import { pendingCount } from '../features/review-model.js';
import { viewState } from '../app/view-state.js';
/* 异步保存必须归属启动时的项目和候选；全部原生任务用替身，不碰真实素材。 */
import { state } from '../app/state.js';
import { on } from '../app/events.js';
import { update } from '../app/project-events.js';
import { rowById, types, timeline } from '../app/project-queries.js';
import * as storage from '../app/storage.js';
import { parseAny } from '../core/parse.js';
import {
  importCandidateData,
  decideCandidate,
  setCandidateNote,
  deleteCandidateBatch,
  purgeRejectedCandidates,
} from '../app/candidate-actions.js';
import { applyRemoteProject } from '../app/collab-apply.js';
import { setType, setShotNote, renameProject } from '../app/actions.js';
import { captureSaveTask, saveCandidateSegment, isCandidateBusy } from '../app/candidate-media.js';
import { flushWriteBack } from '../app/candidate-sync.js';
import { changeProject, saveCurrentProject } from '../app/project-change.js';
import { clearUndo, canUndo, canRedo, undo, redo, setSnapshotHooks, rebaseHistory } from '../app/undo.js';
import { addRefsToShot, rememberDuration } from '../app/asset-actions.js';
import { createReplica, receiveOps, rebaseSnapshot, LOG_MAX } from '../core/collab-sync.js';

const doc = url => ({
  type: 'fenjingtai-candidates',
  version: 4,
  project: '保存竞态回归',
  batch: '测试',
  shots: [
    {
      lines: '1',
      label: '测试画面',
      cands: [
        {
          key: 'race',
          for: '1',
          title: '测试片段',
          url,
          in: 2,
          out: 5,
          best: { in: 2, out: 5 },
          license: '公有领域',
          why: '测试画面',
        },
      ],
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
    viewState.view = 'table';
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
    {
      fresh();
      let initialTimeline = timeline();
      const changes = [];
      const off = on('project-committed', value => changes.push({ ...value, observed: timeline() }));
      try {
        saveCurrentProject();
        t('导出前保存不广播项目修改，也不重建时间轴', changes.length === 0 && timeline() === initialTimeline);
        const row0 = state.rows.find(r => r.kind === 'line');
        const oldNote = row0.note || '';
        const session = {};
        setShotNote(row0, '连续输入一', { session });
        setShotNote(row0, '连续输入二', { session });
        undo();
        t(
          '连续输入备注只撤销一步，回到输入前内容',
          state.rows.find(r => r.id === row0.id).note === oldNote && !canUndo(),
        );
        changes.length = 0;
        const cands = state.candidates;
        let reads = 0;
        state.candidates = new Proxy(cands, {
          get(target, key, receiver) {
            if (/^\d+$/.test(String(key))) reads++;
            return Reflect.get(target, key, receiver);
          },
        });
        pendingCount();
        reads = 0;
        pendingCount();
        t('待审数量缓存命中后每个候选只访问一次', reads === cands.length);
        state.candidates = cands;
        initialTimeline = timeline();
        renameProject('只改项目名称');
        t(
          '改名提交一次变化说明，保留时间轴缓存',
          changes.length === 1 && !changes[0].timing && timeline() === initialTimeline,
        );
        changeProject('修改备注', () => {
          state.rows.find(r => r.kind === 'line').note = '新备注';
        });
        t(
          '只改备注保留时间轴缓存，变更范围包含对应句子',
          timeline() === initialTimeline && changes.at(-1).rowIds.includes(state.rows.find(r => r.kind === 'line').id),
        );
        const row = state.rows.find(r => r.kind === 'line');
        changeProject('修改计时', change => {
          row.time = { start: 1, end: 4, st: 'ok' };
          change.emit('view-refresh');
        });
        t(
          '修改计时时在通知订阅者前使缓存失效',
          changes.at(-1).timing &&
            changes.at(-1).observed !== initialTimeline &&
            timeline().times.get(row.id).end === 4,
        );
        t(
          '项目状态不再包含界面选区、筛选或视图',
          !['sel', 'multi', 'filter', 'query', 'view'].some(key => Object.hasOwn(state, key)),
        );
        const selected = viewState.sel;
        const count = changes.length;
        let rejected = false;
        try {
          changeProject('不可序列化的修改', () => {
            viewState.sel = -1;
            row.circular = row;
          });
        } catch {
          rejected = true;
        }
        t(
          '提交校验失败时恢复项目对象并且不广播修改',
          rejected && !Object.hasOwn(row, 'circular') && changes.length === count && state.rows.includes(row),
        );
        t('项目失败恢复同时还原独立的界面选区', viewState.sel === selected);
      } finally {
        off();
      }
    }
    {
      fresh();
      update('rows');
      const row = state.rows.find(r => r.kind === 'line');
      const rowNode = document.querySelector(`.row[data-id="${row.id}"]`);
      const filters = document.querySelector('#filters').firstElementChild;
      let initialTimeline = timeline();
      const commits = [];
      let workspace = 0;
      const offCommit = on('project-committed', change => commits.push(change));
      const offWorkspace = on('workspace', () => workspace++);
      try {
        setShotNote(row, '通过统一提交刷新的描述');
        t(
          '描述修改不发送旧通知也会显示，保留表格与统计节点',
          document.querySelector(`.row[data-id="${row.id}"]`) === rowNode &&
            rowNode.querySelector('.note').textContent === row.note &&
            document.querySelector('#filters').firstElementChild === filters,
        );
        t(
          '描述修改只提交一次、工作区只刷新一次且时间轴不失效',
          commits.length === 1 && workspace === 1 && timeline() === initialTimeline,
        );
        workspace = 0;
        const count = commits.length;
        row.note = '协作传来的描述';
        applyRemoteProject(
          { pid: state.projectId },
          {
            rows: new Set([row.id]),
            fields: new Set(['note']),
            meta: new Set(),
            structural: false,
            assets: false,
            cands: false,
            removed: [],
          },
        );
        t(
          '协作局部修改只发布一次提交，不再退回整体刷新',
          commits.length === count + 1 &&
            commits.at(-1).source === 'remote' &&
            workspace === 1 &&
            document.querySelector(`.row[data-id="${row.id}"]`) === rowNode &&
            rowNode.querySelector('.note').textContent === '协作传来的描述' &&
            timeline() === initialTimeline,
        );
        setType([row.id], 'fx');
        undo();
        t(
          '撤销标注使用同一变化清单恢复显示，时间轴缓存保留',
          commits.at(-1).source === 'history' &&
            commits.at(-1).rowFields.includes('type') &&
            timeline() === initialTimeline &&
            document.querySelector(`.row[data-id="${row.id}"]`) === rowNode,
        );
        const previousCount = commits.length;
        update('view-refresh');
        t(
          '筛选与布局刷新不伪装成项目修改，也不失效时间轴',
          commits.length === previousCount && timeline() === initialTimeline,
        );
        const note = document.querySelector(`.note[data-id="${row.id}"]`);
        note.focus();
        workspace = 0;
        let caretStayed = true;
        for (const text of ['正在输入', '正在输入画面', '正在输入画面描述']) {
          note.textContent = text;
          const range = document.createRange();
          range.selectNodeContents(note);
          range.collapse(false);
          getSelection().removeAllRanges();
          getSelection().addRange(range);
          const { anchorNode, anchorOffset } = getSelection();
          note.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
          caretStayed &&= getSelection().anchorNode === anchorNode && getSelection().anchorOffset === anchorOffset;
        }
        t(
          '连续输入描述立即保存且不更换输入节点、不移动光标',
          rowById(row.id).note === '正在输入画面描述' &&
            document.activeElement === note &&
            document.querySelector(`.note[data-id="${row.id}"]`) === note &&
            caretStayed &&
            timeline() === initialTimeline,
        );
        t('连续输入时不在每个按键后重复刷新工作区', workspace === 0);
        await new Promise(resolve => setTimeout(resolve, 300));
        t('输入停顿后合并刷新一次工作区，保持输入焦点', workspace === 1 && document.activeElement === note);
        note.blur();
        await tick();
      } finally {
        offCommit();
        offWorkspace();
      }
    }
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
    pending = begin(c);
    changeProject(null, () => {
      state.candidates.splice(0, 1);
      c.note = '失败修改';
      return false;
    });
    result = await complete(pending);
    t(
      '失败恢复保留候选对象，进行中的正常保存仍能完成',
      result.attached && state.candidates[0] === c && c.savedPath === result.path && !c.note,
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
    let writes = 0,
      events = 0;
    const stopWrite = storage.onProjectWrite(() => writes++);
    const stopEvent = on('failed-change-test', () => events++);
    const before = JSON.stringify(state);
    const row = state.rows[0];
    try {
      changeProject(null, change => {
        state.title = '失败标题';
        state.speechRate = 9;
        state.mediaDir = '/failed';
        viewState.filter = 'none';
        row.text = '失败正文';
        state.rows = [];
        change.emit('failed-change-test');
        throw new Error('无撤销名称的修改失败');
      });
    } catch {}
    t('不记撤销的失败修改也恢复数据和界面状态', JSON.stringify(state) === before && state.rows[0] === row);
    t('失败操作不会通知保存、协作或业务订阅方', writes === 0 && events === 0 && canRedo());
    const rowId = row.id,
      typeId = state.types[0].id,
      typeLabel = state.types[0].label;
    changeProject(null, () => {
      row.id = 999999;
      rowById(row.id); // 在失败修改中也可能读取派生查询。
      state.types[0].label = '失败类型';
      types().label(typeId);
      return false;
    });
    t(
      '失败恢复使句子和类型缓存失效',
      rowById(rowId) === row && !rowById(999999) && types().label(typeId) === typeLabel,
    );

    const backgroundId = storage.createProject('后台失败回归', parseAny('后台原文。'));
    storage.switchProject(previous);
    const background = storage.projectById(backgroundId),
      backgroundBefore = JSON.stringify(background);
    writes = 0;
    changeProject(
      null,
      (change, project) => {
        project.title = '后台失败标题';
        project.rows[0].text = '后台失败正文';
        project.mediaDir = '/failed';
        return { error: '模拟后台校验失败' };
      },
      { projectId: backgroundId },
    );
    t('后台项目校验失败恢复原项目，不触发保存', JSON.stringify(background) === backgroundBefore && writes === 0);
    storage.switchProject(backgroundId);
    const normalizeBefore = JSON.stringify(state);
    try {
      changeProject(
        '规范化失败',
        () => {
          state.title = '不能留下的标题';
          state.rows = [null];
        },
        { normalize: true },
      );
    } catch {}
    t('提交前规范化失败也恢复完整数据', JSON.stringify(state) === normalizeBefore);
    stopWrite();
    stopEvent();

    // 日志多次裁剪后，撤销和重做仍保留对方修改；主机 / 访客都走同一条保护路径。
    for (const role of ['host', 'guest']) {
      fresh();
      const rep = createReplica(state, { role });
      const restoreHooks = setSnapshotHooks({
        mark: () => rep.seq,
        rebase: (data, entry) => rebaseSnapshot(rep, data, entry.mark),
      });
      try {
        clearUndo();
        const originalTitle = state.title;
        renameProject('自己的修改');
        undo(); // 保留一条重做历史，验证两边的栈都能补上对方修改。
        const id = state.rows.find(r => r.kind === 'line').id;
        for (let i = 0; i < LOG_MAX * 2 + 1; i++) {
          receiveOps(
            rep,
            state,
            { ops: [{ t: 'rf', id, k: i === 0 ? 'text' : 'note', v: i === 0 ? '同事改过的正文' : `意见 ${i}` }] },
            {
              beforePrune: through =>
                rebaseHistory(
                  state.projectId,
                  (data, entry) => rebaseSnapshot(rep, data, entry.mark, through),
                  through,
                ),
            },
          );
        }
        redo();
        t(
          `${role} 多轮日志清理后重做仍保留同事正文`,
          state.title === '自己的修改' && state.rows.find(r => r.id === id).text === '同事改过的正文',
        );
        undo();
        t(
          `${role} 多轮日志清理后撤销仍保留同事最新修改`,
          state.title === originalTitle &&
            state.rows.find(r => r.id === id).text === '同事改过的正文' &&
            state.rows.find(r => r.id === id).note === `意见 ${LOG_MAX * 2}` &&
            rep.log.length <= LOG_MAX,
        );
      } finally {
        restoreHooks();
        clearUndo();
      }
    }
    fresh();
    const staleRep = createReplica(state, { role: 'host' });
    const restoreStaleHooks = setSnapshotHooks({
      mark: () => staleRep.seq,
      rebase: (data, entry) => rebaseSnapshot(staleRep, data, entry.mark),
    });
    try {
      renameProject('过期历史不能覆盖');
      const id = state.rows.find(r => r.kind === 'line').id;
      for (let i = 0; i <= LOG_MAX; i++)
        receiveOps(staleRep, state, { ops: [{ t: 'rf', id, k: 'text', v: `同事正文 ${i}` }] });
      undo();
      t(
        '过期撤销被拒绝且不丢历史、不覆盖同事正文',
        canUndo() &&
          !canRedo() &&
          state.title === '过期历史不能覆盖' &&
          state.rows.find(r => r.id === id).text === `同事正文 ${LOG_MAX}`,
      );
    } finally {
      restoreStaleHooks();
      clearUndo();
    }
    fresh();
    clearUndo();
    const assetsBefore = Object.keys(state.assets).sort().join();
    addRefsToShot(
      state.rows.find(r => r.kind === 'line'),
      ['/isolated/new.png'],
    );
    undo();
    t('添加素材撤销同时恢复登记表和画面引用', Object.keys(state.assets).sort().join() === assetsBefore);

    // 打字即存、后台读到的结果：撤销别的操作时不能被旧快照带回去
    c = fresh();
    const line = () => state.rows.find(r => r.kind === 'line');
    const oldTitle = state.title;
    addRefsToShot(line(), ['/isolated/dur.png']);
    renameProject('改过的名字');
    undo();
    t('改项目名算一步撤销', state.title === oldTitle && canUndo());
    undo();
    t('撤销前一步不会把项目名带偏', state.title === oldTitle);

    c = fresh();
    const session = { snapped: false };
    setCandidateNote(c.id, '意', session);
    setCandidateNote(c.id, '意见', session);
    undo();
    t('同一次输入的审核意见一步撤销', !state.candidates.find(x => x.id === c.id).note && !canUndo());

    c = fresh();
    addRefsToShot(line(), ['/isolated/dur.png']);
    const asset = Object.values(state.assets).find(a => a.path === '/isolated/dur.png');
    rememberDuration(asset, 12);
    addRefsToShot(line(), ['/isolated/other.png']);
    undo();
    t('撤销后读到的素材时长还在', state.assets[asset.id]?.durationSec === 12);

    storage.createProject('清理回归', parseAny('第一句话。'));
    importCandidateData(
      {
        ...doc(urlA),
        shots: [
          {
            lines: '1',
            label: '测试画面',
            cands: [
              {
                key: 'keep',
                for: '1',
                title: '留下',
                url: urlA,
                in: 0,
                out: 2,
                best: { in: 0, out: 2 },
                license: '公有领域',
                why: '测试',
              },
              {
                key: 'drop',
                for: '1',
                title: '不要',
                url: urlB,
                in: 0,
                out: 2,
                best: { in: 0, out: 2 },
                license: '公有领域',
                why: '测试',
              },
            ],
          },
        ],
      },
      src,
    );
    const [keep, drop] = state.candidates;
    decideCandidate(keep.id, 'ok');
    clearUndo();
    decideCandidate(drop.id, 'no');
    addRefsToShot(line(), ['/isolated/after.png']);
    const removed = await purgeRejectedCandidates();
    undo();
    t('撤销别的操作不会让已清理的候选回来', removed.length === 1 && !state.candidates.some(x => x.id === drop.id));
    undo();
    t(
      '撤销那次否决时候选照常回来',
      state.candidates.some(x => x.id === drop.id && x.decision !== 'no'),
    );
  } finally {
    await flushWriteBack();
    window.fjtHooks = hooks;
    storage.switchProject(previous);
    clearUndo();
  }
}
