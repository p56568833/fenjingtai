/* 通用导出计划（纯函数，无 DOM / 无应用状态 / 不读文件系统）：
   把项目快照按现有排布规则（timeline / playback-plan / shot-layout / shots）转成剪辑器无关的
   素材表、轨道片段、定格派生需求与结构化问题。剪映的私有结构不在这里，见 electron/jianying/。

   约定：
   · 时间统一整数微秒；绝对时间边界先按帧量化（同一时间只算一次），相邻片段共用边界，
     长度 = endUs - startUs，不逐段累计误差。源入出点是源文件时间，只取整到微秒。
   · 每个镜头的画面按「有效播放区间」展开，和连播预览一致：自然句间停顿里前一画面延续，
     视频从源入点继续播，播到出点后保持末帧；fitDone（定格补满）同样用末帧补足；
     镜头末尾 0.05 秒的舍入误差当作延续。手动画布、镜头之间、开头和录音尾部不擅自延续。
   · 输入只读：不修改 project；ID 由 deps.idFor 注入，未注入时用本次调用内的确定性自增。 */
import { buildTimeline } from './timeline.js';
import { buildPlaybackUnits, heldThrough } from './playback-plan.js';
import { usableLength } from './shot-layout.js';
import { shots, isRole } from './shots.js';
import { usageList, kindOf, assetName, LINK_RE } from './asset-model.js';
import { safeFileName } from './text.js';

export const SCHEMA_VERSION = 1;
export const PLAN_DEFAULTS = Object.freeze({
  width: 1920,
  height: 1080,
  fps: 30,
  subtitles: false,
  altAssets: false,
  includeVoice: true,
});

const EPS = 1e-6;
const TOL = 0.05; // 和预览一致：镜头末尾 / 手动画布舍入容差
const MAX_FRAME = 240;

const finite = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const gcd = (a, b) => {
  let x = Math.abs(a),
    y = Math.abs(b);
  while (y) [x, y] = [y, x % y];
  return x || 1;
};

/* 帧率用有理数表达；小数帧率只认已验证过的 23.976 / 29.97 / 59.94 */
const KNOWN_RATES = [
  [24000, 1001],
  [30000, 1001],
  [60000, 1001],
  [24, 1],
  [25, 1],
  [30, 1],
  [48, 1],
  [50, 1],
  [60, 1],
  [120, 1],
  [240, 1],
];
function normalizeFps(value) {
  const fps = finite(value);
  if (fps == null || fps <= 0) return { num: 30, den: 1 };
  for (const [num, den] of KNOWN_RATES) if (Math.abs(fps - num / den) < 0.001) return { num, den };
  if (Number.isInteger(fps) && fps <= MAX_FRAME) return { num: fps, den: 1 };
  const den = 1000,
    num = Math.round(fps * den),
    g = gcd(num, den);
  return { num: num / g, den: den / g };
}

function normalizeOptions(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const width = Math.round(finite(source.width) ?? PLAN_DEFAULTS.width);
  const height = Math.round(finite(source.height) ?? PLAN_DEFAULTS.height);
  return {
    width: width > 0 && width <= 10000 ? width : PLAN_DEFAULTS.width,
    height: height > 0 && height <= 10000 ? height : PLAN_DEFAULTS.height,
    rate: normalizeFps(source.fps),
    subtitles: source.subtitles === true,
    altAssets: source.altAssets === true,
    includeVoice: source.includeVoice !== false,
  };
}

/* 帧量化时钟：us(sec) 先四舍五入到帧，再换算成整数微秒；plainUs 用于源文件时间 */
function createClock(rate) {
  const fps = rate.num / rate.den;
  return {
    fps,
    frameUs: (rate.den * 1e6) / rate.num,
    us(sec) {
      const value = finite(sec);
      if (value == null) return null;
      return Math.round((Math.round(value * fps) * rate.den * 1e6) / rate.num);
    },
    plainUs(sec) {
      const value = finite(sec);
      return value == null ? null : Math.round(value * 1e6);
    },
  };
}

function makeIds(injected) {
  let seq = 0;
  if (typeof injected === 'function')
    return prefix => {
      const id = injected(prefix);
      return typeof id === 'string' && id ? id : `${prefix}-${++seq}`;
    };
  return prefix => `${prefix}-${++seq}`;
}

const positive = value => {
  const number = finite(value);
  return number != null && number > 0 ? number : null;
};

const probeFor = (probes, path) => {
  if (!path || !probes) return null;
  if (probes instanceof Map) return probes.get(path) || null;
  return probes[path] || null;
};

const cleanUrlName = ref => {
  try {
    const url = new URL(ref);
    return decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || url.hostname);
  } catch {
    return String(ref).split(/[\\/]/).pop() || String(ref);
  }
};

const mediaName = (asset, path) => asset?.name || assetName(path) || cleanUrlName(path) || '素材';
const kindOrNull = (asset, path) => asset?.kind || kindOf(path) || null;

/* 片段范围：只认有限数字、入点 ≥ 0、出点大于入点 */
function clipInfo(item) {
  const raw = item?.usage?.clip;
  if (!raw || typeof raw !== 'object') return null;
  const cin = finite(raw.in);
  const cout = finite(raw.out);
  const valid = cin != null && cout != null && cin >= 0 && cout > cin;
  return { in: cin, out: cout, valid, raw };
}

const issueExtra = extra => {
  const out = {};
  if (extra)
    for (const key of ['rowId', 'lineNo', 'assetId']) {
      const value = extra[key];
      if (value != null) out[key] = value;
    }
  return out;
};

function pickLineNo(row, index) {
  const no = finite(row?.no);
  return no != null ? no : index + 1;
}

/* ── 时间来源：把 timeline 的三档来源整理成可显示的说明 ── */
function buildTiming(tl, lines) {
  const counts = { ok: 0, low: 0, est: 0, gap: 0 };
  for (const row of lines) {
    const time = tl.times.get(row.id);
    if (!time) continue;
    if (time.src === 'srt') {
      if (time.st === 'low') counts.low++;
      else if (time.st === 'est') counts.est++;
      else counts.ok++;
    } else if (time.src === 'gap') counts.gap++;
  }
  const estimated = counts.low + counts.est + counts.gap;
  const mixed = tl.source === 'srt' && estimated > 0;
  let note;
  if (tl.source === 'srt') {
    if (!mixed) note = `字幕实测 ${counts.ok} 句`;
    else {
      const parts = [];
      if (counts.low) parts.push(`低置信 ${counts.low} 句`);
      if (counts.est) parts.push(`字幕里没找到 ${counts.est} 句、按前后推算`);
      if (counts.gap) parts.push(`对齐后新增 ${counts.gap} 句、按前后推算`);
      note = `字幕实测 ${counts.ok} 句；${parts.join('；')}`;
    }
  } else if (tl.source === 'fit') note = `按口播音频总长推算 ${lines.length} 句`;
  else note = `按语速 ${String(Math.round(tl.rate * 10) / 10)} 字/秒估算 ${lines.length} 句`;
  return { source: tl.source, mixed, counts, note };
}

/* ── 字幕 SRT ── */
function srtTime(us) {
  const ms = Math.max(0, Math.round(us / 1000));
  const h = Math.floor(ms / 3600000),
    m = Math.floor(ms / 60000) % 60,
    s = Math.floor(ms / 1000) % 60,
    rest = ms % 1000;
  const p = (n, len = 2) => String(n).padStart(len, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(rest, 3)}`;
}
function srtText(text) {
  // SRT 一句一行：换行折成空格，箭头转义，避免破坏 cue 结构
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/-->/g, '→')
    .trim();
}
function buildSrt(entries) {
  if (!entries.length) return '';
  return (
    entries
      .map(
        (entry, index) => `${index + 1}\n${srtTime(entry.startUs)} --> ${srtTime(entry.endUs)}\n${srtText(entry.text)}`,
      )
      .join('\n\n') + '\n'
  );
}

const unionLength = intervals => {
  const list = intervals.filter(item => item.end > item.start).sort((a, b) => a.start - b.start || a.end - b.end);
  let covered = 0,
    from = null,
    to = null;
  for (const item of list) {
    if (from == null) {
      from = item.start;
      to = item.end;
    } else if (item.start <= to) to = Math.max(to, item.end);
    else {
      covered += to - from;
      from = item.start;
      to = item.end;
    }
  }
  if (from != null) covered += to - from;
  return covered;
};

/* 导出计划入口：project 是深拷贝后的只读快照，options 是画布/帧率/字幕等设置，
   deps = { idFor(prefix), probes[path] = { durationSec, width, height, ...exists } } */
export function buildEditExportPlan(project = {}, options = {}, deps = {}) {
  const snapshot = project && typeof project === 'object' ? project : {};
  const opt = normalizeOptions(options);
  const clock = createClock(opt.rate);
  const id = makeIds(deps?.idFor);
  const probes = deps?.probes && typeof deps.probes === 'object' ? deps.probes : {};
  const registry = snapshot.assets && typeof snapshot.assets === 'object' ? snapshot.assets : {};
  const rows = Array.isArray(snapshot.rows) ? snapshot.rows : [];
  const lines = rows.filter(row => row && row.kind === 'line');
  const speechRate = finite(snapshot.speechRate);
  const rawVoice = snapshot.voice && typeof snapshot.voice === 'object' ? snapshot.voice : null;
  const voicePath = typeof rawVoice?.path === 'string' ? rawVoice.path.trim() : '';
  const voice = rawVoice
    ? {
        path: voicePath,
        name: mediaName(null, voicePath) || '口播音频',
        duration: finite(rawVoice.duration),
      }
    : null;
  const title = typeof snapshot.title === 'string' && snapshot.title.trim() ? snapshot.title.trim() : '未命名项目';

  const tl = buildTimeline(lines, {
    voiceDuration: voice?.duration ?? null,
    speechRate: speechRate != null && speechRate > 0 ? speechRate : undefined,
  });
  const units = buildPlaybackUnits({ rows, assets: registry }, tl);

  const issues = [];
  const seenIssues = new Set();
  const addIssue = (level, code, message, extra) => {
    issues.push({ level, code, message, ...issueExtra(extra) });
  };
  const addIssueOnce = (key, level, code, message, extra) => {
    if (seenIssues.has(key)) return;
    seenIssues.add(key);
    addIssue(level, code, message, extra);
  };
  const locate = (unit, item) => ({
    rowId: unit?.members?.[0]?.id ?? null,
    lineNo: unit?.members?.[0] ? pickLineNo(unit.members[0], 0) : null,
    assetId: item?.assetId,
  });

  /* ── 时长：口播总长和录音实际长度取大者，录音尾部保留 ── */
  let lineEnd = 0;
  for (const time of tl.times.values()) if (Number.isFinite(time.end)) lineEnd = Math.max(lineEnd, time.end);
  for (const unit of units) if (Number.isFinite(unit.end)) lineEnd = Math.max(lineEnd, unit.end);
  const durationSec = Math.max(finite(tl.total) ?? 0, lineEnd, voice?.duration ?? 0, 0);
  const durationUs = Math.max(0, clock.us(durationSec) ?? 0);
  const boundUs = value => clamp(Number.isFinite(value) ? value : 0, 0, durationUs);

  /* ── 问题预检：不只看排出来的画面，也要把「排不出来但用户以为用了」的素材说清楚 ── */
  const badVisuals = new Set(); // 镜头第一句 id + 素材 id：已报过，不再上画面
  const scanVisual = (members, usages, unitIndex) => {
    const lead = members[0];
    const mark = (usage, level, code, message) => {
      badVisuals.add(`${lead.id}|${usage.assetId}`);
      addIssueOnce(`${lead.id}|${usage.assetId}|${code}`, level, code, message, {
        rowId: lead.id,
        lineNo: pickLineNo(lead, unitIndex),
        assetId: usage.assetId,
      });
    };
    const onSomewhere = assetId => members.some(member => usageList(member).some(u => u.assetId === assetId && !u.off));
    for (const usage of usages) {
      if (!onSomewhere(usage.assetId)) continue;
      const asset = registry[usage.assetId];
      if (!asset) {
        mark(usage, 'block', 'unknown-asset', '某个画面引用的素材记录不存在（可能已从素材库删除）');
        continue;
      }
      const path = typeof asset.path === 'string' ? asset.path : '';
      const name = mediaName(asset, path);
      if (!path) {
        mark(usage, 'block', 'missing-path', `素材「${name}」没有本地路径，无法导出`);
        continue;
      }
      if (LINK_RE.test(path)) {
        mark(usage, 'block', 'linked-asset', `「${name}」还是网络链接，需要先保存到本机再导出`);
        continue;
      }
      const kind = kindOrNull(asset, path);
      if (kind !== 'video' && kind !== 'image') {
        mark(usage, 'block', 'unsupported-media', `「${name}」不是视频或图片，不能放到画面轨`);
        continue;
      }
      if (probeFor(probes, path)?.exists === false) {
        mark(usage, 'block', 'missing-file', `「${name}」文件失联或无法读取`);
      }
    }
  };

  const overlayAssets = new Map();
  const altAssets = new Map();
  for (const members of shots(rows)) {
    const first = members[0];
    const list = usageList(first);
    const onSomewhere = assetId => members.some(member => usageList(member).some(u => u.assetId === assetId && !u.off));
    const mains = list.filter(u => u.role === 'main' && onSomewhere(u.assetId));
    const chosen = mains.length ? mains : list.filter(u => !isRole(u.role) && onSomewhere(u.assetId)).slice(0, 1);
    scanVisual(
      members,
      chosen,
      units.findIndex(unit => unit.members[0] === first),
    );
    for (const member of members)
      for (const usage of usageList(member)) {
        if (usage.off) continue;
        if (usage.role === 'overlay' && !overlayAssets.has(usage.assetId))
          overlayAssets.set(usage.assetId, { usage, row: member });
        else if (usage.role === 'alt' && !altAssets.has(usage.assetId))
          altAssets.set(usage.assetId, { usage, row: member });
      }
  }

  /* ── 句子时间诊断：非有限 / 负数 / 相邻句子重叠 ── */
  lines.forEach((row, index) => {
    const time = row.time;
    if (!time || typeof time !== 'object') return;
    const start = finite(time.start),
      end = finite(time.end);
    if (start == null || end == null)
      addIssue('block', 'invalid-time', `第 ${pickLineNo(row, index)} 句的字幕时间不是有效数字，已按前后句推算`, {
        rowId: row.id,
        lineNo: pickLineNo(row, index),
      });
    else if (start < 0 || end <= start)
      addIssue('block', 'invalid-time', `第 ${pickLineNo(row, index)} 句的字幕时间无效，导出时已按可用范围处理`, {
        rowId: row.id,
        lineNo: pickLineNo(row, index),
      });
  });
  let previousTime = null;
  lines.forEach((row, index) => {
    const time = tl.times.get(row.id);
    if (!time) return;
    if (previousTime && time.start < previousTime.time.end - TOL)
      addIssue(
        'block',
        'line-overlap',
        `第 ${previousTime.no} 句和第 ${pickLineNo(row, index)} 句的句子时间重叠，重叠部分按后出现的句子截断`,
        { rowId: row.id, lineNo: pickLineNo(row, index) },
      );
    previousTime = { time, no: pickLineNo(row, index) };
  });

  /* ── 镜头时间重叠：预览里后开始的镜头优先，导出按同样可见范围截断（问题已在上面定位） ── */
  const visibleEnds = new Map();
  const orderedUnits = units
    .map((unit, index) => ({ unit, index }))
    .sort((a, b) => a.unit.start - b.unit.start || a.index - b.index);
  orderedUnits.forEach((entry, index) => {
    const next = orderedUnits[index + 1];
    let end = entry.unit.end;
    if (next && next.unit.start < end - EPS) end = Math.max(entry.unit.start, next.unit.start);
    visibleEnds.set(entry.unit, end);
  });

  /* ── 素材表 / 定格派生表 / 轨道 ── */
  const assets = [];
  const assetByKey = new Map();
  const derived = [];
  const derivedByKey = new Map();
  const videoTrack = [];
  const audioTrack = [];
  const textTrack = [];
  const subtitles = [];

  const pushAsset = (key, kind, path, name, extra = {}) => {
    if (assetByKey.has(key)) return assetByKey.get(key).planId;
    const probe = probeFor(probes, path);
    const fileDur = positive(probe?.durationSec) ?? finite(extra.durationSec);
    const entry = {
      planId: id('asset'),
      kind,
      path,
      name,
      width: finite(probe?.width),
      height: finite(probe?.height),
      durationUs: fileDur != null && fileDur > 0 ? Math.round(fileDur * 1e6) : null,
      ...(extra.sourceAssetId ? { sourceAssetId: extra.sourceAssetId } : {}),
    };
    assets.push(entry);
    assetByKey.set(key, entry);
    return entry.planId;
  };

  const sourceAssetFor = path => Object.values(registry).find(asset => asset?.path === path);

  const makeFreeze = (asset, atUs, sourceAssetId) => {
    const key = `${asset?.path || ''}|${atUs}|${opt.width}x${opt.height}`;
    if (derivedByKey.has(key)) return derivedByKey.get(key).planId;
    const base = safeFileName(String(mediaName(asset, asset?.path || '')).replace(/\.[^.]+$/, ''), 'freeze');
    const entry = {
      planId: id('freeze'),
      type: 'freeze',
      sourceAssetId: sourceAssetId || null,
      sourcePath: asset?.path || '',
      atUs,
      width: opt.width,
      height: opt.height,
      outputName: `${base}-freeze-${derived.length + 1}.png`,
    };
    derived.push(entry);
    derivedByKey.set(key, entry);
    return entry.planId;
  };

  const emitVideoSegment = (unit, item, asset, sourceStartSec, startRel, playSec) => {
    const startUs = boundUs(clock.us(unit.start + startRel));
    const endUs = boundUs(clock.us(unit.start + startRel + playSec));
    if (endUs <= startUs) return null;
    const sourceStartUs = Math.max(0, clock.plainUs(sourceStartSec) ?? 0);
    const sourceDurationUs = Math.round(playSec * 1e6);
    if (sourceDurationUs <= 0) return null;
    const entry = {
      id: id('clip'),
      kind: 'video',
      assetId: pushAsset(`video|${asset.id}`, 'video', asset.path, mediaName(asset, asset.path), {
        durationSec: asset.durationSec,
        sourceAssetId: asset.id,
      }),
      targetStartUs: startUs,
      targetDurationUs: endUs - startUs,
      sourceStartUs,
      sourceDurationUs,
      speed: 1,
      volume: 0,
    };
    videoTrack.push(entry);
    return entry;
  };

  const emitImageSegment = (unit, item, startRel, endRel) => {
    const startUs = boundUs(clock.us(unit.start + startRel));
    const endUs = boundUs(clock.us(unit.start + endRel));
    if (endUs <= startUs) return null;
    const entry = {
      id: id('clip'),
      kind: 'image',
      assetId: pushAsset(`image|${item.assetId}`, 'image', item.asset.path, mediaName(item.asset, item.asset.path), {
        sourceAssetId: item.assetId,
      }),
      targetStartUs: startUs,
      targetDurationUs: endUs - startUs,
      sourceStartUs: 0,
      sourceDurationUs: endUs - startUs,
      speed: 1,
      volume: 0,
    };
    videoTrack.push(entry);
    return entry;
  };

  const reportLostSegment = (unit, item) => {
    addIssueOnce(
      `${unit.members[0].id}|${item.assetId}|sub-frame`,
      'confirm',
      'zero-length',
      `第 ${pickLineNo(unit.members[0], 0)} 句里的画面不足一帧，导出时省略`,
      { ...locate(unit, item), assetId: item.assetId },
    );
  };

  /* 每个镜头：按 layout.items 展开有效播放区间 */
  for (const unit of units) {
    const limitEnd = visibleEnds.get(unit) ?? unit.end;
    const limitRel = limitEnd - unit.start;
    if (!(limitRel > EPS)) continue;
    const layout = unit.layout;
    if (!layout) continue;
    const items = layout.items || [];
    const dur = layout.dur;
    let visibleEndRel = 0;

    items.forEach((item, index) => {
      if (!(item.end > item.start + EPS)) return;
      if (item.start >= dur - EPS) {
        addIssue(
          'confirm',
          'over-shot',
          `「${mediaName(item.asset, item.asset?.path || '')}」排在整个镜头之后，导出的草稿里不会出现`,
          { ...locate(unit, item), assetId: item.assetId },
        );
        return;
      }
      const badKey = `${unit.members[0].id}|${item.assetId}`;
      if (badVisuals.has(badKey)) return; // 失联 / 链接 / 不支持：上面已经给过问题，这里留白
      const probe = probeFor(probes, item.asset?.path || '');
      let startRel = Math.max(0, item.start);
      let endRel = Math.min(item.end, dur, limitRel);
      if (startRel < visibleEndRel - TOL) {
        addIssue(
          'block',
          'picture-overlap',
          `第 ${pickLineNo(unit.members[0], 0)} 句画面里的主画面时间重叠，导出按预览可见范围截断；建议先调整时间`,
          locate(unit, item),
        );
      }
      startRel = Math.max(startRel, visibleEndRel);
      if (endRel <= startRel + EPS) {
        if (item.over) {
          // 已在下面统一报 over-shot
        } else if (item.end <= limitRel + TOL) {
          addIssue(
            'confirm',
            'zero-length',
            `第 ${pickLineNo(unit.members[0], 0)} 句里有画面没有可导出的时间，已省略`,
            {
              ...locate(unit, item),
              assetId: item.assetId,
            },
          );
        }
        return;
      }

      /* 有效播放区间：自然停顿里延续前一画面；末尾 0.05 秒容差 */
      let extEndRel = endRel;
      if (!layout.timed && index < items.length - 1) {
        const next = items[index + 1];
        if (next && next.start > item.end + EPS && heldThrough(unit, item, next, tl))
          extEndRel = Math.max(extEndRel, Math.min(next.start, dur, limitRel));
      }
      if (index === items.length - 1 && item.end >= dur - TOL)
        extEndRel = Math.min(Math.max(extEndRel, dur), limitRel, dur);
      if (item.over)
        addIssue(
          'confirm',
          'over-shot',
          `「${mediaName(item.asset, item.asset?.path || '')}」超出镜头可见范围，只导出能看见的部分`,
          {
            ...locate(unit, item),
            assetId: item.assetId,
          },
        );

      if (item.kind === 'image') {
        if (probe && finite(probe.durationSec) > TOL)
          addIssueOnce(
            `${item.assetId}|animated`,
            'confirm',
            'animated-image',
            `「${mediaName(item.asset, item.asset?.path || '')}」是动态图片，导出后会按静态图片显示`,
            { ...locate(unit, item), assetId: item.assetId },
          );
        if (!emitImageSegment(unit, item, startRel, extEndRel)) reportLostSegment(unit, item);
        visibleEndRel = Math.max(visibleEndRel, extEndRel);
        return;
      }

      /* 视频：从源入点播到出点；需要延续的部分用末帧 PNG 补（fitDone / 自然停顿 / 末尾容差） */
      const clip = clipInfo(item);
      const asset = item.asset;
      const path = asset?.path || '';
      const name = mediaName(asset, path);
      const fileDur = positive(probe?.durationSec) ?? finite(asset?.durationSec);
      let sourceStartSec = 0;
      if (clip) {
        if (clip.valid) sourceStartSec = clip.in;
        else if (clip.in != null && clip.in >= 0)
          addIssue('block', 'source-range', `「${name}」的片段出点必须大于入点，导出按整段处理`, locate(unit, item));
        else addIssue('block', 'source-range', `「${name}」的片段入点/出点无效，导出按整段处理`, locate(unit, item));
      }
      let usableSec = usableLength(item); // 现有规则：片段长度 / 文件时长 / #t= 片段
      if (clip?.valid && clip.in < 0) {
        addIssue('block', 'source-range', `「${name}」的片段入点不能小于 0，导出从 0 开始`, locate(unit, item));
        sourceStartSec = 0;
        usableSec = clip.out;
      }
      if (fileDur != null) {
        if (clip?.valid && clip.out > fileDur + TOL) {
          addIssue(
            'block',
            'source-range',
            `「${name}」的片段超出文件时长，导出只取文件里有的部分`,
            locate(unit, item),
          );
          usableSec = Math.max(0, fileDur - sourceStartSec);
        } else if (clip?.valid) {
          if (sourceStartSec >= fileDur - EPS) {
            addIssue('block', 'source-range', `「${name}」的片段入点超出文件时长，没有可用的画面`, locate(unit, item));
            usableSec = 0;
          } else usableSec = Math.min(usableSec ?? fileDur, Math.max(0, fileDur - sourceStartSec));
        } else usableSec = Math.min(usableSec ?? fileDur, fileDur);
      } else if (usableSec == null) {
        addIssueOnce(
          `${asset?.id || path}|unknown-duration`,
          'confirm',
          'unknown-duration',
          `无法确认「${name}」的视频时长，已按排布时间导出，请检查切点`,
          { ...locate(unit, item), assetId: item.assetId },
        );
      }

      const need = extEndRel - startRel;
      const playSec = usableSec == null ? need : clamp(usableSec, 0, need);
      const videoEnd = emitVideoSegment(unit, item, asset, sourceStartSec, startRel, playSec);
      const splitRel = startRel + playSec;
      const startUs = boundUs(clock.us(unit.start + startRel));
      const endUs = boundUs(clock.us(unit.start + extEndRel));
      const splitUs = boundUs(clock.us(unit.start + splitRel));
      if (endUs <= startUs) {
        reportLostSegment(unit, item);
      } else if (endUs > splitUs) {
        if (videoEnd && endUs - splitUs < clock.frameUs) {
          // 不足一帧的结尾并进视频段，不额外生成定格图
          videoEnd.targetDurationUs = endUs - videoEnd.targetStartUs;
        } else if (!videoEnd && endUs - splitUs < clock.frameUs) {
          reportLostSegment(unit, item);
        } else if (splitUs >= startUs) {
          const sourceOutSec = sourceStartSec + playSec;
          const atSec = Math.max(sourceStartSec, sourceOutSec - 1 / clock.fps);
          const atUs = Math.max(0, clock.plainUs(atSec) ?? 0);
          const sourcePlanId =
            videoEnd?.assetId ||
            pushAsset(`video|${asset.id}`, 'video', asset.path, name, {
              durationSec: asset.durationSec,
              sourceAssetId: asset.id,
            });
          const freezeId = makeFreeze(asset, atUs, sourcePlanId);
          videoTrack.push({
            id: id('clip'),
            kind: 'image',
            assetId: freezeId,
            targetStartUs: splitUs,
            targetDurationUs: endUs - splitUs,
            sourceStartUs: 0,
            sourceDurationUs: endUs - splitUs,
            speed: 1,
            volume: 0,
            derived: true,
          });
        }
      }
      visibleEndRel = Math.max(visibleEndRel, extEndRel);
    });

    /* 手动画布留白：素材之间 / 末尾空着的地方保持空白（不自动延续） */
    if (layout.timed && items.length) {
      const spans = items
        .map(item => ({ start: item.start, end: Math.min(item.end, dur, limitRel) }))
        .sort((a, b) => a.start - b.start);
      let cursor = 0,
        gap = 0;
      for (const span of spans) {
        if (span.start > cursor + TOL) gap += span.start - cursor;
        cursor = Math.max(cursor, span.end);
      }
      if (limitRel > cursor + TOL) gap += limitRel - cursor;
      if (gap > TOL)
        addIssueOnce(
          `${unit.members[0].id}|manual-gap`,
          'info',
          'manual-gap',
          `手动画布留白 ${gap.toFixed(1)} 秒，导出后保持空白`,
          { rowId: unit.members[0].id, lineNo: pickLineNo(unit.members[0], 0) },
        );
    }
  }

  videoTrack.sort((a, b) => a.targetStartUs - b.targetStartUs || a.targetDurationUs - b.targetDurationUs);

  /* ── 口播音轨：从 0 开始，保留实际时长 ── */
  let voiceIncluded = false;
  if (opt.includeVoice && voice) {
    if (!voice.path) addIssue('block', 'voice-path', '口播音频没有本地路径，无法导出');
    else if (LINK_RE.test(voice.path))
      addIssue('block', 'linked-asset', '口播音频还是网络链接，需要先保存到本机再导出');
    else if (probeFor(probes, voice.path)?.exists === false)
      addIssue('block', 'missing-file', '口播音频文件失联或无法读取');
    else {
      const probeDur = positive(probeFor(probes, voice.path)?.durationSec);
      let voiceDur = voice.duration != null && voice.duration > 0 ? voice.duration : probeDur;
      if (voiceDur == null || !(voiceDur > 0)) {
        addIssue('confirm', 'unknown-duration', '无法确认口播音频时长，已按整条时间轴导出，请检查');
        voiceDur = durationSec;
      }
      const durationVoiceUs = Math.max(0, clock.us(voiceDur) ?? 0);
      if (durationVoiceUs <= 0) {
        addIssue('confirm', 'zero-length', '口播音频不足一帧，没有放进草稿，请检查音频文件');
      } else {
        const sourceAsset = sourceAssetFor(voice.path);
        const planId = pushAsset(`audio|${voice.path}`, 'audio', voice.path, voice.name, {
          durationSec: voiceDur,
          sourceAssetId: sourceAsset?.id,
        });
        audioTrack.push({
          id: id('audio'),
          kind: 'audio',
          assetId: planId,
          targetStartUs: 0,
          targetDurationUs: durationVoiceUs,
          sourceStartUs: 0,
          sourceDurationUs: durationVoiceUs,
          volume: 1,
        });
        voiceIncluded = true;
      }
    }
  } else if (opt.includeVoice && !voice) {
    addIssue('info', 'no-voice', '项目没有关联口播音频，草稿里只有画面');
  }

  /* ── 字幕与 SRT：默认关闭；开启后每句一个可编辑文字段 ── */
  if (opt.subtitles) {
    lines.forEach((row, index) => {
      const time = tl.times.get(row.id);
      const text = typeof row.text === 'string' ? row.text : '';
      if (!time || !srtText(text)) return;
      const startUs = boundUs(clock.us(Math.max(0, time.start)));
      const endUs = boundUs(clock.us(time.end));
      if (endUs <= startUs) {
        addIssue('confirm', 'zero-length', `第 ${pickLineNo(row, index)} 句字幕不足一帧，导出时省略`, {
          rowId: row.id,
          lineNo: pickLineNo(row, index),
        });
        return;
      }
      const no = pickLineNo(row, index);
      subtitles.push({ lineId: row.id, no, text, startUs, endUs });
      textTrack.push({ id: id('text'), text, targetStartUs: startUs, targetDurationUs: endUs - startUs });
    });
  }

  /* ── 备选素材：只进 altAssets，不上轨道 ── */
  const altList = [];
  if (altAssets.size) {
    if (opt.altAssets) {
      for (const [assetId, { row }] of altAssets) {
        const asset = registry[assetId];
        if (!asset) {
          addIssue('block', 'unknown-asset', '备选素材的记录不存在（可能已从素材库删除）', {
            rowId: row?.id,
            lineNo: row ? pickLineNo(row, 0) : null,
            assetId,
          });
          continue;
        }
        const path = typeof asset.path === 'string' ? asset.path : '';
        const name = mediaName(asset, path);
        if (!path) {
          addIssue('block', 'missing-path', `备选素材「${name}」没有本地路径，无法复制`, { rowId: row?.id, assetId });
          continue;
        }
        if (LINK_RE.test(path)) {
          addIssueOnce(
            `${assetId}|alt-linked`,
            'confirm',
            'linked-asset',
            `备选素材「${name}」还是网络链接，没有复制到草稿`,
            { rowId: row?.id, assetId },
          );
          continue;
        }
        if (probeFor(probes, path)?.exists === false) {
          addIssueOnce(
            `${assetId}|alt-missing`,
            'confirm',
            'missing-file',
            `备选素材「${name}」文件失联，没有复制到草稿`,
            {
              rowId: row?.id,
              assetId,
            },
          );
          continue;
        }
        altList.push({ planId: id('asset'), path, name, kind: kindOrNull(asset, path) || 'file' });
      }
    } else {
      addIssueOnce(
        'alt-not-selected',
        'info',
        'alt-not-selected',
        `有 ${altAssets.size} 个备选素材未复制到草稿（可在“更多设置”里勾选）`,
      );
    }
  }

  /* ── 叠加素材：首版不上轨，只提醒 ── */
  for (const [assetId, { row }] of overlayAssets) {
    const asset = registry[assetId];
    const path = typeof asset?.path === 'string' ? asset.path : '';
    const name = asset ? mediaName(asset, path) : '叠加素材';
    addIssueOnce(
      `${assetId}|overlay`,
      'confirm',
      'overlay',
      `「${name}」是叠加素材，本次没有放到轨道，需在剪映里手动安排`,
      { rowId: row?.id, lineNo: row ? pickLineNo(row, 0) : null, assetId },
    );
  }

  /* ── 时长 / 时间来源提醒 ── */
  if (!lines.length && durationUs === 0) addIssue('info', 'empty-project', '项目里还没有口播句子或画面，导出计划为空');
  const timing = buildTiming(tl, lines);
  if (lines.length) {
    if (timing.source === 'rate')
      addIssueOnce('timing-rate', 'info', 'timing-rate', '句子时间按语速估算，剪映里的切换点可能和实际口播有偏差');
    else if (timing.source === 'fit')
      addIssueOnce('timing-fit', 'info', 'timing-fit', '句子时间按口播音频总长推算，不是逐句字幕实测');
    else if (timing.mixed)
      addIssueOnce(
        'timing-mixed',
        'info',
        'timing-mixed',
        `部分句子时间来自推算（低置信 ${timing.counts.low} 句、字幕缺失 ${timing.counts.est} 句、新增 ${timing.counts.gap} 句）`,
      );
  }

  /* 探针时长和项目记录不一致：排布不改，只提示，避免导出悄悄换了排布 */
  for (const entry of assets) {
    if (entry.kind !== 'video') continue;
    const asset = entry.sourceAssetId ? registry[entry.sourceAssetId] : null;
    const recorded = finite(asset?.durationSec);
    const probed = positive(probeFor(probes, entry.path)?.durationSec);
    if (recorded != null && probed != null && Math.abs(recorded - probed) > 0.25)
      addIssueOnce(
        `${entry.planId}|duration-mismatch`,
        'info',
        'duration-mismatch',
        `「${entry.name}」的实际时长（${probed.toFixed(1)} 秒）和项目记录（${recorded.toFixed(1)} 秒）不一致，排布仍按项目记录导出`,
        { assetId: entry.sourceAssetId },
      );
  }

  /* ── 统计 ── */
  const visualSpans = videoTrack.map(entry => ({
    start: entry.targetStartUs,
    end: entry.targetStartUs + entry.targetDurationUs,
  }));
  const visualUs = unionLength(visualSpans);
  const freezeSegments = videoTrack.filter(entry => entry.derived).length;
  const voiceUs = audioTrack.reduce((sum, entry) => sum + entry.targetDurationUs, 0);

  return {
    schemaVersion: SCHEMA_VERSION,
    source: {
      projectId: snapshot.projectId ?? null,
      updatedAt: snapshot.updatedAt ?? null,
      title,
    },
    title,
    canvas: { width: opt.width, height: opt.height },
    fps: { num: opt.rate.num, den: opt.rate.den },
    durationUs,
    timing,
    assets,
    derived,
    altAssets: altList,
    tracks: { video: videoTrack, audio: audioTrack, text: textTrack },
    subtitles,
    srt: buildSrt(subtitles),
    issues,
    stats: {
      shots: units.length,
      segments: videoTrack.length + audioTrack.length + textTrack.length,
      videoSegments: videoTrack.filter(entry => entry.kind === 'video').length,
      imageSegments: videoTrack.filter(entry => entry.kind === 'image' && !entry.derived).length,
      freezeSegments,
      freezeCount: freezeSegments,
      derivedCount: derived.length,
      textSegments: textTrack.length,
      gapUs: Math.max(0, durationUs - visualUs),
      totalUs: durationUs,
      visualUs,
      voiceUs,
      voiceIncluded,
      assetCount: assets.length,
      altCount: altAssets.size,
      timingSource: timing.source,
      mixed: timing.mixed,
    },
  };
}

/* 预检 / 复制素材时用的文件清单（浅拷贝数组，不包含剪映私有字段） */
export function collectPlanFiles(plan) {
  const source = plan && typeof plan === 'object' ? plan : {};
  return {
    media: Array.isArray(source.assets) ? [...source.assets] : [],
    derived: Array.isArray(source.derived) ? [...source.derived] : [],
    alt: Array.isArray(source.altAssets) ? [...source.altAssets] : [],
  };
}
