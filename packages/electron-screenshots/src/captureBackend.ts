import process from 'node:process';
import { app } from 'electron';

/**
 * 抓屏后端选择。
 *
 * 背景（麒麟 V10 SP1 / ARM64 / UKUI Wayland，2026-11-26 现场取证）：
 * `node-screenshots` 底层的 xcap 在 Wayland 上走 libwayshot 0.3.0，它绑定
 * `zxdg_output_manager_v1` 第 3 版时要求协议版本 ≥ 3；UKUI 只提供第 2 版，
 * 且没有后续抓屏需要的 `zwlr_screencopy_manager_v1`。libwayshot 在
 * `lib.rs:133:17` 直接 `panic!`，并发生在不能 unwind 的 extern 回调里
 * （`panic in a function that cannot unwind` → `SIGABRT`）。
 *
 * 这种 abort **不可能在 JS 侧 try/catch，也不可能被 `catch_unwind` 兜住** ——
 * 唯一可靠的办法是在调用任何原生 API 之前就把这条路关掉，让抓屏走
 * Electron 自己的 `desktopCapturer`。所以这里做进程级的后端门禁：
 *
 * - Linux + Wayland（尤其是 UKUI）：默认禁用原生后端；
 * - Linux + X11 / 其他平台：保持原生后端（原有行为）；
 * - 宿主可以用构造选项 `captureBackend` 或环境变量强制指定后端，
 *   例如 wlroots 合成器上确认原生可用时传 `native`。
 *
 * 门禁做在 `loadNodeScreenshots` 的入口，而不是每个调用点：
 * `Monitor.fromPoint` / `captureImage` / `Window.all` 全都是从那里拿模块，
 * 任何一处漏掉都会让整个 Electron 进程 abort，而不是只让这次截图失败。
 */

export type CaptureBackend = 'native' | 'electron';
export type CaptureBackendOption = 'auto' | CaptureBackend;

export interface CaptureBackendDecision {
  backend: CaptureBackend;
  /** 写进日志的原因，降级时能一眼分清是环境不支持还是被强制切换 */
  reason: string;
}

/** 不改代码也能覆盖后端：`ELECTRON_SCREENSHOTS_CAPTURE_BACKEND=native|electron|auto` */
export const CAPTURE_BACKEND_ENV = 'ELECTRON_SCREENSHOTS_CAPTURE_BACKEND';

/** 决策输入抽成纯参数，方便脱离 Electron 环境验证各种会话组合 */
export interface CaptureBackendInput {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Electron 实际走的 ozone 平台（`--ozone-platform` / hint），可能为空 */
  ozonePlatform?: string;
}

let optionOverride: CaptureBackendOption | null = null;
let cached: CaptureBackendDecision | null = null;

function isOption(value: string | undefined): value is CaptureBackendOption {
  return value === 'auto' || value === 'native' || value === 'electron';
}

/**
 * 宿主显式指定后端。进程级生效；重复设置同一值不会清掉缓存。
 *
 * 传 `undefined`（宿主没有传该选项）会清掉之前的显式覆盖，回到环境变量 /
 * 自动判定 —— 否则同一进程里第二个 `new Screenshots()` 不传选项时，会莫名
 * 继承第一个实例指定的后端。
 *
 * 注意：这里允许运行时改，是因为 `loadNodeScreenshots` 每次取模块都会重新
 * 读决策（`getNodeScreenshots` 里的门禁不是只在预热时做一次），所以不存在
 * "先预热成 native、后切 electron 仍然调原生"的窗口。
 */
export function configureCaptureBackend(option?: CaptureBackendOption): void {
  const next = option ?? null;
  if (optionOverride === next) {
    return;
  }
  optionOverride = next;
  cached = null;
}

/** 只给测试用：连同模块加载缓存一起重置 */
export function resetCaptureBackend(): void {
  optionOverride = null;
  cached = null;
}

function desktopNames(env: NodeJS.ProcessEnv): string {
  return [env.XDG_CURRENT_DESKTOP, env.XDG_SESSION_DESKTOP, env.DESKTOP_SESSION]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/**
 * 后端判定逻辑（只依赖传入参数；模块级的显式覆盖由调用方传入后再读）。
 *
 * 判定顺序：
 * 1. 构造选项 > 环境变量 > auto；显式值永远优先；
 * 2. 非 Linux：原生后端（原有行为不变）；
 * 3. Linux 上先看 Electron 的 ozone 平台：显式 `x11` 视为 X11（XWayland 下
 *    X11 抓屏是可用的），显式 `wayland` 视为 Wayland；
 * 4. 没有显式 ozone 时，用 `XDG_SESSION_TYPE` / `WAYLAND_DISPLAY` / 桌面名
 *    判断。UKUI 只要看见 Wayland 环境就禁原生 —— 不赌它到底跑在 XWayland
 *    还是原生 Wayland 上，因为 xcap 可能自己按 `WAYLAND_DISPLAY` 选后端。
 */
export function resolveCaptureBackend(
  input: CaptureBackendInput,
): CaptureBackendDecision {
  const raw =
    optionOverride ?? input.env[CAPTURE_BACKEND_ENV]?.trim().toLowerCase();
  const option = isOption(raw) ? raw : 'auto';

  if (option === 'native') {
    return {
      backend: 'native',
      reason: '构造选项或环境变量强制使用原生后端',
    };
  }
  if (option === 'electron') {
    return {
      backend: 'electron',
      reason: '构造选项或环境变量强制使用 Electron 后端',
    };
  }

  if (input.platform !== 'linux') {
    return {
      backend: 'native',
      reason: `${input.platform} 平台继续使用原生后端`,
    };
  }

  const ozone = (input.ozonePlatform ?? '').trim().toLowerCase();
  const sessionType = (input.env.XDG_SESSION_TYPE ?? '').trim().toLowerCase();
  const waylandDisplay = input.env.WAYLAND_DISPLAY?.trim();
  const display = input.env.DISPLAY?.trim();
  const desktop = desktopNames(input.env);
  const ukui = desktop.includes('ukui');

  // UKUI 不看 ozone：只要暴露了 wayland socket，xcap 就可能自己选 Wayland 后端
  const ukuiWayland = ukui && Boolean(waylandDisplay);
  // 关键：XWayland 上 DISPLAY 存在、Electron 也没被要求走 Wayland 时，xcap 用的是
  // X11 后端，原生抓屏本来就是好的（0.6.2 在这类会话上一直正常）。不能只凭
  // XDG_SESSION_TYPE=wayland 就禁掉，否则正常机器白白丢掉窗口识别。
  // 只有这几种情况才禁：Electron 明确跑 Wayland / UKUI 暴露 wayland socket /
  // 根本没有 X11 DISPLAY 的纯 Wayland 会话。
  const wayland =
    ozone === 'wayland' ||
    ukuiWayland ||
    (!display && (sessionType === 'wayland' || Boolean(waylandDisplay)));

  if (!wayland) {
    return {
      backend: 'native',
      reason: `Linux 会话未识别为 Wayland（ozone=${ozone || '默认'}，session=${sessionType || '未知'}）`,
    };
  }

  if (ukui) {
    return {
      backend: 'electron',
      reason:
        'UKUI Wayland 只提供 zxdg_output_manager_v1 v2（libwayshot 要求 v3）且缺少 zwlr_screencopy，原生抓屏会 panic/abort，已切到 Electron 后端',
    };
  }

  return {
    backend: 'electron',
    reason:
      'Wayland 会话下 node-screenshots/libwayshot 依赖 wlroots 截图协议，通用合成器通常不提供，已切到 Electron 后端（确认原生可用可显式指定 native）',
  };
}

/** Electron 当前 ozone 平台；非 Electron 环境下 `app` 不存在，返回空串 */
function ozonePlatform(): string {
  try {
    const commandLine = app?.commandLine;
    return (
      commandLine?.getSwitchValue?.('ozone-platform') ||
      process.env.ELECTRON_OZONE_PLATFORM_HINT ||
      ''
    );
  } catch {
    return process.env.ELECTRON_OZONE_PLATFORM_HINT || '';
  }
}

/** 当前进程采用的抓屏后端（结果缓存，环境/选项变化前保持不变） */
export function getCaptureBackendDecision(): CaptureBackendDecision {
  if (!cached) {
    cached = resolveCaptureBackend({
      platform: process.platform,
      env: process.env,
      ozonePlatform: ozonePlatform(),
    });
  }
  return cached;
}
