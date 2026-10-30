import { create } from 'zustand'
import { useAppStore } from './useAppStore'

export type WebInstallKind = 'nginx' | 'caddy'
type InstallKind = 'docker' | WebInstallKind

type InstallTask = {
  sessionId: string
  kind: InstallKind
  status: 'running' | 'success' | 'error'
  log: string[]
  error?: string
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
        return { tasks: { ...state.tasks, [key]: { ...task, log: [...task.log.slice(-199), line] } } }
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
        return { tasks: { ...state.tasks, [key]: { ...task, log: [...task.log.slice(-199), line] } } }
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
