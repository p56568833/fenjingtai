/* 局域网协作的通道：开 / 关共享、找局域网里的主机、连接、收发消息。消息内容由界面进程解释 */
const { execFile } = require('node:child_process');
const os = require('node:os');
const { createCollabNet } = require('./collab-net');
const { fingerprint, findByContent } = require('./file-match');

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
  handle('collab:connect', (_e, target) => collab.connect({ address: text(target?.address), port: target?.port }));
  handle('collab:send', (_e, id, msg) => collab.send(String(id), msg));
  handle('collab:close', (_e, id) => collab.close(String(id)));
  handle('collab:addresses', () => collab.addresses());
  // 传文件：界面进程先确认这个文件确实是共享项目里的素材 / 口播，才登记给对方取
  handle('collab:file-offer', (_e, token, file) => collab.offerFile(text(token), String(file || '')));
  handle('collab:file-fetch', (_e, req) =>
    collab.fetchFile({
      address: text(req?.address),
      port: req?.port,
      token: text(req?.token),
      dir: String(req?.dir || ''),
      name: text(req?.name),
    }),
  );
  handle('collab:file-expect', (_e, req) =>
    collab.expectFile({ token: text(req?.token), dir: String(req?.dir || ''), name: text(req?.name) }),
  );
  handle('collab:file-push', (_e, req) =>
    collab.pushFile({
      address: text(req?.address),
      port: req?.port,
      token: text(req?.token),
      file: String(req?.file || ''),
    }),
  );
  handle('collab:file-cancel', (_e, token) => collab.cancelFile(text(token)));
  // 按内容认文件：界面进程同样先确认是共享项目里的素材 / 口播，才把指纹告诉对方
  handle('collab:file-info', async (_e, file) => {
    try {
      return { ok: true, ...(await fingerprint(String(file || ''))) };
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
      const dirs = (Array.isArray(req?.dirs) ? req.dirs : []).map(d => String(d || ''));
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
  app.on('before-quit', () => collab.dispose());
}

module.exports = { registerCollabIpc };
