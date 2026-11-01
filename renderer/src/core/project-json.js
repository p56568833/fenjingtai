import { projectData } from './project-data.js';

/* 项目 JSON（v4）：项目里的全部数据——句子、素材库、类型、字幕、口播、视频候选（含审核结果与批次）、片段保存位置。
   本地素材只记路径，不含文件本身；换电脑后路径对不上的素材会显示「文件失联」，可以重新定位 */
export function buildProjectJson(project) {
  return JSON.stringify(
    {
      v: 4,
      ...projectData(project, 'exchange'),
      savedAt: new Date().toISOString(),
    },
    null,
    2,
  );
}
