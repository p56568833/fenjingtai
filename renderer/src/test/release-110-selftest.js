/* 1.10 自测：撤销后回写候选清单、回写失败时不清掉「不要」、危险确认框回车不执行、提示条分类型、
   操作条批量标注、替换整稿清掉旧候选、紧凑行距。原生能力全部用 window.fjtHooks 替身，不碰网络和磁盘。 */
import { state, update } from '../app/state.js';
import * as storage from '../app/storage.js';
import { undo, clearUndo } from '../app/undo.js';
import { parseAny } from '../core/parse.js';
import { applyImport } from '../app/actions.js';
import { importLoadedFile } from '../ui/import-export.js';
import { closeVideoReview, flushWriteBack } from '../features/video-review.js';
import { confirmModal, toast } from '../ui/dom.js';
import { runCommand } from '../ui/commands.js';

const $ = s => document.querySelector(s);
const pause = ms => new Promise(r => setTimeout(r, ms));
const lines = () => state.rows.filter(r => r.kind === 'line');
const cand = key => state.candidates.find(c => c.key === key);
const key = (k, opts = {}) =>
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...opts }));

const DOC = {
  type: 'fenjingtai-candidates',
  version: 2,
  project: '1.10 自测',
  batch: '1.10 自测',
  shots: [
    {
      lines: '1',
      label: '甲',
      cands: [
        { key: 'A', title: '甲', url: 'https://x.org/a.mp4', in: 1, out: 5, license: '公有领域', why: '甲' },
        { key: 'B', title: '乙', url: 'https://x.org/b.mp4', in: 1, out: 5, license: '公有领域', why: '乙' },
      ],
    },
  ],
};

export async function runRelease110Tests(t) {
  const original = state.projectId;
  const writes = [];
  let writeFails = false;
  const hooksBefore = window.fjtHooks;
  window.fjtHooks = {
    ...(window.fjtHooks || {}),
    writeCandidateReview: async (file, results) => {
      writes.push({ file, results: structuredClone(results) });
      return writeFails ? { ok: false, error: '清单写不进去：没有写入权限' } : { ok: true };
    },
  };
  try {
    storage.createProject('1.10 自测', parseAny('## 段\n甲。乙。丙。\n## 别的\n丁。'));
    clearUndo();
    state.view = 'table';
    update('rows');
    await pause(30);

    /* 撤销「通过」后，清单文件也改回去 */
    importLoadedFile({ name: '候选.json', ext: 'json', content: JSON.stringify(DOC), path: '/tmp/候选-110.json' });
    await pause(60);
    $(`[data-vr-id="${cand('A').id}"] [data-vr-d="ok"]`)?.click();
    await flushWriteBack();
    const okWritten = writes.at(-1)?.results.find(r => r.key === 'A')?.decision === 'ok';
    undo();
    await pause(650);
    const last = writes.at(-1)?.results.find(r => r.key === 'A');
    t('撤销「通过」后自动把清单里的结果改回待审', okWritten && cand('A').decision === '' && last?.decision === '');

    /* 回写失败：关窗口时不清掉「不要」，窗口里能看到没写回 */
    writeFails = true;
    $(`[data-vr-id="${cand('B').id}"] [data-vr-d="no"]`)?.click();
    await pause(20);
    closeVideoReview();
    await pause(80);
    t('清单写不进去时「不要」的候选留在项目里', cand('B')?.decision === 'no');
    runCommand('video:open');
    await pause(40);
    t('审核窗口提示有清单没写回，可以重试', !$('#vrSync').hidden && $('#vrSync').textContent.includes('没写回'));
    writeFails = false;
    $('#vrRetrySync')?.click();
    await pause(60);
    closeVideoReview();
    await pause(80);
    t(
      '写回成功后，没有通过候选的画面仍保留「不要」的候选供返工',
      cand('B')?.decision === 'no' && writes.at(-1)?.results.find(r => r.key === 'B')?.decision === 'no',
    );
    runCommand('video:open');
    await pause(40);
    $(`[data-vr-id="${cand('A').id}"] [data-vr-d="ok"]`)?.click();
    await flushWriteBack();
    closeVideoReview();
    await pause(80);
    t('同一画面有候选通过后，写回成功再清掉「不要」的候选', cand('A')?.decision === 'ok' && !cand('B'));

    /* 危险确认框：回车不执行，焦点在「取消」 */
    let deleted = false;
    confirmModal('删除？', '测试', '删除', () => (deleted = true));
    await pause(40);
    const focusOnCancel = document.activeElement === $('#mCancel');
    key('Enter');
    await pause(20);
    t(
      '危险确认框打开时焦点在「取消」上，按回车不会删除',
      focusOnCancel && !deleted && !$('#modalMask').classList.contains('show'),
    );
    let confirmed = false;
    confirmModal('继续？', '测试', '继续', () => (confirmed = true), { danger: false });
    await pause(40);
    const ae = document.activeElement;
    const where = `${ae?.tagName}#${ae?.id}.${ae?.className}`;
    key('Enter');
    await pause(20);
    t('普通确认框按回车照常确认', confirmed, where);
    confirmModal('焦点循环', '测试', '删除', () => {});
    await pause(40);
    $('#mOk').focus();
    key('Tab');
    t('Tab 只在弹窗里转（从最后一个按钮回到第一个）', $('#modalMask').contains(document.activeElement));
    key('Escape');
    await pause(20);

    /* 提示条分类型 */
    toast('保存失败：磁盘满了');
    const errKind = $('#toast').dataset.kind;
    toast('已导出：x.md');
    t('出错的提示是红色、完成的提示才打勾', errKind === 'error' && $('#toast').dataset.kind === 'ok');

    /* 操作条：鼠标批量标注 */
    const ids = lines()
      .slice(1, 3)
      .map(r => r.id);
    state.multi = ids;
    state.sel = ids[0];
    update('selection');
    await pause(30);
    const typeBtn = $('#selTypes [data-sel-type]');
    typeBtn?.click();
    await pause(20);
    t(
      '操作条上点类型按钮，选中的句子一起标上',
      !!typeBtn && ids.every(id => state.rows.find(r => r.id === id).type === typeBtn.dataset.selType),
    );
    state.multi = [lines()[2].id, lines()[3].id]; // 跨章节
    update('selection');
    await pause(30);
    t('跨章节选中时直接写出不能共用的原因', !$('#selHint').hidden && $('#selHint').textContent.includes('章节'));
    state.multi = null;
    update('selection');

    /* 替换整稿：旧候选、字幕对齐一起清掉 */
    importLoadedFile({ name: '候选.json', ext: 'json', content: JSON.stringify(DOC), path: '/tmp/候选-110b.json' });
    await pause(60);
    closeVideoReview();
    await pause(40);
    const had = state.candidates.length;
    state.timing = { name: 'x.srt', cues: [] };
    applyImport(parseAny('完全不同的新稿子。第二句。'), '新稿', { mode: 'replace' });
    t('替换整稿后旧的视频候选和字幕对齐一起清掉', had > 0 && state.candidates.length === 0 && state.timing === null);
    undo();
    t('替换整稿可以撤销，候选回来', state.candidates.length === had);

    /* 紧凑行距 */
    const before = document.body.classList.contains('compact');
    runCommand('view:density');
    const after = document.body.classList.contains('compact');
    runCommand('view:density');
    t('紧凑行距可以开关', before !== after && document.body.classList.contains('compact') === before);

    /* 应用内更新：有新版本 → 顶栏按钮 → 看更新说明 → 下载 → 重启并更新 */
    const installs = [];
    window.fjtHooks = {
      ...window.fjtHooks,
      checkUpdate: async () => ({
        ok: true,
        available: true,
        version: '9.9.9',
        current: '1.10.0',
        notes: '修了很多问题\n第二行',
        size: 130 * 1048576,
        canInstall: true,
        page: 'https://github.com/x/y/releases/latest',
      }),
      downloadUpdate: async () => ({ ok: true, version: '9.9.9', verified: true }),
      installUpdate: async () => (installs.push(1), { ok: true }),
    };
    runCommand('update:check');
    await pause(40);
    t(
      '检查到新版本：顶栏出现下载图标「更新」按钮，弹出更新说明',
      !$('#btnUpdate').hidden &&
        $('#updButtonLabel').textContent === '更新' &&
        !!$('#btnUpdate svg') &&
        $('#btnUpdate').title.includes('9.9.9') &&
        $('#updateMask').classList.contains('show') &&
        $('#updNotes').textContent.includes('第二行'),
    );
    $('#updGo').click();
    await pause(40);
    t(
      '下载校验好后入口显示「重启更新」',
      $('#updGo').textContent === '重启并更新' && $('#updButtonLabel').textContent === '重启更新',
    );
    $('#updateMask').classList.remove('show');
    $('#btnUpdate').click();
    await pause(20);
    t('已下载时点击顶栏仍先打开详情，不直接安装', $('#updateMask').classList.contains('show') && installs.length === 0);
    /* 下好 9.9.9 之后又发了 9.9.10：点开时重新检查，改成直接下最新的一版，说明里列出跳过的每一版 */
    const checkBefore = window.fjtHooks.checkUpdate;
    window.fjtHooks.checkUpdate = async () => ({
      ...(await checkBefore()),
      version: '9.9.10',
      versions: ['9.9.10', '9.9.9'],
      notes: '【分镜台 9.9.10】\n新的\n\n【分镜台 9.9.9】\n修了很多问题',
    });
    $('#updateMask').classList.remove('show');
    $('#btnUpdate').click();
    await pause(20);
    t(
      '下好旧一版后又发了新版：点开显示最新版，按钮回到「下载并更新」，写明包含 2 个版本',
      $('#updTitle').textContent.includes('9.9.10') &&
        $('#updGo').textContent === '下载并更新' &&
        $('#updMeta').textContent.includes('包含 2 个版本') &&
        $('#updNotes').textContent.includes('分镜台 9.9.9') &&
        $('#updButtonLabel').textContent === '更新',
    );
    window.fjtHooks.downloadUpdate = async () => ({ ok: true, version: '9.9.10', verified: true });
    $('#updGo').click();
    await pause(40);
    t('下最新的一版', $('#updGo').textContent === '重启并更新');
    $('#updGo').click();
    await pause(20);
    t('点「重启并更新」交给主进程换新版', installs.length === 1);
    $('#updateMask').classList.remove('show');
    window.fjtHooks = {
      ...window.fjtHooks,
      checkUpdate: async () => ({ ok: true, available: false, current: '1.10.0' }),
    };
  } finally {
    window.fjtHooks = hooksBefore;
    const pid = state.projectId;
    if (storage.switchProject(original)) storage.deleteProject(pid);
    clearUndo();
    update('rows');
  }
}
