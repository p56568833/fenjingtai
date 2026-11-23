/* 剪映字幕对齐（纯函数，无 DOM，node 可直接测）：
   录完口播后，剪映「字幕识别」出来的 SRT 带真实时间，但文字是识别结果——会有错字、没标点、断句和稿子不一样、
   有口误重录或临场删改。这里把稿子和字幕都压成「只剩文字和数字」的字符流，逐字对齐，再把时间映射回每一句。

   做法：
   1. 字幕每条的时间按字数平均分给它的每个字（剪映一条字幕通常就是一小句，线性插值足够准）
   2. 先找「两边都只出现一次的 5 字片段」当锚点，取单调递增的最长链（LIS）——稳定、抗大段增删
   3. 锚点之间的空隙用编辑距离逐字对齐（错字当替换也算对上）；空隙大到不值得逐字算时按比例映射
   4. 每句取对上的字里最早 / 最晚的时间；按「原字完全相同」的比例给置信度
   5. 一个字都没对上的句子（没录 / 删掉了）按前后句推算时间，标记为推算 */

import { speechUnits } from './text.js';

/* ── 字幕解析：SRT / WebVTT / ASS ── */
const TIME_RE =
  /^\s*(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})(?:[,.](\d+))?\s*-->\s*(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})(?:[,.](\d+))?(?:\s.*)?$/;
const ASS_TIME_RE = /^(\d{1,3}):(\d{1,2}):(\d{1,2})(?:[,.](\d+))?$/;
const STYLE_TAG_RE = /<\/?(?:i|b|u|c|v|font|ruby|rt|lang)(?:\.[^>]*)?(?:\s[^>]*)?>/gi;
const VTT_TS_TAG_RE = /<(?:\d{1,3}:)?\d{1,2}:\d{2}[.,]\d+>/g;
const ASS_TAG_RE = /\{\\[^}]*\}/g;
const VTT_SKIP_BLOCK_RE = /^(?:WEBVTT(?:\s|$)|NOTE(?:\s|$)|STYLE\s*$|REGION\s*$)/;
const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

const toSec = (h, m, s, ms) => (h ? parseInt(h, 10) : 0) * 3600 + +m * 60 + +s + (ms ? parseFloat('0.' + ms) : 0);

function decodeEntities(str) {
  return str.replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|(amp|lt|gt|quot|apos|nbsp));/gi, (full, hex, dec, named) => {
    if (named) return NAMED_ENTITIES[named.toLowerCase()] ?? full;
    const cp = hex ? parseInt(hex, 16) : parseInt(dec, 10);
    if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) return full;
    try {
      return String.fromCodePoint(cp);
    } catch {
      return full;
    }
  });
}

function cleanSubLine(line) {
  return decodeEntities(line.replace(STYLE_TAG_RE, '').replace(VTT_TS_TAG_RE, '').replace(ASS_TAG_RE, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

function parseAssTime(str) {
  const m = String(str || '')
    .trim()
    .match(ASS_TIME_RE);
  return m ? toSec(m[1], m[2], m[3], m[4]) : NaN;
}

function parseAssDialogue(line) {
  const body = line.replace(/^Dialogue:\s*/i, '');
  const fields = [];
  let from = 0;
  for (let n = 0; n < 9; n++) {
    const comma = body.indexOf(',', from);
    if (comma < 0) return null;
    fields.push(body.slice(from, comma));
    from = comma + 1;
  }
  const start = parseAssTime(fields[1]);
  const end = parseAssTime(fields[2]);
  if (!(end > start)) return null;
  const textPart = body
    .slice(from)
    .replace(/\\[Nn]/g, '\n')
    .replace(/\\h/g, ' ');
  const rawLines = textPart.split('\n').map(cleanSubLine).filter(Boolean);
  if (!rawLines.length) return null;
  return { start, end, rawLines, text: rawLines.join(' ') };
}

function dedupeRollingCues(rawCues) {
  const out = [];
  let prevOrig = null;
  let prevEnd = -Infinity;
  for (const cue of rawCues) {
    const origLines = cue.rawLines;
    let lines = origLines;
    if (prevOrig && cue.start <= prevEnd + 0.5) {
      let overlap = 0;
      const maxK = Math.min(prevOrig.length, origLines.length);
      for (let k = maxK; k >= 1; k--) {
        let match = true;
        for (let i = 0; i < k; i++) {
          if (prevOrig[prevOrig.length - k + i] !== origLines[i]) {
            match = false;
            break;
          }
        }
        if (match) {
          overlap = k;
          break;
        }
      }
      if (overlap > 0 && (origLines.length > 1 || (prevOrig.length > 1 && cue.start <= prevEnd + 0.05))) {
        lines = origLines.slice(overlap);
      }
    }
    prevOrig = origLines;
    prevEnd = cue.end;
    if (!lines.length) continue;
    out.push({ start: cue.start, end: cue.end, text: lines.join(' '), rawLines: lines });
  }
  return out;
}

export function parseSubtitles(text) {
  const lines = String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const rawCues = [];
  let cur = null;
  let skipping = false;

  const flush = () => {
    if (!cur) return;
    const rawLines = cur.lines.map(cleanSubLine).filter(Boolean);
    if (rawLines.length && cur.end > cur.start) {
      rawCues.push({ start: cur.start, end: cur.end, text: rawLines.join(' '), rawLines });
    }
    cur = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed) {
      flush();
      skipping = false;
      continue;
    }
    if (/^Dialogue:\s*/i.test(trimmed)) {
      flush();
      skipping = false;
      const assCue = parseAssDialogue(trimmed);
      if (assCue) rawCues.push(assCue);
      continue;
    }
    if (skipping) continue;
    if (!cur && VTT_SKIP_BLOCK_RE.test(trimmed)) {
      skipping = true;
      continue;
    }
    const m = raw.match(TIME_RE);
    if (m) {
      flush();
      cur = {
        start: toSec(m[1], m[2], m[3], m[4]),
        end: toSec(m[5], m[6], m[7], m[8]),
        lines: [],
      };
      continue;
    }
    if (cur) {
      // 两条 SRT 之间缺空行时，紧贴下一条时间行的纯数字行是下一条的序号而非本条正文
      const nextIsTime = i + 1 < lines.length && TIME_RE.test(lines[i + 1]);
      if (nextIsTime && /^\d+$/.test(trimmed) && cur.lines.length > 0) {
        flush();
        continue;
      }
      cur.lines.push(raw);
    }
  }
  flush();

  rawCues.sort((a, b) => a.start - b.start);
  return dedupeRollingCues(rawCues);
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

/* 词级切分：CJK 汉字/假名/谚文按单字，拉丁字母/数字序列（含撇号缩写）按完整单词 */
const NORM_TOKEN_RE =
  /[\u3400-\u9fff\uf900-\ufaff\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{Script=Latin}\p{N}]+(?:['’][\p{Script=Latin}\p{N}]+)*/gu;
export function normTokens(text) {
  const norm = String(text || '')
    .normalize('NFKC')
    .toLowerCase();
  const out = [];
  for (const m of norm.matchAll(NORM_TOKEN_RE)) out.push(m[0].replaceAll('’', "'"));
  return out;
}

const K = 5; // 中文字符级锚点片段长度
const K_WORD = 3; // 英文词级锚点片段长度
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

/* 稿子单元 → 字幕单元 的映射。map[i] = j（-1 = 没对上），exact[i] = 是否完全一致 */
export function alignChars(s, t, { k: win = K } = {}) {
  const map = new Int32Array(s.length).fill(-1);
  const exact = new Uint8Array(s.length);
  if (!s.length || !t.length) return { map, exact };
  const gramLen = Math.max(1, win);
  // 1. 唯一锚点（不重叠、不交叉）
  const grams = arr => {
    const g = new Map();
    for (let i = 0; i + gramLen <= arr.length; i++) {
      const key = arr.slice(i, i + gramLen).join('\x00');
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
    if (i < lastI + 1 || j < lastJ + 1) continue;
    for (let m = 0; m < gramLen; m++) {
      map[i + m] = j + m;
      exact[i + m] = 1;
    }
    lastI = i + gramLen - 1;
    lastJ = j + gramLen - 1;
  }
  // 2. 锚点之间的空隙逐单元对齐
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
        // 空隙太大：按比例映射，精确相等的单元仍记 exact
        for (let x = i; x < b; x++) {
          const y = Math.min(d - 1, c + Math.floor(((x - i) * (d - c)) / (b - i)));
          map[x] = y;
          exact[x] = s[x] === t[y] ? 1 : 0;
        }
      }
    }
    i = b;
  }
  return { map, exact };
}

/* 主入口：lines = [{id, text}]（按稿子顺序的句子），cues = parseSubtitles 的结果
   返回 { times: Map(id → {start,end,conf,st}), stats } ；st: ok 对上 / low 低置信 / est 推算 */
export function alignScript(lines, cues) {
  // 拉丁词占比高（英文稿）自动用词级 normTokens + K=3，中文稿仍用字级 normChars + K=5
  const previewTokens = lines.flatMap(line => normTokens(line.text));
  const latinCount = previewTokens.filter(tok => /\p{Script=Latin}/u.test(tok)).length;
  const useWordMode = previewTokens.length > 0 && latinCount / previewTokens.length >= 0.5;
  const tokenize = useWordMode ? normTokens : normChars;
  const k = useWordMode ? K_WORD : K;

  // 字幕流 + 每个单元的起止时间
  const t = [],
    tStart = [],
    tEnd = [];
  for (const cue of cues) {
    const cs = tokenize(cue.text);
    const span = (cue.end - cue.start) / Math.max(1, cs.length);
    cs.forEach((ch, idx) => {
      t.push(ch);
      tStart.push(cue.start + span * idx);
      tEnd.push(cue.start + span * (idx + 1));
    });
  }
  // 稿子流 + 每个单元属于哪一句
  const s = [],
    owner = [];
  lines.forEach((line, li) => {
    for (const ch of tokenize(line.text)) {
      s.push(ch);
      owner.push(li);
    }
  });
  const { map, exact } = alignChars(s, t, { k });

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
    // 对上的太少（多半是错位配上的零星几个），不如当成没对上，按前后推算
    if (conf < 0.25) return null;
    return { start: p.lo, end: p.hi, conf: Math.round(conf * 100) / 100, st: conf >= 0.6 ? 'ok' : 'low' };
  });
  // 相邻句子重叠修剪：保证严格单调（start >= prevEnd 且 end >= start）
  let prevEnd = 0;
  for (const r of result) {
    if (!r) continue;
    if (r.start < prevEnd) {
      r.start = prevEnd;
      if (r.end < r.start) r.end = r.start;
    }
    prevEnd = r.end;
  }
  // 没对上的句子按前后已知时间推算（权重按朗读量）
  const total = cues.reduce((mx, c) => Math.max(mx, c.end), 0);
  for (let li = 0; li < result.length; li++) {
    if (result[li]) continue;
    let a = li - 1;
    while (a >= 0 && !result[a]) a--;
    let b = li + 1;
    while (b < result.length && (!result[b] || result[b].st === 'est')) b++;
    const from = a >= 0 ? result[a].end : 0;
    const to = b < result.length ? result[b].start : Math.max(from, total);
    // 这一段连续没对上的句子按朗读量分摊 [from, to]
    const run = [];
    for (let x = li; x < b; x++) if (!result[x]) run.push(x);
    const weights = run.map(x => Math.max(0.5, speechUnits(lines[x].text)));
    const sum = weights.reduce((acc, w) => acc + w, 0);
    let cur = from;
    run.forEach((x, idx) => {
      const len = to > from ? ((to - from) * weights[idx]) / sum : 0;
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

/* 时间码格式化在 text.js，这里转引保持旧接口 */
