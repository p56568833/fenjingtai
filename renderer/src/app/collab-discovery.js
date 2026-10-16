/* 主机发现和手动地址查询。会话、配对和重连由调用方负责。 */
import * as native from '../platform/native.js';
import { notify } from './events.js';
export function createCollabDiscovery({ myId, needsReconnect, changed, onHosts }) {
  let hosts = [],
    manualHosts = [],
    watching = false,
    discovering = false;
  const queries = new Map();
  async function queryHost(address) {
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

  async function syncDiscovery() {
    const need = watching || needsReconnect();
    if (need === discovering) return;
    discovering = need;
    if (need) {
      const r = await native.collabDiscover(true).catch(() => null);
      if (r?.hosts) hosts = r.hosts.filter(h => h.hostId !== myId());
      if (r && r.ok === false)
        notify('没能在局域网里查找：可能被别的程序占用了端口，可以用「输入地址」加入', null, 'warn');
    } else {
      hosts = [];
      native.collabDiscover(false).catch(() => {});
    }
    changed();
  }
  function watchHosts(on) {
    watching = !!on;
    syncDiscovery();
  }

  return {
    queryHost,
    watchHosts,
    sync: syncDiscovery,
    broadcastHosts: () => hosts,
    snapshot: () => ({
      hosts: [...hosts, ...manualHosts.filter(m => !hosts.some(h => h.hostId === m.hostId))],
      discovering,
    }),
    handleEvent(evt) {
      const q = queries.get(evt.id);
      if (q && (evt.type === 'message' || evt.type === 'close')) {
        q(evt.msg);
        return true;
      }
      if (evt.type !== 'hosts') return false;
      hosts = (evt.hosts || []).filter(h => h.hostId !== myId());
      changed();
      onHosts();
      return true;
    },
  };
}
