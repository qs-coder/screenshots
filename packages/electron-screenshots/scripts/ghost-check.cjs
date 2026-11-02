#!/usr/bin/env electron
/**
 * 残影（ghost）自检：把"宿主窗口刚 hide 就抓屏"做成可复现的像素测量。
 *
 * 为什么需要它：残影是个**时序**问题，肉眼看截图只能看到"有没有"，看不到
 * "差多少、还差几毫秒"。这里的做法是拿一块纯品红（#FF00FF）的无边框窗口当
 * 探针 —— 品红在屏幕上几乎不可能自然出现，所以窗口矩形里"品红像素占比"
 * 就是残影的量化值：1.00 = 窗口还完整留在底图里，0.00 = 已经完全消失。
 *
 * 品红还有个附带好处：R 和 B 相等，所以不管 toRawSync() 给的是 RGBA 还是
 * BGRA，判据都一样，不用先去确认通道顺序。
 *
 * 测三件事：
 * 1. 权限基线 —— 窗口**可见**时抓一次，占比应该接近 1.00。拿不到这个数就说明
 *    没有屏幕录制权限（macOS 会只给壁纸和菜单栏），后面的数字全无意义，
 *    所以基线不过就直接退出，不产出误导性的"没有残影"。
 * 2. hide 之后 0 / 16 / 33 / 50ms 各抓一次 —— 这就是 `captureSettleMs`
 *    该取多少的依据。默认 50ms 对应最后一档。
 * 3. `node-screenshots` 能不能加载 —— 加载失败时插件会退到 desktopCapturer，
 *    那条路的第一帧是"更早的合成结果"，本身就是残影的来源。
 *
 * 用法（在 packages/electron-screenshots 下）：
 *   npm run build && npx electron scripts/ghost-check.cjs
 *
 * ⚠️ 权限：从终端起 Electron 时，TCC 把授权记在**终端**名下（责任进程链
 * `终端 → … → Electron`）。系统设置里给终端勾上"屏幕与系统音频录制"，
 * 或者用 `node scripts/dev-app.mjs` 起（权限记在 ScreenshotsDev 名下）。
 */
const {
  app,
  BrowserWindow,
  desktopCapturer,
  screen,
  systemPreferences,
} = require('electron');

/** 探针窗口：无边框纯品红，位置固定，方便按矩形统计 */
const PROBE = { x: 240, y: 220, width: 640, height: 420 };
const MAGENTA = 'ff00ff';
/** 抓屏相对 hide() 的延迟，单位 ms；最后一档就是默认的 captureSettleMs */
const DELAYS = [0, 16, 33, 50];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 矩形内"接近纯品红"的像素占比 */
function magentaRatio(raw, imageWidth, rect) {
  const { x, y, width, height } = rect;
  let hit = 0;
  let total = 0;
  for (let row = y; row < y + height; row += 1) {
    const lineOffset = row * imageWidth * 4;
    for (let col = x; col < x + width; col += 1) {
      const i = lineOffset + col * 4;
      const r = raw[i];
      const g = raw[i + 1];
      const b = raw[i + 2];
      total += 1;
      // R/B 都高、G 低 —— 品红。阈值放宽一点，容忍缩放插值和色彩配置偏移
      if (r > 190 && g < 90 && b > 190) {
        hit += 1;
      }
    }
  }
  return total ? hit / total : 0;
}

/** DIP 矩形 → 抓屏图像的像素矩形。用图像实际尺寸换算，不赌 Monitor 报的是 DIP 还是物理像素 */
function toImageRect(bounds, image, rect) {
  const scaleX = image.width / bounds.width;
  const scaleY = image.height / bounds.height;
  return {
    x: Math.round((rect.x - bounds.x) * scaleX),
    y: Math.round((rect.y - bounds.y) * scaleY),
    width: Math.round(rect.width * scaleX),
    height: Math.round(rect.height * scaleY),
  };
}

function pct(value) {
  return `${(value * 100).toFixed(2)}%`;
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const status = systemPreferences.getMediaAccessStatus('screen');
  console.log(`屏幕录制权限状态：${status}`);

  // 加载器是这次改动的重点：先确认它拿得到原生模块，否则测的就是兜底路径
  const loader = require('../lib/loadNodeScreenshots.js');
  loader.resetNodeScreenshotsCache();
  const startedAt = performance.now();
  loader.warmUpNodeScreenshots();
  const loadCost = performance.now() - startedAt;
  const mod = loader.getNodeScreenshots();
  const loadError = loader.getNodeScreenshotsLoadError();
  console.log(
    mod
      ? `node-screenshots 加载成功（同步 ${loadCost.toFixed(1)}ms，Monitor/Window 齐备）`
      : `node-screenshots 加载失败：${loadError && loadError.message}`,
  );
  if (!mod) {
    console.log('\n加载失败时插件会退到 desktopCapturer —— 那条路的第一帧可能就是残影来源。');
  }
  const { Monitor } = mod ?? require('node-screenshots');

  const display = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    ...PROBE,
    frame: false,
    show: false,
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    backgroundColor: `#${MAGENTA}`,
    webPreferences: { offscreen: false },
  });
  await win.loadURL(
    `data:text/html,<body style="margin:0;height:100vh;background:%23${MAGENTA}"></body>`,
  );

  // 探针在窗口中心所在的那块屏上；按中心点挑，挑不到就用第一块
  const center = { x: PROBE.x + PROBE.width / 2, y: PROBE.y + PROBE.height / 2 };
  const monitors = Monitor.all();
  const monitor =
    monitors.find(
      (m) =>
        center.x >= m.x() &&
        center.x < m.x() + m.width() &&
        center.y >= m.y() &&
        center.y < m.y() + m.height(),
    ) ?? monitors[0];
  if (!monitor) {
    console.error('拿不到显示器对象，退出');
    app.exit(2);
    return;
  }
  // Electron 39 的 Display 上已经没有顶层 width/height 了，统一走 bounds
  const bounds = display.bounds;
  console.log(
    `显示器 ${monitor.width()}x${monitor.height()}（scaleFactor ${monitor.scaleFactor()}），` +
      `Electron display ${bounds.width}x${bounds.height} @ ${bounds.x},${bounds.y}`,
  );

  // ---- 1. 权限基线：窗口可见时必须抓到满屏品红 ----
  win.show();
  await sleep(500);
  const baselineStart = performance.now();
  const baselineImage = await monitor.captureImage();
  const baselineCost = performance.now() - baselineStart;
  const rect = toImageRect(bounds, baselineImage, PROBE);
  console.log(
    `抓屏图像 ${baselineImage.width}x${baselineImage.height}，探针矩形 ` +
      `${rect.width}x${rect.height} @ ${rect.x},${rect.y}`,
  );
  const baseline = magentaRatio(baselineImage.toRawSync(), baselineImage.width, rect);
  console.log(`\n[基线] 窗口可见：品红 ${pct(baseline)}（抓屏 ${baselineCost.toFixed(0)}ms）`);
  if (baseline < 0.5) {
    console.error(
      '\n基线不达标：抓不到屏幕内容（很可能没有屏幕录制权限）。' +
        '后面的数字不可信，已中止。\n' +
        '处理：系统设置 → 隐私与安全性 → 屏幕与系统音频录制，给当前终端（或 ScreenshotsDev）勾上后重跑。',
    );
    app.exit(2);
    return;
  }

  // ---- 2. hide 之后各档延迟的残影占比 ----
  console.log('\n[测量] hide() 之后抓屏，矩形内残留的品红占比：');
  const results = [];
  for (const delay of DELAYS) {
    // 每档都先让窗口稳定显示，再 hide，避免上一档的合成状态影响这一档
    win.show();
    win.focus();
    await sleep(400);
    win.hide();
    if (delay > 0) {
      await sleep(delay);
    }
    const grabStart = performance.now();
    const image = await monitor.captureImage();
    const grabCost = performance.now() - grabStart;
    const ratio = magentaRatio(image.toRawSync(), image.width, rect);
    results.push({ delay, ratio, grabCost });
    console.log(
      `  +${String(delay).padStart(2, ' ')}ms → 品红 ${pct(ratio)}（这次抓屏本身花了 ${grabCost.toFixed(0)}ms）`,
    );
  }

  // ---- 3. 对照组：兜底路径（desktopCapturer）的第一帧 ----
  // 这是原来那个 bug 的现场：原生模块加载失败时插件退到这条路，
  // 而 getSources 是"新建采集流取第一帧"，第一帧可能是更早的合成结果。
  // 整图统计（不切矩形）：探针窗口占整屏 19% 左右，有残影就该看见这个量级。
  console.log('\n[对照] 兜底路径 desktopCapturer 的第一帧：');
  const thumbSize = {
    width: Math.round(bounds.width * (display.scaleFactor || 1)),
    height: Math.round(bounds.height * (display.scaleFactor || 1)),
  };
  const captureFallback = async (label) => {
    const start = performance.now();
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: thumbSize,
    });
    const cost = performance.now() - start;
    const source =
      sources.find((s) => String(s.display_id) === String(display.id)) ??
      sources[0];
    if (!source) {
      console.log(`  ${label}: 拿不到屏幕源`);
      return null;
    }
    const size = source.thumbnail.getSize();
    const bitmap = source.thumbnail.toBitmap();
    let hit = 0;
    let total = 0;
    for (let i = 0; i + 3 < bitmap.length; i += 4) {
      total += 1;
      if (bitmap[i] > 190 && bitmap[i + 1] < 90 && bitmap[i + 2] > 190) {
        hit += 1;
      }
    }
    const ratio = total ? hit / total : 0;
    console.log(
      `  ${label}: 整屏品红 ${pct(ratio)}（${cost.toFixed(0)}ms，${size.width}x${size.height}）`,
    );
    return ratio;
  };
  win.show();
  await sleep(400);
  win.hide();
  const firstFrame = await captureFallback('第一帧');
  const secondFrame = await captureFallback('第二帧（插件实际采用的那帧）');
  if (firstFrame !== null && secondFrame !== null) {
    console.log(
      firstFrame > 0.05
        ? `  → 第一帧确实带残影（${pct(firstFrame)}），插件丢掉第一帧是必要的`
        : `  → 这次第一帧就是干净的（${pct(firstFrame)}），没复现出"旧帧"现象`,
    );
  }

  // ---- 4. 结论 ----
  const settled = results[results.length - 1];
  console.log('\n[结论]');
  if (settled.ratio < 0.02) {
    console.log(
      `  默认 captureSettleMs=50ms 时残影 ${pct(settled.ratio)}，肉眼不可见 —— 这条路径没有残影问题。`,
    );
  } else {
    console.log(
      `  ⚠️ 50ms 后仍有 ${pct(settled.ratio)} 的品红残留，说明合成还没完成，captureSettleMs 需要调大。`,
    );
  }
  const zero = results[0];
  console.log(
    `  参考：+0ms 时 ${pct(zero.ratio)} —— 抓屏本身要几十上百毫秒，` +
      '所以这一档实际采样点已经在请求之后很久，低于这个量级的差异测不出来。',
  );

  win.destroy();
  app.exit(0);
});
