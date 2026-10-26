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
  const [width, setWidth] = useState(window.innerWidth);
  const [height, setHeight] = useState(window.innerHeight);
  const [display, setDisplay] = useState<Display | undefined>(undefined);
  const [lang, setLang] = useState<Lang | undefined>(undefined);
  const [windows, setWindows] = useState<Bounds[]>([]);
  const [edges, setEdges] = useState<Bounds[]>([]);
  // 截图底图的 objectURL，换屏和结束时都要 revoke，否则每张 3MB 的 PNG 一直挂在内存里
  const objectUrlRef = useRef<string | null>(null);

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
    window.screenshots.start()
  }, [])

  const onStop = useCallback(() => {
    window.screenshots.stop()
  }, [])

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

    // 主进程发来的是 Buffer，过 IPC 到渲染端是 Uint8Array（ArrayBuffer  backing）
    const onCapture = (display: Display, png: Uint8Array<ArrayBuffer>) => {
      setDisplay(display);
      // 元素与窗口识别都是异步的，先清掉上一张图的结果，免得矩形贴在新图上
      setEdges([]);
      setWindows([]);
      // 主进程直接给 PNG 字节，不再走 base64 dataURL：省一次编码、一次解码，
      // 以及一个几 MB 字符串穿过 IPC
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
      }
      const next = URL.createObjectURL(new Blob([png], { type: 'image/png' }));
      objectUrlRef.current = next;
      setUrl(next);
    };

    const onWindows = (windowBounds: Bounds[] = []) => {
      setWindows(windowBounds);
    };

    const onEdges = (edgeBounds: Bounds[] = []) => {
      setEdges(edgeBounds);
    };

    const onReset = () => {
      setUrl(undefined);
      setDisplay(undefined);
      setWindows([]);
      setEdges([]);
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
      // 确保截图区域被重置
      requestAnimationFrame(() => window.screenshots.reset());
    };

    window.screenshots.on('setLang', onSetLang);
    window.screenshots.on('capture', onCapture);
    window.screenshots.on('windows', onWindows);
    window.screenshots.on('edges', onEdges);
    window.screenshots.on('reset', onReset);
    // 告诉主进程页面准备完成
    window.screenshots.ready();
    return () => {
      window.screenshots.off('capture', onCapture);
      window.screenshots.off('windows', onWindows);
      window.screenshots.off('edges', onEdges);
      window.screenshots.off('setLang', onSetLang);
      window.screenshots.off('reset', onReset);
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
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
