/* 当前项目的数据容器；查询、加载、搜索和选区由各自模块负责。
   业务修改必须通过 project-change.js 提交。 */
import { projectData } from '../core/project-data.js';
export const state = {
  // 当前项目
  projectId: null,
  ...projectData({}),
};
