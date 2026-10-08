/* 首帧前套上主题类，避免深色模式启动闪白（CSP 不允许内联脚本，所以单独成文件，经典脚本同步执行）。
   偏好：light / dark / system（跟随系统，没设过时的默认） */
try {
  var pref = localStorage.getItem('fjz:theme') || 'system';
  var dark = pref === 'dark' || (pref === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  if (dark) document.body.classList.add('dark');
} catch (e) {
  /* 读不到偏好就用浅色 */
}
