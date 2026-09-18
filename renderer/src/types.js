/* 类型定义：五类标注 + 筛选，全应用共用（勾选视图与表格视图同一套） */
export const ICON = {
  a:    '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="7.2" r="3.6"/><path d="M12 12.6c-4 0-7.5 2.1-7.5 4.9V19h15v-1.5c0-2.8-3.5-4.9-7.5-4.9Z"/></svg>',
  real: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 6h11a1 1 0 0 1 1 1v2.3l4.4-2.6a.55.55 0 0 1 .8.5v9.6a.55.55 0 0 1-.8.5L16 14.7V17a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Z"/></svg>',
  stock:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/></svg>',
  ai:   '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.5 14 9l6.5 2-6.5 2-2 6.5-2-6.5L3.5 11 10 9l2-6.5Z"/><path d="M19 15.5 19.8 18l2.5.8-2.5.8-.8 2.4-.8-2.4-2.5-.8 2.5-.8.8-2.5Z"/></svg>',
  fx:   '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13.2 2.2 4.5 13.4c-.3.4 0 .9.5.9h5l-1.3 7.3c-.1.5.6.8.9.4l8.7-11.2c.3-.4 0-.9-.5-.9h-5l1.3-7.3c.1-.5-.6-.8-.9-.4Z"/></svg>',
};

export const TYPES = {
  a:    {label:'A roll',       full:'A roll · 真人出镜',  cls:'t-a',    ocls:'c-a',    color:'var(--c-a)',    icon:ICON.a},
  real: {label:'真实素材',     full:'B roll · 真实素材',  cls:'t-real', ocls:'c-real', color:'var(--c-real)', icon:ICON.real},
  stock:{label:'通用素材',     full:'B roll · 通用素材',  cls:'t-stock',ocls:'c-stock',color:'var(--c-stock)',icon:ICON.stock},
  ai:   {label:'AI 动画',      full:'B roll · AI 动画',   cls:'t-ai',   ocls:'c-ai',   color:'var(--c-ai)',   icon:ICON.ai},
  fx:   {label:'结构特效',     full:'B roll · 结构特效',  cls:'t-fx',   ocls:'c-fx',   color:'var(--c-fx)',   icon:ICON.fx},
};
export const TYPE_ORDER = ['a','real','stock','ai','fx'];
export const KEY2TYPE = {'1':'a','2':'real','3':'stock','4':'ai','5':'fx','0':null};

export const FILTERS = [
  {id:'all',   label:'全部',      color:'#8a93a6'},
  {id:'a',     label:'A roll',    color:'var(--c-a)'},
  {id:'real',  label:'真实素材',  color:'var(--c-real)'},
  {id:'stock', label:'通用素材',  color:'var(--c-stock)'},
  {id:'ai',    label:'AI 动画',   color:'var(--c-ai)'},
  {id:'fx',    label:'结构特效',  color:'var(--c-fx)'},
  {id:'none',  label:'未标注',    color:'#8a93a6'},
];
