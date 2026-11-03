import type { Bounds } from './types';

/**
 * 把选区对齐到**设备像素**网格。
 *
 * 光标的 `clientX/clientY` 是小数（Retina 上实测 `497.03125` 这种值很常见），
 * 直接拿来算选区的话，`translate()`、`width`、`height` 全都是小数：
 *
 * - 画布里是「外层 translate(+bounds) + 内层图片 translate(-bounds)」两层合成，
 *   两个小数位移在合成器里各自对齐设备像素，取整方向不一定相同，
 *   于是图片内容相对选区边框每帧差 1px —— 拖动时看到的就是"框里的画面在抖"；
 * - 底图是原生像素、按 DIP 缩放显示的，亚像素位移会让采样网格每帧错位，
 *   配上 `image-rendering: crisp-edges` 就是整块画面在闪。
 *
 * 对齐到 1/dpr 之后，两层位移都正好落在设备像素上，采样网格不再变，
 * 画面和边框一起稳住；导出的裁剪也刚好落在像素边界上（`composeImage` 里
 * 是 `Math.round` 取的源矩形，小数会让它和预览差 1px）。
 *
 * 注意四边都要对齐：只对齐 x/y 的话，`width` 的零头会留在右边，
 * 右/下边框照样落在半像素上。
 */
export default function quantizeBounds(
  bounds: Bounds,
  dpr: number = typeof window === 'undefined' ? 1 : window.devicePixelRatio,
): Bounds {
  const ratio = dpr > 0 ? dpr : 1;
  const snap = (value: number) => Math.round(value * ratio) / ratio;

  const x = snap(bounds.x);
  const y = snap(bounds.y);
  const right = snap(bounds.x + bounds.width);
  const bottom = snap(bounds.y + bounds.height);
  // 至少要留一个设备像素，否则选区会变成一条线
  const min = 1 / ratio;

  return {
    x,
    y,
    width: Math.max(right - x, min),
    height: Math.max(bottom - y, min),
  };
}
