/* 稿子文件读取（主进程用，纯 Node，无 Electron 依赖，便于单测）：
   - .md / .markdown / .txt / .srt / .vtt：按 UTF-8 读，失败回退 UTF-16 / GBK（Windows 记事本存的中文稿）
   - .docx：自带最小 ZIP 解析 + zlib 解压 word/document.xml，按段落取文字；标题样式段落转成「## 标题」，
     这样后续分句逻辑能直接识别为章节。不引第三方库。 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { findEocd, eocdInfo, zip64Directory, parseCentralDirectory, localDataStart } = require('./zip-directory');

const SCRIPT_EXTS = ['md', 'markdown', 'txt', 'docx', 'json', 'srt', 'vtt', 'ass', 'zip'];
const MAX_BYTES = 30 * 1024 * 1024;

function looksLatinWin1252(buf) {
  const len = Math.min(buf.length, 65536);
  let asciiLetters = 0;
  let high = 0;
  let isolatedHigh = 0;
  let win1252Punct = 0;
  for (let i = 0; i < len; i++) {
    const b = buf[i];
    if ((b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a)) asciiLetters++;
    else if (b >= 0x80) {
      high++;
      const prevHigh = i > 0 && buf[i - 1] >= 0x80;
      const nextHigh = i + 1 < len && buf[i + 1] >= 0x80;
      if (!prevHigh && !nextHigh) isolatedHigh++;
      if (b === 0x85 || (b >= 0x91 && b <= 0x97)) win1252Punct++;
    }
  }
  if (!high || asciiLetters < 4) return false;
  if (high / len > 0.15 || asciiLetters < high * 2) return false;
  return isolatedHigh * 2 >= high || win1252Punct * 2 >= high;
}

function decodeText(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    const fallbacks = looksLatinWin1252(buf)
      ? ['windows-1252', 'gb18030', 'gbk', 'big5']
      : ['gb18030', 'gbk', 'big5', 'windows-1252'];
    for (const enc of fallbacks) {
      try {
        return new TextDecoder(enc, { fatal: true }).decode(buf);
      } catch {
        /* 这个运行时不支持该编码，或字节序列不合法，换下一个 */
      }
    }
    return buf.toString('utf8');
  }
}

/* ── 最小 ZIP 读取：只取一个条目（目录解析和项目包共用 zip-directory.js） ── */
function readZipEntry(buf, wanted) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是有效的 docx（找不到 ZIP 目录）');
  let { count, cdSize, cdStart, zip64At } = eocdInfo(buf, eocd);
  if (zip64At != null) {
    if (!Number.isSafeInteger(zip64At) || zip64At < 0 || zip64At + 56 > buf.length)
      throw new Error('docx ZIP64 目录损坏');
    ({ count, cdSize, cdStart } = zip64Directory(buf.subarray(zip64At, zip64At + 56)));
  }
  if (
    !Number.isSafeInteger(cdStart) ||
    !Number.isSafeInteger(cdSize) ||
    cdStart < 0 ||
    cdSize < 0 ||
    cdStart + cdSize > buf.length
  )
    throw new Error('docx 内部结构损坏');
  const target = String(wanted || '').toLowerCase();
  const entry = parseCentralDirectory(buf.subarray(cdStart, cdStart + cdSize), count).find(
    e => e.name.toLowerCase() === target,
  );
  if (!entry) return null;
  if (!Number.isSafeInteger(entry.local) || entry.local < 0 || entry.local + 30 > buf.length)
    throw new Error('docx 内部结构损坏');
  const start = localDataStart(buf.subarray(entry.local, entry.local + 30), entry.local);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(entry.csize) ||
    start < 0 ||
    entry.csize < 0 ||
    start + entry.csize > buf.length
  )
    throw new Error('docx 内部结构损坏');
  const data = buf.subarray(start, start + entry.csize);
  if (entry.method === 0) {
    if (data.length > MAX_BYTES) throw new Error('docx 正文太大');
    return data;
  }
  if (entry.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_BYTES });
  throw new Error('docx 使用了不支持的压缩方式');
}

const XML_ENTITIES = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };
const decodeXml = s =>
  s.replace(/&(lt|gt|quot|apos|amp|#x([0-9a-f]+)|#(\d+));/gi, (m, name, hex, dec) => {
    if (hex != null) {
      const cp = parseInt(hex, 16);
      return Number.isSafeInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    if (dec != null) {
      const cp = parseInt(dec, 10);
      return Number.isSafeInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return XML_ENTITIES[name.toLowerCase()] ?? m;
  });

function stripElement(xml, tag) {
  const re = new RegExp(`<${tag}(?=[\\s/>])[^>]*?(?:\\/>|>)|<\\/${tag}>`, 'g');
  let out = '';
  let last = 0;
  let depth = 0;
  for (const m of xml.matchAll(re)) {
    const tok = m[0];
    if (tok.startsWith('</')) {
      if (depth > 0) {
        depth--;
        if (depth === 0) last = m.index + tok.length;
      }
    } else if (tok.endsWith('/>')) {
      if (depth === 0) {
        out += xml.slice(last, m.index);
        last = m.index + tok.length;
      }
    } else {
      if (depth === 0) out += xml.slice(last, m.index);
      depth++;
    }
  }
  if (depth === 0) out += xml.slice(last);
  return out;
}

function extractParagraphs(body) {
  const re = /<w:p(?=[\s/>])[^>]*?(?:\/>|>)|<\/w:p>/g;
  const paragraphs = [];
  const stack = [];
  let cursor = 0;
  for (const m of body.matchAll(re)) {
    const tok = m[0];
    if (tok.startsWith('</')) {
      if (!stack.length) continue;
      const top = stack.pop();
      top.chunks.push(body.slice(cursor, m.index));
      paragraphs[top.slot] = top.chunks.join('');
      cursor = m.index + tok.length;
    } else if (tok.endsWith('/>')) {
      if (stack.length) stack[stack.length - 1].chunks.push(body.slice(cursor, m.index));
      else paragraphs.push('');
      cursor = m.index + tok.length;
    } else {
      if (stack.length) stack[stack.length - 1].chunks.push(body.slice(cursor, m.index));
      const slot = paragraphs.length;
      paragraphs.push('');
      stack.push({ slot, chunks: [] });
      cursor = m.index + tok.length;
    }
  }
  while (stack.length) {
    const top = stack.pop();
    paragraphs[top.slot] = top.chunks.join('');
  }
  return paragraphs;
}

/* 标题样式：英文版 Heading1 / Title，中文版常见 styleId 为 1、2…，也可能直接叫「标题 1」 */
const HEADING_STYLE = /<w:pStyle\s+w:val="(?:Heading\d*|heading\s*\d*|Title|\d|标题\s*\d*)"/i;
const PARA_TOKEN_RE =
  /<w:t(?:\s[^>]*)?(?<!\/)>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*?(?:\/>|>[\s\S]*?<\/w:tab>)|<w:(?:br|cr)\b[^>]*?(?:\/>|>[\s\S]*?<\/w:(?:br|cr)>)|<w:noBreakHyphen\b[^>]*?(?:\/>|>[\s\S]*?<\/w:noBreakHyphen>)/g;

function docxToText(buf) {
  const xmlBuf = readZipEntry(buf, 'word/document.xml');
  if (!xmlBuf) throw new Error('docx 里没有正文（word/document.xml）');
  let body = xmlBuf.toString('utf8');
  for (const tag of ['w:del', 'w:moveFrom', 'mc:Fallback', 'w:instrText']) body = stripElement(body, tag);
  const out = [];
  for (const inner of extractParagraphs(body)) {
    let text = '';
    for (const t of inner.matchAll(PARA_TOKEN_RE)) {
      if (t[1] != null) text += decodeXml(t[1]);
      else if (t[0].startsWith('<w:tab')) text += ' ';
      else if (t[0].startsWith('<w:noBreakHyphen')) text += '-';
      else text += '\n';
    }
    text = text.replace(/\s+$/g, '');
    if (!text.trim()) {
      out.push('');
      continue;
    }
    const pPr = (inner.match(/<w:pPr\b[^>]*>[\s\S]*?<\/w:pPr>/) || [''])[0];
    const heading = HEADING_STYLE.test(pPr) || /<w:outlineLvl\s+w:val="[0-5]"/.test(pPr);
    const maxHeadingLen = /[A-Za-z]/.test(text) ? 140 : 60;
    out.push(heading && text.length <= maxHeadingLen && !text.includes('\n') ? `## ${text.trim()}` : text);
  }
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* 读一个稿子文件 → { name, ext, content } 或 { error } */
function readScriptFile(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return { error: '无法识别这个文件路径' };
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!SCRIPT_EXTS.includes(ext)) return { error: `不支持导入 .${ext || '无后缀'} 文件` };
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return { error: '这不是一个文件' };
    // 打包的项目（ZIP）可能有几个 GB：不读进内存，只把路径交给界面，由主进程边读边解压
    if (ext === 'zip') return { name: path.basename(file), ext, content: '', path: file, size: st.size };
    if (st.size > MAX_BYTES) return { error: '文件太大（超过 30MB），不像是稿子' };
    const buf = fs.readFileSync(file);
    const content = ext === 'docx' ? docxToText(buf) : decodeText(buf);
    return { name: path.basename(file), ext, content, path: file }; // path：视频候选清单要回写审核结果
  } catch (e) {
    return { error: '读取失败：' + (e && e.message ? e.message : e) };
  }
}

module.exports = { readScriptFile, docxToText, decodeText, readZipEntry, SCRIPT_EXTS };
