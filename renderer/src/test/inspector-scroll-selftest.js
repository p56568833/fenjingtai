import { viewState } from '../app/view-state.js';
import { state } from '../app/state.js';
import { update } from '../app/project-events.js';
import { groupRows } from '../core/shots.js';
import { parseAny } from '../core/parse.js';
import { addRefsToShot, removeUsage } from '../app/asset-actions.js';
import { openInspectorFor } from '../ui/inspector.js';
import * as storage from '../app/storage.js';

const $ = s => document.querySelector(s);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function runInspectorScrollTests(t) {
  const original = state.projectId,
    oldView = viewState.view,
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
  let insertProject = null;
  try {
    for (const view of ['table', 'check']) {
      viewState.view = view;
      viewState.sel = lines[0].id; // 已选句在屏幕外，不能因为开面板而滚回去。
      update('rows');
      await pause(650); // 等切项目的入场动画结束，再测面板引起的位置变化。
      const wrap = $('#tableWrap');
      const sentence = $(`${view === 'table' ? '.sent' : '.as'}[data-id="${lines[214].id}"]`);
      sentence.scrollIntoView({ block: 'start' });
      await pause(80);
      wrap.scrollTop += sentence.getBoundingClientRect().top - wrap.getBoundingClientRect().top - 55;
      await pause(650); // 屏幕外的行首次进入视口时也可能开始入场动画。
      const at = () => sentence.getBoundingClientRect().top - wrap.getBoundingClientRect().top;
      for (const action of ['打开', '按钮关闭', '再次打开', '再次关闭']) {
        const before = at();
        const width = sentence.getBoundingClientRect().width;
        $('#btnDetail').click();
        const immediate = at();
        await pause(150);
        const drift = Math.abs(at() - before);
        t(
          `${view} ${action}素材面板保持第215句的位置`,
          drift <= 2 && Math.abs(immediate - before) <= 2 && viewState.sel === lines[0].id,
          JSON.stringify({ before, immediate, after: at(), drift, selected: viewState.sel }),
        );
        if (action === '打开' && view === 'table')
          t('开面板确实改变正文宽度', sentence.getBoundingClientRect().width < width - 20);
      }
      const before = at();
      openInspectorFor(lines[215].id);
      await pause(150);
      t(`${view} 从句子入口打开面板也保持阅读位置`, Math.abs(at() - before) <= 2);
      $('#btnDetail').click();
      await pause(100);
      $('#btnDetail').click();
      // 明确的新导航应覆盖面板的迟后校准。
      const next = $(`${view === 'table' ? '.sent' : '.as'}[data-id="${lines[250].id}"]`);
      next.scrollIntoView({ block: 'center' });
      await pause(150);
      const rect = next.getBoundingClientRect(),
        viewport = wrap.getBoundingClientRect();
      t(`${view} 开面板后的新导航不会被拉回旧句子`, rect.top >= viewport.top && rect.bottom <= viewport.bottom);
      $('#btnDetail').click();
      await pause(100);

      // 增删素材只应原地刷新当前画面的素材卡，不能重建整张表或改变阅读位置。
      const currentSentence = () => $(`${view === 'table' ? '.sent' : '.as'}[data-id="${lines[214].id}"]`);
      const positionOf = el => el.getBoundingClientRect().top - wrap.getBoundingClientRect().top;
      const beforeNode = currentSentence();
      const beforeAdd = positionOf(beforeNode);
      addRefsToShot(lines[214], ['/tmp/分镜台-增删素材位置测试.png']);
      await pause(120);
      const afterAddNode = currentSentence();
      t(
        `${view} 添加素材不重建中间列表且保持位置`,
        afterAddNode === beforeNode && Math.abs(positionOf(afterAddNode) - beforeAdd) <= 2,
      );
      const beforeRemove = positionOf(afterAddNode);
      removeUsage(lines[214], 0);
      await pause(120);
      const afterRemoveNode = currentSentence();
      t(
        `${view} 移除素材不重建中间列表且保持位置`,
        afterRemoveNode === afterAddNode && Math.abs(positionOf(afterRemoveNode) - beforeRemove) <= 2,
      );
    }

    // 协作时同事在前面插句：整表重建后，正在看的句子不能被挤走。
    // 直接跳到长稿后段：前面的行从没展开过，重建后先按真实高度排一遍、下一帧又缩回占位高度，校准要跟得上。
    const text = Array.from(
      { length: 400 },
      (_, i) =>
        `第${i + 1}句口播${i % 7 ? '' : '，这一句特别长，会在表格里折成两行甚至三行，模拟真实稿子里长短不一的句子'}。`,
    ).join('\n');
    storage.createProject('插句位置测试', parseAny(text));
    insertProject = state.projectId;
    viewState.view = 'table';
    update('rows');
    await pause(650);
    const target = state.rows.filter(r => r.kind === 'line')[299];
    const sentence = () => $(`.sent[data-id="${target.id}"]`);
    sentence().scrollIntoView({ block: 'center' });
    await pause(200);
    const before = sentence().getBoundingClientRect().top;
    const track = [];
    for (let k = 0; k < 3; k++) {
      state.rows.splice(3, 0, { id: 900000 + k, kind: 'line', type: 'real', text: '同事在前面新插的一句。' });
      update('rows');
      for (let f = 0; f < 6; f++) {
        // 这一帧画完之后再量：看到的就是屏幕上真正出现过的位置
        await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
        track.push(Math.round(sentence().getBoundingClientRect().top - before));
      }
    }
    t(
      '同事在前面插句时，正在看的句子位置不动',
      track.every(d => Math.abs(d) <= 2),
      JSON.stringify(track),
    );
  } finally {
    if (!$('#inspector').hidden) $('#btnDetail').click();
    storage.switchProject(original);
    storage.deleteProject(project);
    if (insertProject) storage.deleteProject(insertProject);
    viewState.view = oldView;
    update('rows');
    if (wasOpen) $('#btnDetail').click();
    await pause(100);
  }
}
