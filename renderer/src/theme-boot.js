/* 首帧前套上主题类，避免深色模式启动闪白（CSP 不允许内联脚本，所以单独成文件，经典脚本同步执行） */
try {
  if (localStorage.getItem('fjz:theme') === 'dark') document.body.classList.add('dark');
} catch (e) {
  /* 读不到偏好就用浅色 */
}
