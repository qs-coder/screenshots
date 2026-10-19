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
import getSnapEdges, { getWindowAt } from "../getSnapEdges";
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
  const { url, image, width, height, windows } = useStore();
  const [bounds, boundsDispatcher] = useBounds();

  const elRef = useRef<HTMLDivElement>(null);
  const pointRef = useRef<Point | null>(null);
  // 用来判断鼠标是否移动过
  // 如果没有移动过位置，则pointerup时不更新
  const isMoveRef = useRef<boolean>(false);
  const [position, setPosition] = useState<Position | null>(null);
  // 正在框选，此时框外还不能显示 not-allowed
  const [isSelecting, setIsSelecting] = useState<boolean>(false);
  // 微信式窗口识别：未框选时高亮光标所在的窗口，单击即整窗选中
  const [hover, setHover] = useState<Bounds | null>(null);

  const edges = useMemo(
    () => getSnapEdges(windows, width, height),
    [windows, width, height]
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
          snap ? edges : undefined
        )
      );
    },
    [width, height, edges, boundsDispatcher]
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

  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
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
        // 只有没在拖框时才做窗口识别，否则高亮层会在拖动过程中跟着闪
        setHover(!bounds && pos ? getWindowAt(windows, pos.x, pos.y) : null);
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
        const win =
          rect && getWindowAt(windows, e.clientX - rect.x, e.clientY - rect.y);
        if (win) {
          // 微信式：单击直接选中光标所在的整个窗口
          boundsDispatcher.set(win);
        } else {
          onStop && onStop();
        }
      }
      pointRef.current = null;
      isMoveRef.current = false;
      setIsSelecting(false);
      setHover(null);
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [updateBounds, onStart, onStop, bounds, windows, boundsDispatcher]);

  useLayoutEffect(() => {
    if (!image || bounds) {
      // 重置位置
      setPosition(null);
      setHover(null);
    }
  }, [image, bounds]);

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
