import { viewState } from '../app/view-state.js';
/* 搜索的真实界面回归：长稿定位、共用描述去重、输入法与连续跳转。 */
import { state } from '../app/state.js';
import { update } from '../app/project-events.js';
import { timeline } from '../app/project-queries.js';
import * as storage from '../app/storage.js';
import { openSearch, closeSearch } from '../ui/search.js';
import { setView } from '../ui/render.js';
import { runCommand } from '../ui/base/commands.js';

const $ = selector => document.querySelector(selector);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function runSearchTests(t) {
  const original = state.projectId;
  const previousView = viewState.view;
  let project;
  try {
    const rows = Array.from({ length: 150 }, (_, i) => {
      const no = i + 1;
      const groupId = no >= 90 && no <= 93 ? 'body-hit' : no >= 120 && no <= 122 ? 'note-hit' : null;
      return {
        id: no,
        kind: 'line',
        text: no === 91 || no === 141 ? `第 ${no} 句提到批发商。` : `第 ${no} 句。` + '长稿中的口播内容。'.repeat(4),
        note: groupId ? '批发商的共用画面描述' : '',
        groupId,
        type: no === 141 ? 'stock' : 'real',
      };
    });
    project = storage.createProject('搜索准确定位回归', rows);
    setView('table');
    update('rows');
    runCommand('nav:jump', 150);
    runCommand('inspector:open', 150);
    await pause(100);
    openSearch();
    const input = $('#searchInput');
    const type = async query => {
      input.value = query;
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
      await pause(230);
    };
    const press = (key, options) =>
      input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }));
    const enter = options => press('Enter', options);
    const shown = () => $('#searchbar').classList.contains('show');
    viewState.multi = [1, 2];
    await type('批发商');
    t(
      '输入搜索词后自动选中首个正文命中句，而非共用画面第一句',
      viewState.sel === 91 &&
        !viewState.multi &&
        $('#searchCnt').textContent === '1/3' &&
        $('.row.selected')?.dataset.id === '91' &&
        !!$('.row[data-id="91"] mark') &&
        $('.row[data-id="90"]').classList.contains('qdim'),
    );
    const box = $('.row[data-id="91"]').getBoundingClientRect();
    const viewport = $('#tableWrap').getBoundingClientRect();
    t('长稿搜索自动把命中的具体句子带进视口', box.top >= viewport.top && box.bottom <= viewport.bottom);
    t(
      '搜索不夺走输入焦点，时间条和面板同步到命中句',
      document.activeElement === input &&
        $('#segLine').textContent === '第 91 句' &&
        $('#inspector').dataset.row === '91',
    );
    press('ArrowDown');
    t('下键跳到下一个结果，共用描述仅计一次', viewState.sel === 120 && $('#searchCnt').textContent === '2/3');
    $('#qNext').click();
    t('搜索下一项继续定位到具体正文句', viewState.sel === 141 && $('#searchCnt').textContent === '3/3');
    $('#qNext').click();
    t('最后一个搜索结果之后回到第一项', viewState.sel === 91 && $('#searchCnt').textContent === '1/3');
    press('ArrowUp');
    t('上键反向循环到最后一个结果', viewState.sel === 141 && shown());
    $('#qPrev').click();
    t('搜索上一项按结果顺序返回', viewState.sel === 120);

    viewState.filter = 'real';
    update('rows');
    await type('批发');
    t(
      '搜索跳转保留当前类型筛选',
      viewState.sel === 91 && viewState.filter === 'real' && $('#searchCnt').textContent === '1/2',
    );
    input.value = '批发商';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    press('ArrowDown');
    t('防抖结束前立即按下键也不会跳过第一个结果', viewState.sel === 91 && $('#searchCnt').textContent === '1/2');
    press('ArrowDown');
    t('同一关键词再按下键才前往下一项', viewState.sel === 120);
    await type('完全不存在的关键词');
    t('搜索无结果保留当前位置并显示零项', viewState.sel === 120 && $('#searchCnt').textContent === '0/0');
    enter();
    t('没有结果时回车不收起搜索，方便继续改关键词', shown() && viewState.query === '完全不存在的关键词');
    await type('');
    t(
      '清空搜索保留当前位置并移除高亮',
      viewState.sel === 120 && !viewState.query && !$('#searchCnt').textContent && !$('#rows mark'),
    );

    input.value = '批';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    input.value = 'pifashang';
    input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    await pause(230);
    t('开始输入法组合时取消旧搜索，不用半截拼音跳转', !viewState.query && viewState.sel === 120);
    input.value = '批发商';
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    await pause(230);
    t('输入法上屏后自动定位首个正文命中句', viewState.sel === 91 && $('#searchCnt').textContent === '1/2');
    enter({ isComposing: true });
    t('输入法选字的回车不选定也不收起搜索', viewState.sel === 91 && shown());

    const inView = id => {
      const b = $(`.row[data-id="${id}"]`)?.getBoundingClientRect();
      const v = $('#tableWrap').getBoundingClientRect();
      return !!b && b.top >= v.top && b.bottom <= v.bottom;
    };
    const rowTop = id => $(`.row[data-id="${id}"]`).getBoundingClientRect().top;
    await pause(150);
    const before = rowTop(91);
    const blocks = [...document.querySelectorAll('#rows .row')];
    $('#qClose').click();
    await pause(150);
    t(
      '关闭搜索只原地去掉高亮，不换句子块（页面不闪）',
      blocks.every(el => el.isConnected) && !$('#rows .qdim') && !$('#rows mark'),
    );
    t(
      '点关闭后停在命中句，不跳回搜索前的位置',
      viewState.sel === 91 && !viewState.query && inView(91) && Math.abs(rowTop(91) - before) < 2,
      `sel=${viewState.sel} 位移=${Math.round(rowTop(91) - before)}`,
    );

    viewState.filter = 'all';
    update('rows');
    openSearch();
    const kept = [...document.querySelectorAll('#rows .row')];
    await type('第 141 句');
    t('搜索只原地加高亮和淡化，不换句子块', kept.every(el => el.isConnected) && !!$('#rows .qdim'));
    await pause(150);
    const hit = rowTop(141);
    $('.row[data-id="141"] .sent').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    $('.row[data-id="141"] .sent').click();
    await pause(150);
    t(
      '点正文结束搜索并停在原处',
      !$('#searchbar').classList.contains('show') &&
        !viewState.query &&
        !$('#rows mark') &&
        viewState.sel === 141 &&
        Math.abs(rowTop(141) - hit) < 2,
    );

    viewState.filter = 'real';
    update('rows');
    openSearch();
    await type('141');
    t(
      '输入编号直达对应句子，被筛选隐藏时切回全部',
      viewState.sel === 141 &&
        viewState.filter === 'all' &&
        $('#searchJump').textContent === '→ 第 141 句' &&
        $('#searchCnt').textContent === '1/1',
      `sel=${viewState.sel} filter=${viewState.filter} ${$('#searchJump').textContent} ${$('#searchCnt').textContent}`,
    );
    enter();
    t(
      '回车选定这句并收起搜索',
      !$('#searchbar').classList.contains('show') && !viewState.query && viewState.sel === 141,
    );
    openSearch();
    await type('9');
    t('纯数字只直达那一句，不再混入正文里的数字', viewState.sel === 9 && $('#searchCnt').textContent === '1/1');
    await type('9999');
    t('没有这一句时按正文搜索并提示', viewState.sel === 9 && $('#searchJump').textContent === '没有第 9999 句');
    await type('120-122');
    t('编号范围逐句切换', viewState.sel === 120 && $('#searchCnt').textContent === '1/3');
    press('ArrowDown');
    t('编号范围按下键到下一句', viewState.sel === 121);
    enter();
    t('多个结果时回车选定当前这句并收起搜索', viewState.sel === 121 && !shown() && !viewState.query);
    openSearch();
    await type('#999');
    t('不存在的编号给出提示并留在原处', viewState.sel === 121 && $('#searchJump').textContent === '没有第 999 句');
    const sec = Math.ceil(timeline().times.get(100).start);
    await type(`${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`);
    t(
      '输入口播时间跳到正在说的那句',
      viewState.sel === 100 && $('#searchJump').textContent.endsWith('→ 第 100 句') && inView(100),
      `sel=${viewState.sel} ${$('#searchJump').textContent}`,
    );
    await type('#1');
    await type(`${Math.floor(sec / 60)}.${String(sec % 60).padStart(2, '0')}`);
    t(
      '小数点写法的时间同样跳到正在说的那句',
      viewState.sel === 100 && $('#searchJump').textContent.endsWith('→ 第 100 句'),
      `sel=${viewState.sel} ${$('#searchJump').textContent}`,
    );
    await type('999:00');
    t('超出全片时长给出提示', viewState.sel === 100 && $('#searchJump').textContent.startsWith('超出全片时长'));

    closeSearch();
    t('关闭后清空直达提示', !$('#searchJump').textContent);
    viewState.filter = 'all';
    setView('check');
    openSearch();
    await type('批发商');
    t(
      '原文视图搜索同样准确选中共用画面中的命中句',
      viewState.sel === 91 &&
        $('.as.cur')?.dataset.id === '91' &&
        !!$('.as[data-id="91"] mark') &&
        $('#searchCnt').textContent === '1/3',
    );
  } finally {
    closeSearch();
    storage.switchProject(original);
    if (project) storage.deleteProject(project);
    setView(previousView);
    update('rows');
  }
}
