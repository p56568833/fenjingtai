/* 数据安全回归（不需要 Electron）：损坏原件没能改名 / 复制保留时，主进程必须拒绝一切写入，
   渲染层不把示例库当成首次启动自动保存，也不显示「已保存」。
   覆盖：无备份、有可读备份、原件成功保留后恢复写入、正常首次启动仍自动落盘。
   运行：node scripts/data-safety-test.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createStore } = require('../electron/data-store.js');

let passed = 0;
const failures = [];
const test = (name, fn) => {
  try {
    fn();
    passed++;
    console.log('✓', name);
  } catch (error) {
    failures.push({ name, error });
    console.log('✗', name, '\n   ', error.message.split('\n').join('\n    '));
  }
};
const atest = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log('✓', name);
  } catch (error) {
    failures.push({ name, error });
    console.log('✗', name, '\n   ', error.message.split('\n').join('\n    '));
  }
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), '分镜台数据安全测试-'));
const lib = title => ({ v: 2, currentId: 'p1', projects: { p1: { id: 'p1', title, rows: [], updatedAt: 1 } } });
const CORRUPT = '{"v":2,"projects":{"p1":{"id":"p1","title":"坏掉的';
const LIBRARY_NAME = '分镜台数据.json';

/* 用延时替换模拟「改名失败、复制失败」：只让 rename/copy 失败，原子写仍能落盘。
   这正是故障链：保护失败后旧实现仍允许 savePatch 覆盖原路径。 */
function breakPreserve() {
  const originals = { renameSync: fs.renameSync, copyFileSync: fs.copyFileSync };
  fs.renameSync = () => {
    const error = new Error('EPERM: operation not permitted, rename');
    error.code = 'EPERM';
    throw error;
  };
  fs.copyFileSync = () => {
    const error = new Error('EACCES: permission denied, copyfile');
    error.code = 'EACCES';
    throw error;
  };
  return () => {
    fs.renameSync = originals.renameSync;
    fs.copyFileSync = originals.copyFileSync;
  };
}
const writeBlockedInfo = info => {
  assert.equal(info?.writeBlocked, true, `info().writeBlocked 应为 true：${JSON.stringify(info)}`);
  assert.ok(!/已改名|已保留为|另存为/.test(info.error || ''), `错误信息不能声称原件已保留：${info.error}`);
  assert.ok(!info.kept, `没有保留成功时不能给出 kept 文件名：${JSON.stringify(info.kept)}`);
};
const assertBlockedSave = (store, label) => {
  assert.throws(
    () => store.save(lib(label)),
    error => error?.code === 'DATA_WRITE_BLOCKED' || /停止写入|不能写入|拒绝写入/.test(error?.message || ''),
    'save() 必须拒绝覆盖',
  );
  assert.throws(
    () => store.savePatch({ currentId: 'p1', projects: { p1: { id: 'p1', title: label, rows: [], updatedAt: 2 } } }),
    error => error?.code === 'DATA_WRITE_BLOCKED' || /停止写入|不能写入|拒绝写入/.test(error?.message || ''),
    '增量 savePatch() 必须拒绝覆盖',
  );
  assert.throws(
    () => store.savePatch({ full: lib(label) }),
    error => error?.code === 'DATA_WRITE_BLOCKED' || /停止写入|不能写入|拒绝写入/.test(error?.message || ''),
    '全量 savePatch() 必须拒绝覆盖',
  );
};

/* ── 主进程：没有备份，原件读取损坏且没能保留 ── */
test('主进程/无备份：原件损坏且改名、复制都失败 → 建立写保护，所有保存入口拒绝覆盖', () => {
  const dir = tmp();
  const file = path.join(dir, LIBRARY_NAME);
  fs.writeFileSync(file, CORRUPT, 'utf8');
  const store = createStore(() => dir);
  const restore = breakPreserve();
  try {
    assert.equal(store.load(), null);
    writeBlockedInfo(store.info());
    assert.equal(store.info().status, 'corrupt');
    assertBlockedSave(store, '覆盖尝试');
    assert.equal(fs.readFileSync(file, 'utf8'), CORRUPT, '原文件字节不能被改动');
    // 再次读取 / 重新 load 不能悄悄解除保护
    assert.equal(store.load(), null);
    writeBlockedInfo(store.info());
    assertBlockedSave(store, '再次覆盖');
  } finally {
    restore();
  }
  // 确认原件已安全保留后（显式操作）才解除
  assert.equal(typeof store.retryPreserve, 'function', '应提供显式重试保留的入口');
  assert.equal(store.retryPreserve(), true);
  assert.equal(store.info().writeBlocked, false);
  assert.ok(store.info().kept, '保留成功后应给出实际的文件名');
  const keptPath = path.join(dir, store.info().kept);
  assert.equal(fs.readFileSync(keptPath, 'utf8'), CORRUPT, '保留的副本必须与原字节一致');
  store.save(lib('保留后写入'));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).projects.p1.title, '保留后写入');
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ── 主进程：有可读备份，但原件没能保留 ── */
test('主进程/有可读备份：原件没能保留时不能用备份恢复后覆盖原路径', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, '自动备份'), { recursive: true });
  fs.writeFileSync(path.join(dir, '自动备份', '备份-2026-10-01 10-00-00.json'), JSON.stringify(lib('可读备份')));
  const file = path.join(dir, LIBRARY_NAME);
  fs.writeFileSync(file, CORRUPT, 'utf8');
  const store = createStore(() => dir);
  const restore = breakPreserve();
  try {
    assert.equal(store.load(), null, '原件没能保留时不得用备份恢复并覆盖');
    writeBlockedInfo(store.info());
    assert.equal(store.info().status, 'corrupt');
    assertBlockedSave(store, '备份场景');
    assert.equal(fs.readFileSync(file, 'utf8'), CORRUPT, '原文件字节不能被改动');
    assert.equal(
      fs.readFileSync(path.join(dir, '自动备份', '备份-2026-10-01 10-00-00.json'), 'utf8'),
      JSON.stringify(lib('可读备份')),
      '备份不能被改动',
    );
  } finally {
    restore();
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ── 主进程：原件成功保留后仍可恢复、保存（原有行为） ── */
test('主进程/保留成功：改名保留损坏原件后照常恢复备份并保存', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, '自动备份'), { recursive: true });
  fs.writeFileSync(path.join(dir, '自动备份', '备份-2026-10-01 10-00-00.json'), JSON.stringify(lib('可读备份')));
  fs.writeFileSync(path.join(dir, LIBRARY_NAME), CORRUPT, 'utf8');
  const store = createStore(() => dir);
  assert.equal(store.load().projects.p1.title, '可读备份');
  assert.equal(store.info().status, 'recovered');
  assert.equal(store.info().writeBlocked, false);
  const kept = fs.readdirSync(dir).find(f => f.startsWith('分镜台数据.损坏-'));
  assert.equal(fs.readFileSync(path.join(dir, kept), 'utf8'), CORRUPT);
  store.save(lib('照常保存'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, LIBRARY_NAME), 'utf8')).projects.p1.title, '照常保存');
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ── 渲染层：主进程报告写保护时，不把示例库当成首次启动自动保存 ── */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const installDomStub = () => {
  globalThis.window = {
    native: null,
    fjtHooks: null,
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.document = {
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
};

async function bootStorage(tag, native) {
  installDomStub();
  globalThis.window.native = native;
  // 每个场景独立一份 storage 模块状态（相对导入仍然共享 state / events）
  return import(`../renderer/src/app/storage.js?scenario=${tag}`);
}

await atest('渲染层/写保护：损坏且未能保留时不自动保存示例，不显示已保存', async () => {
  const saves = [];
  const syncSaves = [];
  const phases = [];
  const storage = await bootStorage('blocked', {
    isNative: () => true,
    loadData: () => null,
    dataStatus: () => ({
      status: 'corrupt',
      kept: '',
      error: '损坏的数据文件没能改名或复制保留，原文件仍在原位置；已停止写入',
      writeBlocked: true,
    }),
    saveData: async patch => {
      saves.push(patch);
      return true;
    },
    saveDataSync: patch => {
      syncSaves.push(patch);
      return true;
    },
  });
  const { on } = await import('../renderer/src/app/events.js');
  const off = on('save-state', phase => phases.push(phase));
  try {
    const fresh = storage.initStorage();
    assert.equal(fresh, false, '写保护下的损坏数据不能被当成首次启动');
    assert.equal(storage.dataLoadInfo().writeBlocked, true, '渲染层要能看到写保护状态');
    // 界面仍有内容可看，但不得落盘
    assert.ok(storage.current()?.rows?.length > 0, '写保护时内存里仍应装载示例稿供查看');
    await sleep(700);
    assert.equal(saves.length, 0, '写保护时不得自动保存示例库');
    assert.equal(syncSaves.length, 0);
    storage.persist(true);
    await sleep(700);
    assert.equal(saves.length, 0, 'persist() 也不能绕过写保护');
    assert.ok(phases.includes('blocked'), `保存状态要明确显示写保护：${phases.join(',')}`);
    assert.ok(!phases.includes('saved'), `不得显示已保存：${phases.join(',')}`);
  } finally {
    off();
  }
});

await atest('渲染层/正常首次启动：没有数据文件时仍自动保存示例库', async () => {
  const saves = [];
  const storage = await bootStorage('fresh', {
    isNative: () => true,
    loadData: () => null,
    dataStatus: () => ({ status: 'missing' }),
    saveData: async patch => {
      saves.push(patch);
      return true;
    },
    saveDataSync: () => true,
  });
  assert.equal(storage.initStorage(), true);
  await sleep(700);
  assert.ok(saves.length >= 1, '正常首次启动必须照常落盘示例库');
});

await atest('渲染层/原件已保留：损坏但保留成功时照常可写', async () => {
  const saves = [];
  const storage = await bootStorage('preserved', {
    isNative: () => true,
    loadData: () => null,
    dataStatus: () => ({ status: 'corrupt', kept: '分镜台数据.损坏-2026-10-01 10-00-00.json', writeBlocked: false }),
    saveData: async patch => {
      saves.push(patch);
      return true;
    },
    saveDataSync: () => true,
  });
  assert.equal(storage.initStorage(), false);
  await sleep(700);
  assert.ok(saves.length >= 1, '原件已安全保留后应恢复可写');
});

if (failures.length) {
  console.log(`\n数据安全回归：${passed} 通过，${failures.length} 失败`);
  for (const { name, error } of failures)
    console.log(`  ✗ ${name}\n${String(error.stack || error).replace(/^/gm, '    ')}`);
  process.exit(1);
}
console.log(`\n数据安全回归：${passed} 项全部通过`);
void ROOT;
