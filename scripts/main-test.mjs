/* 主进程纯逻辑回归（不需要启动 Electron）：数据损坏自救 / 备份保留策略 / 备份路径校验 / 稿子文件读取（含 docx）/ 打包白名单
   用法：node scripts/main-test.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { shouldIgnore } from './package-filter.mjs';

const require = createRequire(import.meta.url);
const { createStore, retentionKeep } = require('../electron/data-store.js');
const { readScriptFile, docxToText } = require('../electron/script-reader.js');

let count = 0;
const test = (name, fn) => {
  fn();
  count++;
  console.log('✓', name);
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), '分镜台主进程测试-'));
const lib = title => ({ v: 2, currentId: 'p1', projects: { p1: { id: 'p1', title, rows: [], updatedAt: 1 } } });

/* ── 最小 ZIP 写入（造 docx 测试文件用） ── */
function crc32(buf) {
  let c,
    crc = 0xffffffff;
  for (const b of buf) {
    c = (crc ^ b) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(files) {
  const locals = [],
    centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, 'utf8'),
      data = zlib.deflateRawSync(raw),
      nameBuf = Buffer.from(name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc32(raw), 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc32(raw), 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, data);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const DOC_XML = `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>开场钩子</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">第一句话。</w:t></w:r><w:r><w:t>第二句 &amp; 结尾！</w:t></w:r></w:p>
<w:p/>
<w:p><w:pPr><w:pStyle w:val="1"/></w:pPr><w:r><w:t>正文</w:t></w:r></w:p>
<w:p><w:r><w:t>被删掉的</w:t></w:r><w:del><w:r><w:delText>旧字</w:delText></w:r></w:del><w:r><w:t>保留。</w:t></w:r></w:p>
</w:body></w:document>`;

/* ── 数据落盘 ── */
test('数据文件损坏：坏文件改名保留，自动用最近的可读备份恢复', () => {
  const dir = tmp();
  const store = createStore(() => dir);
  fs.mkdirSync(path.join(dir, '自动备份'), { recursive: true });
  const old = path.join(dir, '自动备份', '备份-2026-09-20 10-00-00.json');
  const newer = path.join(dir, '自动备份', '备份-2026-09-21 10-00-00.json');
  fs.writeFileSync(old, JSON.stringify(lib('旧备份')));
  fs.writeFileSync(newer, '{坏的');
  fs.utimesSync(old, new Date(Date.now() - 7200e3), new Date(Date.now() - 7200e3));
  fs.writeFileSync(path.join(dir, '分镜台数据.json'), '{"v":2,"projects":{"p1":');
  const data = store.load();
  assert.equal(data.projects.p1.title, '旧备份');
  assert.equal(store.info().status, 'recovered');
  assert.ok(
    fs.readdirSync(dir).some(f => f.startsWith('分镜台数据.损坏-')),
    '坏文件要留着',
  );
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '分镜台数据.json'), 'utf8')).projects.p1.title, '旧备份');
});
test('数据文件损坏且没有备份：返回 null + corrupt，坏文件不被覆盖', () => {
  const dir = tmp();
  const store = createStore(() => dir);
  fs.writeFileSync(path.join(dir, '分镜台数据.json'), 'not json');
  assert.equal(store.load(), null);
  assert.equal(store.info().status, 'corrupt');
  const kept = fs.readdirSync(dir).find(f => f.startsWith('分镜台数据.损坏-'));
  assert.equal(fs.readFileSync(path.join(dir, kept), 'utf8'), 'not json');
  store.save(lib('新的')); // 之后正常保存写的是新文件，坏文件原样还在
  assert.equal(fs.readFileSync(path.join(dir, kept), 'utf8'), 'not json');
});
test('正常读写 + 首次保存顺带备份上一版', () => {
  const dir = tmp();
  const store = createStore(() => dir);
  assert.equal(store.load(), null);
  assert.equal(store.info().status, 'missing');
  store.save(lib('A'));
  store._resetForTest();
  store.save(lib('B'));
  assert.equal(store.load().projects.p1.title, 'B');
  assert.equal(store.listBackups().length, 1);
});
test('备份保留：24 小时内全留，更早每天一份，30 天外清掉', () => {
  const now = Date.parse('2026-09-23T12:00:00');
  const h = 3600e3;
  const list = [
    ...Array.from({ length: 30 }, (_, i) => ({ f: `recent${i}`, t: now - i * 0.5 * h })), // 15 小时内 30 份
    { f: 'd2-late', t: now - 40 * h },
    { f: 'd2-early', t: now - 44 * h },
    { f: 'd5', t: now - 5 * 24 * h },
    { f: 'd40', t: now - 40 * 24 * h },
  ];
  const keep = retentionKeep(list, now);
  assert.equal([...keep].filter(f => f.startsWith('recent')).length, 30);
  assert.ok(keep.has('d2-late') && !keep.has('d2-early'));
  assert.ok(keep.has('d5') && !keep.has('d40'));
});
test('恢复备份只认备份目录里的文件名，拒绝 ../ 路径', () => {
  const dir = tmp();
  const store = createStore(() => dir);
  fs.writeFileSync(path.join(dir, 'secret.json'), JSON.stringify(lib('x')));
  assert.equal(store.readBackup('../secret.json').ok, false);
  assert.equal(store.readBackup('/etc/passwd').ok, false);
});

/* ── 稿子读取 ── */
test('docx：标题样式转成 ## 章节，段落保留，修订删除的文字不要', () => {
  const text = docxToText(zip({ '[Content_Types].xml': '<x/>', 'word/document.xml': DOC_XML }));
  assert.equal(text, '## 开场钩子\n第一句话。第二句 & 结尾！\n\n## 正文\n被删掉的保留。');
});
test('readScriptFile：docx / GBK 编码 txt / 不支持的后缀', () => {
  const dir = tmp();
  const docx = path.join(dir, '稿子.docx');
  fs.writeFileSync(docx, zip({ 'word/document.xml': DOC_XML }));
  const r = readScriptFile(docx);
  assert.equal(r.ext, 'docx');
  assert.ok(r.content.startsWith('## 开场钩子'));
  const gbk = path.join(dir, '旧稿.txt');
  fs.writeFileSync(gbk, Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0xa1, 0xa3])); // 「你好。」GBK
  assert.equal(readScriptFile(gbk).content, '你好。');
  assert.ok(readScriptFile(path.join(dir, 'a.exe')).error);
  assert.ok(readScriptFile('relative.txt').error);
});

/* ── 打包白名单 ── */
test('打包只带 electron / renderer / package.json，备份与自测文件不进安装包', () => {
  for (const p of ['/package.json', '/electron/main.js', '/renderer/index.html', '/renderer/src/state.js'])
    assert.equal(shouldIgnore(p), false, p);
  for (const p of [
    '/备份-2026-09-23/分镜台.app',
    '/分镜台.html',
    '/node_modules/x',
    '/renderer/src/selftest.js',
    '/scripts/test.mjs',
  ])
    assert.equal(shouldIgnore(p), true, p);
});

console.log(`${count} 项主进程回归通过`);
