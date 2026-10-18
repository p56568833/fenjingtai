/* 待返工（纯数据，无 DOM）：审核里没过关、或者你明确说了要换 / 要补的句子，一句（或一段）一项列在一页。
   标记随项目保存、撤销、导出：
     素材上的 rework = { note, at }   右侧素材卡片上点「不满意」：这个素材要换掉，note 写哪里不满意
     句子上的 rework = { note, at }   「让 AI 再找一个」/ 待返工页的补充要求：这几句再补一个镜头
     句子上的 reworkOff = 时间戳       点了「不用返工了」：在这之前否掉的候选不再算返工
   一项待返工就是你加进来的那几句：共用画面里只对第 1 句的素材点了不满意，就是「第 1 句」这一项，
   不把同一画面的别的句子带进来。来源：
     · 标了不满意的素材：它配的那几句（整段的就是整个画面）
     · 写了要求的句子：连着的几句算一项
     · 否掉的候选：它 for 的那几句，那几句还没有通过的视频，而且不是在「不用返工了」之前否掉的
   这几句有候选被通过：要换掉的旧素材挪到备选、要求清掉，从这一页消失。 */
import { shotMembers, applyRole, usageSpan } from './shots.js';
import { usageList } from './asset-model.js';
import { CANDIDATE_VERSION, forRange } from './candidate-values.js';
import { sentenceScope } from './candidate-scope.js';

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
/* 不用返工了：这一项（那几句）上的要求、要换掉的素材标记都清掉，那几句记下时间 */
export function dismissRework(rows, item, now = Date.now()) {
  const ids = new Set(item.target.map(m => m.id));
  const out = new Set(item.replaces.map(x => x.assetId));
  for (const m of rows) {
    if (!ids.has(m.id)) continue;
    delete m.rework;
    m.reworkOff = now;
  }
  for (const m of item.members) for (const u of usageList(m)) if (out.has(u.assetId)) delete u.rework;
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

const overlaps = (a, b) => Math.min(a.to, b.to) >= Math.max(a.from, b.from);
/* 候选在画面里配的那几句：挂上了按它现在在轨上的位置，否则按清单里的 for */
const spanOfCand = (c, members) => {
  if (c.assetId) {
    const sp = usageSpan(members, c.assetId);
    if (!sp.empty) return { from: sp.from, to: sp.to };
  }
  return forRange(c, members);
};

/* 所有待返工的项，按稿子顺序；一项就是加进来的那几句：
   [{ key, lead, members（整个画面）, from, to（members 下标）, target（那几句）, cands（配到这几句的候选）,
      rejected, approved, request, replaces, lastAt }] */
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
    const last = members.length - 1;
    const items = new Map();
    const item = (from, to) => {
      const key = `${from}-${to}`;
      if (!items.has(key)) items.set(key, { from, to, request: null, replaces: [], fresh: [] });
      return items.get(key);
    };
    // 写了要求的句子：连着的几句算一项（点名素材的老写法算进要换掉的素材）
    let start = -1;
    members.forEach((m, i) => {
      const has = !!m.rework && !m.rework.assetId;
      if (has && start < 0) start = i;
      if (start >= 0 && (!has || i === last)) {
        item(start, has ? i : i - 1).request = members[start].rework;
        start = -1;
      }
    });
    for (const x of replacesOf(members)) {
      const sp = usageSpan(members, x.assetId);
      item(sp.empty ? 0 : sp.from, sp.empty ? last : sp.to).replaces.push(x);
    }
    const approved = g.cands.filter(c => c.decision === 'ok');
    const covered = new Set();
    for (const c of approved) {
      const sp = spanOfCand(c, members);
      for (let i = sp.from; i <= sp.to; i++) covered.add(i);
    }
    for (const c of g.cands.filter(isRejected)) {
      const sp = forRange(c, members);
      const off = Math.max(0, ...members.slice(sp.from, sp.to + 1).map(m => m.reworkOff || 0));
      if (off && (c.decidedAt || 0) <= off) continue;
      let open = false;
      for (let i = sp.from; i <= sp.to; i++) if (!covered.has(i)) open = true;
      if (open) item(sp.from, sp.to).fresh.push(c);
    }
    for (const it of items.values()) {
      if (!it.request && !it.replaces.length && !it.fresh.length) continue;
      const cands = g.cands.filter(c => overlaps(forRange(c, members), it));
      const rejected = cands.filter(isRejected);
      out.push({
        key: `${g.lead.id}:${it.from}-${it.to}`,
        lead: g.lead,
        members,
        from: it.from,
        to: it.to,
        target: members.slice(it.from, it.to + 1),
        cands,
        rejected,
        approved: cands.filter(c => c.decision === 'ok'),
        request: it.request,
        replaces: it.replaces,
        lastAt: Math.max(
          it.request?.at || 0,
          ...it.replaces.map(x => x.at || 0),
          ...rejected.map(c => c.decidedAt || 0),
        ),
      });
    }
  }
  return out.sort(
    (a, b) => (order.get(a.lead.id) ?? 0) - (order.get(b.lead.id) ?? 0) || a.from - b.from || a.to - b.to,
  );
}

/* 候选通过了：它配的那几句上的返工要求算解决。那几句上标了不满意的旧素材挪到备选（不删，后悔还能换回来），
   那几句的补充要求清掉；别的句子的返工不动。返回挪到备选的素材 id 列表 */
export function resolveOnApprove(rows, row, approvedAssetId) {
  const members = shotMembers(rows, row);
  const sp = usageSpan(members, approvedAssetId);
  const span = sp.empty ? { from: 0, to: members.length - 1 } : sp;
  const demoted = [];
  for (const { assetId } of replacesOf(members)) {
    if (assetId === approvedAssetId) continue;
    const own = usageSpan(members, assetId);
    if (!own.empty && !overlaps(own, span)) continue;
    if (members.some(m => usageList(m).some(u => u.assetId === assetId))) {
      applyRole(members, assetId, 'alt');
      demoted.push(assetId);
    }
    for (const m of members) for (const u of usageList(m)) if (u.assetId === assetId) delete u.rework;
    for (const m of members) if (m.rework?.assetId === assetId) delete m.rework;
  }
  members.slice(span.from, span.to + 1).forEach(m => {
    if (m.rework && !m.rework.assetId) delete m.rework;
  });
  return demoted;
}

/* 返工单按画面写：同一个画面里的几项（第 1 句、第 3 句）合成一条，for 列出要补的那几句 */
export function groupReworkItems(items) {
  const map = new Map();
  for (const s of items) {
    if (!map.has(s.lead.id)) map.set(s.lead.id, { lead: s.lead, members: s.members, items: [] });
    map.get(s.lead.id).items.push(s);
  }
  return [...map.values()].map(g => {
    const ids = new Set(g.items.flatMap(s => s.target.map(m => m.id)));
    const uniq = list => [...new Set(list)];
    return {
      ...g,
      target: g.members.filter(m => ids.has(m.id)),
      forTexts: g.items.map(s =>
        s.from === s.to ? String(s.target[0].no) : `${s.target[0].no}-${s.target.at(-1).no}`,
      ),
      requests: g.items.map(s => s.request?.note).filter(Boolean),
      replaces: uniq(g.items.flatMap(s => s.replaces)),
      rejected: uniq(g.items.flatMap(s => s.rejected)),
      cands: uniq(g.items.flatMap(s => s.cands)),
    };
  });
}

/* 画面里每一句：{ line, text, seconds }（seconds 含句间停顿，for 写这一句时 best 要够这么长） */
const eachLine = (members, secs) =>
  members.map((m, i) => ({
    line: String(m.no),
    text: m.text,
    ...(Number.isFinite(secs?.[i]) ? { seconds: Math.round(secs[i] * 10) / 10 } : {}),
  }));

/* 要补的那几句各要多少秒：按整个画面算（最后一句的停顿到下一个画面开口），再挑出那几句 */
const targetSeconds = (s, secondsOf) => {
  const all = secondsOf(s.members);
  return all ? s.target.map(m => all[s.members.indexOf(m)]) : null;
};

const rangeOf = members =>
  members.length > 1 ? `${members[0].no}-${members[members.length - 1].no}` : String(members[0]?.no ?? '');

/* 返工单：交给找素材的 AI 读。只写它需要的：要补的那几句（每句多长）、画面描述、你的要求、要换掉的素材和理由、
   那几句现在挂着的素材、否掉的候选和理由。shots：groupReworkItems 的结果（一个画面一条）。
   secondsOf(members)：每句要多少秒（含句间停顿），界面按时间轴传进来；不传就不写秒数 */
export function buildReworkDoc({ title, shots, registry = {}, batchName = () => '', secondsOf = () => null }) {
  const DEC = { no: '不要', re: '换一个' };
  const ROLE = { main: '主画面', overlay: '叠加', alt: '备选' };
  const nameOf = id => registry[id]?.name || registry[id]?.path || '';
  return {
    type: 'fenjingtai-rework',
    version: 1,
    id: 'rw-' + crypto.randomUUID(),
    project: title,
    createdAt: new Date().toISOString(),
    sentences: sentenceScope(shots.flatMap(s => s.target.map(m => m.no))).text,
    reply: `按每个画面的要求和否掉的理由重新找视频候选，用分镜台候选清单格式 v${CANDIDATE_VERSION} 写一份新的候选清单。顶层 reworkId 原样填写本返工单的 id；shots[].lines 逐项照抄这里的 lines，分散的画面分别写，禁止用首尾句号扩成整段，禁止添加返工单以外的画面；可以先回复其中一部分。每段视频的 for 只能写这个画面 for 里列出的句子（要补的就是那几句，同一画面的别的句子不用找），best 要够那几句的长度（看 each 里每句的 seconds）。rejected 里「换一个」的，给同一个 for 再找一段新 key 的视频；replace 里是要换掉的素材和不满意的地方；不要再给已经否掉的同一段。`,
    shots: shots.map(s => ({
      lines: rangeOf(s.members),
      for: s.forTexts,
      text: s.target.map(m => m.text).join(''),
      each: eachLine(s.target, targetSeconds(s, secondsOf)),
      visualNote: s.lead.note || '',
      need: s.cands.find(c => c.need)?.need || '',
      request: s.requests.join('\n'),
      replace: s.replaces.map(x => ({ name: nameOf(x.assetId), note: x.note || '' })),
      current: [
        ...new Map(
          s.target.flatMap(m =>
            usageList(m)
              .filter(u => registry[u.assetId] && !u.off) // 只写这几句上挂着的，配别的句子的不相干
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
        for: c.forText || '',
        note: c.note || '',
        batch: batchName(c),
      })),
    })),
  };
}
