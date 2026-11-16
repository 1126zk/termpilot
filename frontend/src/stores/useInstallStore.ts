import { create } from 'zustand'
import { useAppStore } from './useAppStore'

export type WebInstallKind = 'nginx' | 'caddy'
type InstallKind = 'docker' | WebInstallKind

type InstallTask = {
  sessionId: string
  kind: InstallKind
  status: 'running' | 'success' | 'error'
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
}

export const dockerInstallKey = (sessionId: string) => `${sessionId}:docker`
export const webInstallKey = (sessionId: string, kind: WebInstallKind) => `${sessionId}:${kind}`

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
  }
}))
