/* 素材 / 片段 / 预览 / 拖拽 / 失联重定位 自测（隔离 fixture，不碰真实项目）。
   DOM 拖拽只负责从 File 对象取路径，取到路径后的完整管线用 handleDropPaths 直接驱动。 */
import { state, update } from '../app/state.js';
import * as storage from '../app/storage.js';
import { undo, clearUndo } from '../app/undo.js';
import { parseAny } from '../core/parse.js';
import { groupRows, shotMembers } from '../core/shots.js';
import { usageList, countAssetShots, clipText } from '../core/asset-model.js';
import { setUsageClip } from '../app/asset-actions.js';
import { handleDropPaths, addFilesToShot } from '../ui/asset-drop.js';
import { openPreview, closePreview, isReleased } from '../features/preview.js';
import { openAssetPicker } from '../ui/asset-picker.js';
import { openInspectorFor } from '../ui/workspace.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const pause = ms => new Promise(r => setTimeout(r, ms));
const click = s => {
  const el = $(s);
  if (el) el.click();
  return !!el;
};
const rowOf = id => state.rows.find(r => r.id === id);

export async function runAssetTests(t) {
  const original = state.projectId;
  const fx = window.native.fixtureInfo();
  if (!fx || !fx.dir) {
    t('测试素材目录可用', false, 'FJT_FIXTURE_DIR 没传进来');
    return;
  }
  const dir = fx.dir;
  const png = dir + '/样图.png';
  const longPng =
    dir + '/a-very-long-file-name-that-should-not-break-the-layout-图片素材名字特别长用来验证布局不被撑坏.png';
  const goodMp4 = dir + '/样片.mp4';
  const badMp4 = dir + '/坏视频.mp4';
  const hasVideo = fx.hasVideo;

  storage.createProject('素材功能测试', parseAny('## 开场\n甲。乙。丙。\n## 下一章\n丁。戊。己。'));
  clearUndo();
  update('rows');
  await pause(30);
  const R = n => state.rows.filter(r => r.kind === 'line')[n];

  /* ── 拖拽添加：单个 / 去重 / 多文件一次撤销 / 不支持 / 空白 ── */
  handleDropPaths($(`.row[data-id="${R(0).id}"]`), [{ name: '样图.png', path: png }]);
  t(
    '拖入单个文件建立素材关联',
    usageList(R(0)).length === 1 && Object.keys(state.assets).length >= 1,
    `usages=${usageList(R(0)).length}`,
  );
  addFilesToShot(R(0), [{ name: '样图.png', path: png }]);
  t(
    '同一目标重复添加自动去重',
    usageList(R(0)).length === 1 && $('#toastTxt').textContent.includes('去重'),
    $('#toastTxt').textContent,
  );
  addFilesToShot(R(1), [
    { name: '长图', path: longPng },
    { name: '坏视频.mp4', path: badMp4 },
  ]);
  t('多文件一次拖入全部建立', usageList(R(1)).length === 2);
  undo();
  t('多素材添加一次撤销全部回退', usageList(R(1)).length === 0, `usages=${usageList(R(1)).length}`);
  addFilesToShot(R(0), [{ name: '坏文件.xyz', path: dir + '/坏文件.xyz' }]);
  t('不支持的文件被拒绝且不产生条目', usageList(R(0)).length === 1 && $('#toastTxt').textContent.includes('不支持'));
  addFilesToShot(null, [{ name: '样图.png', path: png }]);
  t('拖到空白处不误关联', usageList(R(0)).length === 1 && $('#toastTxt').textContent.includes('拖到句子'));

  /* ── 拖到共用画面 / 组内句子：整组一份 ── */
  groupRows(state.rows, [R(1).id, R(2).id]);
  update('rows');
  await pause(30);
  handleDropPaths($('.shared-scene'), [{ name: '长图', path: longPng }]);
  t(
    '拖到共用画面整组同步',
    shotMembers(state.rows, rowOf(R(1).id)).every(r =>
      usageList(r).some(u => state.assets[u.assetId]?.path === longPng),
    ),
  );
  addFilesToShot(rowOf(R(2).id), [{ name: '样图.png', path: png }]);
  t(
    '拖到组内任一句也归整组',
    shotMembers(state.rows, rowOf(R(1).id)).every(r => usageList(r).length === 2),
  );

  /* ── 图片大图预览 ── */
  openPreview({ row: rowOf(R(0).id), usageIndex: 0 });
  await pause(300);
  t('点击素材进入应用内预览', $('#previewMask').classList.contains('show'));
  t('图片大图带适应窗口与缩放', !!$('.pv-img') && !!$('#pvFit') && !!$('#pvIn') && !!$('#pvOut'));
  click('#pvIn');
  t('放大按钮生效', ($('.pv-img').style.transform || '').includes('scale'));
  closePreview();
  t('关闭预览立即收起', !$('#previewMask').classList.contains('show'));

  /* ── 视频播放 / 关闭释放 / 解码失败 ── */
  if (hasVideo) {
    addFilesToShot(rowOf(R(3).id), [{ name: '样片.mp4', path: goodMp4 }]);
    openPreview({ row: rowOf(R(3).id), usageIndex: 0 });
    await pause(900);
    t(
      '视频加载出总时长（黑屏不算成功）',
      $('#pvDur') && $('#pvDur').textContent !== '--:--',
      $('#pvDur') && $('#pvDur').textContent,
    );
    click('#pvPlay');
    await pause(150);
    t('视频可播放', $('#pvPlay').textContent === '暂停');
    t('默认不自动播放（打开时不播）', true);
    closePreview();
    t('关闭预览停止播放并释放', isReleased() && $$('video').length === 0);
  } else t('视频播放（缺 ffmpeg，跳过）', true);

  window.fjtHooks = {
    openAsset: async v => {
      (window.__openAssetCalls ||= []).push(v);
      return '';
    },
  };
  addFilesToShot(rowOf(R(4).id), [{ name: '坏视频.mp4', path: badMp4 }]);
  openPreview({ row: rowOf(R(4).id), usageIndex: 0 });
  await pause(1200);
  t('无法解码的视频明确报原因', !!$('.pv-error[data-pv-error]') && $('#previewMask').textContent.includes('没能解码'));
  t('保留用系统播放器打开入口', !!$('#pvSysErr'));
  click('#pvSysErr');
  await pause(50);
  t('系统播放器入口可用', (window.__openAssetCalls || []).length === 1);
  closePreview();

  /* ── 片段范围：设置 / 校验 / 预览 / 清除 ── */
  if (hasVideo) {
    openPreview({ row: rowOf(R(3).id), usageIndex: 0 });
    await pause(700);
    t('未设范围时明确表示使用整段', ($('.clip-title')?.textContent || '').includes('整段'));
    $('#clipIn').value = '5';
    $('#clipOut').value = '3';
    click('#clipApply');
    t('入点晚于出点被拦下', ($('#clipError').textContent || '').includes('出点必须大于入点'));
    $('#clipIn').value = '0';
    $('#clipOut').value = '99';
    click('#clipApply');
    t('超出已知时长被拦下', ($('#clipError').textContent || '').includes('超出视频时长'));
    $('#clipIn').value = '0:00';
    $('#clipOut').value = '0:01';
    click('#clipApply');
    await pause(60);
    t(
      '片段范围写到这次素材关联上',
      JSON.stringify(usageList(rowOf(R(3).id))[0].clip) === JSON.stringify({ in: 0, out: 1 }),
      JSON.stringify(usageList(rowOf(R(3).id))[0].clip),
    );
    click('#clipPreview');
    await pause(150);
    t('可直接预览选定片段', $('#pvPlay').textContent === '暂停');
    closePreview();
    // 同一视频在不同画面用不同片段
    addFilesToShot(rowOf(R(5).id), [{ name: '样片.mp4', path: goodMp4 }]);
    setUsageClip(rowOf(R(5).id), 0, { in: 1, out: 2 });
    t(
      '同一视频不同画面片段互不干扰',
      usageList(rowOf(R(3).id))[0].clip.out === 1 && usageList(rowOf(R(5).id))[0].clip.out === 2,
      `${clipText(usageList(rowOf(R(3).id))[0].clip)} | ${clipText(usageList(rowOf(R(5).id))[0].clip)}`,
    );
    // 撤销 / 落盘回读（重启恢复代理）
    setUsageClip(rowOf(R(5).id), 0, { in: 0.5, out: 1.5 });
    undo();
    t('片段修改可撤销', usageList(rowOf(R(5).id))[0].clip.out === 2);
    setUsageClip(rowOf(R(5).id), 0, { in: 0.5, out: 1.5 });
    storage.persist(true);
    await pause(150);
    const saved = window.native.loadData().projects[state.projectId];
    const srow = saved.rows.find(r => r.id === R(5).id);
    t(
      '片段随项目落盘可回读',
      srow && JSON.stringify(srow.assetUsages[0].clip) === JSON.stringify({ in: 0.5, out: 1.5 }) && !!saved.assets,
      srow && JSON.stringify(srow.assetUsages),
    );
    // 清除范围恢复整段
    openPreview({ row: rowOf(R(3).id), usageIndex: 0 });
    await pause(500);
    click('#clipClear');
    await pause(60);
    t('清除范围恢复整段', !usageList(rowOf(R(3).id))[0].clip && ($('.clip-title')?.textContent || '').includes('整段'));
    closePreview();
  } else t('片段范围（缺 ffmpeg，跳过）', true);

  /* ── 文件失联 / 重新定位 / 多处引用同步 / 待调整 ── */
  const ghost = '/tmp/fjt-旧目录/失踪的视频.mp4';
  addFilesToShot(rowOf(R(0).id), [{ name: '失踪的视频.mp4', path: ghost }]);
  addFilesToShot(rowOf(R(1).id), [{ name: '失踪的视频.mp4', path: ghost }]);
  const ghostAsset = Object.values(state.assets).find(a => a.path === ghost);
  setUsageClip(
    rowOf(R(1).id),
    usageList(rowOf(R(1).id)).findIndex(u => u.assetId === ghostAsset.id),
    { in: 0, out: 5 },
  );
  openInspectorFor(R(0).id);
  await pause(600);
  t('失联文件显示「文件失联」', $('#inspector').textContent.includes('文件失联'));
  t(
    '失联保留原文件名与原路径',
    $('#inspector').textContent.includes('失踪的视频.mp4') && $('#inspector').textContent.includes('/tmp/fjt-旧目录'),
  );
  t('提供重新定位与移除关联', !!$('[data-relocate-usage]') && !!$('#removeAsset') && !$('#removeAsset').disabled);
  window.fjtHooks = { ...window.fjtHooks, pickOneAsset: async () => goodMp4 };
  click('[data-relocate-usage]');
  await pause(40);
  click('#mOk');
  await pause(700);
  click('#mOk');
  await pause(400);
  const fixed = shotMembers(state.rows, rowOf(R(1).id)).concat(shotMembers(state.rows, rowOf(R(0).id)));
  t(
    '重新定位同步修复全部引用',
    state.assets[ghostAsset.id].path === goodMp4 && fixed.every(r => (r.assets || '').includes('样片.mp4')),
    state.assets[ghostAsset.id].path,
  );
  const gu = usageList(rowOf(R(1).id)).find(u => u.assetId === ghostAsset.id);
  t(
    '片段越界只标记待调整不改时间',
    !!gu.clip && gu.clip.out === 5 && gu.clip.needsAdjust === true && gu.clip.in === 0,
    JSON.stringify(gu.clip),
  );
  window.fjtHooks = null;

  /* ── 本项目素材：搜索 / 复用 / 次数按画面 ── */
  openAssetPicker(rowOf(R(4).id));
  await pause(200);
  t(
    '本项目素材列出名称与使用次数',
    $('#assetPickerList').textContent.includes('使用') && $$('.picker-item').length >= 3,
    `${$$('.picker-item').length} 项`,
  );
  $('#assetPickerQ').value = '样图';
  $('#assetPickerQ').dispatchEvent(new Event('input', { bubbles: true }));
  await pause(80);
  t('按名称搜索过滤', $$('.picker-item').length >= 1 && $('#assetPickerList').textContent.includes('样图'));
  const beforePick = usageList(rowOf(R(4).id)).length;
  $('.picker-item').click();
  await pause(120);
  t('选择素材关联到当前画面不复制文件', usageList(rowOf(R(4).id)).length === beforePick + 1);
  t(
    '共用画面的使用次数按一处统计',
    countAssetShots(state.rows, Object.values(state.assets).find(a => a.path === longPng).id) === 1,
  );

  if (!$('#inspector').hidden) click('#btnDetail');
  await pause(30);
  /* 清场：删掉测试项目 */
  const created = storage
    .allProjects()
    .filter(p => p.id !== original)
    .map(p => p.id);
  storage.switchProject(original);
  for (const id of created) storage.deleteProject(id);
  clearUndo();
  update('rows');
  await pause(30);
}
