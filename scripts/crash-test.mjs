/* 限量崩溃记录回归：用隔离目录，不碰用户数据或让正式应用崩溃。 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createCrashLog, monitorCrashes, errorInfo, MAX_BYTES, MAX_RECORDS } = require('../electron/crash-log');
const root = fs.mkdtempSync(path.join(os.tmpdir(), '分镜台崩溃自测-'));
let count = 0;
function test(name, fn) {
  fn();
  count++;
  console.log('✓', name);
}
const make = (name, extra = {}) => createCrashLog({ dir: path.join(root, name), version: '2.0.3', ...extra });
try {
  test('连续启动和正常退出不误报，取消退出仍保留运行标记', () => {
    const log = make('正常');
    const app = new EventEmitter();
    monitorCrashes({ app, log, processEvents: new EventEmitter() });
    log.start();
    app.emit('before-quit');
    assert.ok(fs.existsSync(path.join(root, '正常', '运行状态.json')));
    app.emit('quit', {}, 0);
    const next = make('正常');
    next.start();
    assert.equal(next.list().records.length, 0);
    next.finish();
  });
  test('来不及记录的突然退出，下次启动补记原版本且只补一次', () => {
    make('突然退出', { version: '2.0.2' }).start();
    const next = make('突然退出');
    next.start();
    assert.equal(next.list().records.length, 1);
    assert.equal(next.list().records[0].kind, 'abnormal-exit');
    assert.equal(next.list().records[0].version, '2.0.2');
    assert.match(next.list().records[0].message, /强制退出或断电/);
    next.finish();
    const third = make('突然退出');
    third.start();
    assert.equal(third.list().records.length, 1);
  });
  test('同一异常一万次只写一条，不同异常风暴最多十条，并为致命异常留位置', () => {
    let now = Date.now();
    const log = make('风暴', { now: () => now });
    log.start();
    for (let i = 0; i < 10000; i++) log.record('renderer-error', { message: '重复异常' });
    assert.equal(log.list().records.length, 1);
    for (let i = 0; i < 10000; i++) log.record('renderer-error', { message: String(i) });
    assert.equal(log.list().records.length, 10);
    assert.ok(log.record('main-exception', { message: '致命错误' }, { fatal: true }));
    assert.equal(log.list().records.length, 11);
    assert.equal(log.record('main-exception', { message: '另一致命错误' }, { fatal: true }), false);
    now += 61000;
    assert.ok(log.record('renderer-error', { message: '新的异常' }));
    const next = make('风暴');
    next.start();
    assert.equal(
      next.list().records.some(r => r.kind === 'abnormal-exit'),
      false,
      '已记下的致命异常不再补一条',
    );
  });
  test('跨启动只保留最新二十条，超长中文和转义内容仍遵守文件容量', () => {
    let now = Date.now();
    let log = make('容量', { now: () => now });
    log.start();
    for (let i = 0; i < 60; i++) {
      now += 61000;
      log.record('renderer-error', { message: String(i) });
    }
    assert.equal(log.list().records.length, MAX_RECORDS);
    assert.equal(log.list().records.at(-1).message, '40');
    log.finish();
    log = make('容量', { now: () => now });
    log.start();
    assert.equal(log.list().records.length, MAX_RECORDS);
    for (let i = 0; i < 60; i++) {
      now += 61000;
      log.record('renderer-error', { message: `${i}\0${'中文\0'.repeat(10000)}`, stack: '\0'.repeat(100000) });
    }
    assert.ok(log.list().records.length <= MAX_RECORDS);
    assert.ok(fs.statSync(path.join(root, '容量', '崩溃记录.json')).size <= MAX_BYTES);
    assert.ok(log.list().records[0].message.startsWith('59'));
    assert.equal(log.clear().ok, true);
    assert.deepEqual(log.list().records, []);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '容量', '崩溃记录.json'))), []);
  });
  test('界面与辅助进程异常有记录，正常进程退出忽略，观察异常不添加吞错处理器', () => {
    const app = new EventEmitter();
    const proc = new EventEmitter();
    const log = make('事件');
    log.start();
    monitorCrashes({ app, log, processEvents: proc });
    app.emit('render-process-gone', {}, {}, { reason: 'clean-exit', exitCode: 0 });
    app.emit('child-process-gone', {}, { reason: 'normal-exit', type: 'GPU', exitCode: 0 });
    assert.equal(log.list().records.length, 0);
    app.emit('render-process-gone', {}, {}, { reason: 'oom', exitCode: 9 });
    app.emit('child-process-gone', {}, { reason: 'crashed', type: 'GPU', exitCode: 1 });
    proc.emit('unhandledRejection', new Error('任务异常'));
    proc.emit('uncaughtExceptionMonitor', new Error('致命异常'), 'uncaughtException');
    assert.equal(proc.listenerCount('uncaughtException'), 0);
    assert.deepEqual(
      new Set(log.list().records.map(r => r.kind)),
      new Set(['main-exception', 'main-rejection', 'renderer-crash', 'child-crash']),
    );
    assert.match(log.list().records[0].stack, /致命异常/);
  });
  test('主进程真的遇到未捕获异常，退出前同步落盘并保留原退出行为', () => {
    const dir = path.join(root, '真实异常');
    const module = require.resolve('../electron/crash-log');
    const source = `const {createCrashLog,monitorCrashes}=require(${JSON.stringify(module)}); const {EventEmitter}=require('node:events'); const log=createCrashLog({dir:${JSON.stringify(dir)},version:'2.0.3'}); log.start(); monitorCrashes({app:new EventEmitter(),log}); setImmediate(()=>{throw new Error('隔离进程致命异常')});`;
    assert.throws(
      () => execFileSync(process.execPath, ['-e', source], { stdio: 'pipe' }),
      e => e.status === 1,
    );
    const records = JSON.parse(fs.readFileSync(path.join(dir, '崩溃记录.json')));
    assert.equal(records[0].kind, 'main-exception');
    assert.match(records[0].stack, /隔离进程致命异常/);
  });
  test('日志目录不可写或损坏不会抛错，残留临时日志启动时清理', () => {
    const dir = path.join(root, '坏目录');
    fs.writeFileSync(dir, '这是文件');
    const bad = make('坏目录');
    assert.doesNotThrow(() => bad.start());
    assert.equal(bad.record('error', { message: 'x' }), false);
    assert.equal(bad.clear().ok, false);
    assert.doesNotThrow(() => bad.finish());
    assert.ok(bad.list().error);
    assert.doesNotThrow(() =>
      errorInfo({
        get message() {
          throw new Error('坏对象');
        },
      }),
    );
    const logDir = path.join(root, '损坏');
    fs.mkdirSync(logDir);
    fs.writeFileSync(path.join(logDir, '崩溃记录.json'), '{损坏的 JSON');
    fs.writeFileSync(path.join(logDir, '崩溃记录.json.tmp'), '未写完');
    const log = make('损坏');
    log.start();
    assert.ok(log.list().error);
    assert.equal(fs.existsSync(path.join(logDir, '崩溃记录.json.tmp')), false);
    assert.ok(log.record('error', { message: '恢复记录' }));
    assert.equal(log.list().error, '');
  });
  console.log(`崩溃记录检查通过：${count} 项`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
