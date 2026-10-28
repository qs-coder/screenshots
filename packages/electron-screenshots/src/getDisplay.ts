import { type Rectangle, screen } from 'electron';

export interface Display extends Rectangle {
  id: number;
  scaleFactor: number;
}

/**
 * Electron 的 `Display` 换算成本库用的矩形。
 *
 * 单独抽出来是因为除了"光标所在屏幕"，预截其他屏幕时也要用同一套取整规则 ——
 * 窗口 bounds 和视图 bounds 必须严格相等，两边各取整一次就会出现 1px 的错位。
 */
export function toDisplay(display: {
  id: number;
  bounds: Rectangle;
  scaleFactor: number;
}): Display {
  const { id, bounds, scaleFactor } = display;

  // https://github.com/nashaofu/screenshots/issues/98
  return {
    id,
    x: Math.floor(bounds.x),
    y: Math.floor(bounds.y),
    width: Math.floor(bounds.width),
    height: Math.floor(bounds.height),
    scaleFactor,
  };
}

export default (): Display => {
  const point = screen.getCursorScreenPoint();

  return toDisplay(screen.getDisplayNearestPoint(point));
};
