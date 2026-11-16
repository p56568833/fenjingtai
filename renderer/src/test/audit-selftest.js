/* 审查报告的隔离回归：后台重画、输入法组合、播放器取消和拖动取消。 */
import { state } from '../app/state.js';
import { emit } from '../app/events.js';
import { update } from '../app/project-events.js';
import * as storage from '../app/storage.js';
import { clearUndo } from '../app/undo.js';
import { parseAny } from '../core/parse.js';
import { startEdit } from '../ui/edit.js';
import { renderAll, setView } from '../ui/render.js';
import { runCommand } from '../ui/base/commands.js';
import { importCandidateData } from '../app/candidate-actions.js';
import { addRefsToShot, setUsageLines, setShotTimes } from '../app/asset-actions.js';
import { playerHTML, playClip, stopClip, setVoiceOn } from '../features/clip-player.js';
import { voicePlayer } from '../features/voice.js';
import { closePlaythrough, playthroughState, playthroughKey, trackDragging } from '../features/playthrough.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const firstLine = () => state.rows.find(row => row.kind === 'line');
export async function runAuditTests(t) {
  const previous = state.projectId;
  const voiceMethods = { ...voicePlayer };
  const voicePref = localStorage.getItem('fjz:vrVoice');
  let card = null;
  try {
    storage.createProject('审查隔离回归', parseAny('第一句口播。\n第二句口播。'));
    setView('table');
    renderAll();
    let row = firstLine();
    const sent = document.querySelector(`.row[data-id="${row.id}"] .sent`);
    startEdit(sent);
    sent.textContent = '正在修改的新正文。';
    emit('view-refresh');
    t('后台更新不替换正在输入的句子编辑器', sent.isConnected && document.activeElement === sent);
    sent.blur();
    // 隐藏自测窗口不一定获得系统焦点，补发编辑器依赖的失焦事件。
    sent.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await pause(20);
    t(
      '编辑结束后数据和重画正文一致',
      row.text === '正在修改的新正文。' &&
        document.querySelector(`.row[data-id="${row.id}"] .sent`).textContent === row.text,
      JSON.stringify({
        stored: row.text,
        actual: firstLine().text,
        shown: document.querySelector(`.row[data-id="${row.id}"] .sent`).textContent,
        focused: document.activeElement?.className,
      }),
    );

    const note = document.querySelector(`.note[data-id="${row.id}"]`);
    note.focus();
    note.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    note.textContent = 'huamian';
    note.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    emit('view-refresh');
    t('输入法组合中不保存拼音，也不被后台重画打断', !row.note && note.isConnected && document.activeElement === note);
    note.textContent = '画面描述';
    note.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '画面描述' }));
    t('输入法确认后立即保存最终文字', row.note === '画面描述');
    note.blur();
    note.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await pause(20);
    t('重画后画面描述保留最终文字', document.querySelector(`.note[data-id="${row.id}"]`).textContent === '画面描述');

    importCandidateData(
      {
        type: 'fenjingtai-candidates',
        version: 4,
        project: '审查',
        batch: '回归',
        shots: [
          {
            lines: '1',
            label: '画面',
            cands: [
              {
                key: 'A',
                for: '1',
                title: '片段',
                url: 'https://example.invalid/a.mp4',
                in: 0,
                out: 3,
                best: { in: 0, out: 3 },
                license: '测试',
                why: '测试',
              },
            ],
          },
        ],
      },
      '',
    );
    runCommand('video:open');
    const opinion = document.querySelector('#vrList [data-vr-note]');
    opinion.focus();
    opinion.value = '正在输入的审核意见';
    opinion.dispatchEvent(new InputEvent('input', { bubbles: true }));
    emit('candidate-media');
    t('后台片段任务不清掉审核意见的焦点', opinion.isConnected && document.activeElement === opinion);
    opinion.blur();
    opinion.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await pause(20);
    t('审核重画后意见仍完整保留', document.querySelector('#vrList [data-vr-note]').value === '正在输入的审核意见');
    setView('table');

    // 用可控的媒体和音频替身验证事件顺序，不下载、不播放真实文件。
    state.voice = { path: '/isolated/voice.wav', duration: 8, name: '测试' };
    let voicePlaying = false,
      voiceCalls = 0,
      lastVoiceEnd = null;
    Object.assign(voicePlayer, {
      available: () => true,
      isPlaying: () => voicePlaying,
      currentTime: () => 0,
      playRange: async (_from, to) => {
        voicePlaying = true;
        voiceCalls++;
        lastVoiceEnd = to;
      },
      pause: () => {
        voicePlaying = false;
      },
      seek: () => {},
    });
    setVoiceOn(true);
    const candidate = { id: 'audit', rowId: row.id, in: 0, out: 3, url: 'data:video/mp4,' };
    card = document.createElement('div');
    card.innerHTML = playerHTML(candidate);
    document.body.append(card);
    const video = card.querySelector('video');
    let paused = true,
      plays = 0,
      nowTime = 0;
    Object.defineProperties(video, {
      paused: { configurable: true, get: () => paused },
      duration: { configurable: true, value: 10 },
      readyState: { configurable: true, value: 1 },
      currentTime: {
        configurable: true,
        get: () => nowTime,
        set: val => {
          nowTime = val;
        },
      },
    });
    video.load = () => {};
    video.play = async () => {
      paused = false;
      plays++;
    };
    video.pause = () => {
      paused = true;
    };
    playClip(card, candidate);
    video.onplaying();
    const box = card.querySelector('[data-vr-voice]');
    t('审核片段可以带口播播放', voicePlaying && voiceCalls > 0);
    t('单句候选不重复标句号', card.querySelectorAll('.vr-seg-no').length === 0);
    t(
      '进度条整条统一无灰色分界，且高度不被大封面样式污染',
      !card.querySelector('.vr-vo-span') && card.querySelector('.vr-rail').getBoundingClientRect().height <= 10,
    );
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    const calls = voiceCalls;
    video.ontimeupdate();
    t('取消口播后视频更新事件不会重新起播口播', !voicePlaying && voiceCalls === calls);
    const lateTime = video.ontimeupdate;
    stopClip();
    lateTime();
    t('停止播放器清除媒体地址和事件回调', paused && !video.getAttribute('src') && !video.ontimeupdate);
    Object.defineProperty(video, 'readyState', { configurable: true, value: 0 });
    playClip(card, candidate);
    const beforeMetadata = plays;
    stopClip();
    video.dispatchEvent(new Event('loadedmetadata'));
    t('停止后的迟到元数据事件不能让旧片段播放', plays === beforeMetadata && paused);
    card.remove();
    card = null;

    // 多句同画面且候选比口播长出余量：1、2 两句都在段落开头标出，不标后面第 3 句，播到尾巴余量停字幕和口播
    const auditPid = state.projectId;
    storage.createProject('多句片段回归', parseAny('第一句口播。\n第二句口播。\n第三句口播。'));
    const multiPid = state.projectId;
    const allRows = state.rows.filter(r => r.kind === 'line');
    allRows[0].groupId = 'audit-g1';
    allRows[1].groupId = 'audit-g1';
    allRows[0].time = { start: 0, end: 2 };
    allRows[1].time = { start: 2, end: 4 };
    allRows[2].time = { start: 4, end: 6 };
    state.voice = { path: '/isolated/voice.wav', duration: 6, name: '测试' };
    update('rows');
    setVoiceOn(true);
    voicePlaying = false;
    lastVoiceEnd = null;
    const multiCand = {
      id: 'audit-multi',
      rowId: allRows[0].id,
      forIds: [allRows[0].id, allRows[1].id],
      in: 0,
      out: 6,
      url: 'data:video/mp4,',
    };
    card = document.createElement('div');
    card.innerHTML = playerHTML(multiCand);
    document.body.append(card);
    const initialTime = card.querySelector('.vr-time').textContent;
    const mv = card.querySelector('video');
    let mPaused = true,
      mNow = 0;
    Object.defineProperties(mv, {
      paused: { configurable: true, get: () => mPaused },
      duration: { configurable: true, value: 10 },
      readyState: { configurable: true, value: 1 },
      currentTime: {
        configurable: true,
        get: () => mNow,
        set: val => {
          mNow = val;
        },
      },
    });
    mv.load = () => {};
    mv.play = async () => {
      mPaused = false;
    };
    mv.pause = () => {
      mPaused = true;
    };
    playClip(card, multiCand);
    mv.onplaying();
    const segTexts = [...card.querySelectorAll('.vr-seg-no')].map(el => el.textContent);
    t(
      '多句候选预览总时长按会上屏时长截齐',
      initialTime === '0:00 / 0:04' && card.querySelector('.vr-time').textContent === '0:00 / 0:04',
      JSON.stringify({ initialTime, activeTime: card.querySelector('.vr-time').textContent }),
    );
    t(
      '多句候选在每句开头标出本段句号，且不标后续第 3 句',
      segTexts.length === 2 &&
        segTexts[0] === '1' &&
        segTexts[1] === '2' &&
        card.querySelectorAll('.vr-tick').length === 1 &&
        card.querySelector('.vr-tick').style.left === '50%',
      JSON.stringify(segTexts),
    );
    t('多句候选口播结束点不超过当前画面结尾', lastVoiceEnd != null && lastVoiceEnd <= 4.01, String(lastVoiceEnd));
    mNow = 4.05;
    mv.ontimeupdate();
    t(
      '播到会上屏结尾即停止预览与口播，不放多余尾巴且保留原始余量字段',
      mPaused &&
        mNow === 0 &&
        !voicePlaying &&
        multiCand.out === 6 &&
        !card.querySelector('.vr-sub').textContent.includes('第三句'),
      JSON.stringify({
        mPaused,
        mNow,
        voicePlaying,
        out: multiCand.out,
        sub: card.querySelector('.vr-sub').textContent,
      }),
    );
    stopClip();
    card.remove();
    card = null;
    storage.switchProject(auditPid);
    storage.deleteProject(multiPid);
    setView('table');
    renderAll();
    Object.assign(voicePlayer, voiceMethods);

    state.voice = null;
    row = firstLine();
    row.type = 'real';
    addRefsToShot(row, ['/isolated/audit.png']);
    setUsageLines(row, 0, 0, 0);
    update('rows');
    runCommand('playthrough:shot', row.id);
    if (playthroughState().playing) playthroughKey(new KeyboardEvent('keydown', { key: ' ' }));
    const down = () => {
      // 拖动回调挂在两条轨的外框上（色块可以在正片和备选之间拖）
      const lane = document.querySelector('#pttLanes'),
        block = lane.querySelector('#pttLane .ptt-block');
      const rect = block.getBoundingClientRect();
      block.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
          pointerId: 123,
          clientX: rect.left + rect.width / 2,
        }),
      );
      return lane;
    };
    let lane = down();
    lane.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 123 }));
    t('拖动取消会释放拖动回调', !trackDragging());
    await pause(20);
    lane = down();
    lane.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 123, clientX: 5 }));
    closePlaythrough();
    lane.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 123, clientX: 5 }));
    t('关闭预览后迟到的松开事件不会提交拖动', !trackDragging() && !row.assetUsages[0].at);
    runCommand('playthrough:shot', row.id);
    setShotTimes(row, [{ assetId: row.assetUsages[0].assetId, start: 0, end: 1 }]);
    await pause(30);
    t('取消拖动后重新打开仍能刷新镜头排布', Math.abs(playthroughState().layout.items[0].end - 1) < 0.01);
  } finally {
    document.activeElement?.blur();
    stopClip();
    closePlaythrough();
    card?.remove();
    Object.assign(voicePlayer, voiceMethods);
    if (voicePref == null) localStorage.removeItem('fjz:vrVoice');
    else localStorage.setItem('fjz:vrVoice', voicePref);
    setView('table');
    storage.switchProject(previous);
    clearUndo();
    renderAll();
  }
}
