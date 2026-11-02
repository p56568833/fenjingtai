/* 数据层回归（不需要 Electron、不碰真实磁盘和用户数据）：
   缺陷 2：候选清单写回必须用「发起时那个项目」的 rows / candidates 算 inUse，不能混用当前项目状态；
           入队时就算好内容，真正写文件时不重新读取活动项目；失败记录与重试、同一清单串行写入照旧。
   缺陷 3：批量按句号改名部分失败时，成功的改名仍要更新引用；失败项保留原引用；无论成功 / 部分失败 / 抛错
           都释放忙碌标记、定时器入口不留下未处理的 Promise 拒绝、失败提示按批次汇总一条。
   用法：node scripts/candidate-regression-test.mjs */

/* ── 替换原生能力：window.native 提供存储，window.fjtHooks 提供命令替身 ── */
const calls = { review: [], tag: [], retag: [], video: [] };
const stubs = {
  review: async () => ({ ok: true }),
  tag: async () => ({ ok: true }),
  retag: async () => ({ ok: true }),
  video: async () => ({ ok: true, path: '/media/测试.mp4' }),
};

globalThis.window = {
  native: {
    isNative: () => true,
    loadData: () => null,
    dataStatus: () => ({ status: 'missing' }),
    saveData: async () => true,
    saveDataSync: () => true,
    onSegmentProgress: () => {},
  },
  fjtHooks: {
    writeCandidateReview: (file, results) => {
      calls.review.push({ file, results: structuredClone(results) });
      return stubs.review(file, results);
    },
    tagSavedClip: (path, tag) => {
      calls.tag.push({ path, tag });
      return stubs.tag(path, tag);
    },
    retagLineFile: (path, tag) => {
      calls.retag.push({ path, tag });
      return stubs.retag(path, tag);
    },
    saveVideoSegment: opts => {
      calls.video.push(opts);
      return stubs.video(opts);
    },
    probeAssets: async () => ({}),
    revealAsset: () => {},
  },
  addEventListener() {},
  removeEventListener() {},
};
globalThis.document = {};

const assert = (await import('node:assert/strict')).default;
const storage = await import('../renderer/src/app/storage.js');
const { state } = await import('../renderer/src/app/state.js');
const { on } = await import('../renderer/src/app/events.js');
const { changeProject } = await import('../renderer/src/app/project-change.js');
const { clearUndo, canUndo, undo } = await import('../renderer/src/app/undo.js');
const { writeBack, flushWriteBack, syncedFiles, writeBackFailures } =
  await import('../renderer/src/app/candidate-sync.js');
const { captureSaveTask, saveCandidateSegment, retagLineFiles, tagOldSavedClips, scheduleRetag } =
  await import('../renderer/src/app/candidate-media.js');
const { applyRemoteProject } = await import('../renderer/src/app/collab-apply.js');
const { assetName } = await import('../renderer/src/core/asset-model.js');

storage.initStorage();

/* ── 小工具 ── */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const clone = value => JSON.parse(JSON.stringify(value));
let projectNo = 0;
let unhandled = [];
process.on('unhandledRejection', reason => unhandled.push(reason));
const notices = [];
on('notify', payload => notices.push(payload));

const line = (id, no, extra = {}) => ({
  id,
  kind: 'line',
  text: `第${no}句。`,
  note: '',
  type: null,
  assetUsages: [],
  ...extra,
});
const candidate = (over = {}) => ({
  id: 'vc-测试',
  key: 'k',
  lines: '1',
  label: '画面',
  rowId: 'a1',
  title: '测试视频',
  url: 'https://example.com/a.mp4',
  page: '',
  in: 0,
  out: 10,
  best: { in: 1, out: 5 },
  license: '',
  why: '',
  forText: '1',
  forIds: ['a1'],
  seq: 0,
  short: '',
  need: '',
  limits: '',
  srcFile: '',
  decision: '',
  note: '',
  ...over,
});

/* 建一个当前项目并把它同步进库（库里的对象之后作为「后台项目」使用） */
function newProject(title, rows, { assets = {}, candidates = [] } = {}) {
  const pid = storage.createProject(`${title}-${++projectNo}`, clone(rows), clone(assets));
  if (candidates.length) state.candidates = clone(candidates);
  storage.persist(true);
  return pid;
}
const projectOf = pid => storage.projectById(pid);
const contentOf = pid => {
  const p = projectOf(pid);
  return JSON.stringify({ title: p.title, rows: p.rows, assets: p.assets, candidates: p.candidates });
};
const writesOf = file => calls.review.filter(x => x.file === file).map(x => x.results);
const failuresOf = file => writeBackFailures().filter(([f]) => f === file);

/* 等待防抖写回真正落盘（writeBack 是 500ms 防抖） */
const settle = () => sleep(620);

const A_ROWS = [
  line('a1', 1, { assetUsages: [{ assetId: 'aid', role: 'main', clip: { in: 1, out: 5 } }] }),
  line('a2', 2),
];
const A_ASSETS = { aid: { id: 'aid', kind: 'video', path: 'https://example.com/a.mp4', name: 'a.mp4' } };
const B_ROWS = [line('b1', 1), line('b2', 2)];
const A_CAND = over =>
  candidate({
    id: 'c-a',
    rowId: 'a1',
    forIds: ['a1'],
    decision: 'ok',
    assetId: 'aid',
    savedPath: '/media/A.mp4',
    ...over,
  });

/* 改名替身：按「第N句_」前缀换文件名 */
const taggedPath = (path, tag) => {
  const cut = path.lastIndexOf('/') + 1;
  const base = path.slice(cut).replace(/^第\d+(?:-\d+)?句_/, '');
  return `${path.slice(0, cut)}${tag}_${base}`;
};

/* ── 缺陷 2 用到的项目构造 ── */
function backgroundProject(file, { bAssets = {}, bCandidates = [] } = {}) {
  const pidA = newProject('后台项目 A', A_ROWS, {
    assets: A_ASSETS,
    candidates: [A_CAND({ srcFile: file })],
  });
  const pidB = newProject('当前项目 B', B_ROWS, { assets: bAssets, candidates: bCandidates });
  clearUndo();
  return { pidA, pidB };
}

/* ── 缺陷 3 用到的项目构造 ── */
const MEDIA = '/媒体目录';
const OLD1 = `${MEDIA}/第9句_甲片段.mp4`;
const OLD2 = `${MEDIA}/第9句_乙片段.mp4`;
const NEW1 = `${MEDIA}/第1句_甲片段.mp4`;
const NEW2 = `${MEDIA}/第2句_乙片段.mp4`;
const TAG_OLD1 = `${MEDIA}/甲片段.mp4`;
const TAG_OLD2 = `${MEDIA}/乙片段.mp4`;
const TAG_NEW1 = `${MEDIA}/第1句_甲片段.mp4`;
const TAG_NEW2 = `${MEDIA}/第2句_乙片段.mp4`;
const tagRows = () => [
  line('t1', 1, { assetUsages: [{ assetId: 'r1', role: 'main', clip: { in: 0, out: 2 } }] }),
  line('t2', 2, { assetUsages: [{ assetId: 'r2', role: 'main', clip: { in: 0, out: 2 } }] }),
  line('t3', 3),
];
const tagCands = file => [
  candidate({
    id: 'tc1',
    rowId: 't1',
    forIds: ['t1'],
    decision: 'ok',
    assetId: 'r1',
    savedPath: TAG_OLD1,
    srcFile: `${file}#1`,
  }),
  candidate({
    id: 'tc2',
    rowId: 't2',
    forIds: ['t2'],
    decision: 'ok',
    assetId: 'r2',
    savedPath: TAG_OLD2,
    srcFile: `${file}#2`,
  }),
];
const retagAssets = () => ({
  r1: { id: 'r1', kind: 'video', path: OLD1, name: assetName(OLD1) },
  r2: { id: 'r2', kind: 'video', path: OLD2, name: assetName(OLD2) },
});
const retagCands = file => [
  candidate({
    id: 'tc1',
    rowId: 't1',
    forIds: ['t1'],
    decision: 'ok',
    assetId: 'r1',
    savedPath: OLD1,
    srcFile: `${file}#1`,
  }),
  candidate({
    id: 'tc2',
    rowId: 't2',
    forIds: ['t2'],
    decision: 'ok',
    assetId: 'r2',
    savedPath: OLD2,
    srcFile: `${file}#2`,
  }),
];
function retagProject(file) {
  return newProject('改名项目', tagRows(), { assets: retagAssets(), candidates: retagCands(file) });
}
function tagProject(file) {
  return newProject('补句号项目', tagRows(), {
    assets: {
      r1: { id: 'r1', kind: 'video', path: TAG_OLD1, name: assetName(TAG_OLD1) },
      r2: { id: 'r2', kind: 'video', path: TAG_OLD2, name: assetName(TAG_OLD2) },
    },
    candidates: tagCands(file),
  });
}
const refsOf = pid => {
  const p = projectOf(pid);
  return {
    paths: Object.fromEntries(Object.values(p.assets).map(a => [a.id, a.path])),
    saved: Object.fromEntries((p.candidates || []).map(c => [c.id, c.savedPath])),
  };
};
const callsFor = stub => calls[stub].length;

/* ── 测试框架：逐条跑，失败不中断，最后统一退出码 ── */
const results = [];
async function test(name, fn) {
  // 同一入口的调用次数按测试各自统计
  if (name.startsWith('改名')) calls.retag.length = 0;
  if (name.startsWith('补句号')) calls.tag.length = 0;
  try {
    await fn();
    results.push({ name, ok: true });
    console.log('✓', name);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log('✗', name);
    console.log(String(error?.stack || error).replace(/^/gm, '    '));
  }
}

/* ═══════════ 缺陷 2 ═══════════ */

await test('写回：后台项目 A 的 inUse 由 A 的 rows 决定（不是当前项目 B）', async () => {
  const file = '/候选/B1.json';
  const { pidA, pidB } = backgroundProject(file);
  const beforeB = contentOf(pidB);
  writeBack(projectOf(pidA));
  await settle();
  const writes = writesOf(file);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0].inUse, true);
  assert.equal(contentOf(pidB), beforeB, 'B 项目内容不该被写回任务改动');
  assert.equal(canUndo(), false, '后台写回不进当前项目撤销栈');
});

await test('写回：当前项目恰有相同素材 ID 但没用它，仍以原项目为准', async () => {
  const file = '/候选/B2.json';
  const sameId = { aid: { id: 'aid', kind: 'video', path: '/media/B-同ID.mp4', name: 'B-同ID.mp4' } };
  const bRows = [line('b1', 1, { assetUsages: [{ assetId: 'aid', role: 'alt' }] })];
  const pidA = newProject('后台项目 A', A_ROWS, { assets: A_ASSETS, candidates: [A_CAND({ srcFile: file })] });
  newProject('当前项目 B', bRows, { assets: sameId });
  clearUndo();
  writeBack(projectOf(pidA));
  await settle();
  const writes = writesOf(file);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0].inUse, true, 'B 只是碰巧有同一个素材 ID，未在 B 上使用，不能影响 A');
  assert.equal(canUndo(), false);
});

await test('写回：原项目 A 没用该素材时，当前项目 B 用着同一素材 ID 也不能算在用', async () => {
  const file = '/候选/B3.json';
  const aRows = [line('a1', 1, { assetUsages: [{ assetId: 'aid', role: 'alt' }] }), line('a2', 2)];
  const pidA = newProject('后台项目 A', aRows, { assets: A_ASSETS, candidates: [A_CAND({ srcFile: file })] });
  const bRows = [line('b1', 1, { assetUsages: [{ assetId: 'aid', role: 'main' }] })];
  const sameId = { aid: { id: 'aid', kind: 'video', path: '/media/B-同ID.mp4', name: 'B-同ID.mp4' } };
  newProject('当前项目 B', bRows, { assets: sameId });
  clearUndo();
  writeBack(projectOf(pidA));
  await settle();
  const writes = writesOf(file);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0].inUse, false, 'A 上只是备选，B 的主画面不能把 A 的写回改成 inUse');
  assert.equal(canUndo(), false);
});

await test('写回：入队后切项目 / 改候选，不改变已排队的内容', async () => {
  const file = '/候选/B4.json';
  const { pidA, pidB } = backgroundProject(file);
  const beforeB = contentOf(pidB);
  writeBack(projectOf(pidA));
  storage.switchProject(pidA);
  state.candidates[0].note = '入队后才改的意见';
  await settle();
  const writes = writesOf(file);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0].note, '', '排队内容应在入队时定格');
  assert.equal(writes[0][0].inUse, true);
  assert.equal(contentOf(pidB), beforeB);
  assert.equal(canUndo(), false);
});

await test('后台保存片段：写回用原项目的 rows，当前项目与撤销栈不受影响', async () => {
  const file = '/候选/B5.json';
  const pidA = newProject('后台保存 A', A_ROWS, { assets: A_ASSETS });
  state.candidates = [A_CAND({ id: 'c-save', srcFile: file })];
  storage.persist(true);
  const task = captureSaveTask('c-save');
  assert.ok(task, '应能捕获保存任务');
  const pidB = newProject('当前项目 B', B_ROWS);
  clearUndo();
  const beforeB = contentOf(pidB);
  stubs.video = async () => ({ ok: true, path: '/media/A-保存.mp4' });
  const saved = await saveCandidateSegment(task, '/media');
  assert.equal(saved?.attached, true);
  await settle();
  const a = projectOf(pidA);
  assert.equal(a.candidates[0].savedPath, '/media/A-保存.mp4', '片段应记在原项目上');
  assert.equal(a.assets.aid.path, '/media/A-保存.mp4', '原项目素材路径应换成保存后的文件');
  const writes = writesOf(file);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0].inUse, true, 'A 的素材在 A 的主画面上，写回必须标在用');
  assert.equal(contentOf(pidB), beforeB, 'B 项目内容不该被后台保存改动');
  assert.equal(canUndo(), false, '后台保存不进当前项目撤销栈');
});

await test('后台协作落地：写回用被协作项目的 rows，当前项目与撤销栈不受影响', async () => {
  const file = '/候选/B6.json';
  const { pidA, pidB } = backgroundProject(file);
  const beforeB = contentOf(pidB);
  applyRemoteProject(
    { pid: pidA, peer: '对方' },
    { structural: false, assets: false, cands: true, fields: new Set(), meta: new Set(), rows: new Set(), removed: [] },
  );
  await settle();
  const writes = writesOf(file);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0].inUse, true, '协作项目 A 的主画面素材应标为在用');
  assert.equal(contentOf(pidB), beforeB);
  assert.equal(canUndo(), false);
});

await test('写回：同一清单串行写入，排队内容不受后续内存修改影响', async () => {
  const file = '/候选/B7.json';
  newProject('并发写回', A_ROWS, { assets: A_ASSETS, candidates: [A_CAND({ srcFile: file })] });
  let release;
  const seen = [];
  stubs.review = (f, results) => {
    if (f !== file) return { ok: true };
    seen.push(structuredClone(results));
    return seen.length === 1
      ? new Promise(resolve => {
          release = resolve;
        })
      : Promise.resolve({ ok: true });
  };
  const first = flushWriteBack();
  await tick();
  assert.equal(seen.length, 1, '第一次写回应已开始');
  state.candidates[0].note = '第二版';
  const second = flushWriteBack();
  await tick();
  assert.equal(seen.length, 1, '第二份内容必须等第一份写完');
  state.candidates[0].note = '未提交的临时值';
  release({ ok: true });
  await Promise.all([first, second]);
  assert.equal(seen.length, 2);
  assert.equal(seen[0][0].note, '', '第一份写的是提交时的内容');
  assert.equal(seen[1][0].note, '第二版', '第二份写的是第二次提交时的内容');
  stubs.review = async () => ({ ok: true });
});

await test('写回：失败记下来，下次重试成功后清除失败记录', async () => {
  const file = '/候选/B8.json';
  newProject('失败重试', A_ROWS, { assets: A_ASSETS, candidates: [A_CAND({ srcFile: file })] });
  stubs.review = f => (f === file ? { ok: false, error: '磁盘已满' } : { ok: true });
  await flushWriteBack();
  assert.equal(writesOf(file).length, 1);
  assert.equal(failuresOf(file).length, 1);
  assert.match(failuresOf(file)[0][1], /磁盘已满/);
  stubs.review = async () => ({ ok: true });
  await flushWriteBack();
  assert.equal(writesOf(file).length, 2, '失败过的清单下次要再写');
  assert.equal(failuresOf(file).length, 0, '写成功后清除失败记录');
});

await test('写回接口只收项目上下文，不再接受裸候选数组', () => {
  assert.throws(() => writeBack([]), TypeError);
  assert.throws(() => flushWriteBack([]), TypeError);
  assert.throws(() => syncedFiles([]), TypeError);
});

/* ═══════════ 缺陷 3：按句号自动改名 ═══════════ */

await test('改名：全部成功——素材 / 候选引用一起换成新文件名', async () => {
  const pid = retagProject('/候选/R1.json');
  stubs.retag = async (path, tag) => ({ ok: true, path: taggedPath(path, tag) });
  notices.length = 0;
  const moved = await retagLineFiles();
  assert.equal(moved, 2);
  assert.deepEqual(
    calls.retag.slice(-2).map(x => x.tag),
    ['第1句', '第2句'],
  );
  const refs = refsOf(pid);
  assert.equal(refs.paths.r1, NEW1);
  assert.equal(refs.paths.r2, NEW2);
  assert.equal(refs.saved.tc1, NEW1);
  assert.equal(refs.saved.tc2, NEW2);
  assert.equal(notices.length, 0, '全部成功不弹提示');
});

await test('改名：首项成功、次项返回 ok:false——成功项已同步，失败项保留原引用', async () => {
  const pid = retagProject('/候选/R2.json');
  stubs.retag = async (path, tag) =>
    path === OLD2 ? { ok: false, error: '没有权限' } : { ok: true, path: taggedPath(path, tag) };
  notices.length = 0;
  let moved;
  try {
    moved = await retagLineFiles();
  } catch (error) {
    assert.fail(`部分失败不该把异常抛给调用方：${error?.message || error}`);
  }
  assert.equal(moved, 1);
  const refs = refsOf(pid);
  assert.equal(refs.paths.r1, NEW1, '成功的改名必须更新引用');
  assert.equal(refs.paths.r2, OLD2, '失败项保留原引用');
  assert.equal(refs.saved.tc2, OLD2);
  assert.equal(callsFor('retag'), 2, '同一轮不重复重试失败项');
  assert.equal(notices.length, 1, '失败提示按批次汇总一条');
  assert.equal(notices[0].kind, 'warn');
  assert.match(notices[0].msg, /1/);
  // 忙碌状态已释放：下一次任务能继续处理剩下的失败项
  stubs.retag = async (path, tag) => ({ ok: true, path: taggedPath(path, tag) });
  assert.equal(await retagLineFiles(), 1);
  assert.equal(refsOf(pid).paths.r2, NEW2);
});

await test('改名：首项成功、次项抛错——异常不外泄，成功项仍已同步', async () => {
  const pid = retagProject('/候选/R3.json');
  stubs.retag = async (path, tag) => {
    if (path === OLD2) throw new Error('文件被占用');
    return { ok: true, path: taggedPath(path, tag) };
  };
  notices.length = 0;
  let moved;
  try {
    moved = await retagLineFiles();
  } catch (error) {
    assert.fail(`单项抛错不该中断整轮：${error?.message || error}`);
  }
  assert.equal(moved, 1);
  const refs = refsOf(pid);
  assert.equal(refs.paths.r1, NEW1);
  assert.equal(refs.paths.r2, OLD2);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, 'warn');
  assert.match(notices[0].msg, /文件被占用/);
});

await test('改名：全部失败——引用全部保持原样，仍只提示一条', async () => {
  const pid = retagProject('/候选/R4.json');
  stubs.retag = async () => ({ ok: false, error: '磁盘不可写' });
  notices.length = 0;
  const moved = await retagLineFiles();
  assert.equal(moved, 0);
  const refs = refsOf(pid);
  assert.equal(refs.paths.r1, OLD1);
  assert.equal(refs.paths.r2, OLD2);
  assert.equal(refs.saved.tc1, OLD1);
  assert.equal(refs.saved.tc2, OLD2);
  assert.equal(callsFor('retag'), 2, '不做无限即时重试');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, 'warn');
});

await test('改名：执行期间又收到一次请求——不并发，结束后补跑一次且下次任务可执行', async () => {
  const pid = retagProject('/候选/R5.json');
  let release;
  let count = 0;
  stubs.retag = async (path, tag) => {
    count++;
    if (count === 1)
      return new Promise(resolve => {
        release = () => resolve({ ok: true, path: taggedPath(path, tag) });
      });
    return { ok: true, path: taggedPath(path, tag) };
  };
  const first = retagLineFiles();
  await tick();
  const again = await retagLineFiles();
  assert.equal(again, 0, '执行中的重复请求只登记一次补跑');
  release();
  assert.equal(await first, 2, '第一轮把两项都处理完');
  await sleep(60); // 让补跑（plan 已空）走完并释放状态
  // 补一条新片段，验证下一次任务仍能执行（忙碌标记没有卡住）
  state.candidates.push(
    candidate({
      id: 'tc3',
      rowId: 't3',
      forIds: ['t3'],
      decision: 'ok',
      savedPath: '/媒体目录/第9句_丙片段.mp4',
      srcFile: '/候选/R5.json#3',
    }),
  );
  stubs.retag = async (path, tag) => ({ ok: true, path: taggedPath(path, tag) });
  assert.equal(await retagLineFiles(), 1, '下一轮仍能执行');
  assert.equal(state.candidates.find(c => c.id === 'tc3').savedPath, '/媒体目录/第3句_丙片段.mp4');
  assert.equal(refsOf(pid).paths.r1, NEW1);
});

await test('改名：定时器入口不留下未处理的 Promise 拒绝', async () => {
  retagProject('/候选/R7.json');
  stubs.retag = async path => {
    if (path === OLD2) throw new Error('定时任务里的失败');
    return { ok: true, path: taggedPath(path, '第1句') };
  };
  unhandled = [];
  scheduleRetag(0);
  await sleep(150);
  assert.deepEqual(unhandled, [], '定时改名失败不能变成未处理的 Promise 拒绝');
});

await test('改名：跨项目共享同一路径时两个项目的引用都更新，撤销历史里的路径也同步', async () => {
  const old = `${MEDIA}/第9句_共享片段.mp4`;
  const sharedRow = () => [line('t1', 1, { assetUsages: [{ assetId: 'rx', role: 'main', clip: { in: 0, out: 2 } }] })];
  const pidA = newProject('跨项目 A', sharedRow(), {
    assets: { rx: { id: 'rx', kind: 'video', path: old, name: assetName(old) } },
    candidates: [
      candidate({
        id: 'shared-a',
        rowId: 't1',
        forIds: ['t1'],
        decision: 'ok',
        assetId: 'rx',
        savedPath: old,
        srcFile: '/候选/R6A.json',
      }),
    ],
  });
  state.assets = { ry: { id: 'ry', kind: 'video', path: old, name: assetName(old) } };
  state.candidates = [
    candidate({
      id: 'shared-b',
      rowId: 't1',
      forIds: ['t1'],
      decision: 'ok',
      assetId: 'ry',
      savedPath: old,
      srcFile: '/候选/R6B.json',
    }),
  ];
  const pidB = storage.createProject('跨项目 B', sharedRow(), {});
  state.assets = { ry: { id: 'ry', kind: 'video', path: old, name: assetName(old) } };
  state.candidates = [
    candidate({
      id: 'shared-b',
      rowId: 't1',
      forIds: ['t1'],
      decision: 'ok',
      assetId: 'ry',
      savedPath: old,
      srcFile: '/候选/R6B.json',
    }),
  ];
  storage.persist(true);
  storage.switchProject(pidA);
  clearUndo();
  changeProject('改备注', () => {
    state.rows[0].note = '待撤销';
  });
  assert.equal(canUndo(), true);
  stubs.retag = async (path, tag) => ({ ok: true, path: taggedPath(path, tag) });
  const moved = await retagLineFiles();
  assert.equal(moved, 1);
  const next = taggedPath(old, '第1句');
  assert.equal(refsOf(pidA).paths.rx, next);
  assert.equal(refsOf(pidA).saved['shared-a'], next);
  assert.equal(refsOf(pidB).paths.ry, next, '另一个项目的素材路径也要跟着改');
  assert.equal(refsOf(pidB).saved['shared-b'], next, '另一个项目的候选引用也要跟着改');
  undo();
  assert.equal(state.assets.rx.path, next, '撤销历史里的旧路径也要同步成改名后的路径');
  assert.equal(state.candidates.find(c => c.id === 'shared-a').savedPath, next);
});

await test('补句号：全部成功——素材 / 候选引用一起换成新文件名', async () => {
  const pid = tagProject('/候选/T1.json');
  stubs.tag = async (path, tag) => ({ ok: true, path: taggedPath(path, tag) });
  notices.length = 0;
  const tagged = await tagOldSavedClips();
  assert.equal(tagged, 2);
  const refs = refsOf(pid);
  assert.equal(refs.paths.r1, TAG_NEW1);
  assert.equal(refs.paths.r2, TAG_NEW2);
  assert.equal(refs.saved.tc1, TAG_NEW1);
  assert.equal(refs.saved.tc2, TAG_NEW2);
  assert.equal(notices.length, 1, '成功提示沿用原有一条');
  assert.equal(notices[0].kind, 'ok');
});

await test('补句号：首项成功、次项返回 ok:false——成功项已同步，失败项保留', async () => {
  const pid = tagProject('/候选/T2.json');
  stubs.tag = async (path, tag) =>
    path === TAG_OLD2 ? { ok: false, error: '没有权限' } : { ok: true, path: taggedPath(path, tag) };
  notices.length = 0;
  let tagged;
  try {
    tagged = await tagOldSavedClips();
  } catch (error) {
    assert.fail(`部分失败不该把异常抛给调用方：${error?.message || error}`);
  }
  assert.equal(tagged, 1);
  const refs = refsOf(pid);
  assert.equal(refs.paths.r1, TAG_NEW1);
  assert.equal(refs.paths.r2, TAG_OLD2);
  assert.equal(refs.saved.tc2, TAG_OLD2);
  assert.equal(callsFor('tag'), 2, '同一轮不重复重试失败项');
  assert.equal(notices.length, 1, '失败提示按批次汇总一条');
  assert.equal(notices[0].kind, 'warn');
  stubs.tag = async (path, tag) => ({ ok: true, path: taggedPath(path, tag) });
  assert.equal(await tagOldSavedClips(), 1, '忙碌状态已释放，下一次任务可执行');
  assert.equal(refsOf(pid).paths.r2, TAG_NEW2);
});

await test('补句号：首项成功、次项抛错——异常不外泄，成功项仍已同步', async () => {
  const pid = tagProject('/候选/T3.json');
  stubs.tag = async (path, tag) => {
    if (path === TAG_OLD2) throw new Error('文件被占用');
    return { ok: true, path: taggedPath(path, tag) };
  };
  notices.length = 0;
  let tagged;
  try {
    tagged = await tagOldSavedClips();
  } catch (error) {
    assert.fail(`单项抛错不该中断整轮：${error?.message || error}`);
  }
  assert.equal(tagged, 1);
  const refs = refsOf(pid);
  assert.equal(refs.paths.r1, TAG_NEW1);
  assert.equal(refs.paths.r2, TAG_OLD2);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, 'warn');
  assert.match(notices[0].msg, /文件被占用/);
});

await test('补句号：全部失败——引用全部保持原样，仍只提示一条', async () => {
  const pid = tagProject('/候选/T4.json');
  stubs.tag = async () => ({ ok: false, error: '磁盘不可写' });
  notices.length = 0;
  const tagged = await tagOldSavedClips();
  assert.equal(tagged, 0);
  const refs = refsOf(pid);
  assert.equal(refs.paths.r1, TAG_OLD1);
  assert.equal(refs.paths.r2, TAG_OLD2);
  assert.equal(refs.saved.tc1, TAG_OLD1);
  assert.equal(refs.saved.tc2, TAG_OLD2);
  assert.equal(callsFor('tag'), 2);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, 'warn');
});

await test('补句号：执行期间又收到一次请求——复用同一轮，结束后下次任务可执行', async () => {
  tagProject('/候选/T5.json');
  let release;
  let count = 0;
  stubs.tag = async (path, tag) => {
    count++;
    if (count === 1)
      return new Promise(resolve => {
        release = () => resolve({ ok: true, path: taggedPath(path, tag) });
      });
    return { ok: true, path: taggedPath(path, tag) };
  };
  const first = tagOldSavedClips();
  await tick();
  const again = tagOldSavedClips();
  assert.equal(again, first, '执行中的重复请求应复用同一轮，不并发');
  release();
  assert.equal(await first, 2);
  unhandled = [];
  await sleep(80); // 补跑的 tidySavedClips 不能留下未处理的拒绝
  assert.deepEqual(unhandled, []);
  state.candidates.push(
    candidate({
      id: 'tc3',
      rowId: 't3',
      forIds: ['t3'],
      decision: 'ok',
      savedPath: '/媒体目录/丙片段.mp4',
      srcFile: '/候选/T5.json#3',
    }),
  );
  stubs.tag = async (path, tag) => ({ ok: true, path: taggedPath(path, tag) });
  assert.equal(await tagOldSavedClips(), 1, '下一轮仍能执行');
  assert.equal(state.candidates.find(c => c.id === 'tc3').savedPath, '/媒体目录/第3句_丙片段.mp4');
});

await test('补句号：跨项目共享同一路径时两个项目的引用都更新，撤销历史里的路径也同步', async () => {
  const old = `${MEDIA}/共享片段.mp4`;
  const sharedRow = () => [line('t1', 1, { assetUsages: [{ assetId: 'rx', role: 'main', clip: { in: 0, out: 2 } }] })];
  const pidA = newProject('补句号跨项目 A', sharedRow(), {
    assets: { rx: { id: 'rx', kind: 'video', path: old, name: assetName(old) } },
    candidates: [
      candidate({
        id: 'shared-a',
        rowId: 't1',
        forIds: ['t1'],
        decision: 'ok',
        assetId: 'rx',
        savedPath: old,
        srcFile: '/候选/T6A.json',
      }),
    ],
  });
  const pidB = storage.createProject('补句号跨项目 B', sharedRow(), {});
  state.assets = { ry: { id: 'ry', kind: 'video', path: old, name: assetName(old) } };
  state.candidates = [
    candidate({
      id: 'shared-b',
      rowId: 't1',
      forIds: ['t1'],
      decision: 'ok',
      assetId: 'ry',
      savedPath: old,
      srcFile: '/候选/T6B.json',
    }),
  ];
  storage.persist(true);
  storage.switchProject(pidA);
  clearUndo();
  changeProject('改备注', () => {
    state.rows[0].note = '待撤销';
  });
  stubs.tag = async (path, tag) => ({ ok: true, path: taggedPath(path, tag) });
  assert.equal(await tagOldSavedClips(), 1);
  const next = taggedPath(old, '第1句');
  assert.equal(refsOf(pidA).paths.rx, next);
  assert.equal(refsOf(pidA).saved['shared-a'], next);
  assert.equal(refsOf(pidB).paths.ry, next);
  assert.equal(refsOf(pidB).saved['shared-b'], next);
  undo();
  assert.equal(state.assets.rx.path, next);
  assert.equal(state.candidates.find(c => c.id === 'shared-a').savedPath, next);
});

/* ── 收尾 ── */
await sleep(80);
await test('全程没有未处理的 Promise 拒绝', () => {
  assert.deepEqual(unhandled, []);
});

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log('失败：');
  for (const f of failed) console.log('  ✗', f.name);
  process.exit(1);
}
process.exit(0);
