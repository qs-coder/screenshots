import process from 'node:process';
import type { Display } from './getDisplay.js';
import getMonitor from './getMonitor.js';
import type { Bounds } from './preload.js';

/**
 * 盖住屏幕这个比例以上的窗口，才可能是**透明覆盖层**（HUD / 灵动岛 / 输入法候选层），
 * 需要按像素甄别一次，见 `transparentRatio`。
 *
 * 这里刻意**不是**一个"超线就丢"的阈值：早期版本用 95% 覆盖率一刀切，把"最大化窗口"
 * 一起砍了 —— macOS 上最大化的窗口是 `0,33,屏宽,屏高-33`（让出菜单栏），覆盖率
 * 1.00×0.97，照样过线；Windows 上最大化让出任务栏，同理。结果是最常见的那个窗口反而
 * 选不到：光标压在上面时命中它**背后**那个窗口，高亮框和眼前看到的东西完全错位 ——
 * 用户看到的就是"窗口边缘识别不精确"。
 */
const OVERLAY_COVER = 0.85;

/**
 * 窗口图像里 alpha 接近 0 的像素占比超过这个数，就认定是透明覆盖层。
 *
 * 实测（macOS）：HUD 类窗口 97% 的像素是透明的，所有真实窗口都是 100% 不透明，
 * 中间没有灰色地带，所以阈值取 0.5 足够宽松。
 */
const TRANSPARENT_RATIO = 0.5;

/**
 * 一次截图最多甄别几个覆盖层候选。
 *
 * 拍一次窗口是同步原生调用，实测 70~530ms（窗口越大越慢），拍三个就能把主进程堵上一秒半。
 * 所以按 z 序从高往低试，并且**一拍到不透明的窗口就停**：覆盖层永远浮在真实窗口之上，
 * 它下面不可能再藏着覆盖层（真藏着也被挡住了）。常见情况只拍一次。
 */
const MAX_OVERLAY_PROBES = 2;

/**
 * 每读一个窗口属性都是一次原生调用（实测约 2ms），几十个窗口就是一两秒。
 * 每处理这么多个窗口让出一次主线程，否则宿主应用会被这段循环冻住 ——
 * 实测让出反而更快（原生层有机会把查询批处理掉），单次卡顿也从整段降到几十毫秒。
 */
const YIELD_EVERY = 4;

/**
 * 比这还小的矩形不算拾取目标。
 *
 * 主要是跨屏窗口在本屏剩下的残片：一块窗口横跨两块屏时，落在本屏的可能只有
 * `0,363 2x33` 这样一条 2 像素宽的边，既选不中也选不准，还会把锁边吸附带偏。
 * 真窗口不会被这个尺寸卡住，而 8 DIP 以下的东西本来也没法用鼠标点。
 */
const MIN_WINDOW_SIZE = 8;

/** 只用到这两件事，避免把 node-screenshots 的类型拖进来 */
interface WindowLike {
  captureImageSync(): ImageLike;
}

interface ImageLike {
  width: number;
  height: number;
  cropSync(x: number, y: number, width: number, height: number): ImageLike;
  toRawSync(): Uint8Array;
}

/** 窗口的原始几何（物理像素、全局坐标），和屏幕无关，可以跨屏复用 */
interface RawWindow {
  pid: number;
  /** z 值，越大越靠上；只用来排序，排完就不再用 */
  z: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 甄别透明覆盖层要用它自己的像素，见 `transparentRatio` */
  win: WindowLike;
  /**
   * 是不是透明覆盖层：`undefined` 还没测过，`null` 测不出来（按"不是"处理）。
   * 这是窗口自身的属性，和屏幕无关，所以跟着缓存走 —— 换屏时不必重拍一遍。
   */
  overlay?: boolean | null;
}

/**
 * 本轮截图枚举到的窗口原始几何。
 *
 * 换屏时会再调一次 `getWindows`，而窗口属性是逐个原生查询的，重新枚举要一秒上下 ——
 * 换屏后那段时间里 hover 完全不响应，用户会以为"窗口识别坏了"。
 * 截图期间桌面被遮罩冻住、窗口几何不会变，所以按截图轮次缓存一次，换屏直接复用。
 */
let cache: RawWindow[] | null = null;

/** 新一轮截图开始，上一轮的几何作废 */
export function resetWindowCache(): void {
  cache = null;
}

const yieldToLoop = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

/**
 * 枚举当前屏幕上**可见**的其他应用窗口矩形，供渲染端做窗口识别与锁边。
 *
 * 只保留顶层所见的窗口：z 值从大到小遍历，被更上层窗口整个盖住的直接丢弃，
 * 这样锁边候选和高亮候选都只会是用户真正看得到的那些窗口。
 * 唯一的例外是透明覆盖层（HUD / 灵动岛 / 输入法候选层）：它们尺寸跟屏幕一样大、
 * 内容却是全透明的，留着会把下面的真实窗口全"盖住"，所以按窗口像素单独甄别后剔除。
 *
 * 返回的坐标已经换算成渲染端画布用的 DIP，原点是这块屏幕的左上角。
 * node-screenshots 的窗口枚举依赖系统权限（macOS 没有屏幕录制权限时只剩菜单栏），
 * 任何平台都可能给出空列表，所以这里一律以异常/空值收敛成 `[]`，
 * 让渲染端退化成纯手动框选，而不是让截图主流程失败。
 *
 * @param reuse 同一轮截图里换屏时传 true：直接复用上一次的枚举结果
 */
export default async function getWindows(
  display: Display,
  logger?: (message: string, ...args: unknown[]) => void,
  reuse = false,
): Promise<Bounds[]> {
  const visible: Bounds[] = [];

  try {
    const monitor = await getMonitor(display);

    // `Window.all()` 和 `Monitor` 是同一套坐标，Electron 的 `display` 是 DIP；
    // Windows 开显示缩放时两者差一个 scaleFactor（物理像素 / DIP），
    // 所以先在这套原始坐标里减掉本屏原点，再整体换算成画布用的 DIP。
    const originX = monitor?.x() ?? display.x;
    const originY = monitor?.y() ?? display.y;
    const scale =
      monitor && monitor.width() > 0 ? monitor.width() / display.width : 1;

    const fromCache = reuse && cache !== null;
    const windows = fromCache
      ? (cache as RawWindow[])
      : await enumerate(logger);
    if (!fromCache) {
      cache = windows;
    }

    logger?.(
      '窗口坐标换算原始 monitor %o display %o scale %s（%s）',
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
      fromCache ? '复用缓存' : '重新枚举',
    );

    // 排查坐标空间用的原始值，尤其是 Windows 的缩放显示
    const raw: Bounds[] = [];
    // 甄别出来的透明覆盖层：普通窗口筛完之后再决定要不要留
    const overlays: Bounds[] = [];
    let probes = 0;
    // 拍到不透明的窗口就说明已经越过覆盖层那几层了，后面的不必再拍（见 MAX_OVERLAY_PROBES）
    let probing = true;

    for (const win of windows) {
      // 除以 scale 之后是小数，而渲染端的拾取判定按整数像素比，窗口边框那一圈像素要归窗口自己。
      // 小数会让左/上边缘丢掉不到 1 DIP 的一条带，元素矩形就在这条带上冒出来
      // —— 现象还是"窗口边缘被切碎"。所以统一 floor 左上、ceil 右下：宁可多占半个像素也绝不漏。
      const right = Math.ceil((win.x + win.width - originX) / scale);
      const bottom = Math.ceil((win.y + win.height - originY) / scale);
      const x = Math.max(0, Math.floor((win.x - originX) / scale));
      const y = Math.max(0, Math.floor((win.y - originY) / scale));
      const width = Math.min(display.width, right) - x;
      const height = Math.min(display.height, bottom) - y;

      // 落在别的屏幕上的窗口、跨屏剩下的窄条、以及宽度或高度为 0 的窗口都没有意义
      if (width < MIN_WINDOW_SIZE || height < MIN_WINDOW_SIZE) {
        continue;
      }

      const rect: Bounds = { x, y, width, height };

      // 本进程自己的窗口只排除**铺满整屏**的那几个（截图窗口 + 各屏的屏蔽窗口）：
      // 它们盖住整块屏幕，留着会让光标在任何位置都命中"全屏窗口"。
      // 但**不能**按 pid 一刀切 —— 宿主应用自己的普通窗口是屏幕上真实可见的东西，
      // 用户很可能就是要截它（拿自己的应用做演示是常见用法）。以前整个进程都被排除，
      // 那个窗口只能靠元素识别，于是被内部的分隔线切成好几块 —— 看起来就是
      // "一个窗口被识别成两个区域"。
      if (
        win.pid === process.pid &&
        width >= display.width - 2 &&
        height >= display.height - 2
      ) {
        continue;
      }

      // 盖住大半屏幕的窗口要甄别一下是不是透明覆盖层：这类窗口 z 值压在真实窗口之上，
      // 留着会让光标在**任何位置**都命中它，真实窗口被 `isCovered` 全部吃掉。
      // 判据是窗口自己的像素（见 `transparentRatio`），不是尺寸、也不是标题 ——
      // 尺寸分不开它和最大化窗口，标题也靠不住（透明覆盖层可以带标题）。
      if (
        width >= display.width * OVERLAY_COVER &&
        height >= display.height * OVERLAY_COVER
      ) {
        if (
          win.overlay === undefined &&
          probing &&
          probes < MAX_OVERLAY_PROBES
        ) {
          probes++;
          // 拍窗口是同步原生调用（几十毫秒到半秒），先让出一轮，别和 hover 抢主线程
          await yieldToLoop();
          const ratio = transparentRatio(win.win, logger);
          win.overlay = ratio === null ? null : ratio >= TRANSPARENT_RATIO;
          if (win.overlay === false) {
            probing = false;
          }
        }
        if (win.overlay) {
          overlays.push(rect);
          continue;
        }
      }

      if (visible.some((top) => isCovered(rect, top))) {
        continue;
      }
      visible.push(rect);
      // 只跟着**真正下发**的矩形采样，原始值和换算值才是同一个窗口，
      // 否则日志里这两行对不上，坐标空间对不对根本核不出来
      if (raw.length < 2) {
        raw.push({
          x: win.x,
          y: win.y,
          width: win.width,
          height: win.height,
        });
      }
    }

    if (visible.length) {
      if (overlays.length) {
        logger?.(
          '剔除透明覆盖层 %d 条（窗口自身像素几乎全透明）',
          overlays.length,
        );
      }
    } else {
      // 一个普通窗口都没有：那这些就是真·全屏应用，全丢了等于什么都选不到
      visible.push(...overlays);
      if (overlays.length) {
        logger?.('只有覆盖层候选，按全屏应用保留 %d 条', overlays.length);
      }
    }

    logger?.('窗口坐标（前两个）原始 %o 换算后 %o', raw, visible.slice(0, 2));
  } catch (err) {
    logger?.('窗口枚举失败 %o', err);
    return [];
  }

  return visible;
}

/**
 * 窗口自身像素的透明比例：透明覆盖层（HUD / 灵动岛 / 输入法候选层）的窗口图像里
 * 绝大部分像素 alpha 都是 0，真实窗口则整窗不透明。
 *
 * 只裁三条横带（1/4、1/2、3/4 高度）算比例，避开整窗 `toRaw` 那 20MB 拷贝；
 * 取三条带的中位数，这样"中间有一条透明空隙"的真实窗口不会被误判。
 *
 * 拿不到像素（窗口已关闭、系统不给拍）时返回 null，调用方按"不是覆盖层"处理 ——
 * 宁可多留一个全屏高亮，也不能把真实窗口丢掉。
 */
function transparentRatio(
  win: WindowLike,
  logger?: (message: string, ...args: unknown[]) => void,
): number | null {
  let img: ImageLike;
  try {
    img = win.captureImageSync();
  } catch (err) {
    logger?.('覆盖层甄别：拍窗口失败 %o', err);
    return null;
  }

  const { width, height } = img;
  if (!width || !height) {
    return null;
  }

  const ratios: number[] = [];
  for (const frac of [0.25, 0.5, 0.75]) {
    const bandHeight = Math.max(1, Math.min(16, Math.floor(height / 8)));
    const top = Math.max(
      0,
      Math.min(
        height - bandHeight,
        Math.round(height * frac) - (bandHeight >> 1),
      ),
    );
    try {
      const band = img.cropSync(0, top, width, bandHeight);
      const raw = band.toRawSync();
      const px = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      const total = width * bandHeight;
      let clear = 0;
      for (let i = 0; i < total; i++) {
        // 读不到 alpha 就当不透明，和"拿不到像素"同一个保守方向
        if ((px[i * 4 + 3] ?? 255) < 128) {
          clear++;
        }
      }
      ratios.push(clear / Math.max(1, total));
    } catch {
      // 某条带取不到就跳过，还有另外两条
    }
  }

  if (!ratios.length) {
    return null;
  }
  ratios.sort((a, b) => a - b);
  return ratios[ratios.length >> 1] ?? null;
}

/**
 * 逐个窗口读几何。**必须让出主线程**：每个属性都是一次原生查询，
 * 几十个窗口读下来接近一秒，同步跑完宿主应用会整个卡住。
 */
async function enumerate(
  logger?: (message: string, ...args: unknown[]) => void,
): Promise<RawWindow[]> {
  const result: RawWindow[] = [];

  try {
    const { Window } = await import('node-screenshots');

    // 原生顺序就是 z 从大到小，渲染端从上往下找第一个命中的窗口即视觉上最上面的那个
    const windows = Window.all();

    for (let i = 0; i < windows.length; i++) {
      if (i > 0 && i % YIELD_EVERY === 0) {
        await yieldToLoop();
      }

      const win = windows[i];
      if (!win) {
        continue;
      }
      if (win.isMinimized()) {
        continue;
      }

      result.push({
        // 本进程的窗口不在这里排除，见 `getWindows` 里的说明
        pid: win.pid(),
        z: win.z(),
        x: win.x(),
        y: win.y(),
        width: win.width(),
        height: win.height(),
        win,
      });
    }

    // 文档说 `Window.all()` 已经按 z 排好，但这是拾取正确性的前提（拿错顺序就会选中背后的窗口），
    // 不赌平台实现，这里排一次 —— 只在枚举那一次付这点开销，换屏走缓存不重排
    result.sort((a, b) => b.z - a.z);
  } catch (err) {
    // 枚举失败（没权限、屏幕锁定、系统正忙）就当没有窗口：
    // 结果一起缓存起来，别让换屏时再花几秒重试一遍
    logger?.('窗口枚举失败 %o', err);
  }

  logger?.('窗口枚举 %d 个（已剔除最小化）', result.length);

  return result;
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
