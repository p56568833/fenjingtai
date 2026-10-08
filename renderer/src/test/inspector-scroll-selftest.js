import { state, update } from '../app/state.js';
import { groupRows } from '../core/shots.js';
import { parseAny } from '../core/parse.js';
import { openInspectorFor } from '../ui/inspector.js';
import * as storage from '../app/storage.js';

const $ = s => document.querySelector(s);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function runInspectorScrollTests(t) {
  const original = state.projectId,
    oldView = state.view,
    wasOpen = !$('#inspector').hidden;
  if (wasOpen) $('#btnDetail').click();
  const rows = parseAny(
    '## 长稿\n' +
      Array.from(
        { length: 450 },
        (_, i) =>
          `第${i + 1}句：一颗小小的绿白色胶囊，一天一粒的简便剂量，连社区家庭医生都能放心开具，让无数人第一次有勇气在诊室里承认自己不太对劲。`,
      ).join('\n'),
  );
  const lines = rows.filter(r => r.kind === 'line');
  for (let i = 0; i < lines.length; i += 3) {
    const members = lines.slice(i, i + 3);
    groupRows(
      rows,
      members.map(r => r.id),
    );
    members.forEach(r => {
      r.type = 'real';
      r.note = '胶囊实物特写，杂志封面与新闻报道；字幕说明每年的销售额。';
    });
  }
  storage.createProject('面板滚动定位测试', rows);
  const project = state.projectId;
  try {
    for (const view of ['table', 'check']) {
      state.view = view;
      state.sel = lines[0].id; // 已选句在屏幕外，不能因为开面板而滚回去。
      update('rows');
      await pause(650); // 等切项目的入场动画结束，再测面板引起的位置变化。
      const wrap = $('#tableWrap');
      const sentence = $(`${view === 'table' ? '.sent' : '.as'}[data-id="${lines[214].id}"]`);
      sentence.scrollIntoView({ block: 'start' });
      await pause(80);
      wrap.scrollTop += sentence.getBoundingClientRect().top - wrap.getBoundingClientRect().top - 55;
      await pause(650); // 屏幕外的行首次进入视口时也可能开始入场动画。
      const at = () => sentence.getBoundingClientRect().top - wrap.getBoundingClientRect().top;
      for (const action of ['打开', '按钮关闭', '再次打开', '面板关闭']) {
        const before = at();
        const width = sentence.getBoundingClientRect().width;
        $(action === '面板关闭' ? '#closeDetail' : '#btnDetail').click();
        const immediate = at();
        await pause(150);
        const drift = Math.abs(at() - before);
        t(
          `${view} ${action}素材面板保持第215句的位置`,
          drift <= 2 && Math.abs(immediate - before) <= 2 && state.sel === lines[0].id,
          JSON.stringify({ before, immediate, after: at(), drift, selected: state.sel }),
        );
        if (action === '打开' && view === 'table')
          t('开面板确实改变正文宽度', sentence.getBoundingClientRect().width < width - 20);
      }
      const before = at();
      openInspectorFor(lines[215].id);
      await pause(150);
      t(`${view} 从句子入口打开面板也保持阅读位置`, Math.abs(at() - before) <= 2);
      $('#closeDetail').click();
      await pause(100);
      $('#btnDetail').click();
      // 明确的新导航应覆盖面板的迟后校准。
      const next = $(`${view === 'table' ? '.sent' : '.as'}[data-id="${lines[250].id}"]`);
      next.scrollIntoView({ block: 'center' });
      await pause(150);
      const rect = next.getBoundingClientRect(),
        viewport = wrap.getBoundingClientRect();
      t(`${view} 开面板后的新导航不会被拉回旧句子`, rect.top >= viewport.top && rect.bottom <= viewport.bottom);
      $('#closeDetail').click();
      await pause(100);
    }
  } finally {
    if (!$('#inspector').hidden) $('#btnDetail').click();
    storage.switchProject(original);
    storage.deleteProject(project);
    state.view = oldView;
    update('rows');
    if (wasOpen) $('#btnDetail').click();
    await pause(100);
  }
}
