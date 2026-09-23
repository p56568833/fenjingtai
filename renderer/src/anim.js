/* 入场动画开关：切视图/导入/切项目时 arm，渲染一次后自动熄火 */
let armed = true;
export const armAnimation = () => {
  armed = true;
};
export const takeAnimation = () => {
  const v = armed;
  armed = false;
  return v;
};
