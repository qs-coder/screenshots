#!/usr/bin/env electron
/**
 * 用 demo 那套流程（`Screenshots` + 宿主窗口 + 防截屏 `hide()`）跑一次**真实截图**，
 * 然后直接检查**底图 PNG** 里有没有宿主窗口的残影。
 *
 * 和 `ghost-check.cjs` 的区别：那个是纯抓屏时序测量，这个是走完整链路 ——
 * `startCapture()` → `settleBeforeGrab()` → `capture()` → 底图进 `shots` 缓存，
 * 也就是用户真正看到的那张图。所以它能回答"截图里到底还有没有自己"。
 *
 * 两次运行构成一组对照：
 *   npx electron scripts/ghost-demo.cjs            # 防截屏：先 hide 再截（默认）
 *   GHOST_KEEP=1 npx electron scripts/ghost-demo.cjs  # 不 hide：底图里应该能测到宿主窗口
 *
 * 后者是**阳性对照**：如果连"不 hide"都测不出品红，说明测量本身失效，
 * 前者的 0% 就不能当作"没有残影"的证据。
 *
 * 用法（packages/electron-screenshots 下，先 npm run build）：
 *   npx electron scripts/ghost-demo.cjs
 */
const path = require('node:path');
const {
  app,
  BrowserWindow,
  nativeImage,
  screen,
  systemPreferences,
} = require('electron');

const ROOT = path.resolve(__dirname, '..');
const Screenshots = require(path.join(ROOT, 'lib/index.js')).default;
const loader = require(path.join(ROOT, 'lib/loadNodeScreenshots.js'));

/** 宿主窗口：无边框纯品红，尺寸固定，位置按"截图会落在哪块屏"算出来 */
const HOST_SIZE = { width: 720, height: 480 };
const MAGENTA = 'ff00ff';
/** 是否模拟防截屏（先 hide 宿主窗口再截图）；GHOST_KEEP=1 关掉它 */
const ANTI_CAPTURE = process.env.GHOST_KEEP !== '1';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pct(value) {
  return `${(value * 100).toFixed(2)}%`;
}

/** 位图（BGRA）里某个矩形内"接近纯品红"的像素占比 */
function magentaRatio(bitmap, imageWidth, rect) {
  let hit = 0;
  let total = 0;
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const x1 = Math.min(imageWidth, Math.round(rect.x + rect.width));
  const y1 = Math.round(rect.y + rect.height);
  for (let y = y0; y < y1; y += 1) {
    const line = y * imageWidth * 4;
    for (let x = x0; x < x1; x += 1) {
      const i = line + x * 4;
      total += 1;
      // 品红的 R/B 相等，所以 BGRA / RGBA 两种顺序都适用
      if (bitmap[i] > 190 && bitmap[i + 1] < 90 && bitmap[i + 2] > 190) {
        hit += 1;
      }
    }
  }
  return total ? hit / total : 0;
}

app.whenReady().then(async () => {
  console.log(`屏幕录制权限：${systemPreferences.getMediaAccessStatus('screen')}`);
  console.log(
    `模式：${ANTI_CAPTURE ? '防截屏（hide 后截图）' : '不 hide（阳性对照）'}` +
      `，captureSettleMs=${process.env.GHOST_SETTLE ?? '默认 50'}`,
  );

  /**
   * 截图打的是**光标所在那块屏**（`getDisplay()` 取 `getCursorScreenPoint()`），
   * 所以宿主窗口必须摆到那块屏里，否则底图里根本不会有它，测量就没意义。
   */
  const target = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const hostRect = {
    x: target.bounds.x + 240,
    y: target.bounds.y + 200,
    width: Math.min(HOST_SIZE.width, target.bounds.width - 320),
    height: Math.min(HOST_SIZE.height, target.bounds.height - 280),
  };
  console.log(
    `目标屏 id=${target.id} ${target.bounds.width}x${target.bounds.height} @ ${target.bounds.x},${target.bounds.y}`,
  );

  const host = new BrowserWindow({
    ...hostRect,
    frame: false,
    backgroundColor: `#${MAGENTA}`,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  await host.loadURL(
    `data:text/html,<body style="margin:0;height:100vh;background:%23${MAGENTA}"></body>`,
  );
  // 让窗口稳定合成，避免"刚 show 就 hide"混进别的变量
  await sleep(800);

  // GHOST_SETTLE=0 关掉抓屏前的等待，用来验证"不等就抓"确实会拍到残影
  const settle = process.env.GHOST_SETTLE;
  const screenshots = new Screenshots({
    singleWindow: true,
    ...(settle === undefined ? {} : { captureSettleMs: Number(settle) }),
  });
  const display = target;

  if (ANTI_CAPTURE) {
    host.hide();
  }
  const startedAt = performance.now();
  await screenshots.startCapture();
  const cost = performance.now() - startedAt;

  // 底图在 shots 缓存里（private 字段，运行时可直接读）；预截其他屏是异步的，稍等一下
  let entry = screenshots.shots?.get(display.id);
  for (let i = 0; i < 40 && !entry; i += 1) {
    await sleep(100);
    entry = screenshots.shots?.get(display.id);
  }
  if (!entry) {
    console.error('没拿到底图（shots 里没有这块屏）—— 截图可能在更早的环节就失败了');
    app.exit(2);
    return;
  }

  const image = nativeImage.createFromBuffer(entry.png);
  const size = image.getSize();
  const bitmap = image.toBitmap();
  const scaleX = size.width / display.bounds.width;
  const scaleY = size.height / display.bounds.height;
  const rect = {
    x: (hostRect.x - display.bounds.x) * scaleX,
    y: (hostRect.y - display.bounds.y) * scaleY,
    width: hostRect.width * scaleX,
    height: hostRect.height * scaleY,
  };

  const inRect = magentaRatio(bitmap, size.width, rect);
  const whole = magentaRatio(bitmap, size.width, {
    x: 0,
    y: 0,
    width: size.width,
    height: size.height,
  });
  const loadError = loader.getNodeScreenshotsLoadError();

  console.log(`\nstartCapture 耗时 ${cost.toFixed(0)}ms`);
  console.log(
    `node-screenshots：${loadError ? `加载失败 ${loadError.message}` : '已加载（走的原生路径，不是 desktopCapturer 兜底）'}`,
  );
  console.log(`底图 ${size.width}x${size.height}，宿主窗口矩形 ${rect.width.toFixed(0)}x${rect.height.toFixed(0)}`);
  console.log(`宿主窗口区域品红：${pct(inRect)}`);
  console.log(`整张底图品红：${pct(whole)}`);

  if (ANTI_CAPTURE) {
    console.log(
      inRect < 0.01
        ? '\n✅ 底图里没有宿主窗口 —— 防截屏这条路径没有残影'
        : `\n❌ 底图里还残留 ${pct(inRect)} 的宿主窗口 —— 有残影`,
    );
  } else {
    console.log(
      inRect > 0.5
        ? '\n✅ 阳性对照成立：不 hide 时底图能测到宿主窗口，说明测量是灵敏的'
        : `\n⚠️ 阳性对照没成立（只有 ${pct(inRect)}）：测量本身可能失效，别把另一组 0% 当证据`,
    );
  }

  app.exit(0);
});
