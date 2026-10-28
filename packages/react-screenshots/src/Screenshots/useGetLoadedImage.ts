import { useEffect, useState } from 'react';

/**
 * 底图元素。
 *
 * `preloaded` 是调用方**已经解码好**的元素（Electron 那边和 url 成对提交）：
 * 有它就直接用，绝不再走"先置空、等 onload"的老路 —— 那中间的一帧没有底图，
 * 透明窗口会把桌面透出来，换屏时看着就是闪一下。
 */
export default function useGetLoadedImage(
  url?: string,
  preloaded?: HTMLImageElement | null,
): HTMLImageElement | null {
  const [image, setImage] = useState<HTMLImageElement | null>(
    preloaded ?? null,
  );

  useEffect(() => {
    if (preloaded) {
      setImage(preloaded);
      return;
    }

    // 先置空图片
    setImage(null);
    if (url == null) {
      return;
    }

    const $image = document.createElement('img');

    const onLoad = () => setImage($image);
    const onError = () => setImage(null);

    $image.addEventListener('load', onLoad);
    $image.addEventListener('error', onError);
    $image.src = url;

    return () => {
      $image.removeEventListener('load', onLoad);
      $image.removeEventListener('error', onError);
    };
  }, [url, preloaded]);

  return image;
}
