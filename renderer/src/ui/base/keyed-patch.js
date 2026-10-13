/* 按块原地更新：每块（一句、一组共用画面、一段原文…）有固定的 key 和它的 HTML，
   和上次写进页面的比，一样的块原样留着（滚动位置、浏览器记住的行高、缩略图都不丢），
   变了的块换掉，新加的插进去，没了的删掉。
   块的写法：叶子 { key, html }；容器 { key, html: 外壳（空的开闭标签）, kids: [...] }，外壳不变时只更新里面的块。
   每块的 HTML 必须正好是一个元素。 */
const tpl = document.createElement('template');

/* fresh：整块重来（切项目 / 切视图的入场动画）；onReplace(旧, 新)：同一块换新元素时，让调用方把旧元素里
   后来补画的内容（素材卡片…）挪过去。返回新建的元素。 */
export function patchChildren(parent, specs, { fresh = false, onReplace = null } = {}) {
  // 里面是别的渲染器写的内容（原文视图 / 表格互切、空状态…），或要求整块重来：清空后按新的建
  if (fresh || [...parent.childNodes].some(n => n.nodeType !== 1 || n._pk == null)) parent.replaceChildren();
  const old = new Map();
  for (const el of parent.children) old.set(el._pk, el);
  const made = [];
  const need = [];
  for (const s of specs) {
    const el = old.get(s.key);
    if (el && el._ph === s.html) {
      s.el = el;
      old.delete(s.key);
    } else need.push(s);
  }
  if (need.length) {
    // 一次解析所有新块，比逐块解析快得多（第一次打开长稿时几百句）
    tpl.innerHTML = need.map(s => s.html).join('');
    const kids = [...tpl.content.children];
    if (kids.length !== need.length) throw new Error('patchChildren：每块的 HTML 必须正好是一个元素');
    need.forEach((s, i) => {
      s.el = kids[i];
      s.el._pk = s.key;
      s.el._ph = s.html;
      made.push(s.el);
      const before = old.get(s.key);
      if (before) {
        if (onReplace && !s.kids) onReplace(before, s.el);
        // 容器外壳变了：里面的块还能接着用
        if (s.kids) s.el.append(...before.children);
      }
    });
    tpl.innerHTML = '';
  }
  for (const el of old.values()) el.remove();
  // 按新的顺序排：没动的块不挪（挪动会让浏览器重新排版它）
  let cur = parent.firstElementChild;
  for (const s of specs) {
    if (s.el === cur) cur = cur.nextElementSibling;
    else parent.insertBefore(s.el, cur);
  }
  for (const s of specs) if (s.kids) made.push(...patchChildren(s.el, s.kids, { onReplace }));
  return made;
}

/* 别处在原地改了某块的内容（标注颜色、画面描述、改字…）：页面上的这块已经和记下的 HTML 不一样了，
   标成过期，下次更新时按数据重画它。不标的话，撤销回到原来的数据时会以为「没变」而留着改过的样子。 */
export function staleBlock(el) {
  for (let e = el; e; e = e.parentElement) {
    if (e._pk != null) {
      e._ph = null;
      return;
    }
  }
}
