/**
 * 「冻结画面」窗口（每块屏一个）的 preload。
 *
 * 这个窗口只干一件事：把**这一轮截图**里这块屏的画面钉在屏幕上。
 * 换屏时交互窗口要换图、要搬位置、要改尺寸，这些动作本身都会露出中间态；
 * 只要底下始终有一张一模一样的画面顶着，用户就什么都看不出来。
 *
 * 主进程推两个状态，顺序不能反：
 * - `freeze-veil`：压暗层。截图像素一抓到手就打开（压暗立刻生效，
 *   编码慢的那几百毫秒里屏幕不会"亮着等"）。它的 alpha 必须和渲染端
 *   `.screenshots-background-mask` 一致，否则换屏时两块屏亮度会跳一下。
 * - `freeze-image`：截图 PNG。**解码完成才显示**，于是"纯色压暗"换成
 *   "压暗后的截图"发生在同一帧里，看起来完全等价。
 */
import { ipcRenderer } from 'electron';

let shot: HTMLImageElement | null = null;
let veil: HTMLElement | null = null;
let objectUrl: string | null = null;

const mount = () => {
  shot = document.getElementById('shot') as HTMLImageElement | null;
  veil = document.getElementById('veil');
};

ipcRenderer.on('SCREENSHOTS:freeze-veil', (_event, on: boolean) => {
  if (!veil) {
    mount();
  }
  veil?.classList.toggle('on', !!on);
});

ipcRenderer.on(
  'SCREENSHOTS:freeze-image',
  (_event, buffer: Uint8Array<ArrayBuffer>) => {
    if (!shot) {
      mount();
    }
    const $shot = shot;
    if (!$shot) {
      return;
    }
    const url = URL.createObjectURL(new Blob([buffer], { type: 'image/png' }));
    // 换下来的旧 objectURL 要等新图**真的显示出来**再放：先放会露出空白帧
    const prev = objectUrl;
    objectUrl = url;
    $shot.src = url;
    $shot.decode().then(
      () => {
        $shot.style.opacity = '1';
        if (prev) {
          URL.revokeObjectURL(prev);
        }
      },
      () => {
        // 解码失败就保持"只有压暗"的样子：宁可少一张图，也不要露出破图
        URL.revokeObjectURL(url);
      },
    );
  },
);

/**
 * 光标进到这块屏：立刻催主进程换屏。
 *
 * 不催的话要等 100ms 的轮询，这段时间里光标是 not-allowed（这块屏的窗口在最上面），
 * 换过去才变回十字/移动 —— 来回划屏就是一路"箭头闪一下"。
 * 换屏之后交互窗口盖上来，这里就再也收不到 pointermove 了，所以不必额外去重。
 */
let lastNudge = 0;
window.addEventListener(
  'pointermove',
  () => {
    const now = Date.now();
    if (now - lastNudge < 100) {
      return;
    }
    lastNudge = now;
    ipcRenderer.send('SCREENSHOTS:freeze-enter');
  },
  { passive: true },
);
