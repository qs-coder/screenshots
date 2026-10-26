import { Worker } from 'node:worker_threads';
import type { Bounds } from './preload.js';

/** 截图像素，物理分辨率 */
export interface Pixels {
  buf: ArrayBuffer;
  width: number;
  height: number;
  /** 物理像素 / DIP */
  scale: number;
}

/** 检测区域，DIP、屏幕坐标 */
export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 慢机器上的兜底：元素识别是锦上添花，不值得一直等 */
const TIMEOUT = 8000;
/** 邻域精修只有几十毫秒的量级，等久了说明这台机器不行，直接放弃这次精修 */
const REGION_TIMEOUT = 1500;

export interface EdgeThresholds {
  low?: number;
  high?: number;
}

export interface EdgeJobOptions {
  thresholds?: EdgeThresholds | undefined;
  /** 只检这块邻域（按原生分辨率），不给就是整屏检测 */
  region?: Region | undefined;
  /**
   * 精修用的粗矩形（整屏那遍的结果）。给了就把邻域的原生边吸附到它的四条边上，
   * 返回列表第一条永远是它（可能已被贴准），后面才是邻域里的其他候选。
   */
  refine?: Region | undefined;
  /** 额外回传原生分辨率真值边框，只用于 `DEBUG=edge_det` 的调试图 */
  debug?: boolean | undefined;
}

export interface EdgesResult {
  bounds: Bounds[];
  /** 仅 `debug`：物理像素坐标，未圆整、未去重 */
  rawBorders?: { x: number; y: number; w: number; h: number }[] | undefined;
}

/**
 * 在 worker 线程里做元素级边缘检测。
 *
 * 契约和 getWindows 一样：任何失败都返回空数组，绝不让截图主流程抛错。
 */
export default function getEdges(
  pixels: Pixels,
  display: { width: number; height: number },
  logger: (message: string, ...args: unknown[]) => void,
  options: EdgeJobOptions = {},
): Promise<EdgesResult> {
  return run(pixels, display, logger, options, TIMEOUT);
}

/**
 * 光标邻域的**原生分辨率**检测：整屏那条为压耗时降了采样，矩形边天然偏 1~3 DIP，
 * 拾取要的是贴得准，所以按光标周围一小块原分辨率重检一次。
 *
 * `refine` 给整屏那遍的粗矩形时，结果会按它做边吸附 —— 邻域只负责贴边，不负责找元素。
 */
export function getPreciseEdges(
  pixels: Pixels,
  display: { width: number; height: number },
  logger: (message: string, ...args: unknown[]) => void,
  region: Region,
  thresholds?: EdgeThresholds,
  refine?: Region,
): Promise<EdgesResult> {
  return run(
    pixels,
    display,
    logger,
    { region, refine, thresholds },
    REGION_TIMEOUT,
  );
}

function run(
  pixels: Pixels,
  display: { width: number; height: number },
  logger: (message: string, ...args: unknown[]) => void,
  options: EdgeJobOptions,
  timeout: number,
): Promise<EdgesResult> {
  const empty: EdgesResult = { bounds: [] };

  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(require.resolve('./edgeWorker.js'));
    } catch (err) {
      logger('元素检测 worker 启动失败 %o', err);
      resolve(empty);
      return;
    }

    let settled = false;
    const done = (result: EdgesResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    };

    const timer = setTimeout(() => {
      logger('元素检测超时 %dms，跳过', timeout);
      done(empty);
    }, timeout);

    worker.once(
      'message',
      (result: {
        bounds?: Bounds[];
        rawBorders?: EdgesResult['rawBorders'];
        error?: string | null;
      }) => {
        if (result?.error) {
          logger('元素检测失败 %s', result.error);
        }
        done({
          bounds: Array.isArray(result?.bounds) ? result.bounds : [],
          rawBorders: Array.isArray(result?.rawBorders)
            ? result.rawBorders
            : undefined,
        });
      },
    );
    worker.once('error', (err) => {
      logger('元素检测 worker 异常 %o', err);
      done(empty);
    });

    // 不用 transfer 列表：pixels.buf 在主进程要被复用（换屏、每次邻域精修、调试图），
    // 一旦 transfer 过去本地就 detached 成空缓冲。structured clone 拷 22MB 是毫秒级，
    // 相比 WASM 检测本身可以忽略。
    worker.postMessage({
      buf: pixels.buf,
      width: pixels.width,
      height: pixels.height,
      scale: pixels.scale,
      displayWidth: display.width,
      displayHeight: display.height,
      lowThreshold: options.thresholds?.low,
      highThreshold: options.thresholds?.high,
      region: options.region,
      refine: options.refine,
      debug: options.debug,
    });
  });
}
