/* 局域网协作的通道：开 / 关共享、找局域网里的主机、连接、收发消息。消息内容由界面进程解释 */
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCollabNet } = require('./collab-net');
const { fingerprint, findByContent } = require('./file-match');
const { safeFileName } = require('./fs-utils');
const { segmentFileBase } = require('./video-tools');

/* 这台电脑在「系统设置 → 通用 → 共享」里的名字（取不到就用主机名） */
function machineName() {
  return new Promise(resolve =>
    execFile('/usr/sbin/scutil', ['--get', 'ComputerName'], { timeout: 2000 }, (err, out) => {
      const name = !err && String(out || '').trim();
      resolve(name || os.hostname().replace(/\.local$/, ''));
    }),
  );
}

function registerCollabIpc({ handle, win, app }) {
  const send = evt => {
    const w = win();
    if (w && !w.isDestroyed()) w.webContents.send('collab:event', evt);
  };
  const collab = createCollabNet({ emit: send });
  const text = v => String(v ?? '').slice(0, 200);
  const parsePort = port => {
    if (port == null || port === '') return { ok: true, port: undefined };
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return { ok: false, error: '端口无效' };
    return { ok: true, port: n };
  };
  const validAbsPath = p => typeof p === 'string' && !!p && path.isAbsolute(p) && !p.split(/[\\/]/).includes('..');
  // 视频片段从对方电脑拷来时，和从网站截取的用同一套文件名（名字_入点-出点.mp4）
  const fileName = req =>
    req?.segment ? `${segmentFileBase(req.segment.name, req.segment.start, req.segment.end)}.mp4` : text(req?.name);
  const announcement = info => ({
    proto: Number(info?.proto) || 1,
    version: app.getVersion(),
    hostId: text(info?.hostId),
    name: text(info?.name),
    shares: (Array.isArray(info?.shares) ? info.shares : []).map(s => ({ id: text(s?.id), title: text(s?.title) })),
  });
  handle('collab:machine', () => machineName());
  handle('collab:host-start', async (_e, info) => {
    try {
      return { ok: true, ...(await collab.startHost(announcement(info))) };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  });
  handle('collab:host-update', (_e, info) => collab.updateHost(announcement(info)));
  handle('collab:host-stop', () => collab.stopHost());
  handle('collab:discover', async (_e, on) => {
    if (!on) return collab.stopDiscovery();
    const ok = await collab.startDiscovery();
    return { ok, hosts: collab.hosts() };
  });
  handle('collab:connect', (_e, target) => {
    const p = parsePort(target?.port);
    if (!p.ok) return { error: p.error };
    return collab.connect({ address: text(target?.address), port: p.port });
  });
  handle('collab:send', (_e, id, msg) => collab.send(String(id), msg));
  handle('collab:close', (_e, id) => collab.close(String(id)));
  handle('collab:addresses', () => collab.addresses());
  // 传文件：界面进程先确认这个文件确实是共享项目里的素材 / 口播，才登记给对方取
  handle('collab:file-offer', (_e, token, file) => {
    if (!validAbsPath(file)) return { error: '文件路径无效' };
    return collab.offerFile(text(token), file);
  });
  handle('collab:file-fetch', (_e, req) => {
    const p = parsePort(req?.port);
    if (!p.ok) return { error: p.error };
    if (!validAbsPath(req?.dir)) return { error: '保存目录无效' };
    return collab.fetchFile({
      address: text(req?.address),
      port: p.port,
      token: text(req?.token),
      dir: req.dir,
      name: fileName(req),
    });
  });
  handle('collab:file-expect', (_e, req) => {
    if (!validAbsPath(req?.dir)) return { error: '保存目录无效' };
    return collab.expectFile({ token: text(req?.token), dir: req.dir, name: fileName(req) });
  });
  handle('collab:file-push', (_e, req) => {
    const p = parsePort(req?.port);
    if (!p.ok) return { error: p.error };
    if (!validAbsPath(req?.file)) return { error: '文件路径无效' };
    return collab.pushFile({
      address: text(req?.address),
      port: p.port,
      token: text(req?.token),
      file: req.file,
    });
  });
  handle('collab:file-cancel', (_e, token) => collab.cancelFile(text(token)));
  // 按内容认文件：界面进程同样先确认是共享项目里的素材 / 口播，才把指纹告诉对方
  handle('collab:file-info', async (_e, file) => {
    if (!validAbsPath(file)) return { ok: false };
    try {
      return { ok: true, ...(await fingerprint(file)) };
    } catch {
      return { ok: false };
    }
  });
  const finds = new Map(); // token → 是否已取消
  handle('collab:find-files', async (_e, req) => {
    const token = text(req?.token);
    finds.set(token, false);
    try {
      const wants = (Array.isArray(req?.wants) ? req.wants : []).map(w => ({
        size: Number(w?.size),
        fp: text(w?.fp),
      }));
      const dirs = (Array.isArray(req?.dirs) ? req.dirs : []).filter(validAbsPath);
      return await findByContent({
        dirs,
        wants,
        isCanceled: () => finds.get(token) === true,
        onProgress: scanned => send({ type: 'find-progress', token, scanned }),
      });
    } finally {
      finds.delete(token);
    }
  });
  handle('collab:find-cancel', (_e, token) => {
    if (finds.has(text(token))) finds.set(text(token), true);
  });
  handle('collab:cache-dir', (_e, projectId) => {
    const dir = path.join(app.getPath('userData'), '候选缓存', safeFileName(String(projectId || 'default'), 'default'));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  });
  // 保存失败可能取消退出；等窗口确实关闭后才断开协作。
  app.on('will-quit', () => collab.dispose());
}

module.exports = { registerCollabIpc };
