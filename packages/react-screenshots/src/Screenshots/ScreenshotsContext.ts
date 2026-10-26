import type { Dispatch, SetStateAction } from 'react';
import React from 'react';
import type { Bounds, CanvasContextRef, EmitterRef, History } from './types';
import type { Lang } from './zh_CN';
import zhCN from './zh_CN';

export interface ScreenshotsContextStore {
  url?: string;
  image: HTMLImageElement | null;
  width: number;
  height: number;
  lang: Lang;
  emitterRef: EmitterRef;
  canvasContextRef: CanvasContextRef;
  history: History;
  bounds: Bounds | null;
  /** 屏幕上其他应用的窗口矩形，屏幕内坐标系；拿不到时为空数组 */
  windows: Bounds[];
  /** 从截图像素里识别出的元素矩形，屏幕内坐标系；未开启或识别失败时为空数组 */
  edges: Bounds[];
  cursor?: string;
  operation?: string;
}

export interface ScreenshotsContextDispatcher {
  call?: <T>(funcName: string, ...args: T[]) => void;
  setHistory?: Dispatch<SetStateAction<History>>;
  setBounds?: Dispatch<SetStateAction<Bounds | null>>;
  setCursor?: Dispatch<SetStateAction<string | undefined>>;
  setOperation?: Dispatch<SetStateAction<string | undefined>>;
}

export interface ScreenshotsContextValue {
  store: ScreenshotsContextStore;
  dispatcher: ScreenshotsContextDispatcher;
}

/**
 * 空矩形列表复用同一个引用。
 * 吸附边用 useMemo 缓存、依赖这个数组，每次渲染新建一个会让缓存失效，
 * 指针每动一次都重算上千个坐标。
 */
export const EMPTY_BOUNDS: Bounds[] = [];

export default React.createContext<ScreenshotsContextValue>({
  store: {
    url: undefined,
    image: null,
    width: 0,
    height: 0,
    lang: zhCN,
    emitterRef: { current: {} },
    canvasContextRef: { current: null },
    history: {
      index: -1,
      stack: [],
    },
    bounds: null,
    windows: [],
    edges: [],
    cursor: 'move',
    operation: undefined,
  },
  dispatcher: {
    call: undefined,
    setHistory: undefined,
    setBounds: undefined,
    setCursor: undefined,
    setOperation: undefined,
  },
});
