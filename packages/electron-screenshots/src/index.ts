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
import { FREEZE_HTML } from './freeze.js';
import getDisplay, { type Display, toDisplay } from './getDisplay.js';
import getEdges, {
  type EdgeThresholds,
  getPreciseEdges,
  type Pixels,
  type Region,
} from './getEdges.js';
import getWindows, { resetWindowCache } from './getWindows.js';
import {
  getNodeScreenshotsLoadError,
  requireNodeScreenshots,
  warmUpNodeScreenshots,
} from './loadNodeScreenshots.js';
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
  /**
   * 抓屏前等多久（毫秒），给宿主"隐藏自己窗口"留出合成器时间，默认 `50`。
   *
   * 防截屏模式下宿主都是 `mainWindow.hide()` 之后立刻起截图，而这一抓**可能抓到
   * hide 生效前的那一帧** —— 底图上就留下宿主的残影（实测：`hide()` 之后 0ms 抓，
   * 窗口像素仍在画面里；16ms 后剩 0.3% 的边；50ms 后才彻底干净）。
   *
   * 只在本轮**第一次**抓屏前等一次，而且这段时间和建窗口（`reset` 等渲染回执）
   * 是并行的，所以基本不增加"从点击到画面锁住"的耗时。
   *
   * 传 0 关闭（宿主自己保证抓屏时窗口已经不在画面上）。
   */
  captureSettleMs?: number;
}

export type { Bounds };

const windowTypes: Record<string, string | undefined> = {
  darwin: 'panel',
  // linux 必须设置为 undefined，否则会在部分系统上不能触发focus 事件
  // https://github.com/nashaofu/screenshots/issues/203#issuecomment-1518923486
  linux: undefined,
  win32: 'toolbar',
};

/**
 * 兜底抓屏（`desktopCapturer`）里"丢弃第一帧"时，两次取源之间的间隔。
 *
 * 太短（<30ms）第二次很可能还是同一帧，等于白取；太长（>200ms）只会拖慢这条
 * 本来就已经很慢的路。60ms 够新的采集流产出第一帧，肉眼也看不出截图变慢。
 */
const FALLBACK_SECOND_GRAB_DELAY = 60;

/**
 * 覆盖层（截图窗口 + 冻结画面）用的窗口层级。
 *
 * 和微信、Snipaste 一样，覆盖层**压在菜单栏和程序坞之上**：整屏（含顶部那条和
 * 底部那条）被同一张定格画面 + 同一层压暗盖住，亮度一致，光标划过去只有高亮在变；
 * 选中的区域里也不会混进一条"活着的"、点得动的栏。
 *
 * 用 `screen-saver`（Electron 能给到的最高层级），是为了压住视频播放器、录屏工具、
 * 各种 HUD 这些常驻浮层 —— 它们普遍比菜单栏还高，降一档就压不住了。
 *
 * 注意：**靠层级盖住 ≠ 把系统那两条藏起来**。早先是用 `kiosk: true` 让应用进全屏
 * 演示模式，那是系统级的隐藏（菜单栏/程序坞真的被收走、还切了一次 Space），
 * 用户看到的就是"截图一出来任务栏没了"。现在只靠窗口层级盖住，系统状态一动不动。
 */
const OVERLAY_LEVEL = 'screen-saver';

/**
 * 抓屏前默认等多久，见 `ScreenshotsOpts.captureSettleMs`。
 *
 * 实测（macOS，宿主 `hide()` 之后立刻抓屏，按窗口区域的像素统计）：
 * `+0ms` 窗口像素仍然整块在画面里（26.0%，和可见时 26.2% 一样）；
 * `+16ms` 剩 0.3%（只剩边缘那一圈）；`+50ms` 才 0.00%。
 * 也就是说"截图里那层宿主残影"不是玄学，就是抓早了一帧。
 */
const CAPTURE_SETTLE_MS = 50;

/**
 * 当前系统能不能用**透明窗口**当覆盖层。
 *
 * 冻结画面是"透明窗口 + 页面里画截图和压暗"，整个前提是窗口真的透明。Windows 上透明窗口
 * 依赖 DWM 合成，而 **Windows 7 是可以关掉 DWM 的**（Basic/经典主题、远程桌面会话、
 * "调整为最佳性能"）。关掉之后 `transparent: true` 会退化成不透明黑块 —— 冻结画面就成了
 * 压在别的屏上的一块黑，比不盖还糟。Win8 之后 DWM 无法关闭，不必判断。
 *
 * 检测用两步：
 * 1. 系统版本 ≥ 6.2（Win8）直接放行；
 * 2. Win7 上只有 Electron ≤22（Win7 唯一能跑的版本）才有 `systemPreferences.isAeroGlassEnabled`，
 *    新版本已经删掉这个 API，所以按可选调用处理；拿不到就当有合成（Win7 默认主题就是 Aero）。
 */
function transparentOverlaySupported(): boolean {
  if (process.platform !== 'win32') {
    return true;
  }
  const [majorPart = '0', minorPart = '0'] = process
    .getSystemVersion()
    .split('.');
  const major = Number(majorPart);
  const minor = Number(minorPart);
  if (!Number.isFinite(major) || major > 6 || (major === 6 && minor >= 2)) {
    return true;
  }
  const probe = (
    systemPreferences as unknown as { isAeroGlassEnabled?: () => boolean }
  ).isAeroGlassEnabled;
  return typeof probe === 'function' ? probe.call(systemPreferences) : true;
}

/**
 * 多屏截图的两条硬约束（改这里之前先看 `freeze.ts` 与 `switchDisplay`）：
 *
 * 1. 每块屏上常驻一个「冻结画面」窗口：这张屏自己的截图 + 与活动屏同 alpha 的压暗。
 *    所有屏幕因此长得一模一样，光标划过去只有高亮在变，亮度不会跳。
 * 2. 换屏时交互窗口整层隐身（`setBlank`），换图 / 搬窗口 / 改尺寸都在看不见的时候做完。
 *    能这么干的前提就是第 1 条 —— 隐身之后露出来的还是同一张画面。
 */

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

  /** 本轮第一次抓屏前要等的毫秒数，见 `ScreenshotsOpts.captureSettleMs` */
  private captureSettleMs: number;

  /** 本轮"抓屏前的那一拍"已经等过了（只等第一次，其余屏与换屏补截不必再等） */
  private settleDone = false;

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
   * 本轮截图是否已经警告过"退化到 desktopCapturer"。
   *
   * 只在每轮第一次降级时打一条：这条路会连着走（活动屏 + 每块副屏 + 换屏补截），
   * 每次都打就把日志刷满了。
   */
  private fallbackWarned = false;

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

  /**
   * 每块屏的「冻结画面」窗口，key 为 display.id。
   *
   * 它不是遮罩，而是**这块屏自己的那张截图**（外加和活动屏同 alpha 的压暗）。
   * 于是整场截图里每块屏看起来都一样：一张定格的画面，均匀压暗 30%。
   *
   * 这一点是"换屏视觉平稳"的地基：
   * - 换屏时交互窗口整层隐身（`setBlank`），露出来的还是同一张画面、同一层压暗，
   *   用户看不到任何变化，换图/搬窗口/改尺寸都藏在后面做完；
   * - 非活动屏不再是"50% 纯黑盖在真实桌面上"，而是和活动屏亮度一致，
   *   光标划过去不会出现"这块屏突然亮一点、那块暗一点"；
   * - 真实桌面在压暗之后就不再露出来了，换屏中途也不会"解冻"一下再冻回去。
   *
   * 窗口本身常驻（整场只建一次），只在结束截图时销毁。
   */
  private $freezeWins = new Map<
    number,
    {
      $win: BrowserWindow;
      /** 页面加载完了没有：加载前的 IPC 会丢，所以图片和压暗都要先暂存 */
      loaded: boolean;
      /** 显示过没有。没显示过的窗口拍不进预截，也不会被算作"可以隐身" */
      shown: boolean;
      /** 这块屏的截图，等页面加载完补发 */
      png: Buffer | undefined;
      /** 压暗层该不该亮着（同样要能补发） */
      veil: boolean;
    }
  >();

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
    /**
     * 立刻查一次（不等定时器那一拍）。
     *
     * 光标一进到别的屏就调它：靠 100ms 轮询的话，这段时间光标还停在冻结画面上，
     * 显示的是 not-allowed，换过去才变回十字 —— 来回划屏就是"箭头闪一下"。
     */
    nudge: (() => void) | null;
  } = {
    currentDisplay: null as unknown as Display,
    timer: null,
    watching: false,
    lock: false,
    nudge: null,
  };

  constructor(opts?: ScreenshotsOpts) {
    super();
    this.logger = opts?.logger || debug('electron-screenshots');
    this.singleWindow = opts?.singleWindow || false;
    this.isPromptScreenPermission = opts?.promptScreenPermission || false;
    this.isDetectEdges = opts?.detectEdges || false;
    this.edgeThresholds = opts?.edgeThresholds;
    this.captureSettleMs = opts?.captureSettleMs ?? CAPTURE_SETTLE_MS;
    /**
     * 先依赖：原生模块在这里同步加载掉（实测几毫秒），第一次截图不用再等，
     * 加载失败的原因也能在构造时就落到 `getNodeScreenshotsLoadError()` 里。
     * 失败不抛 —— 抓屏和窗口识别各自走降级，构造不会被打崩。
     */
    warmUpNodeScreenshots();
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
     * 新一轮的两个一次性开关，必须在**发起抓屏之前**清掉：
     * 抓屏会先等 `captureSettleMs`（给宿主的 hide 留时间），这里晚一行就漏掉了。
     */
    this.settleDone = false;
    this.fallbackWarned = false;

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
     * 冻结画面先立起来：每块屏一张"自己的截图 + 30% 压暗"。
     *
     * 必须排在截图窗口 show 之前：遮罩要"跟着截图一起出来"。
     * 等绘制完再建就晚了几百毫秒，用户看到的是另一块屏先敞着、过一会儿才暗下去。
     *
     * 活动屏的截图此刻已经在手上（`shotPromise` 刚 resolve），压暗和画面直接给它；
     * 其他屏要等自己那块抓完，见 `captureOtherDisplays`。
     */
    this.ensureFreezeWindows();
    this.setFreezeVeil(display.id, true);
    this.pushFreezeImage(display.id, shot.png);

    /**
     * 先以**全透明**显示，等渲染端把这一帧画完再亮出来。
     *
     * 不能"等画完再 show"：隐藏窗口里 rAF 不跑、解码也慢得离谱（实测首次解码要 1 秒以上，
     * 而且经常等不到），主进程只能等到超时，截图窗口反而更晚出现。
     * 也不能"先 show 再等图"：窗口先出现但里面什么都没画完，等图到了再"啪"地换上去。
     * 所以取中间：显示（这样渲染进程才会正常出帧）但完全透明（用户看不见），
     * 画好了再亮出来，用户看到的第一帧就是完整的截图。
     *
     * 亮出来的这一刻是**看不出变化**的：底下那张冻结画面早就是同一张图、同一层压暗，
     * 换上来只是"同一画面换了个更靠前的窗口在画"。
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
   * **每块屏的像素一抓到手就立刻压暗自己的冻结画面**（不等 PNG 编码）——
   * 编码一块 5K 屏要几百毫秒，等编码完再压暗，几块屏会一块一块地暗下去，
   * 用户看到的就是"遮罩没同步出来"。
   * 编码完再把截图交给这个窗口：压暗已经在了，换成"压暗后的截图"是同一次变更，
   * 亮度不变、内容就是抓那一刻的屏幕，看不出来。
   * 失败只丢这一块屏的画面（换屏时再补截），不能让整次截图失败。
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
            const shot = await this.capture(display, () => {
              if (this.capturing) {
                this.setFreezeVeil(display.id, true);
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
            this.pushFreezeImage(display.id, shot.png);
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
      // 不管截成没截成，压暗都得亮起来，否则那块屏一直敞着、还能点到底下的应用
      this.revealFreezeVeils();
    }
  }

  /**
   * 取某块屏幕的截图：优先用预截缓存，没有才现场截。
   *
   * 现场截之前必须先把这块屏的冻结画面收起来，不然拍到的就是"上一张截图 + 压暗"——
   * 这也正是为什么换屏一律取缓存。只有"截图过程中新插进来的屏幕"会走到这条路径。
   */
  private async shotOf(
    display: Display,
  ): Promise<{ png: Buffer; image?: ShotImage | undefined }> {
    const cached = this.shots.get(display.id);
    if (cached) {
      return cached;
    }

    const item = this.$freezeWins.get(display.id);
    const needHide = !!item && item.shown && !item.$win.isDestroyed();
    if (needHide && item) {
      item.$win.hide();
    }
    let shot: { png: Buffer; image?: ShotImage | undefined };
    try {
      shot = await this.capture(display);
    } finally {
      // 先让窗口回来再推图：隐藏窗口里的解码会被拖住
      if (needHide && item && !item.$win.isDestroyed()) {
        item.$win.show();
        this.raiseInteractive(item.$win);
      }
    }

    this.shots.set(display.id, {
      display,
      png: shot.png,
      image: shot.image,
    });
    // 新插进来的屏：压暗 + 画面都得补上，否则换过去是一片真实桌面
    this.setFreezeVeil(display.id, true);
    this.pushFreezeImage(display.id, shot.png);
    return shot;
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
      // 同一时刻只留一条链：nudge 会插进来，不先清掉定时器就会跑出两条并行链
      if (this.screenWatcher.timer) {
        clearTimeout(this.screenWatcher.timer);
        this.screenWatcher.timer = null;
      }
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

    this.screenWatcher.nudge = () => {
      void checkScreen();
    };
    checkScreen();
  }

  /**
   * 光标换到另一块屏。
   *
   * 目标只有一个：**用户看不到任何变化**。换屏要做的三件事（换底图、搬窗口、改尺寸）
   * 每一件单独拿出来都会露出中间态，所以整段都放在"看不见的时候"做：
   *
   * 1. 交互窗口整层隐身（`setBlank`）—— 此刻两块屏上露出来的都是各自的冻结画面
   *    （同一张截图 + 同一层 30% 压暗），和隐身前一模一样；
   * 2. 新底图在隐身期间提交并画好（旧屏上不会闪出另一块屏的画面）；
   * 3. 搬窗口 + 改尺寸也在隐身期间完成（跨屏、跨缩放比的合成器重建看不见）；
   * 4. 新画面已经上屏，再取消隐身 —— 用户看到的第一帧就是新屏的画面。
   *
   * 没有冻结画面兜底时（Linux、或截图过程中新插进来还没截过的屏）退回原来的直接搬：
   * 那时隐身只会露出真实桌面，反而更闪。
   *
   * 截图一律取 `shotOf` 的缓存：目标屏此刻盖着冻结画面，重新截屏会把那层压暗拍进去。
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
    // 中途插拔屏幕时补齐冻结画面（正常情况下这里什么都不做）
    this.ensureFreezeWindows();
    const shot = await this.shotOf(display);
    // 换屏不算"新的一轮截图"：`captureSeq` 只在 startCapture 里递增。
    // 以前这里也 ++，而开场识别要一两秒才跑完 —— 用户在识别算完之前把光标划到
    // 另一块屏，整轮结果都会被判成过期丢掉，之后两块屏都不再有高亮/吸附，
    // 看起来就是"窗口边缘完全识别不出来"。识别结果该不该下发，改由屏 id 判断。
    const seq = this.captureSeq;

    // 两块屏都有冻结画面才敢隐身，否则露出来的就是真实桌面
    const masked =
      this.freezeReady(display.id) && this.freezeReady(previous.id);
    if (masked) {
      this.setBlank(true);
    }
    try {
      // 1. 渲染端换图并画好这一帧（整段都在隐身中）
      await this.prepareRenderer(display, shot.png);

      // 2. 内容已经就绪，窗口搬过去的第一帧就是新屏的画面
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
      if (masked) {
        /**
         * 让窗口的"搬家"先落到合成器上再取消隐身。
         *
         * 两者都是异步的：取消隐身要走 渲染端绘制 → 合成 → 上屏，通常比 setBounds
         * 慢一两帧，但跨屏（尤其跨缩放比）时并不保证。差一帧就是"新屏的画面
         * 在旧屏上闪一下"，代价只有十几毫秒，索性等一拍。
         */
        await new Promise<void>((resolve) => setTimeout(resolve, 16));
      }
    } finally {
      if (masked) {
        this.setBlank(false);
      }
    }

    this.logger(
      '换屏 → %d %dx%d 耗时 %dms%s',
      display.id,
      display.width,
      display.height,
      Math.round(performance.now() - startedAt),
      masked ? '（隐身切换）' : '',
    );

    // 换屏后只下发开场就算好的结果，1ms 量级；这里绝不能再跑识别
    this.sendRecognition(display, seq);
  }

  /**
   * 让交互窗口整层隐身 / 恢复。
   *
   * 用渲染端的 `visibility: hidden` 而不是 `win.setOpacity`：窗口本来就是透明的，
   * 藏掉内容就等于藏掉窗口，而 `setOpacity` 在部分平台/透明窗口上并不可靠。
   * 隐身期间窗口仍在最前面、仍然挡点击，只是画不出东西来。
   */
  private setBlank(blank: boolean): void {
    if (!this.$view || this.$view.webContents.isDestroyed()) {
      return;
    }
    this.$view.webContents.send('SCREENSHOTS:blank', blank);
  }

  private stopScreenWatcher() {
    if (this.screenWatcher.timer) {
      clearTimeout(this.screenWatcher.timer);
      this.screenWatcher.timer = null;
    }
    this.screenWatcher.watching = false;
    this.screenWatcher.nudge = null;
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
    // 下一轮重新计"抓屏前那一拍"与降级警告
    this.settleDone = false;
    this.fallbackWarned = false;
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
    this.destroyFreezeWindows();
    await this.reset();

    if (!this.$win) {
      return;
    }

    // 不再进 kiosk（见 enableLargerThanScreen 的注释），收尾就只剩常规的失焦 / 移除视图
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
         * mac 下设置为false，否则可能会导致程序坞不恢复问题
         */
        fullscreen: false,
        // mac fullscreenable 设置为 true 会导致应用崩溃
        fullscreenable: false,
        backgroundColor: '#00000000',
        titleBarStyle: 'hidden',
        hasShadow: false,
        paintWhenInitiallyHidden: false,
        // mac 特有的属性
        roundedCorners: false,
        /**
         * macOS 会把窗口的 frame 夹进"可见区域"（让出菜单栏那 30 多个点）。
         * 早先靠 `kiosk: true` 逃出这个夹取，代价是应用进全屏演示模式 —— 菜单栏和
         * 程序坞被系统收走、还切了一次 Space（用户看到的就是"截图一出来任务栏没了"）。
         * 现在改用这个开关：允许窗口超出屏幕范围，照样能盖满整屏（含菜单栏那条），
         * 但不触发全屏，系统状态一动不动。
         */
        enableLargerThanScreen: true,
        acceptFirstMouse: true,
      });

      this.emit('windowCreated', this.$win);
      this.$win.on('show', () => {
        // 断言置顶，最后抢焦点
        this.assertTopMost(this.$win);
        this.$win?.focus();
      });

      this.$win.on('closed', () => {
        this.emit('windowClosed', this.$win);
        this.$win = null;
        // 冻结画面不可聚焦、也不在任务栏，宿主直接 close 截图窗口时必须一起收掉，
        // 否则会留下一层用户点不掉的压暗遮罩
        this.destroyFreezeWindows();
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
   * 所以抬到 `OVERLAY_LEVEL`（`screen-saver`，Electron 能给到的最高层级）：
   * - Windows 上从 floating 到 status 都排在任务栏之下，只有 pop-up-menu 及以上才在任务栏之上；
   * - macOS 上对应 NSScreenSaverWindowLevel，能压住菜单栏、程序坞和绝大多数常驻浮层。
   *
   * `moveTop()` 负责同层级内的相对顺序（同层级时它才是决定谁在上面的那个）。
   * https://www.electronjs.org/docs/latest/api/browser-window#winsetalwaysontopflag-level-relativellevel
   */
  private assertTopMost($win: BrowserWindow | null): void {
    if (!$win || $win.isDestroyed()) {
      return;
    }
    $win.setAlwaysOnTop(true, OVERLAY_LEVEL);
    $win.moveTop();
  }

  /**
   * 把截图窗口和所有冻结画面一起抬回最上层，**截图窗口必须在最后**。
   *
   * 顺序不能反：冻结画面和截图窗口同在 `OVERLAY_LEVEL` 层级，谁后抬谁在上面。
   * 冻结画面一旦压住活动屏的截图窗口，macOS 会把截图窗口判成 occluded，
   * 渲染端被节流（rAF 停、定时器拖到 1s），换屏就开始"追不上光标"。
   */
  private raiseAll(): void {
    for (const item of this.$freezeWins.values()) {
      if (!item.$win.isDestroyed()) {
        item.$win.setAlwaysOnTop(true, OVERLAY_LEVEL);
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
   * 为**每一块**屏幕建一个常驻的「冻结画面」窗口。
   *
   * 早先是"活动屏不留、其余屏建"，于是每换一次屏都要销毁一个、重建一个 ——
   * 重建要走 `new BrowserWindow` + `loadURL` + `show`，实测 80~150ms。
   * 这段空窗期里刚离开的那块屏会露出**真实桌面**，然后才被半透明黑盖上：
   * 来回切换就是"亮一下、黑一下"的闪烁。
   *
   * 现在一次建全、整场只推两个状态（压暗、截图），换屏不再创建/销毁任何窗口。
   *
   * 建出来先**不显示**：预截其他屏幕时它不能被拍进去，透明窗口在 Windows 上
   * 首帧也可能闪一下黑。等这块屏的像素抓到、要压暗了再 show（见 `setFreezeVeil`）。
   */
  private ensureFreezeWindows(): void {
    /**
     * Linux 整平台跳过，原因不在"没有这个约束"，而在**摆不动窗口**。
     *
     * 冻结画面的前提是"把窗口钉死在某块屏的 (x,y,w,h) 上"。Wayland 下客户端拿不到全局坐标，
     * 窗口位置完全由合成器决定，`setBounds` 的 x/y 会被忽略 —— 这套东西根本表达不出来。
     * X11 本来可以（多数发行版 Electron 默认还走 XWayland，定位是正常的），但这里没有区分
     * 会话类型（`XDG_SESSION_TYPE` / `WAYLAND_DISPLAY`），索性一刀切跳过。
     *
     * 这条早退是从上一代「屏蔽窗口」继承下来的（Wayland 下同样无法定位），不是这一版新加的。
     *
     * 代价只落在多屏：单屏时冻结画面本来就被截图窗口完全盖住、不参与任何视觉；多屏则退化成
     * "换屏直接搬窗口"（`switchDisplay` 里 `masked` 恒 false），换屏会闪一下，别的屏也挡不住点击。
     *
     * Windows 7 关掉 DWM 时同样不建（透明窗口会变黑块，见 `transparentOverlaySupported`）。
     */
    if (process.platform === 'linux' || !transparentOverlaySupported()) {
      return;
    }

    const alive = new Set<number>();
    let created = false;

    for (const display of screen.getAllDisplays()) {
      alive.add(display.id);
      if (this.$freezeWins.has(display.id)) {
        continue;
      }
      created = true;

      const bounds = {
        x: Math.floor(display.bounds.x),
        y: Math.floor(display.bounds.y),
        width: Math.floor(display.bounds.width),
        height: Math.floor(display.bounds.height),
      };

      const $win = new BrowserWindow({
        title: 'screenshots-freeze',
        ...bounds,
        useContentSize: true,
        type: windowTypes[process.platform] as string,
        frame: false,
        show: false,
        // 页面本体就是截图 + 压暗，窗口底色必须透明，压暗层才压得住真实桌面
        transparent: true,
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
        /**
         * **必须盖满整屏（含菜单栏那 30 多个点）**，否则页面里的截图会整体下移：
         * 屏幕顶部露出真实的菜单栏，紧接着又是冻结画面里自带的那条 —— 看上去就是
         * "顶上有两个任务栏"。
         *
         * macOS 会把窗口的 frame 夹进"可见区域"。早先靠 `kiosk: true` 逃出夹取，
         * 代价是系统进全屏演示模式、菜单栏和程序坞被藏起来；现在改成
         * `enableLargerThanScreen`：允许超出屏幕范围，但不触发全屏。
         * 盖住之后由 `OVERLAY_LEVEL` 保证它压在菜单栏/程序坞之上。
         */
        enableLargerThanScreen: true,
        fullscreen: false,
        // mac fullscreenable 设置为 true 会导致应用崩溃（与截图窗口同因）
        fullscreenable: false,
        backgroundColor: '#00000000',
        titleBarStyle: 'hidden',
        roundedCorners: false,
        hasShadow: false,
        webPreferences: {
          preload: require.resolve('./freezePreload.js'),
          nodeIntegration: false,
          contextIsolation: true,
          // 这个窗口整场都在等主进程推图，被判定"后台"也不能把定时器拖慢
          backgroundThrottling: false,
        },
      });

      const item = {
        $win,
        loaded: false,
        shown: false,
        png: undefined as Buffer | undefined,
        veil: false,
      };
      this.$freezeWins.set(display.id, item);
      $win.on('closed', () => {
        this.$freezeWins.delete(display.id);
      });

      /**
       * **构造参数里的尺寸靠不住，建完必须再落一次 `setBounds`。**
       *
       * Windows 创建顶层窗口时会把尺寸夹到"主屏工作区"里，夹的是**宽高**，跟任务栏在哪条边无关：
       * - 任务栏在底部（主屏 1536×864，工作区高 816）：主屏建出来 1536×816，副屏 2048×1152 也建出来 1536×816；
       * - 任务栏在左侧（工作区 1488×864）：主屏建出来 1488×864，副屏同样被夹成 1488×864。
       *
       * 也就是说副屏不管多大，都直接套用主屏工作区的尺寸。窗口一旦建小，这块屏上就只有
       * 左上角一小块"压暗的小截图"：整张图被压进小窗口里，图里自带的那条任务栏（横的或竖的）
       * 跑到屏幕中间，边上再压着一条真实任务栏 —— 用户看到的就是"扩展屏出现小的遮罩图"
       * 和"截图时多个任务栏"。
       *
       * 这个夹取只发生在**创建阶段**：创建后 `setBounds` 到真实尺寸能落地，之后 `show()`
       * 也不会再被夹回去（已实测，任务栏在底部/左侧两种布局都验过）。截图窗口那边本来就
       * 有一次 `setBounds`，所以只有冻结画面会中招 —— 老版纯黑遮罩同样中招，只是纯黑少一块
       * 看不出来。
       *
       * 三个平台都补：Windows 是上面那条尺寸夹取，macOS 是 frame 夹进可见区域
       * （配合 `enableLargerThanScreen` 才彻底生效），Linux 多调一次也无副作用。
       */
      $win.setBounds(bounds);

      // 冻结画面也要压在最上面：默认 floating 层级压不住那些常驻浮层，
      // 一旦被别的窗口盖住，用户就能看到真实桌面、也能点到底下的应用
      $win.setAlwaysOnTop(true, OVERLAY_LEVEL);

      // 它必须可聚焦光标才会更新，所以一拿到焦点就立刻还给截图窗口
      $win.on('focus', () => {
        if (this.capturing) {
          this.$win?.focus();
        }
      });

      $win.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(FREEZE_HTML)}`,
      );

      $win.webContents.on('did-finish-load', () => {
        if ($win.isDestroyed()) {
          return;
        }
        item.loaded = true;
        this.assertTopMost($win);
        this.raiseInteractive($win);
        // 页面加载前推的状态会丢，这里补一次；顺序固定：先压暗，再上图
        this.setFreezeVeil(display.id, item.veil);
        if (item.png) {
          $win.webContents.send('SCREENSHOTS:freeze-image', item.png);
        }
      });
    }

    // 拔掉的屏幕：销毁它那块，别留着挡一块不存在的区域
    for (const [id, item] of this.$freezeWins) {
      if (!alive.has(id)) {
        this.$freezeWins.delete(id);
        if (!item.$win.isDestroyed()) {
          item.$win.destroy();
        }
      }
    }

    // 新窗口是后建的，会压在截图窗口之上，必须重新抬回去
    if (created) {
      this.raiseInteractive();
    }
  }

  /**
   * 把截图窗口重新抬到所有冻结画面之上。
   *
   * 反过来（冻结画面压住截图窗口）后果不只是层级不对：macOS 会把被完全遮住的窗口
   * 判成 occluded，Chromium 于是把渲染端当后台页面节流 —— `document.visibilityState`
   * 变成 hidden，rAF 不跑、定时器拖到 1s，换屏时的绘制回执就迟迟不到，
   * 表现就是"窗口追不上光标、来回划屏一路闪"。
   */
  private raiseInteractive($freeze?: BrowserWindow | null): void {
    if ($freeze && !$freeze.isDestroyed()) {
      this.assertTopMost($freeze);
    }
    if (this.$win && !this.$win.isDestroyed()) {
      this.assertTopMost(this.$win);
      this.$win.moveTop();
    }
  }

  /**
   * 打开/关掉某块屏的压暗层（第一次打开时顺带把窗口显示出来）。
   *
   * 只动页面里的一个类，窗口本身常驻 —— 换屏路径上不再有窗口的创建销毁。
   *
   * 显示用 `show()` 而不是 `setOpacity`：透明窗口在 Windows 上对 setOpacity
   * 支持不可靠，一旦没生效就是"整块屏永远不压暗"。
   */
  private setFreezeVeil(displayId: number, on: boolean): void {
    const item = this.$freezeWins.get(displayId);
    if (!item || item.$win.isDestroyed()) {
      return;
    }
    item.veil = on;
    if (on && !item.shown) {
      item.shown = true;
      item.$win.show();
      // 上屏后再落一次 bounds：macOS 的 frame 夹取可能发生在第一次上屏时，
      // 而 `enableLargerThanScreen` 下这次 setBounds 才真正盖满整屏
      if (process.platform === 'darwin') {
        const display = screen.getAllDisplays().find((d) => d.id === displayId);
        if (display) {
          item.$win.setBounds({
            x: Math.floor(display.bounds.x),
            y: Math.floor(display.bounds.y),
            width: Math.floor(display.bounds.width),
            height: Math.floor(display.bounds.height),
          });
        }
      }
      // show() 会把它抬到截图窗口之上，必须马上还回去（否则渲染端被判 occluded）
      this.raiseInteractive(item.$win);
    }
    if (!item.loaded) {
      return;
    }
    item.$win.webContents.send('SCREENSHOTS:freeze-veil', on);
  }

  /**
   * 把某块屏的截图交给它的冻结画面窗口。
   *
   * 页面还没加载完就先存着，`did-finish-load` 时补发 —— 早发的 IPC 会直接丢掉。
   */
  private pushFreezeImage(displayId: number, png: Buffer): void {
    const item = this.$freezeWins.get(displayId);
    if (!item) {
      return;
    }
    item.png = png;
    if (!item.loaded || item.$win.isDestroyed()) {
      return;
    }
    item.$win.webContents.send('SCREENSHOTS:freeze-image', png);
  }

  /** 每块屏都压暗（预截完成之后调，之前必须保持不显示） */
  private revealFreezeVeils(): void {
    for (const id of this.$freezeWins.keys()) {
      this.setFreezeVeil(id, true);
    }
  }

  /** 这块屏有没有可用的冻结画面（显示过、页面也加载完了） */
  private freezeReady(displayId: number): boolean {
    const item = this.$freezeWins.get(displayId);
    return !!item && item.loaded && item.shown && !item.$win.isDestroyed();
  }

  private destroyFreezeWindows(): void {
    for (const item of this.$freezeWins.values()) {
      if (!item.$win.isDestroyed()) {
        item.$win.destroy();
      }
    }
    this.$freezeWins.clear();
  }

  /**
   * 抓屏前等一拍，把"宿主刚 hide 掉自己窗口"这件事让合成器做完。
   *
   * 防截屏模式下宿主的调用顺序永远是 `mainWindow.hide()` → `startCapture()`，
   * 中间只有几个微任务；而抓屏拿到的是**调用那一刻屏幕上的合成结果**，
   * `hide()` 还没被 WindowServer 处理完，于是宿主窗口原封不动地进了底图 ——
   * 用户看到的就是"截图里有一层自己应用的虚影/残影"。
   *
   * 实测（见 `CAPTURE_SETTLE_MS`）：0ms 抓 → 窗口整块还在；16ms → 只剩边缘；
   * 50ms → 彻底干净。所以这里等 50ms，而且**只等本轮第一次**：
   * 后面那些抓屏（其他屏预截、换屏补截）发生时窗口早就没了。
   *
   * 这段等待和 `createWindow`（`reset` 要等渲染端回执，实测几十到几百毫秒）并行，
   * 所以"从点击到画面锁住"的耗时基本不变。
   */
  private async settleBeforeGrab(): Promise<void> {
    if (this.settleDone || this.captureSettleMs <= 0) {
      return;
    }
    this.settleDone = true;
    const startedAt = performance.now();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, this.captureSettleMs);
    });
    this.logger(
      '抓屏前等待 %dms（给宿主 hide 留合成时间，实际 %dms）',
      this.captureSettleMs,
      Math.round(performance.now() - startedAt),
    );
  }

  /**
   * 截一块屏。
   *
   * `onGrabbed` 在**像素已经抓到手**、还没开始编码的那一刻回调。
   * 压暗就靠它抢时间：`toPng` 编码一块 5K 屏要几百毫秒，等编码完再压暗，
   * 用户看到的就是"另一块屏慢半拍才暗下去"。抓完就压暗，编码在后面慢慢做。
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

    await this.settleBeforeGrab();

    try {
      let time = performance.now();
      // 必须走 CJS require（见 loadNodeScreenshots）：asar 里动态 import 会 ENOTDIR，
      // 一失败就退到下面的 desktopCapturer 兜底，而那条路的第一帧可能是旧帧。
      // 模块在构造时就预热过，这里通常只是一次同步取缓存
      const { Monitor } = requireNodeScreenshots();
      const loadCost = Math.round(performance.now() - time);
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
        'SCREENSHOTS:capture 耗时 load %dms fromPoint %dms captureImage %dms toPng %dms png %dKB',
        loadCost,
        fromPointCost,
        imageCost,
        pngCost,
        Math.round(buffer.length / 1024),
      );
      return { png: buffer, image };
    } catch (err) {
      this.logger('SCREENSHOTS:capture Monitor capture() error %o', err);
      const time = performance.now();
      const sources = await this.fallbackSources(display);
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
   * 兜底抓屏用的屏幕源（`desktopCapturer`）。
   *
   * 只在 `node-screenshots` 用不了时才走到这里：asar 里解析失败、原生模块没装、
   * 采集调用抛错。这条路有两个坑，都在这儿挡掉：
   *
   * 1. **第一帧可能是旧帧** —— 这就是"截图里有一层宿主窗口残影"的现场。
   *    `desktopCapturer.getSources` 在 macOS 上是"新建一条采集流、取第一帧"，
   *    而这一帧可能来自 WindowServer 里**更早**的合成结果：宿主刚 `hide()` /
   *    最小化的那个窗口还留在里面（半透明、位置尺寸都可能不是当下的）。
   *    所以这里取两次源、**只用第二次**的缩略图 —— 第二帧一定是这条流开始之后画的。
   *    代价是多花一次 `getSources`（几百毫秒），但这条路本来就不是快路径，
   *    宁可慢也不能把残影冻进截图。
   * 2. **静默降级** —— 同一个模块挂了，窗口枚举（`Window.all()`）必然也是空列表，
   *    用户只会看到"没有高亮 + 有残影"，根本分不清是权限、依赖还是解析问题。
   *    所以每轮截图第一次走到这里都打一条明确的警告。
   */
  private async fallbackSources(
    display: Display,
  ): Promise<DesktopCapturerSource[]> {
    if (!this.fallbackWarned) {
      this.fallbackWarned = true;
      const reason = getNodeScreenshotsLoadError();
      this.logger(
        '抓屏退化到 desktopCapturer：画面可能带宿主刚隐藏窗口的残影，窗口识别同时不可用%s',
        reason ? `（${reason.message}）` : '',
      );
    }

    const thumbnailSize = {
      width: Math.floor(display.width * display.scaleFactor),
      height: Math.floor(display.height * display.scaleFactor),
    };
    const first = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize,
    });
    // 等一拍再取第二次：新建采集流要一点时间才会产出"当下"的帧，
    // 立刻重取大概率还是同一帧（等于没换）
    await new Promise<void>((resolve) => {
      setTimeout(resolve, FALLBACK_SECOND_GRAB_DELAY);
    });
    try {
      const second = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize,
      });
      if (second.length) {
        this.logger(
          'SCREENSHOTS:capture 兜底取源两次，丢弃第一帧（%d 个源）',
          second.length,
        );
        return second;
      }
    } catch (err) {
      this.logger('SCREENSHOTS:capture 兜底第二次取源失败，退回第一帧 %o', err);
    }
    return first;
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
    const current = this.screenWatcher.currentDisplay as
      | Partial<Display>
      | null
      | undefined;
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

    const current = this.screenWatcher.currentDisplay as
      | Partial<Display>
      | null
      | undefined;
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

    /**
     * 光标进了某块屏的冻结画面：立刻查一次屏，别等 100ms 的轮询。
     *
     * 只认自己那些冻结画面发来的消息，别的窗口发来的一律忽略。
     */
    ipcMain.on('SCREENSHOTS:freeze-enter', (event) => {
      if (!this.capturing) {
        return;
      }
      const fromFreeze = [...this.$freezeWins.values()].some(
        (item) =>
          !item.$win.isDestroyed() &&
          item.$win.webContents.id === event.sender.id,
      );
      if (!fromFreeze) {
        return;
      }
      this.screenWatcher.nudge?.();
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
