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
import getSnapEdges, {
  getPreciseRectAt,
  getWindowAt,
  getRectAt,
} from "../getSnapEdges";
import useBounds from "../hooks/useBounds";
import useStore from "../hooks/useStore";
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
  // 用来判断鼠标是否移动过
  // 如果没有移动过位置，则pointerup时不更新
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

  const updateBounds = useCallback(
    (p1: Point, p2: Point, snap: boolean) => {
      if (!elRef.current) {
        return;
      }
      const { x, y } = elRef.current.getBoundingClientRect();

      boundsDispatcher.set(
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
          snap ? snapEdges : undefined
        )
      );
    },
    [width, height, snapEdges, boundsDispatcher]
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
      setIsSelecting(true);
      onStart && onStart();
    },
    [bounds, onStart]
  );

  const pickAt = useCallback(
    (x: number, y: number) => {
      const rect = getPreciseRectAt(windows, preciseRef.current, x, y);
      return rect ?? getRectAt(windows, edges, x, y);
    },
    [windows, edges]
  );

  /**
   * 按光标位置重算高亮。pointermove 和"识别结果到达"都会调用它：
   * 后者是因为开场识别要几百毫秒（Windows 上还要加首帧解码），
   * 用户往往已经把鼠标停在窗口上不动了 —— 只靠 pointermove 的话高亮永远不出现。
   */
  const syncHover = useCallback(
    (pos: Position | null) => {
      const next = !bounds && pos ? pickAt(pos.x, pos.y) : null;
      hoverRef.current = next;
      setHover(next);
      // 落在窗口之外才需要精修（窗口本来就有精确边界）；
      // 已经贴准过的矩形再问一遍只是白花一次 worker
      if (
        next &&
        pos &&
        next !== preciseRef.current &&
        !getWindowAt(windows, pos.x, pos.y)
      ) {
        cursorRef.current = pos;
        requestRegion(next);
      }
    },
    [bounds, pickAt, windows, requestRegion]
  );

  useEffect(() => {
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
      // Alt/⌥ 是吸附的逃生口，需要精确到像素时按住它
      updateBounds(
        pointRef.current,
        {
          x: e.clientX,
          y: e.clientY,
        },
        !e.altKey
      );
      isMoveRef.current = true;
    };

    const onPointerUp = (e: PointerEvent) => {
      if (!pointRef.current) {
        return;
      }

      if (isMoveRef.current) {
        onStart && onStart();
        updateBounds(
          pointRef.current,
          {
            x: e.clientX,
            y: e.clientY,
          },
          !e.altKey
        );
      } else {
        const rect = elRef.current?.getBoundingClientRect();
        const picked = rect && pickAt(e.clientX - rect.x, e.clientY - rect.y);
        if (picked) {
          // 微信式：单击直接选中光标所在的整个窗口或元素
          boundsDispatcher.set(picked);
        } else {
          onStop && onStop();
        }
      }
      pointRef.current = null;
      isMoveRef.current = false;
      setIsSelecting(false);
      hoverRef.current = null;
      setHover(null);
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [updateBounds, onStart, onStop, pickAt, syncHover, boundsDispatcher]);

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
      // 高亮立刻换成这份准的矩形：用户停在元素上不动时不会再有 pointermove
      const next = getPreciseRectAt(windows, refined, cursor.x, cursor.y);
      if (next) {
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
