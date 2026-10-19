# electron-screenshots

> electron 截图插件

## Prerequisites

- electron >= 11

## Install

[![NPM](https://nodei.co/npm/electron-screenshots.png?downloads=true&downloadRank=true&stars=true)](https://nodei.co/npm/electron-screenshots/)

## Usage

```ts
import debug from "electron-debug";
import { app, globalShortcut } from "electron";
import Screenshots from "./screenshots";

app.whenReady().then(() => {
  app.setAppUserModelId('com.electron.screenshots')
  const screenshots = new Screenshots();
  globalShortcut.register("ctrl+shift+a", () => {
    screenshots.startCapture();
    screenshots.$view.webContents.openDevTools();
  });
  // 点击确定按钮回调事件
  screenshots.on("ok", (e, buffer, bounds) => {
    console.log("capture", buffer, bounds);
  });
  // 点击取消按钮回调事件
  screenshots.on("cancel", () => {
    console.log("capture", "cancel1");
  });
  screenshots.on("cancel", (e) => {
    // 执行了preventDefault
    // 点击取消不会关闭截图窗口
    e.preventDefault();
    console.log("capture", "cancel2");
  });
  // 点击保存按钮回调事件
  screenshots.on("save", (e, buffer, bounds) => {
    console.log("capture", buffer, bounds);
  });
  // 保存后的回调事件
  screenshots.on("afterSave", (e, buffer, bounds, isSaved) => {
    console.log("capture", buffer, bounds);
    console.log("isSaved", isSaved); // 是否保存成功
  });
  debug({ showDevTools: true, devToolsMode: "undocked" });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
```

### 注意

- 如果使用了 webpack 打包主进程，请在主进程 webpack 配置中修改如下配置，否则可能会出现不能调用截图窗口的情况

```js
{
  externals: {
    'electron-screenshots': 'require("electron-screenshots")'
  }
}
```

- `vue-cli-plugin-electron-builder`配置示例[vue-cli-plugin-electron-builder-issue](https://github.com/nashaofu/vue-cli-plugin-electron-builder-issue/blob/0f774a90b09e10b02f86fcb6b50645058fe1a4e8/vue.config.js#L1-L8)

```js
// vue.config.js
module.exports = {
  publicPath: ".",
  pluginOptions: {
    electronBuilder: {
      // 不打包，使用 require 加载
      externals: ["electron-screenshots"],
    },
  },
};
```

- vite 配置示例：

```js
// vite.config.js
import { defineConfig } from "vite";
import viteExternals from "vite-plugin-externals";

export default defineConfig({
  plugins: [
    viteExternals({
      "electron-screenshots": 'require("electron-screenshots")', // 模块名称: 全局变量
    }),
  ],
});
```

- esc 取消截图，可用以下代码实现按 esc 取消截图

```js
globalShortcut.register("esc", () => {
  if (screenshots.$win?.isFocused()) {
    screenshots.endCapture();
  }
});
```

- 加速截图界面展示，不销毁`BrowserWindow`，减少创建窗口的开销，可用以下代码实现。**需注意，启用该功能，会导致`window-all-closed`事件不触发，因此需要手动关闭截图窗口**

```js
// 是否复用截图窗口，加快截图窗口显示，默认值为 false
// 如果设置为 true 则会在第一次调用截图窗口时创建，后续调用时直接使用
// 且由于窗口不会 close，所以不会触发 app 的 `window-all-closed` 事件
const screenshots = new Screenshots({
  singleWindow: true,
});
```

- 多屏幕时，**已经框选出选区**的截图期间，**非活动屏幕**上会叠一层半透明黑底 + `not-allowed` 光标的屏蔽窗口，鼠标划过去点不到其他程序，只会点到这层遮罩；活动屏幕上的截图窗口本身覆盖了整块屏幕（含 Windows 任务栏），所以截图期间整机相当于被"锁住"。键盘输入继续发给截图窗口（Esc 取消走截图窗口的焦点，不受影响）。

  所以想在扩展屏截图，就在**还没按下鼠标**的时候把光标移到扩展屏，它会变成活动屏（原屏随即被锁住），再按下框选即可；一旦开始框选，其他屏幕就只剩 `not-allowed`，截不到也点不到，需要按 Esc 退出后重新触发。Linux（Wayland 无法可靠定位窗口）不创建屏蔽窗口，只保留跟手换屏。

- 微信/Snipaste 式的**窗口识别与锁边**：`startCapture` 时会枚举当前屏幕上**可见**的其他应用窗口矩形（按 z 序从最上层往下遍历，被更上层窗口整个盖住的不计入），随截图数据一起发给渲染端，于是 hover 会高亮光标所在窗口、单击整窗选中、拖框和 resize 会自动吸附到窗口边（按住 `Alt`/`⌥` 关闭吸附）。枚举走 `node-screenshots` 的 `Window.all()`，实测耗时约 16ms；拿不到窗口时列表为空，交互自动退化成纯手动框选，不报错也不拖慢截图。可用 `DEBUG=electron-screenshots` 看 `startCapture windows(N)` 这行确认拿到几个窗口。

  各操作系统的支持情况（决定这个特性是否可用，代码里没有其它兜底数据源）：

  | 系统 | 窗口识别 | 需要的授权 |
  | ---- | -------- | ---------- |
  | Windows（x64/x32/arm64） | ✓ | 无 |
  | macOS（x64/arm64） | ✓ | **屏幕录制**。未授权时 `Window.all()` 只剩系统菜单栏，等效于不可用 |
  | Linux X11 | ✓ | 无 |
  | Linux Wayland | ✗ | 合成器不向其他进程暴露窗口几何，任何库都拿不到 |

  macOS 上这是系统限制而非 bug：`CGWindowListCopyWindowInfo` 对未授权进程会把每个窗口的 `kCGWindowName` 置空、`kCGWindowSharingState` 报 0，`node-screenshots`（Rust/xcap 预编译二进制）会把这类条目全部丢弃，纯 JS 侧无法绕过；`get-windows` 这类替代库同样要求屏幕录制或辅助功能授权，且要随包分发一个未签名的辅助可执行文件。所以推荐宿主应用引导用户授权 macOS 屏幕录制——库内置了引导入口：构造时传 `promptScreenPermission: true`，未授权时会在截图窗口创建前弹系统设置引导并**中止本次截图**（macOS 不允许程序申请该权限，`systemPreferences.askForMediaAccess` 只支持 microphone/camera，所以只能"提示 + 跳转设置"；授权后需重启应用，再点一次截图即可）。未授权期间每次触发都会提示并中止，避免截图按钮看起来"按了没反应"。不开这个选项时（默认），未授权不影响截图，只是没有窗口识别与锁边。空列表时日志会打印 `窗口识别不可用（空列表）screen access=denied` 这类原因。

- Windows 上截图窗口使用 `screen-saver` 置顶层级，并在失焦时立刻重新置顶并抢回焦点。原因是任务栏自身是 topmost 窗口，`setAlwaysOnTop(true)` 默认的 `floating` 层级排在任务栏**之下**，点一下任务栏截图界面就会沉底，加上 `skipTaskbar` 之后没有任何入口可以点回来，看起来像"截图丢了"。注意 `Win+D`、`Alt+Tab` 这类系统快捷键无法拦截，只能在失焦后抢回焦点。

- 排查截图响应慢，可以用 `DEBUG=electron-screenshots` 启动应用，`startCapture` / `capture` / `reset` / `createWindow` 会分段输出耗时：

```
startCapture capture +236ms (total 237ms)
SCREENSHOTS:capture 耗时 import 1ms fromPoint 0ms captureImage 96ms toPng 118ms base64 14ms png 3421KB
createWindow 耗时 21ms (含 reset)
```

## Methods

- `Debugger`类型产考[debug](https://github.com/debug-js/debug)中的`Debugger`类型

```ts
export type LoggerFn = (...args: unknown[]) => void;
export type Logger = Debugger | LoggerFn;

export interface Lang {
  magnifier_position_label?: string;
  operation_ok_title?: string;
  operation_cancel_title?: string;
  operation_save_title?: string;
  operation_redo_title?: string;
  operation_undo_title?: string;
  operation_mosaic_title?: string;
  operation_text_title?: string;
  operation_brush_title?: string;
  operation_arrow_title?: string;
  operation_ellipse_title?: string;
  operation_rectangle_title?: string;
}

export interface ScreenshotsOpts {
  lang?: Lang;
  // 调用日志，默认值为 debug('electron-screenshots')
  // debug https://www.npmjs.com/package/debug
  logger?: Logger;
  // 是否复用截图窗口，加快截图窗口显示，默认值为 false
  // 如果设置为 true 则会在第一次调用截图窗口时创建，后续调用时直接使用
  // 且由于窗口不会 close，所以不会触发 app 的 `window-all-closed` 事件
  singleWindow?: boolean;
  // macOS 上检测到屏幕录制未授权时，弹窗引导用户去「系统设置 → 隐私与安全性 → 屏幕录制」，
  // 并中止本次截图（此时还没创建截图窗口，干净退出）。默认 false
  // 未授权期间每次触发都会提示并中止，直到完成授权（授权后需重启应用）
  promptScreenPermission?: boolean;
}
```

| 名称                                              | 说明             | 返回值 |
| ------------------------------------------------- | ---------------- | ------ |
| `constructor(opts: ScreenshotsOpts): Screenshots` | 调用截图方法截图 | -      |
| `startCapture(): Promise<void>`                   | 调用截图方法截图 | -      |
| `endCapture(): Promise<void>`                     | 手动结束截图     | -      |
| `setLang(lang: Lang): Promise<void>`              | 修改语言         | -      |

## Events

- 数据类型

```ts
interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Display {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenshotsData {
  bounds: Bounds;
  display: Display;
}

class Event {
  public defaultPrevented = false;

  public preventDefault(): void {
    this.defaultPrevented = true;
  }
}
```

| 名称          | 说明                                                        | 回调参数                                                                          |
| ------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------- |
| ok            | 截图确认事件                                                | `(event: Event, buffer: Buffer, data: ScreenshotsData) => void`                   |
| cancel        | 截图取消事件                                                | `(event: Event) => void`                                                          |
| save          | 截图保存事件                                                | `(event: Event, buffer: Buffer, data: ScreenshotsData) => void`                   |
| afterSave     | 截图保存（取消保存）后的事件                                | `(event: Event, buffer: Buffer, data: ScreenshotsData, isSaved: boolean) => void` |
| windowCreated | 截图窗口被创建后触发                                        | `($win: BrowserWindow) => void`                                                   |
| windowClosed  | 截图窗口被关闭后触发，对`BrowserWindow` `closed` 事件的转发 | `($win: BrowserWindow) => void`                                                   |

### 说明

- event: 事件对象
- buffer: png 图片 buffer
- bounds: 截图区域信息
- display: 截图的屏幕
- `event`对象可调用`preventDefault`方法来阻止默认事件，例如阻止默认保存事件

```ts
const screenshots = new Screenshots({
  lang: {
    magnifier_position_label: "Position",
    operation_ok_title: "Ok",
    operation_cancel_title: "Cancel",
    operation_save_title: "Save",
    operation_redo_title: "Redo",
    operation_undo_title: "Undo",
    operation_mosaic_title: "Mosaic",
    operation_text_title: "Text",
    operation_brush_title: "Brush",
    operation_arrow_title: "Arrow",
    operation_ellipse_title: "Ellipse",
    operation_rectangle_title: "Rectangle",
  },
});

screenshots.on("save", (e, buffer, data) => {
  // 阻止插件自带的保存功能
  // 用户自己控制保存功能
  e.preventDefault();
  // 用户可在这里自己定义保存功能
  console.log("capture", buffer, data);
});

screenshots.startCapture();
```

## Screenshot

![screenshot](../../screenshot.jpg)
