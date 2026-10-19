import process from 'node:process';
import type { Display } from './getDisplay.js';
import type { Bounds } from './preload.js';

/**
 * 枚举当前屏幕上**可见**的其他应用窗口矩形，供渲染端做窗口识别与锁边。
 *
 * 只保留顶层所见的窗口：z 值从大到小遍历，被更上层窗口整个盖住的直接丢弃，
 * 这样锁边候选和高亮候选都只会是用户真正看得到的那些窗口。
 *
 * 返回的坐标已经减掉屏幕原点，和截图 UI 用的是同一套屏幕内坐标系。
 * node-screenshots 的窗口枚举依赖系统权限（macOS 没有屏幕录制权限时只剩菜单栏），
 * 任何平台都可能给出空列表，所以这里一律以异常/空值收敛成 `[]`，
 * 让渲染端退化成纯手动框选，而不是让截图主流程失败。
 */
export default async function getWindows(display: Display): Promise<Bounds[]> {
  const visible: Bounds[] = [];

  try {
    const { Window } = await import('node-screenshots');
    // z 值大的在前，渲染端从上往下找第一个命中的窗口就是视觉上最上面的那个
    const windows = Window.all().sort((a, b) => b.z() - a.z());

    for (const win of windows) {
      // 截图窗口和屏蔽窗口都属于本进程，且铺满整块屏幕，
      // 参与识别会让任何位置都命中"全屏窗口"
      if (win.pid() === process.pid || win.isMinimized()) {
        continue;
      }

      const right = win.x() + win.width() - display.x;
      const bottom = win.y() + win.height() - display.y;
      const x = Math.max(0, win.x() - display.x);
      const y = Math.max(0, win.y() - display.y);
      const width = Math.min(display.width, right) - x;
      const height = Math.min(display.height, bottom) - y;

      // 落在别的屏幕上的窗口、以及宽度或高度为 0 的窗口都没有意义
      if (width < 2 || height < 2) {
        continue;
      }

      const rect: Bounds = { x, y, width, height };
      if (visible.some((top) => isCovered(rect, top))) {
        continue;
      }
      visible.push(rect);
    }
  } catch {
    return [];
  }

  return visible;
}

/** `rect` 是否被 `other` 整个盖住 */
function isCovered(rect: Bounds, other: Bounds): boolean {
  return (
    other.x <= rect.x &&
    other.y <= rect.y &&
    other.x + other.width >= rect.x + rect.width &&
    other.y + other.height >= rect.y + rect.height
  );
}
