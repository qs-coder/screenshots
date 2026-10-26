import { parentPort } from 'node:worker_threads';
import type { Bounds } from './preload.js';

/**
 * 元素级边缘检测的 worker_threads 入口。
 *
 * 必须单独开线程：detectBorders 是同步 WASM，一张 2940x1912 的图要 300~700ms，
 * 放在主进程会把宿主应用的所有窗口和 IPC 一起冻住，放在渲染端又会卡住 hover。
 * 另外截图页面是 file:// 加载的，网页里起 Worker 会被 CORS 挡掉。
 *
 * 两种任务：
 * - 整屏（默认）：为了压耗时要在原生分辨率和降采样之间取舍，矩形只能给"候选集"。
 * - 邻域（带 `region`）：只裁光标周围一小块、**不降采样**，坐标按物理像素算，
 *   这是拾取精度的来源 —— 整屏那条 2x2 均值会把 1px 描边摊开，矩形边天然偏 1~3 DIP。
 */

/** 整屏检测用的最长边上限，超过就降采样，把 WASM 的耗时压到可接受范围 */
const MAX_SIDE = 1920;
/** 比这更小的矩形基本都是图标和抗锯齿碎块（DIP） */
const MIN_EDGE = 16;
/** 两条边都几乎铺满整屏的框是屏幕/窗口自己的边，不是元素 */
const MAX_COVER = 0.95;
/** 下发给渲染端的矩形数量上限 */
const MAX_EDGES = 600;
/** 一条描边会被检出内外两圈，四条边都在这个容差内（DIP）视为同一个矩形 */
const DUP_TOLERANCE = 2;
/** 面积达到外层 85% 以上的内层框视为同一个元素的重复检出 */
const CONTAIN_RATIO = 0.85;
/** 原生分辨率的边落在粗矩形这条边的这个范围内（DIP）才敢替换 */
const REFINE_SNAP = 6;
/**
 * Canny 描边本身有厚度：检出的边框是"描边带的外沿"，比元素的真实边界四周各胖 1 物理像素。
 * 换算时内缩这一像素，Retina 2x 下正好消掉那恒定的 +1 DIP 误差。
 */
const STROKE_INSET = 1;

type Rgba = Uint8Array<ArrayBuffer>;

/** 检测区域，DIP、屏幕坐标 */
interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Job {
  /** RGBA 像素，物理分辨率 */
  buf: ArrayBuffer;
  width: number;
  height: number;
  /** 物理像素 / DIP */
  scale: number;
  displayWidth: number;
  displayHeight: number;
  /** Canny 双阈值，浅色低对比的界面调低、壁纸噪声多调高 */
  lowThreshold?: number;
  highThreshold?: number;
  /** 调试模式：额外跑一遍原生分辨率，边框坐标按物理像素原样回传、不圆整不去重 */
  debug?: boolean;
  /** 只检这块邻域（光标精修）；不给就是整屏检测 */
  region?: Region;
  /**
   * 精修时给出的粗矩形（整屏那一遍的结果，DIP）。
   * 原生分辨率只用来把它的四条边对齐到 1 物理像素，不承担"发现元素"的职责 ——
   * 裁剪区比元素本身小的时候边根本看不见，让邻域自己找元素会找出一堆横向切片。
   */
  refine?: Region;
}

interface Target {
  data: Rgba;
  width: number;
  height: number;
  /** 检测坐标除以它得到物理坐标 */
  factor: number;
  /** 这块像素在整屏物理坐标里的原点，邻域任务换回 DIP 时要减掉 */
  originX?: number;
  originY?: number;
}

interface Border {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Result {
  bounds: Bounds[];
  /** 仅 `debug` 任务：原生分辨率边框，物理像素坐标 */
  rawBorders?: Border[] | undefined;
  error: string | null;
}

// tsc 在 CJS 产物里会把 import() 降级成 require()，而 edge_det 只发 ESM，
// 在不支持 require(ESM) 的 Node 上会直接抛 ERR_REQUIRE_ESM，所以绕一层保住真正的动态导入
const importEdgeDet = new Function('s', 'return import(s)') as (
  s: string,
) => Promise<{
  detectBorders: (
    data: Uint8Array,
    width: number,
    height: number,
    options: {
      lowThreshold: number;
      highThreshold: number;
      minArea: number;
    },
  ) => Border[];
}>;

/** 长边不超过 MAX_SIDE 时原样用，Retina 优先 2x2 均值（1px 描边用最近邻会被采样掉） */
function pickTarget(job: Job): Target {
  const { width, height } = job;
  const src = new Uint8Array(job.buf);
  const longest = Math.max(width, height);

  if (longest <= MAX_SIDE) {
    return { data: src, width, height, factor: 1 };
  }
  if (width % 2 === 0 && height % 2 === 0 && longest / 2 <= MAX_SIDE) {
    return { ...box2x2(src, width, height), factor: 0.5 };
  }
  const factor = MAX_SIDE / longest;
  return { ...nearest(src, width, height, factor), factor };
}

/**
 * 裁出一块邻域并**按原生分辨率**送去检测。
 *
 * 区域按 DIP 矩形乘 scale，四周各扩 `expand` DIP；越界就夹到屏内。因为不降采样，
 * factor 恒为 1，返回的边框是相对这块裁剪像素的坐标，由 `toBounds` 加回 `originX/originY`
 * 再除以 scale 换回整屏 DIP。
 */
function pickRegion(job: Job, region: Region, expand: number): Target {
  const { width, height, scale } = job;
  const src = new Uint8Array(job.buf);
  const x0 = Math.max(0, Math.floor((region.x - expand) * scale));
  const y0 = Math.max(0, Math.floor((region.y - expand) * scale));
  const x1 = Math.min(width, Math.ceil((region.x + region.width + expand) * scale));
  const y1 = Math.min(height, Math.ceil((region.y + region.height + expand) * scale));
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const data = new Uint8Array(w * h * 4);
  const stride = width * 4;

  for (let y = 0; y < h; y++) {
    const from = (y0 + y) * stride + x0 * 4;
    data.set(src.subarray(from, from + w * 4), y * w * 4);
  }

  return { data, width: w, height: h, factor: 1, originX: x0, originY: y0 };
}

function box2x2(
  src: Uint8Array,
  width: number,
  height: number,
): { data: Rgba; width: number; height: number } {
  const w = width / 2;
  const h = height / 2;
  const row = width * 4;
  const data = new Uint8Array(w * h * 4) as Rgba;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = y * 2 * row + x * 8;
      const d = (y * w + x) * 4;
      for (let c = 0; c < 4; c++) {
        data[d + c] =
          ((src[s + c] ?? 0) +
            (src[s + 4 + c] ?? 0) +
            (src[s + row + c] ?? 0) +
            (src[s + row + 4 + c] ?? 0)) /
          4;
      }
    }
  }

  return { data, width: w, height: h };
}

function nearest(
  src: Uint8Array,
  width: number,
  height: number,
  factor: number,
): { data: Rgba; width: number; height: number } {
  const w = Math.max(1, Math.round(width * factor));
  const h = Math.max(1, Math.round(height * factor));
  const data = new Uint8Array(w * h * 4) as Rgba;

  for (let y = 0; y < h; y++) {
    const sy = Math.min(height - 1, Math.floor(y / factor));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(width - 1, Math.floor(x / factor));
      const s = (sy * width + sx) * 4;
      const d = (y * w + x) * 4;
      data[d] = src[s] ?? 0;
      data[d + 1] = src[s + 1] ?? 0;
      data[d + 2] = src[s + 2] ?? 0;
      data[d + 3] = src[s + 3] ?? 0;
    }
  }

  return { data, width: w, height: h };
}

/**
 * 检测结果换算成 DIP 矩形：过滤碎块、裁到屏内、合并内外两圈描边，再去掉重复的内层框。
 *
 * `originX/originY` 是邻域裁剪时跳过的那段物理像素，精修任务要把它们减掉。
 * `minEdge` 对邻域结果放宽（一块 160x120 的小区域里，元素常常本来就不到 16 DIP）。
 */
function toBounds(
  borders: Border[],
  target: Target,
  job: Job,
  minEdge = MIN_EDGE,
  inset = 0,
): Bounds[] {
  const k = 1 / (target.factor * job.scale);
  // detectBorders 给的是**相对这块像素**的坐标：物理绝对 = 原点 + 相对值，再除以 scale 才是 DIP。
  // 先加后除（而不是 (相对 - 原点)/scale），否则邻域结果会整体平移一个裁剪原点。
  const originX = target.originX ?? 0;
  const originY = target.originY ?? 0;
  const { displayWidth, displayHeight } = job;

  const rects: Bounds[] = [];
  for (const b of borders) {
    const x = Math.max(0, Math.round((originX + b.x + inset) * k));
    const y = Math.max(0, Math.round((originY + b.y + inset) * k));
    // 右下先换算再相减，两次圆整不会累积成 1 DIP 的宽高误差
    const width =
      Math.min(displayWidth, Math.round((originX + b.x + b.w - inset) * k)) -
      x;
    const height =
      Math.min(displayHeight, Math.round((originY + b.y + b.h - inset) * k)) -
      y;

    if (width < minEdge || height < minEdge) {
      continue;
    }
    if (
      width >= displayWidth * MAX_COVER &&
      height >= displayHeight * MAX_COVER
    ) {
      continue;
    }
    rects.push({ x, y, width, height });
  }

  // 大的在前：内外两圈描边留下外面那个，内层重复框也在这一步被丢掉
  rects.sort((a, b) => b.width * b.height - a.width * a.height);

  const out: Bounds[] = [];
  for (const r of rects) {
    if (out.length >= MAX_EDGES) {
      break;
    }
    const dup = out.some((o) => isDuplicate(o, r) || isNested(o, r));
    if (!dup) {
      out.push(r);
    }
  }

  return out;
}

/** 内外两圈描边：四条边都落在容差内 */
function isDuplicate(o: Bounds, r: Bounds): boolean {
  return (
    Math.abs(o.x - r.x) <= DUP_TOLERANCE &&
    Math.abs(o.y - r.y) <= DUP_TOLERANCE &&
    Math.abs(o.x + o.width - (r.x + r.width)) <= DUP_TOLERANCE &&
    Math.abs(o.y + o.height - (r.y + r.height)) <= DUP_TOLERANCE
  );
}

/** `r` 被 `o` 基本包住（`o` 先入列表、面积更大），留着只会在 hover 时来回跳 */
function isNested(o: Bounds, r: Bounds): boolean {
  const dx = Math.max(0, Math.min(o.x + o.width, r.x + r.width) - Math.max(o.x, r.x));
  const dy = Math.max(
    0,
    Math.min(o.y + o.height, r.y + r.height) - Math.max(o.y, r.y),
  );
  const area = r.width * r.height;
  return area > 0 && (dx * dy) / area >= CONTAIN_RATIO;
}

/**
 * 用原生分辨率的候选边把粗矩形四条边各吸附一次。
 *
 * 只认"离粗边最近、不超过 `REFINE_SNAP` DIP"的那条原生边，内外两个方向都可以 ——
 * 降采样那遍既可能偏外也可能偏内（Retina 上恒为 +1 DIP 的胖边就是典型的偏外）。
 * 候选必须是"包围住粗矩形中心的那个元素"本身，否则相邻元素的边会把框拽走。
 * 某条边找不到合适的候选就原样保留，所以最坏情况退化成粗矩形，
 * 不会出现"精修完反而没了框"的闪烁。
 */
function snapRefine(coarse: Region, candidates: Bounds[]): Bounds {
  const cx = coarse.x + coarse.width / 2;
  const cy = coarse.y + coarse.height / 2;
  const mine = candidates.filter(
    (r) =>
      cx >= r.x &&
      cx <= r.x + r.width &&
      cy >= r.y &&
      cy <= r.y + r.height,
  );

  /** 取"离 current 最近、在阈值内"的候选边；平票时保留 current，不做无谓的移动 */
  const pull = (current: number, pick: (r: Bounds) => number) => {
    let best = current;
    let bestDistance = REFINE_SNAP + 1;
    for (const r of mine) {
      const v = pick(r);
      const distance = Math.abs(v - current);
      if (distance < bestDistance) {
        best = v;
        bestDistance = distance;
      }
    }
    return best;
  };

  const x = pull(coarse.x, (r) => r.x);
  const y = pull(coarse.y, (r) => r.y);
  const right = pull(coarse.x + coarse.width, (r) => r.x + r.width);
  const bottom = pull(coarse.y + coarse.height, (r) => r.y + r.height);

  return {
    x,
    y,
    width: Math.max(2, right - x),
    height: Math.max(2, bottom - y),
  };
}

parentPort?.on('message', async (job: Job) => {
  const reply = (bounds: Bounds[], error: string | null, rawBorders?: Border[]) => {
    parentPort?.postMessage({ bounds, rawBorders, error } satisfies Result);
  };

  try {
    const { detectBorders } = await importEdgeDet('edge_det');
    const options = {
      lowThreshold: job.lowThreshold ?? 20,
      highThreshold: job.highThreshold ?? 60,
      minArea: 3,
    };

    // 调试真值：整屏原生分辨率再跑一次（只在 DEBUG=edge_det 时；500ms 级别的耗时，不进正常路径）
    const rawBorders = job.debug
      ? detectBorders(
          new Uint8Array(job.buf) as Rgba,
          job.width,
          job.height,
          options,
        )
      : undefined;

    if (job.region) {
      // 邻域：原分辨率检测，边框按描边厚度内缩，再换回整屏 DIP
      const target = pickRegion(job, job.region, 1);
      const borders = detectBorders(
        target.data,
        target.width,
        target.height,
        options,
      );
      const candidates = toBounds(borders, target, job, 6, STROKE_INSET);
      reply(
        job.refine
          ? [snapRefine(job.refine, candidates), ...candidates]
          : candidates,
        null,
        rawBorders,
      );
      return;
    }

    const target = pickTarget(job);
    const borders = detectBorders(
      target.data,
      target.width,
      target.height,
      options,
    );
    // 整屏那一遍：降采样后 1 物理像素的描边厚度已经摊进邻域平均里，不再额外内缩，
    // 贴边的精度交给邻域精修那一次原分辨率检测
    reply(toBounds(borders, target, job), null, rawBorders);
  } catch (err) {
    reply([], err instanceof Error ? err.message : String(err));
  }
});
