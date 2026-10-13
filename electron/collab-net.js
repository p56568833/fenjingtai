/* 局域网协作的网络层（只管收发，不懂项目数据；不依赖 Electron，主进程测试里直接 require）：
   · 主机：开一个 TCP 服务；每 2 秒用 UDP 广播一次「我在共享哪些项目」，同一局域网里的分镜台就能找到它。
   · 访客：监听广播，列出局域网里正在共享的项目；连上主机后双方按行收发 JSON 消息。
   · 配对码、项目内容、合并规则都在界面进程里处理，这里只转消息。 */
const net = require('node:net');
const dgram = require('node:dgram');
const os = require('node:os');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DISCOVERY_PORT = 47390;
const SERVICE_PORT = 47391;
const MAX_LINE = 512 * 1024 * 1024; // 一条消息最大 512 MB（整份项目内容），超了当坏连接断掉
const HOST_TTL = 7000;

/* 本机在局域网里的 IPv4 地址和对应的广播地址 */
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal || !a.netmask) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      out.push({ address: a.address, broadcast: ip.map((b, i) => (b & mask[i]) | (~mask[i] & 255)).join('.') });
    }
  return out;
}

function createCollabNet({
  emit,
  discoveryPort = DISCOVERY_PORT,
  servicePort = SERVICE_PORT,
  announceMs = 2000,
  extraTargets = [],
} = {}) {
  const conns = new Map(); // id → socket
  let server = null;
  let serverPort = 0;
  let announcement = null;
  let announcer = null;
  let announceTimer = null;
  let listener = null;
  let pruneTimer = null;
  const hosts = new Map(); // hostId → { hostId, name, address, port, shares, seen }
  const fire = evt => {
    try {
      emit?.(evt);
    } catch (error) {
      console.error('协作事件转发失败', error);
    }
  };

  /* 一条连接：按换行切消息。pending：判断连接用途时已经读到的字节 */
  function attach(socket, info, pending = null) {
    const id = crypto.randomUUID();
    conns.set(id, socket);
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 5000);
    let chunks = [];
    let size = 0;
    const onData = data => {
      let start = 0;
      for (let i = data.indexOf(10); i >= 0; i = data.indexOf(10, start)) {
        chunks.push(data.subarray(start, i));
        const line = Buffer.concat(chunks).toString('utf8');
        chunks = [];
        size = 0;
        start = i + 1;
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          socket.destroy();
          return;
        }
        fire({ type: 'message', id, msg });
      }
      if (start < data.length) {
        chunks.push(data.subarray(start));
        size += data.length - start;
        if (size > MAX_LINE) socket.destroy();
      }
    };
    socket.on('data', onData);
    let closed = false;
    const done = reason => {
      if (closed) return;
      closed = true;
      conns.delete(id);
      fire({ type: 'close', id, reason });
    };
    socket.on('error', err => done(String(err?.code || err?.message || err)));
    socket.on('close', () => done('closed'));
    fire({ type: 'open', id, ...info });
    if (pending?.length) onData(pending);
    return id;
  }

  /* 连进来的连接先看第一行：取文件 / 送文件的连接在这里直接收发原始字节，其余交给 attach 当消息连接 */
  function routeIncoming(socket) {
    const info = { incoming: true, address: socket.remoteAddress?.replace(/^::ffff:/, '') };
    let buf = Buffer.alloc(0);
    let routed = false;
    const timer = setTimeout(() => !routed && socket.destroy(), 15000);
    const route = fn => {
      routed = true;
      clearTimeout(timer);
      socket.removeListener('data', onData);
      fn();
    };
    const onData = data => {
      buf = Buffer.concat([buf, data]);
      const i = buf.indexOf(10);
      if (i < 0) {
        if (buf.length > 64 * 1024) route(() => attach(socket, info, buf));
        return;
      }
      let head = null;
      try {
        head = JSON.parse(buf.subarray(0, i).toString('utf8'));
      } catch {
        /* 不是 JSON：交给消息连接按坏数据处理 */
      }
      if (head?.type === 'file-get') return route(() => serveFile(socket, head));
      if (head?.type === 'file-put') return route(() => receivePut(socket, head, buf.subarray(i + 1)));
      route(() => attach(socket, info, buf));
    };
    socket.on('data', onData);
    socket.on('error', () => {});
  }

  /* ── 传文件（局域网里把对方缺的素材文件拷过去）──
     两种方向都由访客发起连接（主机开着服务，访客不开）：
     · 访客取主机的文件：主机先登记 offer(token, 文件)，访客连上来发 file-get，主机回一行文件大小再发原始字节；
     · 主机取访客的文件：主机先登记 expect(token, 存到哪)，访客连上来发 file-put + 文件大小，再发原始字节。
     token 用一次就作废，只在 10 分钟内有效；只能取对方界面进程明确登记过的那一个文件。 */
  const offers = new Map(); // token → { path, expires }
  const expects = new Map(); // token → { dir, name, resolve, timer }
  const active = new Map(); // token → 取消函数
  const progress = (token, total) => {
    let last = 0;
    return done => {
      const now = Date.now();
      if (now - last < 200 && done < total) return;
      last = now;
      fire({ type: 'file-progress', token, done, total });
    };
  };
  const reserved = new Set();
  function freePath(dir, name) {
    const safe =
      String(name || 'file')
        .replace(/[/\\:\0]/g, '_')
        .replace(/^\.+/, '') || 'file';
    const dot = safe.lastIndexOf('.');
    const stem = dot > 0 ? safe.slice(0, dot) : safe;
    const ext = dot > 0 ? safe.slice(dot) : '';
    for (let i = 1; ; i++) {
      const p = path.join(dir, i === 1 ? safe : `${stem} (${i})${ext}`);
      if (!fs.existsSync(p) && !reserved.has(p)) {
        reserved.add(p);
        return p;
      }
    }
  }
  /* 收文件：先写 .part，收够字节数再改成正式文件名 */
  function createSink({ dir, name, size, token }) {
    fs.mkdirSync(dir, { recursive: true });
    const target = freePath(dir, name);
    const part = target + '.part';
    const out = fs.createWriteStream(part);
    const report = progress(token, size);
    let done = 0;
    let failed = null;
    out.on('error', err => (failed ||= err));
    const release = () => reserved.delete(target);
    return {
      write(chunk, socket) {
        done += chunk.length;
        report(done);
        if (!out.write(chunk) && socket) {
          socket.pause();
          out.once('drain', () => socket.resume());
        }
      },
      finish() {
        return new Promise(resolve =>
          out.end(() => {
            release();
            if (failed || done !== size) {
              fs.rm(part, { force: true }, () => {});
              return resolve({
                error: failed ? `存不下：${failed.code || failed.message}` : '文件没传完整（连接断了），再取一次',
              });
            }
            fs.rename(part, target, err =>
              err
                ? resolve({ error: `存不下：${err.code || err.message}` })
                : resolve({ ok: true, path: target, size }),
            );
          }),
        );
      },
      abort() {
        out.destroy();
        release();
        fs.rm(part, { force: true }, () => {});
      },
    };
  }
  function offerFile(token, file) {
    return new Promise(resolve =>
      fs.stat(file, (err, st) => {
        if (err || !st.isFile()) return resolve({ error: '这台电脑上也找不到这个文件' });
        offers.set(String(token), { path: file, expires: Date.now() + 10 * 60 * 1000 });
        resolve({ ok: true, size: st.size, name: path.basename(file) });
      }),
    );
  }
  function serveFile(socket, head) {
    const token = String(head.token || '');
    const o = offers.get(token);
    offers.delete(token);
    if (!o || o.expires < Date.now())
      return socket.end(JSON.stringify({ ok: false, error: '这次取文件过期了，再取一次' }) + '\n');
    fs.stat(o.path, (err, st) => {
      if (err) return socket.end(JSON.stringify({ ok: false, error: '这台电脑上也找不到这个文件' }) + '\n');
      socket.write(JSON.stringify({ ok: true, size: st.size }) + '\n');
      const rs = fs.createReadStream(o.path);
      rs.on('error', () => socket.destroy());
      socket.on('error', () => rs.destroy());
      rs.pipe(socket);
    });
  }
  /* 访客：从主机取文件 */
  function fetchFile({ address, port, token, dir, name }) {
    return new Promise(resolve => {
      const socket = net.connect({ host: String(address), port: Number(port) || servicePort });
      let head = null;
      let buf = Buffer.alloc(0);
      let sink = null;
      let settled = false;
      const end = r => {
        if (settled) return;
        settled = true;
        active.delete(token);
        resolve(r);
      };
      active.set(token, () => {
        socket.destroy();
        sink?.abort();
        end({ error: '已取消', canceled: true });
      });
      socket.on('connect', () => socket.write(JSON.stringify({ type: 'file-get', token }) + '\n'));
      socket.on('data', data => {
        if (!head) {
          buf = Buffer.concat([buf, data]);
          const i = buf.indexOf(10);
          if (i < 0) return;
          try {
            head = JSON.parse(buf.subarray(0, i).toString('utf8'));
          } catch {
            head = { ok: false, error: '对方发来的数据不对' };
          }
          if (!head.ok) {
            socket.destroy();
            return end({ error: head.error || '对方没给文件' });
          }
          try {
            sink = createSink({ dir, name, size: Number(head.size) || 0, token });
          } catch (err) {
            socket.destroy();
            return end({ error: `存不下：${err.code || err.message}` });
          }
          data = buf.subarray(i + 1);
        }
        if (data.length) sink.write(data, socket);
      });
      socket.on('close', async () => {
        if (settled) return;
        if (!sink) return end({ error: '连不上对方，或对方中途断开了' });
        end(await sink.finish());
      });
      socket.on('error', () => {});
    });
  }
  /* 主机：等访客把文件送过来 */
  function expectFile({ token, dir, name }, waitMs = 60000) {
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        expects.delete(token);
        resolve({ error: '对方没有把文件发过来' });
      }, waitMs);
      expects.set(String(token), { dir, name, resolve, timer });
      active.set(String(token), () => {
        clearTimeout(timer);
        expects.delete(token);
        resolve({ error: '已取消', canceled: true });
      });
    });
  }
  function receivePut(socket, head, rest) {
    const token = String(head.token || '');
    const e = expects.get(token);
    expects.delete(token);
    if (!e) return socket.destroy();
    clearTimeout(e.timer);
    let sink;
    try {
      sink = createSink({ dir: e.dir, name: e.name, size: Number(head.size) || 0, token });
    } catch (err) {
      socket.destroy();
      active.delete(token);
      return e.resolve({ error: `存不下：${err.code || err.message}` });
    }
    active.set(token, () => {
      socket.destroy();
      sink.abort();
      active.delete(token);
      e.resolve({ error: '已取消', canceled: true });
    });
    let finished = false;
    socket.on('data', chunk => sink.write(chunk, socket));
    socket.on('close', async () => {
      if (finished || !active.has(token)) return;
      finished = true;
      active.delete(token);
      e.resolve(await sink.finish());
    });
    socket.on('error', () => {});
    if (rest.length) sink.write(rest, socket);
  }
  /* 访客：把自己的文件送给主机 */
  function pushFile({ address, port, token, file }) {
    return new Promise(resolve =>
      fs.stat(file, (err, st) => {
        if (err || !st.isFile()) return resolve({ error: '这台电脑上也找不到这个文件' });
        const socket = net.connect({ host: String(address), port: Number(port) || servicePort });
        let ok = true;
        socket.on('connect', () => {
          socket.write(JSON.stringify({ type: 'file-put', token, size: st.size }) + '\n');
          const rs = fs.createReadStream(file);
          rs.on('error', () => {
            ok = false;
            socket.destroy();
          });
          rs.pipe(socket);
        });
        socket.on('error', () => (ok = false));
        socket.on('close', () => resolve(ok ? { ok: true } : { error: '传到一半断了' }));
      }),
    );
  }
  function cancelFile(token) {
    const cancel = active.get(String(token));
    if (!cancel) return false;
    cancel();
    return true;
  }

  /* ── 主机 ── */
  function listenOn(port) {
    return new Promise((resolve, reject) => {
      const s = net.createServer(routeIncoming);
      s.once('error', reject);
      s.listen(port, () => {
        s.removeListener('error', reject);
        s.on('error', err => console.error('协作服务出错', err));
        resolve(s);
      });
    });
  }
  async function startHost(info) {
    announcement = info || announcement;
    if (!server) {
      try {
        server = await listenOn(servicePort);
      } catch {
        server = await listenOn(0); // 端口被占了就随便要一个，广播里会带上
      }
      serverPort = server.address().port;
    }
    if (!announcer) {
      announcer = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      announcer.on('error', err => console.error('协作广播出错', err));
      await new Promise(resolve => announcer.bind(0, resolve));
      announcer.setBroadcast(true);
    }
    clearInterval(announceTimer);
    announceTimer = setInterval(announce, announceMs);
    announce();
    return { port: serverPort, addresses: lanAddresses().map(a => a.address) };
  }
  function announce() {
    if (!announcer || !announcement) return;
    const packet = Buffer.from(JSON.stringify({ app: 'fenjingtai', ...announcement, port: serverPort }));
    const targets = new Set(['255.255.255.255', ...lanAddresses().map(a => a.broadcast), ...extraTargets]);
    for (const t of targets) announcer.send(packet, discoveryPort, t, () => {});
  }
  function updateHost(info) {
    announcement = info;
    announce();
  }
  function stopHost() {
    clearInterval(announceTimer);
    announceTimer = null;
    const sock = announcer;
    announcer = null;
    if (sock && announcement) {
      // 告诉还在看列表的人：不共享了（发完再关，不然这一包会被丢掉）
      const packet = Buffer.from(JSON.stringify({ app: 'fenjingtai', ...announcement, shares: [], port: serverPort }));
      for (const t of new Set(['255.255.255.255', ...lanAddresses().map(a => a.broadcast), ...extraTargets]))
        sock.send(packet, discoveryPort, t, () => {});
    }
    announcement = null;
    if (sock)
      setTimeout(() => {
        try {
          sock.close();
        } catch {
          /* 已经关了 */
        }
      }, 300).unref?.();
    server?.close();
    server = null;
    serverPort = 0;
  }

  /* ── 找局域网里的主机 ── */
  const hostList = () => [...hosts.values()].map(({ seen: _seen, ...h }) => h);
  function startDiscovery() {
    if (listener) return Promise.resolve(true);
    listener = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    listener.on('message', (buf, rinfo) => {
      let p;
      try {
        p = JSON.parse(buf.toString('utf8'));
      } catch {
        return;
      }
      if (p?.app !== 'fenjingtai' || typeof p.hostId !== 'string' || !Number.isInteger(p.port)) return;
      const shares = Array.isArray(p.shares) ? p.shares.filter(s => s && typeof s.id === 'string') : [];
      const prev = hosts.get(p.hostId);
      const next = {
        hostId: p.hostId,
        name: String(p.name || '').slice(0, 60),
        proto: p.proto,
        version: String(p.version || ''),
        address: rinfo.address,
        port: p.port,
        shares: shares.map(s => ({ id: s.id, title: String(s.title || '').slice(0, 120) })),
        seen: Date.now(),
      };
      hosts.set(p.hostId, next);
      if (!shares.length) hosts.delete(p.hostId);
      const { seen: _a, ...a } = prev || {};
      const { seen: _b, ...b } = next;
      if (!prev || JSON.stringify(a) !== JSON.stringify(b) || !shares.length)
        fire({ type: 'hosts', hosts: hostList() });
    });
    pruneTimer = setInterval(() => {
      let changed = false;
      for (const [id, h] of hosts)
        if (Date.now() - h.seen > HOST_TTL) {
          hosts.delete(id);
          changed = true;
        }
      if (changed) fire({ type: 'hosts', hosts: hostList() });
    }, 2000);
    return new Promise(resolve => {
      listener.once('error', err => {
        console.error('协作发现出错', err);
        stopDiscovery();
        resolve(false);
      });
      listener.bind(discoveryPort, () => resolve(true));
    });
  }
  function stopDiscovery() {
    clearInterval(pruneTimer);
    pruneTimer = null;
    try {
      listener?.close();
    } catch {
      /* 已经关了 */
    }
    listener = null;
    hosts.clear();
  }

  /* ── 连接 ── */
  function connect({ address, port }, timeoutMs = 5000) {
    return new Promise(resolve => {
      const socket = net.connect({ host: String(address), port: Number(port) || servicePort });
      const timer = setTimeout(() => {
        socket.destroy();
        resolve({ error: '连不上：对方没有响应' });
      }, timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve({ id: attach(socket, { incoming: false, address: String(address) }) });
      });
      socket.once('error', err => {
        clearTimeout(timer);
        resolve({
          error: err?.code === 'ECONNREFUSED' ? '连不上：对方没有在共享' : `连不上：${err?.code || err?.message}`,
        });
      });
    });
  }
  function send(id, msg) {
    const socket = conns.get(id);
    if (!socket || socket.destroyed) return false;
    socket.write(JSON.stringify(msg) + '\n');
    return true;
  }
  function close(id) {
    const socket = conns.get(id);
    if (!socket) return false;
    socket.end();
    setTimeout(() => socket.destroy(), 1000).unref?.();
    return true;
  }
  function dispose() {
    for (const socket of conns.values()) socket.destroy();
    conns.clear();
    for (const cancel of [...active.values()]) cancel();
    stopHost();
    stopDiscovery();
  }
  return {
    startHost,
    updateHost,
    stopHost,
    startDiscovery,
    stopDiscovery,
    hosts: hostList,
    connect,
    send,
    close,
    dispose,
    offerFile,
    fetchFile,
    expectFile,
    pushFile,
    cancelFile,
    addresses: () => lanAddresses().map(a => a.address),
  };
}

module.exports = { createCollabNet, lanAddresses, DISCOVERY_PORT, SERVICE_PORT };
