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
  assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'http,https,tls,tcp,crypto');
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

console.log(`${count} 项主进程回归通过`);
