import type { Bounds } from './types';

export interface SnapEdges {
  xs: number[];
  ys: number[];
}

/** 像素级阈值，和微信、Snipaste 的吸附手感基本一致 */
export const SNAP_THRESHOLD = 6;

/**
 * 把所有可吸附的边收集起来：屏幕四边 + 每个矩形的四边。
 * 调用方只传窗口的边（窗口数据不可用时才退回元素边），拖框时不会被碎框带偏。
 * 矩形列表为空时只剩屏幕四边，行为退化成"只能贴屏幕边"，不会拖慢拖框。
 */
export default function getSnapEdges(
  rects: Bounds[],
  width: number,
  height: number,
): SnapEdges {
  const xs = new Set<number>([0, width]);
  const ys = new Set<number>([0, height]);

  for (const win of rects) {
    xs.add(win.x);
    xs.add(win.x + win.width);
    ys.add(win.y);
    ys.add(win.y + win.height);
  }

  return {
    xs: [...xs].sort((a, b) => a - b),
    ys: [...ys].sort((a, b) => a - b),
  };
}

/** 命中阈值内返回吸附后的值，否则原样返回 */
export function snapToEdge(
  value: number,
  candidates: number[],
  exclude?: number,
): number {
  let best = Number.NaN;
  let bestDistance = SNAP_THRESHOLD + 1;

  for (const candidate of candidates) {
    if (candidate === exclude) {
      continue;
    }
    const distance = Math.abs(candidate - value);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }

  return Number.isNaN(best) ? value : best;
}

/**
 * 光标是否落在元素矩形内部。元素的两层拾取（邻域精修 / 整屏候选）共用这一个判定 ——
 * 边界点上口径不一样的话，同一像素会给出不同答案，hover 就会抖。
 * 窗口另有 `containsWindow`，原因见那里的注释。
 */
function contains(r: Bounds, x: number, y: number): boolean {
  return x > r.x && y > r.y && x < r.x + r.width && y < r.y + r.height;
}

/**
 * 窗口把边框那 1px 也算作自己的一部分：像素本来就是这个窗口的，
 * 按 `contains` 的口径光标压在边框上时窗口不算命中，元素矩形就会趁虚而入，
 * 表现为"窗口边缘冒出碎框"。右/下不取等，避免和紧邻的窗口抢同一列像素。
 */
function containsWindow(r: Bounds, x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height;
}

/**
 * 取光标所在窗口，列表已按 z 值从大到小排序，第一个命中的就是最上面的。
 */
export function getWindowAt(
  windows: Bounds[],
  x: number,
  y: number,
): Bounds | null {
  for (const win of windows) {
    if (containsWindow(win, x, y)) {
      return win;
    }
  }

  return null;
}

/**
 * hover 与单击要选中的矩形：**窗口优先**，光标不在任何系统窗口里时才拿元素矩形兜底。
 * 元素法只能看到露出来的那部分，被别的窗口压住的边界它检不出来，
 * 拿面积比大小的话整窗会只选中一半，所以有窗口数据时不再比较。
 */
export function getRectAt(
  windows: Bounds[],
  edges: Bounds[],
  x: number,
  y: number,
): Bounds | null {
  const win = getWindowAt(windows, x, y);
  if (win) {
    return win;
  }

  let best: Bounds | null = null;
  for (const edge of edges) {
    if (
      contains(edge, x, y) &&
      (!best || edge.width * edge.height < best.width * best.height)
    ) {
      best = edge;
    }
  }

  return best;
}

/**
 * 拾取顺序：系统窗口 → 邻域精修矩形 → 整屏候选矩形。
 *
 * 精修矩形是按原生分辨率把粗矩形四条边贴准后的结果，和粗矩形是同一个元素，
 * 所以只在光标不在任何系统窗口里、且确实落在它里面时才替换粗结果。
 */
export function getPreciseRectAt(
  windows: Bounds[],
  precise: Bounds | null,
  x: number,
  y: number,
): Bounds | null {
  if (getWindowAt(windows, x, y)) {
    return null;
  }
  return precise && contains(precise, x, y) ? precise : null;
}

/**
 * 移动整个选区时用的位移量：只要任一条边进入阈值就整体平移过去。
 * 这样是"框的边对齐窗口边"，而不是"鼠标抓取的点对齐窗口边"。
 */
export function snapOffset(values: number[], candidates: number[]): number {
  let best = 0;
  let bestDistance = SNAP_THRESHOLD + 1;

  for (const value of values) {
    for (const candidate of candidates) {
      const distance = Math.abs(candidate - value);
      if (distance < bestDistance) {
        best = candidate - value;
        bestDistance = distance;
      }
    }
  }

  return best;
}
