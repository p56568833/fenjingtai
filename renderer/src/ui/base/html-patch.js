/* 对受控的界面 HTML 做局部更新：保留素材、句子按钮和已加载的缩略图，避免清空后整块重画。
   用于素材卡、右侧面板和协作菜单；不接管正文编辑器或媒体播放器。 */
const keyOf = node => {
  if (node.nodeType !== 1) return `node:${node.nodeType}`;
  for (const name of ['id', 'data-asset-id', 'data-line-asset', 'data-preview-path', 'data-line', 'data-cl']) {
    if (node.hasAttribute(name)) return `${node.tagName}:${name}:${node.getAttribute(name)}`;
  }
  return `${node.tagName}:${node.classList[0] || ''}`;
};

function patchNode(before, after) {
  if (before.nodeType !== 1) {
    if (before.nodeValue !== after.nodeValue) before.nodeValue = after.nodeValue;
    return;
  }
  // 缩略图由懒加载器维护，路径和种类没变时连内部 img / canvas 都原样保留。
  if (
    before.matches('.asset-thumb') &&
    after.matches('.asset-thumb') &&
    before.dataset.previewPath === after.dataset.previewPath &&
    before.dataset.kind === after.dataset.kind &&
    before.dataset.fileMissing === after.dataset.fileMissing
  )
    return;
  for (const attr of [...before.attributes]) {
    if (!after.hasAttribute(attr.name)) before.removeAttribute(attr.name);
  }
  for (const attr of after.attributes) {
    if (before.getAttribute(attr.name) !== attr.value) before.setAttribute(attr.name, attr.value);
  }
  if (before.tagName === 'TEXTAREA') {
    // 正在编辑的画面描述交给现有输入会话，后台状态刷新不能覆盖光标和未结束的输入。
    if (before !== document.activeElement && before.value !== after.value) before.value = after.value;
    return;
  }
  patchNodes(before, after);
}

function patchNodes(parent, next) {
  const old = [...parent.childNodes];
  const used = new Set();
  let cursor = parent.firstChild;
  for (const desired of [...next.childNodes]) {
    const key = keyOf(desired);
    const existing = old.find(node => !used.has(node) && keyOf(node) === key);
    const node = existing || desired.cloneNode(true);
    if (existing) {
      used.add(existing);
      patchNode(existing, desired);
    }
    if (node !== cursor) {
      if (existing && parent.isConnected && typeof parent.moveBefore === 'function') parent.moveBefore(node, cursor);
      else parent.insertBefore(node, cursor);
    }
    cursor = node.nextSibling;
  }
  // 滑块（.mo-glide）是动效层自己放进来的，不在模板里，局部更新时保留，免得悬停高亮被冲掉
  for (const node of old) if (!used.has(node) && !node.classList?.contains('mo-glide')) node.remove();
}

export function patchHTML(parent, html, { fresh = false } = {}) {
  const template = document.createElement('template');
  template.innerHTML = html;
  if (fresh) parent.replaceChildren(template.content);
  else patchNodes(parent, template.content);
}
