/* 表格按块原地更新：没变的句子不换元素；别人增删改句子时正在看的位置不动；句号、时长原地改；
   共用画面、筛选、章节显隐、搜索高亮、原文视图互切都和整表重画的结果一致。 */
import { state, emit, update, types } from '../app/state.js';
import * as storage from '../app/storage.js';
import { setType } from '../app/actions.js';
import { undo, clearUndo } from '../app/undo.js';
import { openInspectorFor } from '../ui/inspector.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const rowEl = id => $(`#rows .row[data-id="${id}"]`);
const text = id => `第 ${id} 句。` + '长稿协作时保留正在阅读的位置。'.repeat(4 + (id % 5));
let nextId = 1000;

export async function runTablePatchTests(t) {
  const original = state.projectId;
  const previousView = state.view;
  let project;
  try {
    const rows = [];
    for (let i = 1; i <= 240; i++) {
      if (i % 60 === 1) rows.push({ id: 5000 + i, kind: 'section', text: `第 ${Math.ceil(i / 60)} 章` });
      rows.push({ id: i, kind: 'line', text: text(i), note: i % 7 ? '' : `第 ${i} 句的画面描述` });
    }
    project = storage.createProject('按块更新回归', rows);
    state.view = 'table';
    state.filter = 'all';
    state.query = '';
    update('rows');
    await pause(200);
    const remote = () => emit('collab-remote');

    /* 正在看第 150 句：别人改它上面看不见的地方，它在屏幕上的位置不动 */
    const look = async id => {
      rowEl(id).scrollIntoView({ block: 'center' });
      await pause(80);
      rowEl(id).scrollIntoView({ block: 'center' });
      await pause(400); // 等滚动后屏幕附近的占位块排完，量到的才是稳定位置
      return rowEl(id).getBoundingClientRect().top;
    };
    const drift = (id, top) => rowEl(id).getBoundingClientRect().top - top;
    state.sel = 1; // 选中句在很前面，阅读位置在后面
    update('selection');
    let top = await look(150);
    const kept = rowEl(150);
    const far = rowEl(230);
    const at = id => state.rows.findIndex(r => r.id === id);

    state.rows[at(20)].text = '同事把这句改得很长。'.repeat(30);
    remote();
    await pause(160);
    t(
      '别人改了上面看不见的一句：只换那一句，正在看的句子和别的句子都不换元素',
      rowEl(150) === kept && rowEl(230) === far && rowEl(20).textContent.includes('同事把这句改得很长'),
    );
    t('别人改了上面一句：正在看的位置不动', Math.abs(drift(150, top)) < 2, `偏移 ${drift(150, top).toFixed(1)}px`);

    top = rowEl(150).getBoundingClientRect().top;
    const added = Array.from({ length: 5 }, () => ({ id: nextId++, kind: 'line', text: '同事新加的一句。'.repeat(6) }));
    state.rows.splice(at(30), 0, ...added);
    remote();
    await pause(160);
    t(
      '别人在上面加了 5 句：后面的句号原地改成新的，元素不换',
      rowEl(150) === kept && rowEl(150).querySelector('.idx span').textContent === '155' && !!rowEl(added[0].id),
    );
    t('别人在上面加句：正在看的位置不动', Math.abs(drift(150, top)) < 2, `偏移 ${drift(150, top).toFixed(1)}px`);
    t(
      '句号变了，勾选框和更多按钮的读屏说明跟着改',
      rowEl(150).querySelector('.row-select').getAttribute('aria-label') === '勾选第 155 句' &&
        rowEl(150).querySelector('.row-more').getAttribute('aria-label') === '第 155 句的更多操作',
    );

    top = rowEl(150).getBoundingClientRect().top;
    state.rows.splice(at(40), 8);
    remote();
    await pause(160);
    t('别人删了上面几句：正在看的位置不动', Math.abs(drift(150, top)) < 2, `偏移 ${drift(150, top).toFixed(1)}px`);
    t('删掉的句子从表格里拿掉', !rowEl(40) && !rowEl(47) && rowEl(150) === kept);

    top = rowEl(150).getBoundingClientRect().top;
    state.rows[at(149)].text = '正在看的上一句被改得很长。'.repeat(12);
    remote();
    await pause(160);
    t('别人改了屏幕上紧挨着的上一句：正在看的句子留在原元素', rowEl(150) === kept);

    top = rowEl(150).getBoundingClientRect().top;
    state.rows[at(150)].text = '正在看的这句被同事改了。';
    remote();
    await pause(160);
    t(
      '别人改了正在看的这句：换成新内容，位置不动',
      rowEl(150).textContent.includes('正在看的这句被同事改了') && Math.abs(drift(150, top)) < 2,
      `偏移 ${drift(150, top).toFixed(1)}px`,
    );

    /* 选中、勾选状态不写进行的 HTML：换选中不换元素，新元素也带上选中状态 */
    const row151 = rowEl(151);
    state.sel = 151;
    update('selection');
    t('换选中句只改选中底色，不换元素', rowEl(151) === row151 && row151.classList.contains('selected'));
    state.rows[at(151)].text = '选中的这句被同事改了。';
    remote();
    await pause(60);
    t('选中的句子被别人改了：新元素仍是选中状态', rowEl(151) !== row151 && rowEl(151).classList.contains('selected'));

    /* 共用画面：组成、拆开、组内改字 */
    const g = 'g-test';
    for (const id of [100, 101, 102]) state.rows[at(id)].groupId = g;
    remote();
    await pause(60);
    const scene = rowEl(100)?.closest('.shared-scene');
    t(
      '组成共用画面：三句合成一块，类型和描述格在右边只有一份',
      !!scene &&
        scene.querySelectorAll('.row').length === 3 &&
        scene.querySelectorAll('.typebox').length === 1 &&
        scene.querySelectorAll('.visual-cell').length === 1 &&
        rowEl(102).classList.contains('shared-scene-end') &&
        !rowEl(100).querySelector('.typebox'),
    );
    t('共用画面的总秒数写在类型色块上面', !!scene?.querySelector('.typebox > .shared-total'));
    state.rows[at(101)].text = '组里中间这句改了。';
    remote();
    await pause(60);
    t(
      '组里改了一句：整组换新，仍是三句一组',
      rowEl(101)?.closest('.shared-scene')?.querySelectorAll('.row').length === 3 &&
        rowEl(101).textContent.includes('组里中间这句改了'),
    );
    for (const id of [100, 101, 102]) delete state.rows[at(id)].groupId;
    remote();
    await pause(60);
    t(
      '拆开共用画面：三句各自一行，各有类型和描述格',
      !rowEl(100).closest('.shared-scene') && [100, 101, 102].every(id => rowEl(id).querySelector('.typebox')),
    );

    /* 筛选：章节里一句都不显示时整章不显示；共用画面中间那句被筛掉，前后两句仍是一块 */
    for (const id of [110, 111, 112]) state.rows[at(id)].groupId = 'g-filter';
    const typeId = types().list[0].id;
    state.rows[at(110)].type = typeId;
    state.rows[at(112)].type = typeId;
    state.filter = typeId;
    update('rows');
    await pause(60);
    const filtered = rowEl(110)?.closest('.shared-scene');
    t(
      '筛选掉组里中间那句：前后两句仍合成一块',
      !!filtered && filtered.querySelectorAll('.row').length === 2 && !rowEl(111),
    );
    t('筛选下一句都没有的章节不显示', $$('#rows .sec-block').length === 1);
    state.filter = 'all';
    update('rows');
    await pause(60);
    t(
      '切回全部：四章都在，组里三句都回来',
      $$('#rows .sec-block').length === 4 && rowEl(110).closest('.shared-scene')?.querySelectorAll('.row').length === 3,
    );

    /* 搜索：命中的句子高亮，其余淡化；清空后恢复 */
    state.query = '第 200 句。'; // 带句号走正文搜索；不带会被当成编号直达
    emit('rows');
    await pause(60);
    t('搜索高亮命中的句子，其余淡化', !!rowEl(200).querySelector('mark') && rowEl(201).classList.contains('qdim'));
    state.query = '';
    emit('rows');
    await pause(60);
    t('清空搜索恢复', !rowEl(200).querySelector('mark') && !rowEl(201).classList.contains('qdim'));

    /* 原文视图和表格互切：各自整块重来，回到表格时内容完整 */
    state.view = 'check';
    update('rows');
    await pause(60);
    t('切到原文视图：表格的行都不在了', !$('#rows .row') && !!$('#rows .as'));
    state.view = 'table';
    update('rows');
    await pause(60);
    t(
      '切回表格：每句一行，句号连续',
      $$('#rows .row[data-id]').length === state.rows.filter(r => r.kind === 'line').length &&
        $$('#rows .row .idx span')
          .slice(0, 3)
          .map(x => x.textContent)
          .join(',') === '1,2,3',
    );

    /* 没有句子的筛选：显示空状态；切回来空状态消失 */
    state.filter = '__none__';
    update('rows');
    await pause(30);
    t('筛选下一句都没有：显示空状态', !!$('#rows .empty-hint') && !$('#rows .row'));
    state.filter = 'all';
    update('rows');
    await pause(30);
    t('切回全部：空状态消失', !$('#rows .empty-hint') && !!$('#rows .row'));

    /* 原地改过的句子（标注颜色、画面描述、改字），撤销回原来的数据后要按数据重画，不能当成「没变」留着 */
    clearUndo();
    setType([60], typeId);
    await pause(30);
    t('标注类型原地改，不换元素', !rowEl(60).classList.contains('unannotated'));
    undo();
    await pause(60);
    t(
      '撤销标注：这句回到未标注的样子',
      rowEl(60).classList.contains('unannotated') && !!rowEl(60).querySelector('.typebox .tchip.t-none'),
    );
    rowEl(62).scrollIntoView({ block: 'center' }); // 屏幕外的行不排版，读不到打的字；真人也只能在屏幕上打字
    await pause(60);
    const note = rowEl(62).querySelector('.note');
    // 测试窗口不在前台，focus() 不一定发焦点事件：照真实顺序手动发
    note.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    note.textContent = '临时写的描述';
    note.dispatchEvent(new InputEvent('input', { bubbles: true }));
    note.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await pause(30);
    t('打字写的画面描述存进数据', state.rows[at(62)].note === '临时写的描述');
    undo();
    await pause(60);
    t('撤销画面描述：格子里的字跟着回到原来', rowEl(62).querySelector('.note').textContent === '');
    const sent = rowEl(63).querySelector('.sent');
    sent.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    sent.textContent = '双击改过的字。';
    sent.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await pause(30);
    t(
      '双击改字原地生效',
      state.rows[at(63)].text === '双击改过的字。' && rowEl(63).textContent.includes('双击改过的字'),
    );
    undo();
    await pause(60);
    t('撤销改字：表格里显示原来的句子', rowEl(63).querySelector('.sent').textContent === text(63));
    state.view = 'check';
    update('rows');
    await pause(60);
    const span = () => $('#rows .as[data-id="64"]');
    setType([64], typeId);
    await pause(30);
    t('原文视图标注原地改', span().classList.contains('typed'));
    undo();
    await pause(60);
    t('原文视图撤销标注：句子回到未标注', !span().classList.contains('typed'));
    state.view = 'table';
    update('rows');
    await pause(60);

    /* 右侧面板：别人改别处时不重写；在面板里打字后撤销，面板跟着回到原来的字 */
    openInspectorFor(150);
    await pause(60);
    const panel = $('#inspector');
    const panelFirst = panel.firstElementChild;
    state.rows[at(200)].text = '面板开着时同事改了别处。';
    remote();
    await pause(60);
    t('别人改了别的句子：右侧面板不重写', panel.firstElementChild === panelFirst && !panel.hidden);
    const area = $('#detailNote');
    // 真实顺序：打字时面板有焦点，停手后的刷新被跳过；离开输入框后马上撤销，中间没有别的刷新
    area.focus();
    area.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    area.value = '面板里写的描述';
    area.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await pause(300);
    area.blur();
    area.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    t('面板里写的描述存进数据', state.rows[at(150)].note === '面板里写的描述');
    undo();
    await pause(60);
    t(
      '撤销面板里写的描述：面板跟着回到原来',
      $('#detailNote')?.value === '' && rowEl(150).querySelector('.note').textContent === '',
    );
    $('#btnDetail').click();
    await pause(30);

    /* 切到后台时别人改的内容照常显示，不再等切回来 */
    const before = rowEl(60);
    window.dispatchEvent(new Event('blur'));
    state.rows[at(61)].text = '切到后台时同事改的。';
    remote();
    await pause(60);
    t(
      '切到后台时别人的修改直接显示，没改的句子不换元素',
      rowEl(61).textContent.includes('切到后台时同事改的') && rowEl(60) === before,
    );
    window.dispatchEvent(new Event('focus'));
  } finally {
    window.dispatchEvent(new Event('focus'));
    state.filter = 'all';
    state.query = '';
    storage.switchProject(original);
    if (project) storage.deleteProject(project);
    state.view = previousView;
    update('rows');
    await pause(180);
  }
}
