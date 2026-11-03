/* eslint-disable no-console */
import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  systemPreferences,
} from 'electron';
import Screenshots from './index.js';
import { resolveResponsibleApp } from './screenPermission.js';

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
    <p id="perm" style="font-size: 12px; color: #666"></p>
    <script>
      document
        .getElementById('capture')
        .addEventListener('click', () => window.demo.startCapture());
      window.demo.onPerm((text) => {
        document.getElementById('perm').textContent = text;
      });
    </script>
  </body>
</html>`;

app.whenReady().then(() => {
  const screenshots = new Screenshots({
    lang: {
      operation_rectangle_title: '矩形2323',
    },
    singleWindow: true,
    /**
     * 打开 macOS 屏幕录制权限的引导。
     *
     * 这个权限**无法由程序申请**（`systemPreferences.askForMediaAccess` 只认
     * microphone/camera），只能把用户引导到系统设置；关掉的话未授权时点截图会
     * 什么都不发生，看起来像按钮坏了。演示程序开着，正好用来看这套流程长什么样。
     */
    promptScreenPermission: true,
    detectEdges: true,
  });
  /**
   * 渲染端 devtools 只在 `DEMO_DEVTOOLS=1` 时打开。
   *
   * 默认关掉：它是**独立窗口**，会一直浮在桌面上，截图时被原样拍进底图，
   * 截图窗口收掉之后也还在 —— 排查"截图里有残影"时它本身就是干扰项。
   */
  if (process.env.DEMO_DEVTOOLS === '1') {
    screenshots.$view.webContents.openDevTools();
  }

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

  /**
   * 把"系统认为的权限状态"和"TCC 认的责任进程"直接显示在演示窗口里。
   *
   * 屏幕录制权限被拒绝时，截图看起来"什么都没发生"，很难判断到底是没授权、
   * 授权记到了别的应用名下、还是判定逻辑出了错。这两条信息能一眼分清。
   */
  const permText = () => {
    const status = systemPreferences.getMediaAccessStatus('screen');
    const target = resolveResponsibleApp();
    return `屏幕录制权限：${status} · 责任进程：${
      target ? target.name : '未识别'
    }`;
  };
  mainWin.webContents.on('did-finish-load', () => {
    mainWin.webContents.send('demo:perm', permText());
  });
  setInterval(() => {
    if (!mainWin.isDestroyed()) {
      mainWin.webContents.send('demo:perm', permText());
    }
  }, 2000);

  /**
   * 防截屏模式：点截图先把宿主窗口 `hide()` 掉，截完/取消再显示回来。
   *
   * 这是宿主应用"截图里不能出现自己"的标准做法，也是**残影最容易出现的时序**：
   * `hide()` 到 `startCapture()` 之间只有几个微任务，WindowServer 还没把窗口
   * 从画面上摘掉，抓屏就会把宿主窗口一起拍进底图。库靠 `captureSettleMs`
   * （默认 50ms）挡这件事，这里正好用来复现/验证。
   *
   * `DEMO_KEEP_WINDOW=1` 可以关掉它，对比"不 hide"的行为。
   */
  const antiCapture = process.env.DEMO_KEEP_WINDOW !== '1';

  const startCapture = async () => {
    if (antiCapture) {
      mainWin.hide();
    }
    try {
      await screenshots.startCapture();
    } catch (err) {
      // 库现在会把"渲染端起不来 / 抓屏失败"这类错误抛出来（内部已回滚覆盖层），
      // 宿主必须接住并把藏起来的主窗口还回来，否则表现就是"点了截图，应用消失"。
      console.error('[demo] startCapture failed:', err);
      restoreHost();
    }
  };

  /** 截图结束（确定 / 取消 / 保存）后把宿主窗口还回来 */
  const restoreHost = () => {
    if (!mainWin.isDestroyed() && !mainWin.isVisible()) {
      mainWin.show();
    }
  };

  // 只接受演示窗口自己发来的消息
  ipcMain.on('demo:startCapture', (event) => {
    if (event.sender !== mainWin.webContents) {
      return;
    }
    void startCapture();
  });

  /**
   * 无头驱动：`DEMO_AUTO_CAPTURE=1` 时启动 1.5s 后自动走一遍"点击"的流程，
   * 方便用脚本验证这条时序，人不用去点按钮。
   */
  if (process.env.DEMO_AUTO_CAPTURE === '1') {
    setTimeout(() => {
      void startCapture();
    }, 1500);
  }

  // 防止不能关闭截图界面
  globalShortcut.register('ctrl+shift+q', () => {
    app.quit();
  });

  // 点击确定按钮回调事件
  screenshots.on('ok', (_event, buffer, bounds) => {
    console.log('capture', buffer, bounds);
    restoreHost();
  });
  /**
   * ESC 取消截图由库自己接管（截图中注册全局快捷键、收尾时注销），宿主不用再挂
   * `focus`/`blur` 去动态注册 —— 那套写法在"先 hide 主窗口再起截图"的打包路径上
   * 拿不到焦点，ESC 会静默失效。
   */
  // 点击取消按钮 / 按 ESC 回调事件
  screenshots.on('cancel', () => {
    console.log('capture', 'cancel1');
    screenshots.setLang({
      operation_ellipse_title: 'ellipse',
      operation_rectangle_title: 'rectangle',
    });
    restoreHost();
  });
  // 点击保存按钮回调事件
  screenshots.on('save', (_event, buffer, bounds) => {
    console.log('capture', buffer, bounds);
    restoreHost();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
