/* 标注类型模型（纯数据，无 DOM / 无应用状态）。
   每个项目自带一套类型（project.types），顺序即快捷键 1–9；老项目没有这个字段时沿用默认五类。
   类型字段：
     id      存进句子 r.type 的键（创建后不变，改名不影响已有标注）
     label   短名（筛选条、统计、清单用）
     full    全名（标注卡、表格类型格用）
     color   主色 #rrggbb（界面配色都由它派生）
     icon    图标键（见 ICONS）
     visual  需要配画面：交稿检查要求画面描述，统计已挂素材，素材清单里出现 */

export const ICONS = {
  person:
    '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="7.2" r="3.6"/><path d="M12 12.6c-4 0-7.5 2.1-7.5 4.9V19h15v-1.5c0-2.8-3.5-4.9-7.5-4.9Z"/></svg>',
  camera:
    '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 6h11a1 1 0 0 1 1 1v2.3l4.4-2.6a.55.55 0 0 1 .8.5v9.6a.55.55 0 0 1-.8.5L16 14.7V17a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Z"/></svg>',
  film: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/></svg>',
  sparkle:
    '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.5 14 9l6.5 2-6.5 2-2 6.5-2-6.5L3.5 11 10 9l2-6.5Z"/><path d="M19 15.5 19.8 18l2.5.8-2.5.8-.8 2.4-.8-2.4-2.5-.8 2.5-.8.8-2.5Z"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13.2 2.2 4.5 13.4c-.3.4 0 .9.5.9h5l-1.3 7.3c-.1.5.6.8.9.4l8.7-11.2c.3-.4 0-.9-.5-.9h-5l1.3-7.3c.1-.5-.6-.8-.9-.4Z"/></svg>',
  text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 6h14M12 6v13M9 19h6"/></svg>',
  image:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/></svg>',
  chart:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  dot: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="5"/></svg>',
};
export const ICON_KEYS = Object.keys(ICONS);

/* 新建类型时依次取的颜色（色相拉开，深浅两种主题下都分得清） */
export const PALETTE = [
  '#3b74e8',
  '#12945f',
  '#d9820b',
  '#7c4de8',
  '#e8502f',
  '#0e9aa7',
  '#c2378f',
  '#6b7a1f',
  '#8a5a2b',
  '#5b6b85',
];

export const MAX_TYPES = 9;

export const DEFAULT_TYPES = Object.freeze([
  { id: 'a', label: 'A roll', full: 'A roll · 真人出镜', color: '#3b74e8', icon: 'person', visual: false },
  { id: 'real', label: '真实素材', full: 'B roll · 真实素材', color: '#12945f', icon: 'camera', visual: true },
  { id: 'stock', label: '通用素材', full: 'B roll · 通用素材', color: '#d9820b', icon: 'film', visual: true },
  { id: 'ai', label: 'AI 动画', full: 'B roll · AI 动画', color: '#7c4de8', icon: 'sparkle', visual: true },
  { id: 'fx', label: '结构特效', full: 'B roll · 结构特效', color: '#e8502f', icon: 'bolt', visual: true },
]);

export const defaultTypes = () => DEFAULT_TYPES.map(t => ({ ...t }));

const HEX = /^#[0-9a-f]{6}$/i;
const ID = /^[a-z][a-z0-9_-]{0,23}$/i;

/* 读进来的类型表（项目文件 / 导入 / 编辑器）统一清洗：去重、补默认值、封顶 9 个；
   不合法或为空时退回默认五类，保证任何时候都有可用的类型 */
export function normalizeTypes(list) {
  if (!Array.isArray(list) || !list.length) return defaultTypes();
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const id = String(raw.id || '').trim();
    if (!ID.test(id) || seen.has(id) || id === 'none' || id === 'all') continue;
    const label =
      String(raw.label || '')
        .trim()
        .slice(0, 12) || id;
    seen.add(id);
    out.push({
      id,
      label,
      full:
        String(raw.full || '')
          .trim()
          .slice(0, 30) || label,
      color: HEX.test(raw.color) ? raw.color.toLowerCase() : PALETTE[out.length % PALETTE.length],
      icon: ICONS[raw.icon] ? raw.icon : 'dot',
      visual: raw.visual !== false,
    });
    if (out.length >= MAX_TYPES) break;
  }
  return out.length ? out : defaultTypes();
}

/* 生成新类型的 id：t1、t2…，避开已有 id */
export function newTypeId(types) {
  const ids = new Set(types.map(t => t.id));
  for (let n = 1; ; n++) if (!ids.has('t' + n)) return 't' + n;
}

/* 把类型表变成查询结构：byId / 快捷键 / 是否需要画面 */
export function typeIndex(types) {
  const list = normalizeTypes(types);
  const byId = new Map(list.map(t => [t.id, t]));
  return {
    list,
    byId,
    get: id => (id == null ? null : byId.get(id) || null),
    has: id => byId.has(id),
    /* 按键 '1'..'9' → 类型 id；'0' → null（清除） */
    keyToType: key => (key === '0' ? null : list[+key - 1]?.id),
    isTypeKey: key => key === '0' || (/^[1-9]$/.test(key) && +key <= list.length),
    /* 未知类型（比如从别的项目粘来的）按需要画面处理：宁可多提醒，也不漏 */
    needsVisual: id => (id == null ? false : byId.has(id) ? byId.get(id).visual : true),
    label: id => (id == null ? '未标注' : byId.get(id)?.label || '未知类型'),
    full: id => (id == null ? '未标注' : byId.get(id)?.full || '未知类型'),
    color: id => (id == null ? null : byId.get(id)?.color || '#8a93a6'),
  };
}

/* 删除类型前的影响面：有多少句用到 */
export const typeUsage = (rows, id) => rows.filter(r => r.kind === 'line' && r.type === id).length;
