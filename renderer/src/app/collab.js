import { createCollabSessionStore } from './collab-session.js';
import { createCollabConnection } from './collab-connection.js';
import { createCollabDiscovery } from './collab-discovery.js';

import { viewState } from './view-state.js';
/* 局域网协作（2.0）的应用层：开始 / 停止共享、配对加入 / 退出、断线重连，把两边的改动接到项目上。
   · 怎么比、怎么合在 core/collab-sync.js；网络收发在主进程（electron/collab-net.js）；界面在 features/collab.js。
   · 一个项目同一时间最多两个人：开始共享的人（主机）和一个用配对码加入的人（访客）。
     配对成功后访客记下一把钥匙（secret），以后重连不用再输配对码；配对码用过一次就换新的。
   · 项目上的 collab 字段（只存在本机）：{ id, role, secret, code, guest, host, pos, maxId, unsent, pathMap }。 */
import { state } from './state.js';
import { emit, on } from './events.js';

import { notify } from './events.js';
import * as storage from './storage.js';
import { clearUndo } from './undo.js';

import { createCollabFiles } from './collab-files.js';

import { COLLAB_PROTO } from '../core/collab-doc.js';
import { stripLocalFrag } from '../core/asset-model.js';

import * as native from '../platform/native.js';

const session = createCollabSessionStore({ send, syncHosting });
const { sessions, openSession, saveMeta, scheduleFlush } = session;
const conns = new Map(); // 连接 id → 会话
const me = { id: '', name: '' };
let hostInfo = null; // 本机开着共享服务时：{ port, addresses }

const projectOf = storage.projectForId;
const metaOf = s => storage.collabOf(s.pid);
const newCode = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, '0');
function send(s, msg) {
  if (!s.conn || s.closing) return;
  native.collabSend(s.conn, msg).catch(() => {});
}
const changed = () => emit('collab-changed');
const discovery = createCollabDiscovery({
  myId: () => me.id,
  needsReconnect: () => [...sessions.values()].some(s => s.rep.role === 'guest' && !s.conn),
  changed,
  onHosts: () => {
    for (const s of sessions.values()) if (s.rep.role === 'guest' && !s.conn) reconnect(s);
  },
});
export const queryHost = discovery.queryHost;
export const watchHosts = discovery.watchHosts;
const files = createCollabFiles({
  sessionOf: pid => sessions.get(pid),
  projectOf,
  metaOf,
  send,
  mapLocalPath,
  myName: () => me.name,
});
const connection = createCollabConnection({
  session,
  conns,
  me,
  discovery,
  files,
  send,
  changed,
  sendPresence,
  endSession,
  shareList,
  newCode,
});
const { reconnect, scheduleReconnect, onNetEvent } = connection;
export const joinShare = connection.joinShare;
export const leaveShare = connection.leaveShare;
export const repair = connection.repair;
export const fileProgress = files.fileProgress;
export const missingFiles = files.missingFiles;
export const fetchFiles = files.fetchFiles;
export const fetchClip = files.fetchClip;
export const ensureCandidateFile = files.ensureCandidateFile;
export const cancelFetch = files.cancelFetch;
export const findProgress = files.findProgress;
export const findLocal = files.findLocal;
export const cancelFind = files.cancelFind;

on('project-committed', change => {
  if (change?.projectId && (change.candidates || change.assets || change.full))
    files.bindApprovedPeerPaths(change.projectId);
});

/* ── 状态（给界面） ── */
function sessionView(s) {
  if (!s) return null;
  const c = metaOf(s) || {};
  return {
    projectId: s.pid,
    role: s.rep.role,
    status: s.status,
    peer: s.peer || '',
    peerSel: s.peerSel,
    code: s.rep.role === 'host' ? c.code : '',
    hostName: c.host?.name || '',
    hostAddress: c.host?.address
      ? `${c.host.address}${c.host.port && c.host.port !== 47391 ? ':' + c.host.port : ''}`
      : '',
  };
}
export const collabSession = (pid = state.projectId) => sessionView(sessions.get(pid));
export function collabState() {
  const joined = new Set([...sessions.values()].map(s => metaOf(s)?.id));
  const { hosts: all, discovering } = discovery.snapshot();
  return {
    me: { ...me },
    hostInfo,
    current: collabSession(),
    hosts: all
      .filter(h => h.hostId !== me.id)
      .map(h => ({ ...h, shares: h.shares.map(x => ({ ...x, joined: joined.has(x.id) })) })),
    discovering,
  };
}
/* 对方正停在当前项目的哪一句（没有协作 / 不在线返回 null） */
export function peerHere() {
  const s = sessions.get(state.projectId);
  return s && s.status === 'online' && s.peerSel != null ? { sel: s.peerSel, name: s.peer || '对方' } : null;
}

/* ── 会话 ── */
function endSession(s, { closeConn = true } = {}) {
  if (sessions.get(s.pid) !== s) return;
  s.closing = true;
  files.abortSession(s.pid);
  session.close(s);
  if (s.conn) {
    conns.delete(s.conn);
    if (closeConn) native.collabClose(s.conn).catch(() => {});
    s.conn = null;
  }
  syncHosting();
  discovery.sync();
  changed();
}

/* ── 主机 ── */
export function startSharing() {
  const pid = state.projectId;
  const p = storage.projectById(pid);
  if (!p) return null;
  if (!p.collab) {
    p.collab = { id: crypto.randomUUID(), role: 'host', code: newCode(), secret: '', pos: {}, maxId: 0 };
    storage.persist(); // 先把界面里的内容存进项目，再从它建 base
    openSession(pid);
  }
  syncHosting();
  changed();
  return p.collab.code;
}
export function stopSharing(pid = state.projectId) {
  const s = sessions.get(pid);
  if (!s || s.rep.role !== 'host' || s.closing) return false;
  const connId = s.conn;
  s.closing = true;
  clearTimeout(s.retry);
  if (connId) {
    conns.delete(connId);
    files.abortSession(s.pid);
    native.collabSend(connId, { type: 'bye', reason: 'stopped' }).catch(() => {});
  }
  setTimeout(() => endSession(s), connId ? 200 : 0);
  return true;
}
export function newPairingCode(pid = state.projectId) {
  const s = sessions.get(pid);
  const c = s && metaOf(s);
  if (!c || s.rep.role !== 'host') return null;
  c.code = newCode();
  s.attempts = 0;
  saveMeta(s);
  changed();
  return c.code;
}
function shareList() {
  return [...sessions.values()]
    .filter(s => s.rep.role === 'host')
    .map(s => ({ id: metaOf(s)?.id, title: projectOf(s.pid)?.title || '未命名' }));
}
async function syncHosting() {
  const shares = shareList();
  if (!shares.length) {
    if (hostInfo) {
      hostInfo = null;
      native.collabHostStop().catch(() => {});
      changed();
    }
    return;
  }
  const info = { proto: COLLAB_PROTO, hostId: me.id, name: me.name, shares };
  if (hostInfo) return native.collabHostUpdate(info).catch(() => {});
  hostInfo = { port: 0, addresses: [] };
  const r = await native.collabHostStart(info).catch(error => ({ ok: false, error: String(error?.message || error) }));
  if (!r?.ok) {
    hostInfo = null;
    notify(`没能开始共享：${r?.error || '网络不可用'}`, null, 'error');
  } else hostInfo = { port: r.port, addresses: r.addresses || [] };
  changed();
}

/* 手动输入地址（广播被路由器挡住时）：问一下这台主机在共享什么 */
/* ── 文件位置只算本机：重新定位失联文件、从对方电脑取过来的文件，对方那边的路径不跟着改 ── */
const isLocalFile = p => typeof p === 'string' && p.startsWith('/');
function mapLocalPath(s, from, to) {
  const c = metaOf(s);
  const cleanFrom = stripLocalFrag(from);
  const cleanTo = stripLocalFrag(to);
  if (!c || !isLocalFile(cleanFrom) || !cleanTo || cleanFrom === cleanTo) return;
  c.pathMap ||= {};
  const hit = Object.entries(c.pathMap).find(([, local]) => stripLocalFrag(local) === cleanFrom);
  const shared = hit ? stripLocalFrag(hit[0]) : cleanFrom;
  for (const k of Object.keys(c.pathMap)) {
    if (stripLocalFrag(k) === shared && k !== shared) delete c.pathMap[k];
  }
  if (shared === cleanTo) delete c.pathMap[shared];
  else c.pathMap[shared] = cleanTo;
  s.rep.pathMap = c.pathMap;
  saveMeta(s);
}
/* 撤销重新定位或路径还原后，把不再被引用的失效本机路径映射清理掉 */
function prunePathMap(s) {
  const c = metaOf(s);
  const project = projectOf(s.pid);
  if (!c?.pathMap || !project) return;
  const livePaths = new Set();
  for (const a of Object.values(project.assets || {})) {
    const p = stripLocalFrag(a?.path);
    if (isLocalFile(p)) livePaths.add(p);
  }
  const vp = stripLocalFrag(project.voice?.path);
  if (isLocalFile(vp)) livePaths.add(vp);
  for (const cand of project.candidates || []) {
    const pp = stripLocalFrag(cand?.peerPath);
    if (isLocalFile(pp)) livePaths.add(pp);
  }
  let dirty = false;
  for (const [shared, local] of Object.entries(c.pathMap)) {
    const cleanShared = stripLocalFrag(shared);
    const cleanLocal = stripLocalFrag(local);
    if (!cleanLocal || cleanShared === cleanLocal || !livePaths.has(cleanLocal)) {
      delete c.pathMap[shared];
      dirty = true;
    }
  }
  if (dirty) {
    s.rep.pathMap = c.pathMap;
    saveMeta(s);
  }
}

/* ── 对方停在哪句 ── */
let presenceTimer = null;
function sendPresence(force = false) {
  clearTimeout(presenceTimer);
  presenceTimer = setTimeout(() => {
    for (const s of sessions.values()) {
      if (!s.conn || s.status !== 'online') continue;
      const sel = s.pid === state.projectId ? viewState.sel : null;
      if (!force && s.sentSel === sel) continue;
      s.sentSel = sel;
      send(s, { type: 'here', sel, name: me.name });
    }
  }, 120);
}

/* ── 找局域网里的主机：协作面板开着，或有离线的访客项目要重连时才听广播 ── */
export function setMyName(name) {
  const v = String(name || '')
    .trim()
    .slice(0, 40);
  if (!v || v === me.name) return;
  me.name = v;
  storage.settings().collabName = v;
  storage.saveSettings();
  if (hostInfo) syncHosting();
  sendPresence(true);
  changed();
}

/* 从备份整库恢复：项目内容都换了，按恢复后的项目重新开会话（访客以主机为准，备份里没送出的改动不再补发） */
function resetSessions() {
  connection.reset();
  clearUndo(); // 整库已被替换，旧项目内容对应的历史不再适用。
  for (const s of sessions.values()) {
    s.closing = true;
    files.abortSession(s.pid);
    clearTimeout(s.timer);
    clearTimeout(s.retry);
    if (s.conn) native.collabClose(s.conn).catch(() => {});
  }
  session.reset();
  conns.clear();
  for (const p of storage.allProjects()) {
    if (p.collab?.role !== 'host' && p.collab?.role !== 'guest') continue;
    if (p.collab.role === 'guest') p.collab.unsent = [];
    const s = openSession(p.id);
    if (s?.rep.role === 'guest') scheduleReconnect(s, 500);
  }
  syncHosting();
  changed();
}

export async function initCollab() {
  if (!native.isNative() || !window.native?.collabSend) return;
  const st = storage.settings();
  if (!st.collabId) {
    st.collabId = crypto.randomUUID();
    storage.saveSettings();
  }
  me.id = st.collabId;
  me.name = st.collabName || (await native.collabMachine().catch(() => '')) || '同事';
  native.onCollabEvent(evt => {
    if (evt.type === 'file-progress') return files.onProgress(evt);
    if (evt.type === 'find-progress') return files.onFindProgress(evt);
    if (discovery.handleEvent(evt)) return;
    onNetEvent(evt);
  });
  storage.onProjectWrite(id => {
    const s = sessions.get(id);
    if (s) scheduleFlush(s);
  });
  session.bindSnapshotHooks();
  on('project-removed', ({ id, collab }) => {
    const s = sessions.get(id);
    if (!s || s.closing) return;
    const connId = s.conn;
    s.closing = true;
    clearTimeout(s.retry);
    if (connId) {
      conns.delete(connId);
      files.abortSession(s.pid);
      native.collabSend(connId, { type: 'bye', reason: collab?.role === 'host' ? 'deleted' : 'left' }).catch(() => {});
    }
    setTimeout(() => endSession(s), connId ? 200 : 0);
  });
  // 重新定位失联文件只算这台电脑的事：对方那边的路径不跟着改（各自电脑上的文件位置不一样）
  on('asset-relocated', ({ moves }) => {
    const s = sessions.get(state.projectId);
    if (!s) return;
    for (const [from, to] of moves || []) mapLocalPath(s, from, to);
  });
  on('history', () => {
    const s = sessions.get(state.projectId);
    if (s) prunePathMap(s);
  });
  on('cursor', () => sendPresence());
  on('project-loaded', () => {
    sendPresence(true);
    changed();
  });
  on('library-replaced', resetSessions);
  // 心跳由主进程网络层处理，不依赖后台可能被暂停的界面计时器。
  for (const p of storage.allProjects()) if (p.collab?.role === 'host' || p.collab?.role === 'guest') openSession(p.id);
  syncHosting();
  for (const s of sessions.values()) if (s.rep.role === 'guest') scheduleReconnect(s, 500);
  changed();
}
