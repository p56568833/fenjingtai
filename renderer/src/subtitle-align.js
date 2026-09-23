/* 剪映字幕对齐（纯函数，无 DOM，node 可直接测）：
   录完口播后，剪映「字幕识别」出来的 SRT 带真实时间，但文字是识别结果——会有错字、没标点、断句和稿子不一样、
   有口误重录或临场删改。这里把稿子和字幕都压成「只剩文字和数字」的字符流，逐字对齐，再把时间映射回每一句。

   做法：
   1. 字幕每条的时间按字数平均分给它的每个字（剪映一条字幕通常就是一小句，线性插值足够准）
   2. 先找「两边都只出现一次的 5 字片段」当锚点，取单调递增的最长链（LIS）——稳定、抗大段增删
   3. 锚点之间的空隙用编辑距离逐字对齐（错字当替换也算对上）；空隙大到不值得逐字算时按比例映射
   4. 每句取对上的字里最早 / 最晚的时间；按「原字完全相同」的比例给置信度
   5. 一个字都没对上的句子（没录 / 删掉了）按前后句推算时间，标记为推算 */

/* ── 字幕解析：SRT / WebVTT ── */
const TIME_RE = /(\d{1,2}:)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})\s*-->\s*(\d{1,2}:)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})/;
const toSec = (h, m, s, ms) => (h ? parseInt(h, 10) : 0) * 3600 + +m * 60 + +s + +ms.padEnd(3, '0') / 1000;

export function parseSubtitles(text) {
  const cues = [];
  const blocks = String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const ti = lines.findIndex(l => TIME_RE.test(l));
    if (ti < 0) continue;
    const m = lines[ti].match(TIME_RE);
    const start = toSec(m[1], m[2], m[3], m[4]);
    const end = toSec(m[5], m[6], m[7], m[8]);
    const body = lines
      .slice(ti + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '') // <i> / <font> 之类的样式标签
      .replace(/\{\\[^}]*\}/g, '') // {\an8} 之类的 ASS 定位
      .trim();
    if (!body || !(end > start)) continue;
    cues.push({ start, end, text: body });
  }
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

/* 只留文字和数字，全角转半角、统一小写：标点、空格、语气断句都不参与对齐 */
export function normChars(text) {
  const out = [];
  for (const ch of String(text || '')
    .normalize('NFKC')
    .toLowerCase())
    if (/[\p{L}\p{N}]/u.test(ch)) out.push(ch);
  return out;
}

const K = 5; // 锚点片段长度
const DP_LIMIT = 4e6; // 逐字对齐的最大格子数（约 2000×2000），再大就按比例映射

/* 最长递增子序列（按 j 严格递增），返回选中的下标 */
function lis(js) {
  const tails = [],
    tailIdx = [],
    prev = new Array(js.length).fill(-1);
  for (let x = 0; x < js.length; x++) {
    let lo = 0,
      hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < js[x]) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = js[x];
    tailIdx[lo] = x;
    prev[x] = lo ? tailIdx[lo - 1] : -1;
  }
  const out = [];
  for (let x = tailIdx[tails.length - 1] ?? -1; x >= 0; x = prev[x]) out.push(x);
  return out.reverse();
}

/* 编辑距离逐字对齐 s[a,b) ↔ t[c,d)：返回 [i, j, 是否同字] 的配对（替换也算配对） */
function dpAlign(s, t, a, b, c, d) {
  const n = b - a,
    m = d - c,
    W = m + 1;
  const cost = new Uint32Array((n + 1) * W);
  const dir = new Uint8Array((n + 1) * W); // 1=对角 2=上(跳过稿子字) 3=左(跳过字幕字)
  for (let i = 0; i <= n; i++) {
    cost[i * W] = i;
    dir[i * W] = 2;
  }
  for (let j = 0; j <= m; j++) {
    cost[j] = j;
    dir[j] = 3;
  }
  for (let i = 1; i <= n; i++) {
    const si = s[a + i - 1];
    for (let j = 1; j <= m; j++) {
      const diag = cost[(i - 1) * W + j - 1] + (si === t[c + j - 1] ? 0 : 1);
      const up = cost[(i - 1) * W + j] + 1;
      const left = cost[i * W + j - 1] + 1;
      let best = diag,
        dd = 1;
      if (up < best) {
        best = up;
        dd = 2;
      }
      if (left < best) {
        best = left;
        dd = 3;
      }
      cost[i * W + j] = best;
      dir[i * W + j] = dd;
    }
  }
  const pairs = [];
  let i = n,
    j = m;
  while (i > 0 && j > 0) {
    const dd = dir[i * W + j];
    if (dd === 1) {
      pairs.push([a + i - 1, c + j - 1, s[a + i - 1] === t[c + j - 1]]);
      i--;
      j--;
    } else if (dd === 2) i--;
    else j--;
  }
  return pairs.reverse();
}

/* 稿子字 → 字幕字 的映射。map[i] = j（-1 = 没对上），exact[i] = 是否同一个字 */
export function alignChars(s, t) {
  const map = new Int32Array(s.length).fill(-1);
  const exact = new Uint8Array(s.length);
  if (!s.length || !t.length) return { map, exact };
  // 1. 唯一锚点
  const grams = arr => {
    const g = new Map();
    for (let i = 0; i + K <= arr.length; i++) {
      const key = arr.slice(i, i + K).join('');
      const e = g.get(key);
      if (e) e.n++;
      else g.set(key, { n: 1, i });
    }
    return g;
  };
  const gs = grams(s),
    gt = grams(t);
  const pairs = [];
  for (const [key, e] of gs) {
    if (e.n !== 1) continue;
    const f = gt.get(key);
    if (f && f.n === 1) pairs.push([e.i, f.i]);
  }
  pairs.sort((x, y) => x[0] - y[0]);
  const chain = lis(pairs.map(p => p[1])).map(x => pairs[x]);
  let lastI = -1,
    lastJ = -1;
  for (const [i, j] of chain) {
    for (let k = 0; k < K; k++) {
      if (i + k > lastI && j + k > lastJ) {
        map[i + k] = j + k;
        exact[i + k] = 1;
        lastI = i + k;
        lastJ = j + k;
      }
    }
  }
  // 2. 锚点之间的空隙逐字对齐
  let i = 0;
  while (i < s.length) {
    if (map[i] >= 0) {
      i++;
      continue;
    }
    let b = i;
    while (b < s.length && map[b] < 0) b++;
    const c = i > 0 ? map[i - 1] + 1 : 0;
    const d = b < s.length ? map[b] : t.length;
    if (d > c) {
      if ((b - i) * (d - c) <= DP_LIMIT) {
        for (const [pi, pj, same] of dpAlign(s, t, i, b, c, d)) {
          map[pi] = pj;
          exact[pi] = same ? 1 : 0;
        }
      } else {
        // 空隙太大：按比例映射（不算「同字」，置信度自然低）
        for (let x = i; x < b; x++) map[x] = Math.min(d - 1, c + Math.floor(((x - i) * (d - c)) / (b - i)));
      }
    }
    i = b;
  }
  return { map, exact };
}

/* 主入口：lines = [{id, text}]（按稿子顺序的句子），cues = parseSubtitles 的结果
   返回 { times: Map(id → {start,end,conf,st}), stats } ；st: ok 对上 / low 低置信 / est 推算 */
export function alignScript(lines, cues) {
  // 字幕字符流 + 每个字的起止时间
  const t = [],
    tStart = [],
    tEnd = [];
  for (const cue of cues) {
    const cs = normChars(cue.text);
    const span = (cue.end - cue.start) / Math.max(1, cs.length);
    cs.forEach((ch, k) => {
      t.push(ch);
      tStart.push(cue.start + span * k);
      tEnd.push(cue.start + span * (k + 1));
    });
  }
  // 稿子字符流 + 每个字属于哪一句
  const s = [],
    owner = [];
  lines.forEach((line, li) => {
    for (const ch of normChars(line.text)) {
      s.push(ch);
      owner.push(li);
    }
  });
  const { map, exact } = alignChars(s, t);

  const per = lines.map(() => ({ n: 0, hit: 0, same: 0, lo: Infinity, hi: -Infinity }));
  for (let i = 0; i < s.length; i++) {
    const p = per[owner[i]];
    p.n++;
    if (map[i] < 0) continue;
    p.hit++;
    if (exact[i]) p.same++;
    p.lo = Math.min(p.lo, tStart[map[i]]);
    p.hi = Math.max(p.hi, tEnd[map[i]]);
  }
  const result = lines.map((line, li) => {
    const p = per[li];
    if (!p.n || !p.hit || !(p.hi > p.lo)) return null;
    const conf = p.same / p.n;
    // 对上的字太少（多半是错位配上的零星几个字），不如当成没对上，按前后推算
    if (conf < 0.25) return null;
    return { start: p.lo, end: p.hi, conf: Math.round(conf * 100) / 100, st: conf >= 0.6 ? 'ok' : 'low' };
  });
  // 相邻句子轻微重叠（同一条字幕里的边界字）：后一句起点顺延到前一句终点
  let prevEnd = -Infinity;
  for (const r of result) {
    if (!r) continue;
    if (r.start < prevEnd && prevEnd < r.end) r.start = prevEnd;
    prevEnd = Math.max(prevEnd, r.end);
  }
  // 没对上的句子按前后已知时间推算
  const total = cues.length ? cues[cues.length - 1].end : 0;
  for (let li = 0; li < result.length; li++) {
    if (result[li]) continue;
    let a = li - 1;
    while (a >= 0 && !result[a]) a--;
    let b = li + 1;
    while (b < result.length && (!result[b] || result[b].st === 'est')) b++;
    const from = a >= 0 ? result[a].end : 0;
    const to = b < result.length ? result[b].start : Math.max(from, total);
    // 这一段连续没对上的句子按字数分摊 [from, to]
    const run = [];
    for (let x = li; x < b; x++) if (!result[x]) run.push(x);
    const weights = run.map(x => Math.max(1, per[x].n));
    const sum = weights.reduce((acc, w) => acc + w, 0);
    let cur = from;
    run.forEach((x, k) => {
      const len = to > from ? ((to - from) * weights[k]) / sum : 0;
      result[x] = { start: cur, end: cur + len, conf: 0, st: 'est' };
      cur += len;
    });
    li = b - 1;
  }
  const times = new Map();
  const stats = { ok: 0, low: 0, est: 0, lines: lines.length, cues: cues.length, duration: total };
  lines.forEach((line, li) => {
    const r = result[li];
    stats[r.st]++;
    times.set(line.id, { start: round(r.start), end: round(r.end), conf: r.conf, st: r.st });
  });
  return { times, stats };
}
const round = x => Math.round(x * 1000) / 1000;

/* 时间码：00:12.3（表格里看）/ 00:00:12.300（导出给剪辑） */
export function fmtTc(sec, { precise = false } = {}) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600),
    m = Math.floor((sec % 3600) / 60),
    s = sec % 60;
  const p = n => String(n).padStart(2, '0');
  if (precise) return `${p(h)}:${p(m)}:${p(Math.floor(s))}.${String(Math.floor((s % 1) * 1000)).padStart(3, '0')}`;
  const ss = Math.floor(s * 10) / 10;
  return `${h ? h + ':' : ''}${p(m)}:${ss < 10 ? '0' : ''}${ss.toFixed(1)}`;
}
