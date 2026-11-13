import { create } from 'zustand'
import { useAppStore } from './useAppStore'

export type WebInstallKind = 'nginx' | 'caddy'
type InstallKind = 'docker' | WebInstallKind | 'browser'

type InstallTask = {
  sessionId: string
  kind: InstallKind
  status: 'running' | 'success' | 'error' | 'paused'
  log: string[]
  /** 最后一行是回车符刷出来的进度，下一次回车覆盖它 */
  lineOpen?: boolean
  error?: string
}

/** 以 \r 开头的行覆盖当前进度，普通行另起一行。进度行在换行时收成普通行。 */
export function applyProgressLine(log: string[], open: boolean, line: string): { log: string[]; open: boolean } {
  const replace = line.startsWith('\r')
  const text = (replace ? line.slice(1) : line).trimEnd()
  const cap = (items: string[]) => (items.length > 200 ? items.slice(-200) : items)
  if (replace) {
    if (!text) return open && log.length > 0 ? { log: log.slice(0, -1), open: false } : { log, open }
    if (open && log.length > 0) return { log: [...log.slice(0, -1), text], open: true }
    return { log: cap([...log, text]), open: true }
  }
  if (!text) return { log, open }
  if (open && log.length > 0) return { log: cap([...log.slice(0, -1), text]), open: false }
  return { log: cap([...log, text]), open: false }
}

type InstallState = {
  tasks: Record<string, InstallTask>
  startDocker: (sessionId: string, mirrors: string[]) => void
  startWeb: (sessionId: string, kind: WebInstallKind) => void
  startBrowser: (sessionId: string) => void
  pauseBrowser: (sessionId: string) => Promise<void>
  clearBrowserCache: (sessionId: string) => Promise<void>
}

export const dockerInstallKey = (sessionId: string) => `${sessionId}:docker`
export const webInstallKey = (sessionId: string, kind: WebInstallKind) => `${sessionId}:${kind}`
export const browserInstallKey = (sessionId: string) => `${sessionId}:browser`

export const useInstallStore = create<InstallState>((set, get) => ({
  tasks: {},

  startDocker: (sessionId, mirrors) => {
    const key = dockerInstallKey(sessionId)
    if (get().tasks[key]?.status === 'running') return
    set((state) => ({
      tasks: { ...state.tasks, [key]: { sessionId, kind: 'docker', status: 'running', log: [] } }
    }))
    const app = useAppStore.getState()
    app.setNotice('正在安装 Docker（按源顺序尝试），装系统包要等一会…', true)
    const unsubscribe = window.api.sessions.onDockerInstallProgress(sessionId, (line) => {
      set((state) => {
        const task = state.tasks[key]
        if (!task) return state
        const next = applyProgressLine(task.log, !!task.lineOpen, line)
        return { tasks: { ...state.tasks, [key]: { ...task, log: next.log, lineOpen: next.open } } }
      })
    })
    void (async () => {
      try {
        await window.api.sessions.dockerInstall(sessionId, mirrors)
        set((state) => ({
          tasks: { ...state.tasks, [key]: { ...state.tasks[key]!, status: 'success' } }
        }))
        app.setNotice('Docker 安装完成')
        app.loadDockerInfo(sessionId, true)
        app.loadWebInfo(sessionId, true)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        set((state) => ({
          tasks: { ...state.tasks, [key]: { ...state.tasks[key]!, status: 'error', error: message } }
        }))
        app.setNotice(message)
      } finally {
        unsubscribe()
      }
    })()
  },

  startWeb: (sessionId, kind) => {
    const key = webInstallKey(sessionId, kind)
    if (get().tasks[key]?.status === 'running') return
    set((state) => ({
      tasks: { ...state.tasks, [key]: { sessionId, kind, status: 'running', log: [] } }
    }))
    const app = useAppStore.getState()
    app.setNotice(`正在拉取 ${kind}:alpine 并启动容器，镜像要下载一会…`, true)
    const unsubscribe = window.api.sessions.onWebInstallProgress(sessionId, (line) => {
      set((state) => {
        const task = state.tasks[key]
        if (!task) return state
        const next = applyProgressLine(task.log, !!task.lineOpen, line)
        return { tasks: { ...state.tasks, [key]: { ...task, log: next.log, lineOpen: next.open } } }
      })
    })
    void (async () => {
      try {
        await window.api.sessions.webInstall(sessionId, kind)
        set((state) => ({
          tasks: { ...state.tasks, [key]: { ...state.tasks[key]!, status: 'success' } }
        }))
        app.setNotice(`${kind} 容器已启动，配置在 ~/.termpilot/${kind}/ 下`)
        app.loadWebInfo(sessionId, true)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        set((state) => ({
          tasks: { ...state.tasks, [key]: { ...state.tasks[key]!, status: 'error', error: message } }
        }))
        app.setNotice(message)
      } finally {
        unsubscribe()
      }
    })()
  },

  startBrowser: (sessionId) => {
    const key = browserInstallKey(sessionId)
    if (get().tasks[key]?.status === 'running') return
    set((state) => ({
      tasks: { ...state.tasks, [key]: { sessionId, kind: 'browser', status: 'running', log: [] } }
    }))
    const app = useAppStore.getState()
    app.setNotice('正在安装云浏览器…', true)
    const unsubscribe = window.api.sessions.onBrowserInstallProgress(sessionId, (line) => {
      set((state) => {
        const task = state.tasks[key]
        if (!task) return state
        const next = applyProgressLine(task.log, !!task.lineOpen, line)
        return { tasks: { ...state.tasks, [key]: { ...task, log: next.log, lineOpen: next.open } } }
      })
    })
    void (async () => {
      try {
        await window.api.sessions.browserInstall(sessionId)
        set((state) => ({
          tasks: { ...state.tasks, [key]: { ...state.tasks[key]!, status: 'success' } }
        }))
        app.setNotice('云浏览器已启动')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message === '已暂停') {
          set((state) => {
            const task = state.tasks[key]
            if (!task) return state
            const next = applyProgressLine(task.log, false, '已暂停')
            return {
              tasks: { ...state.tasks, [key]: { ...task, status: 'paused', log: next.log, lineOpen: false } }
            }
          })
          app.setNotice('已暂停')
          return
        }
        set((state) => {
          const task = state.tasks[key]
          if (!task) return state
          const next = applyProgressLine(task.log, false, message)
          return {
            tasks: { ...state.tasks, [key]: { ...task, status: 'error', error: message, log: next.log, lineOpen: false } }
          }
        })
        app.setNotice(message)
      } finally {
        unsubscribe()
      }
    })()
  },

  pauseBrowser: (sessionId) => {
    const key = browserInstallKey(sessionId)
    if (get().tasks[key]?.status !== 'running') return Promise.resolve()
    return window.api.sessions.browserPause(sessionId).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      if (message === '没有正在进行的下载') return
      useAppStore.getState().setNotice(message)
    })
  },

  clearBrowserCache: async (sessionId) => {
    const key = browserInstallKey(sessionId)
    if (get().tasks[key]?.status === 'running') return
    const app = useAppStore.getState()
    try {
      await window.api.sessions.browserClearCache(sessionId)
      set((state) => ({
        tasks: {
          ...state.tasks,
          [key]: { sessionId, kind: 'browser', status: 'paused', log: ['已清空未完成的下载'] }
        }
      }))
      app.setNotice('已清空未完成的下载')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      app.setNotice(message)
    }
  }
}))
