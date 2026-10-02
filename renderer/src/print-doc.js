/* PDF 分镜脚本：把项目排成一份可直接发给别人看的文档（纯函数，不碰 DOM / 全局状态，node 里也能测）。
   结构沿用软件里的分镜逻辑：
   · 一个「镜头」= 一句，或共用一个画面的连续几句（groupId）——表格里一行，左边口播逐句保留，右边画面只写一次
   · 章节 = 每章一张表，表头（章节名 + 列名）在跨页时自动重复，翻到哪页都知道在哪一章
   · 封面 = 全片节奏色条（按镜头顺序和时长）、画面构成、章节目录
   主进程用 Chromium 的 printToPDF 出矢量 PDF：文字可选可搜、链接可点、章节生成书签。 */

import { speechUnits, hasRealTime, fmtTime } from './util.js';

const TYPE_META = {
  a: { label: 'A roll · 真人出镜', short: 'A roll', color: '#3b74e8' },
  real: { label: 'B roll · 真实素材', short: '真实素材', color: '#12945f' },
  stock: { label: 'B roll · 通用素材', short: '通用素材', color: '#d9820b' },
  ai: { label: 'B roll · AI 动画', short: 'AI 动画', color: '#7c4de8' },
  fx: { label: 'B roll · 结构特效', short: '结构特效', color: '#e8502f' },
};
const TYPE_ORDER = ['a', 'real', 'stock', 'ai', 'fx'];
const NONE = { label: '未标注', short: '未标注', color: '#a3abba' };
const STATUS = { todo: '待找素材', making: '待制作', ready: '已就绪' };

export const PDF_DEFAULTS = { landscape: false, cover: true, status: true, assets: true };

const esc = s =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
const chars = speechUnits;
const meta = t => TYPE_META[t] || NONE;
const pad = (n, w) => String(n).padStart(w, '0');

/* 时长：句内用 3.2s；汇总用 6 分 12 秒；封面大数字用 42:10 */
const fmtSec = s => (s < 10 ? s.toFixed(1) + 's' : Math.round(s) + 's');
export function fmtLong(s) {
  s = Math.round(s);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60),
    r = s % 60;
  return r ? `${m} 分 ${r} 秒` : `${m} 分钟`;
}
const fmtClock = s => {
  s = Math.round(s);
  return `${Math.floor(s / 60)}:${pad(s % 60, 2)}`;
};

export const assetRefs = (r, registry = {}) =>
  Array.isArray(r.assetUsages)
    ? r.assetUsages.map(u => registry[u.assetId]?.path || u.path || '').filter(Boolean)
    : (r.assets || '')
        .split('\n')
        .map(x => x.trim())
        .filter(Boolean);
const clipLabels = (r, registry) =>
  new Map(
    (r.assetUsages || [])
      .filter(u => u.clip)
      .map(u => [
        registry[u.assetId]?.path || u.path || '',
        `片段 ${fmtTime(u.clip.in)}–${fmtTime(u.clip.out)}${u.clip.needsAdjust ? ' · 片段待调整' : ''}`,
      ]),
  );
export function assetName(ref) {
  try {
    if (/^https?:\/\//i.test(ref)) {
      const u = new URL(ref);
      return decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || u.hostname);
    }
  } catch {}
  return ref.split(/[\\/]/).pop() || ref;
}
const isUrl = ref => /^https?:\/\//i.test(ref);
const isVideo = ref => /\.(mp4|mov|mkv|webm|m4v|avi)$/i.test(ref);

/* 项目 → 章节 → 镜头。镜头切分与软件内 shots() 一致：同一 groupId 的连续句子合为一个镜头 */
export function planDocument(rows, speechRate = 4.5, registry = {}) {
  const rate = Number(speechRate) >= 1 && Number(speechRate) <= 10 ? Number(speechRate) : 4.5;
  const chapters = [];
  let chapter = null,
    shot = null,
    shotNo = 0,
    lineNo = 0;
  const hasSections = rows.some(r => r.kind === 'section');
  const startChapter = title => {
    chapter = { title, shots: [], lines: 0, seconds: 0 };
    chapters.push(chapter);
    shot = null;
  };
  for (const r of rows) {
    if (r.kind === 'section') {
      startChapter(r.text);
      continue;
    }
    if (r.kind !== 'line') continue;
    if (!chapter) startChapter(hasSections ? '开场' : null);
    lineNo++;
    const seconds = hasRealTime(r) ? r.time.end - r.time.start : chars(r.text) / rate;
    const line = { no: r.no || lineNo, text: r.text, seconds, time: r.time };
    if (shot && r.groupId && shot.groupId === r.groupId) {
      shot.lines.push(line);
    } else {
      shot = {
        no: ++shotNo,
        groupId: r.groupId || null,
        type: r.type || null,
        note: r.note || '',
        assets: assetRefs(r, registry),
        clipLabels: clipLabels(r, registry),
        status: r.status || 'todo',
        lines: [line],
        seconds: 0,
      };
      chapter.shots.push(shot);
    }
    shot.seconds += seconds;
    chapter.lines++;
    chapter.seconds += seconds;
  }
  const kept = chapters.filter(c => c.shots.length);
  kept.forEach((c, i) => {
    c.index = i + 1;
    c.first = c.shots[0].no;
    c.last = c.shots[c.shots.length - 1].no;
  });
  const allShots = kept.flatMap(c => c.shots);
  return {
    rate,
    chapters: kept,
    shots: allShots,
    lines: kept.reduce((s, c) => s + c.lines, 0),
    seconds: kept.reduce((s, c) => s + c.seconds, 0),
    named: kept.some(c => c.title),
    timed: rows.some(r => r.kind === 'line' && hasRealTime(r)),
  };
}

/* ── 片段 ── */
function rhythmBar(plan, cls = 'rhythm') {
  const total = plan.seconds || 1;
  const chapters = plan.chapters
    .map(c => {
      const segs = c.shots
        .map(s => `<i style="flex:${Math.max(s.seconds, 0.3).toFixed(2)} 1 0;background:${meta(s.type).color}"></i>`)
        .join('');
      return `<div class="rb-chap" style="flex:${Math.max(c.seconds, 0.3).toFixed(2)} 1 0">${segs}</div>`;
    })
    .join('');
  const ticks =
    plan.chapters.length > 1
      ? `<div class="rb-ticks">${plan.chapters
          .map(c => `<span style="flex:${Math.max(c.seconds, 0.3).toFixed(2)} 1 0">${pad(c.index, 2)}</span>`)
          .join('')}</div>`
      : '';
  return `<div class="${cls}"><div class="rb-track">${chapters}</div>${ticks}</div><div class="rb-scale"><span>0:00</span><span>${fmtClock(total)}</span></div>`;
}

function typeBreakdown(plan) {
  const total = plan.seconds || 1;
  const keys = [...TYPE_ORDER, null].filter(k => plan.shots.some(s => (s.type || null) === k));
  return keys
    .map(k => {
      const list = plan.shots.filter(s => (s.type || null) === k);
      const sec = list.reduce((a, s) => a + s.seconds, 0),
        pct = (sec / total) * 100;
      const m = meta(k);
      return `<div class="tb-row"><span class="sw" style="background:${m.color}"></span><span class="tb-name">${esc(m.label)}</span>
      <span class="tb-bar"><i style="width:${pct.toFixed(1)}%;background:${m.color}"></i></span>
      <span class="tb-num">${list.length} 镜</span><span class="tb-num">${fmtLong(sec)}</span><span class="tb-pct">${Math.round(pct)}%</span></div>`;
    })
    .join('');
}

function statusSummary(plan) {
  const broll = plan.shots.filter(s => s.type && s.type !== 'a');
  if (!broll.length) return '';
  const count = k => broll.filter(s => (STATUS[s.status] ? s.status : 'todo') === k).length;
  return `<div class="st-sum">${['ready', 'making', 'todo']
    .map(k => `<span class="st st-${k}"><b>${count(k)}</b>${STATUS[k]}</span>`)
    .join('')}<span class="st-of">共 ${broll.length} 个 B roll 镜头</span></div>`;
}

function cover(plan, title, date) {
  const chapterList = plan.named
    ? `
    <section class="cv-block cv-toc"><div class="cv-h">章节</div>
      ${plan.chapters.map(c => `<div class="toc-row"><span class="toc-no">${pad(c.index, 2)}</span><span class="toc-name">${esc(c.title || '未分章')}</span><span class="toc-shots">镜 ${c.first}${c.last !== c.first ? '–' + c.last : ''}</span><span class="toc-dur">${fmtClock(c.seconds)}</span></div>`).join('')}
    </section>`
    : '';
  return `<div class="cover">
    <div class="cv-top"><span class="cv-brand"><span class="cv-mark"></span>分镜脚本</span><span>${esc(date)}</span></div>
    <h1 class="cv-title">${esc(title)}</h1>
    <div class="cv-stats">
      <div><b>${fmtClock(plan.seconds)}</b><span>${plan.timed ? '全片时长' : '全片估算时长'}</span></div>
      <div><b>${plan.shots.length}</b><span>个镜头</span></div>
      <div><b>${plan.lines}</b><span>句口播</span></div>
      ${plan.named ? `<div><b>${plan.chapters.length}</b><span>个章节</span></div>` : ''}
    </div>
    <div class="cv-label">全片节奏 <small>色块按镜头顺序排列，宽度为${plan.timed ? '镜头时长' : '估算时长'}</small></div>
    ${rhythmBar(plan)}
    <div class="cv-cols">
      ${chapterList}
      <section class="cv-block cv-types"><div class="cv-h">画面构成</div>${typeBreakdown(plan)}${plan.__status ? statusSummary(plan) : ''}</section>
    </div>
    <div class="cv-guide">
      <b>怎么读</b>每一行是一个镜头：左边是逐句口播（带句号和估算时长），右边是这个镜头的画面设计。
      连续几句共用一个画面时合在同一行，左侧色条贯穿这几句。${plan.timed ? `已对齐的句子采用字幕时长（≈ 表示推算或低置信），未对齐的句子按 ${plan.rate} 字/秒估算。` : `时长按 ${plan.rate} 字/秒估算，不是录音时间码。`}
    </div>
  </div>`;
}

function assetBlock(refs, thumbs, labels) {
  if (!refs.length) return '';
  const pics = [],
    files = [];
  for (const ref of refs) {
    const data = thumbs && thumbs.get ? thumbs.get(ref) : null;
    const label = `${assetName(ref)}${labels?.get(ref) ? ' · ' + labels.get(ref) : ''}`;
    if (data)
      pics.push(
        `<figure class="thumb${isVideo(ref) ? ' is-video' : ''}"><img src="${esc(data)}" alt=""><figcaption>${esc(label)}</figcaption></figure>`,
      );
    else if (isUrl(ref)) files.push(`<a class="ref" href="${esc(ref)}">↗ ${esc(label)}</a>`);
    else files.push(`<span class="ref">${isVideo(ref) ? '▶' : '▤'} ${esc(label)}</span>`);
  }
  return `<div class="assets">${pics.length ? `<div class="thumbs">${pics.join('')}</div>` : ''}${files.length ? `<div class="refs">${files.join('')}</div>` : ''}</div>`;
}

function shotRow(s, opts, noWidth) {
  const m = meta(s.type);
  const isA = s.type === 'a';
  const lines = s.lines
    .map(
      l =>
        `<li><span class="ln">${l.no}</span><span class="tx">${esc(l.text)}</span><span class="ld">${l.time && hasRealTime({ time: l.time }) ? `${l.time.st === 'ok' ? '' : '≈'}${fmtTime(l.time.start)} · ` : ''}${fmtSec(l.seconds)}</span></li>`,
    )
    .join('');
  const status =
    opts.status && s.type && !isA
      ? `<span class="status st-${STATUS[s.status] ? s.status : 'todo'}">${STATUS[s.status] || STATUS.todo}</span>`
      : '';
  let note;
  if (s.note.trim()) note = `<div class="note">${esc(s.note.trim())}</div>`;
  else if (isA) note = '';
  else note = `<div class="note muted">画面待定</div>`;
  return `<tr class="shot${isA ? ' is-a' : ''}${s.type ? '' : ' is-none'}${s.lines.length > 1 ? ' is-group' : ''}" style="--tc:${m.color}">
    <td class="c-no"><div class="no">${pad(s.no, noWidth)}</div><div class="sd">${fmtSec(s.seconds)}</div>${s.lines.length > 1 ? `<div class="grp">${s.lines.length} 句共用</div>` : ''}</td>
    <td class="c-vo"><ol>${lines}</ol></td>
    <td class="c-vis"><div class="vis-head"><span class="chip">${esc(m.label)}</span>${status}</div>${note}${opts.assets ? assetBlock(s.assets, opts.thumbs, s.clipLabels) : ''}</td>
  </tr>`;
}

function chapterTable(c, plan, opts, noWidth, breakBefore) {
  // 章节名放进表头：Chromium 打印时 thead 每页重复，翻到哪页都看得到所属章节；
  // 书签用表格前一个零高度的 h2 生成，避免重复表头产生重复书签
  const bookmark = c.title ? `<h2 class="bm">${esc(c.title)}</h2>` : '';
  const chapterRow = c.title
    ? `<tr class="ch"><th colspan="3"><div class="ch-head"><span class="ch-no">${pad(c.index, 2)}</span><span class="ch-name">${esc(c.title)}</span><span class="ch-meta">${c.shots.length} 镜 · ${c.lines} 句 · ${fmtLong(c.seconds)}</span></div></th></tr>`
    : '';
  return `<section class="chapter${breakBefore ? ' new-page' : ''}">${bookmark}
    <table class="board"><colgroup><col class="w-no"><col class="w-vo"><col class="w-vis"></colgroup>
      <thead>${chapterRow}<tr class="cols"><th>镜号</th><th>口播</th><th>画面</th></tr></thead>
      <tbody>${c.shots.map(s => shotRow(s, opts, noWidth)).join('')}</tbody>
    </table></section>`;
}

/* 主入口：返回给 printToPDF 的整页 HTML + 页脚模板 */
export function buildPrintDoc(project, options = {}) {
  const opts = { ...PDF_DEFAULTS, ...options };
  const title = (project.title || '').trim() || '未命名项目';
  const plan = planDocument(project.rows || [], project.speechRate, project.assets || {});
  plan.__status = opts.status;
  const date = opts.date || new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
  const noWidth = plan.shots.length >= 100 ? 3 : 2;
  // 章节普遍较长时每章另起一页；短章节连排，避免满纸空白
  const longChapters = plan.chapters.length > 1 && plan.shots.length / plan.chapters.length >= 8;
  const body = plan.chapters.map((c, i) => chapterTable(c, plan, opts, noWidth, longChapters && i > 0)).join('');
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(title)} · 分镜脚本</title>
<style>${CSS}</style></head>
<body class="${opts.landscape ? 'landscape' : 'portrait'}${plan.timed ? ' timed' : ''}">
${opts.cover ? cover(plan, title, date) : `<div class="mini-head"><h1>${esc(title)}</h1><span>${plan.shots.length} 镜 · ${plan.lines} 句 · 约 ${fmtLong(plan.seconds)} · ${esc(date)}</span></div>`}
${body || '<p class="empty">这个项目还没有句子。</p>'}
</body></html>`;
  const footer = `<div style="width:100%;box-sizing:border-box;padding:0 12mm;display:flex;justify-content:space-between;align-items:center;font-size:7.5px;color:#8a93a6;font-family:-apple-system,'PingFang SC','Hiragino Sans GB','Noto Sans CJK SC','Microsoft YaHei',sans-serif;letter-spacing:.02em"><span>${esc(title)} · 分镜脚本</span><span style="font-family:'SF Mono',Menlo,ui-monospace,monospace"><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`;
  return {
    html,
    footer,
    header: '<span></span>',
    landscape: !!opts.landscape,
    title,
    stats: { shots: plan.shots.length, lines: plan.lines, chapters: plan.chapters.length },
  };
}

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Microsoft YaHei",sans-serif;
  color:#1a2233;font-size:9.6pt;line-height:1.58;-webkit-font-smoothing:antialiased;
  --t2:#5a6478;--t3:#8a93a6;--hair:#e3e6ec;--hair2:#eef0f4;--accent:#416c9d;--mono:"SF Mono",Menlo,ui-monospace,"DejaVu Sans Mono",monospace}
body.portrait{font-size:9.2pt}

/* ── 封面 ── */
.cover{break-after:page;display:flex;flex-direction:column;min-height:176mm}
body.portrait .cover{min-height:262mm}
.cv-top{display:flex;justify-content:space-between;align-items:center;font-size:8.5pt;color:var(--t3);letter-spacing:.04em}
.cv-brand{display:flex;align-items:center;gap:7px;font-weight:600;color:var(--t2)}
.cv-mark{width:10px;height:10px;border-radius:3px;background:var(--accent)}
.cv-title{font-size:26pt;line-height:1.25;font-weight:700;letter-spacing:-.01em;margin:16mm 0 7mm;max-width:88%}
body.portrait .cv-title{font-size:23pt;margin-top:24mm;max-width:100%}
.cv-stats{display:flex;gap:13mm;margin-bottom:11mm}
.cv-stats div{display:flex;flex-direction:column}
.cv-stats b{font-family:var(--mono);font-size:19pt;font-weight:600;line-height:1.1;letter-spacing:-.02em}
.cv-stats span{font-size:8pt;color:var(--t3);margin-top:3px}
.cv-label{font-size:8.5pt;font-weight:600;color:var(--t2);margin-bottom:6px}
.cv-label small{font-weight:400;color:var(--t3);margin-left:8px;font-size:7.5pt}
.rb-track{display:flex;gap:1.2mm;height:9mm}
.rb-chap{display:flex;min-width:1px;border-radius:2px;overflow:hidden}
.rb-chap i{display:block;min-width:.25px;border-right:.4px solid rgba(255,255,255,.75)}
.rb-chap i:last-child{border-right:0}
.rb-ticks{display:flex;gap:1.2mm;margin-top:4px}
.rb-ticks span{min-width:1px;font-family:var(--mono);font-size:6.5pt;color:var(--t3);border-left:.6px solid #c9ced8;padding-left:3px;line-height:1.3;overflow:hidden;white-space:nowrap}
.rb-scale{display:none}
.cv-cols{display:flex;gap:14mm;margin-top:10mm;align-items:flex-start}
body.portrait .cv-cols{flex-direction:column;gap:9mm}
.cv-block{flex:1;min-width:0}
.cv-h{font-size:8.5pt;font-weight:600;color:var(--t2);padding-bottom:5px;border-bottom:.8px solid #1a2233;margin-bottom:2px}
body.portrait .cv-block{width:100%}
.toc-row{display:grid;grid-template-columns:8mm 1fr auto 13mm;gap:3mm;align-items:baseline;padding:4px 0;border-bottom:.5px solid var(--hair);font-size:8.8pt}
.toc-no,.toc-dur,.toc-shots{font-family:var(--mono);font-size:7.8pt;color:var(--t3)}
.toc-dur{text-align:right;color:var(--t2)}
.toc-name{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tb-row{display:grid;grid-template-columns:3mm 30mm 1fr 11mm 17mm 8mm;gap:2.5mm;align-items:center;padding:4.2px 0;border-bottom:.5px solid var(--hair);font-size:8.6pt}
.sw{width:3mm;height:3mm;border-radius:1px}
.tb-bar{height:4px;background:var(--hair2);border-radius:2px;overflow:hidden}
.tb-bar i{display:block;height:100%;border-radius:2px}
.tb-num,.tb-pct{font-family:var(--mono);font-size:7.8pt;color:var(--t2);text-align:right;white-space:nowrap}
.tb-pct{color:var(--t3)}
.st-sum{display:flex;gap:5mm;align-items:baseline;margin-top:5mm;font-size:8pt;color:var(--t2)}
.st-sum .st b{font-family:var(--mono);font-size:11pt;font-weight:600;margin-right:4px;color:#1a2233}
.st-sum .st::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:5px;vertical-align:1px;background:var(--sc)}
.st-of{margin-left:auto;color:var(--t3);font-size:7.5pt}
.cv-guide{margin-top:auto;padding-top:9mm;font-size:7.8pt;line-height:1.75;color:var(--t3);max-width:150mm}
.cv-guide b{color:var(--t2);font-weight:600;margin-right:3mm}

.mini-head{display:flex;align-items:baseline;gap:6mm;padding-bottom:4mm;margin-bottom:5mm;border-bottom:.8px solid #1a2233}
.mini-head h1{font-size:15pt;font-weight:700}
.mini-head span{font-size:8pt;color:var(--t3)}

/* ── 章节 ── */
.chapter{margin-top:10mm;position:relative}
.cover+.chapter,.mini-head+.chapter{margin-top:0}
.chapter.new-page{break-before:page;margin-top:0}
h2.bm{height:1mm;overflow:hidden;margin:0 0 -1mm;font-size:2pt;line-height:1;font-weight:400;color:#fff;white-space:nowrap}
thead tr.ch th{text-align:left;font-weight:400;padding:0 0 2.6mm}
.ch-head{display:flex;align-items:baseline;gap:3.5mm}
.ch-no{font-family:var(--mono);font-size:9.5pt;font-weight:600;color:var(--accent)}
.ch-name{font-size:13pt;font-weight:700;letter-spacing:-.005em;color:#1a2233}
.ch-meta{margin-left:auto;font-size:7.6pt;color:var(--t3);font-family:var(--mono)}

/* ── 分镜表 ── */
table.board{width:100%;border-collapse:collapse;table-layout:fixed}
col.w-no{width:17mm}
col.w-vo{width:47%}
body.portrait col.w-no{width:14mm}
body.portrait col.w-vo{width:50%}
thead{display:table-header-group}
thead tr.cols th{text-align:left;font-family:var(--mono);font-size:6.8pt;font-weight:600;letter-spacing:.12em;color:var(--t3);
  padding:4px 0 4px;border-top:.8px solid #1a2233;border-bottom:.5px solid var(--hair)}
thead tr.cols th:first-child{padding-left:3.2mm}
thead tr.cols th:nth-child(3){padding-left:5mm}
tr.shot{break-inside:avoid}
tr.shot td{vertical-align:top;border-bottom:.5px solid var(--hair);padding:2.8mm 0 3mm}
td.c-no{border-left:2.4px solid var(--tc);padding-left:2.6mm!important}
tr.is-none td.c-no{border-left-style:dashed}
.no{font-family:var(--mono);font-size:11pt;font-weight:600;line-height:1.2;letter-spacing:-.02em}
.sd{font-family:var(--mono);font-size:7pt;color:var(--t3);margin-top:2px}
.grp{font-size:6.6pt;color:var(--tc);margin-top:5px;font-weight:600;line-height:1.3}
td.c-vo{padding-right:4mm!important}
td.c-vo ol{list-style:none}
td.c-vo li{display:grid;grid-template-columns:7.5mm 1fr 8mm;gap:1.5mm;align-items:baseline}
tr.is-group td.c-vo li+li{margin-top:1.6mm;padding-top:1.6mm;border-top:.5px dashed #dfe2e8}
.ln{font-family:var(--mono);font-size:7pt;color:var(--t3);text-align:right;padding-right:1mm}
.tx{font-size:1em}
body.timed td.c-vo li{grid-template-columns:7.5mm 1fr 20mm}
.ld{font-family:var(--mono);font-size:6.8pt;color:#a3abba;text-align:right}
td.c-vis{padding-left:5mm!important;padding-right:1mm!important;border-left:.5px solid var(--hair2)}
.vis-head{display:flex;align-items:center;gap:2.5mm;margin-bottom:1.6mm}
.chip{display:inline-flex;align-items:center;gap:5px;font-size:7.4pt;font-weight:600;color:var(--tc);line-height:1;padding:3px 7px 3px 6px;border-radius:3px;
  background:color-mix(in srgb,var(--tc) 9%,#fff)}
.chip::before{content:"";width:5px;height:5px;border-radius:50%;background:var(--tc)}
tr.is-none .chip{background:none;border:.6px dashed #b8bfcc;color:var(--t3)}
.status{margin-left:auto;font-size:7pt;color:var(--t2);display:inline-flex;align-items:center;gap:4px;white-space:nowrap}
.status::before{content:"";width:5px;height:5px;border-radius:50%;background:var(--sc)}
.st-todo{--sc:#c77700}.st-making{--sc:#3b74e8}.st-ready{--sc:#12945f}
.note{white-space:pre-wrap;word-break:break-word;line-height:1.62}
.note.muted{color:var(--t3);font-size:.92em}
tr.is-a .note{color:var(--t2)}
.assets{margin-top:2.4mm}
.thumbs{display:flex;flex-wrap:wrap;gap:2.4mm}
.thumb{width:36mm;break-inside:avoid}
body.portrait .thumb{width:30mm}
.thumb img{display:block;width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:2px;background:#eef0f4;border:.5px solid var(--hair)}
.thumb.is-video{position:relative}
.thumb.is-video::after{content:"▶";position:absolute;left:2mm;top:2mm;font-size:6pt;color:#fff;background:rgba(15,23,42,.6);border-radius:2px;padding:1px 4px}
.thumb figcaption{font-size:6.6pt;color:var(--t3);margin-top:1mm;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.refs{display:flex;flex-wrap:wrap;gap:1.6mm;margin-top:1.6mm}
.ref{font-size:7pt;color:var(--t2);background:#f3f5f8;border-radius:3px;padding:2px 6px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-decoration:none}
a.ref{color:var(--accent)}
.empty{color:var(--t3);padding:20mm 0;text-align:center}
`;
