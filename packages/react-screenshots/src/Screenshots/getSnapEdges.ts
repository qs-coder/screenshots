import type { Bounds } from './types';

export interface SnapEdges {
  xs: number[];
  ys: number[];
}

/**
 * 高亮对光标的粘滞容差（DIP）。
 *
 * 光标已经出了当前高亮框这么多像素还当它"在框里"，于是不会立刻换框；
 * 反过来，要换到新框也必须进到新框里这么多像素才算数。两边用同一个深度阈值，
 * 公共边上就有一段对称的"死区" —— 手抖 1~2px 既不会换框，也不会闪一帧空白。
 */
export const HOVER_STICK = 3;

/** 精修矩形比粗矩形"更准"的判定容差，见 `getPreciseRectAt` */
export const PRECISE_SLOP = 4;

/** 同一块元素的两次识别结果，四条边各自允许的偏差，见 `stabilizeHover` */
export const REFINE_SLOP = 6;

/** 像素级阈值，和微信、Snipaste 的吸附手感基本一致 */
export const SNAP_THRESHOLD = 6;

/**
 * 松开阈值：已经吸住的边要离开这么远才松开（DIP）。
 *
 * 进出用两个不同阈值是防抖的关键。只留 `SNAP_THRESHOLD` 一个的话，光标停在边界
 * 6px 附近手抖 1~2px，框就会在"吸住"和"跟手"之间反复横跳 —— 看起来就是选区在抖。
 * 吸住之后给一段更宽的保持区间（多出 3px），抖动被这段区间吃掉，框就一直是稳的；
 * 区间也不能开太大，否则松开时要跳的距离比吸进去时还长，手感会变"黏"。
 */
export const SNAP_RELEASE = 9;

/** 一次拖拽内的吸附锁：key → 上次吸住的边，`null` 表示当前没吸住 */
export type SnapLocks = Record<string, number | null>;

export function createSnapLocks(): SnapLocks {
  return {};
}

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
  locks?: SnapLocks,
  key?: string,
): number {
  // 已经吸住的边，只要还在松开阈值内就继续吸着。
  // `exclude` 是另一条边当前的位置：锁住的边正好等于它时会让框缩成 0 宽/高，必须放弃
  if (locks && key) {
    const locked = locks[key];
    if (
      typeof locked === 'number' &&
      locked !== exclude &&
      Math.abs(locked - value) <= SNAP_RELEASE
    ) {
      return locked;
    }
  }

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

  const snapped = Number.isNaN(best) ? null : best;
  if (locks && key) {
    locks[key] = snapped;
  }
  return snapped ?? value;
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
 * 窗口把四条边都算作自己的一部分：像素本来就是这个窗口的，
 * 按 `contains` 的口径光标压在边框上时窗口不算命中，元素矩形就会趁虚而入，
 * 表现为"窗口边缘冒出碎框"。
 *
 * 右/下必须**取等**：窗口矩形是 DWM 的可见边框（`GetWindowRect` 的隐藏边框已经排除了），
 * 光标停在下边缘那一行时那行像素仍属于这个窗口。开区间会让判定漏掉它、落到列表里
 * 下一个命中者身上 —— 那个往往是压在背后、被裁成整屏高的窗口，高亮会突然胀成
 * 一个横跨整屏的大框，看起来就是"窗口边缘识别错了"。
 *
 * 相邻窗口共用一列像素时由列表顺序（z 值从大到小）裁决，靠前的那个赢，
 * 所以这里取等不会把邻居的边抢走。
 */
function containsWindow(r: Bounds, x: number, y: number): boolean {
  return (
    x >= r.x &&
    y >= r.y &&
    x <= r.x + r.width &&
    y <= r.y + r.height
  );
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
 *
 * 判定留了 `PRECISE_SLOP` 的余量：精修后的边比粗矩形准，往往往里收 1~3px。
 * 用严格包含的话，光标在精修边外侧那几个像素里来回时，结果会在精修矩形和粗矩形
 * 之间反复切换 —— 高亮看着就是在抖。放宽几个像素后这段灰区只认精修结果。
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
  return precise && boundsContains(precise, x, y, PRECISE_SLOP) ? precise : null;
}

/**
 * 移动整个选区时用的位移量：只要任一条边进入阈值就整体平移过去。
 * 这样是"框的边对齐窗口边"，而不是"鼠标抓取的点对齐窗口边"。
 */
export function snapOffset(
  values: number[],
  candidates: number[],
  locks?: SnapLocks,
  key?: string,
): number {
  // 平移量已经吸在某个边上：只要整体挪完之后还有一条边留在松开阈值内，就继续用这个位移
  if (locks && key) {
    const locked = locks[key];
    if (typeof locked === 'number' && locked !== 0) {
      const stillSnapped = values.some((value) =>
        candidates.some(
          (candidate) => Math.abs(candidate - (value + locked)) <= SNAP_RELEASE,
        ),
      );
      if (stillSnapped) {
        return locked;
      }
    }
  }

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

  if (locks && key) {
    locks[key] = best === 0 ? null : best;
  }
  return best;
}

/** 两个矩形是否完全一致（含 null 对 null） */
export function sameBounds(a: Bounds | null, b: Bounds | null): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return (
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
  );
}

/** 点是否落在矩形内（`slop` 为向外放宽的容差） */
export function boundsContains(
  r: Bounds,
  x: number,
  y: number,
  slop = 0,
): boolean {
  return (
    x >= r.x - slop &&
    y >= r.y - slop &&
    x <= r.x + r.width + slop &&
    y <= r.y + r.height + slop
  );
}

/**
 * 点是否落在矩形内**并且**离四条边都还有 `margin` 的余量。
 * 小矩形（图标那种）按一半算，否则永远判不进去。
 */
export function boundsContainsInset(
  r: Bounds,
  x: number,
  y: number,
  margin: number,
): boolean {
  const mx = Math.min(margin, Math.max(r.width / 2 - 0.5, 0));
  const my = Math.min(margin, Math.max(r.height / 2 - 0.5, 0));
  return (
    x >= r.x + mx &&
    y >= r.y + my &&
    x <= r.x + r.width - mx &&
    y <= r.y + r.height - my
  );
}

/**
 * `next` 是不是一块**比当前框更小**的候选，也就是"往里钻"的目标：
 * 大窗口里浮着的小窗口、面板里的按钮、z 更高压在上面的重叠窗口。
 *
 * 光标始终还在外面那个大框里，所以单看"光标在不在框里"分不出"往里钻"和"在公共边上抖" ——
 * 区别在于方向：换成更小的候选是明确的深入，换成更大的候选才是往外走。
 * 往外走那条路由 `stabilizeHover` 的 `HOVER_STICK` 死区负责，这里只管深入。
 */
function isDescend(prev: Bounds, next: Bounds): boolean {
  return next.width * next.height < prev.width * prev.height;
}

/** 两个矩形四条边的偏差是否都在 `slop` 之内（同一块元素的两次识别结果） */
export function isNearlySame(a: Bounds, b: Bounds, slop: number): boolean {
  return (
    Math.abs(a.x - b.x) <= slop &&
    Math.abs(a.y - b.y) <= slop &&
    Math.abs(a.x + a.width - (b.x + b.width)) <= slop &&
    Math.abs(a.y + a.height - (b.y + b.height)) <= slop
  );
}

/**
 * 把这次算出来的矩形收敛成一个"不会抖"的高亮。
 *
 * 微信的窗口高亮之所以稳，是因为它一旦高亮某一块就不再重算：光标在这块里面怎么动，
 * 高亮都不变，只有真的走出去才换。按坐标每帧重新拾取的做法做不到这一点 ——
 * 光标压在两个候选的公共边上时，1px 的位移就能让结果在两者之间来回切，
 * 视觉上就是框在抖（还常常夹着"一帧没有高亮"的闪烁）。
 *
 * 这里的规则按优先级：
 * 1. 没有新结果（光标离开所有候选）—— 还停在当前框里就继续留着，别闪；
 * 2. 和当前高亮完全一致 —— 原样返回，连重渲染都省掉；
 * 3. 光标还没**真正进到**新框里（离新框的边不足 `HOVER_STICK`）—— 先不动。
 *    这条和"离开旧框要超过 `HOVER_STICK`"合起来，就是公共边两侧的对称死区：
 *    光标压在两块窗口的公共边上、或者沿窗口边缘走，都不会来回换框；
 * 4. 新结果优先级更高（`authoritative`：元素 → 系统窗口，或 z 更高的窗口）—— 直接换；
 * 5. 新结果**比当前框更小**（`isDescend`：大窗口里浮着的小窗口、面板里的按钮）—— 换。
 *    光标这时候还在外面那个大框里，靠第 6 条永远换不过去，小窗口的边缘也就永远识别不到；
 * 6. 光标还在当前框里（含 `HOVER_STICK` 容差）—— 只有"同一块更准的矩形"才换，
 *    其它候选一律不动，这就是"平稳选中"；
 * 7. 光标已经出了框 —— 正常切到新候选。
 */
export function stabilizeHover(
  prev: Bounds | null,
  next: Bounds | null,
  x: number,
  y: number,
  authoritative = false,
): Bounds | null {
  if (!prev) {
    return next;
  }
  if (!next) {
    return boundsContains(prev, x, y, HOVER_STICK) ? prev : null;
  }
  if (sameBounds(prev, next)) {
    return prev;
  }
  if (!boundsContainsInset(next, x, y, HOVER_STICK)) {
    return prev;
  }
  if (authoritative) {
    return next;
  }
  if (isDescend(prev, next)) {
    return next;
  }
  if (!boundsContains(prev, x, y, HOVER_STICK)) {
    return next;
  }
  return isNearlySame(prev, next, REFINE_SLOP) ? next : prev;
}
