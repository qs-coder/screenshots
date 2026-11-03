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
import {
  hasIndicatorCandidate,
  stripRecordingIndicator,
} from './stripIndicator.js';

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

/** 一块屏的一次抓屏结果：PNG 给渲染端，`image` 留给元素识别取原生像素 */
type Shot = { png: Buffer; image?: ShotImage | undefined };

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
 *
 * 但这是**一台机器、一种窗口**测出来的，别把它当保证：Windows 上同样 50ms，
 * 宿主主窗口（真实页面、有 preload）有时还在合成里 —— 抓到的是一张"窗口框还在、
 * 内容已经清空"的半截画面，压进底图就是用户说的残影。所以 50ms 只是第一拍的
 * 起点，真正的兜底是下面 `GRAB_*` 那一组"抓到画面不再变为止"。
 */
const CAPTURE_SETTLE_MS = 50;

/**
 * 第一次抓屏之后，隔多久再抓一张做"画面还在不在变"的比对。
 *
 * 宿主窗口从 hide 到彻底从合成里消失，实测跨机器能差到 300ms 量级；
 * 80ms 够走过 DWM 的一两帧，又不会把"从点击到画面锁住"明显拖长
 * （这段和建窗口并行，通常被 `createWindow` 那 100~500ms 完全盖住）。
 */
const GRAB_STABLE_GAP_MS = 80;

/**
 * 一次截图里第一次抓屏最多抓几张。
 *
 * 3 张 = 首拍 + 两次校正，最坏多花 160ms。再多就没意义了：那已经不是
 * "宿主窗口在消失"，而是屏幕本身一直在动（视频、动画），继续等只会一直等下去。
 */
const GRAB_MAX_ROUNDS = 3;

/**
 * 两张图差异超过这个比例就认为"画面还在变"，继续抓下一张。
 *
 * 采样点里 0.2% 不同 ≈ 全屏 4000 个点。消失中的窗口动辄占屏幕 10%~30%，
 * 而光标闪烁、输入框光标这类变化只有几十个点，不会误判成"没稳定"。
 */
const GRAB_DIFF_RATIO = 0.002;

/**
 * 比对两张图时的采样步长（像素）。取质数，避免和屏幕宽度共振导致
 * 永远只采到同一列。
 */
const GRAB_DIFF_SAMPLE_STEP = 61;

/**
 * 等渲染端就绪的上限。
 *
 * 渲染端首次启动实测 0.8~7s（冷启动、机械硬盘、宿主机主进程忙时更久），
 * 所以给到 12s。超过就认为页面卡死/没加载出来：**必须抛出去**，
 * 宿主才能把藏起来的主窗口还回来；无限等下去的表现就是"点了截图什么都没发生"，
 * 而且宿主的会话状态（in-flight 标志）也跟着一起卡死。
 */
const RENDERER_READY_TIMEOUT = 12_000;

/**
 * 页面导航"发起后迟迟没提交"的看门狗间隔。
 *
 * `webContents.loadURL()` 只是**发起**导航，真正提交要等渲染进程应答。实测
 * 应用里一个可见窗口都没有时（托盘应用、主窗口已经 `hide()` 才第一次建截图、
 * 或者隐藏窗口里的 BrowserView），这次导航会一直挂在 pending 上：
 * `getURL()` 是空的、`isLoading()` 一直是 true，`did-finish-load` 永远不来。
 *
 * 这种"卡在发起阶段"和"页面真的加载慢"是两回事：前者重新 `loadURL` 一次就能过，
 * 后者重试也没用。所以单独设一个短看门狗，在超时之前就把卡住的导航重新踢一脚，
 * 而不是干等 12s（那 12s 里用户看到的就是"点了截图没反应"）。
 */
const RENDERER_KICK_MS = 1_500;

/** 最多踢几次：够走过"窗口刚显示、合成器还没就绪"这个窗口期，又不会无限重发 */
const RENDERER_MAX_KICKS = 3;

/**
 * 兜底抓屏（`desktopCapturer.getSources`）一次调用的上限。
 *
 * 这条路只在 `node-screenshots` 用不了时才走（asar 里原生模块解析失败等），
 * 而它在 Windows 上偶发不返回：采集流建不起来时既不 resolve 也不 reject。
 * 正常一次全屏取源 300ms~2s，给 8s 已经很宽；超时就当失败，让调用方回滚，
 * 不能让整次截图停在"等一个永远不来的 Promise"上。
 */
const DESKTOP_CAPTURER_TIMEOUT = 8_000;

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

  /**
   * 本轮"抓屏前的那一拍"。
   *
   * 存的是 **Promise 而不是布尔**：一轮里所有屏幕是同时开抓的（见 `grabAllDisplays`），
   * 用一个共享的 Promise 才能让它们等的是同一个 50ms，而不是"谁先到谁等、
   * 后到的一律不等" —— 后者会让后发的抓屏早 50ms 拍到宿主还没隐藏干净的画面。
   */
  private settlePromise: Promise<void> | null = null;

  /**
   * 本轮是不是还处在"第一波抓屏"。
   *
   * `settlePromise` 解决"等的是同一拍"，这个标记解决"谁要做稳定校正"：
   * 第一波（所有屏幕同时开抓的那一次）每块屏都做 `grabUntilStable`，
   * 后面的换屏补截只 await 一个早已 resolve 的 Promise（立即放行、不再校正），
   * 因为那时宿主窗口早就从合成里消失了，多抓只是白花时间。
   */
  private settleFirst = true;

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
   * ESC 只在这之后才生效：之前窗口还是整层隐身，用户看不见任何东西，
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

  /**
   * `isReady` 的兑现函数。
   *
   * ⚠️ 这两个字段**必须声明在 `isReady` 之前**：类字段按声明顺序初始化，
   * 写在后面的话 `= null` 会在 `isReady` 的 executor 执行完之后再跑一遍，
   * 把刚捕获到的 resolve/reject 又覆盖成 null —— 于是 `isReady` 永远无法兑现，
   * 每次截图都要干等到超时才报错（表现就是"有时能截、有时点半天没反应"）。
   */
  private resolveReady: (() => void) | null = null;

  private rejectReady: ((err: Error) => void) | null = null;

  /**
   * 渲染端就绪（`SCREENSHOTS:ready`）。
   *
   * 这个信号是**截图窗口能不能出画面的唯一前提**：没等到它就去建窗口、下发底图，
   * 用户看到的是一个全屏透明窗口，点不掉也看不见；而 `startCapture` 会一直挂在这里，
   * 宿主那边"抓屏中"的标志永远不复位 —— 表现就是"点了截图没反应，之后再也截不了"。
   *
   * 所以它必须能被**拒绝**，不能是个只能 resolve 的 promise：
   * - 页面加载失败 / 渲染进程崩溃 → `failRendererReady()` 立刻拒绝（先自动重载一次）；
   * - 一直不吭声 → 调用方 `waitRendererReady()` 用 `RENDERER_READY_TIMEOUT` 兜底。
   */
  private isReady = new Promise<void>((resolve, reject) => {
    this.resolveReady = resolve;
    this.rejectReady = reject;
  });

  /** 就绪信号已经有结论了（成功或失败），后面的 ready 消息不再重复处理 */
  private readySettled = false;

  /** 渲染端确实起不来时的原因，`startCapture` 直接把它抛给宿主 */
  private readyError: Error | null = null;

  /** 页面加载失败自动重载的次数（只重试一次，避免死循环） */
  private rendererReloads = 0;

  /** 导航卡在 pending 上被重新发起的次数，见 `kickStalledNavigation` */
  private rendererKicks = 0;

  /** 导航看门狗的定时器 */
  private kickTimer: NodeJS.Timeout | null = null;

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
    // 拒绝路径没人 await 时（构造完就失败）不能变成 unhandledRejection，
    // 真正的错误由 `waitRendererReady()` 重新抛给调用方
    this.isReady.catch(() => {});
    this.watchRenderer();
    this.loadRenderer();
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

  /** 渲染端页面的地址（asar 里也走同一套解析） */
  private rendererUrl(): string {
    return `file://${require.resolve('@qs-coder/react-screenshots/dist/electron.html')}`;
  }

  /**
   * 加载（或重载）渲染端页面。
   *
   * 抽成方法是为了让 `did-fail-load` 能重试一次：asar 路径、编码后的产物、
   * 偶发的 ERR_ABORTED 都可能让第一次加载失败，而页面一旦没起来，
   * 后面所有截图都只能"挂住"。
   */
  private loadRenderer(): void {
    try {
      const url = this.rendererUrl();
      this.logger('加载渲染端 %s', url);
      this.$view.webContents.loadURL(url);
    } catch (err) {
      // require.resolve 失败（依赖没装/产物缺 dist）会同步抛，直接定成不可用
      const message = err instanceof Error ? err.message : String(err);
      this.failRendererReady(`渲染端页面解析失败：${message}`);
    }
  }

  /**
   * 盯住渲染端的加载/崩溃，把"页面根本没起来"变成一次明确的失败。
   *
   * 以前这里只有 `ipcMain.once('SCREENSHOTS:ready')`：页面要是加载失败，
   * 这个 once 永远等不到，`startCapture` 就永久挂起 —— 宿主看到的是
   * "主窗口藏了、截图窗没出来"，只能重启应用。
   */
  private watchRenderer(): void {
    const { webContents } = this.$view;

    // 用 on 而不是 once：重载后会再发一次，靠 `readySettled` 去重
    ipcMain.on('SCREENSHOTS:ready', () => {
      this.markRendererReady();
    });

    webContents.on('did-finish-load', () => {
      this.logger('渲染端加载完成');
      // 导航已经提交，看门狗没必要再跑
      this.stopKickWatch();
      // 加载成功就允许下一次失败再重试
      this.rendererReloads = 0;
      this.rendererKicks = 0;
    });

    webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        // 子框架失败与截图无关；-3 是 ERR_ABORTED（主动重载/取消），不算失败
        if (!isMainFrame || errorCode === -3) {
          return;
        }
        this.logger(
          '渲染端加载失败 %d %s %s',
          errorCode,
          errorDescription,
          validatedURL,
        );
        this.retryOrFail(`did-fail-load ${errorCode} ${errorDescription}`);
      },
    );

    webContents.on('render-process-gone', (_event, details) => {
      this.logger('渲染进程退出 %o', details);
      this.retryOrFail(`render-process-gone ${details?.reason ?? 'unknown'}`);
    });

    webContents.on('preload-error', (_event, preloadPath, error) => {
      // preload 挂了 → 页面里没有 `window.screenshots`，ready 也不会来
      this.logger('渲染端 preload 失败 %s %o', preloadPath, error);
      this.retryOrFail(`preload-error ${preloadPath}`);
    });
  }

  /**
   * 导航看门狗：`loadURL()` 发起后如果迟迟没有提交，就重新踢一脚。
   *
   * 判据是 `webContents.getURL()`：导航一旦提交，这里立刻有值；一直为空
   * 说明这次导航卡在了"发出去但渲染进程没应答"的状态。这种状态**不会自愈**，
   * 也不会触发 `did-fail-load`（它压根没失败，只是没开始），所以只能主动重发。
   *
   * 实测触发场景：应用里一个可见窗口都没有时（托盘应用、主窗口已经 `hide()`
   * 之后才第一次建截图实例、隐藏窗口里的 BrowserView），渲染进程拿不到合成器
   * 的帧槽，导航就一直挂着。窗口一显示出来重发就能过。
   */
  private kickStalledNavigation(): void {
    this.stopKickWatch();
    if (this.readySettled) {
      return;
    }
    this.kickTimer = setTimeout(() => {
      this.kickTimer = null;
      if (this.readySettled) {
        return;
      }
      const { webContents } = this.$view;
      if (webContents.isDestroyed()) {
        return;
      }
      // 已经有 URL = 导航提交了，剩下的只是加载慢，交给总超时管
      if (webContents.getURL()) {
        return;
      }
      if (this.rendererKicks >= RENDERER_MAX_KICKS) {
        this.logger('渲染端导航连续 %d 次未提交，不再重发', this.rendererKicks);
        return;
      }
      this.rendererKicks += 1;
      this.logger(
        '渲染端导航未提交（第 %d 次），重新发起加载',
        this.rendererKicks,
      );
      this.loadRenderer();
      this.kickStalledNavigation();
    }, RENDERER_KICK_MS);
    // 看门狗不该拖着进程不退出
    this.kickTimer.unref?.();
  }

  private stopKickWatch(): void {
    if (this.kickTimer) {
      clearTimeout(this.kickTimer);
      this.kickTimer = null;
    }
  }

  /** 加载/渲染失败：先自动重载一次，还不行就定成不可用 */
  private retryOrFail(reason: string): void {
    if (this.readySettled) {
      return;
    }
    if (this.rendererReloads < 1) {
      this.rendererReloads += 1;
      this.logger('渲染端异常（%s），重载一次', reason);
      // 让出这一轮，避免在 did-fail-load 回调里直接 loadURL 又被判成 ERR_ABORTED
      setTimeout(() => {
        this.loadRenderer();
      }, 150);
      return;
    }
    this.failRendererReady(reason);
  }

  private markRendererReady(): void {
    if (this.readySettled) {
      return;
    }
    this.readySettled = true;
    this.stopKickWatch();
    this.logger('SCREENSHOTS:ready');
    this.resolveReady?.();
  }

  private failRendererReady(reason: string): void {
    if (this.readySettled) {
      return;
    }
    this.readySettled = true;
    this.readyError = new Error(`截图渲染端不可用：${reason}`);
    this.stopKickWatch();
    this.logger('渲染端不可用 %s', reason);
    this.rejectReady?.(this.readyError);
  }

  /**
   * 等渲染端就绪，**超时就抛**。
   *
   * 这是"点了截图没反应"那条路的唯一出口：抛出去 → `startCapture` 回滚覆盖层
   * 并把错误交给宿主 → 宿主 `catch` 里把藏起来的主窗口还回来。
   * 宁可报错，也不能让宿主停在一个"窗口藏了、截图没出来"的死状态上。
   */
  private async waitRendererReady(): Promise<void> {
    if (this.readySettled) {
      if (this.readyError) {
        throw this.readyError;
      }
      return;
    }

    // 先把看门狗挂上：导航要是卡在"发出去没应答"，1.5s 后就会重发，
    // 不用等到 12s 总超时才动作
    this.kickStalledNavigation();

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), RENDERER_READY_TIMEOUT);
    });

    try {
      const result = await Promise.race([
        this.isReady.then(() => 'ready' as const),
        timeout,
      ]);
      if (result === 'timeout') {
        // 一直不吭声：最后再给一次机会（页面可能白屏），仍不行就报错
        this.logger('渲染端 %dms 未就绪，重载一次', RENDERER_READY_TIMEOUT);
        this.loadRenderer();
        const second = await Promise.race([
          this.isReady.then(() => 'ready' as const),
          new Promise<'timeout'>((resolve) => {
            timer = setTimeout(
              () => resolve('timeout'),
              RENDERER_READY_TIMEOUT,
            );
          }),
        ]);
        if (second === 'timeout') {
          throw new Error(
            `截图渲染端 ${RENDERER_READY_TIMEOUT * 2}ms 内没有就绪（已重载一次）`,
          );
        }
      }
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }

    if (this.readyError) {
      throw this.readyError;
    }
  }

  /**
   * 开始截图的过程中途失败时的回滚。
   *
   * 失败可能发生在任意一步之后（抓屏抛错、渲染端没就绪、建窗口抛错），
   * 而这一步之前可能已经把冻结画面立起来、把截图窗口 show 出来（整层隐身）。
   * 不回滚的话，用户面前会留下一层看不见又点不掉的覆盖层。
   */
  private abortStart(reason: unknown): void {
    this.logger('startCapture 失败，回滚覆盖层 %o', reason);
    this.capturing = false;
    this.captureReady = false;
    this.settlePromise = null;
    this.settleFirst = true;
    this.stopTopMostGuard();
    this.stopScreenWatcher();
    this.stopKickWatch();
    this.unregisterEscShortcut();
    this.destroyFreezeWindows();
    this.shots.clear();
    this.windowsByDisplay.clear();
    this.edgesByDisplay.clear();
    this.edgePixels.clear();
    this.decodedInRenderer.clear();
    this.edgeSource = undefined;
    this.captureWindows = [];
    const $win = this.$win;
    if ($win && !$win.isDestroyed()) {
      // 失败前可能停在"整层隐身"的预热态，恢复显示再藏，下一轮才不会整层空白
      this.setBlank(false);
      $win.hide();
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
    this.settlePromise = null;
    this.settleFirst = true;
    this.fallbackWarned = false;

    /**
     * 先把屏幕**冻住**，再去等渲染端就绪。
     *
     * 渲染端首次启动要两三秒（冷启动更久，实测 2.5~7s），而用户按下截图后往往
     * 马上就去点任务栏、开别的程序。如果等就绪再截，这些窗口就会被一起拍进"快照"，
     * 而快照必须是一开始那一刻的屏幕 —— 之后打开的所有东西都只应该被它盖在下面。
     *
     * 截图不依赖渲染端，所以这里只发起、不等待：真正的等待和建窗口一起做。
     *
     * **所有屏幕必须在这一刻一起开抓**，不能等活动屏抓完再去抓其它屏。
     * macOS 的"屏幕录制"指示器（菜单栏右上角那个紫色圆点）在采集开始后约
     * 200~300ms 才由 WindowServer 合成进画面，亮起后会持续两三秒 —— 这期间抓到的
     * 画面会把圆点一起拍进去，而且是**写进像素**的，之后无论怎么合成都去不掉。
     * 串行抓的话从第二块屏开始必然带点；同时开抓才能让每块屏都拿到不带点的那一帧。
     * （微信的截图里没有这个点，就是因为它一轮只抓一次、都挤在同一个"冷"窗口里。）
     */
    const pendingShots = this.grabAllDisplays(display);
    const shotPromise = pendingShots.get(display.id) as Promise<Shot>;
    // 这里只是先挂一个处理者：截图失败时下面等渲染端的这段时间不会变成
    // unhandledRejection；错误本身仍由 Promise.all 抛给调用方
    shotPromise.catch(() => {});

    /**
     * 顺序是这一轮的关键，**先建窗口 → 再等底图 → 立刻显示 → 最后等渲染端**。
     *
     * 不能"等渲染端就绪再建窗口"：宿主在截图前已经把主窗口 `hide()` 掉了，这段时间
     * 应用里一个可见窗口都没有，BrowserView 的渲染进程拿不到合成器的帧槽，导航就一直
     * 挂在 pending 上 —— `kickStalledNavigation` 能重发，但发多少次都不会提交，只能等
     * 12s 超时、再重载、再 12s 失败一次。实测冷启动后第一次截图必然中招。
     *
     * 窗口一旦可见，导航立刻就能提交。所以窗口要尽早建、尽早显示（整层隐身，用户看不见），
     * 把"等渲染端"这一步挪到显示之后。
     */
    try {
      const $early = this.ensureWindow(display);
      mark('ensureWindow');

      const shot = await shotPromise;
      mark('capture');

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
       * 先以**整层隐身**显示，等渲染端把这一帧画完再亮出来。
       *
       * 不能"等画完再 show"：隐藏窗口里 rAF 不跑、解码也慢得离谱（实测首次解码要 1 秒以上，
       * 而且经常等不到），主进程只能等到超时，截图窗口反而更晚出现。
       * 也不能"先 show 再等图"：窗口先出现但里面什么都没画完，等图到了再"啪"地换上去。
       * 所以取中间：显示（这样渲染进程才会正常出帧）但看不见内容，
       * 画好了再亮出来，用户看到的第一帧就是完整的截图。
       *
       * 隐身手段是渲染端的 `visibility: hidden`，**不是 `win.setOpacity(0)`**。
       * 早先这里用的是 `setOpacity(0)` → show → 画完再 `setOpacity(1)`，在硬件合成下没问题，
       * 但在软件合成（应用侧一直带着 `--disable-gpu-compositing`）下，透明窗口一旦被
       * 设成 opacity 0，就再也不会重新参与合成 —— 之后 `setOpacity(1)` 也不管用。
       * 用户看到的就是"整块屏永远不出现"：冻结画面在、选区高亮在（那是渲染端画的），
       * 而截图窗口自己的边框、工具栏一片空白。这与 `setBlank()` 里早就记下的
       * "透明窗口对 setOpacity 支持不可靠"是同一件事，这里统一成同一套隐身机制。
       *
       * 亮出来的这一刻是**看不出变化**的：底下那张冻结画面早就是同一张图、同一层压暗，
       * 换上来只是"同一画面换了个更靠前的窗口在画"。
       */
      this.setBlank(true);
      $early.show();
      mark('show');
      // 从这一刻起守住最上层：别的应用随时可能把自己的浮层提到前面
      this.startTopMostGuard();

      /**
       * 其他屏幕的预截**已经在 `grabAllDisplays` 里跟着活动屏一起发出了**，
       * 这里只负责等它们落地、把画面和压暗交给各自的冻结窗口。
       */
      void this.captureOtherDisplays(display, pendingShots);

      // 窗口已经可见，渲染端这才拿得到帧槽；就绪通常是一两百毫秒的事
      await this.waitRendererReady();
      mark('isReady');

      /**
       * reset 要等渲染端回执，只能排在就绪之后。它会顺带把渲染端的 `blank` 清掉
       * （见渲染端 `onReset`），所以紧接着把隐身重新压一次，免得底图没到就先亮出来。
       */
      await this.createWindow(display);
      this.setBlank(true);

      try {
        await this.prepareRenderer(display, shot.png);
      } finally {
        // 渲染端出问题也必须亮出来，否则用户面对的是一个看不见又点不掉的窗口
        if (this.$win && !this.$win.isDestroyed()) {
          this.setBlank(false);
        }
      }
      mark('send capture');

      /**
       * 底图已经亮出来了，从这一刻起 ESC 才允许取消。
       *
       * 全局快捷键放在这里而不是 `show` 之前：窗口先以整层隐身显示的那段时间
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
    } catch (err) {
      // 任何一步失败都要把已经立起来的覆盖层收掉再把错误抛给宿主，
      // 否则宿主停在"窗口藏了、截图没出来"的状态，只能重启
      this.abortStart(err);
      throw err;
    }
  }

  /**
   * 一轮截图开始时，把所有屏幕的抓屏**同时**发出去。
   *
   * 只为了抢那个"冷"窗口，见 `startCapture` 里的说明：指示器要过两三百毫秒才被
   * 合成进画面，所以每块屏的抓屏必须挤在同一瞬间，谁也不能排在别人后面。
   *
   * 返回值按 display.id 索引：活动屏那一条给 `startCapture` 的后续流程用，
   * 其余的在 `captureOtherDisplays` 里消费。失败先在这里接住（不吞错误，只是不让它
   * 变成 unhandledRejection），真正的处理仍在各自的调用点。
   */
  private grabAllDisplays(active: Display): Map<number, Promise<Shot>> {
    const pending = new Map<number, Promise<Shot>>();
    const targets: Display[] = [active];
    for (const item of screen.getAllDisplays()) {
      if (item.id !== active.id) {
        targets.push(toDisplay(item));
      }
    }

    for (const display of targets) {
      const promise = this.capture(display);
      promise.catch(() => {});
      pending.set(display.id, promise);
    }

    this.logger(
      '同时开抓 %d 块屏：%o',
      targets.length,
      targets.map((item) => item.id),
    );
    return pending;
  }

  /**
   * 收下其他屏幕的预截结果。
   *
   * 抓屏本身在 `grabAllDisplays` 里就已经跟着活动屏一起发出了（为了同时开抓），
   * 这里只等它们落地。因为抓得早，轮到这一步时多半已经编码完了 ——
   * 所以画面和压暗是一起交给冻结窗口的，几块屏同时暗下去，不会一块一块地暗。
   *
   * 失败只丢这一块屏的画面（换屏时再补截），不能让整次截图失败。
   */
  private async captureOtherDisplays(
    active: Display,
    pending: Map<number, Promise<Shot>>,
  ): Promise<void> {
    const others = screen
      .getAllDisplays()
      .filter((display) => display.id !== active.id);

    try {
      await Promise.all(
        others.map(async (item) => {
          const display = toDisplay(item);
          try {
            // 抓屏已经同时发出去了，这里只等它落地；没有预发（新插进来的屏）才现场截
            const shot = await (pending.get(display.id) ?? this.capture(display));
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
    this.settlePromise = null;
    this.settleFirst = true;
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

    // 渲染端还没起来就先等着（就绪后自然会带上新语言）；
    // 起不来就别把异常漏成 unhandledRejection —— 构造函数里是浮动调用
    try {
      await this.waitRendererReady();
    } catch (err) {
      this.logger('setLang 跳过：渲染端不可用 %o', err);
      return;
    }

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
   * 建窗口 + 把视图挂上去，**不 show、也不 reset**。
   *
   * 单独抽出来是为了能"先建窗口、后等渲染端"（见 `startCapture`）：BrowserView 的渲染进程
   * 在没有任何可见窗口时拿不到合成器的帧槽，导航会一直挂在 pending 上。窗口必须尽早建出来、
   * 并且尽快显示（整层隐身），导航才有地方提交。
   *
   * 位置和尺寸也在这里落好：窗口还藏着的时候搬家最便宜，用户看不见中间态。
   */
  private ensureWindow(display: Display): BrowserWindow {
    // 复用未销毁的窗口
    if (!this.$win || this.$win.isDestroyed()) {
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

    const $win = this.$win;
    $win.setBrowserView(this.$view);

    // 适定平台
    if (process.platform === 'darwin') {
      $win.setWindowButtonVisibility(false);
    }

    if (process.platform !== 'win32') {
      $win.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true,
      });
    }

    // 还藏着的时候落位置：显示之后再搬，用户会看到窗口跳一下
    $win.blur();
    $win.setBounds(display);
    this.$view.setBounds({
      x: 0,
      y: 0,
      width: display.width,
      height: display.height,
    });
    return $win;
  }

  /**
   * 初始化窗口（渲染端就绪之后调用）：重置截图区域 + 落位置 + 断言置顶。
   */
  private async createWindow(display: Display): Promise<BrowserWindow> {
    const time = performance.now();
    // 重置截图区域（要等渲染端回执，所以只能排在就绪之后）
    await this.reset();

    const $win = this.ensureWindow(display);
    this.assertTopMost($win);
    this.logger(
      'createWindow 耗时 %dms (含 reset)',
      Math.round(performance.now() - time),
    );
    return $win;
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
   * 50ms → 彻底干净。所以这里等 50ms，而且**一轮只等一次**：所有屏幕是同时开抓的，
   * 共享同一个 Promise，等的是同一拍；后面换屏补截时它早就 resolve 了，直接放行。
   *
   * 这段等待和 `createWindow`（`reset` 要等渲染端回执，实测几十到几百毫秒）并行，
   * 所以"从点击到画面锁住"的耗时基本不变。
   *
   * @returns 本次是不是"本轮第一次"（是的话调用方还要接着做画面稳定校正，
   *          见 `grabUntilStable`）——固定等待只能挡住大多数情况，挡不住全部
   */
  private async settleBeforeGrab(): Promise<boolean> {
    // 第一波（grabAllDisplays 同一 tick 里发出的所有抓屏）都算"第一次"：
    // 它们等的是同一个共享 Promise，之后各自做自己的稳定校正
    const first = this.settleFirst;
    if (this.captureSettleMs <= 0) {
      this.settleFirst = false;
      return false;
    }
    if (!this.settlePromise) {
      const startedAt = performance.now();
      this.settlePromise = new Promise<void>((resolve) => {
        setTimeout(resolve, this.captureSettleMs);
      }).then(() => {
        this.logger(
          '抓屏前等待 %dms（给宿主 hide 留合成时间，实际 %dms）',
          this.captureSettleMs,
          Math.round(performance.now() - startedAt),
        );
      });
    }
    await this.settlePromise;
    this.settleFirst = false;
    return first;
  }

  /**
   * 抓屏校正：一直抓到画面不再变化为止（最多 `GRAB_MAX_ROUNDS` 张）。
   *
   * 为什么光靠 `captureSettleMs` 不够：那是一个固定值，而"宿主窗口从 hide 到
   * 真的从合成里消失"跟窗口内容、GPU、DWM 状态都有关。实测同一台 Windows 上，
   * 同样是 `hide()` 之后一两百毫秒抓，简单窗口已经干净，宿主主窗口（真实页面、
   * 有 preload、带标题栏）却会抓到"窗口框还在、内容已经清空"的半截画面 ——
   * 压进底图就是用户看到的残影，而且它会被 hover 高亮原样放大，特别扎眼。
   *
   * 校正的判据不是时间而是**画面本身**：隔 `GRAB_STABLE_GAP_MS` 再抓一张，
   * 两张采样后差异小于 `GRAB_DIFF_RATIO` 就认为屏幕已经定格，用这一张；
   * 否则继续（最多 3 张）。屏幕真的一直在动（视频）时也只多抓两张，
   * 不会无限等下去。
   *
   * 代价基本被 `createWindow` 吃掉了：这一抓和建窗口是并行的，而建窗口
   * （`reset` 等渲染回执）本身就要 100~500ms。
   */
  private async grabUntilStable(
    monitor: { captureImage: () => Promise<ShotImage> },
    first: ShotImage,
  ): Promise<ShotImage> {
    let current = first;

    for (let round = 1; round < GRAB_MAX_ROUNDS; round++) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, GRAB_STABLE_GAP_MS);
      });

      let next: ShotImage;
      try {
        next = await monitor.captureImage();
      } catch (err) {
        // 校正拍失败就用手里的：这一拍只是"更保险"，不该把整次截图拖挂
        this.logger('抓屏校正失败，沿用上一帧 %o', err);
        return current;
      }

      const changed = imageDiffRatio(current, next);
      current = next;
      this.logger(
        '抓屏校正 round=%d 变化 %s%%（阈值 %s%%）',
        round,
        (changed * 100).toFixed(2),
        (GRAB_DIFF_RATIO * 100).toFixed(2),
      );

      if (changed < GRAB_DIFF_RATIO) {
        break;
      }
    }

    return current;
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

    const settled = await this.settleBeforeGrab();

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

      let image = await monitor.captureImage();
      // 只有"本轮第一次"才做稳定校正：后面那些（其他屏预截、换屏补截）抓的时候
      // 宿主窗口早就没了，多抓只是白花时间
      if (settled) {
        image = await this.grabUntilStable(monitor, image);
      }
      const imageCost = Math.round(performance.now() - time);
      time = performance.now();
      // 像素到手，屏幕内容已经定格：这时候压暗遮罩不会再影响这张图
      grab();

      const rawPng = await image.toPng(true);
      const pngCost = Math.round(performance.now() - time);

      /**
       * 把 macOS 的「屏幕录制」指示器从像素里擦掉（见 `stripIndicator`）。
       *
       * 时序上已经尽量避开了（一轮里所有屏幕同时开抓），但指示器亮起后会持续两三秒，
       * 上一轮刚结束就再截一次时起点就是热的 —— 那一次只能靠这一步收尾。
       * 找不到圆点时原样返回，只付一次 PNG 解码的代价。
       */
      const stripStart = performance.now();
      let buffer = rawPng;
      if (process.platform === 'darwin' && hasIndicatorCandidate(image, display.scaleFactor)) {
        buffer = stripRecordingIndicator(rawPng, display.scaleFactor);
      }
      const stripCost = Math.round(performance.now() - stripStart);

      this.logger(
        'SCREENSHOTS:capture 耗时 load %dms fromPoint %dms captureImage %dms toPng %dms strip %dms png %dKB%s',
        loadCost,
        fromPointCost,
        imageCost,
        pngCost,
        stripCost,
        Math.round(buffer.length / 1024),
        buffer === rawPng ? '' : '（已擦除指示器）',
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
    const first = await withTimeout(
      desktopCapturer.getSources({ types: ['screen'], thumbnailSize }),
      DESKTOP_CAPTURER_TIMEOUT,
      'desktopCapturer.getSources（兜底抓屏）',
    );
    // 等一拍再取第二次：新建采集流要一点时间才会产出"当下"的帧，
    // 立刻重取大概率还是同一帧（等于没换）
    await new Promise<void>((resolve) => {
      setTimeout(resolve, FALLBACK_SECOND_GRAB_DELAY);
    });
    try {
      const second = await withTimeout(
        desktopCapturer.getSources({ types: ['screen'], thumbnailSize }),
        DESKTOP_CAPTURER_TIMEOUT,
        'desktopCapturer.getSources（兜底抓屏第二次）',
      );
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

/**
 * 两张截图之间"变了多少"（0~1，按采样点统计）。
 *
 * 采样而不是逐像素：1080p 是 200 万像素、5K 是 1400 万，逐像素比一遍纯属浪费；
 * 窗口消失这种整块变化在 1/61 的采样下依然能被稳定检出，而光标闪烁、
 * 进度条这类小改动不会被误判成"画面还在变"。
 *
 * 拿不到像素（窗口已关闭、原生层不给）时按"没变化"处理：校正只是保险，
 * 不能因为它把整次截图弄挂。
 */
function imageDiffRatio(a: ShotImage, b: ShotImage): number {
  if (a.width !== b.width || a.height !== b.height) {
    return 1;
  }

  let pa: Uint8Array;
  let pb: Uint8Array;
  try {
    const ra = a.toRawSync();
    const rb = b.toRawSync();
    pa = new Uint8Array(ra.buffer, ra.byteOffset, ra.byteLength);
    pb = new Uint8Array(rb.buffer, rb.byteOffset, rb.byteLength);
  } catch {
    return 0;
  }

  const pixels = Math.min(pa.length, pb.length) >> 2;
  let sampled = 0;
  let changed = 0;
  for (let i = 0; i < pixels; i += GRAB_DIFF_SAMPLE_STEP) {
    const o = i << 2;
    // 单通道差 6 以内算同一像素：压暗/抗锯齿造成的 ±1~2 抖动不该被算成变化
    if (
      Math.abs((pa[o] ?? 0) - (pb[o] ?? 0)) > 6 ||
      Math.abs((pa[o + 1] ?? 0) - (pb[o + 1] ?? 0)) > 6 ||
      Math.abs((pa[o + 2] ?? 0) - (pb[o + 2] ?? 0)) > 6
    ) {
      changed++;
    }
    sampled++;
  }

  return sampled ? changed / sampled : 0;
}

/**
 * 给一个"可能永远不返回"的原生调用套上超时。
 *
 * 兜底抓屏走的是 `desktopCapturer.getSources`，它在 Windows 上偶发不返回
 * （采集流建不起来时既不 resolve 也不 reject）。这条路径是"主方案已经不可用"
 * 之后的最后一根稻草，如果它再挂住，`startCapture` 就彻底没救了 ——
 * 宿主会停在"主窗口藏了、截图窗没出来"，用户只能重启应用。
 *
 * 超时按失败处理：抛出去 → `startCapture` 回滚覆盖层 → 宿主 `catch` 把窗口还回来。
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${what} 超时（${ms}ms 未返回）`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
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
