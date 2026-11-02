import { createRequire } from 'node:module';
import process from 'node:process';
import type { Image, Monitor, Window } from 'node-screenshots';

/**
 * 在 **asar 打包环境**里可靠地加载 `node-screenshots`。
 *
 * 背景（生产环境实测，2026-11-02 量子密信 1.0.1）：
 * `import('node-screenshots')` 在 `app.asar` 里会走 Node 的 **ESM resolver**。
 * 它的 `packageResolve` 会按 `node_modules` 逐级向上 stat —— 这些 stat 被
 * Electron 的 asar 钩子拦下后，拼出来的路径是
 * `.../app.asar/node_modules/@qs-coder/electron-screenshots/lib/node_modules/node-screenshots`
 * （`lib/node_modules` 根本不存在），而 **`app.asar` 本身是一个文件**，
 * 对它 stat 出来的不是目录 → `ENOTDIR`，原生模块永远加载失败。
 *
 * 后果（就是"截图有虚影 + 窗口识别失效"这一单）：
 * - 抓屏退到 `desktopCapturer.getSources` 兜底。它是"新建采集流取第一帧"，
 *   第一帧可能是 WindowServer 里**更早**的那一帧 —— 宿主刚 `hide()` 的窗口
 *   还留在里面，于是底图上出现一层半透明、位置/尺寸都不对的残影；
 * - `Window.all()` 整个变空列表 —— 窗口识别与锁边完全失效（没有任何高亮框），
 *   而截图像素本身是好的，所以"截图能用"推不出"模块加载成功"。
 *
 * CJS resolver（`require`）没有这条逐级 stat：它拼出的路径是
 * `.../app.asar/node_modules/node-screenshots`，这个目录在 asar 里真实存在，
 * 加载成功；`.node` 原生二进制由 Electron 的 `process.dlopen` 处理
 * （asar 内的 `.node` 会被解到临时目录再 dlopen，不需要 asarUnpack）。
 *
 * 所以加载顺序是：
 * 1. Electron 主进程的 **固有 `require`** —— asar 感知、能加载原生模块，首选；
 * 2. 拿不到时用 `createRequire(process.execPath)` 兜一次 —— 跟主进程同一 fs 空间，
 *    asar 补丁同样生效（某些严格产物里模块作用域的 `require` 会被打掉），
 *    非 Electron 环境（单测、脚本）也走这条；
 * 3. 两条都失败就记下原因，**不抛在模块加载期** —— 调用方照常降级。
 *
 * 这里刻意是**同步**的：`require` 本来就是同步 API，早先的版本为了留一条
 * `await import()` 的兜底才把整个加载器做成 async，而那条路在 asar 里必然
 * ENOTDIR（只在非 Electron 环境有意义，而那种环境 `createRequire` 一样能过），
 * 于是三个调用点都白等一个 microtask，缓存还得多存一层 rejected promise。
 * 现在解析只发生一次（成功/失败都记住），调用方直接拿到模块或 null。
 *
 * 失败**不抛在模块加载期**是硬要求：顶层静态 `import 'node-screenshots'`
 * 会在宿主 `require('@qs-coder/electron-screenshots')` 的那一刻把整个插件带崩，
 * 下面的降级路径（`fallbackSources` 的 desktopCapturer、`getWindows` 的空列表、
 * `getNodeScreenshotsLoadError()` 的诊断日志）全都建立在"加载失败可捕获"之上。
 */

export interface NodeScreenshotsModule {
  Monitor: typeof Monitor;
  Window: typeof Window;
  Image: typeof Image;
}

/** 主进程里 `require` 是模块作用域变量；非 CJS 产物里可能不存在，所以按可选处理 */
declare const require: undefined | ((id: string) => unknown);

let cached: NodeScreenshotsModule | null = null;

/** 上一次加载失败的原因，供调用方写进日志（加载器本身不打日志） */
let loadError: Error | null = null;

/** 是否已经解析过（成功和失败都算），保证只跑一次 */
let resolved = false;

/** 导出齐不齐。`Monitor`/`Window` 是我们唯一依赖的两个入口 */
function usable(mod: unknown): mod is NodeScreenshotsModule {
  const m = mod as Partial<NodeScreenshotsModule> | null | undefined;
  return Boolean(m?.Monitor && m?.Window);
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    // ENOTDIR / ERR_MODULE_NOT_FOUND 这类错误码比 message 更好认
    const code = (err as NodeJS.ErrnoException).code;
    return code ? `${code}: ${err.message}` : err.message;
  }
  return String(err);
}

/** 试一条通道：成功就把模块记进 `cached` 返回 true，失败把原因记进 `problems` */
function attempt(
  load: () => unknown,
  label: string,
  problems: string[],
): boolean {
  try {
    const mod = load();
    if (usable(mod)) {
      cached = mod;
      return true;
    }
    problems.push(`${label}: 加载成功但导出为空`);
  } catch (err) {
    problems.push(`${label}: ${describe(err)}`);
  }
  return false;
}

/** 只解析一次；成功填 `cached`，失败填 `loadError` */
function resolve(): void {
  if (resolved) {
    return;
  }
  resolved = true;

  const problems: string[] = [];

  // 1. 模块作用域的 `require`：CJS resolver、模块相对路径、asar 感知 —— 首选。
  //    这里**不按 `process.type` 设卡**：真正的调用点（抓屏、窗口枚举）都在主进程，
  //    而其他进程里这一步要么正常工作、要么抛错后落到下一条，设卡只会让
  //    非 Electron 环境（单测、脚本）反而拿不到模块。
  if (
    typeof require === 'function' &&
    attempt(() => require('node-screenshots'), 'require', problems)
  ) {
    return;
  }

  // 2. 某些严格产物里模块作用域的 `require` 会被打掉，用 execPath 现建一个 ——
  //    跟主进程同一 fs 空间，asar 补丁同样生效。
  if (
    attempt(
      () => createRequire(process.execPath)('node-screenshots'),
      'createRequire(execPath)',
      problems,
    )
  ) {
    return;
  }

  loadError = new Error(`node-screenshots 加载失败（${problems.join('；')}）`);
}

/**
 * 提前把原生模块加载好，**不关心结果**。
 *
 * 给"启动时就先依赖"的场合用（`Screenshots` 构造时调一次）：首次 `require`
 * 的几毫秒挪到宿主启动阶段，第一次截图不必再等；加载失败也只是把原因记下来，
 * 后面所有调用方照常走降级路径，不会把插件带崩。
 */
export function warmUpNodeScreenshots(): void {
  resolve();
}

/**
 * 拿到 `node-screenshots` 模块，拿不到返回 `null`。
 *
 * 进程级单例：解析只发生一次，成功和失败都记住 —— 失败之后所有调用方
 * 立刻拿到 null 走兜底，不会每轮截图重复报三四条 ENOTDIR。
 */
export function getNodeScreenshots(): NodeScreenshotsModule | null {
  resolve();
  return cached;
}

/**
 * 拿到模块，拿不到就抛。
 *
 * 给本来就在 `try/catch` 里的调用点用（抓屏、窗口枚举），让异常沿原有的
 * 降级路径走，省掉每处都写一遍 null 判断。抛出的 Error 聚合了两条通道的
 * 失败原因，写进日志就能分清是 asar 解析问题还是依赖没装。
 */
export function requireNodeScreenshots(): NodeScreenshotsModule {
  const mod = getNodeScreenshots();
  if (!mod) {
    throw loadError ?? new Error('node-screenshots 加载失败（原因未知）');
  }
  return mod;
}

/** 加载失败原因；加载成功时为 null */
export function getNodeScreenshotsLoadError(): Error | null {
  resolve();
  return loadError;
}

/**
 * 丢掉缓存，下一次调用重新解析。
 *
 * 只给测试和 `tsc --watch` 热更用：正常运行时模块要么一开始就在，要么永远不在，
 * 重试除了多刷几行日志没有任何意义。
 */
export function resetNodeScreenshotsCache(): void {
  cached = null;
  loadError = null;
  resolved = false;
}
