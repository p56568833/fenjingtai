import { reduced } from './motion.js';

/* 入场动画开关：切视图/导入/切项目时 arm，渲染一次后自动熄火 */
let armed = true;
export const armAnimation = () => {
  armed = true;
};
export const animationArmed = () => armed;
export const takeAnimation = () => {
  const v = armed;
  armed = false;
  return v;
};

/* 切视图时整块轻轻滑进来（dir = -1 从左边、1 从右边）；系统开了「减少动态效果」就不动 */
export function slideIn(el, dir = 1, dist = 22) {
  if (!el || reduced() || typeof el.animate !== 'function') return;
  el.animate(
    [
      { opacity: 0, transform: `translateX(${dir * dist}px)` },
      { opacity: 1, transform: 'none' },
    ],
    { duration: 340, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
  );
}
