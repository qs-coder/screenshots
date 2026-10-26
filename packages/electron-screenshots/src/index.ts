import Events from 'node:events';
import debug, { type Debugger } from 'debug';
import type { Image as ShotImage } from 'node-screenshots';
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
import getEdges, {
  getPreciseEdges,
  type EdgeThresholds,
  type Pixels,
  type Region,
} from './getEdges.js';
import { isEdgesDebugEnabled, writeEdgesDebugImage } from './edgesDebug.js';
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
  /**
   * 元素级自动框选：截图窗口显示之后，在 worker 线程里用截图像素（`edge_det`）
   * 识别界面里的元素矩形（按钮、卡片、输入框等），作为 hover 拾取的兜底边源。
   *
   * 与窗口识别**并存**，拾取顺序由渲染端保证：光标落在某个系统窗口里（含窗口边框那 1px）就整窗选中，
   * 只有落在窗口之外（桌面控件、Wayland、macOS 未授权）才用元素矩形。
   * 像素法只能看到"露出来的那部分"，被别的窗口压住的下边界它检不出来，
   * 所以整窗永远以窗口数据为准；吸附同理只认窗口的边（元素边太碎），`windows` 为空时才由元素边顶上。
   *
   * 默认 false：多一个 WASM 依赖，且每次截图在后台多花几十到几百毫秒（不阻塞截图窗口显示）。
   * 另注意 macOS 未授予屏幕录制权限时，截图像素里根本没有其他应用的内容，
   * 开了也只能得到壁纸碎块。
   */
  detectEdges?: boolean;
  /**
   * 元素识别的 Canny 双阈值，默认 `{ low: 20, high: 60 }`。
   * 浅色低对比的界面（灰底白卡）识别不出来就往下调，壁纸噪声太多就往上调。
   * 只在 `detectEdges` 开启时生效。
   */
  edgeThresholds?: { low?: number; high?: number };
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

  private isDetectEdges: boolean;

  private edgeThresholds: EdgeThresholds | undefined;

  /**
   * 每次下发截图都自增。元素检测是异步的，靠它判断结果还对不对应当前这张图。
   */
  private captureSeq = 0;

  /**
   * 当前这张截图的像素缓存，邻域精修要用。
   *
   * 精修是渲染端 hover 时按需发起的，同一个 worker 入口要能反复调用，
   * 所以这里留住像素、endCapture 时释放；不复用 `toPixels` 的返回值是因为它每次拷一份。
   * 必须连 `display` 一起存：精修要用这份像素所在屏的原点和缩放比，
   * 而 `getDisplay()` 返回的是**光标当前所在**的屏，跟手换屏时两者会错位。
   */
  private edgeSource: { pixels: Pixels; display: Display } | undefined;

  /** 本轮枚举到的系统窗口矩形，只给调试图画框用（识别结果本身走 `SCREENSHOTS:windows`） */
  private captureWindows: Bounds[] = [];

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
    this.isDetectEdges = opts?.detectEdges || false;
    this.edgeThresholds = opts?.edgeThresholds;
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

    // 建窗口里的 reset 要等渲染端回执，所以先把渲染端就绪排在最前面（通常应用启动时就已 resolve）
    await this.isReady;
    mark('isReady');

    /**
     * "先锁定屏幕"的关键：截屏+编码 与 建窗口（含 reset 等待）互不依赖，并行做，
     * 于是第一帧出现的时间约等于 captureImage + toPng，而不是两者相加。
     */
    const [shot, $win] = await Promise.all([
      this.capture(display),
      this.createWindow(display),
    ]);
    mark('capture + createWindow');

    this.capturing = true;

    const seq = ++this.captureSeq;
    this.$view.webContents.send('SCREENSHOTS:capture', display, shot.png);
    /**
     * 拿到图才显示，而不是先显示一个空层再等图。
     * 窗口是透明的，提前 show 只会让这段空档里桌面点不动、焦点还被抢走。
     */
    $win.show();
    mark('send capture');

    /**
     * 两个拾取源都必须排在显示之后，而且要**先窗口后元素**，见 `sendWindowsThenEdges`。
     */
    void this.sendWindowsThenEdges(shot, display, seq);

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
        const shot = await this.capture(display);

        // 更新窗口和视图
        this.$win.setBounds(display);
        this.$view.setBounds({
          x: 0,
          y: 0,
          width: display.width,
          height: display.height,
        });

        // 发送新的截图数据（两个拾取源随后走独立通道，和首次截图一样先锁屏）
        const seq = ++this.captureSeq;
        this.$view.webContents.send('SCREENSHOTS:capture', display, shot.png);
        // 换屏后重新识别，旧的矩形会被 captureSeq 丢掉
        void this.sendWindowsThenEdges(shot, display, seq);

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
    // 22MB 级别的像素缓存，截图结束就放手，别占着宿主的内存
    this.edgeSource = undefined;
    this.captureWindows = [];
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
  private async createWindow(display: Display): Promise<BrowserWindow> {
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
    this.logger(
      'createWindow 耗时 %dms (含 reset)',
      Math.round(performance.now() - time),
    );
    return this.$win;
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

  private async capture(
    display: Display,
  ): Promise<{ png: Buffer; image?: ShotImage | undefined }> {
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

      this.logger(
        'SCREENSHOTS:capture 耗时 import %dms fromPoint %dms captureImage %dms toPng %dms png %dKB',
        importCost,
        fromPointCost,
        imageCost,
        pngCost,
        Math.round(buffer.length / 1024),
      );
      return { png: buffer, image };
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

      // 兜底路径拿不到 RGBA，元素检测只能跳过
      return { png: source.thumbnail.toPNG() };
    }
  }

  /**
   * 两个拾取源的下发顺序。渲染端把 `windows` 为空理解成"这台机器/这个平台拿不到窗口几何"，
   * 于是拾取和吸附都改由元素矩形顶上；所以这两条通道**不能并行**，必须等窗口那批先到，
   * 否则元素矩形抢先到达的那几十毫秒里，光标压在窗口上会被切成一堆碎框
   * （拖框也会被窗口内部的卡片边吸住）—— 0.7.0 没有这个问题，因为窗口矩形和截图在同一个载荷里。
   */
  private async sendWindowsThenEdges(
    shot: { image?: ShotImage | undefined },
    display: Display,
    seq: number,
  ): Promise<void> {
    await this.sendWindows(display, seq);
    if (this.isDetectEdges) {
      await this.detectEdges(shot, display, seq);
    }
  }

  /**
   * 窗口识别与锁边的数据源。刻意排在截图**显示之后**：`Window.all()` 在窗口多的
   * 机器上是几十到几百毫秒，卡在前面就是拖慢锁屏，而它只服务 hover 和吸附。
   */
  private async sendWindows(display: Display, seq: number): Promise<void> {
    const startedAt = performance.now();
    const windows = await getWindows(display, this.logger);
    this.logger(
      '窗口识别 %d 条 %dms（截图显示之后）',
      windows.length,
      Math.round(performance.now() - startedAt),
    );

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

    // 中途换屏或结束了，这批矩形对应的是另一块屏，发过去会错位
    if (
      seq !== this.captureSeq ||
      !this.capturing ||
      !this.$win ||
      this.$win.isDestroyed()
    ) {
      return;
    }

    this.captureWindows = windows;
    this.$view.webContents.send('SCREENSHOTS:windows', windows);
  }

  /**
   * 元素级识别（`edge_det`）。截图窗口显示之后才异步执行，所以不拖慢截图出现的速度；
   * 整窗拾取由渲染端保证以窗口数据为准，这里只补窗口盖不到的地方。
   *
   * 整屏这一遍为了压耗时可能会降采样，边框只当"候选集"用；
   * 贴得准的矩形由 `SCREENSHOTS:edgeRegion` 的邻域精修按原生分辨率现算。
   */
  private async detectEdges(
    shot: { image?: ShotImage | undefined },
    display: Display,
    seq: number,
  ): Promise<void> {
    if (!shot.image) {
      // 兜底的截图路径（desktopCapturer）拿不到 RGBA
      return;
    }
    // 这一遍排在窗口下发之后，那几十到几百毫秒里截图可能已经结束了，
    // 别为一幅不会再被拾取的图拷 22MB 像素、再跑一遍 WASM
    if (!this.capturing || seq !== this.captureSeq) {
      return;
    }

    const debugOn = isEdgesDebugEnabled();
    const startedAt = performance.now();
    // 调试模式要同一份像素再画一次框，别为了省一次拷贝把缓冲搞成两份语义
    const pixels = this.toPixels(shot.image, display, debugOn);
    const { bounds, rawBorders } = await getEdges(pixels, display, this.logger, {
      thresholds: this.edgeThresholds,
      debug: debugOn,
    });
    this.logger(
      '元素检测 %d 条 %dms',
      bounds.length,
      Math.round(performance.now() - startedAt),
    );

    if (debugOn && rawBorders) {
      try {
        this.logger(
          '元素检测调试图 %s（原生真值 %d 条）',
          writeEdgesDebugImage({
            pixels,
            rawBorders,
            bounds,
            windows: this.captureWindows,
          }),
          rawBorders.length,
        );
      } catch (err) {
        this.logger('元素检测调试图写入失败 %o', err);
      }
    }

    // 中途换屏或结束了，这批矩形对应的是另一张图，发过去会错位
    if (
      seq !== this.captureSeq ||
      !this.capturing ||
      !this.$win ||
      this.$win.isDestroyed()
    ) {
      return;
    }

    // 换屏后这张图作废，新的 detectEdges 会重新填
    this.edgeSource = { pixels, display };
    this.$view.webContents.send('SCREENSHOTS:edges', bounds);
  }

  /**
   * 光标邻域的**原生分辨率**精修：渲染端 hover 到窗口之外的位置时发起，
   * 结果只回给那一次请求（`SCREENSHOTS:edges-precise`），不进整屏候选集。
   */
  private async sendPreciseEdges(rect: Region): Promise<void> {
    if (!this.capturing || !this.edgeSource) {
      // 没在截图、或这张图拿不到 RGBA（兜底截图路径）
      return;
    }
    // 像素和屏必须成对取，精修的坐标空间才是这张图所在屏的
    const { pixels, display } = this.edgeSource;
    const seq = this.captureSeq;
    const region = clampRegion(rect, display);
    if (!region) {
      return;
    }
    // 裁剪区必须装得下整个元素，边才检得出来，所以粗矩形四周再留 8 DIP
    const crop: Region = {
      x: region.x - 8,
      y: region.y - 8,
      width: region.width + 16,
      height: region.height + 16,
    };
    // 原分辨率下区域越大越慢；粗矩形本身就大（比如整块桌面区域）时这次精修不值得做
    const maxSide = Math.max(pixels.width, pixels.height) / pixels.scale;
    if (
      Math.max(crop.width, crop.height) > Math.min(700, maxSide) ||
      crop.width * crop.height > maxSide * maxSide * 0.35
    ) {
      this.logger('邻域精修跳过（区域过大）%o', crop);
      return;
    }

    const startedAt = performance.now();
    const { bounds } = await getPreciseEdges(
      pixels,
      display,
      this.logger,
      crop,
      this.edgeThresholds,
      region,
    );
    this.logger(
      '邻域精修 %d 条 %dms 粗矩形 %o → %o',
      bounds.length,
      Math.round(performance.now() - startedAt),
      region,
      bounds[0],
    );

    if (
      seq !== this.captureSeq ||
      !this.capturing ||
      !this.$win ||
      !this.$view ||
      this.$win.isDestroyed() ||
      this.$view.webContents.isDestroyed()
    ) {
      // 等 worker 期间换了屏，这份精修结果对应的是旧图，发过去会贴错地方
      return;
    }
    this.$view.webContents.send('SCREENSHOTS:edges-precise', region, bounds);
  }

  /**
   * 截图像素。要趁 Image 还在手上取，晚一步就得重新截屏。
   * napi 给的 Buffer 可能是外部内存，不能直接交给 worker，所以先拷一份。
   *
   * `reuse` 给调试模式用：同一份像素要喂检测和调试图两次，少拷一次是 22MB。
   */
  private toPixels(image: ShotImage, display: Display, reuse?: boolean): Pixels {
    const raw = image.toRawSync();
    const buf = reuse
      ? (raw.buffer.slice(
          raw.byteOffset,
          raw.byteOffset + raw.byteLength,
        ) as ArrayBuffer)
      : new Uint8Array(raw).buffer;
    return {
      buf,
      width: image.width,
      height: image.height,
      scale: image.width / display.width,
    };
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

    /**
     * 光标邻域的原生分辨率精修请求，只有开了 detectEdges 才有意义
     * （没开时 edgeSource 永远是 undefined，直接忽略）。
     */
    ipcMain.on('SCREENSHOTS:edgeRegion', (_event, region: Region) => {
      if (!this.isDetectEdges || !region) {
        return;
      }
      void this.sendPreciseEdges(region);
    });
  }
}

/** 夹到屏幕内并保证最小尺寸，越界越严重就越没意义，直接返回 undefined 省一次 worker */
function clampRegion(rect: Region, display: Display): Region | undefined {
  const x = Math.max(0, Math.min(rect.x, display.width - 2));
  const y = Math.max(0, Math.min(rect.y, display.height - 2));
  const width = Math.min(display.width - x, Math.max(2, rect.width));
  const height = Math.min(display.height - y, Math.max(2, rect.height));
  if (width < 2 || height < 2) {
    return undefined;
  }
  return { x, y, width, height };
}
