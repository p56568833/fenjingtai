/* 会话状态的合法转换。主机等待来访，访客可重连或等待重新配对。 */
const transitions = {
  host: { waiting: ['online'], online: ['waiting'] },
  guest: {
    offline: ['connecting', 'online', 'needs-code'],
    connecting: ['online', 'offline', 'needs-code'],
    online: ['offline', 'needs-code'],
    'needs-code': ['online', 'offline'],
  },
};
export function transitionSession(session, next) {
  if (session.status === next) return;
  if (!transitions[session.rep.role]?.[session.status]?.includes(next))
    throw new Error(`无效的协作状态转换：${session.rep.role} ${session.status} → ${next}`);
  session.status = next;
}
