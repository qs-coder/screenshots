import type { Bounds } from './types';

export interface SnapEdges {
  xs: number[];
  ys: number[];
}

/** 像素级阈值，和微信、Snipaste 的吸附手感基本一致 */
export const SNAP_THRESHOLD = 6;

/**
 * 把所有可吸附的边收集起来：屏幕四边 + 每个窗口的四边。
 * 窗口列表为空时只剩屏幕四边，行为退化成"只能贴屏幕边"，不会拖慢拖框。
 */
export default function getSnapEdges(
  windows: Bounds[],
  width: number,
  height: number,
): SnapEdges {
  const xs = new Set<number>([0, width]);
  const ys = new Set<number>([0, height]);

  for (const win of windows) {
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

/** 取光标所在窗口，列表已按 z 值从大到小排序，第一个命中的就是最上面的 */
export function getWindowAt(
  windows: Bounds[],
  x: number,
  y: number,
): Bounds | null {
  for (const win of windows) {
    if (
      x > win.x &&
      y > win.y &&
      x < win.x + win.width &&
      y < win.y + win.height
    ) {
      return win;
    }
  }

  return null;
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
