/* 导出文档构建：纯函数，给数据出文本（带批注 MD / 素材清单 / CSV / 项目 JSON）。
   片段范围永远写成人能读懂的 00:12–00:18 / 整段，导出后不悄悄丢失。 */
import { TYPES, TYPE_ORDER } from './types.js';
import { STATUS, shots } from './production.js';
import { lineSeconds } from './util.js';
import { fmtTc } from './subtitle-align.js';

const secText = r => lineSeconds(r).toFixed(1) + 's';
import { usageList, clipText, assetName, kindOf } from './assets.js';

/* 单条素材使用：文件名（片段 / 状态） */
export function usageLine(registry, u, missing) {
  const a = registry[u.assetId] || u;
  const name = a.name || assetName(a.path || '');
  const bits = [u.clip ? `片段 ${clipText(u.clip)}` : '整段'];
  if (u.clip && u.clip.needsAdjust) bits.push('片段待调整');
  if (a.path && missing && missing.has(a.path)) bits.push('文件失联');
  return `${name}（${bits.join(' · ')}）`;
}
const usageLines = (r, registry, missing) => usageList(r).map(u => usageLine(registry, u, missing));
const tName = t => (t ? TYPES[t].label : '未标注');

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
    };
  });

export function buildAnnotatedMd({ title, rows, issues, registry = {}, missing }) {
  let out = `# ${title}\n\n`;
  if (issues.length) out += `> 交稿提示：${issues.length} 个镜头有待处理项，详见文末。\n\n`;
  for (const r of rows) {
    if (r.kind === 'section') {
      out += `\n## ${r.text}\n\n`;
      continue;
    }
    const tag = r.type ? TYPES[r.type].full : '未标注';
    let note = '';
    if (r.note) note = r.type && r.type !== 'a' ? `（画面：${r.note}）` : `（备注：${r.note}）`;
    out += `- [${tag}] ${r.text}${note.replace(/\n/g, ' / ')}\n`;
    out += `<!-- fj-meta ${encodeURIComponent(
      JSON.stringify({
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

export function buildAssetListMd({ title, rows, issues, registry = {}, missing, speechRate }) {
  const shotList = shots(rows);
  const lines = rows.filter(r => r.kind === 'line');
  const dMin = r => lineSeconds(r) / 60;
  let out = `# 素材清单 · ${title}\n`;
  TYPE_ORDER.filter(k => k !== 'a').forEach(k => {
    const items = shotList
      .filter(g => g[0].type === k)
      .map(g => ({
        ...g[0],
        text: g.map(r => r.text).join(''),
        range: g.map(r => r.no).join('、'),
        secs: g.reduce((s, r) => s + lineSeconds(r), 0),
        start: g[0].time?.start,
        timed: g.every(r => r.time && r.time.end > r.time.start),
      }));
    if (!items.length) return;
    const sub = items.reduce((s, r) => s + r.secs / 60, 0);
    out += `\n## ${TYPES[k].full}（${items.length} 条 · 约 ${sub >= 1 ? sub.toFixed(1) + ' 分钟' : Math.round(sub * 60) + ' 秒'}）\n\n`;
    items.forEach((r, i) => {
      const when = r.timed ? `${fmtTc(r.start)} · ` : '';
      out += `${i + 1}. 「${r.text}」${r.note ? ` —— ${r.note}` : '【缺画面描述】'} 【第 ${r.range} 句 · ${when}${r.secs.toFixed(1)}s · ${STATUS[r.status] || STATUS.todo}】\n`;
      const usages = usageLines(r, registry, missing);
      if (usages.length) out += `   素材：${usages.join('；')}\n`;
      else out += `   素材：【未关联】\n`;
    });
  });
  const nA = lines.filter(r => r.type === 'a').length;
  const total = lines.reduce((s, r) => s + dMin(r), 0);
  const timed = lines.some(r => r.time);
  out += `\n---\nA roll 共 ${nA} 句（真人出镜，无需配画面）\n全片约 ${total >= 1 ? total.toFixed(1) + ' 分钟' : Math.round(total * 60) + ' 秒'}（${timed ? '按剪映字幕实测' : `按 ${speechRate ?? ''} 字/秒估算`}）\n`;
  if (issues.length) out += '\n## 待处理\n' + issues.map(x => `- 第 ${x.no} 句：${x.issues.join('、')}`).join('\n');
  return out;
}

export function buildCsv({ title, rows, registry = {}, missing }) {
  let sec = '';
  // 对齐过剪映字幕：多出开始 / 结束时间两列（hh:mm:ss.mmm），剪辑可以直接按时间码找位置
  const timed = rows.some(r => r.kind === 'line' && r.time);
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
      '制作状态',
      '待核对',
    ],
  ];
  const SRC = { ok: '字幕', low: '字幕（低置信）', est: '推算' };
  for (const r of rows) {
    if (r.kind === 'section') {
      sec = r.text;
      continue;
    }
    const timeCols = timed
      ? r.time
        ? [
            fmtTc(r.time.start, { precise: true }),
            fmtTc(r.time.end, { precise: true }),
            secText(r),
            SRC[r.time.st] || '',
          ]
        : ['', '', secText(r), '估算']
      : [secText(r)];
    table.push([
      r.no,
      sec,
      r.text,
      ...timeCols,
      tName(r.type),
      r.note || '',
      r.groupId || '',
      usageLines(r, registry, missing).join('；'),
      r.type === 'a' ? '' : STATUS[r.status] || STATUS.todo,
      r.needsReview ? '是' : '',
    ]);
  }
  return '\uFEFF' + table.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
}

export function buildProjectJson({ title, rows, assets = {}, speechRate, timing }) {
  return JSON.stringify(
    { v: 2, title, speechRate, rows, assets, ...(timing ? { timing } : {}), savedAt: new Date().toISOString() },
    null,
    2,
  );
}

/* 交稿检查里的一行描述（供 UI 复用导出同一套说法） */
export const issueText = x => `第 ${x.no} 句：${x.issues.join('、')}`;
