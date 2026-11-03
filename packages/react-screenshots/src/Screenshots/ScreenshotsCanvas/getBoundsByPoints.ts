import type { SnapEdges, SnapLocks } from '../getSnapEdges';
import { snapOffset, snapToEdge } from '../getSnapEdges';
import type { Bounds, Point } from '../types';

export default function getBoundsByPoints(
  { x: x1, y: y1 }: Point,
  { x: x2, y: y2 }: Point,
  bounds: Bounds,
  width: number,
  height: number,
  resizeOrMove: string,
  edges?: SnapEdges,
  locks?: SnapLocks,
): Bounds {
  // 交换值
  if (x1 > x2) {
    [x1, x2] = [x2, x1];
  }

  if (y1 > y2) {
    [y1, y2] = [y2, y1];
  }

  if (edges) {
    if (resizeOrMove === 'move') {
      const dx = snapOffset([x1, x2], edges.xs, locks, 'move-x');
      const dy = snapOffset([y1, y2], edges.ys, locks, 'move-y');
      x1 += dx;
      x2 += dx;
      y1 += dy;
      y2 += dy;
    } else {
      // 手柄名里带了在动的那条边，另一条必须保持原位，否则整个框会跟着漂
      if (resizeOrMove.includes('left')) {
        x1 = snapToEdge(x1, edges.xs, x2, locks, 'left');
      }
      if (resizeOrMove.includes('right')) {
        x2 = snapToEdge(x2, edges.xs, x1, locks, 'right');
      }
      if (resizeOrMove.includes('top')) {
        y1 = snapToEdge(y1, edges.ys, y2, locks, 'top');
      }
      if (resizeOrMove.includes('bottom')) {
        y2 = snapToEdge(y2, edges.ys, y1, locks, 'bottom');
      }
    }
  }

  // 把图形限制在元素里面
  if (x1 < 0) {
    x1 = 0;
    if (resizeOrMove === 'move') {
      x2 = bounds.width;
    }
  }

  if (x2 > width) {
    x2 = width;
    if (resizeOrMove === 'move') {
      x1 = x2 - bounds.width;
    }
  }

  if (y1 < 0) {
    y1 = 0;
    if (resizeOrMove === 'move') {
      y2 = bounds.height;
    }
  }

  if (y2 > height) {
    y2 = height;
    if (resizeOrMove === 'move') {
      y1 = y2 - bounds.height;
    }
  }

  return {
    x: x1,
    y: y1,
    width: Math.max(x2 - x1, 1),
    height: Math.max(y2 - y1, 1),
  };
}
