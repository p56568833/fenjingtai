/* 审查报告的隔离回归：后台重画、输入法组合、播放器取消和拖动取消。 */
import { state, emit, update } from '../app/state.js';
import * as storage from '../app/storage.js';
import { clearUndo } from '../app/undo.js';
import { parseAny } from '../core/parse.js';
import { startEdit } from '../ui/edit.js';
import { renderAll, setView } from '../ui/render.js';
import { runCommand } from '../ui/base/commands.js';
import { importCandidateData } from '../app/candidate-actions.js';
import { addRefsToShot, setUsageRole, setShotTimes } from '../app/asset-actions.js';
import { playerHTML, playClip, stopClip, setVoiceOn } from '../features/clip-player.js';
import { voicePlayer } from '../features/voice.js';
import { closePlaythrough, playthroughState, playthroughKey } from '../features/playthrough.js';

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
    emit('rows');
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
    emit('rows');
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
        version: 2,
        project: '审查',
        batch: '回归',
        shots: [
          {
            lines: '1',
            label: '画面',
            cands: [
              {
                key: 'A',
                title: '片段',
                url: 'https://example.invalid/a.mp4',
                in: 0,
                out: 3,
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
      voiceCalls = 0;
    Object.assign(voicePlayer, {
      available: () => true,
      isPlaying: () => voicePlaying,
      currentTime: () => 0,
      playRange: async () => {
        voicePlaying = true;
        voiceCalls++;
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
      plays = 0;
    Object.defineProperties(video, {
      paused: { configurable: true, get: () => paused },
      duration: { configurable: true, value: 10 },
      readyState: { configurable: true, value: 1 },
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
    Object.assign(voicePlayer, voiceMethods);

    state.voice = null;
    row = firstLine();
    row.type = 'real';
    addRefsToShot(row, ['/isolated/audit.png']);
    setUsageRole(row, 0, 'main');
    update('rows');
    runCommand('playthrough:shot', row.id);
    if (playthroughState().playing) playthroughKey(new KeyboardEvent('keydown', { key: ' ' }));
    const down = () => {
      const lane = document.querySelector('#pttLane'),
        block = lane.querySelector('.ptt-block');
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
    lane.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 123 }));
    t('拖动取消会释放拖动回调', !lane.onpointermove && !lane.onpointerup);
    await pause(20);
    lane = down();
    const lateUp = lane.onpointerup;
    closePlaythrough();
    lateUp();
    t('关闭预览后迟到的松开事件不会提交拖动', !lane.onpointermove && !row.assetUsages[0].at);
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
