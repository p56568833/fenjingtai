/* 待返工（纯数据，无 DOM）：审核里没过关、或者你明确说了要换 / 要补的画面，按画面汇总到一页。
   标记随项目保存、撤销、导出：
     素材上的 rework = { note, at }   右侧素材卡片上点「不满意」：这个素材要换掉，note 写哪里不满意
     句子上的 rework = { note, at }   「让 AI 再找一个」：这个画面再补一个镜头
     句子上的 reworkOff = 时间戳       点了「不用返工了」：在这之前否掉的候选不再算返工
   一个画面算「待返工」：
     · 有素材标了不满意，或者画面写了要补什么，或者
     · 它的候选里有「不要 / 换一个」，一个都没通过，而且不是在「不用返工了」之前否掉的
   这个画面里有候选被通过：要求都算解决，标了不满意的旧素材挪到备选，从这一页消失。 */
import { shotMembers, applyRole } from './shots.js';
import { usageList } from './asset-model.js';

const REJECT = new Set(['no', 're']);
export const isRejected = c => REJECT.has(c?.decision);

/* 画面要补一个镜头（写在每一句上，共用画面拆开后各自留一份） */
export function setRework(rows, row, rework) {
  for (const m of shotMembers(rows, row)) {
    if (rework) {
      m.rework = { ...rework };
      delete m.reworkOff;
    } else delete m.rework;
  }
}
/* 某个素材不满意（写在每一句对这个素材的使用记录上） */
export function setAssetRework(rows, row, assetId, rework) {
  for (const m of shotMembers(rows, row)) {
    for (const u of usageList(m)) {
      if (u.assetId !== assetId) continue;
      if (rework) u.rework = { ...rework };
      else delete u.rework;
    }
    if (rework) delete m.reworkOff;
  }
}
/* 不用返工了：画面和素材上的要求都清掉，记下时间 */
export function dismissRework(rows, row, now = Date.now()) {
  for (const m of shotMembers(rows, row)) {
    delete m.rework;
    for (const u of usageList(m)) delete u.rework;
    m.reworkOff = now;
  }
}

/* 这个画面里标了不满意的素材：[{ assetId, note, at }]（同一个素材只算一次） */
export function replacesOf(members) {
  const out = new Map();
  for (const m of members) {
    for (const u of usageList(m))
      if (u.rework && !out.has(u.assetId)) out.set(u.assetId, { assetId: u.assetId, ...u.rework });
    // 兼容：画面要求里点名过的素材（早一点的写法）
    const old = m.rework?.assetId;
    if (old && !out.has(old)) out.set(old, { assetId: old, note: m.rework.note || '', at: m.rework.at || 0 });
  }
  return [...out.values()];
}

/* 所有待返工的画面，按稿子顺序：
   [{ lead, members, cands（这个画面所有批次的候选）, rejected, approved, request, replaces, lastAt }] */
export function reworkShots(rows, candidates) {
  const leadOf = new Map(); // 句子 id → 画面第一句
  const order = new Map();
  rows.forEach((r, i) => order.set(r.id, i));
  const lineById = new Map(rows.filter(r => r.kind === 'line').map(r => [r.id, r]));
  const lead = row => {
    if (!leadOf.has(row.id)) {
      const ms = shotMembers(rows, row);
      for (const m of ms) leadOf.set(m.id, ms[0]);
    }
    return leadOf.get(row.id);
  };
  const map = new Map();
  const at = l => {
    if (!map.has(l.id)) map.set(l.id, { lead: l, cands: [] });
    return map.get(l.id);
  };
  for (const c of candidates || []) {
    const row = lineById.get(c.rowId);
    if (row) at(lead(row)).cands.push(c);
  }
  for (const r of lineById.values()) if (r.rework || usageList(r).some(u => u.rework)) at(lead(r));
  const out = [];
  for (const g of map.values()) {
    const members = shotMembers(rows, g.lead);
    const own = members.find(m => m.rework)?.rework || null;
    const request = own && !own.assetId ? own : null; // 点名素材的老写法算进 replaces
    const replaces = replacesOf(members);
    const off = Math.max(0, ...members.map(m => m.reworkOff || 0));
    const rejected = g.cands.filter(isRejected);
    const approved = g.cands.filter(c => c.decision === 'ok');
    const fresh = rejected.filter(c => !off || (c.decidedAt || 0) > off);
    if (!request && !replaces.length && !(fresh.length && !approved.length)) continue;
    out.push({
      lead: g.lead,
      members,
      cands: g.cands,
      rejected,
      approved,
      request,
      replaces,
      lastAt: Math.max(request?.at || 0, ...replaces.map(x => x.at || 0), ...rejected.map(c => c.decidedAt || 0)),
    });
  }
  return out.sort((a, b) => (order.get(a.lead.id) ?? 0) - (order.get(b.lead.id) ?? 0));
}

/* 候选通过了：这个画面的返工要求都算解决。标了不满意的旧素材挪到备选（不删，后悔还能换回来）。
   返回挪到备选的素材 id 列表 */
export function resolveOnApprove(rows, row, approvedAssetId) {
  const members = shotMembers(rows, row);
  const demoted = [];
  for (const { assetId } of replacesOf(members)) {
    if (assetId === approvedAssetId) continue;
    if (!members.some(m => usageList(m).some(u => u.assetId === assetId))) continue;
    applyRole(members, assetId, 'alt');
    demoted.push(assetId);
  }
  for (const m of members) {
    delete m.rework;
    for (const u of usageList(m)) delete u.rework;
  }
  return demoted;
}

const rangeOf = members =>
  members.length > 1 ? `${members[0].no}-${members[members.length - 1].no}` : String(members[0]?.no ?? '');

/* 返工单：交给找素材的 AI 读。只写它需要的：句子、画面描述、你的要求、要换掉的素材和理由、现在挂着的素材、否掉的候选和理由 */
export function buildReworkDoc({ title, shots, registry = {}, batchName = () => '' }) {
  const DEC = { no: '不要', re: '换一个' };
  const ROLE = { main: '主画面', overlay: '叠加', alt: '备选' };
  const nameOf = id => registry[id]?.name || registry[id]?.path || '';
  return {
    type: 'fenjingtai-rework',
    version: 1,
    project: title,
    createdAt: new Date().toISOString(),
    reply:
      '按每个画面的要求和否掉的理由重新找视频候选，用分镜台候选清单格式 v2 写一份新的候选清单（shots[].lines 用这里的 lines）。replace 里是要换掉的素材和不满意的地方；不要再给已经否掉的同一段。',
    shots: shots.map(s => ({
      lines: rangeOf(s.members),
      text: s.members.map(m => m.text).join(''),
      visualNote: s.lead.note || '',
      need: s.cands.find(c => c.need)?.need || '',
      request: s.request?.note || '',
      replace: s.replaces.map(x => ({ name: nameOf(x.assetId), note: x.note || '' })),
      current: [
        ...new Map(
          s.members.flatMap(m =>
            usageList(m)
              .filter(u => registry[u.assetId])
              .map(u => [
                u.assetId,
                {
                  name: registry[u.assetId].name || '',
                  role: ROLE[u.role] || '未分配',
                  path: registry[u.assetId].path,
                },
              ]),
          ),
        ).values(),
      ],
      rejected: s.rejected.map(c => ({
        title: c.title || c.key || '',
        url: c.url,
        in: c.in,
        out: c.out,
        decision: DEC[c.decision],
        note: c.note || '',
        batch: batchName(c),
      })),
    })),
  };
}
