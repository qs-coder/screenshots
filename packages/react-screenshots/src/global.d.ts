import { Display } from './electron/app'
import { Bounds } from './Screenshots/types'

type ScreenshotsListener = (...args: never[]) => void

interface ScreenshotsData {
  bounds: Bounds
  display: Display
}

interface GlobalScreenshots {
  start: () => void
  stop: () => void
  ready: () => void
  reset: () => void
  save: (arrayBuffer: ArrayBuffer, data: ScreenshotsData) => void
  cancel: () => void
  ok: (arrayBuffer: ArrayBuffer, data: ScreenshotsData) => void
  on: (channel: string, fn: ScreenshotsListener) => void
  off: (channel: string, fn: ScreenshotsListener) => void
}

declare global {
  interface Window {
    screenshots: GlobalScreenshots
  }
}
