/* 导入解析：整篇口播稿 → rows；带批注 MD → rows（类型和备注一起恢复） */
import { TYPES, TYPE_ORDER } from './types.js';

let uid = 0;
const nid = () => ++uid;

/* 老版本把「## 章节」行错存成了普通句子，载入时自动转回章节 */
export function migrateSections(rows){
  for(const r of rows){
    if(r.kind==='line' && /^(#{1,6}\s+.*|【[^】]+】)$/.test((r.text||'').trim())){
      r.kind = 'section';
      r.text = r.text.trim().replace(/^#{1,6}\s*/,'').replace(/[【】]/g,'').trim();
      delete r.note; delete r.type; delete r.para;
    }
  }
  return rows;
}

/* 按标点分句，【】/# 开头识别为章节；每个源行的第一句打 para 标记，
   勾选视图靠它把句子还原成原来的段落排版 */
export function parseScript(text){
  const rows = [];
  for(const raw of text.split(/\r?\n/)){
    const line = raw.trim();
    if(!line) continue;
    if(/^#{1,6}\s+.+/.test(line) || /^【.+】$/.test(line)){
      rows.push({id:nid(), kind:'section', text:line.replace(/^#{1,6}\s*/,'').replace(/[【】]/g,'').trim()});
      continue;
    }
    const parts = line.split(/(?<=[。！？；!?…])/).map(s=>s.trim()).filter(Boolean);
    parts.forEach((p, i)=> rows.push({id:nid(), kind:'line', text:p, note:'', type:null, para: i===0}));
  }
  return rows;
}

/* 带批注 MD（本软件导出的格式）：
   - [A roll · 真人出镜] 句子（备注：…）
   - [B roll · 真实素材] 句子（画面：…）
   章节行 ## xxx，标题 # xxx。检测到该格式时返回 rows，否则 null 走普通分句。 */
export function parseAnnotatedMd(text){
  const lines = text.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  const itemRe = /^-\s*\[(.+?)\]\s*(.+)$/;
  const hits = lines.filter(l=>itemRe.test(l)).length;
  if(hits < 3) return null;                      // 不像批注稿，按普通文本处理

  const name2type = {};
  TYPE_ORDER.forEach(k=>{ name2type[TYPES[k].full] = k; name2type[TYPES[k].label] = k; });
  name2type['未标注'] = null;

  const rows = [];
  for(const line of lines){
    const m = line.match(itemRe);
    if(m){
      const type = name2type[m[1].trim()];
      if(type === undefined) continue;           // 方括号不是已知类型，跳过这行（可能是普通 MD 列表）
      let body = m[2];
      let note = '';
      const nm = body.match(/（(画面|备注)：(.*)）\s*$/);
      if(nm){ note = nm[2].trim(); body = body.slice(0, nm.index); }
      rows.push({id:nid(), kind:'line', text: body.trim(), note, type: type??null, para: true});   // 批注稿一行一句，各自成段
      continue;
    }
    if(/^#\s+.+/.test(line)) continue;           // 一级大标题（文档名），不进正文
    if(/^#{2,6}\s+.+/.test(line) || /^【.+】$/.test(line)){
      rows.push({id:nid(), kind:'section', text:line.replace(/^#{2,6}\s*/,'').replace(/[【】]/g,'').trim()});
      continue;
    }
    // 普通文本行：照旧分句
    line.split(/(?<=[。！？；!?…])/).map(s=>s.trim()).filter(Boolean)
      .forEach((p, i)=> rows.push({id:nid(), kind:'line', text:p, note:'', type:null, para: i===0}));
  }
  return rows;
}

/* 统一入口：智能判断用哪种解析 */
export function parseAny(text){
  return migrateSections(parseAnnotatedMd(text) || parseScript(text));
}
