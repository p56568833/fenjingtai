/* 搜索的真实界面回归：长稿定位、共用描述去重、输入法与连续跳转。 */
import { state, update } from '../app/state.js';
import * as storage from '../app/storage.js';
import { openSearch, closeSearch } from '../ui/search.js';
import { setView } from '../ui/render.js';
import { runCommand } from '../ui/base/commands.js';

const $ = selector => document.querySelector(selector);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function runSearchTests(t) {
  const original = state.projectId;
  const previousView = state.view;
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
    const enter = options =>
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options }));
    state.multi = [1, 2];
    await type('批发商');
    t(
      '输入搜索词后自动选中首个正文命中句，而非共用画面第一句',
      state.sel === 91 &&
        !state.multi &&
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
    enter();
    t('回车跳到下一个结果，共用描述仅计一次', state.sel === 120 && $('#searchCnt').textContent === '2/3');
    $('#qNext').click();
    t('搜索下一项继续定位到具体正文句', state.sel === 141 && $('#searchCnt').textContent === '3/3');
    $('#qNext').click();
    t('最后一个搜索结果之后回到第一项', state.sel === 91 && $('#searchCnt').textContent === '1/3');
    enter({ shiftKey: true });
    t('Shift 回车反向循环到最后一个结果', state.sel === 141);
    $('#qPrev').click();
    t('搜索上一项按结果顺序返回', state.sel === 120);

    state.filter = 'real';
    update('rows');
    await type('批发');
    t('搜索跳转保留当前类型筛选', state.sel === 91 && state.filter === 'real' && $('#searchCnt').textContent === '1/2');
    input.value = '批发商';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    enter();
    t('防抖结束前立即回车也不会跳过第一个结果', state.sel === 91 && $('#searchCnt').textContent === '1/2');
    enter();
    t('同一关键词再次回车才前往下一项', state.sel === 120);
    await type('完全不存在的关键词');
    t('搜索无结果保留当前位置并显示零项', state.sel === 120 && $('#searchCnt').textContent === '0/0');
    await type('');
    t(
      '清空搜索保留当前位置并移除高亮',
      state.sel === 120 && !state.query && !$('#searchCnt').textContent && !$('#rows mark'),
    );

    input.value = '批';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    input.value = 'pifashang';
    input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    await pause(230);
    t('开始输入法组合时取消旧搜索，不用半截拼音跳转', !state.query && state.sel === 120);
    input.value = '批发商';
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    await pause(230);
    t('输入法上屏后自动定位首个正文命中句', state.sel === 91 && $('#searchCnt').textContent === '1/2');
    enter({ isComposing: true });
    t('输入法选字回车不前往下一个搜索结果', state.sel === 91);

    closeSearch();
    state.filter = 'all';
    setView('check');
    openSearch();
    await type('批发商');
    t(
      '原文视图搜索同样准确选中共用画面中的命中句',
      state.sel === 91 &&
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
