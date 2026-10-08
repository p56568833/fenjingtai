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
  for (const p of ['/package.json', '/electron/main.js', '/renderer/index.html', '/renderer/src/app/state.js'])
    assert.equal(shouldIgnore(p), false, p);
  for (const p of [
    '/备份-2026-09-23/分镜台.app',
    '/分镜台.html',
    '/node_modules/x',
    '/renderer/src/selftest.js',
    '/renderer/src/test/selftest.js',
    '/renderer/src/test/workspace-selftest.js',
    '/scripts/test.mjs',
  ])
    assert.equal(shouldIgnore(p), true, p);
});

/* ── 视频审核（1.5） ── */
const vt = require('../electron/video-tools.js');
const atest = async (name, fn) => {
  await fn();
  count++;
  console.log('✓', name);
};
test('视频片段文件名：中文安全、带入出点，重名不覆盖', () => {
  assert.equal(vt.segmentFileBase('福特 1922: 肉类/加工', 101, 110.4), '福特 1922- 肉类-加工_1m41s-1m50s');
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'a.mp4'), '');
  fs.writeFileSync(path.join(dir, 'a (2).mp4'), '');
  assert.equal(vt.uniquePath(dir, 'a', '.mp4'), path.join(dir, 'a (3).mp4'));
  const args = vt.segmentArgs('https://x/v.mp4', 101, 110, '/o.mp4');
  assert.deepEqual(args.slice(args.indexOf('-ss'), args.indexOf('-ss') + 6), [
    '-ss',
    '101',
    '-i',
    'https://x/v.mp4',
    '-t',
    '9',
  ]);
  assert.equal(args.at(-1), '/o.mp4');
});
test('截取进度：从 ffmpeg -progress 输出里读出已处理秒数，参数里带 -progress pipe:1', () => {
  assert.equal(vt.progressSeconds('frame=10\nout_time_us=2500000\nout_time=00:00:02.500000\nprogress=continue\n'), 2.5);
  assert.equal(vt.progressSeconds('out_time=00:01:03.50\n'), 63.5);
  assert.equal(vt.progressSeconds('progress=continue\n'), null);
  const args = vt.segmentArgs('https://x/v.mp4', 1, 2, '/o.mp4');
  assert.equal(args[args.indexOf('-progress') + 1], 'pipe:1');
});

test('旧片段补句号：同文件夹改名、已带句号不动、只认视频、重名不覆盖', () => {
  const dir = tmp();
  const a = path.join(dir, '福特肉类加工_1m41s-1m50s.mp4');
  fs.writeFileSync(a, 'x');
  const r = vt.renameWithLineTag(a, '第125-127句');
  assert.ok(r.ok);
  assert.equal(r.path, path.join(dir, '第125-127句_福特肉类加工_1m41s-1m50s.mp4'));
  assert.ok(fs.existsSync(r.path) && !fs.existsSync(a));
  assert.equal(vt.renameWithLineTag(r.path, '第125-127句').unchanged, true);
  const b = path.join(dir, 'b.mp4');
  fs.writeFileSync(b, 'x');
  fs.writeFileSync(path.join(dir, '第3句_b.mp4'), 'old');
  assert.equal(path.basename(vt.renameWithLineTag(b, '第3句').path), '第3句_b (2).mp4');
  assert.equal(fs.readFileSync(path.join(dir, '第3句_b.mp4'), 'utf8'), 'old');
  const doc = path.join(dir, 'c.txt');
  fs.writeFileSync(doc, 'x');
  assert.equal(vt.renameWithLineTag(doc, '第1句').ok, false);
  assert.equal(vt.renameWithLineTag(path.join(dir, '不存在.mp4'), '第1句').ok, false);
  assert.equal(vt.renameWithLineTag(path.join(dir, 'x.mp4'), '../第1句').ok, false);
});

await atest('只保存那几秒：调用 ffmpeg 截取入点到出点，成功后改名；没装 ffmpeg 给出安装提示', async () => {
  const dir = tmp();
  let seen = null;
  const run = async (bin, args) => {
    seen = { bin, args };
    fs.writeFileSync(args.at(-1), Buffer.alloc(2048));
    return { ok: true };
  };
  const r = await vt.saveSegment(
    { url: 'https://archive.org/download/a/a.mp4#t=1,2', start: 101, end: 110, dir, name: '福特肉类加工' },
    { ffmpeg: '/bin/ffmpeg', run },
  );
  assert.ok(r.ok);
  assert.equal(path.basename(r.path), '福特肉类加工_1m41s-1m50s.mp4');
  assert.ok(fs.existsSync(r.path) && !fs.existsSync(r.path + '.part.mp4'));
  assert.equal(seen.args[seen.args.indexOf('-i') + 1], 'https://archive.org/download/a/a.mp4', '去掉 #t 片段标记');
  const none = await vt.saveSegment({ url: 'https://x/v.mp4', start: 1, end: 2, dir, name: 'v' }, { ffmpeg: null });
  assert.equal(none.needFfmpeg, true);
  assert.match(none.error, /brew install ffmpeg/);
  const failed = await vt.saveSegment(
    { url: 'https://x/v.mp4', start: 1, end: 2, dir, name: '失败' },
    { ffmpeg: '/bin/ffmpeg', run: async (b, a) => (fs.writeFileSync(a.at(-1), 'half'), { ok: false, error: '404' }) },
  );
  assert.equal(failed.ok, false);
  assert.ok(!fs.readdirSync(dir).some(f => f.startsWith('失败')), '失败时不留半截文件');
  const empty = await vt.saveSegment(
    { url: 'https://x/v.mp4', start: 6, end: 28, dir, name: '空视频' },
    { ffmpeg: '/bin/ffmpeg', run: async (b, a) => (fs.writeFileSync(a.at(-1), Buffer.alloc(262)), { ok: true }) },
  );
  assert.equal(empty.ok, false, 'ffmpeg 退出成功但产物只有空容器，不应算保存成功');
  assert.ok(!fs.readdirSync(dir).some(f => f.startsWith('空视频')), '空视频不留半截文件');
  const attempts = [];
  const recovered = await vt.saveSegment(
    { url: 'https://x/v.webm', start: 6, end: 28, dir, name: '顺序读取恢复' },
    {
      ffmpeg: '/bin/ffmpeg',
      run: async (bin, args) => {
        attempts.push(args);
        fs.writeFileSync(args.at(-1), Buffer.alloc(attempts.length === 1 ? 262 : 2048));
        return { ok: true };
      },
    },
  );
  assert.equal(recovered.ok, true, '随机跳转只得到空片段时，顺序读取应能恢复');
  assert.equal(attempts.length, 2);
  assert.ok(attempts[0].indexOf('-ss') < attempts[0].indexOf('-i'));
  assert.ok(attempts[1].indexOf('-i') < attempts[1].indexOf('-ss'));
  assert.equal(
    (
      await vt.saveSegment(
        { url: 'file:///etc/passwd', start: 1, end: 2, dir, name: 'x' },
        { ffmpeg: '/bin/ffmpeg', run },
      )
    ).ok,
    false,
  );
  assert.equal(
    (await vt.saveSegment({ url: 'https://x/v.mp4', start: 5, end: 2, dir, name: 'x' }, { ffmpeg: '/bin/ffmpeg', run }))
      .ok,
    false,
  );
});
await atest('下载完整原片：跟随跳转，写临时文件再改名，命名「…_完整原片」', async () => {
  const { EventEmitter, PassThrough } = await import('node:events').then(async m => ({
    ...m,
    ...(await import('node:stream')),
  }));
  const dir = tmp();
  const get = u => {
    const req = new EventEmitter();
    setImmediate(() => {
      const res = new PassThrough();
      if (u.includes('/download/')) {
        res.statusCode = 302;
        res.headers = { location: 'https://ia800.us.archive.org/real/a.mp4' };
      } else {
        res.statusCode = 200;
        res.headers = { 'content-length': '5' };
      }
      req.emit('response', res);
      res.end(res.statusCode === 200 ? 'hello' : '');
    });
    return req;
  };
  const r = await vt.downloadOriginal({ url: 'https://archive.org/download/a/a.mp4', dir, name: '福特' }, { get });
  assert.ok(r.ok, r.error);
  assert.equal(path.basename(r.path), '福特_完整原片.mp4');
  assert.equal(fs.readFileSync(r.path, 'utf8'), 'hello');
});
test('审核结果写回候选清单：只改 fenjingtai-candidates 文件，按 句号|编号 对上', () => {
  const dir = tmp();
  const f = path.join(dir, '候选.json');
  fs.writeFileSync(
    f,
    JSON.stringify({
      type: 'fenjingtai-candidates',
      version: 1,
      shots: [{ lines: '101-103', cands: [{ key: 'A1' }, { key: 'A2' }] }],
    }),
  );
  const r = vt.writeReview(
    f,
    [
      { key: 'A1', lines: '101-103', decision: 'ok', note: '好', savedPath: '/x.mp4' },
      { key: 'A2', lines: '9', decision: 'no' },
    ],
    { now: () => 'T' },
  );
  assert.deepEqual(r, { ok: true, updated: 1 });
  const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepEqual(doc.shots[0].cands[0].review, { decision: 'ok', note: '好', savedPath: '/x.mp4', at: 'T' });
  assert.equal(doc.shots[0].cands[1].review, undefined);
  assert.equal(doc.reviewedAt, 'T');
  const other = path.join(dir, '项目.json');
  fs.writeFileSync(other, '{"v":2}');
  assert.equal(vt.writeReview(other, []).ok, false);
  assert.equal(fs.readFileSync(other, 'utf8'), '{"v":2}');
  assert.equal(vt.writeReview(path.join(dir, 'a.txt'), []).ok, false);
});

/* ── 增量保存 ── */
test('增量保存：只改动过的项目被替换，null 删除项目，其余原样保留', () => {
  const dir = tmp();
  const store = createStore(() => dir);
  store.save({
    v: 2,
    currentId: 'p1',
    projects: { p1: { id: 'p1', title: 'A', rows: [] }, p2: { id: 'p2', title: 'B', rows: [] } },
  });
  store.savePatch({ currentId: 'p2', settings: { x: 1 }, projects: { p1: { id: 'p1', title: 'A2', rows: [] } } });
  let disk = JSON.parse(fs.readFileSync(store.paths.LIB(), 'utf8'));
  assert.equal(disk.projects.p1.title, 'A2');
  assert.equal(disk.projects.p2.title, 'B');
  assert.equal(disk.currentId, 'p2');
  assert.deepEqual(disk.settings, { x: 1 });
  store.savePatch({ currentId: 'p2', projects: { p1: null } });
  disk = JSON.parse(fs.readFileSync(store.paths.LIB(), 'utf8'));
  assert.ok(!disk.projects.p1 && disk.projects.p2);
  assert.throws(() => store.savePatch({ projects: { p2: null } }), /空的项目库/);
  store.savePatch({ full: lib('整库') });
  assert.equal(store.load().projects.p1.title, '整库');
});

console.log(`${count} 项主进程回归通过`);
