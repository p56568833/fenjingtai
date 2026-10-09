/* 数据模型说明（只有类型注释，没有代码）。各模块的 JSDoc 用这里的名字。

   @typedef {'line'|'section'} RowKind

   @typedef {Object} Row  一行：一句口播或一个章节标题
   @property {number} id           项目内唯一，只增不复用
   @property {RowKind} kind
   @property {string} text
   @property {number} [no]          句号（渲染前 renumber 现算，不可靠存储）
   @property {string|null} [type]   标注类型 id（见 Project.types）
   @property {string} [note]        画面描述 / 备注，可多行
   @property {'todo'|'making'|'ready'} [status]  制作状态
   @property {string} [groupId]     共用画面编号：同一章节里连续几句共享 note/type/status/assetUsages
   @property {AssetUsage[]} [assetUsages]
   @property {string} [assets]      旧版素材文本镜像（一行一个路径），由 assetUsages 生成，仅为兼容
   @property {boolean} [para]       原稿换行处（原文视图分段用）
   @property {{start:number,end:number,conf:number,st:'ok'|'low'|'est'}} [time]  剪映字幕对齐结果（秒）

   @typedef {Object} AssetUsage  某个画面对某个素材的使用
   @property {string} assetId
   @property {{in:number,out:number,needsAdjust?:boolean}} [clip]  只用这一段（秒）

   @typedef {Object} Asset  项目素材库里的一个文件 / 链接（只记路径，不复制文件）
   @property {string} id
   @property {'image'|'video'|'audio'|'doc'|'link'} kind
   @property {string} path
   @property {string} name
   @property {number} [durationSec]

   @typedef {Object} TypeDef  标注类型（顺序 = 快捷键 1–9）
   @property {string} id
   @property {string} label
   @property {string} full
   @property {string} color   #rrggbb
   @property {string} icon    core/types.js ICONS 的键
   @property {boolean} visual 需要配画面

   @typedef {Object} Project
   @property {string} id
   @property {string} title
   @property {Row[]} rows
   @property {Object<string, Asset>} assets
   @property {TypeDef[]} [types]       没有时用默认五类
   @property {number} [speechRate]     字 / 秒
   @property {{name:string,at:number,duration:number,cues:Array}} [timing]  对齐用的剪映字幕
   @property {{path:string,name:string,duration:number|null}} [voice]       口播音频
   @property {number} [cursorId]
   @property {number} updatedAt

   @typedef {Object} Library  磁盘上的整个数据文件
   @property {2} v
   @property {string} currentId
   @property {Object<string, Project>} projects
   @property {{defaultTypes?: TypeDef[]}} [settings]
   @property {Object<string, {project: Project, deletedAt: number}>} [trash]  最近删除（30 天）
*/
export {};
