/* 导出到剪映结果面板的布局自测：结果里的草稿目录和导出说明都是 nowrap 长路径，
   不锁列宽时会把结果卡片撑到路径全长，整个弹窗跟着出现横向滚动条——拖动后左半边内容被推出视口。
   这里在真实渲染层里铺出结果面板量一次，样式回退会直接失败。 */
export function runJianyingExportTests(t) {
  const mask = document.getElementById('jianyingMask');
  const modal = mask?.querySelector('.modal');
  const done = document.getElementById('jyDonePane');
  const result = document.getElementById('jyResult');
  if (!mask || !modal || !done || !result) {
    t('导出结果面板已挂载', false, '#jianyingMask / #jyResult 不在页面里');
    return;
  }
  const shown = mask.classList.contains('show');
  const scrollLeft = modal.scrollLeft;
  const panes = ['jyConfigPane', 'jyRunPane'].map(id => document.getElementById(id));
  const paneHidden = panes.map(pane => pane?.hidden);
  const doneHidden = done.hidden;
  const html = result.innerHTML;
  const path =
    '~/Movies/JianyingPro/User Data/Projects/com.lveditor.draft/最终测试-20261018-0230/fenjingtai-export.json';
  // 与 resultRows 的行结构保持一致：左侧定宽标签 + 右侧 nowrap 路径
  result.innerHTML = ['位置', '导出说明']
    .map(label => `<div class="jy-res-row"><b>${label}</b><code title="${path}">${path}</code></div>`)
    .join('');
  panes.forEach(pane => pane && (pane.hidden = true));
  done.hidden = false;
  mask.classList.add('show');
  try {
    modal.scrollLeft = 0;
    const code = result.querySelector('code');
    const style = getComputedStyle(code);
    t(
      '导出结果：长路径不撑出横向滚动条',
      modal.scrollWidth <= modal.clientWidth + 1,
      `${modal.scrollWidth} / ${modal.clientWidth}`,
    );
    t(
      '导出结果：长路径按省略号截断',
      code.scrollWidth > code.clientWidth && style.textOverflow === 'ellipsis',
      `${code.scrollWidth} / ${code.clientWidth} · ${style.textOverflow}`,
    );
  } finally {
    result.innerHTML = html;
    panes.forEach((pane, index) => pane && (pane.hidden = paneHidden[index]));
    done.hidden = doneHidden;
    if (!shown) mask.classList.remove('show');
    modal.scrollLeft = scrollLeft;
  }
}
