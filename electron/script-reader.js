/* 稿子文件读取（主进程用，纯 Node，无 Electron 依赖，便于单测）：
   - .md / .markdown / .txt / .srt / .vtt：按 UTF-8 读，失败回退 UTF-16 / GBK（Windows 记事本存的中文稿）
   - .docx：自带最小 ZIP 解析 + zlib 解压 word/document.xml，按段落取文字；标题样式段落转成「## 标题」，
     这样后续分句逻辑能直接识别为章节。不引第三方库。 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { findEocd, eocdInfo, parseCentralDirectory, localDataStart } = require('./zip-directory');

const SCRIPT_EXTS = ['md', 'markdown', 'txt', 'docx', 'json', 'srt', 'vtt', 'zip'];
const MAX_BYTES = 30 * 1024 * 1024;

function decodeText(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    for (const enc of ['gb18030', 'gbk', 'big5']) {
      try {
        return new TextDecoder(enc).decode(buf);
      } catch {
        /* 这个运行时没有这个编码，换下一个 */
      }
    }
    return buf.toString('utf8');
  }
}

/* ── 最小 ZIP 读取：只取一个条目（目录解析和项目包共用 zip-directory.js） ── */
function readZipEntry(buf, wanted) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是有效的 docx（找不到 ZIP 目录）');
  const { count, cdSize, cdStart } = eocdInfo(buf, eocd);
  const entry = parseCentralDirectory(buf.subarray(cdStart, cdStart + cdSize), count).find(e => e.name === wanted);
  if (!entry) return null;
  const start = localDataStart(buf.subarray(entry.local, entry.local + 30), entry.local);
  if (start < 0) throw new Error('docx 内部结构损坏');
  const data = buf.subarray(start, start + entry.csize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return zlib.inflateRawSync(data);
  throw new Error('docx 使用了不支持的压缩方式');
}

const decodeXml = s =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&amp;/g, '&');

/* 标题样式：英文版 Heading1 / Title，中文版常见 styleId 为 1、2…，也可能直接叫「标题 1」 */
const HEADING_STYLE = /<w:pStyle\s+w:val="(?:Heading\d*|heading\s*\d*|Title|\d|标题\s*\d*)"/i;

function docxToText(buf) {
  const xmlBuf = readZipEntry(buf, 'word/document.xml');
  if (!xmlBuf) throw new Error('docx 里没有正文（word/document.xml）');
  const xml = xmlBuf.toString('utf8');
  const body = xml.replace(/<w:del\b[\s\S]*?<\/w:del>/g, ''); // 修订模式下已删除的文字不要
  const out = [];
  for (const m of body.matchAll(/<w:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:p>)/g)) {
    const inner = m[1] || '';
    let text = '';
    for (const t of inner.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:(?:br|cr)\b[^>]*\/>/g)) {
      if (t[1] != null) text += decodeXml(t[1]);
      else if (t[0].startsWith('<w:tab')) text += ' ';
      else text += '\n';
    }
    text = text.replace(/\s+$/g, '');
    if (!text.trim()) {
      out.push('');
      continue;
    }
    const pPr = (inner.match(/<w:pPr>[\s\S]*?<\/w:pPr>/) || [''])[0];
    const heading = HEADING_STYLE.test(pPr) || /<w:outlineLvl\s+w:val="[0-5]"/.test(pPr);
    out.push(heading && text.length <= 60 && !text.includes('\n') ? `## ${text.trim()}` : text);
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
