import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { systemPreferences } from 'electron';

/**
 * 屏幕录制权限在 macOS 上是**按应用**授予的，而"应用"是谁由 TCC 的
 * responsible process（责任进程）决定 —— 不是你想当然的那个进程。
 *
 * 从终端 `npm run start` 起的 Electron，父进程链是
 * `iTerm2 → login → zsh → npm → Electron`，TCC 一路往上找到第一个 .app 包，
 * 于是权限记在 **iTerm2** 名下。用户去系统设置里勾 "Electron" 是没用的：
 * 列表里可能压根没有它，勾了也不会让 `getMediaAccessStatus('screen')` 变 granted。
 *
 * 这里就是把那个"真正要被授权的应用"算出来，好在提示里直接说清楚该勾谁。
 */
export interface ResponsibleApp {
  /** 系统设置列表里显示的名字，取 .app 包名 */
  name: string;
  /** .app 的绝对路径，用户可以用 ⌘⇧G 直接跳过去 */
  bundlePath: string;
  /** 这个包对应的进程 */
  pid: number;
}

interface ProcInfo {
  ppid: number;
  command: string;
}

/** 读一次 `ps`。读不到就返回 null，调用方一律 fail-open，不影响截图主流程 */
function readProcess(pid: number): ProcInfo | null {
  try {
    const out = execFileSync(
      '/bin/ps',
      ['-o', 'ppid=', '-o', 'command=', '-p', String(pid)],
      { encoding: 'utf8', timeout: 1000 },
    ).trim();
    // 形如 "  1234 /Applications/iTerm.app/Contents/MacOS/iTerm2 --login"
    const matched = /^(\d+)\s+([\s\S]+)$/.exec(out);
    if (!matched) {
      return null;
    }
    return { ppid: Number(matched[1]), command: matched[2] ?? '' };
  } catch {
    return null;
  }
}

/**
 * 从命令行里取出 .app 包路径。
 *
 * 取**第一个** `.app`：IDE 的集成终端跑在
 * `Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/...` 里，
 * TCC 认的是最外层那个主包，取最后一个会得到嵌套 helper，系统设置里根本没有这一项。
 */
function appBundleOf(command: string): string | null {
  const end = command.indexOf('.app/');
  if (end < 0) {
    return null;
  }
  return command.slice(0, end + '.app'.length);
}

let cached: ResponsibleApp | null | undefined;

/**
 * 沿父进程链往上找第一个 .app 包 —— 那就是系统设置里要勾的那个应用。
 *
 * 结果缓存：一次截图只会问一次，而且父进程链在一轮截图里不会变。
 */
export function resolveResponsibleApp(): ResponsibleApp | null {
  if (cached !== undefined) {
    return cached;
  }

  let pid = process.pid;
  for (let depth = 0; depth < 12; depth++) {
    const info = readProcess(pid);
    if (!info) {
      break;
    }
    const bundlePath = appBundleOf(info.command);
    if (bundlePath) {
      cached = {
        name: path.basename(bundlePath, '.app'),
        bundlePath,
        pid,
      };
      return cached;
    }
    if (info.ppid <= 1) {
      break;
    }
    pid = info.ppid;
  }

  cached = null;
  return cached;
}

/** 读 .app 的 CFBundleIdentifier，`tccutil reset` 要用它 */
export function bundleIdOf(bundlePath: string): string | null {
  try {
    const out = execFileSync(
      '/usr/libexec/PlistBuddy',
      [
        '-c',
        'Print :CFBundleIdentifier',
        path.join(bundlePath, 'Contents/Info.plist'),
      ],
      { encoding: 'utf8', timeout: 1000 },
    ).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * 权限状态。macOS 上 Electron 对 `screen` 只会返回 granted / denied ——
 * 没有 `not-determined`：`denied` 的含义是"现在没授权"，**不代表**用户拒绝过。
 */
export function getScreenAccess(): string {
  return systemPreferences.getMediaAccessStatus('screen');
}
