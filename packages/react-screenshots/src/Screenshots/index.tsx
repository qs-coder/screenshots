import type { MouseEvent, ReactElement } from 'react';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import composeImage from './composeImage';
import './icons/iconfont.less';
import './screenshots.less';
import ScreenshotsBackground from './ScreenshotsBackground';
import ScreenshotsCanvas from './ScreenshotsCanvas';
import ScreenshotsContext, { EMPTY_BOUNDS } from './ScreenshotsContext';
import ScreenshotsOperations from './ScreenshotsOperations';
import type { Bounds, Emitter, History } from './types';
import useGetLoadedImage from './useGetLoadedImage';
import type { Lang } from './zh_CN';
import zhCN from './zh_CN';

export interface ScreenshotsProps {
  url?: string;
  /**
   * 与 `url` 成对传入的**已解码**底图元素。
   * Electron 那边解码完才提交，所以底图不会出现"已换 url 但图片还没加载"的空窗期；
   * 不传时按 `url` 自己加载（web 端、或者宿主自己先解码好的场景）。
   */
  imageElement?: HTMLImageElement | null;
  width: number;
  height: number;
  lang?: Partial<Lang>;
  className?: string;
  /**
   * 当前屏幕上其他应用的窗口矩形（屏幕内坐标系），用于窗口识别与锁边吸附。
   * 不传或为空时退化成纯手动框选。
   */
  windows?: Bounds[];
  /**
   * 从截图像素里识别出的元素矩形（屏幕内坐标系），是 `windows` 的兜底：
   * 只有光标不在任何系统窗口里时才用它拾取；吸附只认 `windows` 的边，它只在
   * `windows` 为空时顶上。不传或为空时行为与只有 windows 时完全一致。
   */
  edges?: Bounds[];
  [key: string]: unknown;
}

export default function Screenshots({
  url,
  imageElement,
  width,
  height,
  lang,
  className,
  windows,
  edges,
  ...props
}: ScreenshotsProps): ReactElement {
  const propsRef = useRef(props);
  propsRef.current = props;
  const image = useGetLoadedImage(url, imageElement);
  const canvasContextRef = useRef<CanvasRenderingContext2D>(null);
  const emitterRef = useRef<Emitter>({});
  const [history, setHistory] = useState<History>({
    index: -1,
    stack: [],
  });
  const [bounds, setBounds] = useState<Bounds | null>(null);
  const [cursor, setCursor] = useState<string | undefined>('move');
  const [operation, setOperation] = useState<string | undefined>(undefined);

  const store = {
    url,
    width,
    height,
    image,
    lang: {
      ...zhCN,
      ...lang,
    },
    emitterRef,
    canvasContextRef,
    history,
    bounds,
    windows: windows ?? EMPTY_BOUNDS,
    edges: edges ?? EMPTY_BOUNDS,
    cursor,
    operation,
  };

  const call = useCallback(
    <T extends unknown[]>(funcName: string, ...args: T) => {
      const func = propsRef.current[funcName];
      if (typeof func === 'function') {
        func(...args);
      }
    },
    [],
  );

  const dispatcher = {
    call,
    setHistory,
    setBounds,
    setCursor,
    setOperation,
  };

  const classNames = ['screenshots'];

  if (className) {
    classNames.push(className);
  }

  const reset = useCallback(() => {
    emitterRef.current = {};
    setHistory({
      index: -1,
      stack: [],
    });
    setBounds(null);
    setCursor('move');
    setOperation(undefined);
  }, []);

  const onDoubleClick = useCallback(
    async (e: MouseEvent<HTMLDivElement>) => {
      if (e.button !== 0 || !image) {
        return;
      }
      if (bounds && canvasContextRef.current) {
        composeImage({
          image,
          width,
          height,
          history,
          bounds,
        }).then((blob) => {
          call('onOk', blob, bounds);
          reset();
        });
      } else {
        const targetBounds = {
          x: 0,
          y: 0,
          width,
          height,
        };
        composeImage({
          image,
          width,
          height,
          history,
          bounds: targetBounds,
        }).then((blob) => {
          call('onOk', blob, targetBounds);
          reset();
        });
      }
    },
    [image, history, bounds, width, height, call, reset],
  );

  const onContextMenu = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (e.button !== 2) {
        return;
      }
      e.preventDefault();
      call('onCancel');
      reset();
    },
    [call, reset],
  );

  const onStart = useCallback(() => call('onStart'), []);

  const onStop = useCallback(() => call('onStop'), []);

  // url变化，重置截图区域
  // biome-ignore lint/correctness/useExhaustiveDependencies: useLayoutEffect only cares about url
  useLayoutEffect(() => {
    reset();
  }, [url]);

  return (
    <ScreenshotsContext.Provider value={{ store, dispatcher }}>
      <div
        className={classNames.join(' ')}
        style={{ width, height }}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
      >
        <ScreenshotsBackground onStart={onStart} onStop={onStop} />
        <ScreenshotsCanvas ref={canvasContextRef} />
        <ScreenshotsOperations />
      </div>
    </ScreenshotsContext.Provider>
  );
}
