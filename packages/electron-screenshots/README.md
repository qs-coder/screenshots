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

- 微信/Snipaste 式的**窗口识别与锁边**：截图画面锁住之后才枚举当前屏幕上**可见**的其他应用窗口矩形（按 z 序从最上层往下遍历，被更上层窗口整个盖住的不计入），通过 `SCREENSHOTS:windows` 单独发给渲染端，于是 hover 会高亮光标所在窗口、单击整窗选中、拖框和 resize 会自动吸附到窗口边（按住 `Alt`/`⌥` 关闭吸附）。枚举走 `node-screenshots` 的 `Window.all()`，它是**同步**的原生调用，窗口多的机器上是几十到几百毫秒，所以刻意排在显示之后——放在前面就是纯然的响应延迟；拿不到窗口时列表为空，交互自动退化成纯手动框选，不报错也不拖慢截图。可用 `DEBUG=electron-screenshots` 看 `窗口识别 N 条 Xms（截图显示之后）` 这行确认拿到几个窗口。

  窗口矩形会先换算成渲染端画布用的 DIP：`Window.all()` 和 `Monitor` 是同一套坐标（Windows 上是物理像素的全局虚拟桌面坐标），Electron 的 `display` 是 DIP，开显示缩放或多屏（尤其副屏在左侧、原点为负）时两套空间并不相同，所以先减掉本屏显示器的原点、再按 `monitor.width / display.width` 缩放。`DEBUG=electron-screenshots` 下的 `窗口坐标换算原始 …` 与 `窗口坐标（前两个）原始 … 换算后 …` 两行可以直接核对。

  各操作系统的支持情况（决定这个特性是否可用；窗口几何拿不到时可开启下方的像素元素识别作补充）：

  | 系统 | 窗口识别 | 需要的授权 |
  | ---- | -------- | ---------- |
  | Windows（x64/x32/arm64） | ✓ | 无 |
  | macOS（x64/arm64） | ✓ | **屏幕录制**。未授权时 `Window.all()` 只剩系统菜单栏，等效于不可用 |
  | Linux X11 | ✓ | 无 |
  | Linux Wayland | ✗ | 合成器不向其他进程暴露窗口几何，任何库都拿不到 |

  macOS 上这是系统限制而非 bug：`CGWindowListCopyWindowInfo` 对未授权进程会把每个窗口的 `kCGWindowName` 置空、`kCGWindowSharingState` 报 0，`node-screenshots`（Rust/xcap 预编译二进制）会把这类条目全部丢弃，纯 JS 侧无法绕过；`get-windows` 这类替代库同样要求屏幕录制或辅助功能授权，且要随包分发一个未签名的辅助可执行文件。所以推荐宿主应用引导用户授权 macOS 屏幕录制——库内置了引导入口：构造时传 `promptScreenPermission: true`，未授权时会在截图窗口创建前弹系统设置引导并**中止本次截图**（macOS 不允许程序申请该权限，`systemPreferences.askForMediaAccess` 只支持 microphone/camera，所以只能"提示 + 跳转设置"；授权后需重启应用，再点一次截图即可）。未授权期间每次触发都会提示并中止，避免截图按钮看起来"按了没反应"。不开这个选项时（默认），未授权不影响截图，只是没有窗口识别与锁边。空列表时日志会打印 `窗口识别不可用（空列表）screen access=denied` 这类原因。

- 元素级自动框选（可选，构造时传 `detectEdges: true`）。开启后，截图窗口显示之后会在 **worker 线程**里用这张图的 RGBA 像素通过 [`edge_det`](https://www.npmjs.com/package/edge_det)（纯 Rust→WASM 的界面描边识别）找出界面元素矩形，经 `SCREENSHOTS:edges` 单独发给渲染端，作为 hover 拾取的**兜底**边源（吸附只在拿不到窗口数据时才用它），坐标同样是画布内的 DIP。

  它和窗口识别**并存**，但拾取以窗口为主：渲染端只要光标落在某个系统窗口里（连窗口边框那 1px 也算）就整窗选中，元素矩形只在光标不在任何窗口里时生效（桌面控件、Wayland、macOS 未授权这些没有窗口数据的场合）。吸附同理只认窗口的边——元素边太碎，靠过去会把选区带偏，所以 `windows` 非空时 `edges` 不进吸附候选，为空时才顶上。原因很简单——像素法只能看到**露出来的那部分**，一个被别的窗口压住下边界的白色窗体，它检出来的是半截矩形，让半截去赢整窗是不对的。

  几个实现上的取舍：检测是异步的，截图窗口先显示、结果随后到，所以不会拖慢截图出现的速度；换屏或结束截图时旧的矩形会被丢弃。整屏 2x Retina（3024x1964 物理）实测约 200~700ms，因此长边超过 1920 会先降采样——偶数尺寸优先 2x2 均值而不是最近邻，否则 1px 的描边会被采样掉。结果会过滤掉小于 16 DIP 的碎块和几乎铺满整屏的框，同一条描边检出的内外两圈会合并成一个，嵌套超过 85% 面积的碎框也会被丢掉（否则同一个元素上会叠好几个互相乱跳的小框），最多下发 600 条。任何失败（超时 8s、worker 起不来、WASM 报错）都只是退化成空列表，不抛错。RGBA 是在截图窗口已经显示之后才从 `Image` 上取的，不占用截图出现的耗时；`desktopCapturer` 兜底的截图路径拿不到原始像素，那条路上会跳过元素识别。

  贴边精度靠**第二遍原生分辨率精修**：整屏那一遍降过采样，1px 描边会被 2x2 均值摊开，所以粗矩形的边系统性偏 1~3 DIP。渲染端 hover 到窗口之外的矩形时，会通过 `SCREENSHOTS:edgeRegion` 把那个粗矩形发给主进程；主进程按原生分辨率裁剪粗矩形四周 +8 DIP 的区域重检一次，把检出框按 1 物理像素内缩（Canny 检的是描边本身而不是填充边界），再把粗矩形四条边贴到各自最近的检出边上（阈值 6 DIP，只认包含粗矩形中心的框，保证还是同一个元素），结果经 `SCREENSHOTS:edges-precise` 只回给发起请求的那一次，不进整屏候选集。粗矩形仍然先显示，精修随后替换，所以不会有闪烁。区域过大（边长超过 700 DIP 或面积超过屏幕 35%）时这次精修不值得做，会记一条 `邻域精修跳过（区域过大）` 并保留粗矩形。

  Canny 双阈值默认 `{ low: 20, high: 60 }`，浅色低对比的界面（灰底白卡）检不出来就往下调，壁纸噪声太多就往上调：

  ```js
  const screenshots = new Screenshots({
    detectEdges: true,
    edgeThresholds: { low: 10, high: 30 },
  });
  ```

  **它绕不过系统权限**：macOS 未授予屏幕录制时，截图像素本身就只有壁纸和菜单栏（其他应用的内容连画面都被系统抹掉了），像素识别能检出的只是壁纸碎块。所以这个选项是给"窗口数据不够细"或"平台拿不到窗口几何"（Wayland）的场合补元素级拾取用的。渲染端要把 `edges` 传给 `<Screenshots>`，见 `@qs-coder/react-screenshots` 的文档。

- Windows 上截图窗口使用 `screen-saver` 置顶层级，并在失焦时立刻重新置顶并抢回焦点。原因是任务栏自身是 topmost 窗口，`setAlwaysOnTop(true)` 默认的 `floating` 层级排在任务栏**之下**，点一下任务栏截图界面就会沉底，加上 `skipTaskbar` 之后没有任何入口可以点回来，看起来像"截图丢了"。注意 `Win+D`、`Alt+Tab` 这类系统快捷键无法拦截，只能在失焦后抢回焦点。

- **点击到"画面锁住"的响应速度**：`startCapture` 现在按"先锁屏、再补数据"排列。截屏+PNG 编码 与 建窗口（含等渲染端 reset 回执）并行跑；拿到图就先发 `SCREENSHOTS:capture` 再 `show()`；窗口枚举、元素识别、屏蔽其他屏幕都排在显示之后。于是从点击到画面静止的时间约等于 `captureImage + toPng`，其余全部异步补齐。渲染端在这段空窗里保持不渲染（没有 image 就返回 null），不会出现"遮罩先黑一下、画面后到"的观感。

  底图的 IPC 载荷也从 **base64 dataURL 字符串换成了 PNG 字节**（省一次编码、一次解码和一个几 MB 字符串穿过 IPC），渲染端用 `URL.createObjectURL(new Blob([png], { type: 'image/png' }))` 拿到 URL，并在换屏/结束时 `revokeObjectURL`。**自带渲染层的宿主要注意这个破坏性变更**：`on('capture')` 的第二个参数不再是字符串，第三个参数（窗口矩形）挪到了独立的 `on('windows')` 通道。`desktopCapturer` 兜底路径同样返回 PNG 字节。

- 排查截图响应慢，可以用 `DEBUG=electron-screenshots` 启动应用，`startCapture` / `capture` / `reset` / `createWindow` 会分段输出耗时：

```
startCapture isReady +0ms (total 1ms)
SCREENSHOTS:capture 耗时 import 1ms fromPoint 0ms captureImage 96ms toPng 118ms png 3421KB
createWindow 耗时 21ms (含 reset)
startCapture capture + createWindow +236ms (total 237ms)
startCapture send capture +3ms (total 240ms)
窗口识别 37 条 18ms（截图显示之后）
元素检测 128 条 340ms
邻域精修 4 条 22ms 粗矩形 { x: 60, y: 50, width: 261, height: 151 } → { x: 60, y: 50, width: 260, height: 150 }
```

  看两行就够了：`capture + createWindow` 那行的 total 就是"画面锁住"的时刻；如果它明显大于 `SCREENSHOTS:capture 耗时` 里的 `captureImage + toPng`，说明卡在建窗口或渲染端 reset 回执上（首次截图常见，`singleWindow: true` 复用同一个窗口能省掉大半）。

- 元素识别贴不准边时，用 `DEBUG=electron-screenshots,edge_det` 启动，会额外整屏跑一遍**原生分辨率**检测并写一张调试图（日志里给出路径，形如 `/tmp/qs-screenshots-edges-<时间戳>.png`）：青色是原生分辨率检出的真值边，洋红是实际下发给渲染端的 DIP 矩形，黄色是系统窗口矩形。两者错开多少、是不是漏检、是不是碎框重叠，看图就能分清。这一遍有 500ms 级别的耗时，只在开了 `edge_det` 时跑，正常路径不受影响。

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
  // 元素级自动框选：截图窗口显示后，在 worker 线程里用截图像素（`edge_det`）识别界面元素矩形，
  // 拾取的兜底边源（光标落在某个窗口里时仍以整窗为准，吸附也只认窗口的边）。默认 false
  // 代价是多一个 WASM 依赖，且每次截图在后台多花几十到几百毫秒（不阻塞截图窗口显示）
  detectEdges?: boolean;
  // 元素识别的 Canny 双阈值，默认 { low: 20, high: 60 }
  // 浅色低对比的界面检不出来就往下调，壁纸噪声太多就往上调；只在 detectEdges 开启时生效
  edgeThresholds?: { low?: number; high?: number };
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
