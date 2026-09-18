/* 一条命令跑完自测：起隐藏的 Electron → 轮询 9222 就绪 → 读结果 → 杀干净进程。
   用法：npm test。窗口不弹到用户面前、进程自动清理、失败退出码非 0（以前要手动起实例 + read-selftest.mjs 两步）。 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tryPort = () => new Promise(res => {
  const s = net.connect(9222, '127.0.0.1');
  s.on('connect', () => { s.destroy(); res(true); });
  s.on('error', () => res(false));
});

/* detached 建独立进程组，收尾时整组杀掉——.bin/electron 只是包装脚本，直接 kill 会留下孤儿 Electron */
const child = spawn(path.join(ROOT, 'node_modules', '.bin', 'electron'), ['.', '--selftest'], {
  cwd: ROOT, stdio: 'ignore', detached: true,
});
const killAll = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); } };

let portUp = false;
for(let i = 0; i < 80 && child.exitCode === null; i++){ portUp = await tryPort(); if(portUp) break; await sleep(150); }
if(!portUp){ console.error('测试启动失败：9222 端口不通（Electron 没起来）'); killAll(); process.exit(1); }

try{
  const b = await puppeteer.connect({ browserURL: 'http://localhost:9222', defaultViewport: null });
  const page = (await b.pages()).find(p => p.url().includes('renderer/index.html'));
  if(!page) throw new Error('没找到自测页面');
  let result = null;
  for(let i = 0; i < 80 && !result; i++){ result = await page.evaluate(() => window.__SELFTEST_RESULT__ || null); if(!result) await sleep(250); }
  if(!result) throw new Error('自测 20 秒内没跑完');
  const line = (ok, name, detail) => `${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`;
  console.log(`\n自测结果：${result.total - result.failed}/${result.total} 通过\n`);
  for(const c of result.cases) console.log(line(c.ok, c.name, c.ok ? '' : c.detail));
  process.exitCode = result.failed ? 1 : 0;
  await b.disconnect();
}catch(e){
  console.error('SELFTEST_FAIL:', e.message);
  process.exitCode = 1;
}finally{
  killAll();
}
