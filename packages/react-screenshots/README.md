# react-screenshots

> a screenshot cropper tool by react

## Install

[![NPM](https://nodei.co/npm/react-screenshots.png?downloads=true&downloadRank=true&stars=true)](https://nodei.co/npm/react-screenshots/)

## Usage

1. web 中使用

```ts
import React, { ReactElement, useCallback } from "react";
import Screenshots, { Bounds } from "react-screenshots";
import url from "./image.jpg";

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export default function App(): ReactElement {
  const onSave = useCallback((blob: Blob, bounds: Bounds) => {
    console.log("save", blob, bounds);
    console.log(URL.createObjectURL(blob));
  }, []);
  const onCancel = useCallback(() => {
    console.log("cancel");
  }, []);
  const onOk = useCallback((blob: Blob, bounds: Bounds) => {
    console.log("ok", blob, bounds);
    console.log(URL.createObjectURL(blob));
  }, []);

  return (
    <Screenshots
      url={url}
      width={window.innerWidth}
      height={window.innerHeight}
      lang={{
        operation_undo_title: "Undo",
        operation_mosaic_title: "Mosaic",
        operation_text_title: "Text",
        operation_brush_title: "Brush",
        operation_arrow_title: "Arrow",
        operation_ellipse_title: "Ellipse",
        operation_rectangle_title: "Rectangle",
      }}
      onSave={onSave}
      onCancel={onCancel}
      onOk={onOk}
    />
  );
}
```

2. electron 中使用

- electron 中使用可直接加载渲染进程的页面，页面路径为`require.resolve('react-screenshots/electron/electron.html')`，不推荐自己手动开发主进程，推荐直接使用`electron-screenshots`模块

```ts
interface ScreenshotsData {
  bounds: Bounds
  display: Display
}

interface GlobalScreenshots {
  ready: () => void
  reset: () => void
  save: (arrayBuffer: ArrayBuffer, data: ScreenshotsData) => void
  cancel: () => void
  ok: (arrayBuffer: ArrayBuffer, data: ScreenshotsData) => void
  on: (channel: string, fn: ScreenshotsListener) => void
  off: (channel: string, fn: ScreenshotsListener) => void
}

// 需要在electron的preload中提前初始化这个对象，用于渲染进程与主进程通信
window.screenshots: GlobalScreenshots
```

## Props

```ts
interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Lang {
  magnifier_position_label: string;
  operation_ok_title: string;
  operation_cancel_title: string;
  operation_save_title: string;
  operation_redo_title: string;
  operation_undo_title: string;
  operation_mosaic_title: string;
  operation_text_title: string;
  operation_brush_title: string;
  operation_arrow_title: string;
  operation_ellipse_title: string;
  operation_rectangle_title: string;
}
```

| 名称          | 说明                 | 类型                                   | 是否必选 |
| ------------- | -------------------- | -------------------------------------- | -------- |
| url           | 要编辑的图像资源地址 | `string`                               | 是       |
| imageElement  | 与 `url` 成对传入的**已解码**底图元素；传了就直接用它，不再走"置空等 onload" | `HTMLImageElement \| null`             | 否       |
| width         | 画布宽度             | `number`                               | 是       |
| height        | 画布宽度             | `number`                               | 是       |
| lang     | 多语言支持，默认中文 | `Partial<Lang>`                        | 否       |
| onSave   | 保存按钮回调         | `(blob: Blob, bounds: Bounds) => void` | 否       |
| onCancel | 取消按钮回调         | `() => void`                           | 否       |
| onOk     | 取消按钮回调         | `(blob: Blob, bounds: Bounds) => void` | 否       |
| windows  | 窗口识别与锁边数据   | `Bounds[]`                             | 否       |
| edges    | 元素识别数据（拾取时窗口优先，只在 `windows` 为空时参与吸附） | `Bounds[]`           | 否       |

### 窗口识别与锁边

传入 `windows`（当前屏幕上其他应用的窗口矩形，坐标系为画布内相对坐标，且必须按 z 轴从上到下排序）后会启用两套微信/Snipaste 式交互：

- 未框选时，鼠标悬停会标记光标所在的窗口，单击即整窗选中；按下并拖动仍然是自由框选。被标记的窗口内部透出与遮罩下同尺寸的画面（看起来就是"已经框选好"的样子），只有 `#39f` 的 2px 边框，没有着色填充。
- 框选与拖拽 8 个手柄调整大小时，边会在 6px 内吸附到窗口边和画布边；整体移动选区时按"选区的边对齐窗口的边"平移，而不是按鼠标抓取点对齐。
- 按住 `Alt`/`⌥` 期间禁用吸附，作为需要精确到像素时的逃生口。
- 不传或传空数组时，上述两项都不生效（只剩画布边），交互与之前完全一致。

### 元素识别与自动框选

`edges` 是元素级矩形：`@qs-coder/electron-screenshots` 在 `detectEdges: true` 时用截图像素识别出的界面元素（按钮、卡片、输入框等），坐标系与 `windows` 一致，两个 prop 同时传。两者都是**截图画面锁住之后**才陆续到达的（窗口枚举走 `on('windows')`，元素识别走 `on('edges')`）。内置的 electron 渲染层已经接好这套协议，并且会**按 `display.id` 缓存每块屏解码好的底图**：`on('capture')` 的 PNG 字节可能为 `undefined`，含义是"这块屏你已经有缓存了"；换屏时只换已解码的图片元素，等这一帧真的画完再回 `painted()`，主进程才搬窗口。自带渲染层的宿主若不复现这套回执，每次显示和换屏都会等满 2.5s 的绘制超时，详见 `@qs-coder/electron-screenshots` 的 IPC 说明。

- hover 与单击的拾取规则是**窗口优先**：光标只要落在某个窗口矩形里，就直接选那个窗口（取 z 序最靠上的），完全不会再和元素矩形比面积——像素法只能看到窗口"露出来的那部分"，被别的窗口压住下边界时它检出的是半截矩形，让半截赢整窗是不对的。光标不在任何窗口里时（桌面控件、Wayland 这类拿不到窗口几何的场合），才在包含光标的元素矩形里取面积最小的那个。边界口径分两套：**窗口的四条边算窗口自己**（那 1px 视觉上就是这个窗口的；若不算，光标压在窗口边框上时窗口不命中、元素矩形趁虚而入，表现就是窗口边缘冒碎框；右/下不取等，避免和相邻窗口抢同一列像素），元素的两层（邻域精修 / 整屏候选）共用另一条：四条边本身不算内部，两层之间必须一致，否则同一像素上口径不一，hover 会抖。
- 元素矩形的**贴边精修**是按需二次请求的：整屏那一遍为压耗时降过采样，边会系统性偏 1~3 DIP。hover 到窗口之外的元素矩形时，渲染端通过 `window.screenshots.edgeRegion(rect)` 把粗矩形发给主进程，主进程按原生分辨率重检后回 `edges-precise`，渲染端把高亮和单击结果换成那份贴准的矩形（同一个粗矩形只问一次，结果回来时校验请求标识和光标位置，走远了就丢掉）。宿主用内置的 `<Screenshots>` 即可，不需要自己接这两个通道；`edgeRegion` 是可选方法，老版本主进程没有它时行为退化成只用粗矩形。
- 拖框与 resize 的吸附只认 `windows` 的边：元素边太碎，靠过去会把选区带偏。`windows` 为空（平台或权限拿不到窗口几何）时才由 `edges` 顶上，阈值不变。
- 识别结果是异步的：截图窗口先显示，识别完成后才补齐，所以刚进入截图的那一瞬间可能只有窗口边可吸附。
- `edges` 只有在 `windows` 为空时才进吸附候选；拾取则始终窗口优先，光标不在任何窗口里时才落到元素。不传或传空数组时，行为与不启用元素识别（0.7.0）完全一致。

### example

```js
import React from "react";

function App() {
  return (
    <Screenshot
      url="./example.png"
      width={window.innerWidth}
      height={window.innerHeight}
      onSave={() => {}}
      onCancel={() => {}}
      onOk={() => {}}
    />
  );
}
```

## Screenshot

![screenshot](../../screenshot.jpg)

## Icons

[Iconfont](https://at.alicdn.com/t/project/572327/6f652e79-fb8b-4164-9fb3-40a705433d93.html?spm=a313x.7781069.1998910419.34)
