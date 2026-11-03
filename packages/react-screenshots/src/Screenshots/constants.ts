/**
 * 单击与拖拽的分界（DIP）。
 *
 * 鼠标/触控板按下瞬间几乎都会有 1~3px 的抖动，浏览器会把它如实报成 pointermove。
 * 只要位移没越过这个阈值就仍然按"单击"处理，否则"单击确认高亮的窗口"会变成
 * 一个 1px 的点，拖框也会在手抖时被误触发。4 是各家截图工具的常见取值：
 * 足够盖住抖动，又不会让真正的微调拖拽失灵。
 */
export const CLICK_SLOP = 4;

/** 两个点之间的距离是否还在单击容差内 */
export function isWithinClickSlop(
  a: { x: number; y: number },
  b: { x: number; y: number }
): boolean {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy <= CLICK_SLOP * CLICK_SLOP;
}
