import * as native from '../platform/native.js';

import { state } from '../app/state.js';
import { renumber, timeline } from '../app/project-queries.js';
import { memberSeconds } from '../core/timeline.js';

import {
  importCandidateData,
  setReworkNote as updateReworkNote,
  dismissShotRework,
  registerReworkRequest,
} from '../app/candidate-actions.js';

import { ensureMediaDir } from './review-files.js';

import { assetName } from '../core/asset-model.js';
import { CANDIDATE_VERSION } from '../core/candidate-values.js';

import { toast, confirmModal } from '../ui/base/dom.js';

import { CANDIDATE_SPEC } from '../core/candidate-spec.js';
import { buildReworkDoc } from '../core/rework.js';
import { page, rangeText, curReworkItem, reworkList, batchOfCand } from './review-model.js';

import { safeFileName } from '../core/text.js';

/* 导入反馈、返工意见和文件交付；不负责页面布局或播放器生命周期。 */
export function createReviewWorkflows({ open: openVideoReview, render: renderVideoReview }) {
  function importCandidates(doc, srcFile) {
    const plan = importCandidateData(doc, srcFile);
    if (plan.error) {
      if (plan.errors) showFormatErrors(plan.errors, srcFile);
      else toast(plan.error, null, 'error');
      return null;
    }
    if (!plan.added.length && !plan.updated.length) {
      toast(
        plan.skipped.length ? `清单里的 ${plan.skipped.length} 个候选都对不上句子` : '清单里没有候选',
        null,
        'warn',
      );
      return plan;
    }
    page.curBatch = plan.batch.batchId;
    page.curShot = null;
    openVideoReview();
    toast(
      `已导入 ${plan.added.length} 个视频候选${plan.updated.length ? `，更新 ${plan.updated.length} 个` : ''}${plan.reset ? `（其中 ${plan.reset} 个已通过的换了链接或片段，已撤下旧视频、回到待审）` : ''}${plan.skipped.length ? ` · ${plan.skipped.length} 个对不上句子，已跳过` : ''}`,
      null,
      plan.skipped.length ? 'warn' : 'ok',
    );
    return plan;
  }

  /* 格式不对的清单整份不导入：弹窗逐条写出错在哪；「复制给 AI」把全部错误连同格式规范一起复制，
   粘贴给找素材的 AI 让它照着改 */
  const SPEC_NAME = `《分镜台候选清单格式 v${CANDIDATE_VERSION}》`;
  function showFormatErrors(errors, srcFile) {
    const shown = errors.slice(0, 8);
    const more = errors.length > shown.length ? `\n…还有 ${errors.length - shown.length} 处` : '';
    const name = assetName(srcFile || '') || '这份清单';
    confirmModal(
      '候选清单格式不对，没有导入',
      `「${name}」没有按${SPEC_NAME}写，共 ${errors.length} 处问题，整份都没有导入：\n\n· ${shown.join('\n· ')}${more}\n\n点「复制给 AI」，会把全部问题和格式规范一起复制下来，粘贴给找素材的 AI，让它改好再导入。`,
      '复制给 AI',
      () =>
        copyText(
          `这份视频候选清单（${name}）没有通过分镜台的格式检查，整份没有导入。请按下面的规范逐条改好，输出完整的 JSON 文件：\n\n${errors.map(e => '- ' + e).join('\n')}\n\n---\n\n${CANDIDATE_SPEC}`,
          '已复制问题和格式规范，粘贴给 AI 即可',
        ),
      { cancelText: '关闭', danger: false },
    );
  }
  async function copyText(text, okMsg) {
    try {
      await (window.fjtHooks?.copyText || (t => navigator.clipboard.writeText(t)))(text);
      toast(okMsg, null, 'ok');
    } catch {
      toast('复制失败，请再试一次', null, 'error');
    }
  }
  const copyCandidateSpec = () =>
    copyText(
      `请按下面的规范把找到的视频素材写成候选清单（.json），不合规范的分镜台不会导入。\n\n${CANDIDATE_SPEC}`,
      `已复制${SPEC_NAME}，发给找素材的 AI 即可`,
    );

  /* 返工要求：打字即存，停手后写盘；第一次写字就把这个画面标成「有要求」。
   同一个输入框连续打字算一步撤销，换了输入框（重渲染 / 换画面）就是新的一步 */
  function setReworkNote(text, session) {
    const s = curReworkItem();
    if (s) updateReworkNote(s.lead, text, session);
  }
  function dismissCurrentRework() {
    const s = curReworkItem();
    if (!s) return;
    dismissShotRework(s.lead);
    toast(`${rangeText(s.lead)} 不用返工了 · ⌘Z 可撤销`, null, 'ok');
  }
  /* 待返工页 → 返工单：写到片段保存位置，再把交给 AI 的那句话复制好 */
  async function writeReworkDoc() {
    const pid = state.projectId;
    if (!reworkList().length) return toast('没有待返工的画面', null, 'info');
    const dir = await ensureMediaDir();
    if (!dir || state.projectId !== pid) return;
    renumber();
    const list = reworkList().map(s => ({ ...s, members: s.members.map(m => ({ ...m })) }));
    if (!list.length) return toast('没有待返工的画面', null, 'info');
    const title = state.title || '未命名项目';
    const tl = timeline();
    const doc = buildReworkDoc({
      title,
      shots: list,
      registry: state.assets || {},
      batchName: batchOfCand,
      secondsOf: members => memberSeconds(tl, members),
    });
    const file = `${dir.replace(/\/+$/, '')}/返工单·${safeFileName(title)}.json`;
    const r = await native.writeReworkDoc(file, JSON.stringify(doc, null, 2));
    if (!r?.ok) return toast('返工单没写进去：' + (r?.error || '未知原因'), null, 'error');
    if (state.projectId !== pid) return toast('返工单已写入，但项目已切换，请回到原项目重新生成', null, 'warn');
    registerReworkRequest(doc, list);
    page.reworkDocAt = Date.now();
    renderVideoReview();
    await copyText(
      `读一下「${file}」：这是分镜台的返工单，${list.length} 个画面（${doc.sentences}）。按每个画面的要求和否掉的理由重新找视频候选，用候选清单格式 v${CANDIDATE_VERSION} 写一份新的候选清单给我导入。顶层 reworkId 必须写 "${doc.id}"；shots[].lines 逐项照抄，分散句子分别写，禁止扩成首尾整段或添加返工单之外的画面；每段视频用 for 写明给哪几句，长度按返工单里每句的 seconds 找够。`,
      `返工单已生成（${list.length} 个画面），交给 AI 的话已复制`,
    );
  }
  return { importCandidates, copyCandidateSpec, setReworkNote, dismissCurrentRework, writeReworkDoc };
}
