import Events from 'node:events';
import debug, { type Debugger } from 'debug';
import {
  BrowserView,
  BrowserWindow,
  clipboard,
  type DesktopCapturerSource,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen,
  shell,
  systemPreferences,
} from 'electron';
import fs from 'fs-extra';
import type { Image as ShotImage } from 'node-screenshots';
import { isEdgesDebugEnabled, writeEdgesDebugImage } from './edgesDebug.js';
import Event from './event.js';
import getDisplay, { type Display, toDisplay } from './getDisplay.js';
import getEdges, {
  type EdgeThresholds,
  getPreciseEdges,
  type Pixels,
  type Region,
} from './getEdges.js';
import getWindows, { resetWindowCache } from './getWindows.js';
import padStart from './padStart.js';
import type { Bounds, ScreenshotsData } from './preload.js';
import {
  bundleIdOf,
  getScreenAccess,
  resolveResponsibleApp,
} from './screenPermission.js';

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

/** 屏蔽窗口压暗到多黑。注意它是**会被截进图里**的，所以截图必须发生在它出现之前 */
const BLOCK_OPACITY = 0.5;

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
   * 每块屏幕的截图，key 为 display.id。
   *
   * 换屏时**绝不能重新截屏**：那一刻目标屏上盖着屏蔽窗口，重截会把那层半透明黑一起拍进去，
   * 于是换过去的底图整体暗一半 —— 用户看到的就是"框选区域不变亮"、导出的图也是灰的。
   * 所以其他屏幕在屏蔽窗口出现之前就截好放在这里，换屏只是取缓存。
   */
  private shots = new Map<
    number,
    { display: Display; png: Buffer; image?: ShotImage | undefined }
  >();

  /**
   * 渲染端回执「新一帧已经画出来了」。
   *
   * 换屏时窗口是搬到另一块屏上的，搬之前必须先让渲染端把新图这一帧画完：
   * 否则窗口落地的那几百毫秒里显示的是空/旧内容，在透明窗口下就是一次闪烁。
   */
  private paintWaiter: { resolve: () => void } | null = null;

  /**
   * 截图进行中标记。endCapture 里主动 blur 时它已被置 false，
   * 避免 blur 监听器又把焦点抢回来。
   */
  private capturing = false;

  /** 保存对话框期间不能抢焦点、不能重新置顶 */
  private isDialogOpen = false;

  /**
   * 这一轮截图已经完整可见（底图亮出来、可以交互了）。
   *
   * ESC 只在这之后才生效：之前窗口还是 opacity 0，用户看不见任何东西，
   * 此时允许取消会让 `startCapture` 的后续步骤（下发识别、开屏幕监听）跑在一个
   * 已经收尾的会话上。
   */
  private captureReady = false;

  /** ESC 全局快捷键是否由本库持有（见 `registerEscShortcut`） */
  private escRegistered = false;

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
    /**
     * checkScreen 互斥锁：capture 是几百毫秒的异步操作，而定时器 100ms 一次，
     * 不加锁会并发启动多个 capture，每个完成时都 ++captureSeq，导致先完成的
     * sendWindows/detectEdges 里 seq !== captureSeq 被丢掉，渲染端拿不到 windows/edges。
     */
    lock: boolean;
  } = {
    currentDisplay: null as unknown as Display,
    timer: null,
    watching: false,
    lock: false,
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
    /**
     * ESC 兜底：键盘焦点在渲染端时直接由 webContents 收下。
     *
     * 主路径是 `registerEscShortcut()` 的全局快捷键（不依赖焦点）；这条只在
     * 全局快捷键注册失败（被别的应用占用）时顶上，两者是同一个出口。
     */
    this.$view.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        this.cancelByEsc();
      }
    });
    if (opts?.lang) {
      this.setLang(opts.lang);
    }
  }

  /**
   * 真抓一次屏幕源 —— 这是唯一可信的"有权限"证据。
   *
   * `systemPreferences.getMediaAccessStatus('screen')` 不可靠：macOS 上它会返回
   * `not-determined` / `unknown`（首次调用、刚授权、被 launchd 拉起时都可能），
   * 拿它当"没权限"用，用户明明早就授权了也会每次被弹窗拦住。
   *
   * 反过来，"拿不到"也**不能**推断没授权（采集环境异常时同样返回空），
   * 所以调用方只把它当**正向证据**：能拿到就一定是有权限。
   *
   * 这一调同时就是 TCC 的按需登记：不真的调采集 API，应用不会出现在
   * 「屏幕与系统音频录制」列表里，用户去系统设置根本找不到可勾的项。
   * 系统框没被回答时 Promise 可能一直不返回，所以加超时兜底。
   */
  private async canCaptureScreen(timeout = 20_000): Promise<boolean> {
    try {
      const sources = await Promise.race([
        desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 1, height: 1 },
        }),
        new Promise<null>((resolve) => {
          setTimeout(() => resolve(null), timeout);
        }),
      ]);
      return Array.isArray(sources) && sources.length > 0;
    } catch {
      // 拿不到源不打断主流程，交给后面的引导弹窗
      return false;
    }
  }

  /**
   * 本会话是否**已确认**有屏幕录制权限。
   *
   * 只记「有」，不记「没有」：一次误判被永久缓存的话，用户会在明明有权限的
   * 情况下被反复弹窗 —— 这正是"授权了还一直弹"的根因。
   */
  private screenGranted = false;

  /**
   * macOS 的屏幕录制权限无法由程序申请（`systemPreferences.askForMediaAccess`
   * 只接受 microphone/camera），只能把人引导到系统设置里，所以这里只提示。
   *
   * 必须在截图窗口创建之前弹：截图窗口有失焦即抢回焦点的逻辑，
   * 应用级模态框会被它压下去，用户根本点不到。
   *
   * 判定顺序刻意是「先真抓一次、再信状态」：`getMediaAccessStatus` 会给出
   * `not-determined` / `unknown` 这类"没准话"的答案，信它就会在明明有权限时
   * 反复弹窗。只有**真的抓不到画面**才走引导。
   *
   * @returns true 表示确实拿不到画面（已弹出引导），本次截图应该中止
   */
  private async promptScreenPermission(): Promise<boolean> {
    if (!this.isPromptScreenPermission || process.platform !== 'darwin') {
      return false;
    }

    // 已经确认过有权限：之后一次都不再打扰
    if (this.screenGranted) {
      return false;
    }

    // 1) 系统明确说 granted，直接放行
    if (getScreenAccess() === 'granted') {
      this.screenGranted = true;
      return false;
    }

    /**
     * 2) 系统没给准话（not-determined / unknown / denied），用"能不能真抓到画面"来定。
     *
     * 这一调同时会触发 macOS 的授权框：用户点「允许」后 sources 就非空，
     * 于是直接放行、继续截图 —— 不再弹"需要重启"的二次弹窗。
     */
    if (await this.canCaptureScreen()) {
      this.logger(
        '屏幕录制权限状态为 %s，但能取到屏幕源，按已授权处理',
        getScreenAccess(),
      );
      this.screenGranted = true;
      return false;
    }

    /**
     * 关键：权限记在 TCC 认定的"责任进程"名下，不是记在 Electron 名下。
     * 从终端 `npm run start` 起的话，要勾的是终端 / IDE；
     * 从独立的 .app 起的话，要勾的是那个 .app。不把这件事说清楚，
     * 用户在系统设置里勾了 "Electron" 也还是 denied —— 实测就是这么卡住的。
     */
    const target = resolveResponsibleApp();
    this.logger(
      '屏幕录制权限 %s，窗口识别与锁边不可用（需授权：%s）',
      getScreenAccess(),
      target ? `${target.name} ${target.bundlePath}` : '未识别',
    );

    const detail = [
      `要在「系统设置 → 隐私与安全性 → 屏幕与系统音频录制」里勾选 ${
        target ? `「${target.name}」` : '本应用'
      }，勾完按 ⌘Q 完全退出再重新打开。`,
      target
        ? `要勾的就是这个包：${target.bundlePath}`
        : '列表里找不到的话，点下面的「复制重置命令」执行一次，再截一次图会重新弹窗。',
      '注意：macOS 把权限记在"启动它的那个应用"名下 —— 从终端 / IDE 里 npm run start，要勾的是终端或 IDE，不是 Electron。',
    ].join('\n\n');

    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: '开启窗口识别',
      message: '窗口的屏幕录制权限还没授予，本次截图已取消。',
      detail,
      buttons: ['打开系统设置', '复制重置命令', '知道了'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (response === 0) {
      await shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
      );
    } else if (response === 1 && target) {
      // 之前点过"不允许"的话系统不会再弹窗，只能重置 TCC 记录
      clipboard.writeText(
        `tccutil reset ScreenCapture ${bundleIdOf(target.bundlePath) ?? target.name}`,
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

    /**
     * 先把屏幕**冻住**，再去等渲染端就绪。
     *
     * 渲染端首次启动要两三秒（冷启动更久，实测 2.5~7s），而用户按下截图后往往
     * 马上就去点任务栏、开别的程序。如果等就绪再截，这些窗口就会被一起拍进"快照"，
     * 而快照必须是一开始那一刻的屏幕 —— 之后打开的所有东西都只应该被它盖在下面。
     *
     * 截图不依赖渲染端，所以这里只发起、不等待：真正的等待和建窗口一起做。
     */
    const shotPromise = this.capture(display);
    // 这里只是先挂一个处理者：截图失败时下面等渲染端的这段时间不会变成
    // unhandledRejection；错误本身仍由 Promise.all 抛给调用方
    shotPromise.catch(() => {});

    // 建窗口里的 reset 要等渲染端回执，所以先把渲染端就绪排在最前面
    await this.isReady;
    mark('isReady');

    /**
     * "先锁定屏幕"的关键：截屏+编码 与 建窗口（含 reset 等待）互不依赖，并行做，
     * 于是第一帧出现的时间约等于 captureImage + toPng，而不是两者相加。
     */
    const [shot, $win] = await Promise.all([
      shotPromise,
      this.createWindow(display),
    ]);
    mark('capture + createWindow');

    this.capturing = true;

    const seq = ++this.captureSeq;
    // 新一轮截图，上一轮的窗口几何和渲染端缓存作废
    resetWindowCache();
    this.windowsByDisplay.clear();
    this.decodedInRenderer.clear();
    this.shots.set(display.id, {
      display,
      png: shot.png,
      image: shot.image,
    });

    /**
     * 屏蔽窗口先立起来（全透明，照样挡点击，但不会被拍进图里）。
     *
     * 必须排在截图窗口 show 之前：遮罩要"跟着截图一起出来"。
     * 等绘制完再建就晚了几百毫秒，用户看到的是另一块屏先敞着、过一会儿才压暗。
     */
    this.ensureBlockWindows();

    /**
     * 先以**全透明**显示，等渲染端把这一帧画完再亮出来。
     *
     * 不能"等画完再 show"：隐藏窗口里 rAF 不跑、解码也慢得离谱（实测首次解码要 1 秒以上，
     * 而且经常等不到），主进程只能等到超时，截图窗口反而更晚出现。
     * 也不能"先 show 再等图"：窗口先出现但里面什么都没有，透明窗口直接把桌面透出来，
     * 等图到了再"啪"地换上去 —— 开局这一下闪烁就是这么来的。
     * 所以取中间：显示（这样渲染进程才会正常出帧）但完全透明（用户看不见），
     * 画好了再亮出来，用户看到的第一帧就是完整的截图。
     */
    $win.setOpacity(0);
    $win.show();
    mark('show');
    // 从这一刻起守住最上层：别的应用随时可能把自己的浮层提到前面
    this.startTopMostGuard();

    /**
     * 其他屏幕的预截和这一帧的绘制**并行**跑：截完一块就把那块压暗，
     * 不用等最慢的那块屏编码完。
     */
    void this.captureOtherDisplays(display);

    try {
      await this.prepareRenderer(display, shot.png);
    } finally {
      // 渲染端出问题也必须亮出来，否则用户面对的是一个看不见又点不掉的窗口
      if (this.$win && !this.$win.isDestroyed()) {
        this.$win.setOpacity(1);
      }
    }
    mark('send capture');

    /**
     * 底图已经亮出来了，从这一刻起 ESC 才允许取消。
     *
     * 全局快捷键放在这里而不是 `show` 之前：窗口先以 opacity 0 显示的那段时间
     * 用户什么都看不见，这时候能取消的话，下面的识别与屏幕监听会跑在一个
     * 已经收尾的会话上。
     */
    this.captureReady = true;
    this.registerEscShortcut();

    /**
     * 两个拾取源都必须排在显示之后，而且要**先窗口后元素**。
     * 一次截图里所有屏幕的识别结果都在这里一次算完，之后换屏只下发缓存。
     */
    void this.startRecognition(shot, display, seq);

    // 跟手换屏（与微信、Snipaste 一致），否则扩展屏永远切不过去。
    // 按下鼠标时渲染端会发 SCREENSHOTS:start 停掉监听，此时其他屏幕就被屏蔽窗口锁住。
    this.startScreenWatcher(display);
  }

  /**
   * 预截其他屏幕。
   *
   * 并行截、并行编码，耗时约等于最慢的那一块屏，不阻塞截图窗口显示。
   * **每块屏的像素一抓到手就立刻压暗自己的遮罩**（不等 PNG 编码）——
   * 编码一块 5K 屏要几百毫秒，等编码完再压暗，几块屏会一块一块地黑下去，
   * 用户看到的就是"遮罩没同步出来"。
   * 失败只丢这一块屏的缓存（换屏时再补截），不能让整次截图失败。
   */
  private async captureOtherDisplays(active: Display): Promise<void> {
    const others = screen
      .getAllDisplays()
      .filter((display) => display.id !== active.id);

    try {
      await Promise.all(
        others.map(async (item) => {
          const display = toDisplay(item);
          try {
            /**
             * 抓完像素就压暗（不等编码），这块屏的遮罩几乎是立刻出来的。
             * 遮罩必须赶在编码之前：编码一块 5K 屏要几百毫秒，
             * 等编码完再压暗，几块屏就会一块一块地黑下去，看着像"遮罩没同步"。
             */
            const shot = await this.capture(display, () => {
              if (this.capturing) {
                this.setBlockDim(display.id, true);
              }
            });
            // 期间截图可能已经结束，缓存留着没用还占内存
            if (!this.capturing) {
              return;
            }
            this.shots.set(display.id, {
              display,
              png: shot.png,
              image: shot.image,
            });
            this.logger(
              '预截屏幕 %d 完成 %dKB',
              display.id,
              shot.png.length >> 10,
            );
          } catch (err) {
            this.logger('预截屏幕 %d 失败 %o', display.id, err);
          }
        }),
      );
    } finally {
      // 不管截成没截成，遮罩都得亮起来，否则其他屏幕一直不压暗
      this.revealBlockWindows(active);
    }
  }

  /**
   * 取某块屏幕的截图：优先用预截缓存，没有才现场截。
   *
   * 现场截之前必须先把这块屏的屏蔽窗口隐掉，不然拍到的就是那层半透明黑。
   * 只有"截图过程中新插进来的屏幕"会走到这条路径。
   */
  private async shotOf(
    display: Display,
  ): Promise<{ png: Buffer; image?: ShotImage | undefined }> {
    const cached = this.shots.get(display.id);
    if (cached) {
      return cached;
    }

    const $block = this.$blockWins.get(display.id);
    const needHide = !!$block && !$block.isDestroyed();
    // 还原成"截之前什么样"：可能是压暗的，也可能是活动屏的全透明
    const prevOpacity = needHide ? $block.getOpacity() : 0;
    if (needHide) {
      $block.setOpacity(0);
    }
    try {
      const shot = await this.capture(display);
      this.shots.set(display.id, {
        display,
        png: shot.png,
        image: shot.image,
      });
      return shot;
    } finally {
      if (needHide && !$block.isDestroyed()) {
        $block.setOpacity(prevOpacity);
      }
    }
  }

  /**
   * 把新截图交给渲染端并等它画完这一帧。
   *
   * 超时兜底：渲染端可能已经卡死/销毁，不能因为等一个回执把整个截图卡在这里。
   */
  private async prepareRenderer(display: Display, png: Buffer): Promise<void> {
    if (this.$view.webContents.isDestroyed()) {
      return;
    }

    const startedAt = performance.now();
    const painted = this.waitForPaint();
    // 渲染端已经解过这块屏的图：不用再传一遍几 MB 的 PNG
    const preloaded = this.decodedInRenderer.has(display.id);
    this.$view.webContents.send(
      'SCREENSHOTS:capture',
      display,
      preloaded ? undefined : png,
    );
    await painted;
    this.logger(
      '等待渲染端绘制 %dms%s',
      Math.round(performance.now() - startedAt),
      preloaded ? '（预载命中）' : '',
    );
  }

  /**
   * 等渲染端把这一帧画出来。
   *
   * 超时只是兜底（渲染端可能已经卡死），不能设太短：渲染进程**第一次**解码一张全屏 PNG
   * 要一秒左右（之后的每次只要几十毫秒），超时提前放行就会在窗口里露出空白帧 —— 正是要修的那个闪烁。
   * 实测：首张解码约 1.1s，后续 60~90ms。
   */
  private waitForPaint(timeout = 2500): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.paintWaiter = null;
        resolve();
      }, timeout);
      this.paintWaiter = {
        resolve: () => {
          clearTimeout(timer);
          this.paintWaiter = null;
          resolve();
        },
      };
    });
  }

  private startScreenWatcher(initialDisplay: Display) {
    if (this.screenWatcher.watching) return;

    this.screenWatcher.currentDisplay = initialDisplay;
    this.screenWatcher.watching = true;

    const checkScreen = async () => {
      if (
        !this.screenWatcher.watching ||
        !this.$win ||
        this.$win.isDestroyed()
      ) {
        this.stopScreenWatcher();
        return;
      }

      // 前一轮 capture + 下发还没结束，这次直接跳过，避免并发 capture 把 captureSeq 顶掉
      if (this.screenWatcher.lock) {
        this.screenWatcher.timer = setTimeout(checkScreen, 100);
        return;
      }

      const point = screen.getCursorScreenPoint();
      const newDisplay = screen.getDisplayNearestPoint(point);

      if (newDisplay.id !== this.screenWatcher.currentDisplay.id) {
        this.screenWatcher.lock = true;
        const previous = this.screenWatcher.currentDisplay;
        try {
          const display = toDisplay(newDisplay);
          this.screenWatcher.currentDisplay = display;
          await this.switchDisplay(display, previous);
        } catch (err) {
          // 换屏失败（截不到图）就退回上一块屏，下一轮继续重试，别把状态停在半路
          this.screenWatcher.currentDisplay = previous;
          this.logger('换屏失败 %o', err);
        } finally {
          this.screenWatcher.lock = false;
        }
      }

      // 使用 requestAnimationFrame 的思想控制检查频率
      this.screenWatcher.timer = setTimeout(checkScreen, 100);
    };

    checkScreen();
  }

  /**
   * 光标换到另一块屏。
   *
   * 顺序是这次修复的核心，目标是**每一步都发生在"用户看不见"的时候**：
   *
   * 1. 新图先画好 —— 此刻窗口还在旧屏，替换过程被旧屏挡着；
   * 2. **旧屏先压暗** —— 此刻旧屏还被截图窗口盖着，这一步也看不见。
   *    等窗口搬走时，露出来的是"已经变暗的桌面"，而不是真实桌面过一会儿再补一层黑；
   * 3. 搬窗口 —— 新屏的遮罩还亮着，但它在截图窗口**下面**，所以看不到；
   * 4. **新屏再撤遮罩** —— 窗口已经盖满了，这一步同样看不见。
   *
   * 反过来的顺序（先搬窗口再压暗旧屏）就会露出真实桌面，这就是来回换屏的闪烁来源。
   *
   * 截图一律取 `shotOf` 的缓存：目标屏此刻盖着屏蔽窗口，重新截屏会把那层半透明黑拍进去。
   */
  private async switchDisplay(
    display: Display,
    previous: Display,
  ): Promise<void> {
    const $win = this.$win;
    if (!this.capturing || !$win || $win.isDestroyed()) {
      return;
    }

    const startedAt = performance.now();
    // 中途插拔屏幕时补齐屏蔽窗口（正常情况下这里什么都不做）
    this.ensureBlockWindows();
    const shot = await this.shotOf(display);
    // 换屏不算"新的一轮截图"：`captureSeq` 只在 startCapture 里递增。
    // 以前这里也 ++，而开场识别要一两秒才跑完 —— 用户在识别算完之前把光标划到
    // 另一块屏，整轮结果都会被判成过期丢掉，之后两块屏都不再有高亮/吸附，
    // 看起来就是"窗口边缘完全识别不出来"。识别结果该不该下发，改由屏 id 判断。
    const seq = this.captureSeq;

    // 1. 渲染端换图并画好这一帧（此时窗口还在旧屏上，用户看不到这次替换）
    await this.prepareRenderer(display, shot.png);

    // 2. 旧屏先压暗（被截图窗口盖着，看不见）
    this.setBlockDim(previous.id, true);

    // 3. 内容已经就绪，窗口搬过去的第一帧就是新屏的画面
    if (!$win.isDestroyed()) {
      $win.setBounds(display);
      this.$view.setBounds({
        x: 0,
        y: 0,
        width: display.width,
        height: display.height,
      });
      this.assertTopMost($win);
      $win.moveTop();
    }

    // 4. 新屏撤遮罩（已经被截图窗口盖满，看不见）
    this.setBlockDim(display.id, false);

    this.logger(
      '换屏 → %d %dx%d 耗时 %dms',
      display.id,
      display.width,
      display.height,
      Math.round(performance.now() - startedAt),
    );

    // 换屏后只下发开场就算好的结果，1ms 量级；这里绝不能再跑识别
    this.sendRecognition(display, seq);
  }

  private stopScreenWatcher() {
    if (this.screenWatcher.timer) {
      clearTimeout(this.screenWatcher.timer);
      this.screenWatcher.timer = null;
    }
    this.screenWatcher.watching = false;
    // 结束截图时强制释放锁：万一 capture 还在跑，下一次截图不能被上一轮卡住
    this.screenWatcher.lock = false;
  }

  /**
   * 注册 ESC 取消截图。
   *
   * 上游为了 mac kiosk 支持删掉了渲染端的 keyup 监听，之后 ESC 只能靠宿主自己
   * 在截图窗 `focus` 时 `globalShortcut.register('esc')`、`blur` 时注销，而且
   * handler 里还要再判一次 `$win.isFocused()`。这条链路在打包环境里很脆：
   * 宿主常常会先 `mainWindow.hide()` 再起截图（防截屏模式），进程瞬间没有可见
   * 窗口，截图窗 show 出来时不一定能拿到前台/焦点 —— `focus` 不来，快捷键就一次
   * 都没注册上；就算注册上了，焦点那一刻在屏蔽窗上，`isFocused()` 也会让 handler
   * 静默 return。表现就是"截图卡在屏幕上，ESC 怎么按都没反应"。
   *
   * 所以改由库自己管：截图中注册、收尾时注销，门禁用 `captureReady` 而不是焦点，
   * 只要这一轮截图还开着，不管焦点在谁身上 ESC 都生效。
   *
   * 注册前先 `unregister` 一次：按旧文档接入的宿主可能已经自己注册过 `esc`，
   * 而 `globalShortcut.register` 对同一个键返回 false 且**保留旧回调**，
   * 不清掉的话抢不过来，ESC 还是走的宿主那套带焦点门禁的逻辑。
   */
  private registerEscShortcut(): void {
    if (this.escRegistered) {
      return;
    }
    try {
      // 让位给库自己：宿主的旧注册（带 isFocused 门禁）会挡住这次注册
      globalShortcut.unregister('esc');
      this.escRegistered = globalShortcut.register('esc', () => {
        this.cancelByEsc();
      });
    } catch (err) {
      this.escRegistered = false;
      this.logger('注册 ESC 快捷键异常 %o', err);
    }
    this.logger(
      '注册 ESC 快捷键 %s',
      this.escRegistered ? '成功' : '失败（可能被其他应用占用）',
    );
  }

  private unregisterEscShortcut(): void {
    if (!this.escRegistered) {
      return;
    }
    globalShortcut.unregister('esc');
    this.escRegistered = false;
  }

  /**
   * ESC / 键盘兜底的统一出口，和渲染端发来 `SCREENSHOTS:cancel` 走同一条事件链，
   * 所以宿主只需要监听 `cancel`，不用再自己接键盘。
   */
  private cancelByEsc(): void {
    if (!this.captureReady || this.isDialogOpen) {
      return;
    }
    this.logger('ESC 取消截图');
    this.handleCancel();
  }

  /** 取消截图；宿主可以 `preventDefault` 拦下（比如改成二次确认） */
  private handleCancel(): void {
    const event = new Event();
    this.emit('cancel', event);
    if (event.defaultPrevented) {
      return;
    }
    this.endCapture();
  }

  /**
   * 结束截图
   */
  public async endCapture(): Promise<void> {
    this.logger('endCapture');
    // 先停置顶守卫，否则它会一边拆窗口一边把窗口重新抬起来
    this.stopTopMostGuard();
    // 会话已经结束，ESC 立刻失效：晚一步的话，收尾这几百毫秒里按 ESC
    // 会再走一遍 cancel → endCapture，把宿主的回调打两次
    this.captureReady = false;
    this.unregisterEscShortcut();
    // 停止屏幕监听
    this.stopScreenWatcher();
    this.capturing = false;
    // 22MB 级别的像素缓存，截图结束就放手，别占着宿主的内存
    this.edgeSource = undefined;
    this.captureWindows = [];
    // 每块屏的截图（含原生像素）也一起放掉
    this.shots.clear();
    this.windowsByDisplay.clear();
    this.edgesByDisplay.clear();
    this.edgePixels.clear();
    this.decodedInRenderer.clear();
    this.paintWaiter = null;
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
       * 截图窗口被别的窗口抢了层级/焦点时，**立刻**抬回来，不等置顶守卫那一拍。
       *
       * Windows 上任务栏本身是 topmost，加上 skipTaskbar 之后窗口沉底就没有任何入口
       * 点回来了；macOS 上各种浮层（录屏指示器、输入法候选框）也会盖住截图窗口。
       * 两种情况用户看到的都是"截图跑到别人窗口底下"，所以不区分平台，统一抢回。
       */
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
        this.raiseAll();
        $win.focus();
      });

      this.$win.on('minimize', () => {
        if (this.capturing && !this.isDialogOpen) {
          this.$win?.restore();
        }
      });
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
   * 默认层级（floating）**压不住**很多应用：视频播放器、录屏/截图工具、各种 HUD
   * 都在更高的层级上，于是截图窗口会"跑到别的窗口底下"—— 用户看到的是一半截图、
   * 一半别人的界面，还以为截图坏了。
   *
   * `screen-saver` 是 Electron 能给的最高层级：
   * - Windows 上从 floating 到 status 都排在任务栏之下，只有 pop-up-menu 及以上才在任务栏之上；
   * - macOS 上对应 NSScreenSaverWindowLevel，能压住绝大多数常驻浮层。
   *
   * `moveTop()` 负责同层级内的相对顺序（同层级时它才是决定谁在上面的那个）。
   * https://www.electronjs.org/docs/latest/api/browser-window#winsetalwaysontopflag-level-relativellevel
   */
  private assertTopMost($win: BrowserWindow | null): void {
    if (!$win || $win.isDestroyed()) {
      return;
    }
    $win.setAlwaysOnTop(true, 'screen-saver');
    $win.moveTop();
  }

  /**
   * 把截图窗口和所有遮罩一起抬回最上层，**截图窗口必须在最后**。
   *
   * 顺序不能反：遮罩和截图窗口同在 `screen-saver` 层级，谁后抬谁在上面。
   * 遮罩一旦压住活动屏的截图窗口，macOS 会把截图窗口判成 occluded，
   * 渲染端被节流（rAF 停、定时器拖到 1s），换屏就开始"追不上光标"。
   */
  private raiseAll(): void {
    for (const $block of this.$blockWins.values()) {
      if (!$block.isDestroyed()) {
        $block.setAlwaysOnTop(true, 'screen-saver');
      }
    }
    this.assertTopMost(this.$win);
  }

  /**
   * 截图期间的置顶守卫。
   *
   * 别的应用可能随时把自己的浮层提到最前（提示气泡、录屏指示器、输入法候选框），
   * 一次 `assertTopMost` 压不住整个截图过程。这里每隔一段时间重新断言一次，
   * 用户不小心点到别的地方、或者别的应用抢了层级，几百毫秒内就会自动回到最上面。
   */
  private startTopMostGuard(): void {
    if (this.topMostTimer) {
      return;
    }
    this.topMostTimer = setInterval(() => {
      // 弹窗期间必须放手：保存对话框就挂在截图窗口上，压在最上面会把对话框盖住
      if (!this.capturing || this.isDialogOpen) {
        return;
      }
      this.raiseAll();
      /**
       * ESC 自愈。按旧文档接入的宿主会在截图窗 `blur` 时自己
       * `globalShortcut.unregister('esc')` —— 同一个应用、同一个键，那一下会把
       * 库注册的快捷键一并注销，ESC 又变回"没反应"。这里每拍确认一次，被注销就补回来。
       */
      if (this.captureReady && !globalShortcut.isRegistered('esc')) {
        this.escRegistered = false;
        this.registerEscShortcut();
      }
    }, 400);
  }

  private stopTopMostGuard(): void {
    if (this.topMostTimer) {
      clearInterval(this.topMostTimer);
      this.topMostTimer = null;
    }
  }

  /**
   * 为**每一块**屏幕建一个常驻的屏蔽窗口（先全透明）。
   *
   * 早先是"活动屏不留、其余屏建"，于是每换一次屏都要销毁一个、重建一个 ——
   * 重建要走 `new BrowserWindow` + `loadURL` + `show`，实测 80~150ms。
   * 这段空窗期里刚离开的那块屏会露出**真实桌面**，然后才被半透明黑盖上：
   * 来回切换就是"亮一下、黑一下"的闪烁，看起来像遮罩在闪。
   *
   * 现在一次建全，整场只切 opacity —— 换屏不再创建/销毁任何窗口，没有空窗期。
   */
  private ensureBlockWindows(): void {
    if (process.platform === 'linux') {
      return;
    }

    const alive = new Set<number>();
    let created = false;

    for (const display of screen.getAllDisplays()) {
      alive.add(display.id);
      if (this.$blockWins.has(display.id)) {
        continue;
      }
      created = true;

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
        // 建出来一律全透明：预截其他屏幕时不能被拍进去
        opacity: 0,
        hasShadow: false,
      });

      this.$blockWins.set(display.id, $win);
      $win.on('closed', () => {
        this.$blockWins.delete(display.id);
      });

      // 遮罩也要压在最上面：默认 floating 层级压不住那些常驻浮层，
      // 一旦被别的窗口盖住，用户就能点到底下的应用
      $win.setAlwaysOnTop(true, 'screen-saver');

      // 屏蔽窗口必须可聚焦光标才会更新，所以它一拿到焦点就立刻还给截图窗口
      $win.on('focus', () => {
        if (this.capturing) {
          this.$win?.focus();
        }
      });

      $win.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(BLOCK_HTML)}`,
      );
      // 立刻显示：opacity 是 0，用户看不见，但点击已经挡住了、压暗也是瞬间生效，
      // 不用等页面加载完（那又是几十毫秒）
      $win.show();

      $win.webContents.on('did-finish-load', () => {
        if ($win.isDestroyed()) {
          return;
        }
        this.assertTopMost($win);
        /**
         * show() 会把屏蔽窗口抬到最上面，连**同一块屏**上的截图窗口一起压住。
         *
         * 后果不只是层级不对：macOS 会把被完全遮住的窗口判成 occluded，
         * Chromium 于是把渲染端当后台页面节流 —— `document.visibilityState` 变成 hidden，
         * rAF 不跑、定时器拖到 1s，换屏时的绘制回执就迟迟不到，
         * 表现就是"窗口追不上光标、来回划屏一路闪"。
         *
         * 所以 show 完必须把截图窗口重新抬回去。
         */
        if (this.$win && !this.$win.isDestroyed()) {
          this.assertTopMost(this.$win);
          this.$win.moveTop();
        }
      });
    }

    // 拔掉的屏幕：销毁它那块，别留着挡一块不存在的区域
    for (const [id, $win] of this.$blockWins) {
      if (!alive.has(id)) {
        this.$blockWins.delete(id);
        if (!$win.isDestroyed()) {
          $win.destroy();
        }
      }
    }

    /**
     * 屏蔽窗口是后建的，会压在截图窗口之上。截图窗口必须重新抬到最上面，
     * 否则换屏时"先压暗旧屏"那一步会真的把旧屏画面压暗一瞬间才搬走。
     */
    if (created && this.$win && !this.$win.isDestroyed()) {
      this.assertTopMost(this.$win);
      this.$win.moveTop();
    }
  }

  /**
   * 压暗 / 恢复某一块屏的遮罩。
   *
   * 只改 opacity，窗口一直活着 —— 这是换屏不闪的前提。
   * 活动屏的遮罩置为全透明并放行鼠标：它可能压在截图窗口之上，不放行就会吃掉点击。
   */
  private setBlockDim(displayId: number, dimmed: boolean): void {
    const $win = this.$blockWins.get(displayId);
    if (!$win || $win.isDestroyed()) {
      return;
    }
    $win.setIgnoreMouseEvents(!dimmed);
    $win.setOpacity(dimmed ? BLOCK_OPACITY : 0);
  }

  /** 除活动屏外全部压暗（预截完成之后调，之前必须保持全透明） */
  private revealBlockWindows(active: Display): void {
    for (const id of this.$blockWins.keys()) {
      this.setBlockDim(id, id !== active.id);
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

  /**
   * 截一块屏。
   *
   * `onGrabbed` 在**像素已经抓到手**、还没开始编码的那一刻回调。
   * 遮罩就靠它抢时间：`toPng` 编码一块 5K 屏要几百毫秒，等编码完再压暗，
   * 用户看到的就是"另一块屏慢半拍才黑下去"。抓完就压暗，编码在后面慢慢做。
   */
  private async capture(
    display: Display,
    onGrabbed?: () => void,
  ): Promise<{ png: Buffer; image?: ShotImage | undefined }> {
    this.logger('SCREENSHOTS:capture');

    // 兜底路径也可能走到，别让遮罩被压暗两次
    let grabbed = false;
    const grab = () => {
      if (grabbed) return;
      grabbed = true;
      onGrabbed?.();
    };

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
        // DIP → 物理：`Monitor.fromPoint` 要的是物理像素，方向反了会命中别的屏（见 getMonitor）
        point = screen.dipToScreenPoint(point);
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
      // 像素到手，屏幕内容已经定格：这时候压暗遮罩不会再影响这张图
      grab();

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
      grab();

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
            return (
              Math.abs(size.width - expectedWidth) <= 1 &&
              Math.abs(size.height - expectedHeight) <= 1
            );
          });
        }

        // 策略3: 如果尺寸匹配也失败，在Windows系统上通过cursor位置匹配
        if (!source && process.platform === 'win32') {
          const cursorPoint = screen.getCursorScreenPoint();
          const nearestDisplay = screen.getDisplayNearestPoint(cursorPoint);
          // 如果当前display是cursor所在的显示器，尝试通过name匹配或使用第一个source
          if (nearestDisplay.id === display.id) {
            // 某些系统上，source的name可能包含显示器信息
            source = sources.find(
              (item) => item.name && item.name.includes(display.id.toString()),
            );
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
   * 每块屏的窗口矩形 / 元素矩形。
   *
   * 枚举是全局的（物理坐标），投到某块屏只是纯计算 —— 所以**一次截图只算一遍**：
   * 开场就把所有屏幕都算好存着，换屏时只把缓存里的数组发下去，绝不再跑识别。
   *
   * 以前是每次换屏都重算：`getWindows` 里有同步拍窗口甄别覆盖层（实测 0.1~5s），
   * 主线程被占着，下一次换屏的绘制回执迟迟到不了 —— 表现就是"窗口追不上光标、一路闪"。
   */
  private windowsByDisplay = new Map<number, Bounds[]>();
  private edgesByDisplay = new Map<number, Bounds[]>();
  /** 每块屏的 RGBA 像素，供 hover 时做原生分辨率精修 */
  private edgePixels = new Map<number, Pixels>();
  /** 渲染端已经解码好底图的屏幕，换过去时不用再传 PNG、也不用等解码 */
  private decodedInRenderer = new Set<number>();

  /** 置顶守卫的定时器，见 `startTopMostGuard` */
  private topMostTimer: NodeJS.Timeout | null = null;

  /** 把某块屏的底图先塞给渲染端解码（只解码不上屏），换屏时就能直接换元素 */
  private preloadRenderer(display: Display): void {
    const shot = this.shots.get(display.id);
    if (!shot || this.decodedInRenderer.has(display.id)) {
      return;
    }
    if (this.$view.webContents.isDestroyed()) {
      return;
    }
    this.$view.webContents.send('SCREENSHOTS:preload', display, shot.png);
  }

  /**
   * 把某块屏的识别结果发给渲染端。
   *
   * 纯读缓存 + 一次 IPC，1ms 量级 —— 换屏路径上只允许出现这个。
   * 缓存还没算好（刚开屏那几十毫秒）就先什么都不发，渲染端退化成手动框选，
   * 算完之后换回来就有了。
   */
  private sendRecognition(display: Display, seq: number): void {
    if (
      seq !== this.captureSeq ||
      !this.capturing ||
      !this.$win ||
      this.$win.isDestroyed()
    ) {
      return;
    }
    // 识别结果是"这块屏的"，不是"这一轮截图的"：换屏早于识别算完时，
    // 旧屏的结果绝不能贴到新屏上（坐标原点不同，框会整体错位）。
    // 换屏监听还没启动（开场那几十毫秒）时没有"当前屏"，照常下发。
    const current = this.screenWatcher
      .currentDisplay as Partial<Display> | null | undefined;
    if (current && current.id !== display.id) {
      return;
    }

    const windows = this.windowsByDisplay.get(display.id);
    if (windows) {
      this.captureWindows = windows;
      this.$view.webContents.send('SCREENSHOTS:windows', windows);
    }

    if (!this.isDetectEdges) {
      return;
    }
    const edges = this.edgesByDisplay.get(display.id);
    if (!edges) {
      return;
    }
    const pixels = this.edgePixels.get(display.id);
    if (pixels) {
      this.edgeSource = { pixels, display };
    }
    this.$view.webContents.send('SCREENSHOTS:edges', edges);
  }

  /**
   * 开场把**所有屏幕**的识别结果一次算完并缓存，之后换屏只下发。
   *
   * 先算活动屏（用户马上要 hover），再依次算其他屏；算的过程中用户可能已经在切屏了，
   * 所以每一步都检查 `capturing`。
   */
  private async startRecognition(
    shot: { image?: ShotImage | undefined },
    active: Display,
    seq: number,
  ): Promise<void> {
    await this.computeWindows(active);
    this.sendRecognition(active, seq);
    if (this.isDetectEdges) {
      await this.computeEdges(shot, active);
      this.sendRecognition(active, seq);
    }

    for (const display of screen.getAllDisplays().map(toDisplay)) {
      if (display.id === active.id || !this.capturing) {
        continue;
      }
      const other = this.shots.get(display.id);
      if (!other) {
        continue;
      }
      // 先把底图丢给渲染端解码（和下面的识别并行跑），换过去时就不用等解码
      this.preloadRenderer(display);
      await this.computeWindows(display);
      // 用户可能已经在这几十/几百毫秒里换到这块屏了；此时的开场下发早就过去了，
      // 不在这里补一次，这块屏的高亮和吸附就永远不会出现（只有再切一次屏才有）
      this.sendRecognition(display, seq);
      if (this.isDetectEdges) {
        await this.computeEdges(other, display);
        this.sendRecognition(display, seq);
      }
    }
  }

  /**
   * 算出某块屏的窗口矩形并缓存。
   *
   * **不在换屏路径上调用** —— 只在开场、或缓存缺失时跑一次。
   * 刻意排在截图**显示之后**：`Window.all()` 在窗口多的机器上是几十毫秒到几秒，
   * 卡在前面就是拖慢锁屏，而它只服务 hover 和吸附。
   */
  private async computeWindows(display: Display): Promise<Bounds[]> {
    const cached = this.windowsByDisplay.get(display.id);
    if (cached) {
      return cached;
    }

    const startedAt = performance.now();
    const windows = await getWindows(display, this.logger, true);
    this.logger(
      '窗口识别 %d 条 %dms（%d 号屏）',
      windows.length,
      Math.round(performance.now() - startedAt),
      display.id,
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

    this.windowsByDisplay.set(display.id, windows);
    return windows;
  }

  /**
   * 元素级识别（`edge_det`），算完缓存。
   *
   * 整窗拾取由渲染端保证以窗口数据为准，这里只补窗口盖不到的地方。
   * 整屏这一遍为了压耗时可能会降采样，边框只当"候选集"用；
   * 贴得准的矩形由 `SCREENSHOTS:edgeRegion` 的邻域精修按原生分辨率现算。
   *
   * 同样**不在换屏路径上调用**：一次截图里每块屏只算一遍，换屏只下发缓存。
   */
  private async computeEdges(
    shot: { image?: ShotImage | undefined },
    display: Display,
  ): Promise<Bounds[]> {
    const cached = this.edgesByDisplay.get(display.id);
    if (cached) {
      return cached;
    }
    if (!shot.image) {
      // 兜底的截图路径（desktopCapturer）拿不到 RGBA
      return [];
    }

    const debugOn = isEdgesDebugEnabled();
    const startedAt = performance.now();
    // 调试模式要同一份像素再画一次框，别为了省一次拷贝把缓冲搞成两份语义
    const pixels = this.toPixels(shot.image, display, debugOn);
    const { bounds, rawBorders } = await getEdges(
      pixels,
      display,
      this.logger,
      {
        thresholds: this.edgeThresholds,
        debug: debugOn,
      },
    );
    this.logger(
      '元素检测 %d 条 %dms（%d 号屏）',
      bounds.length,
      Math.round(performance.now() - startedAt),
      display.id,
    );

    if (debugOn && rawBorders) {
      try {
        this.logger(
          '元素检测调试图 %s（原生真值 %d 条）',
          writeEdgesDebugImage({
            pixels,
            rawBorders,
            bounds,
            windows: this.windowsByDisplay.get(display.id) ?? [],
          }),
          rawBorders.length,
        );
      } catch (err) {
        this.logger('元素检测调试图写入失败 %o', err);
      }
    }

    // 像素留给 hover 时的原生分辨率精修，换屏时跟着缓存一起换
    this.edgePixels.set(display.id, pixels);
    this.edgesByDisplay.set(display.id, bounds);
    return bounds;
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

    const current = this.screenWatcher
      .currentDisplay as Partial<Display> | null | undefined;
    if (
      seq !== this.captureSeq ||
      !this.capturing ||
      // 换屏后这份结果对应的是旧屏的图，坐标原点都对不上：以前靠 switchDisplay 里
      // ++captureSeq 顺带拦掉，现在换屏不再动 captureSeq，得在这里按屏判断
      (current && current.id !== display.id) ||
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
  private toPixels(
    image: ShotImage,
    display: Display,
    reuse?: boolean,
  ): Pixels {
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
      this.handleCancel();
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
        // 对话框开着的时候 ESC 必须留给对话框自己，否则用户按 ESC 关不掉它
        this.unregisterEscShortcut();
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
            // 对话框关了、截图还开着：把 ESC 还回来
            if (this.captureReady) {
              this.registerEscShortcut();
            }
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
     * 渲染端画完一帧的回执：换屏时窗口就是等这个才搬过去的，见 `switchDisplay`。
     */
    ipcMain.on('SCREENSHOTS:painted', (event) => {
      if (event.sender !== this.$view.webContents) {
        return;
      }
      this.paintWaiter?.resolve();
    });

    /**
     * 渲染端说"这块屏的底图我解好了"。
     *
     * 记下来之后，换到这块屏就不用再传一遍几 MB 的 PNG，也不用等它解码 ——
     * 换屏路径上只剩下"换元素"和"搬窗口"两件事。
     */
    ipcMain.on('SCREENSHOTS:preloaded', (event, displayId: number) => {
      if (event.sender !== this.$view.webContents) {
        return;
      }
      if (typeof displayId === 'number') {
        this.decodedInRenderer.add(displayId);
      }
    });

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
