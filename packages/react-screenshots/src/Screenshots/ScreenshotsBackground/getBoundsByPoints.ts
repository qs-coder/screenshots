import type { SnapEdges } from '../getSnapEdges';
import { snapToEdge } from '../getSnapEdges';
import type { Bounds, Point } from '../types';

export default function getBoundsByPoints(
  { x: x1, y: y1 }: Point,
  { x: x2, y: y2 }: Point,
  width: number,
  height: number,
  edges?: SnapEdges,
): Bounds {
  if (edges) {
    // 两个角都参与吸附，和微信一致；后一个角不能吸到前一个角所在的边，否则会缩成 0 宽度
    x1 = snapToEdge(x1, edges.xs);
    y1 = snapToEdge(y1, edges.ys);
    x2 = snapToEdge(x2, edges.xs, x1);
    y2 = snapToEdge(y2, edges.ys, y1);
  }

  // 交换值
  if (x1 > x2) {
    [x1, x2] = [x2, x1];
  }

  if (y1 > y2) {
    [y1, y2] = [y2, y1];
  }

  // 把图形限制在元素里面
  if (x1 < 0) {
    x1 = 0;
  }

  if (x2 > width) {
    x2 = width;
  }

  if (y1 < 0) {
    y1 = 0;
  }

  if (y2 > height) {
    y2 = height;
  }

  return {
    x: x1,
    y: y1,
    width: x2 - x1,
    height: y2 - y1,
  };
}
