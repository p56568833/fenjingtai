/* 剪映字幕对齐与独立中文字幕轨的数据操作：应用对齐结果 / 导入中文字幕 / 双语一步对齐 / 清除。
   对齐算法在 core/subtitle-align.js，双语映射规则在 core/bilingual.js。 */
import { changeProject } from './project-change.js';
import { state } from './state.js';
import { timeline } from './project-queries.js';
import { alignScript } from '../core/subtitle-align.js';
import { buildTimeline } from '../core/timeline.js';
import { mapSubCuesToLines } from '../core/bilingual.js';

/* 用一份字幕给当前稿子算对齐结果（不改数据，给预览用） */
export function planAlignment(name, cues, raw = '') {
  const lines = state.rows.filter(r => r.kind === 'line');
  const { times, stats } = alignScript(
    lines.map(r => ({ id: r.id, text: r.text })),
    cues,
  );
  return { projectId: state.projectId, name: name || '字幕', cues, raw, times, stats };
}

export function applyAlignment(plan) {
  if (!plan || (plan.projectId && plan.projectId !== state.projectId)) return false;
  const { name, cues, raw, times, stats } = plan;
  return changeProject(state.timing ? '重新对齐字幕' : '对齐剪映字幕', change => {
    for (const r of state.rows) {
      if (r.kind !== 'line') continue;
      const t = times.get(r.id);
      if (t) r.time = t;
      else delete r.time;
    }
    state.timing = { name, at: Date.now(), duration: stats.duration, cues };
    if (raw) state.timing.raw = raw; // 导入时的 SRT 原文，导出剪映时原样写出

    change.notify(
      `已对齐字幕：${stats.ok} 句对上${stats.low + stats.est ? `，${stats.low + stats.est} 句待核对（时长列标黄）` : ''}`,
      null,
      'ok',
    );
  });
}

export function clearTiming() {
  if (!state.timing && !state.rows.some(r => r.time)) return;
  return changeProject('清除字幕时间', change => {
    for (const r of state.rows) delete r.time;
    state.timing = null;

    change.notify('已清除字幕时间 · ⌘Z 可撤销', null, 'ok');
  });
}

/* 用一份中文字幕按当前时间轴试映射到各句（不改数据，给预览用） */
export function planSubTiming(name, cues, raw = '') {
  const lines = state.rows.filter(r => r.kind === 'line');
  const { mapped, matched, total, cues: cueCount, duration } = mapSubCuesToLines(lines, timeline(), cues);
  return {
    projectId: state.projectId,
    name: name || '中文字幕',
    cues,
    raw,
    mapped,
    stats: { matched, total, cues: cueCount, duration },
  };
}

/* 导入独立中文字幕轨并回填各句译文（绝不覆盖 row.time），自动激活英配中字模式 */
export function applySubTiming(plan, { overwrite = true } = {}) {
  if (!plan || (plan.projectId && plan.projectId !== state.projectId)) return false;
  const { name, cues = [], raw = '', mapped, stats } = plan;
  return changeProject(state.subTiming ? '重新导入中文字幕' : '导入中文字幕', change => {
    let filled = 0;
    const total = state.rows.filter(r => r.kind === 'line').length;
    for (const r of state.rows) {
      if (r.kind !== 'line') continue;
      const val = mapped?.get?.(r.id);
      if (val) {
        if (overwrite || !(typeof r.sub === 'string' && r.sub.trim())) {
          r.sub = val;
          filled++;
        }
      } else if (overwrite) {
        delete r.sub;
      }
    }
    const duration = stats?.duration ?? cues.reduce((mx, c) => Math.max(mx, Number.isFinite(c?.end) ? c.end : 0), 0);
    state.subTiming = { name: name || '中文字幕', at: Date.now(), duration, cues };
    if (raw) state.subTiming.raw = raw;
    state.langMode = 'en-zh';

    change.notify(`已导入中文字幕：匹配 ${filled} / ${total} 句（共 ${cues.length} 条）`, null, 'ok');
    return true;
  });
}

/* 一步事务同时应用英文对齐（r.time + state.timing）与中文字幕轨（state.subTiming + r.sub + langMode） */
export function applyBilingualAlignment(enPlan, subPlan) {
  if (!enPlan || (enPlan.projectId && enPlan.projectId !== state.projectId)) return false;
  if (subPlan?.projectId && subPlan.projectId !== state.projectId) return false;
  return changeProject('对齐双语字幕', change => {
    const now = Date.now();
    // 1. 先应用英文原文字幕对齐（唯一时钟源）
    for (const r of state.rows) {
      if (r.kind !== 'line') continue;
      const t = enPlan.times?.get?.(r.id);
      if (t) r.time = t;
      else delete r.time;
    }
    const enCues = Array.isArray(enPlan.cues) ? enPlan.cues : [];
    const enDur =
      enPlan.stats?.duration ?? enCues.reduce((mx, c) => Math.max(mx, Number.isFinite(c?.end) ? c.end : 0), 0);
    state.timing = { name: enPlan.name || '英文字幕', at: now, duration: enDur, cues: enCues };
    if (enPlan.raw) state.timing.raw = enPlan.raw;

    // 2. 基于刚刚写入的英文时间轴把中文字幕精准映射到各句
    const lines = state.rows.filter(r => r.kind === 'line');
    const subCues = Array.isArray(subPlan?.cues) ? subPlan.cues : [];
    const freshTl = buildTimeline(lines, {
      voiceDuration: state.voice?.duration || null,
      speechRate: state.speechRate,
    });
    const remapped = subCues.length ? mapSubCuesToLines(lines, freshTl, subCues) : null;
    const subMap = remapped ? remapped.mapped : subPlan?.mapped || new Map();

    let subFilled = 0;
    for (const r of lines) {
      const val = subMap.get(r.id);
      if (val) {
        r.sub = val;
        subFilled++;
      } else {
        delete r.sub;
      }
    }
    if (subCues.length) {
      const subDur =
        remapped?.duration ??
        subPlan?.stats?.duration ??
        subCues.reduce((mx, c) => Math.max(mx, Number.isFinite(c?.end) ? c.end : 0), 0);
      state.subTiming = { name: subPlan?.name || enPlan.name || '中文字幕', at: now, duration: subDur, cues: subCues };
      if (subPlan?.raw) state.subTiming.raw = subPlan.raw;
    } else {
      state.subTiming = null;
    }
    state.langMode = 'en-zh';

    const ok = enPlan.stats?.ok ?? 0;
    const warn = (enPlan.stats?.low ?? 0) + (enPlan.stats?.est ?? 0);
    change.notify(
      `已对齐双语字幕：英文 ${ok} 句对上${warn ? `（${warn} 句待核对）` : ''}，中文匹配 ${subFilled} 句`,
      null,
      'ok',
    );
    return true;
  });
}

/* 清除独立中文字幕轨（按需同时清除逐句译文） */
export function clearSubTiming({ clearLineSubs = false } = {}) {
  const hasLineSubs = state.rows.some(r => r.kind === 'line' && typeof r.sub === 'string' && r.sub.trim());
  if (!state.subTiming && (!clearLineSubs || !hasLineSubs)) return false;
  return changeProject('清除中文字幕', change => {
    state.subTiming = null;
    if (clearLineSubs) for (const r of state.rows) delete r.sub;

    change.notify(
      clearLineSubs ? '已清除中文字幕轨与逐句译文 · ⌘Z 可撤销' : '已清除中文字幕轨 · ⌘Z 可撤销',
      null,
      'ok',
    );
    return true;
  });
}
