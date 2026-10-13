/* 主进程纯逻辑回归（不需要启动 Electron）：数据损坏自救 / 备份保留策略 / 备份路径校验 / 稿子文件读取（含 docx）/ 打包白名单
   用法：node scripts/main-test.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { shouldIgnore } from './package-filter.mjs';
import { buildManifest, checkNotes, extractNotes, notesHistory } from './release-manifest.mjs';

const require = createRequire(import.meta.url);
const { createStore, retentionKeep } = require('../electron/data-store.js');
const { readScriptFile, docxToText } = require('../electron/script-reader.js');
const pack = require('../electron/project-pack.js');

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
  // 改稿后句号过时：换成现在的句号，任何类型都行；没有句号的、句号没变的不动；重名不覆盖
  const old = path.join(dir, '第101-103句_屠宰场.jpg');
  fs.writeFileSync(old, 'img');
  const moved = vt.retagLineFile(old, '第118-120句');
  assert.equal(moved.path, path.join(dir, '第118-120句_屠宰场.jpg'));
  assert.ok(fs.existsSync(moved.path) && !fs.existsSync(old));
  assert.equal(vt.retagLineFile(moved.path, '第118-120句').unchanged, true);
  assert.equal(vt.retagLineFile(b, '第9句').ok, false);
  fs.writeFileSync(path.join(dir, '第7句_b.mp4'), 'taken');
  assert.equal(path.basename(vt.retagLineFile(path.join(dir, '第3句_b.mp4'), '第7句').path), '第7句_b (2).mp4');
  assert.equal(vt.retagLineFile(path.join(dir, '第1句_不存在.mp4'), '第2句').ok, false);
  assert.equal(vt.retagLineFile(moved.path, '第1句/..').ok, false);
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
test('审核结果写回 v3 候选清单：方案里的视频也能对上，通过的写明是不是正在用的方案', () => {
  const dir = tmp();
  const f = path.join(dir, '候选.json');
  fs.writeFileSync(
    f,
    JSON.stringify({
      type: 'fenjingtai-candidates',
      version: 3,
      shots: [{ lines: '5', plans: [{ cands: [{ key: 'A' }, { key: 'B' }] }, { cands: [{ key: 'C' }] }] }],
    }),
  );
  const r = vt.writeReview(
    f,
    [
      { key: 'A', lines: '5', decision: 'ok', note: '', inUse: true },
      { key: 'B', lines: '5', decision: 're', note: '太暗', inUse: false },
      { key: 'C', lines: '5', decision: 'ok', note: '' },
    ],
    { now: () => 'T' },
  );
  assert.deepEqual(r, { ok: true, updated: 3 });
  const [p1, p2] = JSON.parse(fs.readFileSync(f, 'utf8')).shots[0].plans;
  assert.deepEqual(p1.cands[0].review, { decision: 'ok', note: '', inUse: true, at: 'T' });
  assert.deepEqual(p1.cands[1].review, { decision: 're', note: '太暗', at: 'T' }, '没通过的不写 inUse');
  assert.deepEqual(p2.cands[0].review, { decision: 'ok', note: '', inUse: false, at: 'T' });
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
  assert.deepEqual(doc.shots[0].cands[0].review, {
    decision: 'ok',
    note: '好',
    savedPath: '/x.mp4',
    inUse: false,
    at: 'T',
  });
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

/* ── 1.10 ── */
test('1.10 数据文件里有结构坏掉的项目：其余照常打开，坏的原样放进 quarantine 不删', () => {
  const dir = tmp();
  const store = createStore(() => dir);
  fs.writeFileSync(
    store.paths.LIB(),
    JSON.stringify({
      v: 2,
      currentId: 'p1',
      projects: { p1: { id: 'p1', title: '好的', rows: [] }, p2: { id: 'p2', title: '坏的', rows: null } },
    }),
  );
  const data = store.load();
  assert.ok(data.projects.p1 && !data.projects.p2);
  assert.equal(data.quarantine.p2.title, '坏的');
  assert.equal(store.info().status, 'partial');
  assert.deepEqual(store.info().broken, ['坏的']);
  store.savePatch({ currentId: 'p1', projects: { p1: { id: 'p1', title: '好的2', rows: [] } } });
  const disk = JSON.parse(fs.readFileSync(store.paths.LIB(), 'utf8'));
  assert.equal(disk.quarantine.p2.title, '坏的', '保存时坏项目仍留在文件里');
});
test('1.10 备份失败不算备份过：下次保存立刻再试；整库恢复前强制备份', () => {
  const dir = tmp();
  const store = createStore(() => dir);
  store.save(lib('一'));
  fs.writeFileSync(path.join(dir, '自动备份'), '我是文件不是文件夹'); // 让建备份文件夹失败
  store.save(lib('二'));
  assert.ok(store.info().backupError, '备份失败要能被界面看到');
  fs.rmSync(path.join(dir, '自动备份'));
  store.save(lib('三'));
  assert.equal(store.info().backupError, undefined);
  assert.equal(store.listBackups().length, 1, '失败后没有空等 30 分钟，下一次保存就补上了备份');
  store.savePatch({ full: lib('整库恢复') });
  assert.equal(store.listBackups().length >= 1, true);
  const newest = JSON.parse(fs.readFileSync(path.join(dir, '自动备份', store.listBackups()[0].f), 'utf8'));
  assert.equal(newest.projects.p1.title, '三', '整库替换前先备份了替换前的库');
});
test('1.10 片段保存：同名同时保存各占一个文件名；流媒体播放列表不交给 ffmpeg；参数带协议白名单', () => {
  const dir = tmp();
  const a = vt.reservePath(dir, '同名', '.mp4');
  const b = vt.reservePath(dir, '同名', '.mp4');
  assert.notEqual(a, b);
  assert.equal(path.basename(b), '同名 (2).mp4');
  assert.ok(vt.isPlaylist('https://x/live/index.m3u8?a=1'));
  assert.ok(!vt.isPlaylist('https://x/v.mp4'));
  const args = vt.segmentArgs('https://x/v.mp4', 1, 2, '/o.mp4');
  assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'http,https,tls,tcp,crypto,httpproxy');
});
await atest('截取走系统代理：PROXY 项交给 ffmpeg（环境变量 http_proxy），直连 / 只有 SOCKS 不设', async () => {
  assert.equal(vt.proxyFromRule('PROXY 127.0.0.1:7890'), 'http://127.0.0.1:7890');
  assert.equal(vt.proxyFromRule('SOCKS5 127.0.0.1:7891; PROXY proxy.lan:8080; DIRECT'), 'http://proxy.lan:8080');
  assert.equal(vt.proxyFromRule('PROXY [::1]:7890'), 'http://[::1]:7890');
  for (const none of ['DIRECT', 'SOCKS5 127.0.0.1:7891', '', null, 'PROXY bad host:1', 'PROXY h:99999999'])
    assert.equal(vt.proxyFromRule(none), null, String(none));
  const dir = tmp();
  const envs = [];
  const run = async (bin, args, opts) => {
    envs.push(opts.env);
    fs.writeFileSync(args.at(-1), Buffer.alloc(2048));
    return { ok: true };
  };
  const req = { url: 'https://x/v.mp4', start: 1, end: 2, dir, name: '代理' };
  assert.ok((await vt.saveSegment(req, { ffmpeg: '/bin/ffmpeg', run, proxy: 'http://127.0.0.1:7890' })).ok);
  assert.equal(envs[0].http_proxy, 'http://127.0.0.1:7890');
  assert.equal(envs[0].PATH, process.env.PATH, '其余环境变量照旧');
  assert.ok((await vt.saveSegment({ ...req, name: '直连' }, { ffmpeg: '/bin/ffmpeg', run })).ok);
  assert.equal(envs[1], undefined, '直连时不改 ffmpeg 的环境');
});
await atest('1.10 两个同名片段并发保存都成功、互不覆盖；m3u8 直接拒绝', async () => {
  const dir = tmp();
  const run = async (bin, args) => {
    await new Promise(r => setTimeout(r, 20));
    fs.writeFileSync(args.at(-1), Buffer.alloc(4096, args.includes('9') ? 1 : 2));
    return { ok: true };
  };
  const req = { url: 'https://x/v.mp4', start: 1, end: 10, dir, name: '并发' };
  const [r1, r2] = await Promise.all([
    vt.saveSegment(req, { ffmpeg: '/bin/ffmpeg', run }),
    vt.saveSegment(req, { ffmpeg: '/bin/ffmpeg', run }),
  ]);
  assert.ok(r1.ok && r2.ok, `${r1.error || ''} ${r2.error || ''}`);
  assert.notEqual(r1.path, r2.path);
  assert.equal(fs.statSync(r1.path).size, 4096);
  assert.equal(fs.statSync(r2.path).size, 4096);
  assert.ok(!fs.readdirSync(dir).some(f => f.includes('.part')), '不留临时文件');
  const hls = await vt.saveSegment({ ...req, url: 'https://x/a.m3u8' }, { ffmpeg: '/bin/ffmpeg', run });
  assert.equal(hls.ok, false);
  assert.match(hls.error, /播放列表/);
});
await atest('1.10 下载原片：长时间没数据算超时、可以取消，失败不留文件', async () => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const dir = tmp();
  // 一直不回应的服务器
  const silent = () => {
    const req = new EventEmitter();
    req.setTimeout = (ms, cb) => setTimeout(cb, ms);
    req.destroy = () => {};
    return req;
  };
  const t = await vt.downloadOriginal({ url: 'https://x/a.mp4', dir, name: '超时' }, { get: silent, idleMs: 30 });
  assert.equal(t.ok, false);
  assert.match(t.error, /超时/);
  // 下到一半取消
  const ctl = new AbortController();
  const slow = () => {
    const req = new EventEmitter();
    req.destroy = () => {};
    setImmediate(() => {
      const res = new PassThrough();
      res.statusCode = 200;
      res.headers = { 'content-length': '100' };
      req.emit('response', res);
      res.write('abc');
      setTimeout(() => ctl.abort(), 10);
    });
    return req;
  };
  const c = await vt.downloadOriginal({ url: 'https://x/b.mp4', dir, name: '取消' }, { get: slow, signal: ctl.signal });
  assert.equal(c.ok, false);
  assert.equal(c.canceled, true);
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(fs.readdirSync(dir), [], '超时、取消都不留文件（占位文件和临时文件都清掉）');
});
test('1.10 候选清单写不进去时返回失败原因（界面据此提示、保留审核结果）', () => {
  const dir = tmp();
  const f = path.join(dir, '候选.json');
  fs.writeFileSync(
    f,
    JSON.stringify({ type: 'fenjingtai-candidates', shots: [{ lines: '1', cands: [{ key: 'A' }] }] }),
  );
  const r = vt.writeReview(f, [{ key: 'A', lines: '1', decision: 'no' }], {
    write: () => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /没有写入权限/);
});

/* ── 1.10 应用内更新 ── */
const up = require('../electron/updater.js');
test('更新：版本号逐段按数字比（1.10 比 1.9 新），草稿 / 预发布不算', () => {
  assert.equal(up.compareVersions('1.10.0', '1.9.3'), 1);
  assert.equal(up.compareVersions('v1.9.3', '1.9.3'), 0);
  assert.equal(up.compareVersions('1.9.3', '1.10.0'), -1);
  const rel = {
    tag_name: 'v1.10.1',
    body: '修了些问题',
    html_url: 'https://github.com/x/y/releases/tag/v1.10.1',
    assets: [
      {
        name: 'FenJingTai-mac-arm64.zip',
        size: 100,
        digest: 'sha256:' + 'a'.repeat(64),
        browser_download_url: 'https://github.com/x/y/releases/download/v1.10.1/FenJingTai-mac-arm64.zip',
      },
      { name: 'FenJingTai-mac-x64.zip', size: 120, browser_download_url: 'https://github.com/x/y/x64.zip' },
    ],
  };
  const arm = up.pickUpdate(rel, { current: '1.10.0', arch: 'arm64' });
  assert.equal(arm.available, true);
  assert.equal(arm.version, '1.10.1');
  assert.equal(arm.sha256, 'a'.repeat(64));
  assert.match(arm.url, /arm64\.zip$/);
  assert.equal(up.pickUpdate(rel, { current: '1.10.0', arch: 'x64' }).sha256, '', '没有 digest 时不校验，但照样能更新');
  assert.equal(up.pickUpdate(rel, { current: '1.10.1', arch: 'arm64' }).available, false);
  assert.equal(up.pickUpdate({ ...rel, prerelease: true }, { current: '1.0.0', arch: 'arm64' }).available, false);
});
test('更新：latest.json 清单 → 按芯片挑 zip（Intel 拿 x64），格式不对返回 null 交给 API', () => {
  const m = buildManifest({
    version: 'v1.10.3',
    notes: '不再受 API 次数限制',
    files: [
      { name: 'FenJingTai-mac-arm64.zip', size: 100, sha256: 'A'.repeat(64) },
      { name: 'FenJingTai-mac-x64.zip', size: 120, sha256: 'b'.repeat(64) },
    ],
  });
  assert.equal(m.version, '1.10.3');
  assert.equal(m.page, `https://github.com/${up.REPO}/releases/tag/v1.10.3`);
  const intel = up.pickManifest(m, { current: '1.10.2', arch: 'x64' });
  assert.equal(intel.available, true);
  assert.equal(intel.version, '1.10.3');
  assert.equal(intel.url, `https://github.com/${up.REPO}/releases/download/v1.10.3/FenJingTai-mac-x64.zip`);
  assert.equal(intel.sha256, 'b'.repeat(64));
  assert.equal(intel.size, 120);
  assert.equal(intel.notes, '不再受 API 次数限制');
  assert.equal(up.pickManifest(m, { current: '1.10.2', arch: 'arm64' }).sha256, 'a'.repeat(64), '校验值统一小写');
  assert.deepEqual(up.pickManifest(m, { current: '1.10.3', arch: 'x64' }), { available: false, latest: '1.10.3' });
  const noX64 = up.pickManifest({ ...m, assets: m.assets.slice(0, 1) }, { current: '1.0.0', arch: 'x64' });
  assert.equal(noX64.available, true);
  assert.equal(noX64.url, '', '没有这台电脑的包：照样提示，但不能一键更新');
  const http = { ...m, assets: [{ ...m.assets[1], url: 'http://x/y.zip' }] };
  assert.equal(up.pickManifest(http, { current: '1.0.0', arch: 'x64' }).url, '', '只认 https 下载地址');
  for (const bad of [null, 'x', {}, { version: '' }, { version: 'abc' }])
    assert.equal(up.pickManifest(bad, { current: '1.0.0', arch: 'x64' }), null);
});
test('更新：隔了好几版也一步更新到最新，说明里列出中间每一版（新的在前）', () => {
  const md =
    '# 分镜台 1.10.5\n\n五\n\n---\n\n# 分镜台 1.10.4\n\n四\n\n---\n\n# 分镜台 1.10.3\n\n三\n\n---\n\n# 分镜台 1.10.2\n\n二\n';
  const history = notesHistory(md);
  assert.deepEqual(
    history.map(h => h.version),
    ['1.10.5', '1.10.4', '1.10.3', '1.10.2'],
  );
  assert.equal(notesHistory(md, 2).length, 2, '最多带几版');
  const m = buildManifest({
    version: '1.10.5',
    notes: '五',
    history,
    files: [{ name: 'FenJingTai-mac-arm64.zip', size: 1, sha256: 'a'.repeat(64) }],
  });
  const from2 = up.pickManifest(m, { current: '1.10.2', arch: 'arm64' });
  assert.equal(from2.version, '1.10.5', '直接给最新版，不是下一版');
  assert.match(from2.url, /v1\.10\.5\/FenJingTai-mac-arm64\.zip$/);
  assert.deepEqual(from2.versions, ['1.10.5', '1.10.4', '1.10.3']);
  assert.ok(
    from2.notes.indexOf('【分镜台 1.10.5】') < from2.notes.indexOf('【分镜台 1.10.3】') && !from2.notes.includes('二'),
    '中间每一版的说明都在，已经装了的那版不列',
  );
  const from4 = up.pickManifest(m, { current: '1.10.4', arch: 'arm64' });
  assert.equal(from4.notes, '五', '只差一版：照旧只显示这一版的说明');
  assert.deepEqual(from4.versions, ['1.10.5']);
  const old = up.pickManifest({ ...m, history: undefined }, { current: '1.10.2', arch: 'arm64' });
  assert.equal(old.notes, '五', '旧清单没有 history 也能用');
});
test('更新：从 UPDATE-NOTES.md 取出某一版的说明，节与节之间以 --- 或下一个一级标题为界', () => {
  const md = '# 分镜台 1.10.3\n\n第一段\n\n**小标题**\n\n- 一条\n\n---\n\n# 分镜台 1.10.2\n\n旧的\n';
  assert.equal(extractNotes(md, '1.10.3'), '第一段\n\n**小标题**\n\n- 一条');
  assert.equal(extractNotes(md, '1.10.2'), '旧的');
  assert.equal(extractNotes(md, '9.9.9'), '');
  const real = fs.readFileSync(new URL('../UPDATE-NOTES.md', import.meta.url), 'utf8');
  const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(extractNotes(real, version), `UPDATE-NOTES.md 里要有「# 分镜台 ${version}」这一节（软件里显示的更新说明）`);
});
test('更新说明格式：只用【新增】【支持】【优化】【修复】，按顺序，每条「• 」开头一句话', () => {
  const ok = '# 分镜台 2.0.0\n\n【新增】\n• 一条\n• 两条\n\n【修复】\n• 修了一处\n\n---\n';
  assert.deepEqual(checkNotes(ok, '2.0.0'), []);
  const bad = (body, re, why) => {
    const errs = checkNotes(`# 分镜台 2.0.0\n\n${body}\n`, '2.0.0');
    assert.ok(
      errs.some(e => re.test(e)),
      `${why}：${errs.join(' / ') || '没报错'}`,
    );
  };
  bad('【新功能】\n• 一条', /不是允许的分组/, '分组名只能是四个之一');
  bad('【修复】\n• 一条\n【新增】\n• 一条', /分组顺序/, '顺序固定');
  bad('【新增】\n• 一条\n【新增】\n• 两条', /重复出现/, '同一分组只写一次');
  bad('【新增】\n这一版做了很多事情，写成了一整段话', /以「• 」开头/, '不能写整段');
  bad('**新增**\n- 一条', /以「• 」开头/, '不用 Markdown 写法');
  bad('• 一条', /先有分组标题/, '条目要在分组下面');
  bad('【新增】\n\n【修复】\n• 一条', /没有条目/, '空分组不写');
  bad('【新增】\n• ' + '字'.repeat(41), /每条不超过/, '每条有字数上限');
  assert.deepEqual(checkNotes('# 分镜台 2.0.0\n【新增】\n' + '• 一条\n'.repeat(12), '2.0.0'), [], '条数不设上限');
  assert.deepEqual(
    checkNotes('# 分镜台 2.0.0\n【新增】\n• 一条\n![配对码加入](https://example.com/pairing.png)', '2.0.0'),
    [],
    '可在分类内附功能图片，不计为更新条目',
  );
  bad('【新增】\n• 一条\n![图片](javascript:alert(1))', /以「• 」开头/, '图片不能使用脚本地址');
  assert.match(checkNotes(ok, '9.9.9')[0], /没有「# 分镜台 9\.9\.9」/);
  // 当前版本的真实说明必须合格（以前发过的旧版本不查）
  const real = fs.readFileSync(new URL('../UPDATE-NOTES.md', import.meta.url), 'utf8');
  const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const errs = checkNotes(real, version);
  assert.deepEqual(errs, [], `UPDATE-NOTES.md 里「# 分镜台 ${version}」这一节不合格式：\n- ${errs.join('\n- ')}`);
});
test('更新：只能原地更新装在可写位置的正式版；从安装盘、被系统隔离运行、开发版都给出原因', () => {
  const exe = '/Applications/分镜台.app/Contents/MacOS/分镜台';
  const ok = up.installTarget(exe, { platform: 'darwin', canWrite: () => true });
  assert.equal(ok.ok, true);
  assert.equal(ok.app, '/Applications/分镜台.app');
  assert.match(up.installTarget(exe, { platform: 'darwin', isPackaged: false }).reason, /开发版本/);
  assert.match(
    up.installTarget('/private/var/folders/x/AppTranslocation/Y/d/分镜台.app/Contents/MacOS/分镜台', {
      platform: 'darwin',
      canWrite: () => true,
    }).reason,
    /应用程序/,
  );
  assert.match(
    up.installTarget('/Volumes/分镜台/分镜台.app/Contents/MacOS/分镜台', { platform: 'darwin', canWrite: () => true })
      .reason,
    /安装盘/,
  );
  assert.match(up.installTarget(exe, { platform: 'darwin', canWrite: () => false }).reason, /没有权限/);
});
await atest('更新：先读 latest.json，不碰 API；清单取不到 / 内容不对才退回 API', async () => {
  const manifest = buildManifest({
    version: '1.10.3',
    files: [{ name: 'FenJingTai-mac-x64.zip', size: 1, sha256: 'c'.repeat(64) }],
  });
  const release = {
    tag_name: 'v1.10.3',
    assets: [{ name: 'FenJingTai-mac-x64.zip', browser_download_url: 'https://github.com/x/y/x64.zip' }],
  };
  const fake = routes => {
    const calls = [];
    const impl = async url => {
      calls.push(url);
      const r = routes[url];
      if (r instanceof Error) throw r;
      if (typeof r === 'number') return new Response('', { status: r });
      return new Response(JSON.stringify(r), { status: 200 });
    };
    return { calls, impl };
  };
  const args = { current: '1.10.2', arch: 'x64' };

  let f = fake({ [up.MANIFEST_URL]: manifest });
  let r = await up.checkForUpdate({ ...args, fetchImpl: f.impl });
  assert.equal(r.ok && r.available && r.source, 'manifest');
  assert.equal(r.sha256, 'c'.repeat(64));
  assert.deepEqual(f.calls, [up.MANIFEST_URL], '有清单就不查 API');

  f = fake({ [up.MANIFEST_URL]: { ...manifest, version: '1.10.2' } });
  r = await up.checkForUpdate({ ...args, fetchImpl: f.impl });
  assert.equal(r.ok && !r.available && r.source, 'manifest', '已是最新也不查 API');
  assert.equal(f.calls.length, 1);

  for (const miss of [404, new Error('网络断了'), { hello: 1 }]) {
    f = fake({ [up.MANIFEST_URL]: miss, [up.LATEST_API]: release });
    r = await up.checkForUpdate({ ...args, fetchImpl: f.impl });
    assert.equal(r.ok && r.available && r.source, 'api', `清单 ${miss} 时退回 API`);
    assert.deepEqual(f.calls, [up.MANIFEST_URL, up.LATEST_API]);
  }

  f = fake({ [up.MANIFEST_URL]: 404, [up.LATEST_API]: 403 });
  r = await up.checkForUpdate({ ...args, fetchImpl: f.impl });
  assert.equal(r.ok, false);
  assert.match(r.error, /限制了查询次数/);

  const hang = (_url, { signal }) =>
    new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))));
  r = await up.checkForUpdate({ ...args, fetchImpl: hang, timeoutMs: 20 });
  assert.equal(r.ok, false);
  assert.match(r.error, /超时/);
});
await atest('更新：下载边下边校验 SHA-256，对不上就丢弃；取消不留文件', async () => {
  const dir = tmp();
  const body = Buffer.from('新版本的压缩包内容');
  const sha = (await import('node:crypto')).createHash('sha256').update(body).digest('hex');
  const fetchOk = async () => new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
  const dest = path.join(dir, 'u.zip');
  const ticks = [];
  const r = await up.downloadUpdate({ url: 'https://x/u.zip', sha256: sha }, dest, {
    fetchImpl: fetchOk,
    onProgress: (g, t) => ticks.push([g, t]),
  });
  assert.ok(r.ok && r.verified, r.error);
  assert.deepEqual(fs.readFileSync(dest), body);
  assert.deepEqual(ticks.at(-1), [body.length, body.length]);
  const bad = await up.downloadUpdate({ url: 'https://x/u.zip', sha256: 'b'.repeat(64) }, path.join(dir, 'v.zip'), {
    fetchImpl: fetchOk,
  });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /校验没通过/);
  const ctl = new AbortController();
  const slow = async (_u, { signal }) =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array([1, 2, 3]));
          signal.addEventListener('abort', () => c.error(new Error('aborted')));
          setTimeout(() => ctl.abort(), 10);
        },
      }),
      { status: 200 },
    );
  const c = await up.downloadUpdate({ url: 'https://x/u.zip' }, path.join(dir, 'w.zip'), {
    fetchImpl: slow,
    signal: ctl.signal,
  });
  assert.equal(c.canceled, true);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['u.zip'], '校验失败和取消都不留文件');
  assert.equal(
    (await up.downloadUpdate({ url: 'http://x/u.zip' }, dest, { fetchImpl: fetchOk })).ok,
    false,
    '只走 https',
  );
});
test('更新：解压后核对是不是分镜台、版本对不对；不对就清掉临时文件夹', () => {
  const parent = tmp();
  const fakeRun = (bundleId, version) => (cmd, args) => {
    if (cmd.endsWith('ditto')) fs.mkdirSync(path.join(args.at(-1), '分镜台.app', 'Contents'), { recursive: true });
    if (cmd.endsWith('plutil')) return args[1] === 'CFBundleIdentifier' ? bundleId : version;
    return '';
  };
  const good = up.prepareUpdate('/tmp/u.zip', { parent, version: '1.10.1', run: fakeRun(up.BUNDLE_ID, '1.10.1') });
  assert.ok(good.ok, good.error);
  assert.ok(good.app.endsWith('分镜台.app') && path.basename(good.stage).startsWith('.分镜台-更新-'));
  const other = up.prepareUpdate('/tmp/u.zip', { parent, version: '1.10.1', run: fakeRun('com.evil.app', '1.10.1') });
  assert.equal(other.ok, false);
  assert.match(other.error, /不是分镜台/);
  const wrongV = up.prepareUpdate('/tmp/u.zip', { parent, version: '1.10.1', run: fakeRun(up.BUNDLE_ID, '1.9.0') });
  assert.match(wrongV.error, /对不上/);
  assert.deepEqual(
    fs.readdirSync(parent).filter(f => f !== path.basename(good.stage)),
    [],
    '失败的都清掉了',
  );
});
test('更新：换新版的脚本先等应用退出，换不上就把旧版放回去，最后重新打开', () => {
  assert.match(up.SWAP_SCRIPT, /kill -0 "\$PID"/);
  assert.match(up.SWAP_SCRIPT, /else mv "\$OLD" "\$TARGET"/);
  assert.match(up.SWAP_SCRIPT, /open "\$TARGET"/);
  const calls = [];
  const dir = tmp();
  up.scheduleSwap({
    pid: 123,
    newApp: '/A/new.app',
    target: '/A/分镜台.app',
    stage: '/A/.s',
    tmpDir: dir,
    spawnImpl: (cmd, args, opts) => (calls.push({ cmd, args, opts }), { unref() {} }),
  });
  assert.equal(calls[0].cmd, '/bin/bash');
  assert.deepEqual(calls[0].args.slice(1), ['123', '/A/new.app', '/A/分镜台.app', '/A/.s']);
  assert.equal(calls[0].opts.detached, true);
});

await atest('项目打包 ZIP：不压缩写入、读回一致；ZIP64 结构也能读；带外层文件夹', async () => {
  const dir = tmp();
  const big = path.join(dir, '视频 一.mp4');
  fs.writeFileSync(big, Buffer.alloc(3 * 1024 * 1024 + 7, 7));
  fs.writeFileSync(path.join(dir, 'b.jpg'), 'img');
  for (const forceZip64 of [false, true]) {
    const zip = path.join(dir, forceZip64 ? 'p64.zip' : 'p.zip');
    let last = null;
    const r = await pack.writeZip(
      zip,
      [
        { name: '礼来/分镜台项目.json', data: '{"v":4,"title":"礼来"}' },
        { name: '礼来/素材/视频 一.mp4', file: big },
        { name: '礼来/素材/b.jpg', file: path.join(dir, 'b.jpg') },
      ],
      { forceZip64, onProgress: (d, t) => (last = [d, t]) },
    );
    assert.ok(r.ok && fs.existsSync(zip) && !fs.existsSync(zip + '.part'));
    assert.equal(last[0], last[1]);
    const info = await pack.inspectPack(zip);
    assert.equal(info.root, '礼来/');
    assert.equal(JSON.parse(info.project).title, '礼来');
    const dest = pack.uniqueDir(dir, '解压');
    fs.mkdirSync(dest);
    const out = await pack.extractPack(zip, dest);
    assert.equal(out.files, 3);
    assert.ok(fs.readFileSync(path.join(dest, '素材', '视频 一.mp4')).equals(fs.readFileSync(big)));
    assert.equal(fs.readFileSync(path.join(dest, '素材', 'b.jpg'), 'utf8'), 'img');
    assert.deepEqual(fs.readdirSync(dest).sort(), ['分镜台项目.json', '素材']);
  }
  assert.equal(path.basename(pack.uniqueDir(dir, '解压')), '解压 (3)');
});

await atest('项目打包 ZIP：0 字节的文件也能打包、解压', async () => {
  const dir = tmp();
  const empty = path.join(dir, '空.txt');
  fs.writeFileSync(empty, '');
  const zip = path.join(dir, 'e.zip');
  await pack.writeZip(zip, [
    { name: 'p/分镜台项目.json', data: '{}' },
    { name: 'p/素材/空.txt', file: empty },
    { name: 'p/素材/有.txt', data: 'x' },
  ]);
  const dest = path.join(dir, 'out');
  fs.mkdirSync(dest);
  const r = await pack.extractPack(zip, dest);
  assert.equal(r.files, 3);
  assert.equal(fs.statSync(path.join(dest, '素材', '空.txt')).size, 0);
  assert.equal(fs.readFileSync(path.join(dest, '素材', '有.txt'), 'utf8'), 'x');
});

await atest('项目打包 ZIP：deflate 压缩的包也能读；../、绝对路径、符号链接、没有项目文件的一律拒收', async () => {
  const dir = tmp();
  // 手工拼一个 deflate 条目 + 一个不安全路径的条目
  const mk = (entries, { symlink = false } = {}) => {
    const parts = [],
      central = [];
    let off = 0;
    for (const [name, text, method] of entries) {
      const raw = Buffer.from(text);
      const data = method === 8 ? zlib.deflateRawSync(raw) : raw;
      const nb = Buffer.from(name);
      const h = Buffer.alloc(30);
      h.writeUInt32LE(0x04034b50, 0);
      h.writeUInt16LE(20, 4);
      h.writeUInt16LE(0x0800, 6);
      h.writeUInt16LE(method, 8);
      h.writeUInt32LE(pack.crc32(raw), 14);
      h.writeUInt32LE(data.length, 18);
      h.writeUInt32LE(raw.length, 22);
      h.writeUInt16LE(nb.length, 26);
      parts.push(h, nb, data);
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(20, 6);
      c.writeUInt16LE(0x0800, 8);
      c.writeUInt16LE(method, 10);
      c.writeUInt32LE(pack.crc32(raw), 16);
      c.writeUInt32LE(data.length, 20);
      c.writeUInt32LE(raw.length, 24);
      c.writeUInt16LE(nb.length, 28);
      c.writeUInt32LE(((symlink && name.endsWith('link') ? 0o120777 : 0o100644) << 16) >>> 0, 38);
      c.writeUInt32LE(off, 42);
      central.push(c, nb);
      off += 30 + nb.length + data.length;
    }
    const cd = Buffer.concat(central);
    const e = Buffer.alloc(22);
    e.writeUInt32LE(0x06054b50, 0);
    e.writeUInt16LE(entries.length, 8);
    e.writeUInt16LE(entries.length, 10);
    e.writeUInt32LE(cd.length, 12);
    e.writeUInt32LE(off, 16);
    return Buffer.concat([...parts, cd, e]);
  };
  const good = path.join(dir, 'good.zip');
  fs.writeFileSync(
    good,
    mk([
      ['分镜台项目.json', '{"title":"x"}', 8],
      ['素材/a.txt', 'hello hello hello', 8],
      ['__MACOSX/._a', 'junk', 0],
    ]),
  );
  const dest = path.join(dir, 'out');
  fs.mkdirSync(dest);
  await pack.extractPack(good, dest);
  assert.equal(fs.readFileSync(path.join(dest, '素材', 'a.txt'), 'utf8'), 'hello hello hello');
  assert.equal(fs.existsSync(path.join(dest, '__MACOSX')), false);
  const reject = async (buf, re) => {
    const f = path.join(dir, 'bad.zip');
    fs.writeFileSync(f, buf);
    await assert.rejects(pack.inspectPack(f), re);
  };
  await reject(
    mk([
      ['分镜台项目.json', '{}', 0],
      ['../evil.txt', 'x', 0],
    ]),
    /不安全/,
  );
  await reject(
    mk([
      ['分镜台项目.json', '{}', 0],
      ['a/../../evil.txt', 'x', 0],
    ]),
    /不安全/,
  );
  await reject(
    mk(
      [
        ['分镜台项目.json', '{}', 0],
        ['素材/link', '/etc/passwd', 0],
      ],
      { symlink: true },
    ),
    /符号链接/,
  );
  await reject(mk([['素材/a.txt', 'x', 0]]), /没有分镜台项目/);
  await reject(Buffer.from('not a zip at all'), /不是有效的 ZIP/);
  assert.equal(pack.safeEntryName('/abs'), null);
  assert.equal(pack.safeEntryName('a\\b'), null);
});

await atest('项目打包 ZIP：取消后不留 .part；解压中途取消报「已取消」', async () => {
  const dir = tmp();
  const f = path.join(dir, 'a.bin');
  fs.writeFileSync(f, Buffer.alloc(9 * 1024 * 1024, 1));
  const ac = new AbortController();
  const zip = path.join(dir, 'c.zip');
  await assert.rejects(
    pack.writeZip(
      zip,
      [
        { name: 'p/分镜台项目.json', data: '{}' },
        { name: 'p/a.bin', file: f },
      ],
      {
        signal: ac.signal,
        onProgress: () => ac.abort(),
      },
    ),
    e => e.canceled === true,
  );
  assert.equal(fs.existsSync(zip) || fs.existsSync(zip + '.part'), false);
  await pack.writeZip(zip, [
    { name: 'p/分镜台项目.json', data: '{}' },
    { name: 'p/a.bin', file: f },
  ]);
  const ac2 = new AbortController();
  const dest = path.join(dir, 'x');
  fs.mkdirSync(dest);
  await assert.rejects(
    pack.extractPack(zip, dest, { signal: ac2.signal, onProgress: () => ac2.abort() }),
    e => e.canceled === true,
  );
  await assert.rejects(pack.writeZip(zip, [{ name: '../x', data: '' }]), /不合法/);
  await assert.rejects(
    pack.writeZip(zip, [
      { name: 'a', data: '' },
      { name: 'a', data: '' },
    ]),
    /重名/,
  );
});

await atest(
  '协作认文件：不看文件名，大小 + 首尾指纹一致才算同一个；子文件夹也找；同名不同内容不认；可取消',
  async () => {
    const { fingerprint, findByContent } = require('../electron/file-match.js');
    const dir = tmp();
    try {
      const big = Buffer.alloc(3 * 1024 * 1024, 7);
      big.write('开头', 0);
      big.write('结尾', big.length - 10);
      const src = path.join(dir, '对方', 'A001.mov');
      fs.mkdirSync(path.dirname(src));
      fs.writeFileSync(src, big);
      fs.writeFileSync(path.join(dir, '对方', 'note.txt'), '小文件');
      const want = await fingerprint(src);
      const small = await fingerprint(path.join(dir, '对方', 'note.txt'));
      assert.equal(want.size, big.length);
      // 本机：改了名、放在深层子文件夹；另有一个同名、同大小但结尾不同的文件
      const mine = path.join(dir, '我的', '项目', '2024', '素材', '第一天');
      fs.mkdirSync(mine, { recursive: true });
      fs.writeFileSync(path.join(mine, '改过名.mov'), big);
      const fake = Buffer.from(big);
      fake.write('不同', fake.length - 10);
      fs.mkdirSync(path.join(dir, '我的', '别处'));
      fs.writeFileSync(path.join(dir, '我的', '别处', 'A001.mov'), fake);
      fs.writeFileSync(path.join(dir, '我的', '.隐藏.mov'), big);
      const r = await findByContent({ dirs: [path.join(dir, '我的')], wants: [want, small, null] });
      assert.deepEqual(r.found, { 0: path.join(mine, '改过名.mov') });
      assert.equal(r.canceled, false);
      // 大小差一个字节就不认（原文件删掉，只剩短一字节的）
      const shorter = path.join(dir, '我的', 'shorter.mov');
      fs.writeFileSync(shorter, big.subarray(0, big.length - 1));
      fs.rmSync(path.join(mine, '改过名.mov'));
      assert.deepEqual((await findByContent({ dirs: [path.join(dir, '我的')], wants: [want] })).found, {});
      // 取消：一开始就取消，什么都不找
      const c = await findByContent({ dirs: [path.join(dir, '对方')], wants: [want], isCanceled: () => true });
      assert.deepEqual(c.found, {});
      assert.equal(c.canceled, true);
      // 相对路径 / 不存在的文件夹直接跳过
      assert.deepEqual((await findByContent({ dirs: ['对方', path.join(dir, '没有')], wants: [want] })).found, {});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

await atest('局域网协作网络层：主机广播 → 访客发现 → 连上收发消息 → 停止共享后从列表消失', async () => {
  const { createCollabNet } = require('../electron/collab-net.js');
  const discoveryPort = 47000 + Math.floor(Math.random() * 900);
  const servicePort = 0; // 测试用随机端口
  const hostEvents = [],
    guestEvents = [];
  const waitFor = (list, pred, ms = 4000) =>
    new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        const hit = list.find(pred);
        if (hit) return resolve(hit);
        if (Date.now() - t0 > ms) return reject(new Error('等不到事件：' + JSON.stringify(list.map(e => e.type))));
        setTimeout(tick, 20);
      };
      tick();
    });
  const host = createCollabNet({
    emit: e => hostEvents.push(e),
    discoveryPort,
    servicePort,
    announceMs: 100,
    extraTargets: ['127.0.0.1'],
  });
  const guest = createCollabNet({ emit: e => guestEvents.push(e), discoveryPort, servicePort });
  try {
    assert.equal(await guest.startDiscovery(), true);
    const info = await host.startHost({ proto: 1, hostId: 'h1', name: '主机', shares: [{ id: 's1', title: '稿子' }] });
    assert.ok(info.port > 0);
    const found = await waitFor(guestEvents, e => e.type === 'hosts' && e.hosts.some(h => h.hostId === 'h1'));
    const h = found.hosts.find(x => x.hostId === 'h1');
    assert.equal(h.port, info.port);
    assert.deepEqual(h.shares, [{ id: 's1', title: '稿子' }]);
    const r = await guest.connect({ address: '127.0.0.1', port: info.port });
    assert.ok(r.id, r.error);
    // 大消息（模拟整份项目）也能完整收到，多条消息按顺序到
    const big = {
      type: 'welcome',
      doc: { rows: Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [i, { text: '句'.repeat(40) }])) },
    };
    assert.equal(guest.send(r.id, { type: 'hello', n: 1 }), true);
    assert.equal(guest.send(r.id, { type: 'ops', n: 2 }), true);
    // 连进来的连接要等第一行到了才知道是消息连接还是传文件，所以 open 在第一条消息之前一刻才报
    const opened = await waitFor(hostEvents, e => e.type === 'open' && e.incoming);
    await waitFor(hostEvents, e => e.type === 'message' && e.msg.n === 2);
    assert.deepEqual(
      hostEvents.filter(e => e.type === 'message').map(e => e.msg.n),
      [1, 2],
    );
    host.send(opened.id, big);
    const got = await waitFor(guestEvents, e => e.type === 'message' && e.msg.type === 'welcome');
    assert.equal(Object.keys(got.msg.doc.rows).length, 3000);
    host.stopHost();
    await waitFor(guestEvents, e => e.type === 'hosts' && !e.hosts.some(x => x.hostId === 'h1'));
    guest.close(r.id);
    await waitFor(guestEvents, e => e.type === 'close' && e.id === r.id);
    const refused = await guest.connect({ address: '127.0.0.1', port: info.port }, 1000);
    assert.ok(refused.error);
  } finally {
    host.dispose();
    guest.dispose();
  }
});

await atest('协作保活：界面不处理消息仍在线，主进程停顿后不误断，失联仍会超时', async () => {
  const { createCollabNet } = require('../electron/collab-net.js');
  const net = await import('node:net');
  const events = [];
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async pred => {
    for (let i = 0; i < 100; i++) {
      const hit = events.find(pred);
      if (hit) return hit;
      await pause(20);
    }
    throw new Error('等不到协作网络事件');
  };
  const options = { heartbeatMs: 50, heartbeatTimeoutMs: 300 };
  const host = createCollabNet({ ...options, servicePort: 0, emit: e => events.push(e) });
  // 模拟界面完全不响应：收到事件后不做任何处理，网络层仍要自行保活。
  const guest = createCollabNet({ ...options, emit: () => {} });
  let legacy;
  try {
    const { port } = await host.startHost({ hostId: 'heartbeat', shares: [] });
    const r = await guest.connect({ address: '127.0.0.1', port });
    guest.send(r.id, { type: 'hello' });
    const first = await wait(e => e.type === 'open');
    host.send(first.id, { type: 'welcome' });
    await pause(900);
    assert.ok(!events.some(e => e.type === 'close'), '超过三个失联期限，连接仍保持');
    assert.ok(!events.some(e => ['ping', 'pong'].includes(e.msg?.type)), '心跳不依赖界面处理');
    // 模拟本机挂起超过超时：恢复后应先探测，再判断对方是否失联。
    const end = performance.now() + 400;
    while (performance.now() < end) {
      /* 模拟事件循环停顿 */
    }
    await pause(100);
    assert.ok(!events.some(e => e.type === 'close'), '本机停顿不能被算成对方失联');
    guest.send(r.id, { type: 'ops', n: 42 });
    await wait(e => e.msg?.n === 42);
    guest.close(r.id);
    await wait(e => e.type === 'close' && e.id === first.id);

    // 旧版只发 ping、不回复 pong，仍然能协作；停止一切消息后必须报超时。
    legacy = net.connect({ host: '127.0.0.1', port });
    legacy.on('error', () => {});
    legacy.write(JSON.stringify({ type: 'hello' }) + '\n');
    const second = await wait(e => e.type === 'open' && e.id !== first.id);
    let received = '';
    legacy.on('data', data => (received += data));
    host.send(second.id, { type: 'welcome' });
    for (let i = 0; i < 12; i++) {
      legacy.write(JSON.stringify({ type: 'ping' }) + '\n');
      await pause(50);
    }
    assert.ok(!events.some(e => e.type === 'close' && e.id === second.id), '兼容旧版心跳');
    assert.match(received, /"type":"pong"/);
    assert.match(received, /"type":"ping"/);
    const closed = await wait(e => e.type === 'close' && e.id === second.id);
    assert.equal(closed.reason, 'heartbeat-timeout');
  } finally {
    legacy?.destroy();
    host.dispose();
    guest.dispose();
  }
});

await atest(
  '局域网协作传文件：访客从主机取、主机从访客取；重名自动加 (2)；取过一次作废；对方没有这个文件时报清楚',
  async () => {
    const { createCollabNet } = require('../electron/collab-net.js');
    const events = [];
    const host = createCollabNet({ emit: e => events.push(e), servicePort: 0, discoveryPort: 47990 });
    const guest = createCollabNet({ emit: () => {} });
    const dir = tmp();
    const hostDir = path.join(dir, '主机'),
      guestDir = path.join(dir, '访客');
    fs.mkdirSync(hostDir);
    fs.mkdirSync(guestDir);
    const big = Buffer.alloc(3 * 1024 * 1024 + 17);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 255;
    fs.writeFileSync(path.join(hostDir, '封面 视频.mp4'), big);
    fs.writeFileSync(path.join(guestDir, '封面 视频.mp4'), 'guest 已经有一个同名文件');
    fs.writeFileSync(path.join(guestDir, '录音.wav'), 'voice-bytes');
    try {
      const { port } = await host.startHost({ proto: 1, hostId: 'h', name: '主机', shares: [] });
      // 访客取主机的文件
      const offer = await host.offerFile('t1', path.join(hostDir, '封面 视频.mp4'));
      assert.equal(offer.size, big.length);
      const got = await guest.fetchFile({ address: '127.0.0.1', port, token: 't1', dir: guestDir, name: offer.name });
      assert.ok(got.ok, got.error);
      assert.equal(path.basename(got.path), '封面 视频 (2).mp4', '重名不覆盖');
      assert.ok(fs.readFileSync(got.path).equals(big));
      assert.ok(!fs.readdirSync(guestDir).some(f => f.endsWith('.part')));
      // 同一个 token 不能再取
      const again = await guest.fetchFile({ address: '127.0.0.1', port, token: 't1', dir: guestDir, name: 'x' });
      assert.match(again.error, /过期/);
      // 不存在的文件
      assert.match((await host.offerFile('t2', path.join(hostDir, '没有.mp4'))).error, /找不到/);
      // 主机取访客的文件
      const waiting = host.expectFile({ token: 't3', dir: hostDir, name: '录音.wav' });
      const pushed = await guest.pushFile({
        address: '127.0.0.1',
        port,
        token: 't3',
        file: path.join(guestDir, '录音.wav'),
      });
      assert.ok(pushed.ok, pushed.error);
      const recv = await waiting;
      assert.ok(recv.ok, recv.error);
      assert.equal(fs.readFileSync(recv.path, 'utf8'), 'voice-bytes');
      assert.ok(events.some(e => e.type === 'file-progress' && e.token === 't3'));
      // 没登记过的送文件连接直接断开
      const stray = await guest.pushFile({
        address: '127.0.0.1',
        port,
        token: 'nope',
        file: path.join(guestDir, '录音.wav'),
      });
      assert.ok(stray.ok || stray.error);
      assert.ok(!fs.readdirSync(hostDir).some(f => f.endsWith('.part')));
      // 普通消息连接照常可用
      const c = await guest.connect({ address: '127.0.0.1', port });
      assert.ok(c.id);
      guest.send(c.id, { type: 'hello' });
      const t0 = Date.now();
      while (!events.some(e => e.type === 'message' && e.msg.type === 'hello') && Date.now() - t0 < 3000)
        await new Promise(r => setTimeout(r, 20));
      assert.ok(events.some(e => e.type === 'message' && e.msg.type === 'hello'));
    } finally {
      host.dispose();
      guest.dispose();
    }
  },
);

await atest('更新下载写盘失败能返回错误并取消读取，进程不崩溃', async () => {
  const dir = tmp();
  let canceled = false;
  const dest = path.join(dir, '不存在的目录', '更新.zip');
  const result = await up.downloadUpdate({ url: 'https://x/u.zip' }, dest, {
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(128 * 1024));
          },
          cancel() {
            canceled = true;
          },
        }),
      ),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /ENOENT/);
  assert.equal(canceled, true);
  assert.deepEqual(fs.readdirSync(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

await atest('外来 ZIP 虚报项目大小被拒绝，素材超出声明大小的块不落盘', async () => {
  const dir = tmp();
  const lie = (data, name, usize) => {
    const buffer = Buffer.from(data);
    let at = buffer.readUInt32LE(buffer.length - 22 + 16);
    const count = buffer.readUInt16LE(buffer.length - 22 + 10);
    for (let i = 0; i < count; i++) {
      const length = buffer.readUInt16LE(at + 28);
      if (buffer.subarray(at + 46, at + 46 + length).toString('utf8') === name) {
        buffer.writeUInt32LE(usize, at + 24);
        buffer.writeUInt32LE(usize, buffer.readUInt32LE(at + 42) + 22);
      }
      at += 46 + length + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
    }
    return buffer;
  };
  try {
    const projectZip = path.join(dir, 'project.zip');
    fs.writeFileSync(
      projectZip,
      lie(
        zip({ [pack.PROJECT_ENTRY]: JSON.stringify({ title: 'x'.repeat(1024 * 1024), rows: [] }) }),
        pack.PROJECT_ENTRY,
        100,
      ),
    );
    await assert.rejects(pack.inspectPack(projectZip), /大小不符/);
    const assetZip = path.join(dir, 'asset.zip');
    fs.writeFileSync(
      assetZip,
      lie(zip({ [pack.PROJECT_ENTRY]: '{}', '素材/a.txt': 'x'.repeat(1024 * 1024) }), '素材/a.txt', 100),
    );
    const out = path.join(dir, 'out');
    fs.mkdirSync(out);
    await assert.rejects(pack.extractPack(assetZip, out), /大小不符/);
    assert.ok(fs.statSync(path.join(out, '素材', 'a.txt')).size <= 100);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`${count} 项主进程回归通过`);
