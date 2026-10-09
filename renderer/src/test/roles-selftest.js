/* 1.4 素材角色与位置自测：默认角色、表格只摆要用的、角色同步整组、
   同一句只能有一个主画面、位置（第几句到第几句）、交稿检查、素材清单、解除共用后各句各留各的、撤销。 */
import { state, update } from '../app/state.js';
import * as storage from '../app/storage.js';
import { undo, clearUndo } from '../app/undo.js';
import { parseAny } from '../core/parse.js';
import { checkDelivery } from '../core/shots.js';
import { usageList } from '../core/asset-model.js';
import { addRefsToShot, setUsageSpan } from '../app/asset-actions.js';
import { setType, ungroupAction } from '../app/actions.js';
import { buildAssetListMd } from '../core/export-doc.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const pause = ms => new Promise(r => setTimeout(r, ms));
const click = s => {
  const el = typeof s === 'string' ? $(s) : s;
  if (el) el.click();
  return !!el;
};
const lines = () => state.rows.filter(r => r.kind === 'line');
const us = (n = 0) => usageList(lines()[n]);

export async function runRoleTests(t) {
  const original = state.projectId;
  storage.createProject('素材角色测试', parseAny('## 段\n甲。乙。丙。\n## 别的\n丁。'));
  clearUndo();
  state.view = 'table';
  update('rows');
  await pause(30);
  const ids = lines()
    .slice(0, 3)
    .map(r => r.id);
  state.multi = ids;
  state.sel = ids[0];
  state.multiMode = true;
  update('selection');
  click('#btnGroup');
  click('#mOk');
  state.multiMode = false;
  setType(ids, 'real');
  const A = lines()[0];
  addRefsToShot(A, ['/tmp/角色-主.png', '/tmp/角色-叠.png', '/tmp/角色-备.mp4']);
  update('rows');
  await pause(30);
  t(
    '空画面第一个素材默认主画面，其余备选',
    us()[0].role === 'main' && us()[1].role === 'alt' && us()[2].role === 'alt',
    JSON.stringify(us()),
  );
  const cell = () => $('.shared-scene .row-assets')?.textContent || '';
  t(
    '表格只摆要用的素材，备选收成一个入口',
    cell().includes('角色-主.png') && !cell().includes('角色-叠.png') && /备选 2 个/.test(cell()),
    cell(),
  );

  state.sel = A.id;
  state.multi = null;
  update('selection');
  if ($('#inspector').hidden) click('#btnDetail');
  click(`[data-detail="${A.id}"]`);
  t(
    '面板每条素材都有主画面 / 叠加 / 备选三个按钮',
    $$('#inspector .asset-role').length === 3 && $$('#inspector .role-chip').length === 9,
  );

  click('#inspector [data-role-usage="1"][data-role="overlay"]');
  t(
    '设为叠加，组内每句同步',
    [0, 1, 2].every(n => us(n)[1].role === 'overlay'),
  );
  // 句子范围选择已从面板移除，范围规则仍通过数据操作验证。
  const pickSpan = (index, from, to) => {
    const row = state.rows.find(r => r.id === state.sel);
    setUsageSpan(row, index, from, to);
  };
  pickSpan(1, 1, 1);
  t('位置：叠加只在第二句出现', us(0)[1].off === true && !us(1)[1].off && us(2)[1].off === true);
  await pause(20);
  t('表格写明叠加出现在第几句', cell().includes(`第 ${lines()[1].no} 句`) && cell().includes('角色-叠.png'), cell());

  click('#inspector [data-role-usage="2"][data-role="main"]');
  t('1.8 一段可以有多个主画面：新设的主画面不再把原来的挤成备选', us()[2].role === 'main' && us()[0].role === 'main');
  pickSpan(2, 1, 2);
  pickSpan(0, 0, 0);
  click('#inspector [data-role-usage="0"][data-role="main"]');
  t(
    '位置不重叠时可以前后两个主画面',
    us()[0].role === 'main' && us()[2].role === 'main' && us(0)[2].off === true && us(0)[0].off !== true,
  );
  const issuesOf = () => checkDelivery(state.rows).find(x => x.id === lines()[0].id)?.issues || [];
  t('主画面覆盖每一句时交稿检查不报', !issuesOf().some(x => x.includes('主画面')), issuesOf().join('、'));
  click('#inspector [data-role-usage="2"][data-role="alt"]');
  t('有句子没有主画面时交稿检查提醒', issuesOf().includes('部分句子没有主画面'), issuesOf().join('、'));
  const md = buildAssetListMd({ title: 't', rows: state.rows, issues: [], registry: state.assets, speechRate: 4.5 });
  t(
    '素材清单只列要用的，备选只报个数',
    md.includes('【主画面】角色-主.png') &&
      md.includes('【叠加】角色-叠.png') &&
      !md.includes('角色-备.mp4') &&
      md.includes('另有备选 1 个'),
    md.split('\n').find(l => l.includes('素材：')),
  );
  undo();
  t('角色修改可撤销', us()[2].role === 'main');

  ungroupAction(ids);
  t(
    '解除共用后每句只留下原本在这句出现的素材',
    us(0).length === 1 && us(0)[0].role === 'main' && us(1).length === 2 && us(2).length === 1,
    [0, 1, 2].map(n => us(n).length).join('/'),
  );
  undo();
  t('撤销解除共用，位置标记原样回来', !!lines()[0].groupId && us(0).length === 3 && us(0)[1].off === true);

  /* 旧项目：未分配角色的素材一键整理 */
  const D = lines()[3];
  D.type = 'real';
  D.assetUsages = us(0)
    .slice(0, 2)
    .map(u => ({ assetId: u.assetId }));
  update('rows');
  click(`[data-detail="${D.id}"]`);
  t(
    '旧素材显示「未分配」并提供一键整理',
    !!$('#autoRoles') && $$('#inspector .inspector-asset.role-none').length === 2,
  );
  click('#autoRoles');
  t(
    '一键整理：第一个当主画面，其余放备选',
    usageList(lines()[3])[0].role === 'main' && usageList(lines()[3])[1].role === 'alt' && !$('#autoRoles'),
  );

  /* 长稿中标记素材，当前句与视口应留在原地。 */
  const longRows = Array.from({ length: 180 }, (_, n) => ({
    id: n + 1,
    kind: 'line',
    text: `第 ${n + 1} 句。` + '这是验证长稿标记后仍停留在原画面的口播内容。'.repeat(5),
    type: 'real',
    note: '保留当前句的画面描述。',
    groupId: `scroll-group-${Math.floor(n / 3)}`,
    assetUsages: [{ assetId: 'scroll-a' }, { assetId: 'scroll-b' }],
  }));
  storage.createProject('长稿素材标记定位', longRows, {
    'scroll-a': { id: 'scroll-a', kind: 'link', path: 'https://example.com/a', name: '素材甲' },
    'scroll-b': { id: 'scroll-b', kind: 'link', path: 'https://example.com/b', name: '素材乙' },
  });
  state.sel = 91;
  state.multi = null;
  state.filter = 'all';
  update('rows');
  click('[data-detail="91"]');
  const target = () => $('.row[data-id="91"] .sent');
  const settle = async () => {
    target().scrollIntoView({ block: 'center' });
    await pause(80);
    target().scrollIntoView({ block: 'center' });
    await pause(80);
  };
  const stayAfter = async (name, action) => {
    await settle();
    const top = target().getBoundingClientRect().top;
    action();
    await pause(100);
    const drift = target().getBoundingClientRect().top - top;
    t(name, state.sel === 91 && Math.abs(drift) < 2, `选中 ${state.sel}，句子偏移 ${drift.toFixed(1)}px`);
  };
  await stayAfter('长稿：设主画面后仍停在原句原位置', () =>
    click('#inspector [data-role-usage="0"][data-role="main"]'),
  );
  await stayAfter('长稿：设叠加后仍停在原句原位置', () =>
    click('#inspector [data-role-usage="1"][data-role="overlay"]'),
  );
  await stayAfter('长稿：调整出现位置后仍停在原句原位置', () => pickSpan(1, 1, 2));
  // 恢复未分配状态，再覆盖一键整理的定位行为。
  state.rows.slice(90, 93).forEach(r => r.assetUsages.forEach(u => delete u.role));
  update('rows');
  click('[data-detail="91"]');
  await stayAfter('长稿：一键整理后仍停在原句原位置', () => click('#autoRoles'));

  /* 清场 */
  click('#btnDetail');
  const created = storage
    .allProjects()
    .filter(p => p.id !== original)
    .map(p => p.id);
  storage.switchProject(original);
  for (const id of created) storage.deleteProject(id);
  state.multi = null;
  state.multiMode = false;
  clearUndo();
  update('rows');
  await pause(30);
}
