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
   * 新一张截图已经画到屏幕上。
   * 主进程换屏时要等这个回执才搬窗口，否则窗口落地的头几帧是空/旧内容，看着就是闪一下。
   */
  painted: () => {
    ipcRenderer.send('SCREENSHOTS:painted');
  },
  /**
   * 某块屏的底图已经解码好、放进渲染端缓存了。
   *
   * 主进程据此知道"这块屏换过去不用等解码"，换屏就能直接换图不等绘制。
   * 见 `Screenshots#preloadRenderer`。
   */
  preloaded: (displayId: number) => {
    ipcRenderer.send('SCREENSHOTS:preloaded', displayId);
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
