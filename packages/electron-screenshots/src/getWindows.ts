import process from 'node:process';
import type { Display } from './getDisplay.js';
import getMonitor from './getMonitor.js';
import type { Bounds } from './preload.js';

/**
 * 枚举当前屏幕上**可见**的其他应用窗口矩形，供渲染端做窗口识别与锁边。
 *
 * 只保留顶层所见的窗口：z 值从大到小遍历，被更上层窗口整个盖住的直接丢弃，
 * 这样锁边候选和高亮候选都只会是用户真正看得到的那些窗口。
 *
 * 返回的坐标已经换算成渲染端画布用的 DIP，原点是这块屏幕的左上角。
 * node-screenshots 的窗口枚举依赖系统权限（macOS 没有屏幕录制权限时只剩菜单栏），
 * 任何平台都可能给出空列表，所以这里一律以异常/空值收敛成 `[]`，
 * 让渲染端退化成纯手动框选，而不是让截图主流程失败。
 */
export default async function getWindows(
  display: Display,
  logger?: (message: string, ...args: unknown[]) => void,
): Promise<Bounds[]> {
  const visible: Bounds[] = [];

  try {
    const { Window } = await import('node-screenshots');
    const monitor = await getMonitor(display);

    // `Window.all()` 和 `Monitor` 是同一套坐标，Electron 的 `display` 是 DIP；
    // Windows 开显示缩放时两者差一个 scaleFactor（物理像素 / DIP），
    // 所以先在这套原始坐标里减掉本屏原点，再整体换算成画布用的 DIP。
    const originX = monitor?.x() ?? display.x;
    const originY = monitor?.y() ?? display.y;
    const scale =
      monitor && monitor.width() > 0 ? monitor.width() / display.width : 1;
    logger?.(
      '窗口坐标换算原始 monitor %o display %o scale %s',
      monitor && {
        x: monitor.x(),
        y: monitor.y(),
        width: monitor.width(),
        height: monitor.height(),
      },
      {
        x: display.x,
        y: display.y,
        width: display.width,
        height: display.height,
      },
      scale,
    );

    // z 值大的在前，渲染端从上往下找第一个命中的窗口就是视觉上最上面的那个
    const windows = Window.all().sort((a, b) => b.z() - a.z());
    // 排查坐标空间用的原始值，尤其是 Windows 的缩放显示
    const raw: Bounds[] = [];

    for (const win of windows) {
      // 截图窗口和屏蔽窗口都属于本进程，且铺满整块屏幕，
      // 参与识别会让任何位置都命中"全屏窗口"
      if (win.pid() === process.pid || win.isMinimized()) {
        continue;
      }

      // 除以 scale 之后是小数，而渲染端的拾取判定按整数像素比，窗口边框那一圈像素要归窗口自己。
      // 小数会让左/上边缘丢掉不到 1 DIP 的一条带，元素矩形就在这条带上冒出来
      // —— 现象还是"窗口边缘被切碎"。所以统一 floor 左上、ceil 右下：宁可多占半个像素也绝不漏。
      const right = Math.ceil((win.x() + win.width() - originX) / scale);
      const bottom = Math.ceil((win.y() + win.height() - originY) / scale);
      const x = Math.max(0, Math.floor((win.x() - originX) / scale));
      const y = Math.max(0, Math.floor((win.y() - originY) / scale));
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
      // 只跟着**真正下发**的矩形采样，原始值和换算值才是同一个窗口，
      // 否则日志里这两行对不上，坐标空间对不对根本核不出来
      if (raw.length < 2) {
        raw.push({
          x: win.x(),
          y: win.y(),
          width: win.width(),
          height: win.height(),
        });
      }
    }

    logger?.('窗口坐标（前两个）原始 %o 换算后 %o', raw, visible.slice(0, 2));
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
