import { on } from '../app/events.js';
/* 画面时间轴的胶片：正片 / 备选色块里横着铺这段片段的小截图，看一眼就知道这段拍的是什么。
   · 色块大约每 64px 一张，从片段入点到出点均匀取时间点（取整到 0.5 秒，裁剪、重画时能复用已经截好的）。
   · 截好的小图按「文件 + 秒数」存在内存里（最多 400 张，每张 96px 宽，合起来不到几 MB）；同一个文件只开一个 <video>，
     顺着时间点一张张 seek，和审核截图、表格缩略图共用 withDecodeSlot 的解码名额，不会把机器拖慢。
   · 只截当前这一个画面里的素材；还没截到的格子先露出色块的底色，截好一张填一张。
   · 图片素材直接拿图片当背景平铺，不用解码。读不出来的视频（在线地址不让读、文件失联）就保留色块。 */
import { fileUrl, LINK_RE } from '../core/asset-model.js';
import { loadMetadata, seekVideoFrame, releaseMedia, withDecodeSlot } from '../ui/base/media.js';

const TILE = 64; // 每格大约多宽（px）
const STEP = 0.5; // 时间点取整：同一段片段裁剪前后、重画前后用同一批截图
const W = 96;
const MAX = 400;
const shots = new Map(); // `${src}|${t}` → canvas（缓存的原图，用时复制一份）
const failed = new Set(); // 读不出来的文件：不再反复尝试
const jobs = new Map(); // src → { want: Set<t> }
const queue = [];
let running = 0;

const keyOf = (src, t) => `${src}|${t}`;
const snap = t => Math.max(0, Math.round(t / STEP) * STEP);

/* 视频要用的地址和片段起点：在线地址去掉 #t=，起点取片段入点（没有就取 #t= 的开头） */
export function filmSource(asset, clip) {
  const path = asset?.path || '';
  if (!path) return null;
  const frag = /#t=([\d.]+)/.exec(path);
  return {
    src: LINK_RE.test(path) ? path.split('#')[0] : fileUrl(path),
    from: Number.isFinite(clip?.in) ? clip.in : frag ? +frag[1] : 0,
  };
}

/* 把一个色块铺上胶片。block 上带 data-film-src / data-film-in / data-film-len（片段在这块里实际放的秒数）
   或 data-film-img（图片）。宽度没变、内容也没变就不重铺 */
function paintBlock(block) {
  const width = block.clientWidth;
  if (!width) return;
  const img = block.dataset.filmImg;
  const src = block.dataset.filmSrc;
  if (!img && !src) return;
  let film = block.querySelector(':scope > .ptt-film');
  const n = Math.max(1, Math.round((width * Math.max(0.05, +(block.dataset.filmFrac ?? 1))) / TILE));
  const from = +block.dataset.filmIn || 0;
  const len = Math.max(0, +block.dataset.filmLen || 0);
  const frac = Math.max(0, Math.min(1, +(block.dataset.filmFrac ?? 1)));
  const sig = img ? `img|${img}` : `${src}|${from}|${len}|${n}|${frac}`;
  if (film?.dataset.sig === sig && !film.querySelector('.ptt-frame.wait')) return;
  if (!film) {
    film = document.createElement('span');
    film.className = 'ptt-film';
    film.setAttribute('aria-hidden', 'true');
    block.prepend(film);
  }
  film.dataset.sig = sig;
  film.style.width = img ? '' : `${(frac * 100).toFixed(2)}%`;
  if (img) {
    film.replaceChildren();
    film.style.backgroundImage = `url("${img.replace(/"/g, '%22')}")`;
    film.classList.add('img');
    return;
  }
  if (failed.has(src)) return film.replaceChildren();
  const cells = [];
  for (let i = 0; i < n; i++) {
    const t = snap(from + (len * (i + 0.5)) / n);
    const cell = document.createElement('span');
    cell.className = 'ptt-frame';
    cell.dataset.t = t;
    if (!fill(cell, src, t)) {
      cell.classList.add('wait');
      want(src, t);
    }
    cells.push(cell);
  }
  film.replaceChildren(...cells);
  pump();
}

/* 有截好的就复制一份放进格子 */
function fill(cell, src, t) {
  const got = shots.get(keyOf(src, t));
  if (!got) return false;
  const cv = document.createElement('canvas');
  cv.width = got.width;
  cv.height = got.height;
  cv.getContext('2d').drawImage(got, 0, 0);
  cell.replaceChildren(cv);
  cell.classList.remove('wait');
  return true;
}

function want(src, t) {
  let job = jobs.get(src);
  if (!job) {
    job = { src, want: new Set() };
    jobs.set(src, job);
    queue.push(job);
  }
  job.want.add(t);
}

function pump() {
  while (running < 2 && queue.length) {
    const job = queue.shift();
    running++;
    withDecodeSlot(() => grab(job)).finally(() => {
      running--;
      if (jobs.get(job.src) === job) jobs.delete(job.src);
      // 截完的那一下又要了新的时间点（重画、裁剪）：再排一次
      for (const t of job.want) want(job.src, t);
      pump();
    });
  }
}

async function grab(job) {
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  try {
    const ready = loadMetadata(v, 20000);
    v.src = job.src;
    await ready;
    while (job.want.size) {
      const t = [...job.want].sort((a, b) => a - b)[0];
      job.want.delete(t);
      if (shots.has(keyOf(job.src, t))) continue;
      await seekVideoFrame(v, t, { timeoutMs: 8000 });
      if (!v.videoWidth) throw new Error('视频没有可用画面');
      const cv = document.createElement('canvas');
      cv.width = W;
      cv.height = Math.round((W * v.videoHeight) / v.videoWidth) || 54;
      cv.getContext('2d').drawImage(v, 0, 0, cv.width, cv.height);
      shots.set(keyOf(job.src, t), cv);
      while (shots.size > MAX) shots.delete(shots.keys().next().value);
      for (const cell of document.querySelectorAll(
        `.ptt-block[data-film-src="${CSS.escape(job.src)}"] .ptt-frame.wait`,
      ))
        if (+cell.dataset.t === t) fill(cell, job.src, t);
    }
  } catch {
    // 读不出来：这个文件的格子都去掉，露出色块本来的样子
    failed.add(job.src);
    job.want.clear();
    for (const block of document.querySelectorAll(`.ptt-block[data-film-src="${CSS.escape(job.src)}"]`))
      block.querySelector(':scope > .ptt-film')?.replaceChildren();
  } finally {
    releaseMedia(v);
  }
}

/* 时间轴重画、宽度变了之后调：给轨道里每个色块铺胶片 */
export function paintFilm(root) {
  if (!root) return;
  for (const block of root.querySelectorAll('.ptt-block')) paintBlock(block);
}

/* 文件换了（重新定位、保存到本地）：之前认定读不出来的可以再试 */
function forgetFilmFailures() {
  failed.clear();
}

on('asset-relocated', forgetFilmFailures);
on('project-loaded', forgetFilmFailures);
on('candidate-media', forgetFilmFailures);
