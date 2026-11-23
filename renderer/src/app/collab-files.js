/* 协作文件传输：缺失检查、按内容认出本机已有的文件、请求、进度和本机引用更新。
   会话由外层提供，本模块不依赖配对 / 重连 / 撤销实现。 */
import { state } from './state.js';
import { emit } from './events.js';
import { invalidateProbe, probePaths, isMissing } from './asset-actions.js';
import { changeProject } from './project-change.js';
import { followMovedPaths } from './undo.js';
import { assetName, syncMirror, referencedAssetIds, stripLocalFrag } from '../core/asset-model.js';
import { localVideoPath } from '../core/candidate-values.js';
import { swapToLocal } from '../core/candidate-placement.js';
import * as native from '../platform/native.js';

const isLocalFile = p => typeof p === 'string' && p.startsWith('/');

export function createCollabFiles({ sessionOf, projectOf, metaOf, send, mapLocalPath, myName }) {
  /* ── 从对方电脑取文件：这台电脑上找不到、对方电脑上有的素材 / 口播音频，拷一份到自己选的文件夹 ── */
  const fileReqs = new Map(); // 请求 id → 收到 file-ready / file-none 时的回调
  let fileJob = null; // 正在取的一批：{ total, index, name, done, size, token, got, failed }
  const clipJobs = new Map(); // 保存片段时从对方电脑拷：token → 进度回调（0–1）
  const fileProgress = () => (fileJob ? { ...fileJob } : null);
  function onFileProgress(evt) {
    const clip = clipJobs.get(evt.token);
    if (clip) return evt.total && clip(Math.min(1, evt.done / evt.total));
    if (!fileJob || evt.token !== fileJob.token) return;
    fileJob.done = evt.done;
    if (evt.total) fileJob.size = evt.total;
    emit('collab-files');
  }
  /* 当前项目里这台电脑上缺的本地文件（用到的素材、口播，以及非否决状态的本地候选视频，同一文件路径去重） */
  async function missingFiles(pid = state.projectId) {
    const p = projectOf(pid);
    if (!p || !sessionOf(pid)) return [];
    const items = [];
    const used = referencedAssetIds(p.rows || []);
    for (const a of Object.values(p.assets || {}))
      if (used.has(a.id) && isLocalFile(a.path))
        items.push({ kind: 'asset', id: a.id, path: a.path, name: assetName(a.path) });
    if (isLocalFile(p.voice?.path)) items.push({ kind: 'voice', path: p.voice.path, name: assetName(p.voice.path) });

    const candRows = [];
    const targets = new Set(items.map(i => i.path));
    for (const c of p.candidates || []) {
      if (c.decision === 'no') continue;
      const src = localVideoPath(c.url);
      if (!src) continue;
      candRows.push({ c, src });
      targets.add(src);
      if (c.savedPath) targets.add(c.savedPath);
      if (c.peerPath) targets.add(c.peerPath);
    }
    if (!targets.size) return [];
    const probe = await probePaths([...targets]);
    const out = items.filter(i => isMissing(probe[i.path]));
    const seenPaths = new Set(items.map(i => stripLocalFrag(i.path)));
    for (const { c, src } of candRows) {
      const hasLocal =
        (c.savedPath && !isMissing(probe[c.savedPath])) ||
        (c.peerPath && !isMissing(probe[c.peerPath])) ||
        !isMissing(probe[src]);
      if (hasLocal || seenPaths.has(src)) continue;
      seenPaths.add(src);
      out.push({ kind: 'cand', id: c.id, path: src, name: assetName(src) });
    }
    return out;
  }
  function askPeer(s, req, waitMs = 30000) {
    if (!s?.conn) return Promise.resolve({ type: 'file-none', reason: '连接已断开' });
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        fileReqs.delete(req.rid);
        resolve({ type: 'file-none', reason: '对方没有回应' });
      }, waitMs);
      const finish = msg => {
        clearTimeout(timer);
        fileReqs.delete(req.rid);
        resolve(msg);
      };
      fileReqs.set(req.rid, { pid: s.pid, finish });
      send(s, req);
    });
  }
  function abortSession(pid, reason = '连接已断开') {
    for (const [, entry] of [...fileReqs.entries()]) {
      if (entry.pid === pid) entry.finish({ type: 'file-none', reason });
    }
  }
  /* 取一个文件。item.clip：要的是对方保存过的视频片段（{ id, url, in, out }），item.segment：存成片段文件名 */
  async function fetchOne(s, item, dir, token, waitMs) {
    const req = { type: 'file-req', rid: crypto.randomUUID(), token, kind: item.kind, assetId: item.id };
    if (item.kind === 'cand') req.candId = item.id;
    if (item.clip) req.clip = item.clip;
    const save = { token, dir, name: item.name, segment: item.segment };
    if (s.rep.role === 'host') {
      // 主机不能连访客：先登记「等这个文件」，再请访客连过来送
      const done = native.collabFileExpect(save);
      const reply = await askPeer(s, req, waitMs);
      if (reply.type !== 'file-ready') {
        native.collabFileCancel(token).catch(() => {});
        await done;
        return { error: reply.reason || '对方没给文件' };
      }
      const res = await done;
      return res?.ok && reply.savedClip ? { ...res, savedClip: true } : res;
    }
    const reply = await askPeer(s, req, waitMs);
    if (reply.type !== 'file-ready') return { error: reply.reason || '对方没给文件' };
    if (fileJob?.token === token) fileJob.size = reply.size || 0;
    const c = metaOf(s);
    const res = await native.collabFileFetch({ ...save, address: c.host.address, port: c.host.port });
    return res?.ok && reply.savedClip ? { ...res, savedClip: true } : res;
  }
  /* 保存已通过的片段：对方保存过同一段（同一链接、同样的入出点）就从他电脑上拷，不用再从网站下载。
     不在线时直接返回 null（不等待，网站下载照常立刻开始）；对方没存过、传输失败也得到 null，调用方照常去网站下载 */
  function fetchClip(pid, clip, opts = {}) {
    const s = sessionOf(pid);
    return s && s.status === 'online' && s.conn && opts.dir ? copyClip(s, clip, opts) : null;
  }
  async function copyClip(s, clip, { dir, name, onProgress }) {
    const token = crypto.randomUUID();
    clipJobs.set(token, p => onProgress?.(p));
    try {
      const item = {
        kind: 'clip',
        clip: { id: clip.id, url: clip.url, in: clip.in, out: clip.out },
        segment: { name, start: clip.in, end: clip.out },
      };
      const r = await fetchOne(s, item, dir, token, 10000).catch(() => null);
      return r?.ok && r.path ? { ok: true, path: r.path, peer: s.peer || '对方' } : null;
    } finally {
      clipJobs.delete(token);
    }
  }
  /* 把拉取到的同事候选视频绑定到本机候选（同源路径共用）及已通过且仍在引用原路径的素材 */
  function bindPeerCandidatePath(s, srcPath, local) {
    const moves = [];
    const committed = changeProject(
      null,
      (change, project) => {
        let touched = false;
        for (const c of project.candidates || []) {
          if (localVideoPath(c.url) !== srcPath) continue;
          if (c.peerPath !== local) {
            c.peerPath = local;
            touched = true;
          }
          const a = c.assetId ? project.assets?.[c.assetId] : null;
          if (a && stripLocalFrag(a.path) === srcPath && a.path !== local) {
            moves.push([a.path, local]);
            a.path = local;
            a.name = assetName(local);
            delete a.durationSec;
            touched = true;
          }
        }
        if (!touched) return false;
        syncMirror(project.rows || [], project.assets || {});
      },
      { projectId: s.pid },
    );
    if (committed === false || committed?.error) return false;
    if (moves.length) {
      for (const [from, to] of moves) mapLocalPath(s, stripLocalFrag(from), stripLocalFrag(to));
      followMovedPaths(new Map(moves));
    }
    invalidateProbe();
    emit('candidate-media');
    return true;
  }
  /* 协作中候选已点「通过」且本机已有 peerPath 时，即时把表格/时间轨素材指到本机缓存副本 */
  function bindApprovedPeerPaths(pid = state.projectId) {
    const s = sessionOf(pid);
    const p = projectOf(pid);
    if (!s || !p) return false;
    const needs = (p.candidates || []).some(c => {
      if (c.decision !== 'ok' || !c.peerPath || !c.assetId) return false;
      const src = localVideoPath(c.url);
      const a = p.assets?.[c.assetId];
      return !!(src && a && stripLocalFrag(a.path) === src && a.path !== c.peerPath);
    });
    if (!needs) return false;
    const moves = [];
    const committed = changeProject(
      null,
      (change, project) => {
        let touched = false;
        for (const c of project.candidates || []) {
          if (c.decision !== 'ok' || !c.peerPath || !c.assetId) continue;
          const src = localVideoPath(c.url);
          const a = project.assets?.[c.assetId];
          if (!src || !a || stripLocalFrag(a.path) !== src || a.path === c.peerPath) continue;
          moves.push([a.path, c.peerPath]);
          a.path = c.peerPath;
          a.name = assetName(c.peerPath);
          delete a.durationSec;
          touched = true;
        }
        if (!touched) return false;
        syncMirror(project.rows || [], project.assets || {});
      },
      { projectId: pid },
    );
    if (committed === false || committed?.error || !moves.length) return false;
    for (const [from, to] of moves) mapLocalPath(s, stripLocalFrag(from), stripLocalFrag(to));
    followMovedPaths(new Map(moves));
    invalidateProbe();
    return true;
  }
  const inflightCand = new Map(); // `${pid}|${src}` → Promise
  /* 审核页 / 播放器按需从同事电脑拉取本地候选视频到本地缓存（静默、按源文件去重并发） */
  async function ensureCandidateFile(candId, pid = state.projectId) {
    const p = projectOf(pid);
    const c = (p?.candidates || []).find(x => String(x.id) === String(candId));
    if (!c) return { ok: false, error: '找不到这个候选' };
    const src = localVideoPath(c.url);
    if (!src) return { ok: false, notLocal: true };
    const checks = [c.savedPath, c.peerPath, src].filter(Boolean);
    const probe = await probePaths(checks);
    if (c.savedPath && !isMissing(probe[c.savedPath])) return { ok: true, path: c.savedPath };
    if (c.peerPath && !isMissing(probe[c.peerPath])) return { ok: true, path: c.peerPath };
    if (!isMissing(probe[src])) return { ok: true, path: src };

    const s = sessionOf(pid);
    if (!s) return { ok: false, noCollab: true };
    if (s.status !== 'online' || !s.conn) return { ok: false, offline: true };

    const key = `${pid}|${src}`;
    if (inflightCand.has(key)) return inflightCand.get(key);
    const job = (async () => {
      const dir = await native.collabCacheDir(pid).catch(() => '');
      if (!dir) return { ok: false, error: '无法创建候选缓存目录' };
      const same = (projectOf(pid)?.candidates || []).find(x => localVideoPath(x.url) === src && x.peerPath && x !== c);
      if (same?.peerPath) {
        const sp = await probePaths([same.peerPath]);
        if (!isMissing(sp[same.peerPath])) {
          bindPeerCandidatePath(s, src, same.peerPath);
          return { ok: true, path: same.peerPath };
        }
      }
      const token = crypto.randomUUID();
      const item = { kind: 'cand', id: c.id, path: src, name: assetName(src) };
      const r = await fetchOne(s, item, dir, token, 30000).catch(error => ({
        error: String(error?.message || error),
      }));
      if (!r?.ok || !r.path) return { ok: false, error: r?.error || '没取到' };
      bindPeerCandidatePath(s, src, r.path);
      return { ok: true, path: r.path };
    })().finally(() => inflightCand.delete(key));
    inflightCand.set(key, job);
    return job;
  }
  /* 取到了：这台电脑上的素材 / 口播改指向新文件（不进撤销，只算本机） */
  function useFetched(s, item, local, { savedClip = false } = {}) {
    if (item.kind === 'cand') return bindPeerCandidatePath(s, item.path, local);
    let movedFrom = '';
    const committed = changeProject(
      null,
      (change, project) => {
        if (item.kind === 'voice') {
          if (project.voice?.path !== item.path) return false;
          project.voice = { ...project.voice, path: local, name: assetName(local) };
        } else {
          const a = project.assets?.[item.id];
          if (!a || a.path !== item.path) return false;
          movedFrom = a.path;
          if (savedClip) {
            const cid = a.source?.candidate;
            const c = cid && (project.candidates || []).find(x => x.id === cid);
            if (c) {
              c.savedPath = local;
              swapToLocal(c, local, project.rows || [], project.assets || {});
              return;
            }
          }
          a.path = local;
          a.name = assetName(local);
          delete a.durationSec;
          const srcPath = stripLocalFrag(item.path);
          if (srcPath)
            for (const c of project.candidates || []) if (localVideoPath(c.url) === srcPath) c.peerPath = local;
          syncMirror(project.rows || [], project.assets);
        }
      },
      { projectId: s.pid },
    );
    if (committed === false || committed?.error) return;
    if (!savedClip) mapLocalPath(s, stripLocalFrag(item.path), stripLocalFrag(local)); // 比下一次同步早：对方收到的还是原路径
    if (movedFrom && !savedClip) followMovedPaths(new Map([[movedFrom, local]]));
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
        const token = crypto.randomUUID();
        Object.assign(fileJob, { index: fileJob.index + 1, name: item.name, done: 0, size: 0, token });
        emit('collab-files');
        const r = await fetchOne(s, item, item.dir || dir, token).catch(error => ({
          error: String(error?.message || error),
        }));
        if (r?.ok) {
          useFetched(s, item, r.path, { savedClip: !!r.savedClip });
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
          items: items.map(i => ({
            kind: i.kind,
            assetId: i.id,
            ...(i.kind === 'cand' ? { candId: i.id } : {}),
          })),
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
          useFetched(s, item, local, { savedClip: !!wants[i]?.savedClip });
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
  /* 找本地候选视频文件：先原路径，再 peerPath */
  async function candSourceFile(p, candId) {
    const c = (p?.candidates || []).find(x => String(x.id) === String(candId));
    if (!c) return null;
    const paths = [localVideoPath(c.url), localVideoPath(c.peerPath)].filter(Boolean);
    if (!paths.length) return null;
    const probe = await probePaths(paths);
    return paths.find(f => !isMissing(probe[f])) || null;
  }
  /* 找共享项目里的素材在本地对应的文件（返回 { file, savedClip }） */
  async function assetSourceFile(p, assetId) {
    const a = p?.assets?.[assetId];
    if (!a) return { file: null, savedClip: false };
    const cid = a.source?.candidate;
    const c = cid ? (p.candidates || []).find(x => String(x.id) === String(cid)) : null;
    if (c && localVideoPath(c.url)) {
      const candFile = await candSourceFile(p, c.id);
      if (candFile) return { file: candFile, savedClip: false };
    }
    const direct = stripLocalFrag(a.path);
    if (isLocalFile(direct)) {
      const probe = await probePaths([direct]);
      if (!isMissing(probe[direct])) return { file: direct, savedClip: !!(c && c.savedPath === direct) };
    }
    if (c && isLocalFile(c.savedPath)) {
      const probe = await probePaths([c.savedPath]);
      if (!isMissing(probe[c.savedPath])) return { file: c.savedPath, savedClip: true };
    }
    return { file: null, savedClip: false };
  }
  /* 对方来问文件信息：和取文件一样，只答这个共享项目里用到的素材、口播和候选视频 */
  async function onInfoReq(s, msg) {
    const p = projectOf(s.pid);
    const used = p ? referencedAssetIds(p.rows || []) : new Set();
    const list = (Array.isArray(msg.items) ? msg.items : []).slice(0, 2000);
    const items = await Promise.all(
      list.map(async it => {
        let file = null;
        let isSavedClip = false;
        if (it?.kind === 'voice') file = isLocalFile(p?.voice?.path) ? p.voice.path : null;
        else if (it?.kind === 'cand') file = await candSourceFile(p, it.candId ?? it.assetId);
        else if (used.has(it?.assetId)) ({ file, savedClip: isSavedClip } = await assetSourceFile(p, it.assetId));
        if (!isLocalFile(file)) return null;
        const r = await native.collabFileInfo(file).catch(() => null);
        return r?.ok ? { size: r.size, fp: r.fp, ...(isSavedClip ? { savedClip: true } : {}) } : null;
      }),
    );
    send(s, { type: 'file-info', rid: msg.rid, items });
  }
  /* 这台电脑保存过的那段已通过片段（同一链接、同样的入出点才算），没有返回 null */
  function savedClip(p, clip) {
    const c = (p.candidates || []).find(x => String(x.id) === String(clip?.id));
    return c?.decision === 'ok' && c.savedPath && c.url === clip.url && c.in === clip.in && c.out === clip.out
      ? c.savedPath
      : null;
  }
  /* 对方来要文件：只给这个共享项目里用到的素材、口播、保存过的已通过片段和候选视频，别的文件一概不给 */
  async function onFileReq(s, msg) {
    const no = reason => send(s, { type: 'file-none', rid: msg.rid, reason });
    const p = projectOf(s.pid);
    if (!p) return no('对方那边找不到这个项目');
    const used =
      msg.kind === 'voice' ||
      msg.kind === 'clip' ||
      msg.kind === 'cand' ||
      referencedAssetIds(p.rows || []).has(msg.assetId);
    if (!used) return no('对方那边也没有这个文件');
    let file;
    let isSavedClip = false;
    if (msg.kind === 'voice') file = isLocalFile(p.voice?.path) ? p.voice.path : null;
    else if (msg.kind === 'clip') file = savedClip(p, msg.clip);
    else if (msg.kind === 'cand') file = await candSourceFile(p, msg.candId ?? msg.assetId);
    else ({ file, savedClip: isSavedClip } = await assetSourceFile(p, msg.assetId));
    if (!isLocalFile(file)) return no(msg.kind === 'clip' ? '对方没保存过这一段' : '对方那边也没有这个文件');
    const probe = await probePaths([file]);
    if (isMissing(probe[file])) return no(`${myName() || '对方'} 的电脑上也找不到这个文件了`);
    if (s.rep.role === 'host') {
      const r = await native.collabFileOffer(msg.token, file).catch(() => null);
      if (!r?.ok) return no(r?.error || '对方那边读不了这个文件');
      return send(s, {
        type: 'file-ready',
        rid: msg.rid,
        size: r.size,
        name: r.name,
        ...(isSavedClip ? { savedClip: true } : {}),
      });
    }
    // 访客：自己连上主机把文件送过去（主机已经在等了）
    const c = metaOf(s);
    send(s, {
      type: 'file-ready',
      rid: msg.rid,
      name: assetName(file),
      ...(isSavedClip ? { savedClip: true } : {}),
    });
    native.collabFilePush({ address: c.host?.address, port: c.host?.port, token: msg.token, file }).catch(() => {});
  }

  return {
    fileProgress,
    findProgress,
    missingFiles,
    fetchFiles,
    fetchClip,
    ensureCandidateFile,
    bindApprovedPeerPaths,
    cancelFetch,
    findLocal,
    cancelFind,
    onProgress: onFileProgress,
    onFindProgress,
    onRequest: onFileReq,
    onInfoRequest: onInfoReq,
    onReply: msg => fileReqs.get(msg.rid)?.finish(msg),
    abortSession,
  };
}
