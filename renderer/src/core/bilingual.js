/* 双语 / 英配中字模式核心规则（纯函数，无 DOM、无副作用、无应用状态）：
   单时钟源不变式：row.text 始终是口播原文，row.time / project.timing 始终以口播原文为唯一时间真相源；
   中文字幕（row.sub / project.subTiming）只负责译文展示、搜索、打印与字幕导出，绝不覆盖 row.time。 */
import { joinSentences } from './text.js';
import { buildTimeline } from './timeline.js';

const CJK_TEST_RE = /[\u3400-\u9fff\uf900-\ufaff\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const LATIN_WORD_RE = /(?:\p{Script=Latin}\p{Mn}*)+(?:['’](?:\p{Script=Latin}\p{Mn}*)+)*/gu;
const HEADING_RE = /^#{1,6}\s+\S.*$/;
const BRACKET_SECTION_RE = /^【[^】]+】$/;

const isSectionLine = line => HEADING_RE.test(line) || BRACKET_SECTION_RE.test(line);
const cleanSectionTitle = line =>
  line
    .replace(/^#{1,6}\s*/, '')
    .replace(/[【】]/g, '')
    .trim();
const roundSec = x => Math.round(x * 1000) / 1000;

/* ── 语种识别 ── */

export function hasCjk(text) {
  return CJK_TEST_RE.test(String(text || ''));
}

/* 判断一段文本是中文为主（'zh'）、英文/拉丁为主（'en'）还是混合/空（'mixed' / ''）。
   按「CJK 字符数 vs 拉丁词数」比较（不按字母数），避免含少量英文专有名词的中文句被误判为英文。 */
export function detectScriptLang(text) {
  const s = String(text || '');
  const cjk = (s.match(CJK_RE) || []).length;
  const latinWords = (s.match(LATIN_WORD_RE) || []).length;
  if (!cjk && !latinWords) return '';
  if (cjk && !latinWords) return 'zh';
  if (latinWords && !cjk) return 'en';
  const ratio = cjk / (cjk + latinWords);
  if (ratio >= 0.4) return 'zh';
  if (ratio <= 0.25 && latinWords >= 4) return 'en';
  return 'mixed';
}

export function isLatinDominant(text) {
  return detectScriptLang(text) === 'en';
}

const isZhSide = text => hasCjk(text) && !isLatinDominant(text);

export function isBilingualProject(project) {
  if (!project || typeof project !== 'object') return false;
  if (project.langMode === 'en-zh') return true;
  if (Array.isArray(project.subTiming?.cues) && project.subTiming.cues.length > 0) return true;
  return (
    Array.isArray(project.rows) &&
    project.rows.some(r => r?.kind === 'line' && typeof r.sub === 'string' && r.sub.trim())
  );
}

/* ── 双语对照文稿解析 ── */

function splitPairToRows(enRaw, zhRaw, splitFn) {
  const enTrim = String(enRaw || '').trim();
  const zhTrim = String(zhRaw || '').trim();
  if (!enTrim) return [];
  const enParts = typeof splitFn === 'function' ? splitFn(enTrim) : [enTrim];
  const parts = enParts.length ? enParts : [enTrim];
  if (parts.length === 1) {
    return [
      {
        kind: 'line',
        text: parts[0],
        ...(zhTrim ? { sub: zhTrim } : {}),
        note: '',
        type: null,
        para: true,
      },
    ];
  }
  const zhParts = zhTrim && typeof splitFn === 'function' ? splitFn(zhTrim) : zhTrim ? [zhTrim] : [];
  if (zhParts.length === parts.length) {
    return parts.map((p, i) => ({
      kind: 'line',
      text: p,
      ...(zhParts[i] ? { sub: zhParts[i] } : {}),
      note: '',
      type: null,
      para: i === 0,
    }));
  }
  // 英文拆成多句但中文句数不同：译文完整归于首句，避免强行切分造成错位或丢字
  return parts.map((p, i) => ({
    kind: 'line',
    text: p,
    ...(i === 0 && zhTrim ? { sub: zhTrim } : {}),
    note: '',
    type: null,
    para: i === 0,
  }));
}

function splitInlineBilingual(line) {
  let parts = null;
  if (line.includes('||')) {
    const raw = line.split(/\s*\|\|\s*/).map(s => s.trim());
    if (raw.length === 2 && raw[0] && raw[1]) parts = raw;
  } else if (line.includes('\t')) {
    const raw = line
      .split(/\t+/)
      .map(s => s.trim())
      .filter(Boolean);
    if (raw.length === 2) parts = raw;
  }
  if (!parts) return null;
  const [a, b] = parts;
  if (isLatinDominant(a) && isZhSide(b)) return { en: a, zh: b };
  if (isLatinDominant(b) && isZhSide(a)) return { en: b, zh: a };
  return null;
}

function splitPlainLine(line, splitFn) {
  const parts = typeof splitFn === 'function' ? splitFn(line) : [line];
  return (parts.length ? parts : [line]).map((p, i) => ({
    kind: 'line',
    text: p,
    note: '',
    type: null,
    para: i === 0,
  }));
}

/* 识别明显符合双语对照结构的文稿（格式 A 同行 ||/\t 分隔；格式 B 英文行 + 中文行交替）。
   普通纯中文 / 纯英文文稿返回 null，由 parseScript 走常规分句。 */
export function parseBilingualLines(rawText, splitFn) {
  const items = String(rawText || '')
    .split(/\r?\n/)
    .map(raw => raw.trim())
    .filter(Boolean)
    .map(line => ({ line, section: isSectionLine(line) }));
  const body = items.filter(it => !it.section);
  if (body.length < 2) return null;

  // 格式 A：同行分隔（|| 或 \t）
  const inlineParsed = items.map(it => (it.section ? null : splitInlineBilingual(it.line)));
  const inlineHits = inlineParsed.filter(Boolean).length;
  if (inlineHits >= 2 && inlineHits / body.length >= 0.6) {
    const rows = [];
    items.forEach((it, idx) => {
      if (it.section) {
        rows.push({ kind: 'section', text: cleanSectionTitle(it.line) });
        return;
      }
      const pair = inlineParsed[idx];
      if (pair) rows.push(...splitPairToRows(pair.en, pair.zh, splitFn));
      else rows.push(...splitPlainLine(it.line, splitFn));
    });
    return { rows, bilingual: true };
  }

  // 格式 B：双行交替（英文为主行 + 中文为主行），不跨章节配对
  const pairStart = new Map();
  let pairCount = 0;
  for (let i = 0; i < items.length;) {
    const cur = items[i];
    const next = items[i + 1];
    if (!cur.section && next && !next.section && isLatinDominant(cur.line) && detectScriptLang(next.line) === 'zh') {
      pairStart.set(i, next.line);
      pairCount++;
      i += 2;
    } else {
      i += 1;
    }
  }
  if (pairCount >= 2 && (pairCount * 2) / body.length >= 0.6) {
    const rows = [];
    for (let i = 0; i < items.length;) {
      const it = items[i];
      if (it.section) {
        rows.push({ kind: 'section', text: cleanSectionTitle(it.line) });
        i += 1;
        continue;
      }
      if (pairStart.has(i)) {
        rows.push(...splitPairToRows(it.line, pairStart.get(i), splitFn));
        i += 2;
        continue;
      }
      rows.push(...splitPlainLine(it.line, splitFn));
      i += 1;
    }
    return { rows, bilingual: true };
  }

  return null;
}

/* ── 字幕形态分析与双语 SRT 拆轨 ── */

function splitCueLines(cue) {
  const rawLines =
    Array.isArray(cue?.rawLines) && cue.rawLines.length
      ? cue.rawLines.map(s => String(s || '').trim()).filter(Boolean)
      : String(cue?.text || '')
          .split(/\r?\n/)
          .map(s => s.trim())
          .filter(Boolean);
  const enLines = [];
  const zhLines = [];
  for (const line of rawLines) {
    const lang = detectScriptLang(line);
    if (lang === 'en') enLines.push(line);
    else if (lang === 'zh' || hasCjk(line)) zhLines.push(line);
    else enLines.push(line);
  }
  return { rawLines, enLines, zhLines };
}

export function inspectSubtitleCues(cues, scriptLines = []) {
  if (!Array.isArray(cues) || !cues.length) return { kind: 'source', cues: [] };

  const multiLine = cues.filter(c => Array.isArray(c?.rawLines) && c.rawLines.length >= 2);
  let bilingualMulti = 0;
  for (const cue of multiLine) {
    const hasEn = cue.rawLines.some(l => isLatinDominant(l));
    const hasZh = cue.rawLines.some(l => isZhSide(l));
    if (hasEn && hasZh) bilingualMulti++;
  }
  const enoughCoverage =
    cues.length <= 2 ? bilingualMulti >= 1 : bilingualMulti >= Math.max(2, Math.ceil(cues.length * 0.3));
  if (multiLine.length > 0 && bilingualMulti > multiLine.length / 2 && enoughCoverage) {
    const enCues = [];
    const zhCues = [];
    for (const cue of cues) {
      if (!cue || !Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.end <= cue.start) continue;
      const { enLines, zhLines } = splitCueLines(cue);
      if (enLines.length) {
        enCues.push({ start: cue.start, end: cue.end, text: joinSentences(enLines), rawLines: enLines });
      }
      if (zhLines.length) {
        zhCues.push({ start: cue.start, end: cue.end, text: joinSentences(zhLines), rawLines: zhLines });
      }
    }
    return { kind: 'bilingual', enCues, zhCues };
  }

  const scriptText = (scriptLines || [])
    .map(item => (typeof item === 'string' ? item : item?.text || ''))
    .join(' ')
    .trim();
  const cueText = cues.map(c => c?.text || '').join(' ');
  if (scriptText && detectScriptLang(scriptText) === 'en' && detectScriptLang(cueText) === 'zh') {
    return { kind: 'translation', cues };
  }

  return { kind: 'source', cues };
}

export function rowsFromBilingualSrt(cues) {
  const rows = [];
  const enCues = [];
  const zhCues = [];
  let duration = 0;
  let seq = 0;
  for (const cue of cues || []) {
    if (!cue || !Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.end <= cue.start) continue;
    duration = Math.max(duration, cue.end);
    const { enLines, zhLines } = splitCueLines(cue);
    const enText = joinSentences(enLines).trim();
    const zhText = joinSentences(zhLines).trim();
    if (enText) enCues.push({ start: cue.start, end: cue.end, text: enText, rawLines: enLines });
    if (zhText) zhCues.push({ start: cue.start, end: cue.end, text: zhText, rawLines: zhLines });
    const text = enText || zhText;
    if (!text) continue;
    rows.push({
      id: ++seq,
      kind: 'line',
      text,
      ...(enText && zhText ? { sub: zhText } : {}),
      note: '',
      type: null,
      para: true,
      time: { start: roundSec(cue.start), end: roundSec(cue.end), conf: 1, st: 'ok' },
    });
  }
  return { rows, enCues, zhCues, duration };
}

/* ── 中文字幕轨 ↔ 口播句映射 ── */

function validSortedCues(cues) {
  if (!Array.isArray(cues)) return [];
  return cues
    .filter(
      c =>
        c &&
        typeof c === 'object' &&
        Number.isFinite(c.start) &&
        Number.isFinite(c.end) &&
        c.start >= 0 &&
        c.end > c.start &&
        typeof c.text === 'string' &&
        c.text.trim(),
    )
    .map((c, idx) => ({ start: c.start, end: c.end, text: c.text.trim(), idx }))
    .sort((a, b) => a.start - b.start || a.end - b.end || a.idx - b.idx);
}

/* 按时间区间把中文字幕 cues 映射到一组带 id 和起止时间的句子槽位 */
function mapCuesToTimedSlots(slots, sortedCues) {
  const buckets = new Map();
  const push = (id, text) => {
    const list = buckets.get(id);
    if (list) list.push(text);
    else buckets.set(id, [text]);
  };
  for (const cue of sortedCues) {
    let bestId = null;
    let bestOv = 0;
    for (const slot of slots) {
      const ov = Math.min(cue.end, slot.end) - Math.max(cue.start, slot.start);
      if (ov > bestOv + 1e-9) {
        bestOv = ov;
        bestId = slot.id;
      }
    }
    if (bestId == null) {
      const mid = (cue.start + cue.end) / 2;
      let bestDist = Infinity;
      for (const slot of slots) {
        const dist = mid < slot.start ? slot.start - mid : mid > slot.end ? mid - slot.end : 0;
        if (dist < bestDist - 1e-9) {
          bestDist = dist;
          bestId = slot.id;
        }
      }
    }
    if (bestId != null) push(bestId, cue.text);
  }
  const mapped = new Map();
  for (const [id, parts] of buckets) {
    const joined = joinSentences(parts).trim();
    if (joined) mapped.set(id, joined);
  }
  return mapped;
}

export function mapSubCuesToLines(lines, tl, cues) {
  const list = Array.isArray(lines) ? lines : [];
  const sortedCues = validSortedCues(cues);
  const duration = sortedCues.reduce((mx, c) => Math.max(mx, c.end), 0);
  if (!list.length || !sortedCues.length) {
    return { mapped: new Map(), matched: 0, total: list.length, cues: sortedCues.length, duration };
  }

  const slots = [];
  if (tl && tl.total > 0 && tl.times) {
    for (const line of list) {
      const tm = tl.times.get(line.id);
      if (tm && Number.isFinite(tm.start) && Number.isFinite(tm.end) && tm.end > tm.start) {
        slots.push({ id: line.id, start: tm.start, end: tm.end });
      }
    }
  }

  let mapped;
  if (slots.length) {
    mapped = mapCuesToTimedSlots(slots, sortedCues);
  } else {
    // 尚无任何时间轴：按顺序比例均匀映射
    const buckets = new Map();
    const n = list.length;
    const m = sortedCues.length;
    for (let i = 0; i < m; i++) {
      const idx = Math.min(n - 1, Math.floor((i * n) / m));
      const id = list[idx].id;
      const arr = buckets.get(id);
      if (arr) arr.push(sortedCues[i].text);
      else buckets.set(id, [sortedCues[i].text]);
    }
    mapped = new Map();
    for (const [id, parts] of buckets) {
      const joined = joinSentences(parts).trim();
      if (joined) mapped.set(id, joined);
    }
  }

  return { mapped, matched: mapped.size, total: list.length, cues: sortedCues.length, duration };
}

/* ── 批量粘贴中文译文 ── */

export function parseBatchTranslations(text, lines, splitFn) {
  const list = Array.isArray(lines) ? lines : [];
  const rawLines = String(text || '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !isSectionLine(l));
  if (!rawLines.length || !list.length) {
    return { mapped: new Map(), matched: 0, total: list.length, extra: rawLines.length };
  }

  let items = rawLines;
  const target = list.length;
  if (typeof splitFn === 'function' && rawLines.length <= target * 0.6) {
    const splitItems = rawLines
      .flatMap(l => splitFn(l))
      .map(s => s.trim())
      .filter(Boolean);
    if (
      splitItems.length > rawLines.length &&
      Math.abs(splitItems.length - target) < Math.abs(rawLines.length - target)
    ) {
      items = splitItems;
    }
  }

  const mapped = new Map();
  const matched = Math.min(items.length, target);
  for (let i = 0; i < matched; i++) {
    mapped.set(list[i].id, items[i]);
  }
  return { mapped, matched, total: target, extra: Math.max(0, items.length - target) };
}

/* ── 播放时刻查字幕 & 所见即所得解析 ── */

export function cueAtTime(cues, t) {
  if (!Array.isArray(cues) || !cues.length || !Number.isFinite(t)) return null;
  let lo = 0;
  let hi = cues.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t + 1e-3) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (ans < 0) return null;
  const hit = cues[ans];
  if (t < hit.end) return hit;
  // 极少数重叠字幕：回退检查前几条是否覆盖当前时刻
  for (let i = ans - 1; i >= 0 && i >= ans - 3; i--) {
    if (cues[i].start <= t + 1e-3 && t < cues[i].end) return cues[i];
  }
  return null;
}

const normSubCompare = text =>
  String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');

export function isSameSubText(a, b) {
  const sa = String(a || '').trim();
  const sb = String(b || '').trim();
  if (sa === sb) return true;
  const na = normSubCompare(sa);
  const nb = normSubCompare(sb);
  return !!na && na === nb;
}

// 缓存 (tl, subTiming.cues) → Map<rowId, derivedSub>，确保每帧播放 O(1) 判断 WYSIWYG
const derivedMapCache = new WeakMap();
function derivedSubMap(tl, cues) {
  if (!tl?.times || !Array.isArray(cues) || !cues.length) return null;
  let byCues = derivedMapCache.get(tl);
  if (!byCues) {
    byCues = new WeakMap();
    derivedMapCache.set(tl, byCues);
  }
  let cached = byCues.get(cues);
  if (!cached) {
    const slots = [];
    for (const [id, tm] of tl.times) {
      if (tm && Number.isFinite(tm.start) && Number.isFinite(tm.end) && tm.end > tm.start) {
        slots.push({ id, start: tm.start, end: tm.end });
      }
    }
    const sorted = validSortedCues(cues);
    cached = slots.length && sorted.length ? mapCuesToTimedSlots(slots, sorted) : new Map();
    byCues.set(cues, cached);
  }
  return cached;
}

function derivedSubForRow(row, tl, cues) {
  if (!row || !Array.isArray(cues) || !cues.length) return '';
  if (tl?.times) {
    const map = derivedSubMap(tl, cues);
    return map?.get(row.id) || '';
  }
  const span = row.time;
  if (!span || !Number.isFinite(span.start) || !Number.isFinite(span.end) || span.end <= span.start) return '';
  const parts = [];
  for (const c of cues) {
    if (!c || !Number.isFinite(c.start) || !Number.isFinite(c.end) || c.end <= c.start) continue;
    const ov = Math.min(c.end, span.end) - Math.max(c.start, span.start);
    if (ov > 0 && ov >= (c.end - c.start) * 0.5) parts.push(String(c.text || '').trim());
  }
  return joinSentences(parts.filter(Boolean)).trim();
}

/* 检查用户是否手工修改过任意一句的 row.sub（用于字幕导出 WYSIWYG 判定） */
export function hasManualSubEdits(lines, tl, subTiming) {
  const cues = subTiming?.cues;
  if (!Array.isArray(cues) || !cues.length) return true;
  const list = Array.isArray(lines) ? lines : [];
  const hasAnyLineSub = list.some(r => typeof r?.sub === 'string' && r.sub.trim());
  if (!hasAnyLineSub) return false;
  const { mapped } = mapSubCuesToLines(list, tl, cues);
  for (const r of list) {
    const cur = typeof r?.sub === 'string' ? r.sub.trim() : '';
    const orig = mapped.get(r.id) || '';
    if (!isSameSubText(cur, orig)) return true;
  }
  return false;
}

export function resolvePlaybackSub({ row, time, subTiming, tl, displayMode = 'zh', bilingual = false } = {}) {
  const en = typeof row?.text === 'string' ? row.text : '';
  if (!bilingual) {
    return { showOverlay: false, overlayZh: '', overlayEn: '', barText: en };
  }

  const cues = Array.isArray(subTiming?.cues) && subTiming.cues.length ? subTiming.cues : null;
  const timedCue = cues ? cueAtTime(cues, time) : null;
  const rowSub = typeof row?.sub === 'string' ? row.sub.trim() : '';

  let zh;
  if (row) {
    if (cues) {
      if (!rowSub) {
        zh = timedCue?.text || '';
      } else {
        const derived = derivedSubForRow(row, tl, cues);
        // 未手工改过则走 subTiming 精确跳字与静音消隐；手工改过则直接展示用户校对后的 row.sub
        zh = derived && isSameSubText(rowSub, derived) ? timedCue?.text || '' : rowSub;
      }
    } else {
      zh = rowSub;
    }
  } else {
    zh = timedCue?.text || '';
  }

  const mode = ['zh', 'both', 'en', 'off'].includes(displayMode) ? displayMode : 'zh';
  if (mode === 'off') return { showOverlay: false, overlayZh: '', overlayEn: '', barText: en };
  if (mode === 'en') return { showOverlay: !!en, overlayZh: '', overlayEn: en, barText: en };
  if (mode === 'both') return { showOverlay: !!(zh || en), overlayZh: zh, overlayEn: en, barText: en };
  return { showOverlay: !!zh, overlayZh: zh, overlayEn: '', barText: en };
}

/* ── 标准 UTF-8 SRT 导出 ── */

function formatSrtTs(sec) {
  const ms = Math.max(0, Math.round((Number.isFinite(sec) ? sec : 0) * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  const rest = ms % 1000;
  const p = (n, len = 2) => String(n).padStart(len, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(rest, 3)}`;
}

function cleanSingleLine(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/-->/g, '→')
    .trim();
}

function formatEntriesToSrt(entries) {
  if (!entries.length) return { srt: '', count: 0 };
  // 排序并裁切微重叠，确保相邻 prev.end <= cur.start
  const sorted = entries.slice().sort((a, b) => a.start - b.start || a.order - b.order);
  const clean = [];
  for (const item of sorted) {
    let { start, end } = item;
    const prev = clean.at(-1);
    if (prev && start < prev.end) {
      if (start > prev.start) prev.end = start;
      else start = prev.end;
    }
    if (end <= start) continue;
    clean.push({ ...item, start, end });
  }
  if (!clean.length) return { srt: '', count: 0 };
  const srt =
    clean
      .map((item, i) => `${i + 1}\n${formatSrtTs(item.start)} --> ${formatSrtTs(item.end)}\n${item.text}`)
      .join('\n\n') + '\n';
  return { srt, count: clean.length };
}

function entriesFromLines(lines, tl, textOf) {
  const out = [];
  lines.forEach((row, idx) => {
    const tm = tl.times.get(row.id);
    if (!tm || !Number.isFinite(tm.start) || !Number.isFinite(tm.end) || tm.end <= tm.start) return;
    const text = textOf(row);
    if (!text) return;
    out.push({ start: Math.max(0, tm.start), end: tm.end, text, order: idx });
  });
  return out;
}

export function buildSrtDocument({ project, tl, track = 'zh' } = {}) {
  const mode = ['zh', 'en', 'bilingual', 'source'].includes(track) ? track : 'zh';
  const rows = Array.isArray(project?.rows) ? project.rows : [];
  const lines = rows.filter(r => r && r.kind === 'line');
  const resolvedTl =
    tl ||
    buildTimeline(lines, {
      voiceDuration: project?.voice?.duration ?? null,
      speechRate: project?.speechRate,
    });

  if (mode === 'en' || mode === 'source') {
    const cues = validSortedCues(project?.timing?.cues);
    const raw = typeof project?.timing?.raw === 'string' ? project.timing.raw : '';
    if (raw.trim()) {
      const count =
        cues.length ||
        raw
          .trim()
          .split(/\r?\n\s*\r?\n/)
          .filter(Boolean).length;
      return { srt: raw, count, track: mode };
    }
    if (cues.length) {
      const entries = cues
        .map((c, idx) => ({ start: c.start, end: c.end, text: cleanSingleLine(c.text), order: idx }))
        .filter(e => e.text);
      return { ...formatEntriesToSrt(entries), track: mode };
    }
    const entries = entriesFromLines(lines, resolvedTl, r => cleanSingleLine(r.text));
    return { ...formatEntriesToSrt(entries), track: mode };
  }

  if (mode === 'zh') {
    const subCues = validSortedCues(project?.subTiming?.cues);
    const subRaw = typeof project?.subTiming?.raw === 'string' ? project.subTiming.raw : '';
    const manual = hasManualSubEdits(lines, resolvedTl, project?.subTiming);
    if (subCues.length && !manual) {
      if (subRaw.trim()) return { srt: subRaw, count: subCues.length, track: mode };
      const entries = subCues
        .map((c, idx) => ({ start: c.start, end: c.end, text: cleanSingleLine(c.text), order: idx }))
        .filter(e => e.text);
      return { ...formatEntriesToSrt(entries), track: mode };
    }
    const entries = entriesFromLines(lines, resolvedTl, r => cleanSingleLine(r.sub));
    return { ...formatEntriesToSrt(entries), track: mode };
  }

  // 'bilingual'：每条为「中文\n英文」（缺中文时只写英文），保留真实换行
  const entries = entriesFromLines(lines, resolvedTl, r => {
    const zh = cleanSingleLine(r.sub);
    const en = cleanSingleLine(r.text);
    if (zh && en) return `${zh}\n${en}`;
    return en || zh;
  });
  return { ...formatEntriesToSrt(entries), track: mode };
}
