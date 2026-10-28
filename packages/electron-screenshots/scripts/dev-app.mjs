#!/usr/bin/env node
/**
 * 把 node_modules 里的 Electron.app 复制成一份**属于本项目自己的** .app，
 * 让它直接跑仓库里的 demo，不再需要 `electron lib/demo.js` 这种命令行启动。
 *
 * 为什么需要这个：
 *
 * macOS 的屏幕录制权限按"应用"授予，而"应用"由 TCC 的责任进程决定。
 * 从终端 `npm run start` 起 Electron 时，责任进程链是
 * `iTerm2 → login → zsh → npm → Electron`，TCC 往上找到第一个 .app 就停了，
 * 于是权限记在 **终端** 名下 —— 系统设置里勾 "Electron" 完全无效，
 * `systemPreferences.getMediaAccessStatus('screen')` 永远是 denied。
 *
 * 这个脚本产出的 .app 有自己的 bundle id（com.qs-coder.screenshots.dev）和名字，
 * 双击 / `open` 启动时责任进程就是它自己，权限也就干净地记在它名下。
 *
 * 用法：
 *   node scripts/dev-app.mjs            # 生成（首次约 1 秒）并启动
 *   node scripts/dev-app.mjs --rebuild  # 强制重新复制 Electron.app（升级 Electron 后用）
 *   node scripts/dev-app.mjs --reset    # 先清掉本应用的屏幕录制授权，再启动（会重新弹系统框）
 *   node scripts/dev-app.mjs --path     # 只打印 .app 路径，不启动
 *
 * ⚠️ 只在首次运行 / 升级 Electron 时才需要 `--rebuild`：重新复制会重新签名，
 * 而 macOS 给 ad-hoc 签名记的授权条件是 **cdhash**（覆盖 Contents/Resources/app），
 * 指纹一变，系统里那条屏幕录制授权就作废，必须重新授权一次。
 * 平时改完源码只要 `npm run build` 再重启 app —— main.js 用绝对路径 require
 * 仓库里的 lib/demo.js，不碰 .app 本体，指纹不变，授权一直有效。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(pkgRoot, '../..');

const BUNDLE_ID = 'com.qs-coder.screenshots.dev';
const APP_NAME = 'ScreenshotsDev';
const outDir = path.join(pkgRoot, '.dev-app');
const appPath = path.join(outDir, `${APP_NAME}.app`);
const stampPath = path.join(outDir, '.electron-version');
const entry = path.join(pkgRoot, 'lib/demo.js');

const argv = process.argv.slice(2);
const forceRebuild = argv.includes('--rebuild');
const pathOnly = argv.includes('--path');
const resetPermission = argv.includes('--reset');

if (!fs.existsSync(entry)) {
  console.error(`找不到 ${entry}，先跑一次 npm run build`);
  process.exit(1);
}

// electron 这个包导出的就是可执行文件路径：.../Electron.app/Contents/MacOS/Electron
const electronBin = require('electron');
const srcApp = path.resolve(path.dirname(electronBin), '../..');
const electronVersion = require('electron/package.json').version;

if (process.platform !== 'darwin') {
  console.error('这个脚本只处理 macOS 的屏幕录制授权问题');
  process.exit(1);
}

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: 'pipe', ...opts });
}

function plistSet(key, value) {
  sh('/usr/libexec/PlistBuddy', [
    '-c',
    `Set :${key} ${value}`,
    path.join(appPath, 'Contents/Info.plist'),
  ]);
}

/**
 * 复制 Electron.app。
 *
 * 用 `cp -Rc`（APFS copy-on-write 克隆）：200MB 的包是瞬间完成的，不占额外磁盘。
 * 文件系统不支持时退回 `ditto`。
 */
function copyApp() {
  fs.rmSync(appPath, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  try {
    sh('/bin/cp', ['-Rc', srcApp, appPath]);
  } catch {
    sh('/usr/bin/ditto', [srcApp, appPath]);
  }
}

function needsCopy() {
  if (forceRebuild || !fs.existsSync(appPath)) {
    return true;
  }
  try {
    return fs.readFileSync(stampPath, 'utf8').trim() !== electronVersion;
  } catch {
    return true;
  }
}

if (needsCopy()) {
  process.stdout.write(`复制 Electron.app ${electronVersion} → ${appPath}\n`);
  copyApp();

  // 换成自己的身份：系统设置里就会显示 ScreenshotsDev，而不是一长串 Electron
  plistSet('CFBundleIdentifier', BUNDLE_ID);
  plistSet('CFBundleName', APP_NAME);
  plistSet('CFBundleDisplayName', APP_NAME);

  /**
   * Contents/Resources/app 存在时 Electron 会直接加载它，忽略内置的 default_app。
   * 于是不需要 `--args`（实测 macOS 26 的 LaunchServices 会把参数丢掉，
   * 结果启动成 Electron 的默认应用，而不是 demo）。
   *
   * main.js 里用绝对路径 require 仓库里的 lib/demo.js：
   * 改完源码 `npm run build` 再重启 app 即可，不用重新复制 .app。
   */
  const resApp = path.join(appPath, 'Contents/Resources/app');
  fs.mkdirSync(resApp, { recursive: true });
  fs.writeFileSync(
    path.join(resApp, 'package.json'),
    JSON.stringify(
      { name: 'screenshots-dev', productName: APP_NAME, version: '0.0.0', main: 'main.js' },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(resApp, 'main.js'),
    [
      '// 由 scripts/dev-app.mjs 生成，直接跑仓库里的 demo',
      `process.chdir(${JSON.stringify(repoRoot)});`,
      `require(${JSON.stringify(entry)});`,
      '',
    ].join('\n'),
  );

  /**
   * 改过 Info.plist 就必须重新签名，否则 TCC 认的还是原来那个 identifier（Electron）。
   * 用 ad-hoc 签名（`-`）就够了：本地开发不需要开发者证书。
   */
  process.stdout.write('重新签名（ad-hoc）…\n');
  try {
    sh('/usr/bin/codesign', [
      '--force',
      '--sign',
      '-',
      '--identifier',
      BUNDLE_ID,
      appPath,
    ]);
  } catch (error) {
    console.error('签名失败：', (error.stderr || error.message || '').toString().trim());
    process.exit(1);
  }

  fs.writeFileSync(stampPath, `${electronVersion}\n`);

  /**
   * 把签名指纹打出来 —— 它决定了屏幕录制授权还在不在。
   *
   * macOS 给 ad-hoc 签名的应用记的授权条件是 **cdhash**（不是 bundle id），
   * 而 cdhash 覆盖了 `Contents/Resources/app/main.js` 这些资源。所以：
   * 只要重新复制 / 重新签名，cdhash 就变，系统里那条授权立刻作废，
   * 用户必须重新授权一次。`--rebuild` 之后请提醒自己重走一次授权。
   */
  try {
    // codesign 把详情写到 stderr，所以要合并一下
    const quoted = `'${appPath.replace(/'/g, `'\\''`)}'`;
    const detail = sh('/bin/sh', [
      '-c',
      `/usr/bin/codesign -d --verbose=4 ${quoted} 2>&1`,
    ]);
    const cdhash = /^CDHash=(\w+)/m.exec(detail)?.[1];
    if (cdhash) {
      process.stdout.write(
        `签名指纹 cdhash=${cdhash}\n` +
          '（系统把屏幕录制授权记在这个指纹上；换了指纹就要重新授权）\n',
      );
    }
  } catch {
    // 拿不到就算了，不影响启动
  }
}

if (pathOnly) {
  console.log(appPath);
  process.exit(0);
}

// 授权记录是坏的 / 想重新走一遍系统弹框时用
if (resetPermission) {
  process.stdout.write(`重置屏幕录制授权（${BUNDLE_ID}）\n`);
  try {
    sh('/usr/bin/tccutil', ['reset', 'ScreenCapture', BUNDLE_ID]);
  } catch (error) {
    console.error('重置失败：', (error.stderr || error.message || '').toString().trim());
  }
}

// 先关掉旧实例：屏幕录制权限只在进程启动时生效，旧进程永远还是 denied，
// 留着它只会让用户点到那个"授权了也没用"的窗口
try {
  sh('/usr/bin/pkill', ['-f', `${appPath}/Contents/MacOS/Electron`]);
  await new Promise((resolve) => setTimeout(resolve, 600));
} catch {
  // 没在跑，正常
}

process.stdout.write(`启动 ${APP_NAME}\n`);
sh('/usr/bin/open', ['-n', appPath]);
