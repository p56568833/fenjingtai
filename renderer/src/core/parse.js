/* 导入解析：整篇口播稿 → rows；带批注 MD → rows（类型和备注一起恢复）。纯函数，无 DOM。 */
import { DEFAULT_TYPES, normalizeTypes } from './types.js';

export function splitSentences(text) {
  const parts =
    text.match(/[^。！？；!?…]+(?:[。！？；!?…]+[”’」』）】\]"']*)?|[。！？；!?…]+[”’」』）】\]"']*/g) || [];
  const result = [];
  for (const part of parts) {
    const t = part.trim();
    if (!t) continue;
    if (result.length && !/[\p{L}\p{N}]/u.test(t)) result[result.length - 1] += t;
    else result.push(t);
  }
  return result;
}

/* 共用画面编号只允许这种形状：会拼进 HTML 属性和选择器，外来数据一律校验 */
export const GROUP_ID = /^[\w-]{1,80}$/;

let uid = 0;
const nid = () => ++uid;

/* 老版本把「## 章节」行错存成了普通句子，载入时自动转回章节 */
export function migrateSections(rows) {
  for (const r of rows) {
    if (r.kind === 'line' && /^(#{1,6}\s+.*|【[^】]+】)$/.test((r.text || '').trim())) {
      r.kind = 'section';
      r.text = r.text
        .trim()
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
  const rows = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#{1,6}\s+.+/.test(line) || /^【.+】$/.test(line)) {
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
export function mdTypes(text) {
  const m = String(text || '').match(TYPES_RE);
  if (!m) return null;
  try {
    return normalizeTypes(JSON.parse(decodeURIComponent(m[1])));
  } catch {
    return null;
  }
}

export function parseAnnotatedMd(text, types = DEFAULT_TYPES) {
  const lines = text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);
  const itemRe = /^-\s*\[(.+?)\]\s*(.+)$/;
  const hits = lines.filter(l => itemRe.test(l)).length;
  const list = mdTypes(text) || normalizeTypes(types);
  const name2type = { 未标注: null };
  // 默认五类的名字总能认出来（老版本导出的 MD），再叠加当前 / 文件自带的类型名
  for (const t of [...DEFAULT_TYPES, ...list]) {
    name2type[t.full] = t.id;
    name2type[t.label] = t.id;
  }
  const known = l => {
    const m = l.match(itemRe);
    return m && Object.hasOwn(name2type, m[1].trim());
  };
  if (!hits || !lines.some(known)) return null; // 不像批注稿，按普通文本处理

  const rows = [];
  for (const line of lines) {
    if (line === '<!-- fj-review -->') break;
    if (line.startsWith('> 交稿提示：') || TYPES_RE.test(line)) continue;
    const meta = line.match(/^<!-- fj-meta (.+) -->$/);
    if (meta) {
      try {
        const value = JSON.parse(decodeURIComponent(meta[1])),
          last = rows[rows.length - 1];
        if (last?.kind === 'line') {
          if (typeof value.note === 'string' && last.note === value.displayNote) last.note = value.note;
          if (typeof value.groupId === 'string' && GROUP_ID.test(value.groupId)) last.groupId = value.groupId;
          if (typeof value.type === 'string' && list.some(t => t.id === value.type)) last.type = value.type;
          if (typeof value.assets === 'string') last.assets = value.assets;
          if (Array.isArray(value.assetUsages)) last.assetUsages = value.assetUsages; // 自包含素材记录（含片段范围），载入时并进素材库
          if (['todo', 'making', 'ready'].includes(value.status)) last.status = value.status;
          last.needsReview = !!value.needsReview;
          if (value.time && Number.isFinite(+value.time.start) && Number.isFinite(+value.time.end))
            last.time = value.time;
        }
      } catch {}
      continue;
    }
    const m = line.match(itemRe);
    if (m) {
      const name = m[1].trim();
      if (!Object.hasOwn(name2type, name)) continue;
      const type = name2type[name]; // 方括号不是已知类型，跳过这行（可能是普通 MD 列表）
      let body = m[2];
      let note = '';
      const nm = body.match(/（(画面|备注)：(.*)）\s*$/);
      if (nm) {
        note = nm[2].trim();
        body = body.slice(0, nm.index);
      }
      rows.push({ id: nid(), kind: 'line', text: body.trim(), note, type: type ?? null, para: true }); // 批注稿一行一句，各自成段
      continue;
    }
    if (/^#\s+.+/.test(line)) continue; // 一级大标题（文档名），不进正文
    if (/^#{2,6}\s+.+/.test(line) || /^【.+】$/.test(line)) {
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
    // 普通文本行：照旧分句
    splitSentences(line).forEach((p, i) =>
      rows.push({ id: nid(), kind: 'line', text: p, note: '', type: null, para: i === 0 }),
    );
  }
  return rows;
}

/* 统一入口：智能判断用哪种解析 */
export function parseAny(text, types = DEFAULT_TYPES) {
  return migrateSections(parseAnnotatedMd(text, types) || parseScript(text));
}
