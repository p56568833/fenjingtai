/* 异步保存必须归属启动时的项目和候选；全部原生任务用替身，不碰真实素材。 */
import { state, on } from '../app/state.js';
import * as storage from '../app/storage.js';
import { parseAny } from '../core/parse.js';
import {
  importCandidateData,
  decideCandidate,
  setCandidateNote,
  deleteCandidateBatch,
} from '../app/candidate-actions.js';
import { captureSaveTask, saveCandidateSegment, isCandidateBusy } from '../app/candidate-media.js';
import { flushWriteBack } from '../app/candidate-sync.js';
import { changeProject } from '../app/project-change.js';
import { clearUndo, canUndo, canRedo, undo } from '../app/undo.js';
import { addRefsToShot } from '../app/asset-actions.js';

const doc = url => ({
  type: 'fenjingtai-candidates',
  version: 2,
  project: '保存竞态回归',
  batch: '测试',
  shots: [
    {
      lines: '1',
      label: '测试画面',
      cands: [{ key: 'race', title: '测试片段', url, in: 2, out: 5, license: '公有领域', why: '测试画面' }],
    },
  ],
});
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
export async function runArchitectureTests(t) {
  const previous = state.projectId;
  const hooks = window.fjtHooks;
  let resolveSave,
    request,
    fail = false;
  window.fjtHooks = {
    ...hooks,
    writeCandidateReview: async () => ({ ok: true }),
    saveVideoSegment: opts => {
      request = opts;
      if (fail) return Promise.reject(new Error('模拟保存失败'));
      return new Promise(resolve => {
        resolveSave = resolve;
      });
    },
  };
  const urlA = 'https://example.invalid/a.mp4',
    urlB = 'https://example.invalid/b.mp4';
  const src = '/isolated/architecture-candidates.json';
  const fresh = () => {
    storage.createProject('保存竞态回归', parseAny('第一句话。\n第二句话。'));
    state.view = 'table';
    importCandidateData(doc(urlA), src);
    const c = state.candidates[0];
    decideCandidate(c.id, 'ok');
    clearUndo();
    return c;
  };
  const begin = c => saveCandidateSegment(captureSaveTask(c.id), '/isolated/media');
  const complete = async promise => {
    resolveSave({ ok: true, path: '/isolated/media/test.mp4' });
    return promise;
  };
  try {
    let c = fresh();
    let pending = begin(c);
    importCandidateData(doc(urlB), src);
    decideCandidate(c.id, 'ok');
    let result = await complete(pending);
    t('异步保存使用启动时的地址和时间范围', request.url === urlA && request.start === 2 && request.end === 5);
    t('更新并重新通过候选后，旧片段不会关联', result.attached === false && !c.savedPath);
    t('旧保存任务完成后释放忙碌状态', !isCandidateBusy(c.id));

    c = fresh();
    pending = begin(c);
    importCandidateData(doc(urlB), src);
    decideCandidate(c.id, 'ok');
    importCandidateData(doc(urlA), src);
    decideCandidate(c.id, 'ok');
    result = await complete(pending);
    t('候选来源 A→B→A 也不能接收旧结果', result.attached === false && !c.savedPath);

    c = fresh();
    pending = begin(c);
    decideCandidate(c.id, 'ok');
    decideCandidate(c.id, 'ok');
    result = await complete(pending);
    t('撤回后重新通过使旧保存失效', result.attached === false && !c.savedPath);

    c = fresh();
    pending = begin(c);
    deleteCandidateBatch(new Set([c.id]));
    undo();
    result = await complete(pending);
    t('删除再撤销后的候选不会被旧任务覆盖', result.attached === false && !state.candidates[0].savedPath);

    c = fresh();
    const original = state.projectId;
    pending = begin(c);
    storage.createProject('另一项目', parseAny('另一句话。'));
    clearUndo();
    result = await complete(pending);
    t(
      '切项目后保存结果归属原项目',
      result.attached && storage.projectById(original).candidates[0].savedPath === result.path,
    );
    t(
      '后台保存不污染当前项目和撤销栈',
      state.candidates.length === 0 && Object.keys(state.assets).length === 0 && !canUndo(),
    );

    c = fresh();
    pending = begin(c);
    result = await complete(pending);
    t(
      '正常保存将片段和关联素材一起提交',
      result.attached && c.savedPath === result.path && state.assets[c.assetId]?.path === result.path,
    );
    undo();
    t(
      '正常保存可整体撤销',
      !state.candidates[0].savedPath && state.assets[state.candidates[0].assetId]?.path.startsWith('https:'),
    );

    c = fresh();
    fail = true;
    result = await begin(c);
    fail = false;
    t('保存异常释放任务并允许重试', result.ok === false && !isCandidateBusy(c.id) && !!captureSaveTask(c.id));

    // 第二次写回必须等待第一次完成，且排队内容不能受后续内存修改影响。
    await flushWriteBack();
    const calls = [];
    let releaseWrite;
    window.fjtHooks.writeCandidateReview = (file, results) => {
      calls.push(structuredClone(results));
      return calls.length === 1
        ? new Promise(resolve => {
            releaseWrite = resolve;
          })
        : Promise.resolve({ ok: true });
    };
    setCandidateNote(c.id, '第一版');
    const first = flushWriteBack();
    await tick();
    setCandidateNote(c.id, '第二版');
    const second = flushWriteBack();
    await tick();
    t('同一清单并发写回按提交顺序排队', calls.length === 1);
    c.note = '未提交的临时值';
    releaseWrite({ ok: true });
    await Promise.all([first, second]);
    t(
      '排队写回捕获当时内容，不读取迟后的全局状态',
      JSON.stringify(calls[0]).includes('第一版') && JSON.stringify(calls[1]).includes('第二版'),
    );
    window.fjtHooks.writeCandidateReview = async () => ({ ok: true });

    clearUndo();
    const title = state.title;
    let seen;
    const off = on('transaction-test', () => {
      seen = storage.current().title;
    });
    changeProject('改标题', change => {
      state.title = '提交后的标题';
      change.emit('transaction-test');
    });
    off();
    t('业务事件发出前项目已提交', seen === '提交后的标题');
    undo();
    changeProject('校验失败', () => ({ error: '校验失败' }));
    t('失败操作不添加撤销步、不清空重做', !canUndo() && canRedo() && state.title === title);
    let caught = false;
    try {
      changeProject('失败修改', () => {
        state.title = '不能留下';
        throw new Error('失败');
      });
    } catch {
      caught = true;
    }
    t('同步修改异常恢复原数据', caught && state.title === title && canRedo());
    const text = state.rows[0].text;
    try {
      changeProject('失败的原地修改', () => {
        state.rows[0].text = '不能写入项目库';
        return false;
      });
    } catch {}
    t(
      '失败修改恢复项目库共享引用',
      state.rows[0].text === text && storage.current().rows === state.rows && storage.current().rows[0].text === text,
    );
    clearUndo();
    const assetsBefore = Object.keys(state.assets).sort().join();
    addRefsToShot(
      state.rows.find(r => r.kind === 'line'),
      ['/isolated/new.png'],
    );
    undo();
    t('添加素材撤销同时恢复登记表和画面引用', Object.keys(state.assets).sort().join() === assetsBefore);
  } finally {
    await flushWriteBack();
    window.fjtHooks = hooks;
    storage.switchProject(previous);
    clearUndo();
  }
}
