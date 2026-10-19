import Events from 'node:events';
import debug, { type Debugger } from 'debug';
import {
  BrowserView,
  BrowserWindow,
  clipboard,
  type DesktopCapturerSource,
  desktopCapturer,
  dialog,
  ipcMain,
  nativeImage,
  screen,
  shell,
  systemPreferences,
} from 'electron';
import fs from 'fs-extra';
import Event from './event.js';
import getDisplay, { type Display } from './getDisplay.js';
import getWindows from './getWindows.js';
import padStart from './padStart.js';
import type { Bounds, ScreenshotsData } from './preload.js';

export type LoggerFn = (...args: unknown[]) => void;
export type Logger = Debugger | LoggerFn;

export interface Lang {
  magnifier_position_label?: string;
  operation_ok_title?: string;
  operation_cancel_title?: string;
  operation_save_title?: string;
  operation_redo_title?: string;
  operation_undo_title?: string;
  operation_mosaic_title?: string;
  operation_text_title?: string;
  operation_brush_title?: string;
  operation_arrow_title?: string;
  operation_ellipse_title?: string;
  operation_rectangle_title?: string;
}

export interface ScreenshotsOpts {
  lang?: Lang;
  logger?: Logger;
  singleWindow?: boolean;
  /**
   * macOS 上屏幕录制未授权时，弹窗引导用户前往系统设置，并**中止本次截图**。
   *
   * 未授权期间每次触发都会提示并中止，直到用户完成授权（授权后需重启应用）。
   *
   * 默认 false：库不应该擅自给所有消费者弹窗和拦截图，宿主应用自己决定要不要这套引导。
   */
  promptScreenPermission?: boolean;
}

export type { Bounds };

const windowTypes: Record<string, string | undefined> = {
  darwin: 'panel',
  // linux 必须设置为 undefined，否则会在部分系统上不能触发focus 事件
  // https://github.com/nashaofu/screenshots/issues/203#issuecomment-1518923486
  linux: undefined,
  win32: 'toolbar',
};

// 屏蔽窗口只需要一个 not-allowed 光标，画面本体由窗口的半透明黑底提供
const BLOCK_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{position:fixed;top:0;right:0;bottom:0;left:0;margin:0;overflow:hidden;cursor:not-allowed}</style></head><body></body></html>`;

export default class Screenshots extends Events {
  // 截图窗口对象
  public $win: BrowserWindow | null = null;

  public $view: BrowserView = new BrowserView({
    webPreferences: {
      preload: require.resolve('./preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  private logger: Logger;

  private singleWindow: boolean;

  private isPromptScreenPermission: boolean;

  /**
   * 截图进行中标记。endCapture 里主动 blur 时它已被置 false，
   * 避免 blur 监听器又把焦点抢回来。
   */
  private capturing = false;

  /** 保存对话框期间不能抢焦点、不能重新置顶 */
  private isDialogOpen = false;

  /** 非活动屏幕上的屏蔽窗口，key 为 display.id */
  private $blockWins = new Map<number, BrowserWindow>();

  private isReady = new Promise<void>((resolve) => {
    ipcMain.once('SCREENSHOTS:ready', () => {
      this.logger('SCREENSHOTS:ready');

      resolve();
    });
  });

  private screenWatcher: {
    currentDisplay: Display;
    timer: any;
    watching: boolean;
  } = {
      currentDisplay: null as unknown as Display,
      timer: null,
      watching: false,
    };

  constructor(opts?: ScreenshotsOpts) {
    super();
    this.logger = opts?.logger || debug('electron-screenshots');
    this.singleWindow = opts?.singleWindow || false;
    this.isPromptScreenPermission = opts?.promptScreenPermission || false;
    this.listenIpc();
    this.$view.webContents.loadURL(
      `file://${require.resolve('@qs-coder/react-screenshots/dist/electron.html')}`,
    );
    if (opts?.lang) {
      this.setLang(opts.lang);
    }
  }

  /**
   * 开始截图
   */
  /**
   * macOS 的屏幕录制权限无法由程序申请（`systemPreferences.askForMediaAccess`
   * 只接受 microphone/camera），只能把人引导到系统设置里，所以这里只提示。
   *
   * 必须在截图窗口创建之前弹：截图窗口有失焦即抢回焦点的逻辑，
   * 应用级模态框会被它压下去，用户根本点不到。
   *
   * 未授权期间每次触发截图都会提示并中止，直到用户完成授权——
   * 否则按钮看起来像没反应，比反复一个弹窗更难排查。
   *
   * @returns true 表示尚未授权（已弹出引导），本次截图应该中止
   */
  private async promptScreenPermission(): Promise<boolean> {
    if (!this.isPromptScreenPermission || process.platform !== 'darwin') {
      return false;
    }

    const status = systemPreferences.getMediaAccessStatus('screen');
    if (status === 'granted') {
      return false;
    }
    this.logger('屏幕录制权限 %s，窗口识别与锁边不可用', status);

    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: '开启窗口识别',
      message: '窗口的屏幕录制权限还没授予，本次截图已取消。',
      detail: `${status === 'denied' ? '权限此前已被拒绝，' : ''}请在「系统设置 → 隐私与安全性 → 屏幕录制」中勾选本应用，授权后重启应用，再截一次图就会有窗口识别与自动锁边。`,
      buttons: ['打开系统设置', '知道了'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response === 0) {
      await shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
      );
    }
    return true;
  }

  public async startCapture(): Promise<void> {
    this.logger('startCapture');

    const startedAt = performance.now();
    let prev = startedAt;
    const mark = (label: string) => {
      const now = performance.now();
      const cost = Math.round(now - prev);
      prev = now;
      this.logger(
        'startCapture %s +%dms (total %dms)',
        label,
        cost,
        Math.round(now - startedAt),
      );
    };

    const display = getDisplay();
    mark('getDisplay');

    if (await this.promptScreenPermission()) {
      // 已经引导用户去授权，本次截图直接中止（此时还没创建任何窗口，干净退出）
      // 用户授权并重启应用后，再点一次截图就是完整的窗口识别效果
      mark('abort(等待屏幕录制授权)');
      return;
    }
    mark('promptScreenPermission');

    const [imageUrl] = await Promise.all([this.capture(display), this.isReady]);
    mark('capture');

    // 窗口识别与锁边的数据源，拿不到就是空数组
    const windows = await getWindows(display);
    mark(`windows(${windows.length})`);
    this.logger('窗口坐标（前两个）%o', windows.slice(0, 2));
    if (!windows.length) {
      // 空列表几乎都是权限问题，不说清楚的话排查成本极高
      // （未授权时截图依然能"出图"，但图里只有壁纸，所以"截图能用"推不出"有权限"）
      const reason =
        process.platform === 'darwin'
          ? `screen access=${systemPreferences.getMediaAccessStatus('screen')}`
          : process.platform === 'linux'
            ? 'Linux 仅支持 X11，Wayland 会话下系统不向其他进程暴露窗口几何'
            : '请检查窗口枚举结果是否被安全软件拦截';
      this.logger('窗口识别不可用（空列表）%s', reason);
    }

    this.capturing = true;

    await this.createWindow(display);
    mark('createWindow');

    this.$view.webContents.send(
      'SCREENSHOTS:capture',
      display,
      imageUrl,
      windows,
    );
    mark('send capture');

    // 屏蔽其他屏幕，截图期间点不到别的地方
    this.syncBlockWindows(display);

    // 跟手换屏（与微信、Snipaste 一致），否则扩展屏永远切不过去。
    // 按下鼠标时渲染端会发 SCREENSHOTS:start 停掉监听，此时其他屏幕就被屏蔽窗口锁住。
    this.startScreenWatcher(display);
  }

  private startScreenWatcher(initialDisplay: Display) {
    if (this.screenWatcher.watching) return;

    this.screenWatcher.currentDisplay = initialDisplay;
    this.screenWatcher.watching = true;

    const checkScreen = async () => {
      if (!this.screenWatcher.watching || !this.$win || this.$win.isDestroyed()) {
        this.stopScreenWatcher();
        return;
      }

      const point = screen.getCursorScreenPoint();
      const newDisplay = screen.getDisplayNearestPoint(point);

      if (newDisplay.id !== this.screenWatcher.currentDisplay.id) {
        const display: Display = {
          id: newDisplay.id,
          x: Math.floor(newDisplay.bounds.x),
          y: Math.floor(newDisplay.bounds.y),
          width: Math.floor(newDisplay.bounds.width),
          height: Math.floor(newDisplay.bounds.height),
          scaleFactor: newDisplay.scaleFactor,
        };

        this.screenWatcher.currentDisplay = display;

        // 预加载新屏幕的截图
        const imageUrl = await this.capture(display);

        // 更新窗口和视图
        this.$win.setBounds(display);
        this.$view.setBounds({
          x: 0,
          y: 0,
          width: display.width,
          height: display.height,
        });

        // 发送新的截图数据
        this.$view.webContents.send(
          'SCREENSHOTS:capture',
          display,
          imageUrl,
          await getWindows(display),
        );

        // 活动屏幕变了，屏蔽窗口跟着换
        this.syncBlockWindows(display);
      }

      // 使用 requestAnimationFrame 的思想控制检查频率
      this.screenWatcher.timer = setTimeout(checkScreen, 100);
    };

    checkScreen();
  }

  private stopScreenWatcher() {
    if (this.screenWatcher.timer) {
      clearTimeout(this.screenWatcher.timer);
      this.screenWatcher.timer = null;
    }
    this.screenWatcher.watching = false;
  }

  /**
   * 结束截图
   */
  public async endCapture(): Promise<void> {
    this.logger('endCapture');
    // 停止屏幕监听
    this.stopScreenWatcher();
    this.capturing = false;
    this.destroyBlockWindows();
    await this.reset();

    if (!this.$win) {
      return;
    }

    // 先清除 Kiosk 模式，然后取消全屏才有效
    this.$win.setKiosk(false);
    this.$win.blur();
    this.$win.blurWebView();
    this.$win.unmaximize();
    this.$win.removeBrowserView(this.$view);

    if (this.singleWindow) {
      this.$win.hide();
    } else {
      this.$win.destroy();
    }
  }

  /**
   * 设置语言
   */
  public async setLang(lang: Partial<Lang>): Promise<void> {
    this.logger('setLang', lang);

    await this.isReady;

    this.$view.webContents.send('SCREENSHOTS:setLang', lang);
  }

  private async reset() {
    // 重置截图区域
    this.$view.webContents.send('SCREENSHOTS:reset');

    const startedAt = performance.now();
    // 保证 UI 有足够的时间渲染
    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout;
      const done = () => {
        clearTimeout(timer);
        ipcMain.removeListener('SCREENSHOTS:reset', done);
        resolve();
      };

      timer = setTimeout(done, 500);
      ipcMain.on('SCREENSHOTS:reset', done);
    });

    this.logger(
      'reset wait renderer %dms',
      Math.round(performance.now() - startedAt),
    );
  }

  /**
   * 初始化窗口
   */
  private async createWindow(display: Display): Promise<void> {
    const time = performance.now();
    // 重置截图区域
    await this.reset();

    // 复用未销毁的窗口
    if (!this.$win || this.$win?.isDestroyed?.()) {
      this.$win = new BrowserWindow({
        title: 'screenshots',
        x: display.x,
        y: display.y,
        width: display.width,
        height: display.height,
        useContentSize: true,
        type: windowTypes[process.platform] as string,
        frame: false,
        show: false,
        autoHideMenuBar: true,
        transparent: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        // focusable 必须设置为 true, 否则窗口不能及时响应esc按键，输入框也不能输入
        focusable: true,
        skipTaskbar: true,
        alwaysOnTop: true,
        /**
         * linux 下必须设置为false，否则不能全屏显示在最上层
         * mac 下设置为false，否则可能会导致程序坞不恢复问题，且与 kiosk 模式冲突
         */
        fullscreen: false,
        // mac fullscreenable 设置为 true 会导致应用崩溃
        fullscreenable: false,
        kiosk: true,
        backgroundColor: '#00000000',
        titleBarStyle: 'hidden',
        hasShadow: false,
        paintWhenInitiallyHidden: false,
        // mac 特有的属性
        roundedCorners: false,
        enableLargerThanScreen: false,
        acceptFirstMouse: true,
      });

      this.emit('windowCreated', this.$win);
      this.$win.on('show', () => {
        // 先完成 kiosk 过渡,再断言置顶,最后抢焦点
        // 原顺序 focus()->setKiosk(true) 会在窗口已可见但置顶/焦点尚未最终断言时
        // 留出脆弱窗口期,Windows 上偶发层级不在最上
        this.$win?.setKiosk(true);
        this.assertTopMost(this.$win);
        this.$win?.focus();
      });

      this.$win.on('closed', () => {
        this.emit('windowClosed', this.$win);
        this.$win = null;
        // 屏蔽窗口不可聚焦、也不在任务栏，宿主直接 close 截图窗口时必须一起收掉，
        // 否则会留下一层用户点不掉的黑色遮罩
        this.destroyBlockWindows();
      });

      /**
       * Windows 任务栏本身是 topmost 窗口，level 低于 pop-up-menu 的窗口会被它盖住；
       * 加上 skipTaskbar 之后截图窗口沉底就没有任何入口点回来了，看起来像"截图丢了"。
       * 所以截图进行中一旦失焦/被最小化，立刻重新置顶并抢回焦点。
       */
      if (process.platform === 'win32') {
        this.$win.on('blur', () => {
          const $win = this.$win;
          if (
            !this.capturing ||
            this.isDialogOpen ||
            !$win ||
            $win.isDestroyed() ||
            !$win.isVisible() ||
            $win.isFocused()
          ) {
            return;
          }
          this.logger('SCREENSHOTS:blur, 重新置顶并抢回焦点');
          this.assertTopMost($win);
          $win.focus();
        });

        this.$win.on('minimize', () => {
          if (this.capturing && !this.isDialogOpen) {
            this.$win?.restore();
          }
        });
      }
    }

    this.$win.setBrowserView(this.$view);

    // 适定平台
    if (process.platform === 'darwin') {
      this.$win.setWindowButtonVisibility(false);
    }

    if (process.platform !== 'win32') {
      this.$win.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true,
      });
    }

    this.$win.blur();
    this.$win.setBounds(display);
    this.$view.setBounds({
      x: 0,
      y: 0,
      width: display.width,
      height: display.height,
    });
    this.assertTopMost(this.$win);
    this.$win.show();
    this.logger(
      'createWindow 耗时 %dms (含 reset)',
      Math.round(performance.now() - time),
    );
  }

  /**
   * 断言窗口在最上层。
   *
   * Windows 上 level 从 floating 到 status 的窗口都排在任务栏之下，只有 pop-up-menu
   * 及以上才在任务栏之上，所以这里用 screen-saver 层级压住任务栏。
   * https://www.electronjs.org/docs/latest/api/browser-window#winsetalwaysontopflag-level-relativellevel
   */
  private assertTopMost($win: BrowserWindow | null): void {
    if (!$win || $win.isDestroyed()) {
      return;
    }
    if (process.platform === 'win32') {
      $win.setAlwaysOnTop(true, 'screen-saver');
      $win.moveTop();
      return;
    }
    $win.setAlwaysOnTop(true);
  }

  /**
   * 在非活动屏幕上创建/移除屏蔽窗口。
   *
   * 截图期间鼠标还能划到别的显示器去点其他程序，这里用一层半透明黑底 + not-allowed
   * 光标把那些屏幕盖住，让点击全部落在自己窗口上。
   * Wayland 下无法定位窗口，Linux 统一跳过。
   */
  private syncBlockWindows(activeDisplay: Display): void {
    if (process.platform === 'linux') {
      return;
    }

    for (const [id, $win] of this.$blockWins) {
      if (id === activeDisplay.id || $win.isDestroyed()) {
        this.$blockWins.delete(id);
        if (!$win.isDestroyed()) {
          $win.destroy();
        }
      }
    }

    for (const display of screen.getAllDisplays()) {
      if (display.id === activeDisplay.id || this.$blockWins.has(display.id)) {
        continue;
      }

      const $win = new BrowserWindow({
        title: 'screenshots-blocker',
        x: Math.floor(display.bounds.x),
        y: Math.floor(display.bounds.y),
        width: Math.floor(display.bounds.width),
        height: Math.floor(display.bounds.height),
        useContentSize: true,
        type: windowTypes[process.platform] as string,
        frame: false,
        show: false,
        transparent: false,
        /**
         * 必须可聚焦：focusable: false 的窗口在 macOS 上不会把鼠标事件交给渲染进程，
         * 光标样式因此一直是默认箭头。被点到就立刻把焦点还给截图窗口即可。
         */
        focusable: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        fullscreen: false,
        fullscreenable: false,
        backgroundColor: '#000000',
        opacity: 0.5,
        hasShadow: false,
      });

      this.$blockWins.set(display.id, $win);
      $win.on('closed', () => {
        this.$blockWins.delete(display.id);
      });

      // 屏蔽窗口必须可聚焦光标才会更新，所以它一拿到焦点就立刻还给截图窗口
      $win.on('focus', () => {
        if (this.capturing) {
          this.$win?.focus();
        }
      });

      $win.webContents.on('did-finish-load', () => {
        if (!$win.isDestroyed()) {
          this.assertTopMost($win);
          $win.show();
          this.logger('SCREENSHOTS:block show display %d', display.id);
        }
      });
      $win.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(BLOCK_HTML)}`,
      );
    }
  }

  private destroyBlockWindows(): void {
    for (const $win of this.$blockWins.values()) {
      if (!$win.isDestroyed()) {
        $win.destroy();
      }
    }
    this.$blockWins.clear();
  }

  private async capture(display: Display): Promise<string> {
    this.logger('SCREENSHOTS:capture');

    try {
      let time = performance.now();
      const { Monitor } = await import('node-screenshots');
      const importCost = Math.round(performance.now() - time);
      time = performance.now();

      let point = {
        x: display.x + display.width / 2,
        y: display.y + display.height / 2,
      };
      if (process.platform === 'win32') {
        point = screen.screenToDipPoint(point);
      }
      const monitor = Monitor.fromPoint(point.x, point.y);
      const fromPointCost = Math.round(performance.now() - time);
      time = performance.now();
      this.logger(
        'SCREENSHOTS:capture Monitor.fromPoint arguments %o',
        display,
      );
      this.logger('SCREENSHOTS:capture Monitor.fromPoint return %o', {
        id: monitor?.id,
        name: monitor?.name,
        x: monitor?.x,
        y: monitor?.y,
        width: monitor?.width,
        height: monitor?.height,
        rotation: monitor?.rotation,
        scaleFactor: monitor?.scaleFactor,
        frequency: monitor?.frequency,
        isPrimary: monitor?.isPrimary,
      });

      if (!monitor) {
        throw new Error(`Monitor.fromDisplay(${display.id}) get null`);
      }

      const image = await monitor.captureImage();
      const imageCost = Math.round(performance.now() - time);
      time = performance.now();

      const buffer = await image.toPng(true);
      const pngCost = Math.round(performance.now() - time);
      time = performance.now();

      const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
      this.logger(
        'SCREENSHOTS:capture 耗时 import %dms fromPoint %dms captureImage %dms toPng %dms base64 %dms png %dKB',
        importCost,
        fromPointCost,
        imageCost,
        pngCost,
        Math.round(performance.now() - time),
        Math.round(buffer.length / 1024),
      );
      return dataUrl;
    } catch (err) {
      this.logger('SCREENSHOTS:capture Monitor capture() error %o', err);
      const time = performance.now();
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width: Math.floor(display.width * display.scaleFactor),
          height: Math.floor(display.height * display.scaleFactor),
        },
      });
      this.logger(
        'SCREENSHOTS:capture 耗时 desktopCapturer.getSources %dms',
        Math.round(performance.now() - time),
      );

      let source: DesktopCapturerSource | undefined;
      // Linux系统上，screen.getDisplayNearestPoint 返回的 Display 对象的 id
      // 和这里 source 对象上的 display_id(Linux上，这个值是空字符串) 或 id 的中间部分，都不一致
      // 但是，如果只有一个显示器的话，其实不用判断，直接返回就行
      if (sources.length === 1) {
        [source] = sources;
      } else {
        // 策略1: 通过 display_id 或 id 匹配
        source = sources.find(
          (item) =>
            item.display_id === display.id.toString() ||
            item.id.startsWith(`screen:${display.id}:`),
        );

        // 策略2: 如果ID匹配失败，通过thumbnail尺寸匹配（适用于Win7等系统）
        // 因为thumbnailSize是根据display尺寸设置的，匹配的source应该有相同的尺寸
        if (!source) {
          const expectedWidth = display.width * display.scaleFactor;
          const expectedHeight = display.height * display.scaleFactor;
          source = sources.find((item) => {
            if (!item.thumbnail) return false;
            const size = item.thumbnail.getSize();
            // 允许小误差（1像素）处理舍入问题
            return Math.abs(size.width - expectedWidth) <= 1
              && Math.abs(size.height - expectedHeight) <= 1;
          });
        }

        // 策略3: 如果尺寸匹配也失败，在Windows系统上通过cursor位置匹配
        if (!source && process.platform === 'win32') {
          const cursorPoint = screen.getCursorScreenPoint();
          const nearestDisplay = screen.getDisplayNearestPoint(cursorPoint);
          // 如果当前display是cursor所在的显示器，尝试通过name匹配或使用第一个source
          if (nearestDisplay.id === display.id) {
            // 某些系统上，source的name可能包含显示器信息
            source = sources.find((item) => item.name && item.name.includes(display.id.toString()));
            // 如果name匹配也失败，使用第一个source作为fallback
            if (!source) {
              [source] = sources;
            }
          }
        }

        // 策略4: 最后的fallback - 如果所有匹配都失败，使用第一个source
        // 这在单显示器系统或匹配逻辑完全失败时至少能工作
        if (!source && sources.length > 0) {
          [source] = sources;
        }
      }

      if (!source) {
        this.logger(
          "SCREENSHOTS:capture Can't find screen source. sources: %o, display: %o",
          sources,
          display,
        );
        throw new Error("Can't find screen source");
      }

      return source.thumbnail.toDataURL();
    }
  }

  /**
   * 绑定ipc时间处理
   */
  private listenIpc(): void {
    /**
     * 开始截图窗口，停止屏幕监听
     */
    ipcMain.on('SCREENSHOTS:start', () => {
      this.logger('SCREENSHOTS:start');
      this.stopScreenWatcher();
    });

    /**
     * 停止截图窗口，重新开启屏幕监听
     */
    ipcMain.on('SCREENSHOTS:stop', () => {
      this.logger('SCREENSHOTS:stop');
      this.stopScreenWatcher();
      this.startScreenWatcher(getDisplay());
    });
    /**
     * OK事件
     */
    ipcMain.on(
      'SCREENSHOTS:ok',
      (_event, buffer: Buffer, data: ScreenshotsData) => {
        this.logger(
          'SCREENSHOTS:ok buffer.length %d, data: %o',
          buffer.length,
          data,
        );

        const event = new Event();
        this.emit('ok', event, buffer, data);
        if (event.defaultPrevented) {
          return;
        }
        clipboard.writeImage(nativeImage.createFromBuffer(buffer));
        this.endCapture();
      },
    );
    /**
     * CANCEL事件
     */
    ipcMain.on('SCREENSHOTS:cancel', () => {
      this.logger('SCREENSHOTS:cancel');

      const event = new Event();
      this.emit('cancel', event);
      if (event.defaultPrevented) {
        return;
      }
      this.endCapture();
    });

    /**
     * SAVE事件
     */
    ipcMain.on(
      'SCREENSHOTS:save',
      async (_event, buffer: Buffer, data: ScreenshotsData) => {
        this.logger(
          'SCREENSHOTS:save buffer.length %d, data: %o',
          buffer.length,
          data,
        );

        const event = new Event();
        this.emit('save', event, buffer, data);
        if (event.defaultPrevented || !this.$win) {
          return;
        }

        const time = new Date();
        const year = time.getFullYear();
        const month = padStart(time.getMonth() + 1, 2, '0');
        const date = padStart(time.getDate(), 2, '0');
        const hours = padStart(time.getHours(), 2, '0');
        const minutes = padStart(time.getMinutes(), 2, '0');
        const seconds = padStart(time.getSeconds(), 2, '0');
        const milliseconds = padStart(time.getMilliseconds(), 3, '0');

        this.isDialogOpen = true;
        this.$win.setAlwaysOnTop(false);

        const { canceled, filePath } = await dialog
          .showSaveDialog(this.$win, {
            defaultPath: `${year}${month}${date}${hours}${minutes}${seconds}${milliseconds}.png`,
            filters: [
              { name: 'Image (png)', extensions: ['png'] },
              { name: 'All Files', extensions: ['*'] },
            ],
          })
          .finally(() => {
            this.isDialogOpen = false;
          });

        if (!this.$win) {
          this.emit('afterSave', new Event(), buffer, data, false); // isSaved = false
          return;
        }

        this.assertTopMost(this.$win);
        if (canceled || !filePath) {
          this.emit('afterSave', new Event(), buffer, data, false); // isSaved = false
          return;
        }

        await fs.writeFile(filePath, buffer);
        this.emit('afterSave', new Event(), buffer, data, true); // isSaved = true
        this.endCapture();
      },
    );
  }
}
