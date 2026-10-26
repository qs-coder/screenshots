/* eslint-disable no-console */
import { contextBridge, type IpcRendererEvent, ipcRenderer } from 'electron';
import type { Display } from './getDisplay.js';

type IpcRendererListener = (
  event: IpcRendererEvent,
  ...args: unknown[]
) => void;
type ScreenshotsListener = (...args: unknown[]) => void;

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenshotsData {
  bounds: Bounds;
  display: Display;
}

const map = new Map<ScreenshotsListener, Record<string, IpcRendererListener>>();

contextBridge.exposeInMainWorld('screenshots', {
  start: () => {
    console.log('contextBridge start');
    ipcRenderer.send('SCREENSHOTS:start');
  },
  stop: () => {
    console.log('contextBridge stop');
    ipcRenderer.send('SCREENSHOTS:stop');
  },
  ready: () => {
    console.log('contextBridge ready');

    ipcRenderer.send('SCREENSHOTS:ready');
  },
  reset: () => {
    console.log('contextBridge reset');

    ipcRenderer.send('SCREENSHOTS:reset');
  },
  /**
   * 请求光标邻域的原生分辨率元素识别，结果从 `on('edges-precise')` 回来。
   * 只有主进程开了 detectEdges 才有响应。
   */
  edgeRegion: (region: Bounds) => {
    ipcRenderer.send('SCREENSHOTS:edgeRegion', region);
  },
  save: (arrayBuffer: ArrayBuffer, data: ScreenshotsData) => {
    console.log('contextBridge save', arrayBuffer, data);

    ipcRenderer.send('SCREENSHOTS:save', Buffer.from(arrayBuffer), data);
  },
  cancel: () => {
    console.log('contextBridge cancel');

    ipcRenderer.send('SCREENSHOTS:cancel');
  },
  ok: (arrayBuffer: ArrayBuffer, data: ScreenshotsData) => {
    console.log('contextBridge ok', arrayBuffer, data);

    ipcRenderer.send('SCREENSHOTS:ok', Buffer.from(arrayBuffer), data);
  },
  on: (channel: string, fn: ScreenshotsListener) => {
    console.log('contextBridge on', fn);

    const listener = (_event: IpcRendererEvent, ...args: unknown[]) => {
      console.log('contextBridge on', channel, fn, ...args);
      fn(...args);
    };

    const listeners = map.get(fn) ?? {};
    listeners[channel] = listener;
    map.set(fn, listeners);

    ipcRenderer.on(`SCREENSHOTS:${channel}`, listener);
  },
  off: (channel: string, fn: ScreenshotsListener) => {
    console.log('contextBridge off', fn);

    const listeners = map.get(fn) ?? {};
    const listener = listeners[channel];
    delete listeners[channel];

    if (!listener) {
      return;
    }

    ipcRenderer.off(`SCREENSHOTS:${channel}`, listener);
  },
});
