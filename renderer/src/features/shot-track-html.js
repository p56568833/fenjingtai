/* 时间轨的视图模板：接收排布和选中状态，不读共享状态或操作页面。 */
import { heldThrough } from '../core/playback-plan.js';
import { circled } from '../core/shot-layout.js';
import { altItems } from '../core/shot-tracks.js';
import { fileUrl } from '../core/asset-model.js';
import { esc } from '../ui/base/dom.js';
import { filmSource } from './filmstrip.js';
const sec = x => (Math.round(x * 10) / 10).toFixed(1);
export const clipLen = it => {
  if (it.kind !== 'video') return null;
  if (it.usage.clip) return it.usage.clip.out - it.usage.clip.in;
  return Number.isFinite(it.asset.durationSec) ? it.asset.durationSec : null;
};
const ALT_ROW = 30; // 备选轨一层的高度（时间上重叠的备选往下叠一层）
/* 色块上的名字：素材名开头的「第469-471句_」每块都一样，去掉只留后面能认出来的部分（悬停仍看全名） */
/* 色块铺胶片要的信息：视频给地址、片段起点、这块里实际放了几秒片段（后面定格补足的那截不铺）；图片给图片地址 */
function filmAttrs(it, blockLen) {
  if (it.kind === 'image') return ` data-film-img="${esc(fileUrl(it.asset.path || ''))}"`;
  const f = filmSource(it.asset, it.usage.clip);
  if (!f) return '';
  const len = clipLen(it);
  const shown = Math.max(0, Math.min(blockLen, len ?? blockLen));
  return ` data-film-src="${esc(f.src)}" data-film-in="${f.from}" data-film-len="${shown.toFixed(2)}" data-film-frac="${(blockLen > 0 ? shown / blockLen : 1).toFixed(4)}"`;
}
export const shortName = name =>
  String(name || '').replace(/^第\s*\d+(?:\s*[-–—~]\s*\d+)?\s*句[\s_·\-–—:：]*/, '') || name || '';

export function shotTrackHTML({ unit: u, assets, tl, ti, pick, toneOf }) {
  const r = u.members[0];
  const items = u.layout?.items || [];
  const trackAlts = u.layout ? altItems(assets, u.members, tl) : [];
  const needs = !r.type || ti.needsVisual(r.type);
  if (!items.length && !trackAlts.length && !needs) return { hidden: true, alts: trackAlts, pick };
  const dur = u.end - u.start;
  // 默认谁都不选：没有白框和把手，看得清相邻两段是不是紧挨着；点一下色块才选中
  if (!items.some(it => it.assetId === pick) && !trackAlts.some(it => it.assetId === pick)) pick = null;
  const pct = x => `${Math.max(0, Math.min(100, (x / dur) * 100))}%`;
  // 刻度：大约每 1 / 2 / 5 / 10 秒一格
  const step = [1, 2, 5, 10, 15, 30].find(s => dur / s <= 14) || 60;
  let ticks = '';
  for (let x = 0; x <= dur + 1e-6; x += step) ticks += `<span class="ptt-tick" style="left:${pct(x)}">${x}s</span>`;
  // 句子分界（第 2 句起）：两条轨上各画一道实线，不写字、不能点；刻度尺上不画
  const cuts = u.members.slice(1).map(m => (tl.times.get(m.id)?.start ?? u.start) - u.start);
  const seps = cuts.map(at => `<span class="ptt-sep" style="left:${pct(at)}"></span>`).join('');
  const bareSeps = seps;
  // 句间停顿里延续的上一段画面：画成同色的淡尾巴，和预览里看到的对上
  const holds = items
    .map((it, k) => {
      const next = items[k + 1];
      if (!next || !heldThrough(u, it, next, tl)) return '';
      const s = Math.min(it.end, dur);
      return `<span class="ptt-hold${toneOf(r.id, items, k) ? ' t1' : ''}" style="left:${pct(s)};width:${pct(Math.min(next.start, dur) - s)}" title="句间停顿，${circled(it.n)} 接着播到 ${circled(next.n)} 出现"></span>`;
    })
    .join('');
  const blocks = items
    .map((it, k) => {
      const end = Math.min(it.end, dur);
      const len = clipLen(it);
      // 标了剪辑里补足的视频才会比片段长：片段之后那截画成补足的样子（定格 / 放慢）
      const short = len != null && len < end - it.start - 0.05;
      const fit = short
        ? `<span class="ptt-fit" style="left:${((len / Math.max(0.01, end - it.start)) * 100).toFixed(1)}%" title="片段放完后定格补足 ${sec(end - it.start - len)} 秒"><i>定格</i></span>`
        : '';
      const cls = [
        'ptt-block',
        toneOf(r.id, items, k) ? 't1' : '',
        it.assetId === pick ? 'on' : '',
        it.over ? 'over' : '',
        it.start >= dur ? 'gone' : '',
      ]
        .filter(Boolean)
        .join(' ');
      const title = `${circled(it.n)} ${it.asset.name || ''}\n${sec(it.start)}–${sec(it.end)} 秒${it.over ? '（超出口播）' : ''}${short ? `\n片段只有 ${sec(len)} 秒，后 ${sec(end - it.start - len)} 秒在剪辑里定格 / 放慢补足` : ''}\n拖到下面的备选轨：先撤下来\n双击：定格补满 / 删除`;
      return `<div class="${cls}" data-ptt="${esc(it.assetId)}"${filmAttrs(it, Math.max(0, end - it.start))} style="left:${pct(it.start)};width:${pct(Math.max(0, end - it.start))}" title="${esc(title)}"><span class="ptt-grip l" title="拖动裁剪开头；Shift 拖相接边调整切换点"></span><span class="ptt-label">${circled(it.n)} ${esc(shortName(it.asset.name))}</span>${fit}<span class="ptt-grip r" title="拖动裁剪结尾；Shift 拖相接边调整切换点"></span></div>`;
    })
    .join('');
  const altRows = Math.max(1, ...trackAlts.map(a => a.row + 1));
  const altBlocks = trackAlts
    .map(it => {
      const title = `备选 · ${it.asset.name || ''}\n${sec(it.start)}–${sec(it.end)} 秒（不播放、不计时长）\n拖上正片轨：落在画面上 = 互换，落在空隙里 = 插进去\n双击：删除`;
      return `<div class="ptt-block alt${it.assetId === pick ? ' on' : ''}" data-ptt="${esc(it.assetId)}" data-alt="1"${filmAttrs(it, Math.max(0, it.end - it.start))} style="left:${pct(it.start)};width:${pct(Math.max(0, it.end - it.start))};top:${4 + it.row * ALT_ROW}px;height:${ALT_ROW - 6}px" title="${esc(title)}"><span class="ptt-grip l" title="拖动裁剪开头"></span><span class="ptt-label">${esc(shortName(it.asset.name))}</span><span class="ptt-grip r" title="拖动裁剪结尾"></span></div>`;
    })
    .join('');
  const timed = !!u.layout?.timed;
  const tips =
    '拖中间：移动 / 换序\n拖两端：裁剪（Shift 拖相接边调切换点）\n上下拖：在正片和备选之间换\nI / O：裁到播放位置\n双击画面：定格补满 / 删除';
  const html = `<div class="ptt-bar"><strong>画面时间</strong>${
    !items.length && !trackAlts.length
      ? ''
      : `<span class="ptt-mode">${timed ? '手动' : '按句子自动'}</span><span class="ptt-help" title="${esc(tips)}" aria-label="${esc(tips)}">?</span>`
  }<span class="ptt-warn" id="pttWarn"></span><span class="spacer"></span>${timed ? '<button class="ptt-reset" id="pttReset" title="去掉手动时间，按每个画面的出现位置（第几句到第几句）排">恢复按句子</button>' : ''}</div>
    <div class="ptt-lanes" id="pttLanes">
      <span></span><div class="ptt-ruler" id="pttRuler" title="点击或拖动：跳到这个时间">${ticks}<span class="ptt-rhead" id="pttRHead"></span></div>
      <span class="ptt-lname">正片</span><div class="ptt-lane" id="pttLane">${seps}${holds}${blocks}<span class="ptt-ghost" id="pttGhost" hidden></span><span class="ptt-insert" id="pttInsert" hidden></span><span class="ptt-head" id="pttHead"></span>${
        items.length ? '' : '<span class="ptt-empty">正片轨还没有画面：审核通过视频，或把备选拖上来</span>'
      }</div>
      <span class="ptt-lname alt">备选</span><div class="ptt-lane alt${trackAlts.length ? '' : ' empty'}" id="pttAlt"${
        trackAlts.length
          ? ` style="height:${altRows * ALT_ROW + 4}px"`
          : ' title="排不下的通过视频放在这里；把正片拖下来也行"'
      }>${bareSeps}${altBlocks}<span class="ptt-insert" id="pttAltInsert" hidden></span></div>
    </div>`;
  return { html, alts: trackAlts, pick, hidden: false };
}
