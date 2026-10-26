import { Display } from './electron/app';
import { Bounds } from './Screenshots/types';

type ScreenshotsListener = (...args: never[]) => void;

interface ScreenshotsData {
  bounds: Bounds;
  display: Display;
}

interface GlobalScreenshots {
  start: () => void;
  stop: () => void;
  ready: () => void;
  reset: () => void;
  /** 请求光标邻域的原生分辨率识别，结果走 `on('edges-precise')`；非 Electron 环境可以没有 */
  edgeRegion?: (region: Bounds) => void;
  save: (arrayBuffer: ArrayBuffer, data: ScreenshotsData) => void;
  cancel: () => void;
  ok: (arrayBuffer: ArrayBuffer, data: ScreenshotsData) => void;
  on: (channel: string, fn: ScreenshotsListener) => void;
  off: (channel: string, fn: ScreenshotsListener) => void;
}

declare global {
  interface Window {
    screenshots: GlobalScreenshots;
  }
}
