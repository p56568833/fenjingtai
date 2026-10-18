/* 剪映草稿索引时间单位 + 剪映运行状态生产接线测试。
   覆盖：
   1) clock 模块的毫秒/微秒/日期换算与非法时钟兜底；
   2) registerDraft / entryFromDraftDir / writeIndexAtomic 的默认时钟与注入时钟路径（不能写出 1970）；
   3) 草稿列表顺序：新条目在最前，按 tm_draft_modified 降序时新草稿在顶部；
   4) 穿过真实 IPC → 导出任务 → 索引登记 的调用链（默认 runExport、真实 exporter、真实 registerDraft）：
      开始运行 / 复制过程中启动 / 过程退出 / 检测失败 / 索引外部改动；
   5) jianying:register 补登记：默认时钟日期正确，运行中或检测失败都拒绝写索引。
   全程用临时目录 + 注入的媒体工具，不启动剪映、不读真实草稿库、不写用户目录。
   用法：node scripts/jianying-index-ipc-test.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const clock = require('../electron/jianying/clock.js');
const register = require('../electron/jianying/register.js');
const platform = require('../electron/jianying/platform.js');
const ipc = require('../electron/ipc-jianying.js');

/* 生产入口 electron/main.js 调 registerJianyingIpc({ handle, win })，不传 deps：
   实时运行状态只能来自 platform.isRunning()（IPC 在每次调用时才读取）。
   测试里替换成可控探针，避免真的去 pgrep 剪映进程；这样旧实现的「IPC 没把
   isRunning 传给导出任务」才会像生产一样退回 request.running 旧快照。 */
let liveProbe = () => false;
platform.isRunning = () => liveProbe();

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const roots = [];
const tmpRoot = label => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `分镜台${label}-`));
  roots.push(dir);
  return dir;
};

const INDEX_NAME = 'root_meta_info.json';
const INJECTED_MS = 1792254000000; // 2026-10-18 00:20:00（本机时区），契约指定的注入时钟
const TEST_FINGERPRINT = {
  ok: true,
  source: 'draft_info',
  platform: {
    app_id: 3704,
    app_source: 'lv',
    app_version: '11.6.0',
    device_id: 'TEST-DEVICE',
    hard_disk_id: 'TEST-DISK',
    mac_address: 'TEST-MAC',
    os: 'mac',
    os_version: '27.0.1',
  },
};

const pad2 = n => String(n).padStart(2, '0');
const expectedStamp = ms => {
  const date = new Date(ms);
  return (
    `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-` +
    `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
  );
};
const todayYmd = () => {
  const date = new Date();
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;
};
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const indexFileOf = library => path.join(library, INDEX_NAME);
const readIndexDoc = library => readJson(indexFileOf(library));
const waitFor = async (predicate, label = '等待条件', timeoutMs = 15000) => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`${label}超时`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

/* ── 临时草稿库 / 草稿目录（真实文件，索引是真实 root_meta_info.json） ── */
function makeLibrary(root, entries = []) {
  const library = path.join(root, '剪映草稿库 目录');
  fs.mkdirSync(library, { recursive: true });
  fs.writeFileSync(indexFileOf(library), JSON.stringify({ all_draft_store: entries, root_path: library }));
  return library;
}

function makeDraftDir(library, name, id) {
  const draftDir = path.join(library, name);
  fs.mkdirSync(path.join(draftDir, 'Resources'), { recursive: true });
  fs.writeFileSync(path.join(draftDir, 'Resources', '占位.mp4'), Buffer.alloc(16, 1));
  fs.writeFileSync(path.join(draftDir, 'draft_info.json'), JSON.stringify({ id, name, duration: 12000000 }));
  return draftDir;
}

/* ── 1. clock 模块本身 ── */
test('clock：readMs 收函数/数字、非法值回退当前；toUs 只乘一次 1000；stampDate 是本地日期', () => {
  assert.equal(
    clock.readMs(() => INJECTED_MS),
    INJECTED_MS,
  );
  assert.equal(clock.readMs(INJECTED_MS), INJECTED_MS);
  assert.equal(clock.readMs(String(INJECTED_MS)), INJECTED_MS);
  for (const bad of [Number.NaN, Infinity, undefined, null, '不是数字', {}]) {
    const value = clock.readMs(bad);
    assert.equal(Number.isFinite(value), true);
    assert.ok(Math.abs(value - Date.now()) < 5000, `非法时钟要回退当前时间，实际 ${value}`);
  }
  assert.equal(clock.toUs(INJECTED_MS), INJECTED_MS * 1000);
  assert.equal(clock.toUs(1234.5678), 1234568); // Math.round
  assert.equal(clock.stampDate(INJECTED_MS), expectedStamp(INJECTED_MS));
  assert.match(clock.stampDate(Date.now()), /^\d{8}-\d{6}$/);
  assert.notEqual(clock.stampDate(Date.now()).slice(0, 8), '19700101');
});

/* ── 2. 默认时钟：补登记写的是微秒，日期是现在，备份名是今天 ── */
test('默认时钟：registerDraft 写微秒且与当前时间相符（不是 1970），备份文件名是今天', () => {
  const root = tmpRoot('默认时钟');
  const library = makeLibrary(root);
  const backupDir = path.join(root, '索引备份');
  const draftDir = makeDraftDir(library, '默认时钟草稿', 'DRAFT-DEFAULT');
  const originalRaw = fs.readFileSync(indexFileOf(library), 'utf8');
  const beforeMs = Date.now();
  const result = register.registerDraft({ draftRoot: library, draftDir, backupDir });
  const afterMs = Date.now();
  assert.equal(result.ok, true, result.error);
  assert.equal(result.registered, true);
  assert.equal(result.already, undefined);

  const entry = readIndexDoc(library).all_draft_store[0];
  assert.equal(entry.draft_fold_path, draftDir);
  assert.equal(entry.draft_name, '默认时钟草稿');
  /* 毫秒被当微秒会得到 1970 年（约 1.7e12），正确值是毫秒×1000（约 1.7e15） */
  assert.ok(entry.tm_draft_create > 1e15, `索引时间应是微秒量级，实际 ${entry.tm_draft_create}`);
  assert.ok(
    entry.tm_draft_create >= beforeMs * 1000 - 5 * 1000000 && entry.tm_draft_create <= afterMs * 1000 + 5 * 1000000,
    `索引时间应接近当前时间，实际 ${new Date(entry.tm_draft_create / 1000).toISOString()}`,
  );
  assert.ok(Math.abs(entry.tm_draft_create / 1000 - Date.now()) < 5000, '索引日期与当前时间相差应小于 5 秒');
  assert.equal(new Date(entry.tm_draft_create / 1000).getFullYear(), new Date().getFullYear(), '不能是 1970 年');
  assert.equal(entry.tm_draft_modified, entry.tm_draft_create);

  /* 备份文件名：今天日期，不能是 1970 */
  const backups = fs.readdirSync(backupDir);
  assert.equal(backups.length, 1, `应只有一个备份，实际 ${backups.join(',')}`);
  const name = backups[0];
  assert.match(name, /^root_meta_info-\d{8}-\d{6}\.json$/);
  const datePart = name.slice('root_meta_info-'.length, 'root_meta_info-'.length + 8);
  assert.equal(datePart, todayYmd(), `备份文件名日期应是今天，实际 ${name}`);
  assert.notEqual(datePart, '19700101');
  assert.equal(fs.readFileSync(path.join(backupDir, name), 'utf8'), originalRaw, '备份应是写之前的索引');
});

/* ── 3. 注入时钟：毫秒 → 微秒只转换一次 ── */
test('注入时钟：now=1792254000000ms → 索引恰为 1792254000000000us，备份日期对应注入时间', () => {
  const root = tmpRoot('注入时钟');
  const library = makeLibrary(root);
  const backupDir = path.join(root, '索引备份');
  const draftDir = makeDraftDir(library, '注入时钟草稿', 'DRAFT-INJECTED');
  const before = Date.now();
  const result = register.registerDraft({ draftRoot: library, draftDir, backupDir, now: INJECTED_MS });
  assert.equal(result.ok, true, result.error);
  const entry = readIndexDoc(library).all_draft_store[0];
  assert.equal(entry.tm_draft_create, INJECTED_MS * 1000, '补登记应把毫秒转成微秒');
  assert.equal(entry.tm_draft_modified, INJECTED_MS * 1000);
  assert.notEqual(entry.tm_draft_create, INJECTED_MS, '不能把毫秒数字直接当微秒写');
  assert.notEqual(entry.tm_draft_create, INJECTED_MS * 1000000, '不能二次乘 1000（毫秒→微秒只能转一次）');
  assert.ok(Date.now() - before < 5000, '注入时钟时不应真的等 5 秒');
  const backups = fs.readdirSync(backupDir);
  assert.equal(backups.length, 1);
  assert.equal(backups[0], `root_meta_info-${expectedStamp(INJECTED_MS)}.json`, '备份日期应对应注入的毫秒时间');
});

/* ── 4. entryFromDraftDir：默认与注入时钟都只转一次 ── */
test('entryFromDraftDir：默认时钟是现在；注入时钟（数字/函数）都恰为同一毫秒的微秒值', () => {
  const root = tmpRoot('反推条目');
  const library = makeLibrary(root);
  const draftDir = makeDraftDir(library, '反推草稿', 'DRAFT-ENTRY');

  const defaultEntry = register.entryFromDraftDir({ draftRoot: library, draftDir });
  assert.equal(defaultEntry.ok, true, defaultEntry.error);
  assert.ok(Math.abs(defaultEntry.entry.tm_draft_create / 1000 - Date.now()) < 5000);
  assert.equal(new Date(defaultEntry.entry.tm_draft_create / 1000).getFullYear(), new Date().getFullYear());

  const numberEntry = register.entryFromDraftDir({ draftRoot: library, draftDir, now: INJECTED_MS });
  assert.equal(numberEntry.entry.tm_draft_create, INJECTED_MS * 1000);
  const functionEntry = register.entryFromDraftDir({ draftRoot: library, draftDir, now: () => INJECTED_MS });
  assert.equal(functionEntry.entry.tm_draft_create, INJECTED_MS * 1000);
  assert.equal(functionEntry.entry.tm_draft_modified, INJECTED_MS * 1000);

  /* 坏时钟回退当前时间，不能写出 1970 或 NaN */
  const badEntry = register.entryFromDraftDir({ draftRoot: library, draftDir, now: () => Number.NaN });
  assert.ok(Math.abs(badEntry.entry.tm_draft_create / 1000 - Date.now()) < 5000);
  assert.equal(Number.isInteger(badEntry.entry.tm_draft_create), true);
});

/* ── 5. 草稿顺序：新条目在最前，剪映按 tm_draft_modified 降序时新草稿在顶部 ── */
test('草稿顺序：新登记条目插到 all_draft_store 最前，按 tm_draft_modified 降序新草稿在顶部', () => {
  const root = tmpRoot('草稿排序');
  const library = makeLibrary(root);
  const oldMs = INJECTED_MS - 24 * 60 * 60 * 1000; // 一天前
  const oldDir = makeDraftDir(library, '旧草稿', 'DRAFT-OLD');
  const newDir = makeDraftDir(library, '新草稿', 'DRAFT-NEW');
  assert.equal(register.registerDraft({ draftRoot: library, draftDir: oldDir, now: oldMs }).registered, true);
  assert.equal(register.registerDraft({ draftRoot: library, draftDir: newDir, now: INJECTED_MS }).registered, true);

  const doc = readIndexDoc(library);
  assert.equal(doc.all_draft_store.length, 2);
  assert.equal(doc.all_draft_store[0].draft_fold_path, newDir, '新条目要插到数组最前');
  assert.equal(doc.all_draft_store.at(-1).draft_fold_path, oldDir);
  /* 剪映的本地草稿列表按 tm_draft_modified 降序展示 */
  const sorted = [...doc.all_draft_store].sort((a, b) => Number(b.tm_draft_modified) - Number(a.tm_draft_modified));
  assert.deepEqual(
    sorted.map(item => item.draft_fold_path),
    [newDir, oldDir],
    '按修改时间降序时新草稿必须在最前',
  );
  const newEntry = doc.all_draft_store[0];
  assert.equal(newEntry.tm_draft_modified, INJECTED_MS * 1000);
  assert.ok(newEntry.tm_draft_modified > oldMs * 1000);
  /* 微秒量级；如果被写成毫秒，剪映会显示 1970 并排到最末 */
  assert.ok(newEntry.tm_draft_modified > 1e15);
});

/* ── 6. registerDraft 的实时运行状态兜底 ── */
test('registerDraft 运行态兜底：isRunning=true 或抛错都不写索引，草稿保留并返回 needsQuit', () => {
  const root = tmpRoot('运行兜底');
  const library = makeLibrary(root);
  const draftDir = makeDraftDir(library, '兜底草稿', 'DRAFT-GUARD');
  const originalRaw = fs.readFileSync(indexFileOf(library), 'utf8');

  const running = register.registerDraft({ draftRoot: library, draftDir, isRunning: () => true, now: INJECTED_MS });
  assert.equal(running.ok, false);
  assert.equal(running.registered, false);
  assert.equal(running.needsQuit, true);
  assert.match(running.error, /剪映正在运行/);

  const broken = register.registerDraft({
    draftRoot: library,
    draftDir,
    isRunning: () => {
      throw new Error('pgrep 失败');
    },
    now: INJECTED_MS,
  });
  assert.equal(broken.ok, false);
  assert.equal(broken.registered, false);
  assert.equal(broken.needsQuit, true);
  assert.match(broken.error, /无法确认剪映/);

  assert.equal(fs.readFileSync(indexFileOf(library), 'utf8'), originalRaw, '拒绝时必须原样保留索引');
  assert.equal(fs.existsSync(path.join(draftDir, 'draft_info.json')), true, '草稿本身要保留');
});

/* ── 7. 真实 IPC → 导出任务 → 索引登记 调用链 ── */

/* 导出计划：视频 + 图片 + 独立音频 + 一条字幕；不产生定格/抽音轨，媒体替身只需要探测和写封面 */
function makePlan(root) {
  const src = path.join(root, '素材 目录 #1');
  fs.mkdirSync(src, { recursive: true });
  const write = (name, size) => {
    const file = path.join(src, name);
    fs.writeFileSync(file, Buffer.alloc(size, 7));
    return file;
  };
  const video = write('A 片段 #1.mp4', 6000);
  const image = write('B 图片 "封面".png', 3000);
  const voice = write('口播 voice.wav', 4000);
  return {
    schemaVersion: 1,
    source: { projectId: 'p-index', updatedAt: '2026-10-18T00:00:00.000Z', title: '索引链路测试' },
    title: '索引链路测试',
    canvas: { width: 1920, height: 1080 },
    fps: { num: 30, den: 1 },
    durationUs: 8000000,
    timing: { source: 'srt', mixed: false, counts: { ok: 1, low: 0, est: 0, gap: 0 }, note: '' },
    assets: [
      { planId: 'a', kind: 'video', path: video, name: 'A 片段 #1.mp4', width: 1280, height: 720, durationUs: 8000000 },
      { planId: 'b', kind: 'image', path: image, name: 'B 图片 "封面".png', width: 1920, height: 1080, durationUs: 0 },
      { planId: 'v', kind: 'audio', path: voice, name: '口播 voice.wav', width: 0, height: 0, durationUs: 8000000 },
    ],
    derived: [],
    tracks: {
      video: [
        {
          id: 's1',
          kind: 'video',
          assetId: 'a',
          targetStartUs: 0,
          targetDurationUs: 3000000,
          sourceStartUs: 0,
          sourceDurationUs: 3000000,
          speed: 1,
          volume: 1,
        },
        {
          id: 's2',
          kind: 'image',
          assetId: 'b',
          targetStartUs: 3000000,
          targetDurationUs: 2000000,
          sourceStartUs: 0,
          sourceDurationUs: 2000000,
          speed: 1,
          volume: 0,
        },
      ],
      audio: [
        {
          id: 'a1',
          kind: 'audio',
          assetId: 'v',
          targetStartUs: 0,
          targetDurationUs: 5000000,
          sourceStartUs: 0,
          sourceDurationUs: 5000000,
          volume: 1,
        },
      ],
      text: [{ id: 't1', text: '索引链路测试字幕', targetStartUs: 300000, targetDurationUs: 2000000 }],
    },
    subtitles: [{ lineId: 'l1', no: 1, text: '索引链路测试字幕', startUs: 300000, endUs: 2300000 }],
    srt: '',
    issues: [],
    stats: { shots: 2, segments: 3, freezeCount: 0, gapUs: 0, totalUs: 8000000 },
  };
}

/* 媒体替身：探测返回真实形状（兼容 Lead 集成后的 { ok:true, ... } 约定），封面写真实文件 */
function makeMediaStub() {
  return {
    available: () => true,
    async probe({ path: file }) {
      if (/\.png$/i.test(file))
        return {
          ok: true,
          durationUs: 0,
          width: 1920,
          height: 1080,
          rotation: 0,
          hasVideo: true,
          hasAudio: false,
          videoCodec: 'png',
          audioCodec: '',
        };
      if (/\.(wav|m4a|aac|mp3)$/i.test(file))
        return {
          ok: true,
          durationUs: 12000000,
          width: 0,
          height: 0,
          rotation: 0,
          hasVideo: false,
          hasAudio: true,
          videoCodec: '',
          audioCodec: 'pcm_s16le',
        };
      return {
        ok: true,
        durationUs: 12000000,
        width: 1280,
        height: 720,
        rotation: 0,
        hasVideo: true,
        hasAudio: true,
        videoCodec: 'h264',
        audioCodec: 'aac',
      };
    },
    async extractFrame() {
      throw new Error('索引链路测试不应抽定格帧');
    },
    async extractAudio() {
      throw new Error('索引链路测试不应抽音轨');
    },
    async cover({ outPath }) {
      fs.writeFileSync(outPath, Buffer.from('fake-jpg-bytes'));
    },
  };
}

function makeIdFor(seed = 0) {
  let n = seed;
  return prefix => `${String(++n).padStart(8, '0')}-${String(prefix).toUpperCase()}`;
}

/* 真实 IPC 实例：捕获 handlers，fake sender 收 progress/result；默认 runExport（不注入），走真实 exporter */
function makeChain(root, { detectRunning = false, now = () => INJECTED_MS, fsFactory } = {}) {
  const library = makeLibrary(root);
  const indexFile = indexFileOf(library);
  const plan = makePlan(root);
  const handlers = new Map();
  const events = [];
  const detectResults = [];
  const live = { running: false, throwNow: false };
  const phaseHook = { fn: null };
  const userData = path.join(root, '用户数据');
  const backupDir = path.join(userData, '剪映导出', '索引备份');
  const sender = {
    id: 7,
    isDestroyed: () => false,
    send(channel, payload) {
      events.push({ channel, payload });
      if (channel === ipc.CHANNELS.PROGRESS && typeof phaseHook.fn === 'function') phaseHook.fn(payload.phase);
    },
  };
  liveProbe = () => {
    if (live.throwNow) throw new Error('模拟运行状态检测失败');
    return live.running;
  };
  const extraFs = typeof fsFactory === 'function' ? fsFactory({ indexFile, library }) : null;
  const deps = {
    app: { getPath: () => userData },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { openPath: async () => '', showItemInFolder: () => {} },
    detect: () => {
      const value = {
        ok: true,
        appPath: '/Applications/VideoFusion-macOS.app',
        version: '11.6.0',
        draftRoot: library,
        running: detectRunning, // 请求开始时的旧快照（装进 request.running）
        canRegister: true,
        fingerprint: TEST_FINGERPRINT,
        supported: true,
        issues: [],
      };
      detectResults.push(value);
      return value;
    },
    /* 故意不传 isRunning：模拟生产入口，实时状态由 platform.isRunning（liveProbe）提供 */
    detectTtl: 0,
    media: makeMediaStub(),
    idFor: makeIdFor(),
    now,
    freeBytes: () => 1024 * 1024 * 1024,
    ...(extraFs ? { fs: extraFs } : {}),
  };
  ipc.registerJianyingIpc({ handle: (channel, fn) => handlers.set(channel, fn), win: () => null, deps });
  const invoke = (channel, payload) => handlers.get(channel)({ sender }, payload);
  const waitResult = async () => {
    await waitFor(() => events.some(item => item.channel === ipc.CHANNELS.RESULT), '等待导出结果');
    return events.filter(item => item.channel === ipc.CHANNELS.RESULT).at(-1).payload;
  };
  return {
    library,
    indexFile,
    backupDir,
    plan,
    events,
    live,
    phaseHook,
    detectResults,
    invoke,
    waitResult,
    progress: () => events.filter(item => item.channel === ipc.CHANNELS.PROGRESS),
    run: async ({ draftName = '链路草稿', jobId = 'job-index-1' } = {}) => {
      const started = await invoke(ipc.CHANNELS.EXPORT, {
        jobId,
        projectId: 'project-index',
        plan,
        snapshot: { title: '索引链路测试', updatedAt: '2026-10-18T00:00:00.000Z' },
        options: { mode: 'library', draftName },
      });
      assert.equal(started.ok, true, started.error);
      const result = await waitResult();
      assert.equal(result.jobId, jobId);
      return result;
    },
  };
}

const draftKept = result => {
  assert.equal(typeof result.draftDir, 'string');
  assert.equal(fs.existsSync(path.join(result.draftDir, 'draft_info.json')), true, '草稿必须保留');
};

/* a. 开始导出时剪映就在运行：只生成草稿，不写索引 */
test('真实 IPC 链路 a：开始导出时剪映在运行 → 草稿保留、索引不动、needsQuit', async () => {
  const root = tmpRoot('链路开始运行');
  const chain = makeChain(root, { detectRunning: true });
  chain.live.running = true;
  const indexBefore = fs.readFileSync(chain.indexFile, 'utf8');
  const result = await chain.run();
  assert.equal(result.ok, true, result.error);
  assert.equal(result.registered, false);
  assert.equal(result.needsQuit, true);
  assert.notEqual(result.runningUnknown, true, '明确检测到运行中时是「正在运行」而不是「无法确认」');
  assert.equal(fs.readFileSync(chain.indexFile, 'utf8'), indexBefore, '运行中不能改索引');
  assert.equal(fs.existsSync(chain.backupDir), false, '没有写索引就不该产生备份');
  draftKept(result);
  assert.ok(chain.progress().length > 0, 'fake sender 应收到进度事件');
  assert.equal(chain.events.filter(item => item.channel === ipc.CHANNELS.RESULT).length, 1, '结果只发一次');
  assert.ok(
    chain.events.every(item => item.payload.jobId === 'job-index-1'),
    '进度/结果都带 jobId',
  );
});

/* b. 开始未运行（request.running 旧快照 false），复制过程中剪映被打开：登记时按实时状态停手 */
test('真实 IPC 链路 b：开始未运行、复制过程中启动（request.running 旧快照 false）→ 不写索引、needsQuit', async () => {
  const root = tmpRoot('链路过程启动');
  const chain = makeChain(root, { detectRunning: false });
  chain.live.running = false;
  chain.phaseHook.fn = phase => {
    if (phase === 'copy') chain.live.running = true; // 复制素材时用户打开了剪映
  };
  const indexBefore = fs.readFileSync(chain.indexFile, 'utf8');
  const result = await chain.run({ draftName: '过程启动草稿' });
  assert.equal(chain.detectResults.at(-1)?.running, false, '请求开始时剪映未运行（request.running 旧快照 false）');
  assert.equal(result.ok, true, result.error);
  assert.equal(result.registered, false, '实时检测到运行中，不能登记');
  assert.equal(result.needsQuit, true);
  assert.equal(fs.readFileSync(chain.indexFile, 'utf8'), indexBefore, '不能退回 request.running 旧快照写索引');
  assert.equal(fs.existsSync(chain.backupDir), false);
  draftKept(result);
  assert.ok(
    chain.progress().some(item => item.payload.phase === 'copy'),
    '复制阶段确实发生过，才说明检测发生在复制之后',
  );
});

/* c. 开始运行（request.running 旧快照 true）但登记前已退出：按实时状态正常登记 */
test('真实 IPC 链路 c：旧快照 true 但登记前已退出 → 正常登记，索引时间与注入时钟一致', async () => {
  const root = tmpRoot('链路过程退出');
  const chain = makeChain(root, { detectRunning: true, now: () => INJECTED_MS });
  chain.live.running = true;
  chain.phaseHook.fn = phase => {
    if (phase === 'copy') chain.live.running = false; // 复制素材时用户退出了剪映
  };
  const result = await chain.run({ draftName: '过程退出草稿' });
  assert.equal(chain.detectResults.at(-1)?.running, true, '请求开始时剪映在运行（request.running 旧快照 true）');
  assert.equal(result.ok, true, result.error);
  assert.equal(result.registered, true, '实时检测到已退出，应正常登记');
  assert.equal(result.needsQuit, false);
  draftKept(result);

  const doc = readIndexDoc(chain.library);
  const entry = doc.all_draft_store.find(item => item.draft_fold_path === result.draftDir);
  assert.ok(entry, '索引里要有这次导出的草稿');
  assert.equal(entry.draft_fold_path, result.draftDir);
  /* 生产链路上 now 必须按毫秒传进 registerDraft；×1000 由 register 内部统一完成。
     如果这里是 1.79e18（再乘了一次 1000），说明 exporter 仍把微秒当毫秒传（等 Lead 接线）。 */
  assert.equal(entry.tm_draft_create, INJECTED_MS * 1000, '索引时间应是注入毫秒的微秒值（且只转一次）');
  assert.equal(entry.tm_draft_modified, INJECTED_MS * 1000);
  const backupNames = fs.readdirSync(chain.backupDir);
  assert.equal(backupNames.length, 1);
  assert.equal(backupNames[0], `root_meta_info-${expectedStamp(INJECTED_MS)}.json`, '备份文件名日期应是注入时钟的日期');
});

/* d. 运行状态检测抛错：保守拒绝写索引，草稿保留 */
test('真实 IPC 链路 d：isRunning 抛错 → 保守不写索引、草稿保留、needsQuit', async () => {
  const root = tmpRoot('链路检测失败');
  const chain = makeChain(root, { detectRunning: false });
  chain.live.throwNow = true;
  const indexBefore = fs.readFileSync(chain.indexFile, 'utf8');
  const result = await chain.run({ draftName: '检测失败草稿' });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.registered, false, '检测失败时不能写索引');
  assert.equal(fs.readFileSync(chain.indexFile, 'utf8'), indexBefore);
  draftKept(result);
  assert.equal(result.needsQuit, true);
  assert.equal(result.runningUnknown, true, '检测失败要标记「无法确认」，不能伪装成明确在运行');
  assert.ok(
    result.notes.some(note => /剪映/.test(note)) || result.issues.some(issue => /剪映|确认/.test(issue.message || '')),
    '要告诉用户草稿没进列表、以及原因（剪映在运行或无法确认）',
  );
});

/* e. 登记写入窗口内索引被外部程序改动：不覆盖外部改动，草稿保留，登记失败/conflict */
test('真实 IPC 链路 e：登记写入窗口索引被外部改动 → 不覆盖、草稿保留、register-failed/conflict', async () => {
  const root = tmpRoot('链路索引冲突');
  const externalDoc = () => ({
    all_draft_store: [
      {
        draft_id: 'EXTERNAL-DRAFT',
        draft_name: '外部改的草稿',
        draft_fold_path: path.join(root, '剪映草稿库 目录', '外部草稿'),
        tm_draft_create: 1,
        tm_draft_modified: 2,
      },
    ],
    root_path: path.join(root, '剪映草稿库 目录'),
    external_marker: true,
  });
  let externalRaw = '';
  let fired = false;
  const chain = makeChain(root, {
    detectRunning: false,
    /* 模拟另一个进程在 registerDraft 的「读索引 → 写索引」窗口里改索引：
       备份文件一落盘（校验读之前）就覆盖索引内容。 */
    fsFactory: ({ indexFile }) => {
      const wrapped = Object.create(fs);
      wrapped.writeFileSync = (file, data, ...rest) => {
        const written = fs.writeFileSync(file, data, ...rest);
        if (
          !fired &&
          typeof file === 'string' &&
          file.includes('索引备份') &&
          path.basename(file).startsWith('root_meta_info-')
        ) {
          fired = true;
          externalRaw = JSON.stringify(externalDoc());
          fs.writeFileSync(indexFile, externalRaw);
        }
        return written;
      };
      return wrapped;
    },
  });
  chain.live.running = false;
  const result = await chain.run({ draftName: '索引冲突草稿' });
  assert.equal(fired, true, '外部改动必须真的写进去，测试才有意义');
  assert.equal(result.ok, true, result.error);
  assert.equal(result.registered, false, '索引被外部改动时不能覆盖');
  assert.equal(fs.readFileSync(chain.indexFile, 'utf8'), externalRaw, '外部改动必须原样保留');
  assert.equal(
    result.issues.some(issue => issue.code === 'register-failed'),
    true,
    '要在问题列表里给出 register-failed',
  );
  draftKept(result);
  /* 冲突时不能留下临时文件 */
  assert.equal(
    fs.readdirSync(chain.library).filter(name => name.endsWith('.tmp')).length,
    0,
    '冲突时要清掉临时索引文件',
  );
});

/* f. 复制素材期间外部程序改索引：登记前比较导出开始时的索引原文，停止自动登记、保留草稿 */
test('真实 IPC 链路 f：复制期间索引被外部改动 → 停止自动登记、外部改动原样保留、草稿保留', async () => {
  const root = tmpRoot('链路复制期索引变更');
  const chain = makeChain(root, { detectRunning: false });
  chain.live.running = false;
  const external = {
    all_draft_store: [
      {
        draft_id: 'EXTERNAL-DURING-COPY',
        draft_name: '复制期间新出现的草稿',
        draft_fold_path: path.join(root, '剪映草稿库 目录', '外部草稿'),
        tm_draft_create: 11,
        tm_draft_modified: 22,
      },
    ],
    root_path: path.join(root, '剪映草稿库 目录'),
    external_marker: 'keep-me',
  };
  const externalRaw = JSON.stringify(external);
  let changed = false;
  chain.phaseHook.fn = phase => {
    if (phase !== 'copy' || changed) return;
    changed = true;
    fs.writeFileSync(chain.indexFile, externalRaw);
  };
  const result = await chain.run({ draftName: '复制期索引变更草稿' });
  assert.equal(changed, true, '外部改动必须真的发生在复制阶段');
  assert.equal(result.ok, true, result.error);
  assert.equal(result.registered, false, '索引在导出期间变化时应停止自动登记');
  assert.equal(fs.readFileSync(chain.indexFile, 'utf8'), externalRaw, '外部改动必须原样保留');
  assert.equal(fs.existsSync(chain.backupDir), false, '停止登记时不应写索引备份');
  assert.equal(result.needsQuit, false, '索引冲突不是剪映运行状态问题');
  assert.ok(
    result.issues.some(issue => issue.code === 'register-failed' && /索引/.test(issue.message || '')),
    '要说明是草稿库索引在导出期间被改动',
  );
  assert.ok(
    result.notes.some(note => /索引/.test(note) && /补登记/.test(note)),
    '要告诉用户草稿保留、可以之后补登记',
  );
  draftKept(result);
});

/* ── 8. jianying:register 补登记（默认时钟；运行中/检测失败拒绝） ── */
function makeRegisterHarness(root, { isRunning }) {
  const library = makeLibrary(root);
  const handlers = new Map();
  const events = [];
  const sender = { id: 9, isDestroyed: () => false, send: (channel, payload) => events.push({ channel, payload }) };
  ipc.registerJianyingIpc({
    handle: (channel, fn) => handlers.set(channel, fn),
    win: () => null,
    deps: {
      app: { getPath: () => path.join(root, '用户数据') },
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
      shell: { openPath: async () => '', showItemInFolder: () => {} },
      detect: () => ({
        ok: true,
        appPath: '/Applications/VideoFusion-macOS.app',
        version: '11.6.0',
        draftRoot: library,
        running: false,
        canRegister: true,
        fingerprint: TEST_FINGERPRINT,
        supported: true,
        issues: [],
      }),
      isRunning,
      detectTtl: 0,
      /* 不注入 registerDraft：补登记必须走真实 register.js */
    },
  });
  return {
    library,
    invoke: (channel, payload) => handlers.get(channel)({ sender }, payload),
  };
}

test('jianying:register 补登记：默认时钟日期正确；运行中或检测失败都拒绝写', async () => {
  /* 1) 正常补登记：默认时钟 → 今天，不是 1970 */
  const okRoot = tmpRoot('补登记正常');
  const okHarness = makeRegisterHarness(okRoot, { isRunning: () => false });
  const draftDir = makeDraftDir(okHarness.library, '补登记草稿', 'DRAFT-IPC-REGISTER');
  const okResult = await okHarness.invoke(ipc.CHANNELS.REGISTER, { draftDir });
  assert.equal(okResult.ok, true, okResult.error);
  assert.equal(okResult.registered, true);
  const entry = readIndexDoc(okHarness.library).all_draft_store[0];
  assert.equal(entry.draft_fold_path, draftDir);
  assert.ok(entry.tm_draft_create > 1e15, `补登记索引应是微秒，实际 ${entry.tm_draft_create}`);
  assert.ok(Math.abs(entry.tm_draft_create / 1000 - Date.now()) < 5000, '补登记日期应与当前时间相符');
  assert.equal(new Date(entry.tm_draft_create / 1000).getFullYear(), new Date().getFullYear());
  const backupDir = path.join(okRoot, '用户数据', '剪映导出', '索引备份');
  const backups = fs.readdirSync(backupDir);
  assert.equal(backups.length, 1);
  assert.equal(
    backups[0].slice('root_meta_info-'.length, 'root_meta_info-'.length + 8),
    todayYmd(),
    '补登记备份文件名应是今天',
  );

  /* 2) 剪映在运行：拒绝写索引，原索引原样保留 */
  const runningRoot = tmpRoot('补登记运行中');
  const runningHarness = makeRegisterHarness(runningRoot, { isRunning: () => true });
  const runningDraft = makeDraftDir(runningHarness.library, '运行中补登记草稿', 'DRAFT-IPC-RUNNING');
  const runningBefore = fs.readFileSync(indexFileOf(runningHarness.library), 'utf8');
  const runningResult = await runningHarness.invoke(ipc.CHANNELS.REGISTER, { draftDir: runningDraft });
  assert.equal(runningResult.ok, false);
  assert.equal(runningResult.registered, false);
  assert.equal(runningResult.needsQuit, true);
  assert.equal(fs.readFileSync(indexFileOf(runningHarness.library), 'utf8'), runningBefore);

  /* 3) 检测抛错：无法确认时也不写索引，并说明无法确认 */
  const brokenRoot = tmpRoot('补登记检测失败');
  const brokenHarness = makeRegisterHarness(brokenRoot, {
    isRunning: () => {
      throw new Error('pgrep 失败');
    },
  });
  const brokenDraft = makeDraftDir(brokenHarness.library, '检测失败补登记草稿', 'DRAFT-IPC-BROKEN');
  const brokenBefore = fs.readFileSync(indexFileOf(brokenHarness.library), 'utf8');
  const brokenResult = await brokenHarness.invoke(ipc.CHANNELS.REGISTER, { draftDir: brokenDraft });
  assert.equal(brokenResult.ok, false);
  assert.equal(brokenResult.registered, false);
  assert.equal(brokenResult.needsQuit, true);
  assert.match(brokenResult.error, /无法确认剪映/);
  assert.equal(fs.readFileSync(indexFileOf(brokenHarness.library), 'utf8'), brokenBefore);

  /* 4) 第一次检查时未运行、真正写索引前剪映被打开 → register.js 兜底再查一次，拒绝写 */
  const flipRoot = tmpRoot('补登记二次检查');
  let checks = 0;
  const flipHarness = makeRegisterHarness(flipRoot, {
    isRunning: () => {
      checks++;
      return checks > 1; // 第二次（写索引前）才「开始运行」
    },
  });
  const flipDraft = makeDraftDir(flipHarness.library, '二次检查草稿', 'DRAFT-IPC-FLIP');
  const flipBefore = fs.readFileSync(indexFileOf(flipHarness.library), 'utf8');
  const flipResult = await flipHarness.invoke(ipc.CHANNELS.REGISTER, { draftDir: flipDraft });
  assert.ok(checks >= 2, `补登记应在写索引前再检查一次运行状态，实际检查 ${checks} 次`);
  assert.equal(flipResult.ok, false, '写索引前检测到运行中就不能写');
  assert.equal(flipResult.registered, false);
  assert.equal(flipResult.needsQuit, true);
  assert.equal(fs.readFileSync(indexFileOf(flipHarness.library), 'utf8'), flipBefore);
});

/* 跑全部用例；每个用例后清掉它创建的临时目录 */
let passed = 0;
const failures = [];
for (const { name, fn } of tests) {
  try {
    await fn();
    passed++;
    console.log('✓', name);
  } catch (error) {
    failures.push({ name, error });
    console.error('✗', name);
    console.error(error?.stack || error);
  } finally {
    for (const dir of roots.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  }
}

if (failures.length) {
  console.error(`\n剪映索引/运行状态接线测试失败：${failures.length} 项未通过（通过 ${passed} 项）`);
  process.exitCode = 1;
} else {
  console.log(`\n剪映索引/运行状态接线测试通过：${passed} 项`);
}
