import type { Api } from '../wails-api'

declare global {
  /** 构建期由 vite define 注入的平台标识（win32 / darwin / linux） */
  const __PLATFORM__: string

  interface Window {
    api: Api
    /** Wails v2 注入的 Go 绑定入口；Go 侧只暴露 app.Bridge.Invoke(channel, args) */
    go: {
      app: {
        Bridge: {
          Invoke(channel: string, args: unknown[]): Promise<unknown>
        }
      }
    }
    /** Wails v2 注入的事件运行时 */
    runtime: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      EventsOn(eventName: string, callback: (...data: any[]) => void): () => void
    }
  }
}

export {}
