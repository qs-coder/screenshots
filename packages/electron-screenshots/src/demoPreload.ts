import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('demo', {
  startCapture: () => {
    ipcRenderer.send('demo:startCapture');
  },
});
