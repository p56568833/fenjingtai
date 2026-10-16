/* 协作项目会话：副本、未发送操作和撤销回补的唯一协调点。 */
import { state } from './state.js';
import { viewState } from './view-state.js';
import * as storage from './storage.js';
import { clearUndo, setSnapshotHooks, rebaseHistory, bindHistory } from './undo.js';
import * as sync from '../core/collab-sync.js';
import { applyRemoteProject } from './collab-apply.js';

export function createCollabSessionStore({ send, syncHosting }) {
  const sessions = new Map();
  const projectOf = storage.projectForId;
  const metaOf = s => storage.collabOf(s.pid);
  function openSession(pid) {
    const c = storage.collabOf(pid);
    const project = projectOf(pid);
    if (!c || !project) return null;
    c.pathMap ||= {};
    const rep = sync.createReplica(project, {
      role: c.role,
      pos: c.pos,
      maxId: c.maxId,
      pathMap: c.pathMap,
      unsent: c.unsent || [],
    });
    const s = {
      pid,
      rep,
      status: c.role === 'host' ? 'waiting' : 'offline',
      conn: null,
      peer: c.role === 'host' ? c.guest?.name || '' : c.host?.name || '',
      peerSel: null,
      sentSel: undefined,
      timer: null,
      retry: null,
      attempts: 0,
    };
    sessions.set(pid, s);
    bindHistory(pid, rep.seq);
    saveMeta(s);
    return s;
  }
  function saveMeta(s) {
    const c = metaOf(s);
    if (!c) return;
    c.pos = s.rep.base.pos;
    c.maxId = s.rep.base.maxId;
    if (s.rep.role === 'guest') c.unsent = sync.unsentKeys(s.rep);
    storage.saveProjectMeta(s.pid);
  }
  /* ── 本机改动 → 对方 ── */
  function scheduleFlush(s) {
    clearTimeout(s.timer);
    s.timer = setTimeout(() => flush(s), 150);
  }
  function flush(s) {
    clearTimeout(s.timer);
    s.timer = null;
    const project = projectOf(s.pid);
    if (!project) return;
    const msg = sync.localChanges(s.rep, project);
    if (msg) send(s, msg);
    if (msg || s.rep.offline.size) saveMeta(s);
    if (s.rep.role === 'host' && msg?.ops.some(op => op.t === 'm' && op.k === 'title')) syncHosting();
  }

  /* ── 对方改动 → 本机 ── */
  function rebaseSessionHistory(s, through = s.rep.seq) {
    rebaseHistory(s.pid, (data, u) => sync.rebaseSnapshot(s.rep, data, u.mark, through), through);
  }

  function onOps(s, msg) {
    const project = projectOf(s.pid);
    if (!project) return;
    flush(s); // 先把本机的改动发出去，再合对方的
    const { sum, reply } = sync.receiveOps(s.rep, project, msg, {
      beforePrune: through => rebaseSessionHistory(s, through),
    });
    if (reply) send(s, reply);
    saveMeta(s);
    if (sum.applied.length) applyRemoteProject(s, sum);
  }

  function close(s) {
    // 退出协作后仍能撤销自己的操作；先把对方改动留在历史里，再解除会话标记。
    rebaseSessionHistory(s);
    bindHistory(s.pid, undefined);
    clearTimeout(s.timer);
    clearTimeout(s.retry);
    sessions.delete(s.pid);
    const p = storage.projectById(s.pid);
    if (p?.collab) {
      delete p.collab;
      storage.saveProjectMeta(s.pid);
    }
  }
  function bindSnapshotHooks() {
    setSnapshotHooks({
      mark: pid => sessions.get(pid)?.rep.seq,
      rebase: (data, u) => {
        const s = sessions.get(u.projectId);
        if (s && u.mark != null) sync.rebaseSnapshot(s.rep, data, u.mark);
      },
    });
  }
  function adoptDocument(s, doc) {
    const project = projectOf(s.pid);
    sync.localChanges(s.rep, project);
    const redo = sync.guestAdopt(s.rep, project, doc);
    if (s.pid === state.projectId) {
      clearUndo();
      const first = state.rows.find(r => r.kind === 'line');
      if (!state.rows.some(r => r.id === viewState.sel)) viewState.sel = first?.id ?? null;
    }
    return redo;
  }
  function offline(s) {
    if (s.rep.role === 'host') s.rep.online = false;
    else {
      flush(s);
      sync.goOffline(s.rep);
      saveMeta(s);
    }
  }
  function reset() {
    clearUndo();
    for (const s of sessions.values()) {
      clearTimeout(s.timer);
      clearTimeout(s.retry);
    }
    sessions.clear();
  }
  return {
    sessions: { get: id => sessions.get(id), has: id => sessions.has(id), values: () => sessions.values() },
    openSession,
    saveMeta,
    close,
    scheduleFlush,
    flush,
    onOps,
    adoptDocument,
    offline,
    reset,
    bindSnapshotHooks,
    hostDoc: s => sync.hostDoc(s.rep),
    acknowledge: (s, n) => {
      sync.receiveAck(s.rep, n);
      saveMeta(s);
    },
  };
}
