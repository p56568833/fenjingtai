/* 视频候选清单（纯数据，无 DOM、无应用状态）：解析 Claude 给的候选清单、挂到画面 / 撤回、换成本地文件、写回内容。
   界面与流程在 features/video-review.js。 */
import { fmtTime, parseTime } from './text.js';
import { shotMembers, setShotField, applyRole, applySpan, resolveMainConflicts } from './shots.js';
import { ensureAsset, usageList, syncMirror, assetName, referencedAssetIds } from './asset-model.js';
import { reworkScopeErrors } from './candidate-scope.js';
import { placeApproved } from './shot-tracks.js';

export const CANDIDATE_TYPE = 'fenjingtai-candidates';
export const DECISION = { ok: '通过', no: '不要', re: '换一个' };
export const CANDIDATE_VERSION = 3;
export const LEGACY_VERSION = 2; // v2（没有方案、可以写 for / coverage）的清单照样能导入，一律当作只有方案一
export const FILL_EPS = 0.5; // 方案加起来比口播短不到 0.5 秒算填满（没录音时口播时长是按语速估的）
export const MARGIN_MAX = 5; // 下载范围比「最好用的几秒」每边最多宽 5 秒

/* ── 候选清单格式检查（v3，硬性规定）：不合格的整份拒收，返回每一处错在哪（空数组 = 合格）。
   规范说明在 core/candidate-spec.js；字段增减时两边一起改。
   v3：画面 → 方案（几选一）→ 视频（按顺序接起来播）；v2：画面 → 候选，当作只有方案一 ── */
const LINES_RE = /^\d+(-\d+)?$/;
const URL_RE = /^https?:\/\/\S+$/i;
const TOP_KEYS = ['type', 'version', 'project', 'batch', 'createdAt', 'shots', 'extra', 'reviewedAt', 'reworkId'];
const SHOT_KEYS = { 3: ['lines', 'label', 'need', 'plans', 'extra'], 2: ['lines', 'label', 'need', 'cands', 'extra'] };
const PLAN_KEYS = ['cands', 'short', 'extra'];
const CAND_BASE = ['key', 'title', 'url', 'page', 'in', 'out', 'best', 'license', 'why', 'limitations', 'extra'];
const CAND_KEYS = {
  3: [...CAND_BASE, 'review'], // review：分镜台写回的审核结果
  2: [...CAND_BASE, 'for', 'coverage', 'review'],
};
/* 画面里的方案：v3 写在 plans 里；v2 的 cands 整个算方案一。返回 [{ short, cands, raw }]，不合格的跳过 */
export const plansOfShot = (s, version) =>
  version === LEGACY_VERSION
    ? [{ short: '', cands: Array.isArray(s?.cands) ? s.cands : [], raw: null }]
    : (Array.isArray(s?.plans) ? s.plans : []).map(p => ({
        short: isObj(p) && typeof p.short === 'string' ? p.short.trim() : '',
        cands: isObj(p) && Array.isArray(p.cands) ? p.cands : [],
        raw: p,
      }));
/* url 必须是视频文件本身：图片、网页地址直接拒收（AI 常把配图或视频页面当成视频交上来，审核页根本播不出来）。
   看扩展名；没有扩展名的 CDN 直链放行，但视频网站的页面地址（YouTube、B 站等）一律不行 */
const VIDEO_EXT_RE = /\.(mp4|m4v|mov|webm|mkv|ogv)$/i;
const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|avif|heic|bmp|svg|tiff?|ico)$/i;
const PAGE_EXT_RE = /\.(s?html?|php|aspx?|jsp)$/i;
const PAGE_HOSTS = [
  'youtube.com',
  'youtu.be',
  'bilibili.com',
  'b23.tv',
  'vimeo.com',
  'douyin.com',
  'tiktok.com',
  'ixigua.com',
  'v.qq.com',
  'youku.com',
  'weibo.com',
  'x.com',
  'twitter.com',
  'facebook.com',
  'instagram.com',
];
export function videoUrlIssue(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return '';
  }
  // 这台电脑 / 局域网里的临时地址（AI 自己起的本地服务）：别的电脑打不开，那个服务一关这里也打不开
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    h === 'localhost' ||
    h === '::1' ||
    h === '0.0.0.0' ||
    h.endsWith('.local') ||
    /^(127|10)\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  )
    return `url 是这台电脑上的临时地址（${u.host}），别的电脑打不开，那个临时服务一关也会失效。请给视频在网上的原始地址，in / out 写原片里的秒数，不要自己剪好再放到本地服务上`;
  let file;
  try {
    file = decodeURIComponent(u.pathname);
  } catch {
    return 'url 含有无效的百分号编码，请提供正确的视频地址（百分号应写成 %25）';
  }
  if (VIDEO_EXT_RE.test(file)) return '';
  const ext = (file.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
  if (IMAGE_EXT_RE.test(file))
    return `url 是图片地址（${ext}），不是视频。不要找图片，必须换成视频文件本身（mp4 / webm 等）`;
  if (PAGE_EXT_RE.test(file))
    return `url 是网页地址（${ext}），不是视频。必须换成视频文件本身（mp4 / webm 等），网页地址放进 page`;
  const host = u.hostname.toLowerCase();
  if (PAGE_HOSTS.some(h => host === h || host.endsWith('.' + h)))
    return `url 是视频网站的页面（${host}），软件播不了。必须换成视频文件本身（mp4 / webm 等），页面地址放进 page`;
  return '';
}

/* ── 重复画面：同一段画面不能配给两处不同的句子 ──
   同一个视频文件（地址去掉 # 片段；以视频扩展名结尾的再去掉 ? 参数，那多半是临时令牌），
   用的时间段（写了 best 看 best，否则看 in–out）重叠 2 秒以上，或重叠超过较短那段的一半，就算同一段画面。
   同一个长视频里不重叠的两段可以分别配两处；同一画面的不同方案最后只用一个，之间不算重复
   （同一个方案里的重复在 validateCandidateDoc 里单独查） */
const footageKey = url => {
  try {
    const u = new URL(String(url).trim());
    const base = `${u.hostname.toLowerCase()}${decodeURIComponent(u.pathname)}`;
    return VIDEO_EXT_RE.test(u.pathname) ? base : base + u.search;
  } catch {
    return String(url || '').trim();
  }
};
const usedRange = c => cleanBest(c.best, Number(c.in), Number(c.out)) || { in: Number(c.in), out: Number(c.out) };
export function footageOverlap(a, b) {
  if (!a?.url || !b?.url || footageKey(a.url) !== footageKey(b.url)) return 0;
  const x = usedRange(a),
    y = usedRange(b);
  const overlap = Math.min(x.out, y.out) - Math.max(x.in, y.in);
  if (!(overlap > 0)) return 0;
  const shorter = Math.min(x.out - x.in, y.out - y.in);
  return overlap >= 2 || overlap >= shorter / 2 ? overlap : 0;
}
const spanText = c => {
  const r = usedRange(c);
  return `${fmtTime(r.in)}–${fmtTime(r.out)}`;
};
/* 已经否掉 / 要换的候选不算「用上」，它的画面可以挪去配别的句子 */
const dropped = decision => decision === 'no' || decision === 're';
/* 这个候选的画面已经在别的句子上用了：返回那个占用者（项目里已通过或待审、画面不同的候选），没有返回 null */
export function footageTakenBy(c, others) {
  return others.find(o => o !== c && o.rowId !== c.rowId && !dropped(o.decision) && footageOverlap(c, o)) || null;
}
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const filled = v => typeof v === 'string' && v.trim() !== '';
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const spanOf = s => {
  const [a, b = a] = s.split('-').map(Number);
  return { from: a, to: b };
};
export function validateCandidateDoc(doc) {
  const errs = [];
  const add = (where, msg) => errs.push(where ? `${where}：${msg}` : msg);
  const unknown = (obj, keys, where) => {
    for (const k of Object.keys(obj))
      if (!keys.includes(k)) add(where, `不认识的字段「${k}」（规范外的内容请放进 extra）`);
  };
  if (!isObj(doc)) return ['文件内容不是一个 JSON 对象'];
  const v = doc.version === LEGACY_VERSION ? LEGACY_VERSION : CANDIDATE_VERSION;
  if (doc.type !== CANDIDATE_TYPE) add('顶层', `type 必须是 "${CANDIDATE_TYPE}"`);
  if (doc.version !== CANDIDATE_VERSION && doc.version !== LEGACY_VERSION)
    add(
      '顶层',
      `version 必须是数字 ${CANDIDATE_VERSION}${doc.version === 1 || doc.version === '1' ? `（这是旧格式 version 1，请按 v${CANDIDATE_VERSION} 规范重写）` : ''}`,
    );
  if (!filled(doc.project)) add('顶层', 'project 必须写项目名');
  if (!filled(doc.batch)) add('顶层', 'batch 必须写这一批的名字');
  if (doc.reworkId != null && !(filled(doc.reworkId) && doc.reworkId.startsWith('rw-')))
    add('顶层', 'reworkId 必须原样复制返工单的 id');
  if (doc.createdAt != null && !(filled(doc.createdAt) && !Number.isNaN(Date.parse(doc.createdAt))))
    add('顶层', 'createdAt 必须是 ISO 时间，如 "2026-10-09T11:02:05+08:00"');
  unknown(doc, TOP_KEYS, '顶层');
  if (!Array.isArray(doc.shots) || !doc.shots.length) {
    add('顶层', 'shots 必须是数组，至少一个画面');
    return errs;
  }
  const shotLines = new Set();
  doc.shots.forEach((s, i) => {
    const sw = `shots[${i}]${isObj(s) && filled(s.lines) ? `（lines "${s.lines}"）` : ''}`;
    if (!isObj(s)) return add(sw, '必须是对象');
    let span = null;
    if (typeof s.lines !== 'string' || !LINES_RE.test(s.lines))
      add(sw, 'lines 必须是文字句号，如 "251" 或 "251-252"（半角减号，不加空格）');
    else {
      span = spanOf(s.lines);
      if (!Number.isSafeInteger(span.from) || !Number.isSafeInteger(span.to) || span.from < 1 || span.to < 1)
        add(sw, 'lines 必须使用有效的正整数句号');
      if (span.to < span.from) add(sw, 'lines 的结束句号不能小于开始句号');
      if (shotLines.has(s.lines)) add(sw, '同一画面只能写一次，多个方案放在同一个画面的 plans 里');
      shotLines.add(s.lines);
    }
    if (!filled(s.label)) add(sw, 'label 必须写这个画面的简短名字');
    if (s.need != null && typeof s.need !== 'string') add(sw, 'need 必须是文字');
    unknown(s, SHOT_KEYS[v], sw);
    if (v === LEGACY_VERSION) {
      if (!Array.isArray(s.cands) || !s.cands.length) return add(sw, 'cands 必须是数组，至少一个候选');
    } else {
      if (s.cands != null) add(sw, '视频要写在 plans 的方案里（plans[].cands），不要直接写 cands');
      if (!Array.isArray(s.plans) || !s.plans.length) return add(sw, 'plans 必须是数组，至少一个方案');
    }
    const keys = new Set();
    plansOfShot(s, v).forEach((p, pi) => {
      const pw = v === LEGACY_VERSION ? sw : `${sw} plans[${pi}]（方案${pi + 1}）`;
      if (v !== LEGACY_VERSION) {
        if (!isObj(p.raw)) return add(pw, '必须是对象');
        unknown(p.raw, PLAN_KEYS, pw);
        if (p.raw.short != null && typeof p.raw.short !== 'string') add(pw, 'short 必须是文字');
        if (!Array.isArray(p.raw.cands) || !p.raw.cands.length) return add(pw, 'cands 必须是数组，至少一个视频');
      }
      p.cands.forEach((c, j) => {
        const cw = `${pw} cands[${j}]${isObj(c) && filled(c.key) ? `（key "${c.key}"）` : ''}`;
        if (!isObj(c)) return add(cw, '必须是对象');
        if (!filled(c.key)) add(cw, 'key 必须写');
        else if (keys.has(c.key)) add(cw, `key "${c.key}" 在这个画面里重复了（所有方案加起来不能重复）`);
        else keys.add(c.key);
        if (!filled(c.title)) add(cw, 'title 必须写中文标题');
        if (typeof c.url !== 'string' || !URL_RE.test(c.url))
          add(cw, 'url 必须是能直接播放的视频文件地址（http / https）');
        else if (videoUrlIssue(c.url)) add(cw, videoUrlIssue(c.url));
        if (c.page != null && (typeof c.page !== 'string' || !URL_RE.test(c.page)))
          add(cw, 'page 必须是网页地址（http / https）');
        if (!isNum(c.in) || c.in < 0) add(cw, 'in 必须是秒数（数字，≥ 0），不要写 "1:41" 或带引号');
        if (!isNum(c.out)) add(cw, 'out 必须是秒数（数字），不要写 "1:41" 或带引号');
        else if (isNum(c.in) && c.out <= c.in) add(cw, 'out 必须大于 in');
        if (c.best == null) {
          if (v !== LEGACY_VERSION) add(cw, 'best 必须写：{ "in": 秒数, "out": 秒数 }，这段里真正要用的那几秒');
        } else {
          const b = c.best;
          if (!isObj(b) || !isNum(b.in) || !isNum(b.out) || Object.keys(b).some(k => k !== 'in' && k !== 'out'))
            add(cw, 'best 必须写成 { "in": 秒数, "out": 秒数 }（数字），不要写别的字段');
          else if (b.out <= b.in) add(cw, 'best 的 out 必须大于 in');
          else if (isNum(c.in) && isNum(c.out) && (b.in < c.in - 0.01 || b.out > c.out + 0.01))
            add(cw, `best（${b.in}–${b.out}）必须在 in–out（${c.in}–${c.out}）范围内`);
          else if (
            v !== LEGACY_VERSION &&
            isNum(c.in) &&
            isNum(c.out) &&
            (b.in - c.in > MARGIN_MAX + 0.01 || c.out - b.out > MARGIN_MAX + 0.01)
          )
            add(
              cw,
              `下载范围 in–out（${c.in}–${c.out}）比 best（${b.in}–${b.out}）宽太多：每边最多宽 ${MARGIN_MAX} 秒，请把 in / out 收窄到 best 前后 1–3 秒`,
            );
        }
        if (v === LEGACY_VERSION && c.for != null) {
          if (typeof c.for !== 'string' || !LINES_RE.test(c.for)) add(cw, 'for 必须是文字句号，如 "252" 或 "252-253"');
          else if (span) {
            const f = spanOf(c.for);
            if (f.to < f.from || f.from < span.from || f.to > span.to)
              add(cw, `for "${c.for}" 必须在这个画面的 lines "${s.lines}" 范围内`);
          }
        }
        if (!filled(c.license)) add(cw, 'license 必须写版权情况（不清楚就写「版权未核实」）');
        if (!filled(c.why)) add(cw, 'why 必须写为什么选它、画面里看到了什么');
        if (v === LEGACY_VERSION && c.coverage != null && c.coverage !== 'full' && c.coverage !== 'partial')
          add(cw, 'coverage 只能是 "full" 或 "partial"');
        if (c.limitations != null && typeof c.limitations !== 'string') add(cw, 'limitations 必须是文字');
        else if (v === LEGACY_VERSION && c.coverage === 'partial' && !filled(c.limitations))
          add(cw, 'coverage 是 "partial" 时必须写 limitations（缺了哪部分）');
        unknown(c, CAND_KEYS[v], cw);
      });
      // 同一个方案里同一段画面用了两次：方案里的视频是接起来播的，等于同一个镜头放两遍
      // （v2 的候选当初写的是「互为备选」，旧清单不追究）
      const live = v === LEGACY_VERSION ? [] : p.cands.filter(usableCand).filter(c => !dropped(c.review?.decision));
      live.forEach((a, k) => {
        for (const b of live.slice(k + 1))
          if (footageOverlap(a, b))
            add(
              '重复画面',
              `lines "${s.lines}" 方案${pi + 1} 里 key "${a.key}"（${spanText(a)}）和 key "${b.key}"（${spanText(b)}）是同一个视频里同一段画面，同一个方案里不能用两次`,
            );
      });
    });
  });
  // 同一份清单里，同一段画面配给了不同的句子：每一对都指出来
  const used = doc.shots.flatMap(s =>
    isObj(s)
      ? plansOfShot(s, v).flatMap(p =>
          p.cands.filter(usableCand).map(c => ({ ...c, rowId: s.lines, decision: c.review?.decision })),
        )
      : [],
  );
  used.forEach((a, i) => {
    if (dropped(a.decision)) return;
    for (const b of used.slice(i + 1))
      if (b.rowId !== a.rowId && !dropped(b.decision) && footageOverlap(a, b))
        add(
          '重复画面',
          `lines "${a.rowId}" 的 key "${a.key}"（${spanText(a)}）和 lines "${b.rowId}" 的 key "${b.key}"（${spanText(b)}）是同一个视频里同一段画面，同一段画面不能配给两处不同的句子。请给其中一处换别的视频，或换成这个视频里不重叠的另一段`,
        );
  });
  return errs;
}
const usableCand = c => isObj(c) && typeof c.url === 'string' && isNum(c.in) && isNum(c.out) && c.out > c.in;

/* 新清单里的候选，和项目里别的批次已经通过 / 待审、配在别的句子上的候选用了同一段画面：一条一条列出来 */
export function duplicateFootageErrors(incoming, existing, rows) {
  const errs = [];
  const noOf = id => rows.find(r => r.id === id)?.no;
  for (const c of incoming) {
    const o = footageTakenBy(c, existing);
    if (!o) continue;
    const where = o.decision === 'ok' ? '已经通过并用在' : '已经作为待审候选配在';
    errs.push(
      `重复画面：lines "${c.lines}" 的 key "${c.key}"（${spanText(c)}）这段画面${where}第 ${noOf(o.rowId) ?? o.lines} 句（${o.title || o.key}，${spanText(o)}），同一段画面不能配给两处不同的句子。请换别的视频，或换成这个视频里不重叠的另一段`,
    );
  }
  return errs;
}

export function parseClock(v) {
  if (typeof v === 'number' && isFinite(v)) return Math.max(0, v);
  const s = String(v ?? '').trim();
  if (!s) return NaN;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  return parseTime(s) ?? NaN;
}
/* "101-103" / "101–103" / [101, 103] / 101 → {from, to} 句号 */
export function parseLines(v) {
  if (Array.isArray(v)) return { from: +v[0], to: +(v[1] ?? v[0]) };
  const m = String(v ?? '').match(/(\d+)\s*(?:[-–—~至到]\s*(\d+))?/);
  return m ? { from: +m[1], to: +(m[2] || m[1]) } : null;
}
/* 精选段（best）：AI 认为最好用的那几秒，原片里的秒数，必须落在 in–out 之内；不合格返回 null */
export function cleanBest(b, tin, tout) {
  if (!b || typeof b !== 'object') return null;
  const bi = Number(b.in),
    bo = Number(b.out);
  if (!Number.isFinite(bi) || !Number.isFinite(bo) || bo <= bi) return null;
  if (Number.isFinite(tin) && Number.isFinite(tout) && (bi < tin - 0.01 || bo > tout + 0.01)) return null;
  const lo = Number.isFinite(tin) ? Math.max(tin, bi) : bi,
    hi = Number.isFinite(tout) ? Math.min(tout, bo) : bo;
  return hi > lo ? { in: lo, out: hi } : null;
}
export const noteLine = c =>
  `视频：${c.title || assetName(c.url)}｜${fmtTime(c.in)}–${fmtTime(c.out)}｜${c.license || '版权未注明'}｜${c.page || c.url}`;
export const remotePath = c => `${c.url.split('#')[0]}#t=${c.in},${c.out}`;

/* 候选清单 → 候选记录（按当前句号找到画面；找不到的列进 skipped）。
   每条记录带 plan（第几个方案，从 1 开始）、seq（在方案里的先后）、short（方案填不满的理由）。
   shotSeconds：画面 → 口播秒数（界面按时间轴传进来）；给了才检查「每个方案填满口播」 */
export function planImport(
  doc,
  srcFile,
  rows,
  existing = [],
  { shotSeconds, reworkRequests = {}, reworkRowIds = [] } = {},
) {
  if (!doc || doc.type !== CANDIDATE_TYPE) return { error: '这不是视频候选清单' };
  const errors = validateCandidateDoc(doc);
  if (errors.length) return { error: `候选清单格式不对（${errors.length} 处）`, errors };
  const scopeErrors = reworkScopeErrors(doc, rows, reworkRequests);
  if (scopeErrors.length) return { error: '返工素材与返工单不一致', errors: scopeErrors };
  const v = doc.version === LEGACY_VERSION ? LEGACY_VERSION : CANDIDATE_VERSION;
  const byNo = new Map(rows.filter(r => r.kind === 'line').map(r => [r.no, r]));
  // v3：画面范围必须和分镜表一模一样（v2 只认第一句，照旧）
  if (v !== LEGACY_VERSION) {
    const off = [];
    for (const s of doc.shots) {
      const range = parseLines(s.lines);
      const row = range && byNo.get(range.from);
      if (!row) continue; // 找不到这句：照旧列进 skipped
      const real = rangeOf(shotMembers(rows, row));
      if (real !== s.lines)
        off.push(
          `lines "${s.lines}" 和分镜表对不上：第 ${range.from} 句所在的画面是「${real.includes('-') ? `第 ${real.replace('-', '–')} 句` : `第 ${real} 句（单句）`}」。lines 要照抄分镜表里的画面范围`,
        );
    }
    if (off.length) return { error: `候选清单里有画面和分镜表对不上（${off.length} 处）`, errors: off };
  }
  const added = [],
    updated = [],
    skipped = [];
  const touchedShots = new Set(); // 有新视频或改过的视频的画面：只查这些画面的方案够不够长
  for (const s of doc.shots) {
    const range = parseLines(s.lines);
    const row = range && byNo.get(range.from);
    plansOfShot(s, v).forEach((p, pi) => {
      p.cands.forEach((raw, seq) => {
        const url = String(raw.url || '').trim();
        const tin = parseClock(raw.in),
          tout = parseClock(raw.out);
        if (!row || !/^https?:\/\//i.test(url) || !(tout > tin)) {
          skipped.push(`${s.lines || '?'} ${raw.key || ''}`.trim());
          return;
        }
        const base = {
          key: String(raw.key || ''),
          lines: String(s.lines),
          label: String(s.label || ''),
          rowId: row.id,
          plan: pi + 1, // 第几个方案；方案之间几选一
          seq, // 在方案里的先后：按这个顺序接起来播
          short: p.short, // 方案填不满时写的理由
          title: String(raw.title || assetName(url)),
          url,
          page: String(raw.page || ''),
          in: tin,
          out: tout,
          best: cleanBest(raw.best, tin, tout), // 精选段：通过时预填成「可用片段」；null = 整段都用（只有 v2 会没有）
          license: String(raw.license || ''),
          why: String(raw.why || ''),
          need: String(s.need || ''), // 这个画面要什么画面（审核页标题下显示）
          limits: String(raw.limitations || ''), // 画面内容只对上一部分时缺了什么
          srcFile: srcFile || '',
          ...(doc.reworkId
            ? {
                reworkId: doc.reworkId,
                reworkNote: reworkRequests[doc.reworkId].targets.find(t => t.rowIds.includes(row.id))?.note || '',
              }
            : {}),
        };
        const old = existing.find(c => c.srcFile === base.srcFile && c.lines === base.lines && c.key === base.key);
        if (old) {
          const changed = candidateChanged(old, { url, in: tin, out: tout });
          // 链接或片段变了：回到待审，旧的素材关联 / 已保存状态都作废（旧文件留在磁盘上，不删）
          const next = { ...old, ...base, ...(changed ? { decision: '', note: old.note || '' } : {}) };
          delete next.for; // 旧记录上的 for / coverage 不再用
          delete next.coverage;
          if (changed) {
            delete next.assetId;
            delete next.savedPath;
            delete next.decidedAt;
            touchedShots.add(s);
          }
          updated.push({ old, next, changed });
        } else if (raw.review?.decision === 'no') {
          // 以前已经标成「不要」、被清掉的：同一份清单再导入时不让它回来
          return;
        } else {
          added.push({ id: 'vc-' + crypto.randomUUID(), ...base, decision: '', note: raw.review?.note || '' });
          touchedShots.add(s);
        }
      });
    });
  }
  // 已交出去的返工任务不能通过删掉标记绕过范围检查；原清单的未改候选仍可重导。
  if (!doc.reworkId) {
    const pending = new Set(reworkRowIds);
    const issued = new Set(Object.values(reworkRequests).flatMap(r => r.targets.flatMap(t => t.rowIds)));
    if (
      [...added, ...updated.filter(x => x.changed).map(x => x.next)].some(
        c => pending.has(c.rowId) && issued.has(c.rowId),
      )
    )
      return {
        error: '返工素材缺少返工单标记',
        errors: [
          '这份清单包含已生成返工单的画面，请在顶层 reworkId 原样填写对应返工单的 id；软件会据此核对实际句子，不能用整段范围代替分散画面',
        ],
      };
  }
  // 和项目里已有的候选比：这份清单自己的旧版本不算（重新导入同一份文件时按 lines + key 对上的就是它自己）
  const mine = new Set([...added, ...updated.map(x => x.next)].map(c => `${c.srcFile}|${c.lines}|${c.key}`));
  const others = existing.filter(c => !mine.has(`${c.srcFile}|${c.lines}|${c.key}`));
  const dupes = duplicateFootageErrors(
    [...added, ...updated.filter(x => x.changed).map(x => x.next)], // 没改过的候选本来就在项目里，不重新追究
    others,
    rows,
  );
  if (dupes.length) return { error: `候选清单里有重复画面（${dupes.length} 处）`, errors: dupes };
  if (v !== LEGACY_VERSION && shotSeconds) {
    const records = [...added, ...updated.map(x => x.next)];
    const short = fillErrors(
      doc.shots.filter(s => touchedShots.has(s)),
      records,
      s => {
        const range = parseLines(s.lines);
        const row = range && byNo.get(range.from);
        return row ? shotSeconds(shotMembers(rows, row)) : null;
      },
    );
    if (short.length) return { error: `候选清单里有方案填不满口播（${short.length} 处）`, errors: short };
  }
  return { added, updated, skipped };
}
const rangeOf = members => {
  const nos = members.map(m => m.no).filter(n => n > 0);
  if (!nos.length) return '';
  const a = Math.min(...nos),
    b = Math.max(...nos);
  return a === b ? String(a) : `${a}-${b}`;
};
const sec1 = x => String(Math.round(x * 10) / 10);

/* ── 方案（v3）：画面里几选一的几套视频，方案里的视频按顺序接起来播 ── */
export const planOf = c => (Number.isSafeInteger(c?.plan) && c.plan > 0 ? c.plan : 1);
export const PLAN_NAMES = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
export const planName = n => `方案${PLAN_NAMES[n - 1] || n}`;
/* 一个视频能用几秒：有精选段按精选段，否则整个下载范围 */
export function usableSeconds(c) {
  const b = cleanBest(c.best, c.in, c.out);
  return b ? b.out - b.in : Math.max(0, c.out - c.in);
}
/* 一个画面的各个方案，按方案号排：[{ plan, cands（按播放顺序）, live（没被否掉的）, okLen, liveLen, short, filled, fits }]。
   need：这个画面的口播秒数；filled = 通过的视频已经填满，fits = 没被否掉的视频加起来够长 */
export function shotPlans(cands, need) {
  const map = new Map();
  for (const c of cands) {
    const n = planOf(c);
    if (!map.has(n)) map.set(n, []);
    map.get(n).push(c);
  }
  return [...map]
    .sort((a, b) => a[0] - b[0])
    .map(([plan, list]) => {
      const ordered = [...list].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
      const live = ordered.filter(c => !dropped(c.decision));
      const ok = ordered.filter(c => c.decision === 'ok');
      const okLen = ok.reduce((t, c) => t + usableSeconds(c), 0);
      const liveLen = live.reduce((t, c) => t + usableSeconds(c), 0);
      const known = Number.isFinite(need) && need > 0;
      return {
        plan,
        cands: ordered,
        live,
        ok,
        okLen,
        liveLen,
        need: known ? need : null,
        short: ordered.find(c => c.short)?.short || '',
        filled: known ? ok.length > 0 && okLen + FILL_EPS >= need : false,
        fits: known ? liveLen + FILL_EPS >= need : true,
      };
    });
}
/* 每个方案都要填满口播：不够长的必须写 short，而且只有一个能填满的方案都没有时，才能交这一个不够长的 */
function fillErrors(shots, records, needOf) {
  const errs = [];
  for (const s of shots) {
    const need = needOf(s);
    if (!(need > 0)) continue;
    const plans = shotPlans(
      records.filter(c => c.lines === String(s.lines)),
      need,
    );
    const anyFits = plans.some(p => p.fits);
    for (const p of plans) {
      if (p.fits) continue;
      const where = `lines "${s.lines}" ${planName(p.plan)}`;
      const gap = `视频加起来 ${sec1(p.liveLen)} 秒，口播 ${sec1(need)} 秒，还差 ${sec1(need - p.liveLen)} 秒`;
      if (anyFits) errs.push(`${where}：${gap}。这个画面已经有能填满的方案，不够长的方案不要交，删掉或者补够长`);
      else if (plans.length > 1)
        errs.push(`${where}：${gap}。一个能填满的方案都没有时，只能交一个不够长的方案，其他的删掉`);
      else if (!p.short)
        errs.push(`${where}：${gap}。请补视频填满；实在找不到，在这个方案的 short 里写明缺了什么、为什么找不到`);
    }
  }
  return errs;
}
/* 主画面按方案里的先后排：审核来的视频之间按 seq 排，占它们原来的位置；别的主画面不动。
   只影响按句子自动排的镜头（拖过的按各自的时间放） */
export function orderPlanMains(members, registry, cands) {
  const byId = new Map(cands.map(c => [c.id, c]));
  const candOf = u => {
    const c = byId.get(registry[u.assetId]?.source?.candidate);
    return c && c.assetId === u.assetId ? c : null;
  };
  for (const m of members) {
    const list = usageList(m);
    const slots = list.map((u, i) => (u.role === 'main' && candOf(u) ? i : -1)).filter(i => i >= 0);
    const sorted = slots
      .map(i => list[i])
      .sort((a, b) => planOf(candOf(a)) - planOf(candOf(b)) || (candOf(a).seq ?? 0) - (candOf(b).seq ?? 0));
    slots.forEach((slot, k) => (list[slot] = sorted[k]));
  }
}

/* 通过：挂到画面上，配整个画面。
   正片轨还有空（tl 给了才判断，见 shot-tracks.js 的 placeApproved）：当主画面——按句子自动排时接在后面，
   拖过时间的放进第一个空当；原来的占位主画面（照片等，非视频审核来的）让位成备选。
   正片轨已经填满：放到备选轨（返回 role: 'alt'），拖上正片轨就能换上。
   cands：项目里所有候选（自动排时按清单里的先后排主画面） */
export function attachCandidate(c, rows, registry, cands = [], { tl = null } = {}) {
  const row = rows.find(r => r.id === c.rowId);
  if (!row) return { error: '找不到这个画面（句子可能被删了）' };
  const members = shotMembers(rows, row);
  const asset = ensureAsset(registry, remotePath(c), { kind: 'video', name: c.title });
  asset.source = { candidate: c.id, url: c.url, page: c.page, license: c.license };
  // 先判断放哪：只看别的候选视频占了多少（占位照片会让位，不算）
  const place = tl
    ? placeApproved(registry, members, tl, usableSeconds(c), id => id !== asset.id && !!registry[id]?.source?.candidate)
    : { role: 'main' };
  for (const m of members) {
    let u = usageList(m).find(x => x.assetId === asset.id);
    if (!u) {
      m.assetUsages = [...usageList(m), { assetId: asset.id }];
      u = m.assetUsages[m.assetUsages.length - 1];
    }
    // 可用片段：清单写了精选段就用精选段，否则整段（截取保存的始终是 in–out，精选段换算到文件里）
    const best = cleanBest(c.best, c.in, c.out);
    u.clip = best ? { ...best } : { in: c.in, out: c.out };
    delete u.off;
  }
  const main = place.role === 'main';
  applyRole(members, asset.id, place.role);
  applySpan(members, asset.id, 0, members.length - 1);
  if (place.at)
    for (const m of members)
      for (const u of usageList(m)) if (u.assetId === asset.id) u.at = { ...place.at, of: members[0].id };
  const demoted = main ? resolveMainConflicts(members, asset.id, id => !!registry[id]?.source?.candidate) : [];
  if (main) orderPlanMains(members, registry, [...cands.filter(x => x.id !== c.id), { ...c, assetId: asset.id }]);
  const line = noteLine(c);
  if (!(row.note || '').includes(line))
    setShotField(rows, row, 'note', (row.note ? row.note.replace(/\s+$/, '') + '\n' : '') + line);
  syncMirror(members, registry);
  return { assetId: asset.id, role: place.role, current: main, demoted };
}
/* 撤回通过：把这个视频从画面上拿掉，画面描述里那一行也删掉 */
export function detachCandidate(c, rows, registry) {
  const id = c.assetId;
  const own = rows.find(r => r.id === c.rowId && r.kind === 'line');
  // 原来那句还在：就处理它所在的画面；找不到（句子被删了 / 旧数据）：到用着这个视频的每个画面里摘掉
  const owners = own
    ? [own]
    : id
      ? rows.filter(r => r.kind === 'line' && usageList(r).some(u => u.assetId === id))
      : [];
  const line = noteLine(c);
  const touched = [];
  for (const row of owners) {
    const members = shotMembers(rows, row);
    if (touched.includes(members[0])) continue;
    touched.push(members[0]);
    for (const m of members) if (id) m.assetUsages = usageList(m).filter(u => u.assetId !== id);
    if ((row.note || '').includes(line))
      setShotField(
        rows,
        row,
        'note',
        row.note
          .split('\n')
          .filter(l => l !== line)
          .join('\n'),
      );
    syncMirror(members, registry);
  }
}
/* 保存了那几秒：素材换成本地文件（文件 = 原片 in–out），原链接留在画面描述里。
   可用片段（精选段 / 审核时改过的入出点）换算成文件里的秒数保留下来；覆盖整个文件的就不再记（= 整段）。
   不知道 in / out（旧调用）时退回「整段」。文件真实时长由界面读取后记进 durationSec */
const r2 = x => Math.round(x * 100) / 100;
export function localClip(clip, c) {
  const span = Number.isFinite(c?.in) && Number.isFinite(c?.out) && c.out > c.in ? c.out - c.in : null;
  if (!clip || span == null || !Number.isFinite(clip.in) || !Number.isFinite(clip.out)) return null;
  const s = Math.max(0, clip.in - c.in),
    e = Math.min(span, clip.out - c.in);
  if (e - s < 0.1 || (s < 0.05 && e > span - 0.05)) return null;
  return { in: r2(s), out: r2(e) };
}
export function swapToLocal(c, localPath, rows, registry) {
  const a = registry[c.assetId];
  if (!a) return false;
  a.path = localPath;
  a.name = assetName(localPath);
  a.kind = 'video';
  delete a.durationSec;
  for (const r of rows)
    if (r.kind === 'line')
      for (const u of usageList(r)) {
        if (u.assetId !== a.id) continue;
        const clip = localClip(u.clip, c);
        if (clip) u.clip = clip;
        else delete u.clip;
      }
  syncMirror(rows, registry);
  return true;
}
/* 已经保存到本地、表格里却还挂着在线地址的视频：找出来（返回 [{ asset, cand }]）。
   典型来源：通过 → 保存 → 撤回 → 再通过，再通过时按在线地址新建了素材，候选上的「已保存」还在，
   「保存已通过的片段」又会跳过它，于是一直显示「在线」；或者重复导入的批次里同一段又通过了一次。
   按「链接 + 入出点」对上已通过、已保存的候选（素材记着的候选优先），链接或片段变了的不算 */
export function staleOnlineClips(cands, rows, registry) {
  const saved = new Map(); // 在线地址（含入出点）→ 已保存的候选
  for (const c of cands) if (c.decision === 'ok' && c.savedPath && c.url) saved.set(remotePath(c), c);
  const byId = new Map(cands.map(c => [c.id, c]));
  const out = [];
  for (const id of referencedAssetIds(rows)) {
    const a = registry[id];
    if (!a || !saved.has(a.path)) continue;
    const own = a.source?.candidate ? byId.get(a.source.candidate) : null;
    const c = own && own.decision === 'ok' && own.savedPath && remotePath(own) === a.path ? own : saved.get(a.path);
    out.push({ asset: a, cand: c });
  }
  return out;
}

/* 文件名里的句号：按这个画面现在的句子范围（第125-127句 / 第125句）；画面找不到时退回清单里写的 lines */
export function lineTag(c, rows) {
  const row = rows.find(r => r.id === c.rowId);
  const nos = row
    ? shotMembers(rows, row)
        .map(m => m.no)
        .filter(n => n > 0)
    : [];
  let from, to;
  if (nos.length) {
    from = Math.min(...nos);
    to = Math.max(...nos);
  } else {
    const r = parseLines(c.lines);
    if (!r || !(r.from > 0)) return '';
    ({ from, to } = r);
  }
  return from === to ? `第${from}句` : `第${from}-${to}句`;
}
export const fileTitle = (c, rows) => [lineTag(c, rows), c.title].filter(Boolean).join('_');
export const hasLineTag = p => /^第\d+(?:-\d+)?句_/.test(assetName(p));

/* 项目 JSON 里带的候选记录：清洗字段，rowId 按导入时的 id 映射改写；对不上句子的丢掉，素材已不在库里的不再算「已挂」 */
export function sanitizeProjectCandidates(list, { idMap = new Map(), rowIds = new Set(), assets = {} } = {}) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const url = String(raw.url || '').trim();
    const tin = parseClock(raw.in),
      tout = parseClock(raw.out);
    if (!/^https?:\/\//i.test(url) || !(tout > tin)) continue;
    const rowId = idMap.has(raw.rowId) ? idMap.get(raw.rowId) : raw.rowId;
    if (!rowIds.has(rowId)) continue;
    let id = typeof raw.id === 'string' && raw.id ? raw.id : 'vc-' + crypto.randomUUID();
    if (seen.has(id)) id = 'vc-' + crypto.randomUUID();
    seen.add(id);
    const decision = ['ok', 'no', 're'].includes(raw.decision) ? raw.decision : '';
    const assetId = typeof raw.assetId === 'string' && assets[raw.assetId] ? raw.assetId : undefined;
    out.push({
      id,
      key: String(raw.key || ''),
      lines: String(raw.lines ?? ''),
      label: String(raw.label || ''),
      rowId,
      title: String(raw.title || assetName(url)),
      url,
      page: String(raw.page || ''),
      in: tin,
      out: tout,
      best: cleanBest(raw.best, tin, tout),
      license: String(raw.license || ''),
      why: String(raw.why || ''),
      plan: planOf(raw),
      seq: Number.isSafeInteger(raw.seq) && raw.seq >= 0 ? raw.seq : 0,
      short: String(raw.short || ''),
      need: String(raw.need || ''),
      limits: String(raw.limits || ''),
      srcFile: typeof raw.srcFile === 'string' ? raw.srcFile : '',
      decision: decision === 'ok' && !assetId ? '' : decision,
      note: String(raw.note || ''),
      ...(assetId ? { assetId } : {}),
      ...(assetId && typeof raw.savedPath === 'string' && raw.savedPath ? { savedPath: raw.savedPath } : {}),
      ...(Number.isFinite(raw.decidedAt) ? { decidedAt: raw.decidedAt } : {}),
      ...(typeof raw.batchId === 'string' ? { batchId: raw.batchId } : {}),
      ...(Number.isFinite(raw.batchAt) ? { batchAt: raw.batchAt } : {}),
      ...(typeof raw.batchName === 'string' ? { batchName: raw.batchName } : {}),
      ...(Number.isSafeInteger(raw.batchNo) && raw.batchNo > 0 ? { batchNo: raw.batchNo } : {}),
      ...(raw.batchKind === 'rework' ? { batchKind: 'rework' } : {}),
      ...(typeof raw.reworkId === 'string' && raw.reworkId.startsWith('rw-') ? { reworkId: raw.reworkId } : {}),
      ...(typeof raw.reworkNote === 'string' ? { reworkNote: raw.reworkNote } : {}),
    });
  }
  return out;
}

/* 同一候选的链接或片段改了：原来通过时挂上的素材、保存好的本地片段都不再代表这个候选 */
export const candidateChanged = (old, next) => old.url !== next.url || old.in !== next.in || old.out !== next.out;

/* 表格里当主画面的素材（写回时据此标出「正在用的方案」） */
export function mainAssetIds(rows) {
  const out = new Set();
  for (const r of rows || [])
    if (r.kind === 'line') for (const u of usageList(r)) if (u.role === 'main' && !u.off) out.add(u.assetId);
  return out;
}
/* 写回候选清单的内容：每个来源文件一份。inUse：素材 id 集合，通过的视频在里面 = 它所在的方案正在用 */
export function reviewPayload(cands, inUse = new Set()) {
  const byFile = new Map();
  for (const c of cands) {
    if (!c.srcFile) continue;
    if (!byFile.has(c.srcFile)) byFile.set(c.srcFile, []);
    byFile.get(c.srcFile).push({
      key: c.key,
      lines: c.lines,
      decision: c.decision || '',
      note: c.note || '',
      savedPath: c.savedPath || '',
      inUse: c.decision === 'ok' && !!c.assetId && inUse.has(c.assetId),
    });
  }
  return byFile;
}
