import process from 'node:process';
import { screen } from 'electron';
import type { Monitor } from 'node-screenshots';
import type { Display } from './getDisplay.js';
import { getNodeScreenshots } from './loadNodeScreenshots.js';

/**
 * 拿到 `display` 对应的 node-screenshots 显示器对象。
 *
 * 它的 `x/y/width/height` 和 `Window.all()` 处在同一套坐标空间，
 * 而 Electron 的 `Display` 是 DIP —— 两者在 Windows 缩放显示下并不相等，
 * 混着用会让窗口矩形整体偏移。需要做坐标换算的地方统一走这里拿原点和缩放比。
 *
 * 按**中心点**匹配而不是按左上角：Windows 上多屏的原点是物理像素、
 * Electron 报的是 DIP，缩放比不是 1 时左上角根本对不上，只有中心点两套空间都落在同一块屏里。
 *
 * 加载走 `getNodeScreenshots()`（CJS require 优先、同步、进程级单例）—— asar 打包后
 * `import('node-screenshots')` 会 ENOTDIR，见那个文件的说明。拿不到模块返回 null，
 * 调用方退回用 `display` 自己的坐标，不抛错。
 */
export default function getMonitor(display: Display): Monitor | null {
  const mod = getNodeScreenshots();
  if (!mod) {
    return null;
  }
  const { Monitor } = mod;

  let point = {
    x: display.x + display.width / 2,
    y: display.y + display.height / 2,
  };
  if (process.platform === 'win32') {
    // `Display` 是 DIP，`Monitor.fromPoint` 和 node-screenshots 的其他坐标一样是物理像素，
    // 这里要做的是 DIP → 物理（`dipToScreenPoint`）；用反了在缩放屏 + 多屏混排时
    // 会落到另一块屏上，拿错原点和缩放比，整份窗口列表都跟着错位。
    point = screen.dipToScreenPoint(point);
  }

  return Monitor.fromPoint(point.x, point.y);
}
