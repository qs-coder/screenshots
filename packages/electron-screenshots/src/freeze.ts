/**
 * 「冻结画面」窗口的页面模板。
 *
 * 单独放在这里是为了让它能被直接读出来验证（页面里的两个开关决定了换屏稳不稳，
 * 肉眼验证需要多屏，成本太高）。
 *
 * 页面只有两样东西：一张截图、一层压暗。
 * - 压暗层初始 `display: none`，靠 `on` 类打开；
 * - 截图初始 `opacity: 0`，解码完才显示。
 * 两者都是同一层 DOM 上的开关，所以"只有压暗" → "压暗后的截图"是同一次变更，
 * 亮度不变、内容就是抓那一刻的屏幕，用户看不出中间有过替换。
 *
 * `cursor: not-allowed` 表示这块屏此刻不接受操作（操作都归交互窗口），
 * 光标进来时 `freezePreload` 会立刻催主进程把交互窗口搬过来。
 */

/**
 * 压暗层的不透明度。
 *
 * **必须**和渲染端 `.screenshots-background-mask` 的 `rgba(0,0,0,.3)` 完全相同：
 * 活动屏的画面来自截图窗口（图片 + 这一层压暗），非活动屏来自冻结画面窗口
 * （同一张图片 + 同一层压暗）。两边一旦不等，换屏就是"两块屏同时变亮/变暗"。
 */
export const MASK_ALPHA = 0.3;

export const FREEZE_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{position:fixed;top:0;right:0;bottom:0;left:0;margin:0;overflow:hidden;background:transparent;cursor:not-allowed}#shot{position:absolute;top:0;left:0;width:100%;height:100%;display:block;border:none;outline:none;opacity:0;image-rendering:-webkit-optimize-contrast;image-rendering:crisp-edges}#veil{position:absolute;top:0;right:0;bottom:0;left:0;display:none;background-color:rgba(0,0,0,${MASK_ALPHA})}#veil.on{display:block}</style></head><body><img id="shot"><div id="veil"></div></body></html>`;
