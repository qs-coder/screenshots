import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('demo', {
  startCapture: () => {
    ipcRenderer.send('demo:startCapture');
  },
  /** 主进程推来的权限状态文本，直接显示在演示窗口里 */
  onPerm: (callback: (text: string) => void) => {
    ipcRenderer.on('demo:perm', (_event, text: string) => {
      callback(text);
    });
  },
});
