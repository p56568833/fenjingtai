/* 局域网协作的同步规则回归（不需要 Electron）：两边同时改、乱序送达、断线重连、各自保存视频片段，最后两边必须一样。
   用法：node scripts/collab-test.mjs */
import assert from 'node:assert/strict';
import {
  keyBetween,
  keysBetween,
  assignPositions,
  stable,
  nextRowId,
  makeCtx,
  sharedRow,
  sharedAsset,
  sharedCand,
  META_KEYS,
} from '../renderer/src/core/collab-doc.js';
import {
  createReplica,
  localChanges,
  receiveOps,
  receiveAck,
  goOffline,
  hostDoc,
  guestAdopt,
  rebaseSnapshot,
  parityOf,
  LOG_MAX,
} from '../renderer/src/core/collab-sync.js';
import { remotePath, swapToLocal, attachCandidate } from '../renderer/src/core/candidates.js';

let count = 0;
const test = (name, fn) => {
  fn();
  count++;
  console.log('✓', name);
};

/* 伪随机（固定种子，失败可复现） */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const sample = () => ({
  title: '示例',
  speechRate: 4.5,
  types: [{ id: 'a', label: 'A', full: 'A roll', color: '#111111', icon: 'a', visual: false }],
  timing: null,
  voice: null,
  rows: [
    { id: 1, kind: 'section', text: '第一章' },
    ...Array.from({ length: 12 }, (_, i) => ({
      id: i + 2,
      kind: 'line',
      text: `第${i + 1}句。`,
      note: '',
      type: null,
    })),
  ],
  assets: {},
  candidates: [],
});

/* 共享形态的指纹：两边比这个 */
function fingerprint(p, pathMap = {}) {
  const ctx = makeCtx(p, pathMap);
  return stable({
    meta: Object.fromEntries(META_KEYS.map(k => [k, k === 'speechRate' ? Number(p[k]) || 4.5 : (p[k] ?? null)])),
    rows: p.rows.map(r => sharedRow(r, ctx)),
    assets: Object.fromEntries(Object.entries(p.assets).map(([k, a]) => [k, sharedAsset(a, ctx)])),
    cands: p.candidates.map(sharedCand),
  });
}

/* 一对连起来的副本：消息排队，按方向保序，什么时候送达由测试决定 */
function pair(project = sample()) {
  const host = { p: structuredClone(project), q: [] };
  host.rep = createReplica(host.p, { role: 'host' });
  const guest = { p: { rows: [], assets: {}, candidates: [] }, q: [] };
  guest.rep = createReplica(guest.p, { role: 'guest' });
  guestAdopt(guest.rep, guest.p, hostDoc(host.rep));
  const flush = side => {
    const msg = localChanges(side.rep, side.p);
    if (msg) (side === host ? guest : host).q.push(msg);
  };
  const deliver = (to, n = Infinity) => {
    const from = to === host ? guest : host;
    while (n-- > 0 && to.q.length) {
      flush(to); // 合对方改动之前先把自己的发出去（和应用里一样）
      const msg = to.q.shift();
      if (msg.type === 'ack') receiveAck(to.rep, msg.n);
      else {
        const { reply } = receiveOps(to.rep, to.p, msg);
        if (reply) from.q.push(reply);
      }
    }
  };
  const settle = () => {
    for (let i = 0; i < 50 && (host.q.length || guest.q.length || true); i++) {
      flush(host);
      flush(guest);
      if (!host.q.length && !guest.q.length) break;
      deliver(host);
      deliver(guest);
    }
  };
  return { host, guest, flush, deliver, settle };
}

const lineRows = p => p.rows.filter(r => r.kind === 'line');
const newId = (side, role) => nextRowId(side.p.rows, { parity: parityOf(role), floor: side.rep.base.maxId });

test('位置键：总在两者之间，批量取键有序、不重复', () => {
  assert.ok(keyBetween('', null) > '');
  assert.ok(keyBetween('a', 'b') > 'a' && keyBetween('a', 'b') < 'b');
  assert.ok(keyBetween('a', 'a1') > 'a' && keyBetween('a', 'a1') < 'a1');
  assert.ok(keyBetween('zz', null) > 'zz');
  const keys = keysBetween('', null, 500, '1');
  for (let i = 1; i < keys.length; i++) assert.ok(keys[i - 1] < keys[i]);
  assert.ok(Math.max(...keys.map(k => k.length)) <= 6, '500 句的键也很短');
  let lo = 'm',
    hi = 'n';
  for (let i = 0; i < 60; i++) {
    const k = keyBetween(lo, hi);
    assert.ok(k > lo && k < hi);
    hi = k; // 一直往同一处插
  }
});

test('位置键：只给新句和挪过的句子换键', () => {
  const prev = { 1: 'a', 2: 'b', 3: 'c', 4: 'd' };
  const { pos, changed } = assignPositions([1, 3, 2, 9, 4], prev, '1');
  assert.equal(changed.length, 2, '只动挪过的那句和新句');
  assert.ok(changed.includes(9));
  const order = [1, 3, 2, 9, 4].map(id => pos[id]);
  for (let i = 1; i < order.length; i++) assert.ok(order[i - 1] < order[i]);
});

test('新句编号：主机双数、访客单数，删掉的编号不再用', () => {
  const rows = [{ id: 7 }, { id: 3 }];
  assert.equal(nextRowId(rows), 8);
  assert.equal(nextRowId(rows, { parity: 0 }), 8);
  assert.equal(nextRowId(rows, { parity: 1 }), 9);
  assert.equal(nextRowId(rows, { parity: 0, floor: 20 }), 22);
});

test('加入：访客拿到整份内容，和主机一样', () => {
  const { host, guest } = pair();
  assert.equal(fingerprint(guest.p), fingerprint(host.p));
  assert.equal(guest.p.rows.length, 13);
});

test('两人改同一句的不同地方：都保留；改同一处：以后到主机的为准，两边一致', () => {
  const { host, guest, settle } = pair();
  host.p.rows[2].type = 'a';
  guest.p.rows[2].note = '近景';
  host.p.rows[3].note = '主机写的';
  guest.p.rows[3].note = '访客写的';
  settle();
  assert.equal(fingerprint(guest.p), fingerprint(host.p));
  assert.equal(host.p.rows[2].type, 'a');
  assert.equal(host.p.rows[2].note, '近景');
  assert.ok(['主机写的', '访客写的'].includes(host.p.rows[3].note));
});

test('两人同时在同一处插句：两句都在，顺序两边一样', () => {
  const { host, guest, settle } = pair();
  host.p.rows.splice(3, 0, { id: newId(host, 'host'), kind: 'line', text: '主机插的', note: '', type: null });
  guest.p.rows.splice(3, 0, { id: newId(guest, 'guest'), kind: 'line', text: '访客插的', note: '', type: null });
  settle();
  assert.equal(fingerprint(guest.p), fingerprint(host.p));
  assert.equal(host.p.rows.length, 15);
  assert.ok(host.p.rows.some(r => r.text === '主机插的') && host.p.rows.some(r => r.text === '访客插的'));
});

test('一边删句、另一边同时改这句：删除生效', () => {
  const { host, guest, settle } = pair();
  const id = host.p.rows[5].id;
  host.p.rows.splice(5, 1);
  guest.p.rows.find(r => r.id === id).note = '改了';
  settle();
  assert.equal(fingerprint(guest.p), fingerprint(host.p));
  assert.ok(!guest.p.rows.some(r => r.id === id));
});

test('挪动句子顺序，两边一致', () => {
  const { host, guest, settle } = pair();
  const [moved] = host.p.rows.splice(2, 1);
  host.p.rows.splice(8, 0, moved);
  const [g] = guest.p.rows.splice(10, 1);
  guest.p.rows.splice(1, 0, g);
  settle();
  assert.equal(fingerprint(guest.p), fingerprint(host.p));
});

test('随机并发改动 300 轮（乱序送达）：两边最后完全一样', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const rand = rng(seed);
    const { host, guest, flush, deliver, settle } = pair();
    const pick = arr => arr[Math.floor(rand() * arr.length)];
    for (let step = 0; step < 40; step++) {
      const side = rand() < 0.5 ? host : guest;
      const role = side === host ? 'host' : 'guest';
      const rows = side.p.rows;
      const act = rand();
      if (act < 0.3 && lineRows(side.p).length) pick(lineRows(side.p)).note = `n${seed}-${step}`;
      else if (act < 0.45 && lineRows(side.p).length) pick(lineRows(side.p)).type = rand() < 0.5 ? 'a' : null;
      else if (act < 0.6) {
        const at = Math.floor(rand() * (rows.length + 1));
        rows.splice(at, 0, { id: newId(side, role), kind: 'line', text: `新${seed}-${step}`, note: '', type: null });
      } else if (act < 0.7 && rows.length > 3) rows.splice(Math.floor(rand() * rows.length), 1);
      else if (act < 0.8 && rows.length > 2) {
        const [r] = rows.splice(Math.floor(rand() * rows.length), 1);
        rows.splice(Math.floor(rand() * (rows.length + 1)), 0, r);
      } else if (act < 0.85) side.p.title = `标题${seed}-${step}`;
      else if (act < 0.9) {
        const id = `as${Math.floor(rand() * 4)}`;
        if (side.p.assets[id] && rand() < 0.3) delete side.p.assets[id];
        else side.p.assets[id] = { id, kind: 'image', path: `/共享/${id}-${step}.jpg`, name: `${id}.jpg` };
      } else if (lineRows(side.p).length) {
        const r = pick(lineRows(side.p));
        const ids = Object.keys(side.p.assets);
        if (ids.length) r.assetUsages = [{ assetId: pick(ids) }];
      }
      if (rand() < 0.5) flush(side);
      if (rand() < 0.4) deliver(rand() < 0.5 ? host : guest, 1);
    }
    settle();
    assert.equal(fingerprint(guest.p), fingerprint(host.p), `种子 ${seed} 两边不一致`);
    // 句子编号两边不会撞
    assert.equal(new Set(host.p.rows.map(r => r.id)).size, host.p.rows.length, `种子 ${seed} 编号重复`);
  }
});

test('访客断线期间的改动：重连后补发；主机同时期的改动也在', () => {
  const { host, guest } = pair();
  goOffline(guest.rep);
  host.rep.online = false;
  guest.p.rows[4].note = '离线时写的';
  guest.p.rows.splice(6, 0, { id: newId(guest, 'guest'), kind: 'line', text: '离线插的', note: '', type: null });
  localChanges(guest.rep, guest.p);
  host.p.rows[8].note = '主机这边改的';
  host.p.title = '主机改了名';
  localChanges(host.rep, host.p);
  // 访客重启：只剩存盘的「没送出去的键」
  const unsent = [...guest.rep.offline];
  const restarted = createReplica(guest.p, { role: 'guest', pos: guest.rep.base.pos, unsent });
  // 重连：主机先发整份内容
  const doc = hostDoc(host.rep);
  localChanges(restarted, guest.p);
  const redo = guestAdopt(restarted, guest.p, doc);
  assert.ok(redo && redo.ops.length);
  const { reply } = receiveOps(host.rep, host.p, redo);
  receiveAck(restarted, reply.n);
  assert.equal(fingerprint(guest.p), fingerprint(host.p));
  assert.equal(host.p.rows.find(r => r.text === '第4句。').note, '离线时写的');
  assert.ok(host.p.rows.some(r => r.text === '离线插的'));
  assert.equal(guest.p.title, '主机改了名');
  assert.equal(guest.p.rows.find(r => r.text === '第8句。').note, '主机这边改的');
});

test('视频片段各存各的：访客保存到本机，主机的素材和片段时间不受影响', () => {
  const project = sample();
  const c = {
    id: 'c1',
    key: 'k1',
    rowId: 3,
    title: '冷藏车',
    url: 'https://example.com/a.mp4',
    in: 12,
    out: 30,
    decision: 'ok',
    srcFile: '/Users/host/候选.json',
  };
  project.candidates = [c];
  const res = attachCandidate(c, project.rows, project.assets);
  c.assetId = res.assetId;
  const { host, guest, settle } = pair(project);
  const gc = guest.p.candidates[0];
  assert.equal(gc.srcFile, undefined, '候选清单文件位置不传');
  assert.equal(guest.p.assets[c.assetId].path, remotePath(c));
  // 主机先保存到自己电脑
  const hc = host.p.candidates[0];
  hc.savedPath = '/Users/host/素材/第2句_冷藏车.mp4';
  swapToLocal(hc, hc.savedPath, host.p.rows, host.p.assets);
  settle();
  assert.equal(guest.p.assets[c.assetId].path, remotePath(c), '访客那边还是在线地址');
  assert.equal(guest.p.candidates[0].savedPath, undefined);
  // 访客也保存到自己电脑
  gc.savedPath = '/Users/guest/下载/第2句_冷藏车.mp4';
  swapToLocal(gc, gc.savedPath, guest.p.rows, guest.p.assets);
  settle();
  assert.equal(host.p.assets[c.assetId].path, hc.savedPath, '主机的本地文件没被换掉');
  assert.equal(guest.p.assets[c.assetId].path, gc.savedPath);
  assert.equal(host.p.candidates[0].srcFile, '/Users/host/候选.json');
  // 访客改片段：主机收到的是换算回原片的时间，再按主机自己的文件换算
  const gu = guest.p.rows.find(r => r.id === 3).assetUsages.find(u => u.assetId === c.assetId);
  gu.clip = { in: 2, out: 6 };
  settle();
  const hu = host.p.rows.find(r => r.id === 3).assetUsages.find(u => u.assetId === c.assetId);
  assert.deepEqual(hu.clip, { in: 2, out: 6 });
  assert.equal(fingerprint(guest.p), fingerprint(host.p));
  // 两边都没有多余的来回
  assert.equal(localChanges(host.rep, host.p), null);
  assert.equal(localChanges(guest.rep, guest.p), null);
});

test('重新定位失联文件只算本机：访客找回的路径不传给主机，之后主机改别的照常同步', () => {
  const project = sample();
  project.assets = { p1: { id: 'p1', kind: 'image', path: '/Users/host/图/封面.jpg', name: '封面.jpg' } };
  project.rows[2].assetUsages = [{ assetId: 'p1' }];
  const { host, guest, settle } = pair(project);
  // 访客那边文件失联，定位到自己电脑上的同名文件（应用层记一条本机路径映射）
  guest.rep.pathMap['/Users/host/图/封面.jpg'] = '/Users/guest/下载/封面.jpg';
  Object.assign(guest.p.assets.p1, { path: '/Users/guest/下载/封面.jpg', name: '封面.jpg' });
  settle();
  assert.equal(host.p.assets.p1.path, '/Users/host/图/封面.jpg');
  assert.equal(localChanges(guest.rep, guest.p), null, '没有多余改动');
  host.p.assets.p1.kind = 'image';
  host.p.rows[2].note = '用这张图';
  settle();
  assert.equal(guest.p.assets.p1.path, '/Users/guest/下载/封面.jpg');
  assert.equal(guest.p.rows[2].note, '用这张图');
  assert.equal(fingerprint(guest.p, guest.rep.pathMap), fingerprint(host.p));
});

test('口播音频：访客把它定位到自己电脑上，主机的口播路径不变；主机改了时长访客照常收到', () => {
  const project = sample();
  project.voice = { path: '/Users/host/口播.wav', name: '口播.wav', duration: 60 };
  const { host, guest, settle } = pair(project);
  guest.rep.pathMap['/Users/host/口播.wav'] = '/Users/guest/口播 (2).wav';
  guest.p.voice = { ...guest.p.voice, path: '/Users/guest/口播 (2).wav', name: '口播 (2).wav' };
  settle();
  assert.equal(host.p.voice.path, '/Users/host/口播.wav');
  host.p.voice = { ...host.p.voice, duration: 61 };
  settle();
  assert.equal(guest.p.voice.path, '/Users/guest/口播 (2).wav');
  assert.equal(guest.p.voice.duration, 61);
});

test('撤销自己的一步：对方之后的改动保留', () => {
  const { host, guest, settle } = pair();
  const snap = JSON.stringify({
    rows: host.p.rows,
    assets: host.p.assets,
    candidates: host.p.candidates,
    title: host.p.title,
  });
  const mark = host.rep.seq;
  host.p.rows[2].note = '主机这一步';
  settle();
  guest.p.rows[5].note = '访客后来写的';
  guest.p.rows.splice(7, 0, { id: newId(guest, 'guest'), kind: 'line', text: '访客插的', note: '', type: null });
  settle();
  const restored = rebaseSnapshot(host.rep, JSON.parse(snap), mark);
  host.p.rows = restored.rows;
  settle();
  assert.equal(host.p.rows[2].note, '');
  assert.equal(guest.p.rows[2].note, '', '撤销同步到了对方');
  assert.equal(guest.p.rows.find(r => r.text === '第5句。').note, '访客后来写的');
  assert.ok(host.p.rows.some(r => r.text === '访客插的'));
  assert.equal(fingerprint(guest.p), fingerprint(host.p));
});

test('日志裁剪前回补快照，反复裁剪后仍保留早期和最新远端改动', () => {
  const project = sample();
  const rep = createReplica(project, { role: 'host' });
  let snapshot = structuredClone(project),
    mark = 0,
    prunes = 0;
  for (let i = 0; i < LOG_MAX * 2 + 1; i++) {
    receiveOps(
      rep,
      project,
      { ops: [{ t: 'rf', id: 2, k: i === 0 ? 'text' : 'note', v: i === 0 ? '对方正文' : String(i) }] },
      {
        beforePrune: through => {
          snapshot = rebaseSnapshot(rep, snapshot, mark, through);
          mark = through;
          prunes++;
        },
      },
    );
  }
  rebaseSnapshot(rep, snapshot, mark);
  assert.equal(snapshot.rows.find(r => r.id === 2).text, '对方正文');
  assert.equal(snapshot.rows.find(r => r.id === 2).note, String(LOG_MAX * 2));
  assert.ok(prunes >= 2);
  assert.ok(rep.log.length <= LOG_MAX);
});

test('没有回补的过期快照被明确拒绝，不能静默覆盖对方修改', () => {
  const project = sample(),
    snapshot = structuredClone(project);
  const rep = createReplica(project, { role: 'host' });
  for (let i = 0; i <= LOG_MAX; i++) receiveOps(rep, project, { ops: [{ t: 'rf', id: 2, k: 'text', v: String(i) }] });
  assert.throws(() => rebaseSnapshot(rep, snapshot, 0), /历史已过期/);
  assert.equal(snapshot.rows[1].text, '第1句。');
});

console.log(`${count} 项协作回归通过`);
