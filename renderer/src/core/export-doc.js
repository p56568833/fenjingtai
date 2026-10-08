/* 导出文档构建：纯函数，给数据出文本（带批注 MD / 素材清单 / CSV / 项目 JSON）。
   片段范围永远写成人能读懂的 00:12–00:18 / 整段，导出后不悄悄丢失。
   ctx 通用字段：{ title, rows, issues, registry, missing, types, timeline | (speechRate, voiceDuration) } */
import { DEFAULT_TYPES, typeIndex } from './types.js';
import { shots, roleLabel, spanText, isRole } from './shots.js';
import { fmtTc } from './text.js';
import { buildTimeline, SOURCE_TEXT } from './timeline.js';
import { usageList, clipText, assetName, kindOf } from './asset-model.js';

const linesOf = rows => rows.filter(r => r.kind === 'line');
function timelineOf(ctx) {
  return (
    ctx.timeline ||
    buildTimeline(linesOf(ctx.rows), { voiceDuration: ctx.voiceDuration, speechRate: ctx.speechRate || 4.5 })
  );
}
const secsOf = (tl, r) => {
  const t = tl.times.get(r.id);
  return t ? t.end - t.start : 0;
};
const fmtMin = sec => (sec >= 60 ? (sec / 60).toFixed(1) + ' 分钟' : Math.round(sec) + ' 秒');

/* 共用画面在表格 / 清单里的人话：第 3–5 句 */
export function shotLabels(rows) {
  const out = new Map();
  for (const g of shots(rows)) {
    if (!g[0].groupId) continue;
    out.set(g[0].groupId, `第 ${g[0].no}–${g[g.length - 1].no} 句`);
  }
  return out;
}

/* 单条素材使用：【角色】文件名（出现位置 · 片段 / 状态）。members 给了才写位置（共用画面） */
export function usageLine(registry, u, missing, members) {
  const a = registry[u.assetId] || u;
  const name = a.name || assetName(a.path || '');
  const where = members ? spanText(members, u.assetId) : '';
  const bits = [];
  if (where && where !== '整段') bits.push(where);
  bits.push(u.clip ? `片段 ${clipText(u.clip)}` : '整段');
  if (u.clip && u.clip.needsAdjust) bits.push('片段待调整');
  if (a.path && missing && missing.has(a.path)) bits.push('文件失联');
  return `【${roleLabel(u.role)}】${name}（${bits.join(' · ')}）`;
}
/* 逐句导出（CSV）：只列这一句实际出现的素材 */
const usageLines = (r, registry, missing) =>
  usageList(r)
    .filter(u => !u.off)
    .map(u => usageLine(registry, u, missing));

/* 自包含的素材使用记录（回读时不再依赖外部素材库也能还原路径与片段） */
const embedUsages = (r, registry) =>
  usageList(r).map(u => {
    const a = registry[u.assetId] || {};
    return {
      path: a.path || '',
      name: a.name || '',
      kind: a.kind || kindOf(a.path || '') || 'doc',
      ...(u.clip
        ? { clip: { in: u.clip.in, out: u.clip.out, ...(u.clip.needsAdjust ? { needsAdjust: true } : {}) } }
        : {}),
      ...(isRole(u.role) ? { role: u.role } : {}),
      ...(u.off ? { off: true } : {}),
    };
  });

export function buildAnnotatedMd({ title, rows, issues = [], registry = {}, types = DEFAULT_TYPES }) {
  const ti = typeIndex(types);
  let out = `# ${title}\n\n`;
  // 文首附类型表：自定义类型（名字、颜色、是否需要画面）回读时原样还原
  out += `<!-- fj-types ${encodeURIComponent(JSON.stringify(ti.list))} -->\n\n`;
  if (issues.length) out += `> 交稿提示：${issues.length} 个镜头有待处理项，详见文末。\n\n`;
  for (const r of rows) {
    if (r.kind === 'section') {
      out += `\n## ${r.text}\n\n`;
      continue;
    }
    const tag = r.type ? ti.full(r.type) : '未标注';
    let note = '';
    if (r.note) note = ti.needsVisual(r.type) ? `（画面：${r.note}）` : `（备注：${r.note}）`;
    out += `- [${tag}] ${r.text}${note.replace(/\n/g, ' / ')}\n`;
    out += `<!-- fj-meta ${encodeURIComponent(
      JSON.stringify({
        type: r.type || null,
        groupId: r.groupId,
        note: r.note || '',
        displayNote: (r.note || '').replace(/\n/g, ' / '),
        assets: r.assets || '',
        status: r.status || 'todo',
        needsReview: !!r.needsReview,
        assetUsages: embedUsages(r, registry),
        ...(r.time ? { time: r.time } : {}),
      }),
    )} -->\n`;
  }
  if (issues.length)
    out +=
      `\n<!-- fj-review -->\n## 交稿待处理\n\n` +
      issues.map(x => `> 第 ${x.no} 句：${x.issues.join('、')}`).join('\n') +
      '\n';
  return out;
}

export function buildAssetListMd(ctx) {
  const { title, rows, issues = [], registry = {}, missing, types = DEFAULT_TYPES } = ctx;
  const ti = typeIndex(types);
  const tl = timelineOf(ctx);
  const shotList = shots(rows);
  const lines = linesOf(rows);
  let out = `# 素材清单 · ${title}\n`;
  for (const t of ti.list.filter(x => x.visual)) {
    const items = shotList
      .filter(g => g[0].type === t.id)
      .map(g => ({
        ...g[0],
        members: g,
        text: g.map(r => r.text).join(''),
        range: g.map(r => r.no).join('、'),
        secs: g.reduce((s, r) => s + secsOf(tl, r), 0),
        start: tl.times.get(g[0].id)?.start,
      }));
    if (!items.length) continue;
    const sub = items.reduce((s, r) => s + r.secs, 0);
    out += `\n## ${t.full}（${items.length} 条 · 约 ${fmtMin(sub)}）\n\n`;
    items.forEach((r, i) => {
      const when = tl.source !== 'rate' && r.start != null ? `${fmtTc(r.start)} · ` : '';
      out += `${i + 1}. 「${r.text}」${r.note ? ` —— ${r.note}` : '【缺画面描述】'} 【第 ${r.range} 句 · ${when}${r.secs.toFixed(1)}s】\n`;
      // 素材清单只列要用的（主画面 / 叠加 / 未分配），备选只报个数，不让剪辑误以为每张都要放
      const all = usageList(r);
      const used = all.filter(u => u.role !== 'alt');
      const alts = all.length - used.length;
      const usages = used.map(u => usageLine(registry, u, missing, r.members));
      if (usages.length) out += `   素材：${usages.join('；')}${alts ? `；另有备选 ${alts} 个` : ''}\n`;
      else out += alts ? `   素材：【未选定，备选 ${alts} 个】\n` : `   素材：【未关联】\n`;
    });
  }
  out += `\n---\n`;
  for (const t of ti.list.filter(x => !x.visual)) {
    const n = lines.filter(r => r.type === t.id).length;
    if (n) out += `${t.label} 共 ${n} 句（无需配画面）\n`;
  }
  const how = tl.source === 'rate' ? `按 ${ctx.speechRate ?? ''} 字/秒估算` : SOURCE_TEXT[tl.source];
  out += `全片约 ${fmtMin(tl.total)}（${how}）\n`;
  if (issues.length) out += '\n## 待处理\n' + issues.map(x => `- 第 ${x.no} 句：${x.issues.join('、')}`).join('\n');
  return out;
}

/* CSV 单元格：引号转义；以 = + - @ 开头的加前缀，防止 Excel 当公式执行 */
const cell = c => {
  let s = String(c ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
};

export function buildCsv(ctx) {
  const { rows, registry = {}, missing, types = DEFAULT_TYPES } = ctx;
  const ti = typeIndex(types);
  const tl = timelineOf(ctx);
  const labels = shotLabels(rows);
  let sec = '';
  // 有真实时间（字幕 / 口播音频）：多出开始 / 结束时间两列（hh:mm:ss.mmm），剪辑可以直接按时间码找位置
  const timed = tl.source !== 'rate';
  const SRC = { ok: '字幕', low: '字幕（低置信）', est: '推算' };
  const srcText = t => (t.src === 'srt' ? SRC[t.st] || '字幕' : t.src === 'fit' ? '按音频推算' : '推算');
  const table = [
    [
      '序号',
      '章节',
      '口播内容',
      ...(timed ? ['开始时间', '结束时间', '时长', '时间来源'] : ['估算时长']),
      '类型',
      '画面/备注',
      '共用画面',
      '素材引用',
      '待核对',
    ],
  ];
  for (const r of rows) {
    if (r.kind === 'section') {
      sec = r.text;
      continue;
    }
    const t = tl.times.get(r.id);
    const secs = (t ? t.end - t.start : 0).toFixed(1) + 's';
    const timeCols = timed
      ? [fmtTc(t?.start ?? 0, { precise: true }), fmtTc(t?.end ?? 0, { precise: true }), secs, t ? srcText(t) : '']
      : [secs];
    table.push([
      r.no,
      sec,
      r.text,
      ...timeCols,
      ti.label(r.type),
      r.note || '',
      r.groupId ? labels.get(r.groupId) || '' : '',
      usageLines(r, registry, missing).join('；'),
      r.needsReview ? '是' : '',
    ]);
  }
  return '\uFEFF' + table.map(r => r.map(cell).join(',')).join('\n');
}

/* 项目 JSON（v4）：项目里的全部数据——句子、素材库、类型、字幕、口播、视频候选（含审核结果与批次）、片段保存位置。
   本地素材只记路径，不含文件本身；换电脑后路径对不上的素材会显示「文件失联」，可以重新定位 */
export function buildProjectJson({ title, rows, assets = {}, speechRate, timing, types, voice, candidates, mediaDir }) {
  return JSON.stringify(
    {
      v: 4,
      title,
      speechRate,
      ...(types ? { types } : {}),
      rows,
      assets,
      ...(timing ? { timing } : {}),
      ...(voice ? { voice } : {}),
      ...(Array.isArray(candidates) && candidates.length ? { candidates } : {}),
      ...(mediaDir ? { mediaDir } : {}),
      savedAt: new Date().toISOString(),
    },
    null,
    2,
  );
}

/* 交稿检查里的一行描述（供 UI 复用导出同一套说法） */
export const issueText = x => `第 ${x.no} 句：${x.issues.join('、')}`;
