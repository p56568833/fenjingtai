/* 协作中的紧凑菜单：位置常显，连接、文件名和名字编辑按需展开。 */
import { state } from '../app/state.js';
import * as collab from '../app/collab.js';
import { esc } from '../ui/base/dom.js';

const icon = paths => `<svg class="mi" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
const arrow = icon('<path d="m9 5 7 7-7 7"/>');
const link = icon('<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2"/>');
const file = icon('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>');
const person = icon('<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>');
const stop = icon('<circle cx="12" cy="12" r="9"/><path d="M9 9h6v6H9Z"/>');

/* 句号按稿子顺序计算，不把内部行 id 当成句号，也不显示口播原文。 */
export function peerLocation() {
  const peer = collab.peerHere();
  if (!peer) return null;
  let chapter = '',
    number = 0;
  for (const row of state.rows) {
    if (row.kind === 'section') chapter = row.text || '未命名章节';
    else if (row.kind === 'line') number++;
    if (row.id !== peer.sel) continue;
    return {
      id: row.id,
      label: row.kind === 'line' ? `${chapter ? chapter + ' · ' : ''}第 ${number} 句` : chapter,
    };
  }
  return null;
}

function connectionSection(st, cur, expanded) {
  const addresses =
    cur.role === 'host'
      ? (st.hostInfo?.addresses || []).map(a =>
          st.hostInfo.port && st.hostInfo.port !== 47391 ? `${a}:${st.hostInfo.port}` : a,
        )
      : cur.hostAddress
        ? [cur.hostAddress]
        : [];
  const summary = addresses[0] || (cur.role === 'host' ? '配对码 ' + (cur.code || '') : '连接详情');
  const addressRows = addresses
    .map(
      address =>
        `<div class="cl-menu-info"><span>${cur.role === 'host' ? '本机地址' : '主机地址'}</span><code>${esc(address)}</code><button class="text-button" data-cl="copyaddress" data-value="${esc(address)}">复制</button></div>`,
    )
    .join('');
  const codeRow =
    cur.role === 'host'
      ? `<div class="cl-menu-info"><span>配对码</span><code>${esc(cur.code || '')}</code><button class="text-button" data-cl="copycode">复制</button><button class="text-button" data-cl="newcode">换一个</button></div><small>让对方在「协作」里选这个项目，输入 4 位配对码；用过后自动换新。</small>`
      : cur.status === 'needs-code'
        ? `<div class="cl-join-row"><input id="collabCode" inputmode="numeric" maxlength="4" placeholder="4 位配对码" autocomplete="off"><button class="btn primary" data-cl="repair">重新加入</button></div><small>请对方查看新的配对码。</small>`
        : `<small>断线期间的改动先保存在本机，连上后自动同步；视频片段各存各的电脑。</small>`;
  return `<button class="pop-item cl-menu-row" data-cl="connections" aria-expanded="${expanded.connections}" aria-controls="collabMenuConnection">${link}<span>连接与配对</span><span class="cl-menu-end"><code title="${esc(addresses.join('、'))}">${esc(summary)}</code>${arrow}</span></button>
    <div id="collabMenuConnection" class="cl-menu-details" ${expanded.connections ? '' : 'hidden'}>${addressRows}${addresses.length && cur.role === 'host' ? '<small>找不到项目时，让对方点「输入地址」填写。</small>' : ''}${codeRow}</div>`;
}

function filesSection(cur, missing, expanded) {
  const job = collab.fileProgress(),
    find = collab.findProgress();
  if (job || find) {
    const pct = job?.size ? Math.min(100, Math.floor((job.done / job.size) * 100)) : 0;
    const text = find
      ? find.phase === 'info'
        ? '正在获取文件信息…'
        : `正在本机查找${find.scanned ? ` · 已看过 ${find.scanned} 个` : '…'}`
      : `正在取第 ${job.index} / ${job.total} 个${job.size ? ` · ${pct}%` : ''}`;
    return `<div class="cl-menu-transfer"><div><span>${text}</span>${job ? `<small title="${esc(job.name)}">${esc(job.name)}</small><div class="pack-bar"><div style="width:${pct}%"></div></div>` : ''}</div><button class="text-button" data-cl="${find ? 'cancelfind' : 'cancelfetch'}">取消</button></div>`;
  }
  const online = cur.status === 'online';
  const list = missing.map(m => `<li title="${esc(m.name)}">${esc(m.name)}</li>`).join('');
  return `<div class="cl-menu-files-row"><button class="pop-item cl-menu-row cl-menu-files-toggle" data-cl="files" aria-expanded="${expanded.files}" aria-controls="collabMenuFiles" ${missing.length ? '' : 'disabled'}>${file}<span>${missing.length ? `缺 ${missing.length} 个文件` : '文件已齐全'}</span>${missing.length ? `<span class="cl-menu-end">${arrow}</span>` : ''}</button>${missing.length ? `<button class="btn cl-menu-action" data-cl="fetchall" ${online ? '' : 'disabled'} title="${online ? '从对方电脑取回缺失文件' : '对方在线后可取回文件'}">全部取过来</button>` : ''}</div>
    <div id="collabMenuFiles" class="cl-menu-details" ${expanded.files && missing.length ? '' : 'hidden'}><ul class="cl-menu-file-list">${list}</ul>${!online ? '<small>对方在线后可查找和取回这些文件。</small>' : ''}<button class="text-button" data-cl="findin" ${online ? '' : 'disabled'}>在文件夹里找</button></div>`;
}

export function collabMenuHTML(missing, expanded) {
  const st = collab.collabState(),
    cur = st.current;
  if (!cur) return '';
  const who = cur.peer || cur.hostName || '等待同事加入';
  const location = peerLocation();
  const online = cur.status === 'online';
  const status = online
    ? '连接正常'
    : cur.status === 'connecting'
      ? '正在连接'
      : cur.status === 'needs-code'
        ? '需要配对码'
        : '等待对方上线';
  const position =
    location?.label ||
    (online
      ? '对方尚未选择句子'
      : cur.peer || cur.hostName
        ? '对方不在线，连上后自动同步'
        : '让同事在「协作」中加入这个项目');
  return `<div class="cl-menu" id="collabMenu">
    <div class="cl-menu-head"><span>${cur.role === 'host' ? '当前共享' : '当前协作'}</span><span class="cl-menu-status" data-status="${cur.status}"><i></i>${status}</span></div>
    <div class="pop-sep"></div>
    <section class="cl-menu-peer"><div class="cl-menu-label">对方当前位置</div><div class="cl-menu-person"><span class="cl-menu-avatar">${esc([...who][0] || '?')}</span><span class="cl-menu-peer-name">${esc(who)}</span><button class="btn cl-menu-action" data-cl="jump" ${location ? '' : 'disabled'}>跳转</button></div><div class="cl-menu-location${location ? ' located' : ''}" aria-live="polite">${esc(position)}</div></section>
    <div class="pop-sep"></div>
    ${connectionSection(st, cur, expanded)}
    ${filesSection(cur, missing, expanded)}
    <button class="pop-item cl-menu-row" data-cl="name" aria-expanded="${expanded.name}" aria-controls="collabMenuName">${person}<span>我的名字</span><span class="cl-menu-end"><span title="${esc(st.me.name)}">${esc(st.me.name)}</span>${icon('<path d="m16 3 5 5-13 13H3v-5Z"/>')}</span></button>
    <div id="collabMenuName" class="cl-menu-details" ${expanded.name ? '' : 'hidden'}><input id="collabName" maxlength="40" value="${esc(st.me.name)}" aria-label="我的名字" placeholder="对方看到的名字" autocomplete="off"></div>
    <div class="pop-sep"></div>
    <button class="pop-item cl-menu-row danger" data-cl="${cur.role === 'host' ? 'stop' : 'leave'}">${stop}${cur.role === 'host' ? '停止共享' : '退出协作'}</button>
  </div>`;
}
