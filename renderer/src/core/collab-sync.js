/* 局域网协作的同步规则（纯函数 + 一个普通对象记状态，不碰网络和界面）。
   两个人：开始共享的人是「主机」，以主机为准排先后；加入的人是「访客」。
   · 本机一有改动就和 base 比出操作发过去。主机收到访客的操作直接合进来并回一个确认（ack）。
   · 访客发出、还没被确认的改动记在 pending 里：这期间主机发来的同一项改动先不合（主机随后会收到访客的，
     以访客这次为准），这样两边最后一定一样。删句子例外：删除总是生效。
   · 访客断线期间的改动只记「键」（offline，随项目存盘）；重连时主机发来整份内容，访客换上之后把这些键
     对应的本机内容再叠上去、补发给主机。主机断线期间的改动不用记：访客重连时拿到的整份内容里就有。
   · log：合进来的对方改动（撤销用：撤回自己的某一步时，把这一步之后对方的改动补进旧快照，不会连对方的一起撤掉）。 */
import {
  diffProject,
  applyOps,
  opKey,
  opsForKeys,
  makeCtx,
  docFromBase,
  baseFromDoc,
  loadDoc,
  buildBase,
} from './collab-doc.js';

export const LOG_MAX = 2000;
export const siteOf = role => (role === 'host' ? '1' : '2');
export const parityOf = role => (role === 'host' ? 0 : role === 'guest' ? 1 : null);

export function createReplica(project, { role, pos = {}, maxId = 0, pathMap = {}, unsent = [] }) {
  const base = buildBase(project, makeCtx(project, pathMap), { pos, maxId, site: siteOf(role) });
  return {
    role,
    base,
    pathMap,
    pending: [],
    offline: new Set(unsent),
    n: 0,
    online: false,
    log: [],
    seq: 0,
    logFloor: 0,
  };
}

export const unsentKeys = rep => [...new Set([...rep.offline, ...rep.pending.flatMap(p => [...p.keys])])];

/* 本机改动 → 要发出去的消息；不在线时只记键（返回 null） */
export function localChanges(rep, project) {
  const ops = diffProject(rep.base, project, makeCtx(project, rep.pathMap), siteOf(rep.role));
  if (!ops.length) return null;
  if (rep.role === 'host') return rep.online ? { type: 'ops', ops } : null;
  if (!rep.online) {
    for (const op of ops) rep.offline.add(opKey(op));
    return null;
  }
  const n = ++rep.n;
  rep.pending.push({ n, keys: new Set(ops.map(opKey)) });
  return { type: 'ops', n, ops };
}

/* 访客本机还没被确认的改动盖着这一项吗 */
export function coveredBy(keys, op) {
  if (op.t === 'rd') return false;
  if (keys.has(opKey(op))) return true;
  return (op.t === 'rf' || op.t === 'p' || op.t === 'r') && keys.has(`r:${op.id}`);
}

/* 合进对方的操作（调用前先 localChanges，把本机改动发出去、记进 pending）。返回 { sum, reply } */
export function receiveOps(rep, project, msg, { beforePrune } = {}) {
  const keys = rep.role === 'guest' ? new Set(unsentKeys(rep)) : null;
  const sum = applyOps(project, rep.base, msg.ops || [], {
    pathMap: rep.pathMap,
    skip: keys ? op => coveredBy(keys, op) : undefined,
  });
  if (sum.applied.length) {
    rep.log.push({ seq: ++rep.seq, ops: sum.applied });
    if (rep.log.length > LOG_MAX) {
      // 分批裁剪，避免日志满后每条消息都重新处理所有快照。
      const count = Math.ceil(LOG_MAX / 2);
      const through = rep.log[count - 1].seq;
      beforePrune?.(through);
      rep.log.splice(0, count);
      rep.logFloor = through;
    }
  }
  const reply = rep.role === 'host' && msg.n != null ? { type: 'ack', n: msg.n } : null;
  return { sum, reply };
}

export function receiveAck(rep, n) {
  rep.pending = rep.pending.filter(p => p.n > n);
}

/* 断线：已发出去、没确认的也算没送到，重连后再发一次（同样的值再写一遍没有副作用） */
export function goOffline(rep) {
  for (const k of unsentKeys(rep)) rep.offline.add(k);
  rep.pending = [];
  rep.online = false;
}

/* 主机：访客加入 / 重连，发整份内容（调用前先 localChanges 把主机的改动并进 base） */
export function hostDoc(rep) {
  rep.online = true;
  return docFromBase(rep.base);
}

/* 访客：换上主机的整份内容，再把本机没同步的改动叠上去；返回要补发的消息（没有就 null）。
   调用前先 localChanges（不在线时它把最新的改动记成键） */
export function guestAdopt(rep, project, doc) {
  const redo = opsForKeys(unsentKeys(rep), rep.base);
  rep.base = baseFromDoc(doc);
  loadDoc(project, doc, rep.pathMap);
  rep.pending = [];
  rep.offline.clear();
  rep.online = true;
  rep.log = [];
  rep.logFloor = rep.seq;
  if (!redo.length) return null;
  applyOps(project, rep.base, redo, { pathMap: rep.pathMap });
  const n = ++rep.n;
  rep.pending.push({ n, keys: new Set(redo.map(opKey)) });
  return { type: 'ops', n, ops: redo };
}

/* 撤销：旧快照（本机形态）补上 mark 之后合进来的对方改动 */
export function rebaseSnapshot(rep, data, mark, through = rep.seq) {
  if (mark == null) return data;
  if (mark < rep.logFloor) throw new Error('协作撤销历史已过期，不能恢复这份快照');
  const ops = rep.log.filter(e => e.seq > mark && e.seq <= through).flatMap(e => e.ops);
  if (ops.length) applyOps(data, null, ops, { pathMap: rep.pathMap, pos: rep.base.pos });
  return data;
}
