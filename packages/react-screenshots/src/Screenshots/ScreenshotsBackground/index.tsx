import type { ReactElement, PointerEvent as ReactPointerEvent } from "react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CLICK_SLOP, isWithinClickSlop } from "../constants";
import getSnapEdges, {
  createSnapLocks,
  getPreciseRectAt,
  getRectAt,
  getWindowAt,
  isNearlySame,
  REFINE_SLOP,
  type SnapLocks,
  sameBounds,
  stabilizeHover,
} from "../getSnapEdges";
import useBounds from "../hooks/useBounds";
import useStore from "../hooks/useStore";
import quantizeBounds from "../quantizeBounds";
import ScreenshotsMagnifier from "../ScreenshotsMagnifier";
import type { Bounds, Point, Position } from "../types";
import getBoundsByPoints from "./getBoundsByPoints";
import "./index.less";

// 添加组件 props 接口
interface ScreenshotsBackgroundProps {
  onStart?: () => void;
  onStop?: () => void;
}

export default memo(function ScreenshotsBackground({ onStart, onStop }: ScreenshotsBackgroundProps): ReactElement | null {
  const { url, image, width, height, windows, edges } = useStore();
  const [bounds, boundsDispatcher] = useBounds();

  const elRef = useRef<HTMLDivElement>(null);
  const pointRef = useRef<Point | null>(null);
  // 位移是否已越过单击容差。按下瞬间的抖动也走 pointermove，
  // 只按"有没有移动过"判断的话，单击会退化成 1px 的框
  const isMoveRef = useRef<boolean>(false);
  const [position, setPosition] = useState<Position | null>(null);
  // 正在框选，此时框外还不能显示 not-allowed
  const [isSelecting, setIsSelecting] = useState<boolean>(false);
  // 微信式识别：未框选时高亮光标所在的窗口或元素，单击即整块选中
  const [hover, setHover] = useState<Bounds | null>(null);
  // 邻域精修的结果：DIP、屏幕内坐标，比整屏候选集贴边准；null 表示还没算出来。
  // 只放 ref 不放 state —— 它不参与渲染，而 pointermove 每秒几十次，不该因它重挂监听器。
  const preciseRef = useRef<Bounds | null>(null);
  const hoverRef = useRef<Bounds | null>(null);
  // 一次拖拽内的吸附锁，见 `snapToEdge`；按下时清空，上一次拖拽的锁不能带过来
  const snapLocksRef = useRef<SnapLocks>(createSnapLocks());
  // 上一次发起精修的粗矩形标识，同一个矩形只问一次
  const lastRegionRef = useRef<string | null>(null);
  // 上一次发起精修的光标位置，结果回来要确认光标还没走远
  const cursorRef = useRef<Point | null>(null);
  // 最后一次 pointermove 的窗口内坐标，以及当时的窗口尺寸。
  // 窗口/元素数据常常晚于光标到达（开场枚举要几百毫秒，Windows 上首帧解码还得几秒），
  // 用户停在目标窗口上不动时没有新的 pointermove，只能靠这份坐标补算高亮。
  // 尺寸一起记是因为客户端坐标的原点跟着窗口走：换到另一块屏后旧坐标会整体错位。
  const lastClientRef = useRef<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  // 用来识别 image 的身份变化（换屏、新一轮截图），见下面的重置
  const lastImageRef = useRef<HTMLImageElement | null>(null);

  const applyPrecise = useCallback((next: Bounds | null) => {
    preciseRef.current = next;
  }, []);

  /**
   * 让主进程按原生分辨率把粗矩形的四条边贴准。
   * 整屏那一遍为压耗时降过采样，边会偏 1~3 DIP，贴边精度只能靠这一次小区域重算。
   * 去重标识就是发出去的粗矩形本身，主进程原样回传，结果回来才认得出是哪一次的。
   */
  const requestRegion = useCallback((rect: Bounds) => {
    const key = `${rect.x},${rect.y},${rect.width},${rect.height}`;
    // 同一个粗矩形不重复问，pointermove 每秒几十次
    if (lastRegionRef.current === key) {
      return;
    }
    lastRegionRef.current = key;
    window.screenshots?.edgeRegion?.(rect);
  }, []);

  const snapEdges = useMemo(
    // 拖框只吸附窗口的边（元素边太碎会把选区带偏）；窗口枚举不到时才退回元素边
    () => getSnapEdges(windows.length ? windows : edges, width, height),
    [windows, edges, width, height]
  );

  const computeBounds = useCallback(
    (p1: Point, p2: Point, snap: boolean): Bounds | null => {
      if (!elRef.current) {
        return null;
      }
      const { x, y } = elRef.current.getBoundingClientRect();

      return quantizeBounds(
        getBoundsByPoints(
          {
            x: p1.x - x,
            y: p1.y - y,
          },
          {
            x: p2.x - x,
            y: p2.y - y,
          },
          width,
          height,
          snap ? snapEdges : undefined,
          snap ? snapLocksRef.current : undefined
        )
      );
    },
    [width, height, snapEdges]
  );

  const updateBounds = useCallback(
    (p1: Point, p2: Point, snap: boolean): Bounds | null => {
      const next = computeBounds(p1, p2, snap);
      if (next) {
        boundsDispatcher.set(next);
      }
      return next;
    },
    [computeBounds, boundsDispatcher],
  );

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      // e.button 鼠标左键
      if (pointRef.current || bounds || e.button !== 0) {
        return;
      }
      pointRef.current = {
        x: e.clientX,
        y: e.clientY,
      };
      isMoveRef.current = false;
      // 上一次拖拽吸住的边不能带到这一次
      snapLocksRef.current = createSnapLocks();
      setIsSelecting(true);
      onStart && onStart();
    },
    [bounds, onStart],
  );

  const pickAt = useCallback(
    (x: number, y: number) => {
      const rect = getPreciseRectAt(windows, preciseRef.current, x, y);
      return rect ?? getRectAt(windows, edges, x, y);
    },
    [windows, edges],
  );

  /**
   * 按光标位置重算高亮。pointermove 和"识别结果到达"都会调用它：
   * 后者是因为开场识别要几百毫秒（Windows 上还要加首帧解码），
   * 用户往往已经把鼠标停在窗口上不动了 —— 只靠 pointermove 的话高亮永远不出现。
   *
   * 算出来的结果不直接上屏，先过一遍 `stabilizeHover`：光标还停在当前高亮框里时
   * 不换框，这样压在两块候选的公共边上、或者手抖 1~2px 时，高亮都是稳的。
   */
  const syncHover = useCallback(
    (pos: Position | null) => {
      const prev = hoverRef.current;
      let next: Bounds | null = null;
      // 系统窗口是权威答案：光标在窗口里时高亮只能是这个窗口，元素矩形不能顶替它
      let authoritative = false;
      if (!bounds && pos) {
        const win = getWindowAt(windows, pos.x, pos.y);
        if (win) {
          next = win;
          // 窗口是权威答案，窗口之间也有优先级：列表按 z 从大到小排，排在前面的压在后面的身上。
          // 优先级更高的窗口命中时就该立刻换 —— "元素 → 窗口"的升级（窗口数据常常晚到，
          // 晚到也得立刻生效）同理，`prev` 根本不在窗口列表里，按 `prevIndex < 0` 走同一条路。
          //
          // 反方向（窗口 → 被它压住的那个）不走快路：两块窗口共用一条边时按坐标判会来回跳，
          // 交给 `stabilizeHover` 的粘滞容差，跨过 `HOVER_STICK` 才换框。
          const prevIndex = prev
            ? windows.findIndex((item) => sameBounds(item, prev))
            : -1;
          const nextIndex = windows.findIndex((item) => sameBounds(item, win));
          authoritative =
            prevIndex < 0 || (nextIndex >= 0 && nextIndex < prevIndex);
        } else {
          next = pickAt(pos.x, pos.y);
        }
      }

      const stable =
        bounds || !pos
          ? null
          : stabilizeHover(prev, next, pos.x, pos.y, authoritative);

      hoverRef.current = stable;
      // 值没变就不提交：pointermove 每秒几十次，无谓的重渲染本身就是一种"抖"
      if (!sameBounds(prev, stable)) {
        setHover(stable);
      }
      // 落在窗口之外才需要精修（窗口本来就有精确边界）；
      // 已经贴准过的矩形再问一遍只是白花一次 worker
      if (
        stable &&
        pos &&
        !sameBounds(stable, preciseRef.current) &&
        !getWindowAt(windows, pos.x, pos.y)
      ) {
        cursorRef.current = pos;
        requestRegion(stable);
      }
    },
    [bounds, pickAt, windows, requestRegion],
  );

  useEffect(() => {
    /**
     * 单击要选中的矩形：优先用**当前高亮的那一块**。
     *
     * 高亮框就是用户看到的框，单击确认它才符合预期；按坐标重新拾取的话，
     * 容差内的抖动会把拾取点挪到旁边更小/更大的元素上，选出来的框和看到的不一样。
     * 允许 CLICK_SLOP 的偏差，是为了"手抖一下点到框外"也仍然算点中。
     */
    const pickForClick = (clientX: number, clientY: number): Bounds | null => {
      const rect = elRef.current?.getBoundingClientRect();
      if (!rect) {
        return null;
      }
      const x = clientX - rect.x;
      const y = clientY - rect.y;
      const hovered = hoverRef.current;
      if (
        hovered &&
        x >= hovered.x - CLICK_SLOP &&
        y >= hovered.y - CLICK_SLOP &&
        x <= hovered.x + hovered.width + CLICK_SLOP &&
        y <= hovered.y + hovered.height + CLICK_SLOP
      ) {
        return hovered;
      }
      return pickAt(x, y);
    };

    const onPointerMove = (e: PointerEvent) => {
      // 底图还没提交时页面里没有 elRef，但坐标一样要记下来：
      // 用户经常在这几百毫秒里就把鼠标挪到目标窗口上，之后不再动了
      lastClientRef.current = {
        x: e.clientX,
        y: e.clientY,
        width: window.innerWidth,
        height: window.innerHeight,
      };
      let pos: Position | null = null;
      if (elRef.current) {
        const rect = elRef.current.getBoundingClientRect();
        if (
          e.clientX < rect.left ||
          e.clientY < rect.top ||
          e.clientX > rect.right ||
          e.clientY > rect.bottom
        ) {
          setPosition(null);
        } else {
          pos = {
            x: e.clientX - rect.x,
            y: e.clientY - rect.y,
          };
          setPosition(pos);
        }
      }

      if (!pointRef.current) {
        // 只有没在拖框时才做识别，否则高亮层会在拖动过程中跟着闪
        syncHover(pos);
        return;
      }
      if (!isMoveRef.current) {
        // 容差内的位移是按下时的手抖，不是拖框：一旦认成拖框，
        // 单击确认窗口就会缩成一个 1px 的点，高亮框也会跟着消失
        if (
          isWithinClickSlop(pointRef.current, { x: e.clientX, y: e.clientY })
        ) {
          return;
        }
        isMoveRef.current = true;
      }
      // Alt/⌥ 是吸附的逃生口，需要精确到像素时按住它
      updateBounds(
        pointRef.current,
        {
          x: e.clientX,
          y: e.clientY,
        },
        !e.altKey,
      );
    };

    const onPointerUp = (e: PointerEvent) => {
      if (!pointRef.current) {
        return;
      }

      const down = pointRef.current;
      const wasDrag = isMoveRef.current;
      pointRef.current = null;
      isMoveRef.current = false;
      setIsSelecting(false);

      if (wasDrag) {
        onStart && onStart();
        const next = computeBounds(
          down,
          {
            x: e.clientX,
            y: e.clientY,
          },
          !e.altKey,
        );
        // 拖出来的框小到没有意义（吸附还可能把两条边吸到一起），
        // 说明用户其实只想单击确认，别把这个点当成选区提交
        if (next && (next.width > CLICK_SLOP || next.height > CLICK_SLOP)) {
          boundsDispatcher.set(next);
          hoverRef.current = null;
          setHover(null);
          return;
        }
      }

      const picked = pickForClick(e.clientX, e.clientY);
      if (picked) {
        // 微信式：单击直接选中光标所在的整个窗口或元素
        boundsDispatcher.set(picked);
      } else {
        onStop && onStop();
      }
      hoverRef.current = null;
      setHover(null);
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [
    updateBounds,
    computeBounds,
    onStart,
    onStop,
    pickAt,
    syncHover,
    boundsDispatcher,
  ]);

  // 底图或识别结果晚到：光标没动也要把高亮和放大镜补上
  useEffect(() => {
    if (!url || !image || pointRef.current) {
      return;
    }
    const last = lastClientRef.current;
    const el = elRef.current;
    if (!last || !el) {
      return;
    }
    // 窗口尺寸变了说明刚换过屏，旧坐标原点属于上一块屏，用它只会把框贴错地方
    if (
      last.width !== window.innerWidth ||
      last.height !== window.innerHeight
    ) {
      return;
    }
    const rect = el.getBoundingClientRect();
    const inside =
      last.x >= rect.left &&
      last.y >= rect.top &&
      last.x <= rect.right &&
      last.y <= rect.bottom;
    const pos = inside ? { x: last.x - rect.x, y: last.y - rect.y } : null;
    if (pos) {
      setPosition(pos);
    }
    syncHover(pos);
  }, [syncHover, url, image]);

  // 精修结果异步回来：第一条就是发起时那个粗矩形（可能已被贴准），光标走远了就丢掉
  useEffect(() => {
    const onEdgesPrecise = (region: Bounds, bounds: Bounds[] = []) => {
      const cursor = cursorRef.current;
      const refined = bounds[0];
      if (!cursor || !region || !refined) {
        return;
      }
      const key = `${region.x},${region.y},${region.width},${region.height}`;
      if (key !== lastRegionRef.current) {
        return;
      }
      applyPrecise(refined);
      // 结果回来时用户可能已经挪到别的元素上（甚至移出了所有候选）：
      // 只认"当前高亮的还是发起精修的这一块"。不校验的话，旧结果会把新元素的高亮顶掉，
      // 或者把已经消失的高亮按旧光标位置贴回来 —— 视觉上就是框自己跳了一下
      const prev = hoverRef.current;
      if (!prev || !isNearlySame(prev, region, REFINE_SLOP)) {
        return;
      }
      // 高亮立刻换成这份准的矩形：用户停在元素上不动时不会再有 pointermove
      const next = getPreciseRectAt(windows, refined, cursor.x, cursor.y);
      if (next && !sameBounds(prev, next)) {
        hoverRef.current = next;
        setHover(next);
      }
    };

    window.screenshots?.on("edges-precise", onEdgesPrecise);
    return () => {
      window.screenshots?.off("edges-precise", onEdgesPrecise);
    };
  }, [applyPrecise, windows]);

  useLayoutEffect(() => {
    // 换屏/新一轮截图时 image 会换成新的，而此刻 bounds 还是 null，
    // 只看 `!image || bounds` 判断不到这种情况，上一张图的精修矩形会贴在新图上
    const isNewImage = image !== lastImageRef.current;
    lastImageRef.current = image;
    if (!image) {
      // 一轮截图结束：下一轮的光标位置和这一轮无关
      lastClientRef.current = null;
    }
    if (isNewImage || !image || bounds) {
      // 重置位置
      setPosition(null);
      hoverRef.current = null;
      setHover(null);
      // 换屏/新一轮截图后上一份精修结果对应的是旧图，留着会把矩形贴错地方
      lastRegionRef.current = null;
      cursorRef.current = null;
      applyPrecise(null);
    }
  }, [image, bounds, applyPrecise]);

  // 没有加载完不显示图片
  if (!url || !image) {
    return null;
  }

  return (
    <div
      ref={elRef}
      className="screenshots-background"
      style={{
        // 框选完成后，框和工具条之外的区域都不再有可操作的东西
        cursor: bounds && !isSelecting ? "not-allowed" : undefined,
      }}
      onPointerDown={onPointerDown}
    >
      <img className="screenshots-background-image" src={url} />
      <div className="screenshots-background-mask" />
      {hover && !bounds && (
        <div
          className="screenshots-background-hover"
          style={{
            left: hover.x,
            top: hover.y,
            width: hover.width,
            height: hover.height,
            backgroundImage: `url(${url})`,
            backgroundPosition: `${-hover.x}px ${-hover.y}px`,
            backgroundSize: `${width}px ${height}px`,
          }}
        />
      )}
      {position && !bounds && (
        <ScreenshotsMagnifier x={position?.x} y={position?.y} />
      )}
    </div>
  );
});
