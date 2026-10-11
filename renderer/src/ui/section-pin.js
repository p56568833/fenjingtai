/* 表格视图的章节吸顶细条。
   章节大标题跟着正文正常滚走；它快滚出顶部时，本章的 .sec-pin 细条淡入吸在顶上，
   细条只在本章（.sec-block）范围内吸顶，下一章的大标题上来时把它直接顶走。 */
let frame = 0;

export function syncSectionPins() {
  frame = 0;
  const wrap = document.querySelector('#tableWrap');
  if (!wrap) return;
  const top = wrap.getBoundingClientRect().top;
  for (const pin of wrap.querySelectorAll('.sec-pin')) {
    const head = pin.nextElementSibling;
    if (!head) continue;
    // 大标题的底边进到细条范围里，就换细条接班
    pin.classList.toggle('on', head.getBoundingClientRect().bottom <= top + pin.offsetHeight + 2);
  }
}

function schedule() {
  if (!frame) frame = requestAnimationFrame(syncSectionPins);
}

export function initSectionPins() {
  const wrap = document.querySelector('#tableWrap');
  if (!wrap) return;
  wrap.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  // 点细条回到本章开头
  document.querySelector('#rows')?.addEventListener('click', e => {
    const pin = e.target.closest('.sec-pin.on');
    if (!pin) return;
    e.stopPropagation();
    const block = pin.closest('.sec-block');
    if (!block) return;
    const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    wrap.scrollTo({
      top: wrap.scrollTop + block.getBoundingClientRect().top - wrap.getBoundingClientRect().top,
      behavior: smooth ? 'smooth' : 'auto',
    });
  });
}
