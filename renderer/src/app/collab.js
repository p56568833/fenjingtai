/* 局域网协作（2.0）的应用层：开始 / 停止共享、配对加入 / 退出、断线重连，把两边的改动接到项目上。
   · 怎么比、怎么合在 core/collab-sync.js；网络收发在主进程（electron/collab-net.js）；界面在 features/collab.js。
   · 一个项目同一时间最多两个人：开始共享的人（主机）和一个用配对码加入的人（访客）。
     配对成功后访客记下一把钥匙（secret），以后重连不用再输配对码；配对码用过一次就换新的。
   · 项目上的 collab 字段（只存在本机）：{ id, role, secret, code, guest, host, pos, maxId, unsent, pathMap }。 */
import { state, emit, on, update } from './state.js';
import { notify } from './events.js';
import * as storage from './storage.js';
import { setSnapshotHooks, clearUndo, rebaseHistory, bindHistory } from './undo.js';
import { invalidateProbe } from './asset-actions.js';
import { createCollabFiles } from './collab-files.js';
import { writeBack } from './candidate-sync.js';
import { normalizeGroups } from '../core/shots.js';
import { COLLAB_PROTO } from '../core/collab-doc.js';
import * as sync from '../core/collab-sync.js';
import * as native from '../platform/native.js';

const sessions = new Map(); // 本机项目 id → 会话
const conns = new Map(); // 连接 id → 会话
const joins = new Map(); // 连接 id → 正在加入（还没收到主机的整份内容）
const waiting = new Map(); // 连进来、还没打招呼的连接 → 超时计时器
const queries = new Map(); // 手动输入地址时问「在共享什么」的连接 → 收到回复 / 断开时的回调
const me = { id: '', name: '' };
let hosts = []; // 局域网里找到的主机（不含自己）
let manualHosts = []; // 手动输入地址找到的主机
let hostInfo = null; // 本机开着共享服务时：{ port, addresses }
let watching = false; // 界面开着协作面板（要看局域网里有谁）
let discovering = false;

const projectOf = pid => (pid === state.projectId ? state : storage.projectById(pid));
const metaOf = s => storage.collabOf(s.pid);
const newCode = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, '0');
const send = (s, msg) => {
  if (!s.conn) return;
  native.collabSend(s.conn, msg).catch(() => {});
};
const changed = () => emit('collab-changed');
const files = createCollabFiles({
  sessionOf: pid => sessions.get(pid),
  projectOf,
  metaOf,
  send,
  mapLocalPath,
  myName: () => me.name,
});
export const fileProgress = files.fileProgress;
export const missingFiles = files.missingFiles;
export const fetchFiles = files.fetchFiles;
export const fetchClip = files.fetchClip;
export const cancelFetch = files.cancelFetch;
export const findProgress = files.findProgress;
export const findLocal = files.findLocal;
export const cancelFind = files.cancelFind;

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
  const all = [...hosts, ...manualHosts.filter(m => !hosts.some(h => h.hostId === m.hostId))];
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
function endSession(s, { closeConn = true } = {}) {
  if (sessions.get(s.pid) !== s) return;
  // 退出协作后仍能撤销自己的操作；先把对方改动留在历史里，再解除会话标记。
  rebaseSessionHistory(s);
  bindHistory(s.pid, undefined);
  clearTimeout(s.timer);
  clearTimeout(s.retry);
  if (s.conn) {
    conns.delete(s.conn);
    if (closeConn) native.collabClose(s.conn).catch(() => {});
  }
  sessions.delete(s.pid);
  const p = storage.projectById(s.pid);
  if (p?.collab) {
    delete p.collab;
    storage.saveProjectMeta(s.pid);
  }
  syncHosting();
  syncDiscovery();
  changed();
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
function afterRemote(s, sum, { full = false } = {}) {
  const project = projectOf(s.pid);
  if (!project) return;
  if (full || sum.structural || sum.fields.has('groupId')) normalizeGroups(project.rows);
  if (full || sum.assets) invalidateProbe();
  // 对方的审核结果写回这台电脑上的候选清单（清单文件只在导入它的那台电脑上，写回只管本机有的）
  if (full || sum.cands) writeBack(project.candidates || []);
  if (s.pid !== state.projectId) {
    storage.markProjectDirty(s.pid);
    return;
  }
  storage.persist();
  // 对方的改动已经写进数据、界面还没开始刷新：要和刷新前比一比的（镜头轨认「对方改了这个画面」）先看
  emit('collab-applied');
  const has = id => state.rows.some(r => r.id === id && r.kind === 'line');
  if (state.sel != null && !has(state.sel)) {
    if (sum?.removed?.includes(state.sel)) notify(`你停着的这句被${s.peer || '对方'}删掉了`, null, 'info');
    state.sel = state.rows.find(r => r.kind === 'line')?.id ?? null;
  }
  if (state.multi) {
    state.multi = state.multi.filter(has);
    if (!state.multi.length) state.multi = null;
  }
  if (full || sum.meta.has('title')) emit('title');
  if (full || sum.meta.has('types')) emit('types');
  if (full || sum.meta.has('voice')) emit('voice');
  if (full || sum.cands) emit('candidates-changed', {});
  if (full) return update('rows');
  if (sum.assets) emit('assets-changed', { ids: null, kind: 'association' });
  const ids = [...sum.rows];
  const simple =
    !sum.structural && !sum.assets && !sum.cands && [...sum.fields].every(f => f === 'type' || f === 'note');
  if (simple && ids.length) {
    if (sum.fields.has('type')) emit('marks', { ids });
    if (sum.fields.has('note')) emit('notes', { ids });
    emit('project-changed');
  } else if (ids.length || sum.structural || sum.assets || sum.cands || sum.meta.size) emit('collab-remote');
}

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
  if (sum.applied.length) afterRemote(s, sum);
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
  if (!s || s.rep.role !== 'host') return false;
  if (s.conn) send(s, { type: 'bye', reason: 'stopped' });
  setTimeout(() => endSession(s), s.conn ? 200 : 0);
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
const shareList = () =>
  [...sessions.values()]
    .filter(s => s.rep.role === 'host')
    .map(s => ({ id: metaOf(s)?.id, title: projectOf(s.pid)?.title || '未命名' }));
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

function onHello(connId, msg) {
  clearTimeout(waiting.get(connId));
  waiting.delete(connId);
  const reply = m => native.collabSend(connId, m).catch(() => {});
  const deny = (reason, text) => {
    reply({ type: 'denied', reason, text });
    setTimeout(() => native.collabClose(connId).catch(() => {}), 300);
  };
  if (msg.proto !== COLLAB_PROTO) return deny('version', '两边的分镜台版本不一样，请都更新到最新版');
  const s = [...sessions.values()].find(x => x.rep.role === 'host' && metaOf(x)?.id === msg.shareId);
  if (!s) return deny('stopped', '这个项目已经停止共享');
  const c = metaOf(s);
  const guestId = String(msg.guestId || '');
  const sameGuest = c.guest?.id === guestId;
  const known = msg.secret && c.secret && msg.secret === c.secret && c.guest?.id === guestId;
  if (!known) {
    if (!msg.code) return deny('auth', '需要重新输入配对码');
    if (String(msg.code) !== c.code) {
      s.attempts++;
      if (s.attempts >= 5) {
        c.code = newCode();
        s.attempts = 0;
        notify('配对码输错太多次，已经换了一个新的', null, 'warn');
        changed();
      }
      return deny('code', '配对码不对');
    }
    s.attempts = 0;
    c.guest = { id: guestId, name: '' };
    c.secret = crypto.randomUUID();
    c.code = newCode(); // 用过就换，别人再拿这个码进不来
  }
  if (s.conn && s.conn !== connId) {
    // 同一个人重连：旧连接悄悄关掉；换了人：告诉原来那位
    if (!sameGuest) send(s, { type: 'bye', reason: 'replaced' });
    conns.delete(s.conn);
    native.collabClose(s.conn).catch(() => {});
  }
  c.guest.name = String(msg.name || c.guest.name || '同事').slice(0, 40);
  flush(s); // 本机还没比过的改动先并进来（这时还不在线，不会单独发）
  const doc = sync.hostDoc(s.rep);
  s.conn = connId;
  conns.set(connId, s);
  s.status = 'online';
  s.peer = c.guest.name;
  s.peerSel = null;
  saveMeta(s);
  reply({ type: 'welcome', shareId: c.id, secret: c.secret, hostId: me.id, hostName: me.name, doc });
  notify(`${s.peer} 加入了协作`, null, 'ok');
  changed();
  sendPresence(true);
}

/* ── 访客 ── */
export async function joinShare(host, share, code) {
  const existing = storage.allProjects().find(p => p.collab?.id === share.id && p.collab.role === 'guest');
  const s = existing && sessions.get(existing.id);
  if (s?.conn) {
    storage.switchProject(existing.id);
    clearUndo();
    update('rows');
    return { ok: true, projectId: existing.id };
  }
  const r = await native
    .collabConnect({ address: host.address, port: host.port })
    .catch(error => ({ error: String(error?.message || error) }));
  if (!r || r.error) return { error: r?.error || '连不上' };
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      joins.delete(r.id);
      native.collabClose(r.id).catch(() => {});
      resolve({ error: '对方没有回应，稍后再试' });
    }, 20000);
    joins.set(r.id, { host, share, existing: existing?.id || null, resolve, timer });
    native
      .collabSend(r.id, {
        type: 'hello',
        proto: COLLAB_PROTO,
        shareId: share.id,
        guestId: me.id,
        name: me.name,
        code: String(code || '').trim(),
      })
      .catch(() => {});
  });
}
function onJoinReply(connId, j, msg) {
  clearTimeout(j.timer);
  joins.delete(connId);
  if (msg.type !== 'welcome') {
    native.collabClose(connId).catch(() => {});
    return j.resolve({ error: msg.text || '加入失败', reason: msg.reason });
  }
  const hostMeta = { id: msg.hostId, name: msg.hostName, address: j.host.address, port: j.host.port };
  let pid = j.existing;
  if (pid && storage.projectById(pid)) {
    const c = storage.collabOf(pid);
    c.secret = msg.secret;
    c.host = hostMeta;
    if (!sessions.has(pid)) openSession(pid);
    storage.switchProject(pid);
  } else {
    pid = storage.createProject(
      msg.doc?.meta?.title || j.share.title || '协作项目',
      [],
      {},
      {
        collab: { id: msg.shareId, role: 'guest', secret: msg.secret, host: hostMeta, pos: {}, maxId: 0, unsent: [] },
      },
    );
    openSession(pid);
  }
  const s = sessions.get(pid);
  adopt(s, connId, msg);
  clearUndo();
  j.resolve({ ok: true, projectId: pid });
}
/* 收到主机的整份内容：换上，再把本机没同步的改动叠上去、补发 */
function adopt(s, connId, msg) {
  s.conn = connId;
  conns.set(connId, s);
  const project = projectOf(s.pid);
  sync.localChanges(s.rep, project); // 不在线：最新的改动记成键
  const redo = sync.guestAdopt(s.rep, project, msg.doc);
  const c = metaOf(s);
  c.host = { ...(c.host || {}), id: msg.hostId, name: msg.hostName };
  s.status = 'online';
  s.peer = msg.hostName || '主机';
  s.peerSel = null;
  if (redo) send(s, redo);
  saveMeta(s);
  if (s.pid === state.projectId) {
    clearUndo(); // 内容整份换过，旧的撤销步对不上了
    const first = state.rows.find(r => r.kind === 'line');
    if (!state.rows.some(r => r.id === state.sel)) state.sel = first?.id ?? null;
  }
  afterRemote(s, null, { full: true });
  syncDiscovery();
  changed();
  sendPresence(true);
}
export function leaveShare(pid = state.projectId) {
  const s = sessions.get(pid);
  if (!s || s.rep.role !== 'guest') return false;
  if (s.conn) send(s, { type: 'bye', reason: 'left' });
  setTimeout(() => endSession(s), s.conn ? 200 : 0);
  return true;
}
/* 钥匙失效（主机那边有人重新配对过）：输新的配对码重连 */
export async function repair(code, pid = state.projectId) {
  const s = sessions.get(pid);
  const c = s && metaOf(s);
  if (!c || s.rep.role !== 'guest') return { error: '这个项目没有在协作' };
  const host = hosts.find(h => h.hostId === c.host?.id) || c.host;
  if (!host?.address) return { error: '在局域网里没找到主机，确认对方开着分镜台' };
  clearTimeout(s.retry);
  const r = await joinShare(host, { id: c.id, title: projectOf(pid)?.title }, code);
  if (r.error) s.status = r.reason === 'code' ? 'needs-code' : s.status;
  changed();
  return r;
}

function scheduleReconnect(s, delay = 3000) {
  clearTimeout(s.retry);
  s.retry = setTimeout(() => reconnect(s), delay);
  syncDiscovery();
}
async function reconnect(s) {
  if (sessions.get(s.pid) !== s || s.conn || s.connecting || s.rep.role !== 'guest' || s.status === 'needs-code')
    return;
  const c = metaOf(s);
  if (!c) return;
  const found = hosts.find(h => h.hostId === c.host?.id && h.shares.some(x => x.id === c.id));
  const target = found || c.host;
  if (!target?.address) return scheduleReconnect(s, 10000);
  s.connecting = true;
  const r = await native.collabConnect({ address: target.address, port: target.port }).catch(() => ({ error: 'x' }));
  s.connecting = false;
  if (sessions.get(s.pid) !== s || s.conn) {
    // 等连接的这会儿项目退出了协作，或者已经用配对码重新连上了
    if (r?.id) native.collabClose(r.id).catch(() => {});
    return;
  }
  if (!r || r.error) return scheduleReconnect(s, found ? 5000 : 10000);
  if (found) c.host = { ...c.host, address: found.address, port: found.port };
  s.conn = r.id;
  conns.set(r.id, s);
  s.status = 'connecting';
  changed();
  send(s, { type: 'hello', proto: COLLAB_PROTO, shareId: c.id, guestId: me.id, name: me.name, secret: c.secret });
}
function onDenied(s, msg) {
  conns.delete(s.conn);
  native.collabClose(s.conn).catch(() => {});
  s.conn = null;
  const title = projectOf(s.pid)?.title || '这个项目';
  if (msg.reason === 'stopped') {
    notify(`主机已停止共享「${title}」，它现在是你的普通项目，内容都在`, null, 'info');
    return endSession(s, { closeConn: false });
  }
  if (msg.reason === 'auth' || msg.reason === 'code') {
    s.status = 'needs-code';
    notify(`「${title}」需要重新输入配对码才能继续协作`, null, 'warn');
    return changed();
  }
  s.status = 'offline';
  notify(msg.text || '连接被拒绝', null, 'warn');
  changed();
  scheduleReconnect(s, 15000);
}
function onBye(s, msg) {
  const title = projectOf(s.pid)?.title || '这个项目';
  const who = s.peer || '对方';
  if (s.rep.role === 'host') {
    const c = metaOf(s);
    if (msg.reason === 'left' && c) {
      c.guest = null;
      c.secret = '';
    }
    dropConn(s);
    notify(`${who} 退出了协作`, null, 'info');
    return;
  }
  const text =
    msg.reason === 'replaced'
      ? `主机那边有别人用配对码加入了「${title}」，你已退出协作，项目内容都在`
      : msg.reason === 'deleted'
        ? `${who} 删除了共享的项目。「${title}」现在是你的普通项目，内容都在`
        : `${who} 停止了共享。「${title}」现在是你的普通项目，内容都在`;
  notify(text, null, 'info');
  endSession(s);
}
/* 连接断了（不是主动退出） */
function dropConn(s) {
  if (s.conn) conns.delete(s.conn);
  s.conn = null;
  s.peerSel = null;
  if (s.rep.role === 'host') {
    s.rep.online = false;
    s.status = 'waiting';
  } else {
    flush(s);
    sync.goOffline(s.rep);
    if (s.status !== 'needs-code') s.status = 'offline';
    saveMeta(s);
    scheduleReconnect(s);
  }
  changed();
}

/* ── 网络事件 ── */
function onNetEvent(evt) {
  if (evt.type === 'hosts') {
    hosts = (evt.hosts || []).filter(h => h.hostId !== me.id);
    emit('collab-changed');
    for (const s of sessions.values()) if (s.rep.role === 'guest' && !s.conn) reconnect(s);
    return;
  }
  if (evt.type === 'open') {
    if (evt.incoming)
      waiting.set(
        evt.id,
        setTimeout(() => {
          waiting.delete(evt.id);
          native.collabClose(evt.id).catch(() => {});
        }, 15000),
      );
    return;
  }
  if (evt.type === 'close') {
    clearTimeout(waiting.get(evt.id));
    waiting.delete(evt.id);
    const j = joins.get(evt.id);
    if (j) {
      clearTimeout(j.timer);
      joins.delete(evt.id);
      j.resolve({ error: '连接断开了，稍后再试' });
    }
    const s = conns.get(evt.id);
    if (s && s.conn === evt.id) {
      const was = s.status === 'online';
      dropConn(s);
      if (was)
        notify(
          `和 ${s.peer || '对方'} 的连接断了，${s.rep.role === 'guest' ? '正在重连' : '等对方重新连上'}；这期间的改动不会丢`,
          null,
          'warn',
        );
    }
    conns.delete(evt.id);
    return;
  }
  if (evt.type !== 'message' || !evt.msg || typeof evt.msg !== 'object') return;
  const msg = evt.msg;
  if (msg.type === 'hello') return onHello(evt.id, msg);
  if (msg.type === 'list') {
    clearTimeout(waiting.get(evt.id));
    waiting.delete(evt.id);
    native
      .collabSend(evt.id, { type: 'shares', hostId: me.id, name: me.name, proto: COLLAB_PROTO, shares: shareList() })
      .catch(() => {});
    return;
  }
  const j = joins.get(evt.id);
  if (j) return onJoinReply(evt.id, j, msg);
  const s = conns.get(evt.id);
  if (!s || s.conn !== evt.id) return;
  if (msg.type === 'welcome') return adopt(s, evt.id, msg);
  if (msg.type === 'denied') return onDenied(s, msg);
  if (msg.type === 'ops') return onOps(s, msg);
  if (msg.type === 'ack') {
    sync.receiveAck(s.rep, msg.n);
    return saveMeta(s);
  }
  if (msg.type === 'here') {
    s.peerSel = msg.sel ?? null;
    if (msg.name && msg.name !== s.peer) {
      s.peer = String(msg.name).slice(0, 40);
      changed();
    }
    return emit('collab-presence');
  }
  if (msg.type === 'bye') return onBye(s, msg);
  if (msg.type === 'file-req') return files.onRequest(s, msg);
  if (msg.type === 'file-info-req') return files.onInfoRequest(s, msg);
  if (msg.type === 'file-ready' || msg.type === 'file-none' || msg.type === 'file-info') return files.onReply(msg);
}

/* 手动输入地址（广播被路由器挡住时）：问一下这台主机在共享什么 */
export async function queryHost(address) {
  const [ip, port] = String(address || '')
    .trim()
    .split(':');
  if (!ip) return { error: '先填对方的地址' };
  const r = await native
    .collabConnect({ address: ip, port: Number(port) || undefined })
    .catch(() => ({ error: '连不上' }));
  if (!r || r.error) return { error: r?.error || '连不上' };
  return new Promise(resolve => {
    const done = msg => {
      clearTimeout(timer);
      queries.delete(r.id);
      native.collabClose(r.id).catch(() => {});
      if (msg?.type !== 'shares') return resolve({ error: '对方没有在共享' });
      const shares = Array.isArray(msg.shares) ? msg.shares : [];
      const host = { hostId: msg.hostId, name: msg.name, address: ip, port: Number(port) || undefined, shares };
      manualHosts = [host, ...manualHosts.filter(h => h.hostId !== host.hostId)];
      changed();
      resolve({ ok: true, host });
    };
    const timer = setTimeout(() => done(null), 8000);
    queries.set(r.id, done);
    native.collabSend(r.id, { type: 'list' }).catch(() => {});
  });
}

/* ── 文件位置只算本机：重新定位失联文件、从对方电脑取过来的文件，对方那边的路径不跟着改 ── */
const isLocalFile = p => typeof p === 'string' && p.startsWith('/');
function mapLocalPath(s, from, to) {
  const c = metaOf(s);
  if (!c || !isLocalFile(from) || !to || from === to) return;
  c.pathMap ||= {};
  const shared = Object.entries(c.pathMap).find(([, local]) => local === from)?.[0] || from;
  if (shared === to) delete c.pathMap[shared];
  else c.pathMap[shared] = to;
  s.rep.pathMap = c.pathMap;
  saveMeta(s);
}

/* ── 对方停在哪句 ── */
let presenceTimer = null;
function sendPresence(force = false) {
  clearTimeout(presenceTimer);
  presenceTimer = setTimeout(() => {
    for (const s of sessions.values()) {
      if (!s.conn || s.status !== 'online') continue;
      const sel = s.pid === state.projectId ? state.sel : null;
      if (!force && s.sentSel === sel) continue;
      s.sentSel = sel;
      send(s, { type: 'here', sel, name: me.name });
    }
  }, 120);
}

/* ── 找局域网里的主机：协作面板开着，或有离线的访客项目要重连时才听广播 ── */
async function syncDiscovery() {
  const need = watching || [...sessions.values()].some(s => s.rep.role === 'guest' && !s.conn);
  if (need === discovering) return;
  discovering = need;
  if (need) {
    const r = await native.collabDiscover(true).catch(() => null);
    if (r?.hosts) hosts = r.hosts.filter(h => h.hostId !== me.id);
    if (r && r.ok === false)
      notify('没能在局域网里查找：可能被别的程序占用了端口，可以用「输入地址」加入', null, 'warn');
  } else {
    hosts = [];
    native.collabDiscover(false).catch(() => {});
  }
  changed();
}
export function watchHosts(on) {
  watching = !!on;
  syncDiscovery();
}

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
  clearUndo(); // 整库已被替换，旧项目内容对应的历史不再适用。
  for (const s of sessions.values()) {
    clearTimeout(s.timer);
    clearTimeout(s.retry);
    if (s.conn) native.collabClose(s.conn).catch(() => {});
  }
  sessions.clear();
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
    const q = queries.get(evt.id);
    if (q && (evt.type === 'message' || evt.type === 'close')) return q(evt.msg);
    onNetEvent(evt);
  });
  storage.onProjectWrite(id => {
    const s = sessions.get(id);
    if (s) scheduleFlush(s);
  });
  setSnapshotHooks({
    mark: pid => sessions.get(pid)?.rep.seq,
    rebase: (data, u) => {
      const s = sessions.get(u.projectId);
      if (s && u.mark != null) sync.rebaseSnapshot(s.rep, data, u.mark);
    },
  });
  on('project-removed', ({ id, collab }) => {
    const s = sessions.get(id);
    if (!s) return;
    if (s.conn) send(s, { type: 'bye', reason: collab?.role === 'host' ? 'deleted' : 'left' });
    setTimeout(() => endSession(s), s.conn ? 200 : 0);
  });
  // 重新定位失联文件只算这台电脑的事：对方那边的路径不跟着改（各自电脑上的文件位置不一样）
  on('asset-relocated', ({ moves }) => {
    const s = sessions.get(state.projectId);
    if (!s) return;
    for (const [from, to] of moves || []) mapLocalPath(s, from, to);
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
