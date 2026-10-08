/* 自动化回归测试（npm test / electron . --selftest 时运行）：
   数据层直接调函数断言，关键交互用真实 DOM 事件模拟，结果挂到 window.__SELFTEST_RESULT__ */
import { state, update } from '../app/state.js';
import * as storage from '../app/storage.js';
import { snapshot, undo, clearUndo } from '../app/undo.js';
import * as actions from '../app/actions.js';
import { parseAny } from '../core/parse.js';
import { demoProject } from '../core/demo.js';

const R = [];
const t = (name, ok, detail = '') => R.push({ name, ok: !!ok, detail });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rows = () => state.rows.filter(r => r.kind === 'line');
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

function key(el, k, opts = {}) {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }));
}
function click(el) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}
function setCaret(el, offset) {
  el.focus();
  const range = document.createRange();
  range.setStart(el.firstChild || el, 0);
  range.setEnd(el.firstChild || el, 0);
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let remain = offset,
    n;
  while ((n = walk.nextNode())) {
    if (remain <= n.textContent.length) {
      range.setStart(n, remain);
      break;
    }
    remain -= n.textContent.length;
  }
  range.collapse(true);
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(range);
}
const caretOffset = el => {
  const range = getSelection().getRangeAt(0);
  const pre = range.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length;
};

export async function runSelfTest() {
  state.autoAdvance = false;
  state.view = 'table';
  // 沙箱数据目录可能残留上个会话的空项目（比如 ux-check 删过项目）：没有句子就补一份示例
  if (!rows().length) {
    const d = demoProject();
    storage.createProject(d.title, d.rows);
    clearUndo();
    update('rows');
  }

  /* ── 1. 初始渲染 ── */
  t('初始渲染：表格有行', $$('.row').length === rows().length && rows().length > 20, `${$$('.row').length} 行`);

  /* ── 2. 标注 + 撤销 ── */
  const firstId = rows()[0].id;
  state.sel = firstId;
  state.multi = null;
  actions.setType([firstId], 'fx');
  t('标注生效', rows()[0].type === 'fx');
  undo();
  t('标注撤销', rows()[0].type === 'a', `type=${rows()[0].type}`);

  /* ── 3. 键盘数字标注（DOM 事件；1=A 2=真实素材 … 0=清除） ── */
  document.activeElement && document.activeElement.blur();
  state.sel = firstId;
  update('selection');
  key(document.body, '2');
  await sleep(30);
  t('数字键标注', rows()[0].type === 'real', `type=${rows()[0].type}`);
  undo();

  /* ── 4. 拆分 ── */
  snapshot('自测基线');
  const twoId = rows()[1].id;
  const twoText = rows()[1].text;
  const cut = Math.floor(twoText.length / 2);
  update('rows');
  await sleep(30);
  let el = $(`.row[data-id="${twoId}"] .sent`);
  el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await sleep(30);
  t('双击进入编辑', el.isContentEditable === true);
  setCaret(el, cut);
  const caretNow = caretOffset(el);
  key(el, 'Enter');
  await sleep(30);
  t(
    'Enter 拆分',
    rows()[1].text + rows()[2].text === twoText && rows().length > 0,
    `caret=${caretNow}/${cut} | r1="${rows()[1].text}" | r2="${rows()[2]?.text}" | n=${twoText.length}`,
  );
  undo();
  snapshot('自测基线2'); // 回到拆分前

  /* ── 5. 句首 ⌫ 合并 + 光标接缝 ── */
  update('rows');
  await sleep(30);
  const a0 = rows()[0].text,
    a1 = rows()[1].text;
  const seam = a0.length;
  state.sel = rows()[1].id;
  update('selection');
  el = $(`.row[data-id="${rows()[1].id}"] .sent`);
  el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await sleep(30);
  setCaret(el, 0);
  key(el, 'Backspace');
  await sleep(80);
  t('句首⌫合并', rows()[0].text === a0 + a1, `"${rows()[0].text.slice(0, 20)}…"`);
  const editingEl = $('.sent[contenteditable="true"]');
  t('合并后保持编辑态', !!editingEl);
  t(
    '光标落在接缝',
    editingEl && caretOffset(editingEl) === seam,
    `offset=${editingEl ? caretOffset(editingEl) : -1}, seam=${seam}`,
  );
  editingEl && editingEl.blur();
  undo();

  /* ── 6. IME 防护：组合中的 Enter / ⌫ 不触发拆分 / 合并 ── */
  update('rows');
  await sleep(30);
  const before = rows().length;
  const t0 = rows()[0].text;
  el = $(`.row[data-id="${rows()[1].id}"] .sent`);
  el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await sleep(30);
  setCaret(el, 0);
  key(el, 'Backspace', { isComposing: true, keyCode: 229 });
  await sleep(50);
  key(el, 'Enter', { isComposing: true, keyCode: 229 });
  await sleep(50);
  t('IME组合中按键不生效', rows().length === before && rows()[0].text === t0);
  el.blur();

  /* ── 7. 句尾 Enter 空出新句子（编辑 → 句尾回车 → 新空句接着写） ── */
  update('rows');
  await sleep(30);
  const n0 = rows().length;
  const anchorId = rows()[0].id;
  el = $(`.row[data-id="${anchorId}"] .sent`);
  el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await sleep(30);
  setCaret(el, el.textContent.length);
  key(el, 'Enter');
  await sleep(80);
  const nel = $('.sent[contenteditable="true"]');
  t(
    '句尾 Enter 空出新句子并进入编辑',
    !!nel && rows().length === n0 + 1 && +nel.closest('.row').dataset.id !== anchorId,
  );
  nel.textContent = '这是插入的新句子。';
  nel.dispatchEvent(new InputEvent('input', { bubbles: true }));
  nel.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  await sleep(50); // 走人即提交（自测窗口 focus 不落稳，合成 focusout）
  t('插入的句子已保存', rows()[1].text === '这是插入的新句子。', rows()[1].text);
  undo(); // 回退打字（修改文字快照）
  undo(); // 回退插入（插入句子快照）——少撤一步会留一个空行污染后面的用例

  /* ── 8. 句尾 Enter 插入后 Esc：空句自动删除 ── */
  update('rows');
  await sleep(30);
  const n1 = rows().length;
  el = $(`.row[data-id="${rows()[0].id}"] .sent`);
  el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await sleep(30);
  setCaret(el, el.textContent.length);
  key(el, 'Enter');
  await sleep(80);
  el = $('.sent[contenteditable="true"]');
  key(el, 'Escape');
  await sleep(50);
  t('空句 Esc 自动删除', rows().length === n1);

  /* ── 9. 备注撤销 ── */
  update('rows');
  await sleep(30);
  const noteEl = $(`.row[data-id="${rows()[0].id}"] .note`);
  const noteBefore = rows()[0].note || '';
  noteEl.focus();
  noteEl.textContent = noteBefore + ' 补充说明';
  noteEl.dispatchEvent(new InputEvent('input', { bubbles: true }));
  noteEl.blur();
  await sleep(30);
  t('备注已写入', rows()[0].note.includes('补充说明'));
  undo();
  t('备注撤销恢复', (rows()[0].note || '') === noteBefore, `"${rows()[0].note}"`);

  /* ── 10. 备注 Enter 跳下一行 ── */
  update('rows');
  await sleep(30);
  const note1 = $(`.row[data-id="${rows()[0].id}"] .note`);
  const note2 = $(`.row[data-id="${rows()[1].id}"] .note`);
  note1.focus();
  await sleep(30);
  key(note1, 'Enter');
  await sleep(50);
  t(
    '备注 Enter 跳到下一行备注',
    document.activeElement === note2,
    document.activeElement && document.activeElement.className,
  );
  document.activeElement.blur();

  /* ── 11. 筛选下合并的提示 ── */
  state.filter = 'none';
  update('rows');
  await sleep(30);
  const noneRows = rows().filter(r => !r.type);
  if (noneRows.length) {
    const idx = state.rows.findIndex(r => r.id === noneRows[0].id);
    const prev = state.rows[idx - 1];
    if (prev && prev.kind === 'line' && prev.type) {
      const res = actions.mergeToPrev(noneRows[0].id);
      const msg = $('#toastTxt').textContent;
      t('筛选下合并给出提示', !!res && msg.includes('当前筛选下不显示'), msg);
      undo();
    }
  }
  state.filter = 'all';
  update('rows');
  await sleep(30);

  /* ── 11.5 章节管理：拆节 / 改名 / 管理菜单 / 删标题 / 删整节 / 节尾插入 ── */
  {
    const base = JSON.stringify(state.rows);
    const secCount0 = state.rows.filter(r => r.kind === 'section').length;
    const si0 = state.rows.findIndex((r, i) => r.kind === 'line' && i > 0 && state.rows[i - 1].kind === 'line');
    const tgt = state.rows[si0];
    const newSid = actions.addSectionBefore(tgt.id);
    await sleep(30);
    t('从句子分出新章节', newSid != null && state.rows[si0].kind === 'section' && state.rows[si0 + 1].id === tgt.id);
    t('章节开头拒绝重复分节', actions.addSectionBefore(tgt.id) == null);
    update('rows');
    await sleep(30);
    const ni = state.rows.findIndex(r => r.id === newSid);
    const nameEl = $(`.section-row[data-si="${ni}"] .name`);
    nameEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await sleep(30);
    t('双击章节名进入改名', nameEl.isContentEditable === true);
    nameEl.textContent = '测试改名节';
    key(nameEl, 'Enter');
    await sleep(40);
    t(
      '章节改名保存',
      state.rows.find(r => r.id === newSid)?.text === '测试改名节',
      state.rows.find(r => r.id === newSid)?.text,
    );
    click($(`.section-row[data-si="${ni}"]`));
    await sleep(30);
    t(
      '点章节行弹管理菜单',
      !!document.querySelector('.popover') && !!document.querySelector('.popover [data-sec-act="delhead"]'),
    );
    click(document.querySelector('.popover [data-sec-act="delhead"]'));
    await sleep(30);
    t(
      '只删标题句子并入上一节',
      !state.rows.some(r => r.id === newSid) &&
        state.rows[si0]?.id === tgt.id &&
        state.rows.filter(r => r.kind === 'section').length === secCount0,
    );
    const s2 = actions.addSectionBefore(tgt.id);
    await sleep(30);
    const nBefore = rows().length;
    actions.deleteSectionAll(s2);
    await sleep(30);
    t(
      '删除整节连句子',
      !state.rows.some(r => r.id === s2 || r.id === tgt.id) && rows().length < nBefore,
      `剩 ${rows().length}/${nBefore}`,
    );
    const fsec = state.rows.find(r => r.kind === 'section');
    const secIds = new Set(state.rows.filter(r => r.kind === 'section').map(r => r.id));
    const sentId = actions.insertSectionWithSentence(fsec.id);
    await sleep(30);
    t(
      '节尾插入新章节和空句',
      sentId != null &&
        state.rows.some(r => r.kind === 'section' && !secIds.has(r.id)) &&
        !!state.rows.find(r => r.id === sentId && r.kind === 'line' && !r.text),
    );
    actions.dropIfEmpty(sentId);
    await sleep(30);
    t(
      '空句放弃连带清掉新标题',
      !state.rows.some(r => r.kind === 'section' && !secIds.has(r.id)) && !state.rows.some(r => r.id === sentId),
    );
    state.rows = JSON.parse(base);
    state.filter = 'all';
    state.sel = rows()[0]?.id ?? null;
    storage.persist(true); // 必须落盘：persist 会把 state.rows 反写回项目库，只改内存的话截断版数据会留在盘上污染下一轮
    update('rows');
    await sleep(30);
  }

  /* ── 12. MD 批注回读 ── */
  const md = `# 测试稿\n\n## 开场\n\n- [A roll · 真人出镜] 第一句口播。（备注：语气加重）\n- [B roll · 真实素材] 第二句口播。（画面：新闻画面）\n- [未标注] 第三句。\n`;
  const parsed = parseAny(md);
  const pl = parsed.filter(r => r.kind === 'line');
  t('MD回读：句数', pl.length === 3, `${pl.length} 句`);
  t(
    'MD回读：类型',
    pl[0].type === 'a' && pl[1].type === 'real' && pl[2].type === null,
    `${pl[0].type},${pl[1].type},${pl[2].type}`,
  );
  t('MD回读：备注', pl[0].note === '语气加重' && pl[1].note === '新闻画面', `${pl[0].note}|${pl[1].note}`);
  t('MD回读：章节', parsed[0].kind === 'section' && parsed[0].text === '开场');

  /* ── 13. 多项目 ── */
  const projCount = storage.allProjects().length;
  const id0 = state.projectId;
  storage.createProject('自测项目', parseAny('一号句。二号句。'));
  t('新建项目并切换', state.projectId !== id0 && rows().length === 2, `${rows().length} 句`);
  const saved = await window.native.loadData();
  t(
    '数据已落盘',
    saved && saved.projects && !!saved.projects[state.projectId],
    Object.keys(saved.projects || {}).length + ' 个项目在盘上',
  );
  storage.deleteProject(state.projectId);
  storage.switchProject(id0);
  t('删除项目回到原项目', state.projectId === id0 && storage.allProjects().length === projCount);
  clearUndo();
  state.sel = rows()[0]?.id ?? null;
  update('rows');

  /* ── 14. 勾选视图：先选句、再标类型；段落封顶续分 ── */
  state.view = 'check';
  update('rows');
  await sleep(30);
  t('勾选视图渲染（一句一 span）', $$('.as').length === rows().length, `${$$('.as').length}/${rows().length}`);
  // 段落：demo 老数据没有 para 标记，靠 5 句 / 120 字封顶也要分出多段，不能一章一大块
  const secCount = state.rows.filter(r => r.kind === 'section').length;
  t('长内容强制分段', $$('.ck-p').length >= secCount + 2, `${$$('.ck-p').length} 段 / ${secCount} 章`);

  // 注意：undo() 会把 state.rows 换成一批新对象，断言前必须按 id 重新取行，不能握旧引用
  const blankId = rows().find(r => !r.type)?.id;
  if (blankId) {
    const rowOf = id => rows().find(r => r.id === id);
    const sp = $(`.as[data-id="${blankId}"]`);
    sp.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    t('单击＝选中（不标类型）', state.sel === blankId && rowOf(blankId).type === null && sp.classList.contains('cur'));
    key(document.body, '1');
    await sleep(30);
    t('按 1 标成 A roll', rowOf(blankId).type === 'a' && sp.classList.contains('st-a'), `type=${rowOf(blankId).type}`);
    t('标完光标留在原句（不自动跳下一句）', state.sel === blankId);
    undo();
    await sleep(20);

    state.sel = blankId;
    state.multi = null;
    update('selection');
    key(document.body, '2');
    await sleep(30);
    t('按 2 标成 B·真实素材', rowOf(blankId).type === 'real', `type=${rowOf(blankId).type}`);
    undo();
    await sleep(20);

    state.sel = blankId;
    state.multi = null;
    update('selection');
    const spFresh = $(`.as[data-id="${blankId}"]`); // undo 会重建 DOM，旧引用已脱离
    spFresh.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await sleep(30);
    const fxCard = document.querySelector('.popover.hovercard [data-ck-t="fx"]');
    if (fxCard) {
      fxCard.click();
      await sleep(30);
    }
    t('点标注卡标类型', rowOf(blankId).type === 'fx', `type=${rowOf(blankId).type}`);
    undo();
  } else t('勾选视图：选句标注', false, '示例稿里没有未标句');

  // 拖选几句 → 批量标
  const idA = rows()[0].id,
    idB = rows()[3].id;
  $(`.as[data-id="${idA}"]`).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  $(`.as[data-id="${idB}"]`).dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  await sleep(20);
  t('拖选＝连选多句', state.multi && state.multi.length === 4, `multi=${state.multi && state.multi.length}`);
  key(document.body, '3');
  await sleep(30);
  t(
    '拖选后按键批量标注',
    rows()
      .slice(0, 4)
      .every(r => r.type === 'stock'),
    rows()
      .slice(0, 4)
      .map(r => r.type)
      .join(','),
  );
  undo();

  // 标注卡：选中即弹 → 点类型就地标；写批注
  t('章节标题吸顶', getComputedStyle($('.ck-sec')).position === 'sticky');
  const hovId = rows()[0].id;
  const selSpan = () => $(`.as[data-id="${hovId}"]`);
  selSpan().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  await sleep(30);
  let card = document.querySelector('.popover.hovercard');
  t('选中句子弹标注卡', !!card && !!card.querySelector('[data-ck-t="a"]') && !!card.querySelector('[data-ck-note]'));
  if (card) {
    card.querySelector('[data-ck-t="ai"]').click();
    await sleep(30);
    t('点标注卡标类型', rows().find(r => r.id === hovId).type === 'ai', rows().find(r => r.id === hovId).type);
    undo();
    await sleep(20);

    // 批注：再选中 → 卡上点写批注 → 句子下方出编辑行 → Enter 保存为红字
    selSpan().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await sleep(30);
    card = document.querySelector('.popover.hovercard');
    card.querySelector('[data-ck-note]').click();
    await sleep(30);
    const ed = $('.as-note-edit');
    t('批注编辑器出现在句下', !!ed && ed.dataset.edit === String(hovId));
    ed.textContent = '这段配城市夜景航拍';
    key(ed, 'Enter');
    await sleep(60);
    const rHov = rows().find(r => r.id === hovId);
    t('批注保存为红字行', rHov.note === '这段配城市夜景航拍' && !!$(`.as-note[data-note="${hovId}"]`), rHov.note);
    undo();
    await sleep(20);
    t('批注可撤销', !rows().find(r => r.id === hovId).note);
  }
  selSpan().blur && selSpan().blur();
  state.view = 'table';
  update('rows');

  // PDF 分镜脚本：菜单入口、选项弹窗、快捷键隔离、排版结构
  {
    const { closePop } = await import('../ui/popover.js');
    closePop();
  }
  $('#reviewMask')?.classList.remove('show');
  await sleep(400); // 等前面用例残留的悬停卡定时器跑完，免得它把刚弹出的菜单关掉
  click($('#btnExport')); // 菜单同步弹出，立刻点，不给其它定时器插队的机会
  const pdfItem = document.querySelector('.popover .pop-item[data-x="pdf"]');
  t('导出菜单有 PDF 分镜脚本', !!pdfItem);
  pdfItem && click(pdfItem);
  await sleep(30);
  t('PDF 选项弹窗打开', $('#pdfMask').classList.contains('show'));
  state.sel = rows()[0].id;
  state.multi = null;
  const typeBeforePdf = rows()[0].type;
  key(document.body, '5');
  await sleep(20);
  t('PDF 弹窗下快捷键不穿透', rows()[0].type === typeBeforePdf, rows()[0].type);
  if (rows()[0].type !== typeBeforePdf) undo();
  key(document.body, 'Escape');
  await sleep(20);
  t('Esc 关闭 PDF 弹窗', !$('#pdfMask').classList.contains('show'));
  key(document.body, 'E', { metaKey: true, shiftKey: true });
  await sleep(20);
  t('⇧⌘E 导出 PDF，不进入专注标注', $('#pdfMask').classList.contains('show') && !state.focusMode);
  key(document.body, 'Escape');
  await sleep(20);
  {
    const { buildPrintDoc } = await import('../core/print-doc.js');
    const { shots } = await import('../core/shots.js');
    const doc = buildPrintDoc({ title: state.title, rows: state.rows, speechRate: state.speechRate });
    const dom = new DOMParser().parseFromString(doc.html, 'text/html');
    t(
      'PDF 每个镜头一行',
      dom.querySelectorAll('tr.shot').length === shots(state.rows).length,
      `${dom.querySelectorAll('tr.shot').length}`,
    );
    t('PDF 逐句保留口播', dom.querySelectorAll('tr.shot li').length === rows().length);
    t('PDF 原生接口已暴露', typeof window.native.exportPdf === 'function');
  }

  const beforeDelete = structuredClone(state.rows);
  actions.deleteRows([rows()[0].id]);
  click($('#toastAct'));
  t('删除提示上的撤销恢复句子', JSON.stringify(state.rows) === JSON.stringify(beforeDelete));

  const suite = async (label, path, fn) => {
    try {
      const m = await import(path);
      await m[fn](t);
    } catch (error) {
      t(`${label} 套件异常`, false, (error.stack || error.message).split('\n')[0]);
    }
  };
  await suite('素材', './assets-selftest.js', 'runAssetTests');
  await suite('共用范围', './group-selftest.js', 'runGroupRangeTests');
  await suite('工作流', './workspace-selftest.js', 'runWorkspaceTests');
  await suite('1.3 新功能', './features-selftest.js', 'runFeatureTests');
  await suite('1.4 素材角色', './roles-selftest.js', 'runRoleTests');
  await suite('1.5 视频审核', './video-review-selftest.js', 'runVideoReviewTests');
  await suite('1.6 自定义类型 · 口播', './iteration-selftest.js', 'runIterationTests');
  const failed = R.filter(x => !x.ok);
  return { total: R.length, failed: failed.length, cases: R };
}
