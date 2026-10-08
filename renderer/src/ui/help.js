/* 快捷键与帮助（⌘/）：分组列出，类型键位按本项目的类型表生成 */
import { types } from '../app/state.js';
import { esc } from './dom.js';
import { registerCommand } from './commands.js';

const $ = s => document.querySelector(s);
const k = s =>
  s
    .split(' ')
    .map(x => `<kbd>${x}</kbd>`)
    .join(' ');

function groups() {
  const n = types().list.length;
  return [
    [
      '标注',
      [
        [
          k(`1–${n}`),
          types()
            .list.map((t, i) => `${i + 1} ${esc(t.label)}`)
            .join(' · '),
        ],
        [k('0') + ' / ' + k('⌫'), '清除标注（不删句子）'],
        [k('⌘⌫'), '删除句子（可撤销）'],
        [k('⌘E'), '专注标注：一次一句，标完自动下一句，R 重复上一个类型'],
        ['筛选条右边「类型…」', '改名字、颜色、快捷键，增删类型'],
        ['勾选几句后底部操作条的类型按钮', '鼠标批量标注（也可以直接按数字键）'],
        [k('⇧⌘E'), '导出 PDF 分镜脚本'],
      ],
    ],
    [
      '选择与编辑',
      [
        [k('↑ ↓'), '切换句子'],
        ['Shift 点选 / 拖选', '连续多选'],
        ['⌘ 点选', '不连续多选（表格）'],
        ['双击正文', '改字；Enter 句尾插新句、句中拆分；句首 ⌫ 并回上一句'],
        [k('Enter'), '跳到这句的画面描述'],
        ['选中连续几句 → 共用一个画面', '口播逐句保留，类型、画面描述、素材共用；选中组里任意一句，整组一起框住'],
        [k('Esc'), '取消勾选'],
      ],
    ],
    [
      '口播与时间',
      [
        [k('空格'), '播放 / 暂停口播（导入口播音频后）'],
        ['点表格里的时间码', '从这句开始播'],
        ['口播条「连播预览」', '口播接着播，画面按镜头自动切换'],
        ['导入 → 对齐剪映字幕', '剪映导出 SRT 后每句换成精确时间（也可以把 SRT 拖进窗口，⇧⌘O）'],
        ['把音频拖到顶部节奏色条', '设为口播音频'],
      ],
    ],
    [
      '素材',
      [
        ['从访达拖到句子 / 共用画面 / 右侧面板', '关联素材（txt、md 当素材请拖到右侧面板）'],
        ['视频预览里 ' + k('空格') + ' ' + k('I') + ' ' + k('O'), '播放、设入点 / 出点；← → 前后 1 秒'],
        ['面板里每个素材：主画面 / 叠加 / 备选', '一段可以有多个主画面，按时间先后编号 ①②③；备选不进素材清单和 PDF'],
        ['「对着口播看画面」里的画面时间轨', '拖色块或按 I / O 调每个主画面出现的秒数'],
        ['把视频候选清单（.json）拖进窗口', '打开视频审核：看截图、播建议片段、通过 / 不要 / 换一个'],
      ],
    ],
    [
      '其它',
      [
        [k('⌘F'), '搜索句子或画面描述'],
        [k('⌘Z') + ' / ' + k('⇧⌘Z'), '撤销 / 重做'],
        [k('⌘T'), '表格 / 审核'],
        [k('⇧⌘D'), '紧凑行距（长稿一屏看更多句）'],
        [k('⌘L'), '切换主题'],
        ['导出 → 交稿检查', '看分镜方案是否齐全；勾选后也检查素材交付'],
        [k('⌘+') + ' / ' + k('⌘−'), '缩放'],
        ['把 MD / TXT / Word / 项目 JSON 拖进窗口', '导入稿子'],
      ],
    ],
  ];
}

export function openHelp() {
  $('#helpBody').innerHTML = groups()
    .map(
      ([title, items]) =>
        `<section><h4>${title}</h4>${items.map(([a, b]) => `<div class="help-row"><span>${a}</span><span>${b}</span></div>`).join('')}</section>`,
    )
    .join('');
  $('#helpMask').classList.add('show');
}

export function initHelp() {
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div class="modal-mask" id="helpMask"><div class="modal wide help-modal"><h3>快捷键与帮助</h3><div id="helpBody" class="help-grid"></div><div class="m-btns"><button class="btn primary" id="helpClose">知道了</button></div></div></div>`,
  );
  registerCommand('help:open', openHelp);
  $('#btnHelp').onclick = openHelp;
  $('#helpClose').onclick = () => $('#helpMask').classList.remove('show');
  $('#helpMask').addEventListener('click', e => {
    if (e.target.id === 'helpMask') $('#helpMask').classList.remove('show');
  });
}
