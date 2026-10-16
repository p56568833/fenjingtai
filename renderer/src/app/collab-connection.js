/* 连接协议：握手、配对、掉线和重连；项目副本与撤销只经 session 接口处理。 */
import { state } from './state.js';
import { emit, notify } from './events.js';
import { update } from './project-events.js';
import * as storage from './storage.js';
import { clearUndo } from './undo.js';
import { applyRemoteProject } from './collab-apply.js';
import { COLLAB_PROTO } from '../core/collab-doc.js';
import * as native from '../platform/native.js';
import { transitionSession } from '../core/collab-session-state.js';

export function createCollabConnection({
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
}) {
  const { sessions, openSession, saveMeta, flush, onOps } = session;
  const joins = new Map();
  const waiting = new Map();
  const projectOf = storage.projectForId;
  const metaOf = s => storage.collabOf(s.pid);
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
    const doc = session.hostDoc(s);
    s.conn = connId;
    conns.set(connId, s);
    transitionSession(s, 'online');
    s.peer = c.guest.name;
    s.peerSel = null;
    saveMeta(s);
    reply({ type: 'welcome', shareId: c.id, secret: c.secret, hostId: me.id, hostName: me.name, doc });
    notify(`${s.peer} 加入了协作`, null, 'ok');
    changed();
    sendPresence(true);
  }

  /* ── 访客 ── */
  async function joinShare(host, share, code) {
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
    const redo = session.adoptDocument(s, msg.doc);
    const c = metaOf(s);
    c.host = { ...(c.host || {}), id: msg.hostId, name: msg.hostName };
    transitionSession(s, 'online');
    s.peer = msg.hostName || '主机';
    s.peerSel = null;
    if (redo) send(s, redo);
    saveMeta(s);
    applyRemoteProject(s, null, { full: true });
    discovery.sync();
    changed();
    sendPresence(true);
  }
  function leaveShare(pid = state.projectId) {
    const s = sessions.get(pid);
    if (!s || s.rep.role !== 'guest') return false;
    if (s.conn) send(s, { type: 'bye', reason: 'left' });
    setTimeout(() => endSession(s), s.conn ? 200 : 0);
    return true;
  }
  /* 钥匙失效（主机那边有人重新配对过）：输新的配对码重连 */
  async function repair(code, pid = state.projectId) {
    const s = sessions.get(pid);
    const c = s && metaOf(s);
    if (!c || s.rep.role !== 'guest') return { error: '这个项目没有在协作' };
    const host = discovery.broadcastHosts().find(h => h.hostId === c.host?.id) || c.host;
    if (!host?.address) return { error: '在局域网里没找到主机，确认对方开着分镜台' };
    clearTimeout(s.retry);
    const r = await joinShare(host, { id: c.id, title: projectOf(pid)?.title }, code);
    if (r.error && r.reason === 'code') transitionSession(s, 'needs-code');
    changed();
    return r;
  }

  function scheduleReconnect(s, delay = 3000) {
    clearTimeout(s.retry);
    s.retry = setTimeout(() => reconnect(s), delay);
    discovery.sync();
  }
  async function reconnect(s) {
    if (sessions.get(s.pid) !== s || s.conn || s.connecting || s.rep.role !== 'guest' || s.status === 'needs-code')
      return;
    const c = metaOf(s);
    if (!c) return;
    const found = discovery.broadcastHosts().find(h => h.hostId === c.host?.id && h.shares.some(x => x.id === c.id));
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
    transitionSession(s, 'connecting');
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
      transitionSession(s, 'needs-code');
      notify(`「${title}」需要重新输入配对码才能继续协作`, null, 'warn');
      return changed();
    }
    transitionSession(s, 'offline');
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
    session.offline(s);
    if (s.rep.role === 'host') {
      transitionSession(s, 'waiting');
    } else {
      if (s.status !== 'needs-code') transitionSession(s, 'offline');
      saveMeta(s);
      scheduleReconnect(s);
    }
    changed();
  }

  /* ── 网络事件 ── */
  function onNetEvent(evt) {
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
      return session.acknowledge(s, msg.n);
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

  function reset() {
    for (const [id, j] of joins) {
      clearTimeout(j.timer);
      native.collabClose(id).catch(() => {});
      j.resolve({ error: '项目库已恢复，请重新加入' });
    }
    for (const [id, timer] of waiting) {
      clearTimeout(timer);
      native.collabClose(id).catch(() => {});
    }
    joins.clear();
    waiting.clear();
  }
  return { joinShare, leaveShare, repair, scheduleReconnect, reconnect, onNetEvent, reset };
}
