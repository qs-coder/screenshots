import type { Bounds, History } from './types';
import { HistoryItemType } from './types';

interface ComposeImageOpts {
  image: HTMLImageElement;
  width: number;
  height: number;
  history: History;
  bounds: Bounds;
}

export default function composeImage({
  image,
  width,
  height,
  history,
  bounds,
}: ComposeImageOpts): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    const $canvas = document.createElement('canvas');

    const rx = image.naturalWidth / width;
    const ry = image.naturalHeight / height;

    // 导出尺寸以底图自身的像素比例为准，而不是窗口的 devicePixelRatio：
    // 两者不等时（Windows 125%/150%、多屏不同缩放）按 devicePixelRatio 定尺寸会把
    // 原生像素下采样或做亚像素重采样，文字直接发虚。
    const targetWidth = Math.max(1, Math.round(bounds.width * rx));
    const targetHeight = Math.max(1, Math.round(bounds.height * ry));
    $canvas.width = targetWidth;
    $canvas.height = targetHeight;

    const ctx = $canvas.getContext('2d');
    if (!ctx) {
      return reject(new Error('convert image to blob fail'));
    }

    ctx.clearRect(0, 0, targetWidth, targetHeight);
    // 源矩形与目标矩形取同一组整数像素，底图这一次 drawImage 是无重采样的 1:1 拷贝
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      image,
      Math.round(bounds.x * rx),
      Math.round(bounds.y * ry),
      targetWidth,
      targetHeight,
      0,
      0,
      targetWidth,
      targetHeight,
    );

    // 标注（直线/箭头/文字/马赛克）仍以屏幕坐标系绘制，随同一个比例放大到原生像素
    ctx.setTransform(
      targetWidth / bounds.width,
      0,
      0,
      targetHeight / bounds.height,
      0,
      0,
    );

    history.stack.slice(0, history.index + 1).forEach((item) => {
      if (item.type === HistoryItemType.Source) {
        item.draw(ctx, item);
      }
    });

    $canvas.toBlob((blob) => {
      if (!blob) {
        return reject(new Error('canvas toBlob fail'));
      }
      resolve(blob);
    }, 'image/png');
  });
}
