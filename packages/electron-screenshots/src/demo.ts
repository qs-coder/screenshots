/* eslint-disable no-console */
import { app, BrowserWindow, globalShortcut, ipcMain } from 'electron';
import Screenshots from './index.js';

const HOST_HTML = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>electron-screenshots demo</title>
    <style>
      body {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 24px;
        height: 100vh;
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        color: #333;
      }
      button {
        padding: 12px 32px;
        font-size: 16px;
        color: #fff;
        background: #1677ff;
        border: none;
        border-radius: 6px;
        cursor: pointer;
      }
      button:hover {
        background: #0958d9;
      }
      p {
        max-width: 480px;
        font-size: 13px;
        line-height: 1.7;
        text-align: center;
        color: #888;
      }
    </style>
  </head>
  <body>
    <button id="capture" type="button">开始截图</button>
    <p>
      截图进行中，鼠标移到其他屏幕会被半透明遮罩挡住（光标为 not-allowed）；
      Esc 取消截图，Ctrl+Shift+Q 退出。
    </p>
    <script>
      document
        .getElementById('capture')
        .addEventListener('click', () => window.demo.startCapture());
    </script>
  </body>
</html>`;

app.whenReady().then(() => {
  const screenshots = new Screenshots({
    lang: {
      operation_rectangle_title: '矩形2323',
    },
    singleWindow: true,
    promptScreenPermission: true,
  });
  screenshots.$view.webContents.openDevTools();

  const mainWin = new BrowserWindow({
    title: 'electron-screenshots demo',
    width: 900,
    height: 640,
    show: true,
    webPreferences: {
      preload: require.resolve('./demoPreload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  mainWin.removeMenu();
  mainWin.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(HOST_HTML)}`,
  );

  // 只接受演示窗口自己发来的消息
  ipcMain.on('demo:startCapture', (event) => {
    if (event.sender !== mainWin.webContents) {
      return;
    }
    screenshots.startCapture();
  });

  screenshots.on('windowCreated', ($win) => {
    $win.on('focus', () => {
      globalShortcut.register('esc', () => {
        if ($win?.isFocused()) {
          screenshots.endCapture();
        }
      });
    });

    $win.on('blur', () => {
      globalShortcut.unregister('esc');
    });
  });

  // 防止不能关闭截图界面
  globalShortcut.register('ctrl+shift+q', () => {
    app.quit();
  });

  // 点击确定按钮回调事件
  screenshots.on('ok', (_event, buffer, bounds) => {
    console.log('capture', buffer, bounds);
  });
  // 点击取消按钮回调事件
  screenshots.on('cancel', () => {
    console.log('capture', 'cancel1');
    screenshots.setLang({
      operation_ellipse_title: 'ellipse',
      operation_rectangle_title: 'rectangle',
    });
  });
  // 点击保存按钮回调事件
  screenshots.on('save', (_event, buffer, bounds) => {
    console.log('capture', buffer, bounds);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
