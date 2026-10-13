/* 协作文件传输：缺失检查、按内容认出本机已有的文件、请求、进度和本机引用更新。
   会话由外层提供，本模块不依赖配对 / 重连 / 撤销实现。 */
import { state } from './state.js';
import { emit } from './events.js';
import { invalidateProbe, probePaths, isMissing } from './asset-actions.js';
import { changeProject } from './project-change.js';
import { assetName, syncMirror, referencedAssetIds } from '../core/asset-model.js';
import * as native from '../platform/native.js';

const isLocalFile = p => typeof p === 'string' && p.startsWith('/');

export function createCollabFiles({ sessionOf, projectOf, metaOf, send, mapLocalPath, myName }) {
  /* ── 从对方电脑取文件：这台电脑上找不到、对方电脑上有的素材 / 口播音频，拷一份到自己选的文件夹 ── */
  const fileReqs = new Map(); // 请求 id → 收到 file-ready / file-none 时的回调
  let fileJob = null; // 正在取的一批：{ total, index, name, done, size, token, got, failed }
  const fileProgress = () => (fileJob ? { ...fileJob } : null);
  function onFileProgress(evt) {
    if (!fileJob || evt.token !== fileJob.token) return;
    fileJob.done = evt.done;
    if (evt.total) fileJob.size = evt.total;
    emit('collab-files');
  }
  /* 当前项目里这台电脑上缺的本地文件（只算用到的素材和口播） */
  async function missingFiles(pid = state.projectId) {
    const p = projectOf(pid);
    if (!p || !sessionOf(pid)) return [];
    const items = [];
    const used = referencedAssetIds(p.rows || []);
    for (const a of Object.values(p.assets || {}))
      if (used.has(a.id) && isLocalFile(a.path))
        items.push({ kind: 'asset', id: a.id, path: a.path, name: assetName(a.path) });
    if (isLocalFile(p.voice?.path)) items.push({ kind: 'voice', path: p.voice.path, name: assetName(p.voice.path) });
    if (!items.length) return [];
    const probe = await probePaths(items.map(i => i.path));
    return items.filter(i => isMissing(probe[i.path]));
  }
  function askPeer(s, req, waitMs = 30000) {
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        fileReqs.delete(req.rid);
        resolve({ type: 'file-none', reason: '对方没有回应' });
      }, waitMs);
      fileReqs.set(req.rid, msg => {
        clearTimeout(timer);
        fileReqs.delete(req.rid);
        resolve(msg);
      });
      send(s, req);
    });
  }
  async function fetchOne(s, item, dir) {
    const token = crypto.randomUUID();
    const req = { type: 'file-req', rid: crypto.randomUUID(), token, kind: item.kind, assetId: item.id };
    fileJob.token = token;
    if (s.rep.role === 'host') {
      // 主机不能连访客：先登记「等这个文件」，再请访客连过来送
      const done = native.collabFileExpect({ token, dir, name: item.name });
      const reply = await askPeer(s, req);
      if (reply.type !== 'file-ready') {
        native.collabFileCancel(token).catch(() => {});
        await done;
        return { error: reply.reason || '对方没给文件' };
      }
      return done;
    }
    const reply = await askPeer(s, req);
    if (reply.type !== 'file-ready') return { error: reply.reason || '对方没给文件' };
    fileJob.size = reply.size || 0;
    const c = metaOf(s);
    return native.collabFileFetch({ address: c.host.address, port: c.host.port, token, dir, name: item.name });
  }
  /* 取到了：这台电脑上的素材 / 口播改指向新文件（不进撤销，只算本机） */
  function useFetched(s, item, local) {
    changeProject(
      null,
      (change, project) => {
        if (item.kind === 'voice') {
          if (project.voice?.path !== item.path) return false;
          project.voice = { ...project.voice, path: local, name: assetName(local) };
          change.emit('voice');
        } else {
          const a = project.assets?.[item.id];
          if (!a || a.path !== item.path) return false;
          a.path = local;
          a.name = assetName(local);
          delete a.durationSec;
          syncMirror(project.rows || [], project.assets);
          change.emit('assets-changed', { ids: null, kind: 'association' });
        }
        change.emit('rows');
      },
      { projectId: s.pid },
    );
    mapLocalPath(s, item.path, local); // 比下一次同步早：对方收到的还是原路径
    invalidateProbe();
  }
  async function fetchFiles(items, dir, pid = state.projectId) {
    const s = sessionOf(pid);
    if (!s || s.status !== 'online') return { error: '对方现在不在线，连上后再取' };
    if (fileJob) return { error: '正在取文件，等这一批取完' };
    if (!items.length) return { got: [], failed: [] };
    fileJob = { total: items.length, index: 0, name: '', done: 0, size: 0, token: '', got: 0, failed: 0 };
    const got = [],
      failed = [];
    try {
      for (const item of items) {
        Object.assign(fileJob, { index: fileJob.index + 1, name: item.name, done: 0, size: 0 });
        emit('collab-files');
        const r = await fetchOne(s, item, dir).catch(error => ({ error: String(error?.message || error) }));
        if (r?.ok) {
          useFetched(s, item, r.path);
          got.push({ ...item, local: r.path });
          fileJob.got++;
        } else {
          failed.push({ ...item, error: r?.error || '没取到' });
          fileJob.failed++;
          if (r?.canceled || !s.conn) break;
        }
      }
    } finally {
      fileJob = null;
      emit('collab-files');
    }
    return { got, failed, dir };
  }
  function cancelFetch() {
    if (fileJob?.token) native.collabFileCancel(fileJob.token).catch(() => {});
  }

  /* ── 取之前先在本机认：对方报每个文件的大小和指纹，在给定的文件夹里找内容一模一样的，找到就直接用，不用再传 ──
     不看文件名、不留任何记录：每次现场比，比完就丢 */
  let findJob = null; // { token, phase: 'info' | 'scan', scanned }
  const findProgress = () => (findJob ? { ...findJob } : null);
  function onFindProgress(evt) {
    if (!findJob || evt.token !== findJob.token) return;
    findJob.scanned = evt.scanned || 0;
    emit('collab-files');
  }
  async function findLocal(items, dirs, pid = state.projectId) {
    const s = sessionOf(pid);
    if (!s || s.status !== 'online') return { error: '对方现在不在线，连上后再找' };
    if (fileJob || findJob) return { error: '正在处理文件，等这一批完了再试' };
    const folders = [...new Set((dirs || []).filter(isLocalFile))];
    if (!items.length || !folders.length) return { got: [], rest: items };
    const token = crypto.randomUUID();
    findJob = { token, phase: 'info', scanned: 0 };
    emit('collab-files');
    try {
      const reply = await askPeer(
        s,
        {
          type: 'file-info-req',
          rid: crypto.randomUUID(),
          items: items.map(i => ({ kind: i.kind, assetId: i.id })),
        },
        60000,
      );
      if (reply.type !== 'file-info') return { error: reply.reason || '对方没给文件信息' };
      if (findJob.canceled) return { got: [], rest: items, canceled: true };
      const wants = items.map((_, i) => reply.items?.[i] || null);
      findJob.phase = 'scan';
      emit('collab-files');
      const r = await native.collabFindFiles({ token, dirs: folders, wants });
      const got = [],
        rest = [];
      items.forEach((item, i) => {
        const local = r?.found?.[i];
        if (local) {
          useFetched(s, item, local);
          got.push({ ...item, local });
        } else rest.push(item);
      });
      return { got, rest, canceled: !!r?.canceled, scanned: r?.scanned || 0 };
    } catch (error) {
      return { error: String(error?.message || error) };
    } finally {
      findJob = null;
      emit('collab-files');
    }
  }
  function cancelFind() {
    if (!findJob) return;
    findJob.canceled = true;
    native.collabFindCancel(findJob.token).catch(() => {});
  }
  /* 对方来问文件信息：和取文件一样，只答这个共享项目里用到的素材和口播 */
  async function onInfoReq(s, msg) {
    const p = projectOf(s.pid);
    const used = p ? referencedAssetIds(p.rows || []) : new Set();
    const list = (Array.isArray(msg.items) ? msg.items : []).slice(0, 2000);
    const items = await Promise.all(
      list.map(async it => {
        const file =
          it?.kind === 'voice' ? p?.voice?.path : used.has(it?.assetId) ? p?.assets?.[it.assetId]?.path : null;
        if (!isLocalFile(file)) return null;
        const r = await native.collabFileInfo(file).catch(() => null);
        return r?.ok ? { size: r.size, fp: r.fp } : null;
      }),
    );
    send(s, { type: 'file-info', rid: msg.rid, items });
  }
  /* 对方来要文件：只给这个共享项目里用到的素材和口播，别的文件一概不给 */
  async function onFileReq(s, msg) {
    const no = reason => send(s, { type: 'file-none', rid: msg.rid, reason });
    const p = projectOf(s.pid);
    if (!p) return no('对方那边找不到这个项目');
    const used = msg.kind === 'voice' || referencedAssetIds(p.rows || []).has(msg.assetId);
    const file = msg.kind === 'voice' ? p.voice?.path : p.assets?.[msg.assetId]?.path;
    if (!used || !isLocalFile(file)) return no('对方那边也没有这个文件');
    const probe = await probePaths([file]);
    if (isMissing(probe[file])) return no(`${myName() || '对方'} 的电脑上也找不到这个文件了`);
    if (s.rep.role === 'host') {
      const r = await native.collabFileOffer(msg.token, file).catch(() => null);
      if (!r?.ok) return no(r?.error || '对方那边读不了这个文件');
      return send(s, { type: 'file-ready', rid: msg.rid, size: r.size, name: r.name });
    }
    // 访客：自己连上主机把文件送过去（主机已经在等了）
    const c = metaOf(s);
    send(s, { type: 'file-ready', rid: msg.rid, name: assetName(file) });
    native.collabFilePush({ address: c.host?.address, port: c.host?.port, token: msg.token, file }).catch(() => {});
  }

  return {
    fileProgress,
    findProgress,
    missingFiles,
    fetchFiles,
    cancelFetch,
    findLocal,
    cancelFind,
    onProgress: onFileProgress,
    onFindProgress,
    onRequest: onFileReq,
    onInfoRequest: onInfoReq,
    onReply: msg => fileReqs.get(msg.rid)?.(msg),
  };
}
