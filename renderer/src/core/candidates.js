import {
  CANDIDATE_TYPE,
  CANDIDATE_VERSION,
  FILL_EPS,
  MARGIN_MAX,
  parseClock,
  parseLines,
  cleanBest,
  usableSeconds,
  candidateChanged,
  forWindow,
  localVideoPath,
  isCandidateSource,
} from './candidate-values.js';
export * from './candidate-values.js';
export * from './candidate-placement.js';
/* 视频候选清单（纯数据，无 DOM、无应用状态）：清单校验、导入规划与审核结果导出。
   界面与流程在 features/video-review.js。 */
import { fmtTime } from './text.js';
import { shotSpan } from './timeline.js';
import { shotMembers } from './shots.js';
import { usageList, assetName } from './asset-model.js';
import { reworkScopeErrors } from './candidate-scope.js';

/* ── 候选清单格式检查（v4，硬性规定）：不合格的整份拒收，返回每一处错在哪（空数组 = 合格）。
   规范说明在 core/candidate-spec.js；字段增减时两边一起改。
   v4：画面 → 视频，每段视频用 for 写明给这个画面里的哪几句（一句，或整段）。旧格式（v1–v3）不再导入 ── */
const LINES_RE = /^\d+(-\d+)?$/;
const URL_RE = /^https?:\/\/\S+$/i;
const TOP_KEYS = ['type', 'version', 'project', 'batch', 'createdAt', 'shots', 'extra', 'reviewedAt', 'reworkId'];
const SHOT_KEYS = ['lines', 'label', 'need', 'cands', 'extra'];
// review：分镜台写回的审核结果
const CAND_KEYS = [
  'key',
  'for',
  'title',
  'url',
  'page',
  'in',
  'out',
  'best',
  'license',
  'why',
  'limitations',
  'short',
  'extra',
  'review',
];
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
   同一个长视频里不重叠的两段可以分别配两处；同一画面里给同一句（for 有重叠）的几段互为候选，之间不算重复
   （同一画面里配给不重叠的两处在 validateCandidateDoc 里单独查） */
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
const forText = f => (f.from === f.to ? `第 ${f.from} 句` : `第 ${f.from}–${f.to} 句`);
export function validateCandidateDoc(doc) {
  const errs = [];
  const add = (where, msg) => errs.push(where ? `${where}：${msg}` : msg);
  const unknown = (obj, keys, where) => {
    for (const k of Object.keys(obj))
      if (!keys.includes(k)) add(where, `不认识的字段「${k}」（规范外的内容请放进 extra）`);
  };
  if (!isObj(doc)) return ['文件内容不是一个 JSON 对象'];
  if (doc.type !== CANDIDATE_TYPE) add('顶层', `type 必须是 "${CANDIDATE_TYPE}"`);
  if (doc.version !== CANDIDATE_VERSION) {
    const old = [1, 2, 3, '1', '2', '3'].includes(doc.version);
    add(
      '顶层',
      `version 必须是数字 ${CANDIDATE_VERSION}${old ? `（这是旧格式 version ${doc.version}，已经不再支持：请按 v${CANDIDATE_VERSION} 规范重写，不再有 plans，每段视频用 for 写明给哪几句）` : ''}`,
    );
    if (old) return errs;
  }
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
      if (shotLines.has(s.lines)) add(sw, '同一画面只能写一次，这个画面的视频都放在它的 cands 里');
      shotLines.add(s.lines);
    }
    if (!filled(s.label)) add(sw, 'label 必须写这个画面的简短名字');
    if (s.need != null && typeof s.need !== 'string') add(sw, 'need 必须是文字');
    unknown(s, [...SHOT_KEYS, 'plans'], sw); // plans 下面单独说清楚
    if (s.plans != null) add(sw, 'v4 不再有 plans：视频直接写在这个画面的 cands 里，每段用 for 写明给哪几句');
    if (!Array.isArray(s.cands) || !s.cands.length) return add(sw, 'cands 必须是数组，至少一个视频');
    const keys = new Set();
    s.cands.forEach((c, j) => {
      const cw = `${sw} cands[${j}]${isObj(c) && filled(c.key) ? `（key "${c.key}"）` : ''}`;
      if (!isObj(c)) return add(cw, '必须是对象');
      if (!filled(c.key)) add(cw, 'key 必须写');
      else if (keys.has(c.key)) add(cw, `key "${c.key}" 在这个画面里重复了`);
      else keys.add(c.key);
      if (typeof c.for !== 'string' || !LINES_RE.test(c.for))
        add(
          cw,
          `for 必须写这段视频给哪几句，文字句号：给一句写 "${span ? span.from : 251}"，给整个画面写 "${s.lines || '251-252'}"（半角减号，不加空格）`,
        );
      else if (span) {
        const f = spanOf(c.for);
        if (f.to < f.from || f.from < span.from || f.to > span.to)
          add(cw, `for "${c.for}" 必须在这个画面的 lines "${s.lines}" 范围内（连续的几句）`);
      }
      if (!filled(c.title)) add(cw, 'title 必须写中文标题');
      const local = localVideoPath(c.url); // 这台电脑上的视频文件（自己截好的片段，自己审）
      if (!local && (typeof c.url !== 'string' || !URL_RE.test(c.url)))
        add(
          cw,
          'url 必须是能直接播放的视频文件地址（http / https），或这台电脑上视频文件的完整路径（如 "/Users/me/素材/第12句.mp4"）',
        );
      else if (!local && videoUrlIssue(c.url)) add(cw, videoUrlIssue(c.url));
      if (c.page != null && (typeof c.page !== 'string' || !URL_RE.test(c.page)))
        add(cw, 'page 必须是网页地址（http / https）');
      if (!isNum(c.in) || c.in < 0) add(cw, 'in 必须是秒数（数字，≥ 0），不要写 "1:41" 或带引号');
      if (!isNum(c.out)) add(cw, 'out 必须是秒数（数字），不要写 "1:41" 或带引号');
      else if (isNum(c.in) && c.out <= c.in) add(cw, 'out 必须大于 in');
      if (c.best == null) add(cw, 'best 必须写：{ "in": 秒数, "out": 秒数 }，这段里真正要用的那几秒');
      else {
        const b = c.best;
        if (!isObj(b) || !isNum(b.in) || !isNum(b.out) || Object.keys(b).some(k => k !== 'in' && k !== 'out'))
          add(cw, 'best 必须写成 { "in": 秒数, "out": 秒数 }（数字），不要写别的字段');
        else if (b.out <= b.in) add(cw, 'best 的 out 必须大于 in');
        else if (isNum(c.in) && isNum(c.out) && (b.in < c.in - 0.01 || b.out > c.out + 0.01))
          add(cw, `best（${b.in}–${b.out}）必须在 in–out（${c.in}–${c.out}）范围内`);
        else if (isNum(c.in) && isNum(c.out) && (b.in - c.in > MARGIN_MAX + 0.01 || c.out - b.out > MARGIN_MAX + 0.01))
          add(
            cw,
            `下载范围 in–out（${c.in}–${c.out}）比 best（${b.in}–${b.out}）宽太多：每边最多宽 ${MARGIN_MAX} 秒，请把 in / out 收窄到 best 前后 1–3 秒`,
          );
      }
      if (!filled(c.license)) add(cw, 'license 必须写版权情况（不清楚就写「版权未核实」）');
      if (!filled(c.why)) add(cw, 'why 必须写为什么选它、画面里看到了什么');
      if (c.limitations != null && typeof c.limitations !== 'string') add(cw, 'limitations 必须是文字');
      if (c.short != null && typeof c.short !== 'string') add(cw, 'short 必须是文字');
      unknown(c, CAND_KEYS, cw);
    });
    // 同一个画面里，同一段画面配给了不重叠的两处：成片里同一个镜头会出现两遍。给同一句（for 有重叠）的互为候选，可以
    const live = s.cands
      .filter(c => usableCand(c) && typeof c.for === 'string' && LINES_RE.test(c.for))
      .filter(c => !dropped(c.review?.decision));
    live.forEach((a, k) => {
      for (const b of live.slice(k + 1)) {
        const fa = spanOf(a.for),
          fb = spanOf(b.for);
        if (Math.min(fa.to, fb.to) >= Math.max(fa.from, fb.from)) continue;
        if (footageOverlap(a, b))
          add(
            '重复画面',
            `lines "${s.lines}" 里 key "${a.key}"（${forText(fa)}，${spanText(a)}）和 key "${b.key}"（${forText(fb)}，${spanText(b)}）是同一个视频里同一段画面，配给了不同的句子，成片里会出现两遍`,
          );
      }
    });
  });
  // 同一份清单里，同一段画面配给了不同的画面：每一对都指出来
  const used = doc.shots.flatMap(s =>
    isObj(s) && Array.isArray(s.cands)
      ? s.cands.filter(usableCand).map(c => ({ ...c, rowId: s.lines, decision: c.review?.decision }))
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

/* 候选清单 → 候选记录（按当前句号找到画面；找不到的列进 skipped）。
   每条记录带 forText（清单里写的 for）、forIds（for 那几句的句子 id，改稿后照样认得）、seq（在清单里的先后）、short（不够长的理由）。
   tl：口播时间轴（界面传进来）；给了才检查「每段视频够它那几句的长度」 */
export function planImport(doc, srcFile, rows, existing = [], { tl, reworkRequests = {}, reworkRowIds = [] } = {}) {
  if (!doc || doc.type !== CANDIDATE_TYPE) return { error: '这不是视频候选清单' };
  const errors = validateCandidateDoc(doc);
  if (errors.length) return { error: `候选清单格式不对（${errors.length} 处）`, errors };
  const scopeErrors = reworkScopeErrors(doc, rows, reworkRequests);
  if (scopeErrors.length) return { error: '返工素材与返工单不一致', errors: scopeErrors };
  const byNo = new Map(rows.filter(r => r.kind === 'line').map(r => [r.no, r]));
  // 画面范围必须和分镜表一模一样
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
  const added = [],
    updated = [],
    skipped = [];
  const fresh = []; // 新加的、改过的视频：只查这些够不够长
  for (const s of doc.shots) {
    const range = parseLines(s.lines);
    const row = range && byNo.get(range.from);
    const members = row ? shotMembers(rows, row) : [];
    s.cands.forEach((raw, seq) => {
      const url = localVideoPath(raw.url) || String(raw.url || '').trim();
      const tin = parseClock(raw.in),
        tout = parseClock(raw.out);
      if (!row || !isCandidateSource(url) || !(tout > tin)) {
        skipped.push(`${s.lines || '?'} ${raw.key || ''}`.trim());
        return;
      }
      const f = parseLines(raw.for);
      const forIds = members.filter(m => m.no >= f.from && m.no <= f.to).map(m => m.id);
      const base = {
        key: String(raw.key || ''),
        lines: String(s.lines),
        forText: String(raw.for),
        forIds,
        label: String(s.label || ''),
        rowId: row.id,
        seq, // 在清单里的先后：同一句的几个候选按这个顺序编号
        short: String(raw.short || '').trim(), // 不够它那几句长时写的理由
        title: String(raw.title || assetName(url)),
        url,
        page: String(raw.page || ''),
        in: tin,
        out: tout,
        best: cleanBest(raw.best, tin, tout), // 精选段：通过时预填成「可用片段」
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
        const changed = candidateChanged(old, base);
        // 链接、片段或给哪几句变了：回到待审，旧的素材关联 / 已保存状态都作废（旧文件留在磁盘上，不删）
        const next = { ...old, ...base, ...(changed ? { decision: '', note: old.note || '' } : {}) };
        if (changed) {
          delete next.assetId;
          delete next.savedPath;
          delete next.decidedAt;
          fresh.push({ rec: next, members, shot: s });
        }
        updated.push({ old, next, changed });
      } else if (raw.review?.decision === 'no') {
        // 以前已经标成「不要」、被清掉的：同一份清单再导入时不让它回来
        return;
      } else {
        const rec = { id: 'vc-' + crypto.randomUUID(), ...base, decision: '', note: raw.review?.note || '' };
        added.push(rec);
        fresh.push({ rec, members, shot: s });
      }
    });
  }
  // 已交出去的返工任务不能通过删掉标记绕过范围检查；原清单的未改候选仍可重导。
  if (!doc.reworkId) {
    const pending = new Set(reworkRowIds);
    const issued = new Set(Object.values(reworkRequests).flatMap(r => r.targets.flatMap(t => t.rowIds)));
    if (fresh.some(x => pending.has(x.rec.rowId) && issued.has(x.rec.rowId)))
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
    fresh.map(x => x.rec), // 没改过的候选本来就在项目里，不重新追究
    others,
    rows,
  );
  if (dupes.length) return { error: `候选清单里有重复画面（${dupes.length} 处）`, errors: dupes };
  if (tl) {
    const short = shortErrors(fresh, tl);
    if (short.length) return { error: `候选清单里有视频不够它那几句的长度（${short.length} 处）`, errors: short };
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

/* 这段视频给的那几句要多长（秒，含句间停顿）；不知道时间返回 null */
export function forSeconds(c, members, tl) {
  const idx = members.map((m, i) => (c.forIds?.includes(m.id) ? i : -1)).filter(i => i >= 0);
  if (!idx.length) return null;
  const span = shotSpan(
    tl,
    members.map(m => m.id),
  );
  const w = forWindow(members, tl.times, idx[0], idx[idx.length - 1], span?.end);
  return w ? w.end - w.start : null;
}
/* 每段视频的 best 要够它那几句的长度（差 FILL_EPS 以内算够）；实在找不到够长的，必须在 short 里写明理由 */
function shortErrors(list, tl) {
  const errs = [];
  for (const { rec, members } of list) {
    const need = forSeconds(rec, members, tl);
    if (!(need > 0) || rec.short) continue;
    const have = usableSeconds(rec);
    if (have + FILL_EPS >= need) continue;
    const where =
      rec.forIds.length === members.length && members.length > 1
        ? `第 ${rec.lines.replace('-', '–')} 句整段`
        : `第 ${rec.forText.replace('-', '–')} 句`;
    errs.push(
      `lines "${rec.lines}" 的 key "${rec.key}"（for "${rec.forText}"）：best 只有 ${sec1(have)} 秒，${where}要 ${sec1(need)} 秒（含句间停顿），还差 ${sec1(need - have)} 秒。请换够长的视频；实在找不到，在这段视频的 short 里写明缺了什么、为什么找不到`,
    );
  }
  return errs;
}

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
    if (!isCandidateSource(url) || !(tout > tin)) continue;
    const rowId = idMap.has(raw.rowId) ? idMap.get(raw.rowId) : raw.rowId;
    if (!rowIds.has(rowId)) continue;
    // v4 起每个候选都记着给哪几句；没有的是旧格式导入的候选，不再保留（已通过挂上的素材留在表格里）
    if (!Array.isArray(raw.forIds) || !raw.forIds.length) continue;
    const forIds = raw.forIds.map(id => (idMap.has(id) ? idMap.get(id) : id)).filter(id => rowIds.has(id));
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
      forText: String(raw.forText || ''),
      forIds,
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

/* 表格里当主画面的素材（写回时据此标出哪些通过的视频正在正片轨上用） */
export function mainAssetIds(rows) {
  const out = new Set();
  for (const r of rows || [])
    if (r.kind === 'line') for (const u of usageList(r)) if (u.role === 'main' && !u.off) out.add(u.assetId);
  return out;
}
/* 写回候选清单的内容：每个来源文件一份。inUse：素材 id 集合，通过的视频在里面 = 它正在正片轨上用 */
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
