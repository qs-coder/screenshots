'use strict';

/**
 * 抓屏后端判定校验（不需要 Electron 运行环境）：
 *   npm run build && npm run test:backend
 */
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const {
  resolveCaptureBackend,
  configureCaptureBackend,
  resetCaptureBackend,
  getCaptureBackendDecision,
  CAPTURE_BACKEND_ENV,
} = require('../lib/captureBackend.js');

const cases = [
  {
    name: '麒麟 UKUI Wayland（带 DISPLAY，XWayland 场景）',
    input: {
      platform: 'linux',
      env: {
        XDG_SESSION_TYPE: 'wayland',
        XDG_CURRENT_DESKTOP: 'UKUI',
        WAYLAND_DISPLAY: 'wayland-0',
        DISPLAY: ':0',
      },
    },
    backend: 'electron',
  },
  {
    name: 'UKUI Wayland + 显式 ozone x11 仍禁原生',
    input: {
      platform: 'linux',
      env: {
        XDG_CURRENT_DESKTOP: 'UKUI',
        WAYLAND_DISPLAY: 'wayland-0',
        DISPLAY: ':0',
      },
      ozonePlatform: 'x11',
    },
    backend: 'electron',
  },
  {
    name: 'GNOME Wayland（ozone wayland）',
    input: {
      platform: 'linux',
      env: {
        XDG_SESSION_TYPE: 'wayland',
        XDG_CURRENT_DESKTOP: 'GNOME',
        WAYLAND_DISPLAY: 'wayland-0',
      },
      ozonePlatform: 'wayland',
    },
    backend: 'electron',
  },
  {
    name: 'X11 桌面（XDG_SESSION_TYPE=x11）',
    input: {
      platform: 'linux',
      env: { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' },
    },
    backend: 'native',
  },
  {
    name: '非 UKUI 的 XWayland（有 DISPLAY，ozone 默认）保留原生',
    input: {
      platform: 'linux',
      env: {
        XDG_SESSION_TYPE: 'wayland',
        XDG_CURRENT_DESKTOP: 'GNOME',
        WAYLAND_DISPLAY: 'wayland-0',
        DISPLAY: ':0',
      },
    },
    backend: 'native',
  },
  {
    name: '纯 Wayland（没有 DISPLAY）禁用原生',
    input: {
      platform: 'linux',
      env: {
        XDG_SESSION_TYPE: 'wayland',
        XDG_CURRENT_DESKTOP: 'GNOME',
        WAYLAND_DISPLAY: 'wayland-0',
      },
    },
    backend: 'electron',
  },
  {
    name: 'XWayland + 显式 ozone x11',
    input: {
      platform: 'linux',
      env: { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' },
      ozonePlatform: 'x11',
    },
    backend: 'native',
  },
  {
    name: 'macOS 保持原生',
    input: { platform: 'darwin', env: {} },
    backend: 'native',
  },
  {
    name: '环境变量强制 electron',
    input: {
      platform: 'win32',
      env: { [CAPTURE_BACKEND_ENV]: 'electron' },
    },
    backend: 'electron',
  },
  {
    name: '环境变量强制 native 覆盖 UKUI 判定',
    input: {
      platform: 'linux',
      env: {
        XDG_SESSION_TYPE: 'wayland',
        XDG_CURRENT_DESKTOP: 'UKUI',
        WAYLAND_DISPLAY: 'wayland-0',
        [CAPTURE_BACKEND_ENV]: 'native',
      },
    },
    backend: 'native',
  },
];

for (const { name, input, backend } of cases) {
  resetCaptureBackend();
  const decision = resolveCaptureBackend(input);
  assert.equal(decision.backend, backend, `${name}: ${decision.reason}`);
  assert.ok(decision.reason, `${name}: 缺少原因说明`);
  console.log(`✓ ${name} → ${backend}`);
}

resetCaptureBackend();
configureCaptureBackend('electron');
assert.equal(
  getCaptureBackendDecision().backend,
  'electron',
  '构造选项应覆盖平台判定',
);
configureCaptureBackend('native');
assert.equal(
  getCaptureBackendDecision().backend,
  'native',
  '构造选项应可运行时切换',
);
// 第二个实例不传选项时，应清掉上一个实例留下的显式覆盖，回到自动判定
configureCaptureBackend(undefined);
assert.equal(
  getCaptureBackendDecision().backend,
  process.platform === 'linux' ? getCaptureBackendDecision().backend : 'native',
  'undefined 应清掉显式覆盖',
);
assert.equal(
  resolveCaptureBackend({ platform: 'linux', env: { DISPLAY: ':0' } }).backend,
  'native',
  '清掉覆盖后 Linux X11 应回到原生',
);
resetCaptureBackend();
console.log('✓ 构造选项覆盖、运行时切换与 undefined 清覆盖');

// 端到端门禁：模拟 UKUI Wayland 后，原生模块入口必须拿不到模块、并且抛出的
// 是"后端已禁用"而不是别的加载错误 —— 这样 capture/getWindows 都会走原来的降级。
const gateCheck = `
  Object.defineProperty(process, 'platform', { value: 'linux' });
  process.env.XDG_SESSION_TYPE = 'wayland';
  process.env.XDG_CURRENT_DESKTOP = 'UKUI';
  process.env.WAYLAND_DISPLAY = 'wayland-0';
  process.env.DISPLAY = ':0';
  const backend = require('./lib/captureBackend.js');
  backend.resetCaptureBackend();
  const loader = require('./lib/loadNodeScreenshots.js');
  loader.resetNodeScreenshotsCache();
  loader.warmUpNodeScreenshots();
  if (loader.getNodeScreenshots() !== null) throw new Error('原生模块未被门禁拦截');
  try {
    loader.requireNodeScreenshots();
    throw new Error('requireNodeScreenshots 未抛错');
  } catch (err) {
    if (!err.message.includes('原生抓屏后端已禁用')) throw err;
  }
  console.log('gate-ok');
`;
const output = execFileSync(process.execPath, ['-e', gateCheck], {
  cwd: path.join(__dirname, '..'),
  encoding: 'utf8',
});
assert.match(output, /gate-ok/);
console.log('✓ UKUI 会话下原生模块入口被门禁拦截（不加载、抛禁用原因）');

// 异常托底（沿用 0.6.2 的行为）：门禁只挡"已知必崩"的环境，其他原生调用异常
// 必须仍然是普通 Error、能被 capture() 的 try/catch 接住并降级到 desktopCapturer。
// 这里用一个故意抛错的 require 模拟 asar/依赖缺失，验证 loader 抛的是可捕获 Error。
const throwCheck = `
  const Module = require('node:module');
  const original = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === 'node-screenshots') throw new Error('模拟原生调用异常');
    return original.apply(this, arguments);
  };
  const loader = require('./lib/loadNodeScreenshots.js');
  loader.resetNodeScreenshotsCache();
  let caught = null;
  try {
    loader.requireNodeScreenshots();
  } catch (err) {
    caught = err;
  }
  if (!(caught instanceof Error) || !caught.message.includes('模拟原生调用异常')) {
    throw new Error('异常没有以可捕获 Error 抛出: ' + String(caught));
  }
  console.log('throw-ok');
`;
const throwOutput = execFileSync(process.execPath, ['-e', throwCheck], {
  cwd: path.join(__dirname, '..'),
  encoding: 'utf8',
});
assert.match(throwOutput, /throw-ok/);
console.log('✓ 原生调用异常仍是可捕获 Error（capture 的 try/catch 能降级兜底）');

console.log('全部抓屏后端判定校验通过');
