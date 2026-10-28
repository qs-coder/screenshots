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

- 多屏幕时，截图期间**每一块屏幕**都有一个常驻的屏蔽窗口（半透明黑底 + `not-allowed` 光标）：非活动屏幕被它压暗并挡掉点击，活动屏幕那一个保持全透明且放行鼠标，由截图窗口盖住整块屏幕（含 Windows 任务栏）。所以一旦截图开始，整机相当于被"锁住"。键盘输入继续发给截图窗口（Esc 取消走截图窗口的焦点，不受影响）。

  屏蔽窗口是**开场一次建全**的，整场截图只切换 opacity，不再创建/销毁任何窗口——以前每换一次屏都要销毁一个再重建一个，重建要走 `new BrowserWindow` + `loadURL` + `show`（实测 80~150ms），这段空窗期里刚离开的那块屏会露出真实桌面，然后才被半透明黑盖上，来回切换就是"亮一下、黑一下"。

  所以想在扩展屏截图，就在**还没按下鼠标**的时候把光标移到扩展屏，它会变成活动屏（原屏随即被压暗），再按下框选即可；一旦开始框选，其他屏幕就只剩 `not-allowed`，截不到也点不到，需要按 Esc 退出后重新触发。Linux（Wayland 无法可靠定位窗口）不创建屏蔽窗口，只保留跟手换屏。

  **换屏绝不重新截屏**：那一刻目标屏上正盖着遮罩，重截会把那层半透明黑一起拍进底图，于是换过去的画面整体暗一半、导出的图也是灰的。因此开场就把**每块屏**各自截好存进缓存（并行截、并行编码，不阻塞截图窗口显示），换屏只是取缓存；只有截图过程中**新插进来**的屏幕才会现场补截，补截前会先把那块屏的遮罩隐掉、截完再恢复。换屏的顺序也为此排过：新图先画好 → 旧屏压暗 → 搬窗口 → 新屏撤遮罩，每一步都发生在用户看不见的时候。

- 微信/Snipaste 式的**窗口识别与锁边**：截图画面锁住之后才枚举屏幕上**可见**的其他应用窗口矩形（按 z 序从最上层往下遍历，被更上层窗口整个盖住的不计入），通过 `SCREENSHOTS:windows` 单独发给渲染端，于是 hover 会高亮光标所在窗口、单击整窗选中、拖框和 resize 会自动吸附到窗口边（按住 `Alt`/`⌥` 关闭吸附）。枚举走 `node-screenshots` 的 `Window.all()`，它是**同步**的原生调用，窗口多的机器上是几十到几百毫秒，所以刻意排在显示之后——放在前面就是纯然的响应延迟；拿不到窗口时列表为空，交互自动退化成纯手动框选，不报错也不拖慢截图。可用 `DEBUG=electron-screenshots` 看 `窗口识别 N 条 Xms（N 号屏）` 这行确认每块屏拿到几个窗口。

  一次截图把**所有屏幕**的识别结果一次算完并按 `display.id` 缓存（窗口枚举是全局的，投到某块屏只是纯坐标换算），换屏时只把缓存数组发下去、1ms 量级。以前是每次换屏都重算一遍，枚举 + 甄别 + 识别能把主线程占住一秒上下，表现就是"窗口追不上光标、来回划屏一路闪"。日志里的 `复用缓存` 说明这次没重新枚举。

  窗口矩形会先换算成渲染端画布用的 DIP：`Window.all()` 和 `Monitor` 是同一套坐标（Windows 上是物理像素的全局虚拟桌面坐标），Electron 的 `display` 是 DIP，开显示缩放或多屏（尤其副屏在左侧、原点为负）时两套空间并不相同，所以先减掉本屏显示器的原点、再按 `monitor.width / display.width` 缩放。`DEBUG=electron-screenshots` 下的 `窗口坐标换算原始 …` 与 `窗口坐标（前两个）原始 … 换算后 …` 两行可以直接核对。

  矩形会取整到**左上 floor、右下 ceil**：拾取判定按整数像素比，小数边会让左/上边缘丢掉不到 1 DIP 的一条带，元素矩形就从那条带上冒出来，现象还是"窗口边缘被切碎"。宁可多占半个像素也绝不漏。

  两类窗口会被特意处理：

  - **透明覆盖层**（HUD、灵动岛、输入法候选层）：尺寸几乎铺满整屏、内容却基本全透明，z 值又压在真实窗口之上，留着会让光标在**任何位置**都命中它、真实窗口全被遮挡判定吃掉。判据是**窗口自己的像素**——盖住屏幕 85% 以上的候选会拍一次窗口自身图像，取三条横带算 alpha 接近 0 的像素占比，中位数超过 50% 才判为覆盖层并剔除（实测 HUD 类 97% 透明、真实窗口 100% 不透明，中间没有灰色地带）。这不是"超线就丢"的面积阈值：最大化窗口同样盖住 85% 以上，把它砍掉的话最常见的那个窗口反而选不到。甄别结果跟着窗口自身的缓存走，换屏不重拍；拍一次是同步原生调用（实测 70~530ms），所以按 z 从高往低试、最多拍 2 个，**一拍到不透明窗口就停**（覆盖层永远浮在真实窗口之上）。拿不到像素时按"不是覆盖层"处理——宁可多留一个全屏高亮，也不能把真实窗口丢掉；若整块屏一个普通窗口都没有，那这些就是真·全屏应用，会保留而不是返回空列表。
  - **跨屏残片**：一块窗口横跨两台显示器时，落在本屏的可能只有 `0,363 2x33` 这样一条 2 像素宽的边，既选不中也选不准，还会把锁边吸附带偏，所以宽高小于 8 DIP 的一律不作为拾取目标。

  本进程自己的窗口**只排除铺满整屏的那几个**（截图窗口 + 各屏的屏蔽窗口，它们留着会让任何位置都命中"全屏窗口"）。以前是按 pid 一刀切，宿主应用自己的普通窗口因此完全不能拾取，只能靠像素元素识别，被内部的分隔线切成好几块——看起来就是"一个窗口被识别成两个区域"。现在宿主自己的窗口正常参与识别（拿自家应用做演示是常见用法）。

  逐个读窗口属性都是一次原生调用（实测约 2ms），几十个窗口读下来接近一秒，所以枚举循环每 4 个窗口让出一次主线程，否则**宿主应用会被这段循环冻住**；实测让出反而更快（原生层有机会把查询批处理掉），单次卡顿也从整段降到几十毫秒。

  各操作系统的支持情况（决定这个特性是否可用；窗口几何拿不到时可开启下方的像素元素识别作补充）：

  | 系统 | 窗口识别 | 需要的授权 |
  | ---- | -------- | ---------- |
  | Windows（x64/x32/arm64） | ✓ | 无 |
  | macOS（x64/arm64） | ✓ | **屏幕录制**。未授权时 `Window.all()` 只剩系统菜单栏，等效于不可用 |
  | Linux X11 | ✓ | 无 |
  | Linux Wayland | ✗ | 合成器不向其他进程暴露窗口几何，任何库都拿不到 |

  macOS 上这是系统限制而非 bug：`CGWindowListCopyWindowInfo` 对未授权进程会把每个窗口的 `kCGWindowName` 置空、`kCGWindowSharingState` 报 0，`node-screenshots`（Rust/xcap 预编译二进制）会把这类条目全部丢弃，纯 JS 侧无法绕过；`get-windows` 这类替代库同样要求屏幕录制或辅助功能授权，且要随包分发一个未签名的辅助可执行文件。所以推荐宿主应用引导用户授权 macOS 屏幕录制——库内置了引导入口：构造时传 `promptScreenPermission: true`（默认 `false`），未授权时会在截图窗口创建前弹系统设置引导并**中止本次截图**（macOS 不允许程序申请该权限，`systemPreferences.askForMediaAccess` 只支持 microphone/camera，所以只能"提示 + 跳转设置"；授权后需重启应用，再点一次截图即可）。不开这个选项时（默认），未授权不影响截图，只是没有窗口识别与锁边。空列表时日志会打印 `窗口识别不可用（空列表）screen access=denied` 这类原因。

  判定顺序是**先真抓一次画面、再信系统状态**，因为 `getMediaAccessStatus('screen')` 会给出 `not-determined` / `unknown` 这类"没准话"的答案，拿它当"没权限"用，用户明明早就授权了也会每次被弹窗拦住（这就是"加了授权还是提示未授权"的真因）。所以只有 `desktopCapturer.getSources` 确实取不到屏幕源时才走引导——这一次调用同时也是 TCC 的按需登记：不真的调采集 API，应用根本不会出现在「屏幕与系统音频录制」列表里，用户去系统设置找不到可勾的项；它同时会触发系统授权框，用户点「允许」后就直接放行、继续截图，不再有"需要重启"的二次弹窗。取源可能长时间不返回（实测过卡两分钟的机器），所以带超时兜底。**"取不到"不能反推成没授权**（采集环境异常时同样为空），因此这里只记"已确认有权限"、之后一次都不再打扰，绝不缓存"没有权限"。

  引导文案里会点名**该勾哪个应用**：macOS 把权限记在 TCC 认定的"责任进程"名下，而不是 Electron 名下——从终端 / IDE 里 `npm run start` 起的 Electron，要勾的是那个终端或 IDE，勾 "Electron" 完全无效。库会沿父进程链找到第一个 `.app` 包，把它的名字和绝对路径写进弹窗（列表里找不到时还可以一键复制 `tccutil reset ScreenCapture <bundleId>`，用于此前点过"不允许"、系统不再弹窗的情况）。

- 元素级自动框选（可选，构造时传 `detectEdges: true`）。开启后，截图窗口显示之后会在 **worker 线程**里用这张图的 RGBA 像素通过 [`edge_det`](https://www.npmjs.com/package/edge_det)（纯 Rust→WASM 的界面描边识别）找出界面元素矩形，经 `SCREENSHOTS:edges` 单独发给渲染端，作为 hover 拾取的**兜底**边源（吸附只在拿不到窗口数据时才用它），坐标同样是画布内的 DIP。每块屏各算各的（用的就是那块的预截缓存），结果按 `display.id` 存着，换屏只下发缓存。

  它和窗口识别**并存**，但拾取以窗口为主：渲染端只要光标落在某个系统窗口里（连窗口边框那 1px 也算）就整窗选中，元素矩形只在光标不在任何窗口里时生效（桌面控件、Wayland、macOS 未授权这些没有窗口数据的场合）。吸附同理只认窗口的边——元素边太碎，靠过去会把选区带偏，所以 `windows` 非空时 `edges` 不进吸附候选，为空时才顶上。原因很简单——像素法只能看到**露出来的那部分**，一个被别的窗口压住下边界的白色窗体，它检出来的是半截矩形，让半截去赢整窗是不对的。

  几个实现上的取舍：检测是异步的，截图窗口先显示、结果随后到，所以不会拖慢截图出现的速度；识别结果按屏缓存、一轮一换，新一轮截图和结束截图时整批释放（每块屏的 RGBA 是 22MB 级别，留着会占住宿主的内存）。整屏 2x Retina（3024x1964 物理）实测约 200~700ms，因此长边超过 1920 会先降采样——偶数尺寸优先 2x2 均值而不是最近邻，否则 1px 的描边会被采样掉。结果会过滤掉小于 16 DIP 的碎块和几乎铺满整屏的框，同一条描边检出的内外两圈会合并成一个，嵌套超过 85% 面积的碎框也会被丢掉（否则同一个元素上会叠好几个互相乱跳的小框），最多下发 600 条。任何失败（超时 8s、worker 起不来、WASM 报错）都只是退化成空列表，不抛错。RGBA 是在每块屏的截图抓到之后才从 `Image` 上取的，不占用"画面锁住"的耗时；`desktopCapturer` 兜底的截图路径拿不到原始像素，那条路上会跳过元素识别。

  贴边精度靠**第二遍原生分辨率精修**：整屏那一遍降过采样，1px 描边会被 2x2 均值摊开，所以粗矩形的边系统性偏 1~3 DIP。渲染端 hover 到窗口之外的矩形时，会通过 `SCREENSHOTS:edgeRegion` 把那个粗矩形发给主进程；主进程按原生分辨率裁剪粗矩形四周 +8 DIP 的区域重检一次，把检出框按 1 物理像素内缩（Canny 检的是描边本身而不是填充边界），再把粗矩形四条边贴到各自最近的检出边上（阈值 6 DIP，只认包含粗矩形中心的框，保证还是同一个元素），结果经 `SCREENSHOTS:edges-precise` 只回给发起请求的那一次，不进整屏候选集。粗矩形仍然先显示，精修随后替换，所以不会有闪烁。区域过大（边长超过 700 DIP 或面积超过屏幕 35%）时这次精修不值得做，会记一条 `邻域精修跳过（区域过大）` 并保留粗矩形。

  Canny 双阈值默认 `{ low: 20, high: 60 }`，浅色低对比的界面（灰底白卡）检不出来就往下调，壁纸噪声太多就往上调：

  ```js
  const screenshots = new Screenshots({
    detectEdges: true,
    edgeThresholds: { low: 10, high: 30 },
  });
  ```

  **它绕不过系统权限**：macOS 未授予屏幕录制时，截图像素本身就只有壁纸和菜单栏（其他应用的内容连画面都被系统抹掉了），像素识别能检出的只是壁纸碎块。所以这个选项是给"窗口数据不够细"或"平台拿不到窗口几何"（Wayland）的场合补元素级拾取用的。渲染端要把 `edges` 传给 `<Screenshots>`，见 `@qs-coder/react-screenshots` 的文档。

- 截图期间，截图窗口和所有遮罩都用 `screen-saver` 置顶层级，并有一个 400ms 的**置顶守卫**周期性把它们抬回最上面（截图窗口最后抬，保证它在遮罩之上）。失焦或被最小化时也立刻抬回并抢回焦点。保存对话框期间守卫会豁免——对话框挂在截图窗口上，压在最上面会把用户要点的那颗按钮盖住。

  这从"只有 Windows"扩展到了**所有平台**。Windows 上是因为任务栏自身是 topmost 窗口，`setAlwaysOnTop(true)` 默认的 `floating` 层级排在任务栏**之下**，点一下任务栏截图界面就会沉底，加上 `skipTaskbar` 之后没有任何入口可以点回来，看起来像"截图丢了"。macOS 上 `floating` 同样压不住各种常驻浮层（录屏指示器、输入法候选框、各种 HUD），被盖住时用户看到的是一半截图、一半别人的界面。注意 `Win+D`、`Alt+Tab` 这类系统快捷键无法拦截，只能在失焦后抢回焦点。

- **点击到"画面锁住"的响应速度**：`startCapture` 按"先锁屏、再补数据"排列，顺序是 `capture(活动屏) ‖ 建窗口` → 建齐每块屏的遮罩（全透明，点击当场被吃掉）→ 截图窗口以 opacity 0 `show()` → 并行开始其他屏的预截（每块抓完像素就压暗那一块）→ 等渲染端画完这一帧 → opacity 1 亮出来。窗口枚举、元素识别都排在显示之后，所以从点击到画面静止的时间约等于 `captureImage + toPng`。

  截图窗口**先显示但完全透明**，而不是"等画完再 show"，也不是"先 show 再等图"：隐藏窗口里 rAF 不跑、解码也慢得离谱（实测首次解码要 1 秒以上、经常等不到），等回执再 show 只会让窗口更晚出现；可反过来先 show 又会让透明窗口把桌面直接透出来，图到了"啪"地换上去——开局这一下闪烁就是这么来的。所以取中间：先显示（渲染进程才会正常出帧）但看不见，画好了再亮出来，用户看到的第一帧就是完整的截图。渲染端万一卡住，等回执有超时兜底，且**兜底放行时也会把窗口亮出来**，不会留下一个看不见又点不掉的东西。

  底图的 IPC 载荷是 **PNG 字节**（不是 base64 dataURL，省一次编码、一次解码和一个几 MB 字符串穿过 IPC），渲染端用 `URL.createObjectURL(new Blob([png], { type: 'image/png' }))` 拿到 URL，并把**解码好的图片元素按 `display.id` 缓存**，在换屏/结束/unmount 时 `revokeObjectURL`。换屏时最贵的一步是解码一张全屏 PNG（实测首次 1.1s、之后 60~90ms），所以开场就把其他屏的底图通过 `SCREENSHOTS:preload` 推给渲染端**只解码、不上屏**，换过去只剩"把已解码的元素换上去"一步；解码完渲染端回一条 `SCREENSHOTS:preloaded`，主进程据此知道这块屏不用再传 PNG（此时 `SCREENSHOTS:capture` 的第二个参数会是 `undefined`）。换屏还要等渲染端回一条 `SCREENSHOTS:painted` 才搬窗口，否则窗口落地的头几帧是空/旧内容，同样是一次闪烁。

  **自带渲染层的宿主注意（0.8.2 起的新破坏性变更）**：`on('capture')` 的第二个参数可能为 `undefined`，含义是"这块屏你已经有缓存了，别再传一遍 PNG"——收到 `undefined` 又拿不到缓存时，渲染层必须保留当前画面而不是清空。同时需要实现 `on('preload')`（解码不上屏）以及 `painted()` / `preloaded(displayId)` 两条渲染端到主进程的回执；不实现的话功能仍可用，但每次显示和换屏都会等满 2.5s 的绘制超时，响应会明显变慢。随包分发的 `@qs-coder/react-screenshots/dist/electron.html` 已经实现整套协议，两个包**必须一起升级到同一版本**。

- 排查截图响应慢，可以用 `DEBUG=electron-screenshots` 启动应用，`startCapture` / `capture` / `reset` / `createWindow` 会分段输出耗时：

```
startCapture isReady +0ms (total 1ms)
SCREENSHOTS:capture 耗时 import 1ms fromPoint 0ms captureImage 96ms toPng 118ms png 3421KB
createWindow 耗时 21ms (含 reset)
startCapture capture + createWindow +236ms (total 237ms)
startCapture show +4ms (total 241ms)
预截屏幕 2 完成 2893KB
等待渲染端绘制 68ms
startCapture send capture +71ms (total 312ms)
窗口枚举 41 个（已剔除最小化）
窗口坐标换算原始 … display … scale 1（重新枚举）
窗口识别 37 条 18ms（1 号屏）
元素检测 128 条 340ms（1 号屏）
窗口识别 37 条 2ms（2 号屏）
邻域精修 4 条 22ms 粗矩形 { x: 60, y: 50, width: 261, height: 151 } → { x: 60, y: 50, width: 260, height: 150 }
换屏 → 2 2560x1440 耗时 12ms
```

  看两行就够了：`startCapture show` 那行的 total 就是"遮罩立起来、点击被吃掉"的时刻，再加上 `等待渲染端绘制` 才是"用户看见画面锁住"的时刻（首次解码会明显偏大，`singleWindow: true` 复用同一个窗口能省掉大半）。`换屏 → …` 那行正常应该在几十毫秒内；如果它接近 2500ms，说明渲染端的 `painted` 回执没回来、走了绘制超时兜底。`窗口坐标换算原始 …（复用缓存）` 表示这批矩形是开场那次枚举的投影结果、换屏没有重查窗口，`（重新枚举）` 只应该在一轮截图里出现一次。

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
