import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Bounds } from './preload.js';
import type { Pixels } from './getEdges.js';

/**
 * 元素识别的调试图（只在 `DEBUG=edge_det` 时生成）。
 *
 * 精度问题只有看真屏幕才能判断，而识别结果本身是几十条坐标，读不出"偏在哪"。
 * 这里把三种几何画回截图像素的**副本**（绝不能改写 pixels.buf，worker 还在用同一块内存检测）：
 * - 青色：原生分辨率检测的**真值**边框（不降采样、不圆整、不去重）
 * - 洋红：实际下发给渲染端的矩形（DIP 放大回物理像素）
 * - 黄色：系统窗口枚举的矩形
 * 青色和洋红在同一条边上错开 = 降采样/圆整的误差；黄色框住的地方青色在乱切 = 该以窗口为准。
 *
 * 零依赖：PNG 自己编码（node:zlib），不往发布包里加图片库。
 */

const RAW_COLOR: [number, number, number] = [0, 220, 220];
const BOUNDS_COLOR: [number, number, number] = [255, 0, 255];
const WINDOW_COLOR: [number, number, number] = [255, 220, 0];

export interface EdgesDebugInput {
  pixels: Pixels;
  /** 原生分辨率检测的边框，物理像素坐标 */
  rawBorders: readonly { x: number; y: number; w: number; h: number }[];
  /** 下发给渲染端的矩形，DIP 坐标 */
  bounds: readonly Bounds[];
  /** 系统窗口矩形，DIP 坐标 */
  windows: readonly Bounds[];
}

/** 打开方式与库里的 DEBUG 日志同源：`DEBUG=edge_det npm run start` */
export function isEdgesDebugEnabled(): boolean {
  return /\bedge_det\b/.test(process.env.DEBUG ?? '');
}

/** 写到系统临时目录，文件名带时间戳；成功返回路径 */
export function writeEdgesDebugImage(input: EdgesDebugInput): string {
  const { pixels, rawBorders, bounds, windows } = input;
  const { width, height, scale } = pixels;
  // slice() 在 TypedArray 上是拷贝：worker 还要用原缓冲检测，画框不能污染它
  const data = new Uint8Array(pixels.buf).slice();

  for (const b of rawBorders) {
    strokeRect(data, width, height, rect(b.x, b.y, b.w, b.h, 1), RAW_COLOR);
  }
  for (const r of bounds) {
    strokeRect(
      data,
      width,
      height,
      rect(r.x, r.y, r.width, r.height, scale),
      BOUNDS_COLOR,
    );
  }
  for (const r of windows) {
    strokeRect(
      data,
      width,
      height,
      rect(r.x, r.y, r.width, r.height, scale),
      WINDOW_COLOR,
    );
  }

  const file = `${tmpdir().replace(/\/+$/, '')}/qs-screenshots-edges-${Date.now()}.png`;
  writeFileSync(file, encodePng(data, width, height));
  return file;
}

/** 原点、宽高从 `scale` 套坐标换算到物理像素；width/height 用右下左上之差，避免两次圆整累积误差 */
function rect(
  x: number,
  y: number,
  w: number,
  h: number,
  scale: number,
): Bounds {
  const x0 = Math.round(x * scale);
  const y0 = Math.round(y * scale);
  return {
    x: x0,
    y: y0,
    width: Math.round((x + w) * scale) - x0,
    height: Math.round((y + h) * scale) - y0,
  };
}

/** 四条边各 2 物理像素宽：Retina 2x 下约 1 DIP，够看清青/洋红的错位又不糊住元素 */
function strokeRect(
  data: Uint8Array,
  width: number,
  height: number,
  r: Bounds,
  color: [number, number, number],
): void {
  const left = Math.max(0, r.x);
  const top = Math.max(0, r.y);
  const right = Math.min(width - 1, r.x + r.width - 1);
  const bottom = Math.min(height - 1, r.y + r.height - 1);
  if (right < left || bottom < top) {
    return;
  }
  for (let t = 0; t < 2; t++) {
    for (let x = left; x <= right; x++) {
      set(data, width, x, Math.min(height - 1, top + t), color);
      set(data, width, x, Math.max(0, bottom - t), color);
    }
    for (let y = top; y <= bottom; y++) {
      set(data, width, Math.min(width - 1, left + t), y, color);
      set(data, width, Math.max(0, right - t), y, color);
    }
  }
}

function set(
  data: Uint8Array,
  width: number,
  x: number,
  y: number,
  color: [number, number, number],
): void {
  const i = (y * width + x) * 4;
  if (x < 0 || x >= width || y < 0 || i + 3 >= data.length) {
    return;
  }
  data[i] = color[0];
  data[i + 1] = color[1];
  data[i + 2] = color[2];
  data[i + 3] = 255;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 8bit RGBA、filter 0 的最小 PNG：签名 + IHDR + IDAT + IEND */
export function encodePng(data: Uint8Array, width: number, height: number): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  const src = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1);
    raw[o] = 0; // 每行 filter none
    src.copy(raw, o + 1, y * stride, y * stride + stride);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, body: Buffer): Buffer {
  const out = Buffer.alloc(body.length + 12);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'ascii');
  body.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

let crcTable: Uint32Array | undefined;

function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = buildCrcTable();
  }
  const table = crcTable;
  let c = 0xffffffff;
  for (const b of buf) {
    c = (table[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
}
