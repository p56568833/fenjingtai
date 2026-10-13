/* 滚动校准只属于当前这次操作，切出窗口或用户开始操作后不能再接着执行。 */
export function scrollGuard(onCancel) {
  const started = performance.now();
  let cancelled = false;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    for (const event of ['wheel', 'pointerdown', 'keydown']) document.removeEventListener(event, cancel, true);
    window.removeEventListener('blur', cancel);
    document.removeEventListener('visibilitychange', visibility);
    onCancel();
  };
  const visibility = () => {
    if (document.hidden) cancel();
  };
  for (const event of ['wheel', 'pointerdown', 'keydown']) document.addEventListener(event, cancel, true);
  window.addEventListener('blur', cancel);
  document.addEventListener('visibilitychange', visibility);
  return {
    cancel,
    active() {
      // 后台暂停的帧或繁忙界面迟到的回调不能重新夺走视口。
      if (performance.now() - started > 500) cancel();
      return !cancelled;
    },
  };
}
