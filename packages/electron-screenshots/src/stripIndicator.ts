import { nativeImage } from 'electron';

/**
 * 把 macOS 的「屏幕录制」隐私指示器从截图里擦掉。
 *
 * ## 为什么需要它
 *
 * macOS 只要检测到有进程在采集屏幕，就会在菜单栏右上角画一个紫色小圆点。
 * 它出现后约 200~300ms 才被 WindowServer 合成进画面，**而它一旦进了画面就是像素**，
 * 之后无论怎么合成都去不掉 —— 于是它会原样出现在用户截出来的图里。
 *
 * 抓屏一侧已经把能做的都做了（见 `Screenshots#grabAllDisplays`：一轮里所有屏幕
 * 同时开抓，抢在那个"冷"窗口里）。但指示器亮起后会持续两三秒，**上一次截图刚结束
 * 就再截一次**（取消后立刻重截、连续截几张）时，起点本来就是热的，抓到的帧必然带点。
 * 这一段没法靠时序解决，只能在像素上收尾。
 *
 * ## 为什么可以放心动像素
 *
 * - 指示器是系统画的一小块纯色圆点，颜色和尺寸都固定，位置只在菜单栏那条里；
 * - 判据要求"圆点周围是一片平坦的菜单栏底色"，压在图标/壁纸上的东西不会被误擦；
 * - 抓图 PNG 本身不带 ICC/gAMA/sRGB 块，`nativeImage` 的
 *   `createFromBuffer → toBitmap → createFromBitmap → toPNG` 往返实测**逐像素无损**
 *   （1474 万字节全等），所以不会引入偏色。
 *
 * ## 代价
 *
 * 每张图多一次 PNG 解码（实测 2560×1440 约 40ms、2940×1912 约 60ms）；
 * 只有真的找到圆点才会重新编码，正常情况（没有点）只付解码这一份。
 */

/** 菜单栏高度的上限（pt）。macOS 常规是 24，留足余量给大字号/刘海屏 */
const MAX_MENU_BAR_PT = 40;

/** 圆点核心色（实测 RGB 79,95,235，取整后留余量）；BGRA 三个通道分别判 */
function isIndicatorPixel(b: number, g: number, r: number): boolean {
  return b >= 185 && b - g >= 85 && b - r >= 85 && r <= 150;
}

interface Blob {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  area: number;
}

/** 只要能裁一块出来看像素就行 —— 传 node-screenshots 的 `Image` 进来 */
export interface CropableImage {
  width: number;
  height: number;
  cropSync(
    x: number,
    y: number,
    width: number,
    height: number,
  ): { toRawSync(): Uint8Array };
}

/**
 * 便宜的预检：右上角到底有没有"紫"的东西。
 *
 * 走的是原生像素裁剪（只有顶部那条，几百 KB），不做整图 PNG 解码 ——
 * 实测干净时能把 `stripRecordingIndicator` 的 60~120ms 压到 5ms 左右。
 *
 * 这里**故意放宽**（通道顺序未知，只按 max/mid/min 判），因为它的结论只用来决定
 * "要不要花大价钱做精确判断"：误报只是多花一次解码，真正的取舍在
 * `stripRecordingIndicator` 里。
 */
export function hasIndicatorCandidate(
  image: CropableImage,
  scaleFactor = 1,
): boolean {
  const scale = scaleFactor > 0 ? scaleFactor : 1;
  const stripHeight = Math.min(image.height, Math.ceil(MAX_MENU_BAR_PT * scale));
  if (stripHeight <= 0 || image.width <= 0) {
    return true;
  }

  let raw: Uint8Array;
  try {
    raw = image.cropSync(0, 0, image.width, stripHeight).toRawSync();
  } catch {
    // 裁不出来就当"可能有"，让精确那一步去判断
    return true;
  }

  const width = image.width;
  // 只看右上角那一段：指示器不会出现在别的地方
  const x0 = Math.max(0, width - Math.ceil(150 * scale));
  for (let y = 0; y < stripHeight; y++) {
    for (let x = x0; x < width; x++) {
      const i = (y * width + x) * 4;
      const c0 = raw[i] ?? 0;
      const c1 = raw[i + 1] ?? 0;
      const c2 = raw[i + 2] ?? 0;
      const max = Math.max(c0, c1, c2);
      const min = Math.min(c0, c1, c2);
      const mid = c0 + c1 + c2 - max - min;
      if (max >= 185 && max - mid >= 85 && mid - min <= 50) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 擦掉图里所有"系统指示器"圆点，返回被擦掉的个数。
 *
 * 找不到就原样返回入参，不重新编码。
 */
export function stripRecordingIndicator(png: Buffer, scaleFactor = 1): Buffer {
  const scale = scaleFactor > 0 ? scaleFactor : 1;

  let image: Electron.NativeImage;
  try {
    image = nativeImage.createFromBuffer(png);
  } catch {
    return png;
  }
  const size = image.getSize();
  if (!size.width || !size.height) {
    return png;
  }

  const stripHeight = Math.min(size.height, Math.ceil(MAX_MENU_BAR_PT * scale));
  const bitmap = image.toBitmap();
  if (bitmap.length < size.width * stripHeight * 4) {
    return png;
  }

  const blobs = findBlobs(bitmap, size.width, stripHeight, scale);
  if (!blobs.length) {
    return png;
  }

  for (const blob of blobs) {
    fillBlob(bitmap, size.width, size.height, blob, scale);
  }

  try {
    return nativeImage.createFromBitmap(bitmap, size).toPNG();
  } catch {
    // 编码失败就退回原图：宁可有圆点，也不能把截图弄坏
    return png;
  }
}

/** 在顶部那条里找圆点：饱和蓝紫、尺寸对得上、周围是平坦底色 */
function findBlobs(
  bitmap: Buffer,
  width: number,
  stripHeight: number,
  scale: number,
): Blob[] {
  const mask = new Uint8Array(width * stripHeight);
  const at = (index: number): number => bitmap[index] ?? 0;
  for (let y = 0; y < stripHeight; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (isIndicatorPixel(at(i), at(i + 1), at(i + 2))) {
        mask[y * width + x] = 1;
      }
    }
  }

  const seen = new Uint8Array(mask.length);
  const blobs: Blob[] = [];
  const minSide = Math.max(3, Math.round(3 * scale));
  const maxSide = Math.round(26 * scale);

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) {
      continue;
    }
    const stack = [start];
    seen[start] = 1;
    let area = 0;
    let minX = width;
    let minY = stripHeight;
    let maxX = -1;
    let maxY = -1;

    while (stack.length) {
      const p = stack.pop() as number;
      const px = p % width;
      const py = (p - px) / width;
      area++;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;

      if (px > 0 && mask[p - 1] && !seen[p - 1]) {
        seen[p - 1] = 1;
        stack.push(p - 1);
      }
      if (px < width - 1 && mask[p + 1] && !seen[p + 1]) {
        seen[p + 1] = 1;
        stack.push(p + 1);
      }
      if (py > 0 && mask[p - width] && !seen[p - width]) {
        seen[p - width] = 1;
        stack.push(p - width);
      }
      if (py < stripHeight - 1 && mask[p + width] && !seen[p + width]) {
        seen[p + width] = 1;
        stack.push(p + width);
      }
    }

    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    if (w < minSide || h < minSide || w > maxSide || h > maxSide) {
      continue;
    }
    // 圆点是圆的：长宽比别太离谱，填充率也别太稀疏（防止误伤细长的紫色线条）
    const ratio = w / h;
    if (ratio < 0.55 || ratio > 1.8) {
      continue;
    }
    if (area < w * h * 0.35) {
      continue;
    }
    blobs.push({ minX, minY, maxX, maxY, area });
  }

  return blobs.filter(
    (blob) =>
      // 菜单栏右上角那一段：位置本身就是最强证据（控制中心/电量/时间都在这里，
      // 系统不会往那儿放紫色图标），圆点压在什么底色上都能认
      isNearTopRight(blob, width, scale) ||
      isFlatAround(bitmap, width, stripHeight, blob, scale),
  );
}

/**
 * 是不是落在菜单栏最右那一段。
 *
 * 指示器实测离右边缘 11~40px（1x 屏 11pt、2x 屏 20pt），偶尔会出现在控制中心右侧
 * 约 140pt 处，所以放宽到 150pt。
 */
function isNearTopRight(blob: Blob, width: number, scale: number): boolean {
  return blob.minX >= width - 150 * scale;
}

/**
 * 圆点周围是不是一片平坦底色。
 *
 * 这一条是防误伤的关键：菜单栏里真有可能出现紫色图标（输入法、剪贴板工具的角标），
 * 但图标周围是别的图形，颜色不会平坦；而指示器压在菜单栏那条半透明底色上，
 * 四周几乎是同一个颜色。
 */
function isFlatAround(
  bitmap: Buffer,
  width: number,
  stripHeight: number,
  blob: Blob,
  scale: number,
): boolean {
  const pad = Math.max(2, Math.round(2 * scale));
  const ring = Math.max(2, Math.round(2 * scale));
  const x0 = Math.max(0, blob.minX - pad - ring);
  const x1 = Math.min(width - 1, blob.maxX + pad + ring);
  const y0 = Math.max(0, blob.minY - pad - ring);
  const y1 = Math.min(stripHeight - 1, blob.maxY + pad + ring);

  const samples: number[][] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      // 只取外圈：blob 外扩 pad 之后的那一圈
      const outside =
        x < blob.minX - pad ||
        x > blob.maxX + pad ||
        y < blob.minY - pad ||
        y > blob.maxY + pad;
      if (!outside) {
        continue;
      }
      const i = (y * width + x) * 4;
      samples.push([
        bitmap[i] ?? 0,
        bitmap[i + 1] ?? 0,
        bitmap[i + 2] ?? 0,
      ]);
    }
  }
  if (samples.length < 8) {
    return false;
  }

  for (let channel = 0; channel < 3; channel++) {
    const values = samples
      .map((s) => s[channel] ?? 0)
      .sort((a, b) => a - b);
    const median = values[values.length >> 1] ?? 0;
    const p10 = values[Math.floor(values.length * 0.1)] ?? 0;
    const p90 = values[Math.floor(values.length * 0.9)] ?? 0;
    // 平坦 = 这一圈里 80% 的像素跟中位数差不了多少
    if (median - p10 > 26 || p90 - median > 26) {
      return false;
    }
  }
  return true;
}

/** 用周围底色的中位数把圆点（含抗锯齿边）整块盖掉 */
function fillBlob(
  bitmap: Buffer,
  width: number,
  height: number,
  blob: Blob,
  scale: number,
): void {
  const pad = Math.max(1, Math.round(1.5 * scale));
  const ring = Math.max(3, Math.round(3 * scale));
  const bx0 = Math.max(0, blob.minX - pad);
  const bx1 = Math.min(width - 1, blob.maxX + pad);
  const by0 = Math.max(0, blob.minY - pad);
  const by1 = Math.min(height - 1, blob.maxY + pad);

  const ringSamples: number[][] = [];
  const rx0 = Math.max(0, blob.minX - pad - ring);
  const rx1 = Math.min(width - 1, blob.maxX + pad + ring);
  const ry0 = Math.max(0, blob.minY - pad - ring);
  const ry1 = Math.min(height - 1, blob.maxY + pad + ring);
  for (let y = ry0; y <= ry1; y++) {
    for (let x = rx0; x <= rx1; x++) {
      const outside =
        x < blob.minX - pad ||
        x > blob.maxX + pad ||
        y < blob.minY - pad ||
        y > blob.maxY + pad;
      if (!outside) {
        continue;
      }
      const i = (y * width + x) * 4;
      ringSamples.push([
        bitmap[i] ?? 0,
        bitmap[i + 1] ?? 0,
        bitmap[i + 2] ?? 0,
        bitmap[i + 3] ?? 255,
      ]);
    }
  }
  if (!ringSamples.length) {
    return;
  }

  const median = (channel: number): number => {
    const values = ringSamples
      .map((s) => s[channel] ?? 0)
      .sort((a, b) => a - b);
    return values[values.length >> 1] ?? 0;
  };
  const fill = [median(0), median(1), median(2), median(3)] as const;

  for (let y = by0; y <= by1; y++) {
    for (let x = bx0; x <= bx1; x++) {
      const i = (y * width + x) * 4;
      bitmap[i] = fill[0];
      bitmap[i + 1] = fill[1];
      bitmap[i + 2] = fill[2];
      bitmap[i + 3] = fill[3];
    }
  }
}
