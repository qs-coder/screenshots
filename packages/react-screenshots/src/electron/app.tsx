import type { ReactElement } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import Screenshots from '../Screenshots';
import type { Bounds } from '../Screenshots/types';
import type { Lang } from '../Screenshots/zh_CN';
import './app.less';

export interface Display {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export default function App(): ReactElement {
  const [url, setUrl] = useState<string | undefined>(undefined);
  // 和 url 成对提交的**已解码**图片元素：Screenshots 直接拿它当底图，
  // 省掉一次重新加载 + 解码，也就没有"图还没到"的空窗期
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [width, setWidth] = useState(window.innerWidth);
  const [height, setHeight] = useState(window.innerHeight);
  const [display, setDisplay] = useState<Display | undefined>(undefined);
  const [lang, setLang] = useState<Lang | undefined>(undefined);
  const [windows, setWindows] = useState<Bounds[]>([]);
  const [edges, setEdges] = useState<Bounds[]>([]);
  /**
   * 每块屏的已解码底图。
   *
   * 来回换屏时最贵的一步是"解码一张全屏 PNG"（实测首次 1.1s、之后 60~90ms）。
   * 同一块屏这一轮已经解过了，再切回来就只是把元素换上去 —— 换屏几乎瞬时，
   * 光标来回划也就不会出现"窗口追不上光标"的滞后感。
   * 生命周期跟着一轮截图走，`reset` 时整批释放。
   */
  const decodedRef = useRef(
    new Map<number, { element: HTMLImageElement; url: string }>(),
  );

  const onSave = useCallback(
    async (blob: Blob | null, bounds: Bounds) => {
      if (!display || !blob) {
        return;
      }
      window.screenshots.save(await blob.arrayBuffer(), { bounds, display });
    },
    [display],
  );

  const onCancel = useCallback(() => {
    window.screenshots.cancel();
  }, []);

  const onStart = useCallback(() => {
    window.screenshots.start();
  }, []);

  const onStop = useCallback(() => {
    window.screenshots.stop();
  }, []);

  const onOk = useCallback(
    async (blob: Blob | null, bounds: Bounds) => {
      if (!display || !blob) {
        return;
      }
      window.screenshots.ok(await blob.arrayBuffer(), { bounds, display });
    },
    [display],
  );

  useEffect(() => {
    const onSetLang = (lang: Lang) => {
      setLang(lang);
    };

    /**
     * 主进程发来的是 Buffer，过 IPC 到渲染端是 Uint8Array（ArrayBuffer backing）。
     *
     * 这里是整个换屏不闪的关键：
     * 1. **先解码再提交**——解码期间窗口里还是上一张图（主进程也还没搬窗口），
     *    所以任何时候都不会出现"底图没了"的空白帧；
     * 2. 尺寸直接取 display，不依赖 resize 事件，窗口搬过去时布局已经是目标尺寸；
     * 3. 提交后等两帧再回执，主进程拿到回执才搬窗口，搬过去的第一帧就是新画面。
     */
    const commit = (
      display: Display,
      element: HTMLImageElement,
      url: string,
    ) => {
      setDisplay(display);
      setWidth(display.width);
      setHeight(display.height);
      setImage(element);
      setUrl(url);
      // 元素与窗口识别都是异步的，先清掉上一张图的结果，免得矩形贴在新图上
      setEdges([]);
      setWindows([]);
      // 告诉主进程：这块屏的底图已经在缓存里了，下次换回来别再传 PNG
      window.screenshots.preloaded?.(display.id);

      // 等这一帧真的画出来再回执；窗口隐藏时 rAF 会被节流，所以留一个定时器兜底。
      // 两条路都会到，只认第一条：多回执一次会把下一次换屏的等待提前解开
      let acked = false;
      const painted = () => {
        if (acked) {
          return;
        }
        acked = true;
        window.screenshots.painted?.();
      };
      if (document.visibilityState === 'hidden') {
        // 窗口还没显示：第一帧要等 show 才会生成，而且一定包含刚提交的这张图，
        // 这时候再等 rAF 只是白等（隐藏窗口的 rAF 根本不会触发）
        painted();
      } else {
        requestAnimationFrame(() => requestAnimationFrame(painted));
        setTimeout(painted, 80);
      }
    };

    const onCapture = (display: Display, png?: Uint8Array<ArrayBuffer>) => {
      const cached = decodedRef.current.get(display.id);
      if (cached) {
        // 这块屏这一轮已经解过了（开场预载的）：直接换元素，连 objectURL 都不用重建
        commit(display, cached.element, cached.url);
        return;
      }
      if (!png) {
        // 主进程以为这里已经有缓存，结果没有 —— 只能等下一次完整下发
        return;
      }

      const url = URL.createObjectURL(new Blob([png], { type: 'image/png' }));
      const element = new Image();
      element.src = url;
      const done = () => {
        decodedRef.current.set(display.id, { element, url });
        commit(display, element, url);
      };
      // decode 失败（损坏的 PNG）也要提交，让 <img> 自己走错误路径，不能把换屏卡死
      element.decode().then(done, done);
    };

    /**
     * 开场就把其他屏幕的底图解码好存着（只解码，不上屏）。
     *
     * 这样换屏时只剩"把元素换上去"一步，不会再有"解码 400ms 里窗口追不上光标"。
     * 一次性把整轮截图要用的图都准备好，也符合"发起截图就固定下来"的预期。
     */
    const onPreload = (display: Display, png: Uint8Array<ArrayBuffer>) => {
      if (decodedRef.current.has(display.id)) {
        window.screenshots.preloaded?.(display.id);
        return;
      }
      const url = URL.createObjectURL(new Blob([png], { type: 'image/png' }));
      const element = new Image();
      element.src = url;
      const done = () => {
        if (decodedRef.current.has(display.id)) {
          URL.revokeObjectURL(url);
        } else {
          decodedRef.current.set(display.id, { element, url });
        }
        window.screenshots.preloaded?.(display.id);
      };
      element.decode().then(done, done);
    };

    const onWindows = (windowBounds: Bounds[] = []) => {
      setWindows(windowBounds);
    };

    const onEdges = (edgeBounds: Bounds[] = []) => {
      setEdges(edgeBounds);
    };

    const onReset = () => {
      setUrl(undefined);
      setImage(null);
      setDisplay(undefined);
      setWindows([]);
      setEdges([]);
      // 一轮截图结束，把整批已解码底图连同 objectURL 一起放掉
      for (const { url } of decodedRef.current.values()) {
        URL.revokeObjectURL(url);
      }
      decodedRef.current.clear();
      // 确保截图区域被重置。不能用 rAF：截图窗口是隐藏的（paintWhenInitiallyHidden: false），
      // 隐藏窗口里 rAF 不跑，主进程只能等到超时，开局白等 500ms
      setTimeout(() => window.screenshots.reset(), 0);
    };

    window.screenshots.on('setLang', onSetLang);
    window.screenshots.on('capture', onCapture);
    window.screenshots.on('preload', onPreload);
    window.screenshots.on('windows', onWindows);
    window.screenshots.on('edges', onEdges);
    window.screenshots.on('reset', onReset);
    // 告诉主进程页面准备完成
    window.screenshots.ready();
    return () => {
      window.screenshots.off('capture', onCapture);
      window.screenshots.off('preload', onPreload);
      window.screenshots.off('windows', onWindows);
      window.screenshots.off('edges', onEdges);
      window.screenshots.off('setLang', onSetLang);
      window.screenshots.off('reset', onReset);
      for (const { url } of decodedRef.current.values()) {
        URL.revokeObjectURL(url);
      }
      decodedRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const onResize = () => {
      setWidth(window.innerWidth);
      setHeight(window.innerHeight);
    };

    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
    };
  }, []);

  return (
    <div className="body">
      <Screenshots
        url={url}
        imageElement={image}
        width={width}
        height={height}
        windows={windows}
        edges={edges}
        lang={lang}
        onSave={onSave}
        onCancel={onCancel}
        onOk={onOk}
        onStart={onStart}
        onStop={onStop}
      />
    </div>
  );
}
