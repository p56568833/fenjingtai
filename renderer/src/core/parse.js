/* 导入解析：整篇口播稿 → rows；带批注 MD → rows（类型和备注一起恢复）。纯函数，无 DOM。 */
import { DEFAULT_TYPES, normalizeTypes } from './types.js';
import { cleanRework } from './asset-usage.js';
import { parseBilingualLines } from './bilingual.js';

const HARD_END_RE = /[。！？；!?…]/;
const CLOSER_RE = /[”’」』）】\]"')》〉]/;
const EN_ABBRS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'sr',
  'jr',
  'st',
  'mt',
  'inc',
  'ltd',
  'corp',
  'co',
  'vs',
  'etc',
  'e.g',
  'i.e',
  'no',
  'vol',
  'fig',
  'eq',
  'jan',
  'feb',
  'mar',
  'apr',
  'aug',
  'sep',
  'sept',
  'oct',
  'nov',
  'dec',
]);
const INITIALISM_RE = /(?:^|[^\p{Script=Latin}\p{N}])(?:[A-Za-z]{1,2}\.)+[A-Za-z]$/u;
const WORD_BEFORE_DOT_RE = /([A-Za-z]+(?:\.[A-Za-z]+)*)$/;

function skipClosers(s, pos) {
  const seenQuote = new Set();
  let end = pos;
  while (end < s.length && CLOSER_RE.test(s[end])) {
    const ch = s[end];
    if ((ch === '"' || ch === "'") && seenQuote.has(ch)) break;
    if (ch === '"' || ch === "'") seenQuote.add(ch);
    end++;
  }
  return end;
}

function isNonBreakingDot(s, dotIndex) {
  const before = s.slice(0, dotIndex);
  if (/\d$/.test(before) && /^\d/.test(s.slice(dotIndex + 1))) return true;
  if (INITIALISM_RE.test(before)) return true;
  const wm = before.match(WORD_BEFORE_DOT_RE);
  if (wm && EN_ABBRS.has(wm[1].toLowerCase())) return true;
  return false;
}

export function splitSentences(text) {
  const s = String(text || '');
  const rawParts = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (HARD_END_RE.test(ch)) {
      let end = i + 1;
      while (end < s.length && HARD_END_RE.test(s[end])) end++;
      end = skipClosers(s, end);
      rawParts.push(s.slice(start, end));
      start = end;
      i = end - 1;
      continue;
    }
    if (ch === '.') {
      let dotEnd = i + 1;
      while (dotEnd < s.length && s[dotEnd] === '.') dotEnd++;
      const dotCount = dotEnd - i;
      if (dotCount >= 2) {
        let end = dotEnd;
        while (end < s.length && (HARD_END_RE.test(s[end]) || s[end] === '.')) end++;
        const after = skipClosers(s, end);
        if (after === s.length || /\s/.test(s[after])) {
          rawParts.push(s.slice(start, after));
          start = after;
          i = after - 1;
          continue;
        }
        i = dotEnd - 1;
        continue;
      }
      const after = skipClosers(s, dotEnd);
      const atBoundary = after === s.length || /\s/.test(s[after]);
      if (atBoundary && !isNonBreakingDot(s, i)) {
        rawParts.push(s.slice(start, after));
        start = after;
        i = after - 1;
      }
    }
  }
  if (start < s.length) rawParts.push(s.slice(start));

  const result = [];
  for (const part of rawParts) {
    const t = part.trim();
    if (!t) continue;
    if (result.length && !/[\p{L}\p{N}]/u.test(t)) result[result.length - 1] += t;
    else result.push(t);
  }
  return result;
}

/* 共用画面编号只允许这种形状：会拼进 HTML 属性和选择器，外来数据一律校验 */
export const GROUP_ID = /^[\w-]{1,80}$/;

const HEADING_RE = /^#{1,6}\s+\S.*$/;
const H1_RE = /^#\s+\S.*$/;
const H2_6_RE = /^#{2,6}\s+\S.*$/;
const BRACKET_SECTION_RE = /^【[^】]+】$/;
const isSectionLine = line => HEADING_RE.test(line) || BRACKET_SECTION_RE.test(line);

let uid = 0;
const nid = () => ++uid;

/* 老版本把「## 章节」行错存成了普通句子，载入时自动转回章节 */
export function migrateSections(rows) {
  for (const r of rows) {
    const trimmed = (r.text || '').trim();
    if (r.kind === 'line' && isSectionLine(trimmed)) {
      r.kind = 'section';
      r.text = trimmed
        .replace(/^#{1,6}\s*/, '')
        .replace(/[【】]/g, '')
        .trim();
      delete r.note;
      delete r.type;
      delete r.para;
    }
  }
  return rows;
}

/* 按标点分句，【】/# 开头识别为章节；每个源行的第一句打 para 标记，
   勾选视图靠它把句子还原成原来的段落排版 */
export function parseScript(text) {
  const bi = parseBilingualLines(text, splitSentences);
  if (bi?.bilingual) return bi.rows.map(r => ({ id: nid(), ...r }));
  const rows = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (isSectionLine(line)) {
      rows.push({
        id: nid(),
        kind: 'section',
        text: line
          .replace(/^#{1,6}\s*/, '')
          .replace(/[【】]/g, '')
          .trim(),
      });
      continue;
    }
    const parts = splitSentences(line);
    parts.forEach((p, i) => rows.push({ id: nid(), kind: 'line', text: p, note: '', type: null, para: i === 0 }));
  }
  return rows;
}

/* 带批注 MD（本软件导出的格式）：
   - [A roll · 真人出镜] 句子（备注：…）
   - [B roll · 真实素材] 句子（画面：…）
   章节行 ## xxx，标题 # xxx。检测到该格式时返回 rows，否则 null 走普通分句。 */
/* 本软件导出的 MD 文首带一份类型表（自定义类型也能原样回读） */
const TYPES_RE = /^<!-- fj-types (.+) -->$/m;
const META_RE = /^<!-- fj-meta (.+) -->$/;
export function mdTypes(text) {
  const m = String(text || '').match(TYPES_RE);
  if (!m) return null;
  try {
    return normalizeTypes(JSON.parse(decodeURIComponent(m[1])));
  } catch {
    return null;
  }
}

function stripTrailingNote(body) {
  const s = body.trimEnd();
  if (!s.endsWith('）')) return { text: body.trim(), note: '' };
  let depth = 0;
  let open = -1;
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] === '）') depth++;
    else if (s[i] === '（') {
      depth--;
      if (depth === 0) {
        open = i;
        break;
      }
    }
  }
  if (open < 0) return { text: body.trim(), note: '' };
  const m = s.slice(open).match(/^（(?:画面|备注)：([\s\S]*)）$/);
  if (!m) return { text: body.trim(), note: '' };
  return { text: s.slice(0, open).trim(), note: m[1].trim() };
}

export function parseAnnotatedMd(text, types = DEFAULT_TYPES) {
  const lines = text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);
  const itemRe = /^-\s*\[(.+?)\]\s*(.+)$/;
  const list = mdTypes(text) || normalizeTypes(types);
  const name2type = { 未标注: null };
  // 默认五类的名字总能认出来（老版本导出的 MD），再叠加当前 / 文件自带的类型名
  for (const t of [...DEFAULT_TYPES, ...list]) {
    name2type[t.full] = t.id;
    name2type[t.label] = t.id;
  }
  const isKnownItem = l => {
    const m = l.match(itemRe);
    return !!(m && Object.hasOwn(name2type, m[1].trim()));
  };
  const preReview = [];
  for (const l of lines) {
    if (l === '<!-- fj-review -->') break;
    preReview.push(l);
  }
  const hasMarker = preReview.some(l => TYPES_RE.test(l) || META_RE.test(l));
  const bodyLines = preReview.filter(
    l =>
      !l.startsWith('> 交稿提示：') &&
      !TYPES_RE.test(l) &&
      !META_RE.test(l) &&
      !H1_RE.test(l) &&
      !H2_6_RE.test(l) &&
      !BRACKET_SECTION_RE.test(l),
  );
  const knownCount = bodyLines.filter(isKnownItem).length;
  if (!knownCount) return null; // 不像批注稿，按普通文本处理
  if (!hasMarker && !(bodyLines.length === 1 || (knownCount >= 2 && knownCount * 2 >= bodyLines.length))) return null;

  const rows = [];
  const idMap = new Map();
  for (const line of lines) {
    if (line === '<!-- fj-review -->') break;
    if (line.startsWith('> 交稿提示：') || TYPES_RE.test(line)) continue;
    const meta = line.match(META_RE);
    if (meta) {
      try {
        const value = JSON.parse(decodeURIComponent(meta[1])),
          last = rows[rows.length - 1];
        if (last?.kind === 'line') {
          if (Number.isInteger(value.id) && value.id > 0 && !idMap.has(value.id)) idMap.set(value.id, last.id);
          if (typeof value.note === 'string' && last.note === value.displayNote) last.note = value.note;
          if (typeof value.sub === 'string' && value.sub.trim()) last.sub = value.sub.trim();
          if (typeof value.groupId === 'string' && GROUP_ID.test(value.groupId)) last.groupId = value.groupId;
          if (typeof value.type === 'string' && list.some(t => t.id === value.type)) last.type = value.type;
          if (typeof value.assets === 'string') last.assets = value.assets;
          if (Array.isArray(value.assetUsages)) last.assetUsages = value.assetUsages; // 自包含素材记录（含片段范围），载入时并进素材库
          if (['todo', 'making', 'ready'].includes(value.status)) last.status = value.status;
          if (
            value.time &&
            typeof value.time === 'object' &&
            typeof value.time.start === 'number' &&
            typeof value.time.end === 'number' &&
            Number.isFinite(value.time.start) &&
            Number.isFinite(value.time.end) &&
            value.time.start >= 0 &&
            value.time.end >= value.time.start
          ) {
            const conf = typeof value.time.conf === 'number' && Number.isFinite(value.time.conf) ? value.time.conf : 0;
            last.time = {
              start: +value.time.start,
              end: +value.time.end,
              conf,
              st: ['ok', 'low', 'est'].includes(value.time.st) ? value.time.st : 'est',
            };
          }
          const rework = cleanRework(value.rework);
          if (rework) last.rework = rework;
          if (Number.isFinite(+value.reworkOff) && +value.reworkOff > 0) last.reworkOff = +value.reworkOff;
        }
      } catch {}
      continue;
    }
    const m = line.match(itemRe);
    if (m && Object.hasOwn(name2type, m[1].trim())) {
      const type = name2type[m[1].trim()];
      const { text: bodyText, note } = stripTrailingNote(m[2]);
      rows.push({ id: nid(), kind: 'line', text: bodyText, note, type: type ?? null, para: true }); // 批注稿一行一句，各自成段
      continue;
    }
    if (H1_RE.test(line)) continue; // 一级大标题（文档名），不进正文
    if (H2_6_RE.test(line) || BRACKET_SECTION_RE.test(line)) {
      rows.push({
        id: nid(),
        kind: 'section',
        text: line
          .replace(/^#{2,6}\s*/, '')
          .replace(/[【】]/g, '')
          .trim(),
      });
      continue;
    }
    // 普通文本行（含未知方括号列表行）：照旧分句，不吞掉
    splitSentences(line).forEach((p, i) =>
      rows.push({ id: nid(), kind: 'line', text: p, note: '', type: null, para: i === 0 }),
    );
  }
  for (const row of rows)
    for (const usage of row.assetUsages || [])
      if (usage?.at) {
        if (idMap.has(usage.at.of)) usage.at = { ...usage.at, of: idMap.get(usage.at.of) };
        else delete usage.at; // 原镜头起点已被删掉，不能继续引用别的句子。
      }
  return rows;
}

/* 统一入口：智能判断用哪种解析 */
export function parseAny(text, types = DEFAULT_TYPES) {
  return parseAnnotatedMd(text, types) || migrateSections(parseScript(text));
}
