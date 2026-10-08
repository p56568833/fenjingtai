/* 纯文本 / 时间工具（无 DOM、无应用状态，node 可直接测） */

/* 朗读量（按「中文字」计）：汉字、数字各算 1；英文按单词算，一个词约等于 1.8 个汉字的时长 */
export function speechUnits(t) {
  const s = t || '';
  const cjk = (s.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  const digits = (s.match(/[0-9]/g) || []).length;
  const words = (s.match(/[A-Za-z]+(?:['’][A-Za-z]+)?/g) || []).length;
  return cjk + digits + words * 1.8;
}

/* 秒 → mm:ss（超 1 小时 h:mm:ss） */
export function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60),
    m = Math.floor(sec / 60) % 60,
    h = Math.floor(sec / 3600);
  const p = n => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

/* 手输时间：12 / 00:12 / 1:02:03 / 12.5 → 秒；认不出返回 null */
export function parseTime(str) {
  if (str == null) return null;
  const t = String(str).trim();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t);
  const m = t.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
  if (!m) return null;
  const h = m[1] ? +m[1] : 0,
    mm = +m[2],
    ss = parseFloat(m[3]);
  if (mm > 59 || ss >= 60) return null;
  return h * 3600 + mm * 60 + ss;
}

/* 时间码：00:12.3（界面）/ 00:00:12.300（导出给剪辑） */
export function fmtTc(sec, { precise = false } = {}) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600),
    m = Math.floor((sec % 3600) / 60),
    s = sec % 60;
  const p = n => String(n).padStart(2, '0');
  if (precise) return `${p(h)}:${p(m)}:${p(Math.floor(s))}.${String(Math.floor((s % 1) * 1000)).padStart(3, '0')}`;
  const ss = Math.floor(s * 10) / 10;
  return `${h ? h + ':' : ''}${p(m)}:${ss < 10 ? '0' : ''}${ss.toFixed(1)}`;
}

/* 时长：12.3 秒 / 2 分 05 秒 */
export function fmtLen(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  if (sec < 60) return `${sec.toFixed(1)} 秒`;
  return `${Math.floor(sec / 60)} 分 ${String(Math.round(sec % 60)).padStart(2, '0')} 秒`;
}

/* 文件名安全：去掉 macOS / Windows 不允许或会被当成路径的字符 */
export function safeFileName(name, fallback = '未命名项目') {
  const s = String(name || '')
    // eslint-disable-next-line no-control-regex -- 控制字符本来就是要去掉的
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  return s || fallback;
}
