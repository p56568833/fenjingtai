/* 通用小工具：时长估算 / 转义 / toast / 确认弹窗 */
export const dur = t => { const n = ((t||'').match(/[\u4e00-\u9fa5A-Za-z0-9]/g)||[]).length; return (n/4.5).toFixed(1)+'s'; };
export const durNum = t => (t.match(/[\u4e00-\u9fa5A-Za-z0-9]/g)||[]).length/4.5;
export const esc = s => String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
/* 搜索命中加 <mark> 高亮（表格/总览共用，q 已确保非空且命中） */
export const hiText = (t,q)=>{
  const i = t.toLowerCase().indexOf(q.toLowerCase());
  if(i<0) return esc(t);
  return esc(t.slice(0,i)) + '<mark>' + esc(t.slice(i,i+q.length)) + '</mark>' + esc(t.slice(i+q.length));
};

/* 中文输入法正在组合中（打拼音未上屏）时，按键不该触发任何命令 */
export const composing = e => e.isComposing || e.keyCode === 229;

/* toast：相同内容 2 秒内重复触发只重置计时，不重放动画（连续合并不吵） */
export function toast(msg, action){
  const t = document.querySelector('#toast'), act = document.querySelector('#toastAct');
  const repeat = t._msg === msg && Date.now() - (t._at||0) < 2000;
  t._msg = msg; t._at = Date.now();
  document.querySelector('#toastTxt').textContent = msg;
  t._action = action || null;
  act.style.display = action ? '' : 'none';
  if(action) act.textContent = action.label;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(()=>t.classList.remove('show'), action?6000:2200);
}

let modalCb = null;
export function confirmModal(title, body, okText, cb){
  document.querySelector('#mTitle').textContent = title;
  document.querySelector('#mBody').textContent = body;
  document.querySelector('#mOk').textContent = okText;
  document.querySelector('#modalMask').classList.add('show');
  modalCb = cb;
}
export function initModal(){
  const mask = document.querySelector('#modalMask');
  document.querySelector('#mCancel').onclick = ()=> mask.classList.remove('show');
  document.querySelector('#mOk').onclick = ()=>{ mask.classList.remove('show'); modalCb && modalCb(); };
  mask.addEventListener('click', e=>{ if(e.target===mask) mask.classList.remove('show'); });   // 点遮罩=取消
}
