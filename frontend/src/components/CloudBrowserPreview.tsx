import { forwardRef, useEffect, useRef, useState } from 'react'
import { Globe } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { BrowserInfo } from '../../../shared/types'
import { BrowserLive } from './BrowserLive'
import { useAppStore } from '../stores/useAppStore'
import { browserInstallKey, useInstallStore } from '../stores/useInstallStore'

/** width 为 null 时和终端平分（flex:1），否则按像素宽度占右侧。 */
export const CloudBrowserPreview = forwardRef<HTMLElement, { termId: string; width: number | null }>(function CloudBrowserPreview(
  props,
  ref
) {
  const sessionId = useAppStore((s) => {
    const tab = s.tabs.find((item) => item.id === props.termId)
    return tab?.kind === 'ssh' ? tab.sessionId : null
  })
  const task = useInstallStore((s) => (sessionId ? s.tasks[browserInstallKey(sessionId)] : undefined))
  const startBrowser = useInstallStore((s) => s.startBrowser)
  const pauseBrowser = useInstallStore((s) => s.pauseBrowser)
  const clearBrowserCache = useInstallStore((s) => s.clearBrowserCache)
  const [info, setInfo] = useState<BrowserInfo | null>(null)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [tick, setTick] = useState(0)
  const [busy, setBusy] = useState<'start' | 'stop' | null>(null)
  const [pausing, setPausing] = useState(false)
  const [clearing, setClearing] = useState(false)
  const installing = task?.status === 'running'
  const log = task?.log ?? []
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (task?.status === 'success') setTick((n) => n + 1)
  }, [task?.status])

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [task?.log])

  useEffect(() => {
    setInfo(null)
    setError('')
    setLoaded(!sessionId)
  }, [sessionId])

  useEffect(() => {
    if (!sessionId) return
    let cancel = false
    void window.api.sessions.browser(sessionId).then(
      (next) => {
        if (cancel) return
        setInfo(next)
        setError('')
        setLoaded(true)
      },
      (err: unknown) => {
        if (cancel) return
        setInfo(null)
        setError(err instanceof Error ? err.message : String(err))
        setLoaded(true)
      }
    )
    return () => {
      cancel = true
    }
  }, [sessionId, tick])

  const run = (op: 'start' | 'stop') => {
    if (!sessionId || busy) return
    setBusy(op)
    void window.api.sessions
      .browserService(sessionId, op)
      .then(() => setTick((n) => n + 1))
      .catch((err: unknown) => {
        useAppStore.getState().setNotice(err instanceof Error ? err.message : String(err))
      })
      .finally(() => setBusy(null))
  }

  const message = describe(info, error, loaded, !!sessionId)

  return (
    <section
      ref={ref}
      className="flex min-h-0 min-w-0 flex-col border-l border-border"
      style={props.width == null ? { flex: '1 1 0%' } : { width: props.width, flex: '0 0 auto' }}
    >
      {info?.state === 'running' && sessionId ? (
        <BrowserLive sessionId={sessionId} stopping={busy === 'stop'} onStop={() => run('stop')} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-sm text-muted-foreground">
        <Globe className="size-8" />
        {message && <p>{message}</p>}
        {info?.dockerAvailable && info.dockerRunning && !info.state && (
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button size="sm" disabled={installing || clearing} onClick={() => sessionId && startBrowser(sessionId)}>
              {installing ? '安装中…' : '一键安装云浏览器'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!installing || pausing}
              onClick={() => {
                if (!sessionId || pausing) return
                setPausing(true)
                void pauseBrowser(sessionId).finally(() => setPausing(false))
              }}
            >
              {pausing ? '暂停中…' : '暂停'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={installing || clearing}
              onClick={() => {
                if (!sessionId) return
                setClearing(true)
                void clearBrowserCache(sessionId).finally(() => setClearing(false))
              }}
            >
              {clearing ? '清空中…' : '清空缓存'}
            </Button>
          </div>
        )}
        {info?.dockerRunning && !!info.state && info.state !== 'running' && (
          <Button size="sm" disabled={busy !== null} onClick={() => run('start')}>
            {busy === 'start' ? '启动中…' : '启动云浏览器'}
          </Button>
        )}
        {log.length > 0 && !info?.state && (
          <div
            ref={logRef}
            className="max-h-44 w-full max-w-2xl overflow-auto rounded-md bg-muted p-2 font-mono text-sm select-text"
          >
            {log.map((line, i) => (
              <div key={i} className="whitespace-nowrap">
                {line}
              </div>
            ))}
          </div>
        )}
        </div>
      )}
    </section>
  )
})

function describe(info: BrowserInfo | null, error: string, loaded: boolean, hasSession: boolean): string {
  if (!loaded || !hasSession || !info) return error && loaded ? error : ''
  if (!info.dockerAvailable) return '这台服务器没有安装 Docker'
  if (info.needSudo) return '没有权限操作 Docker'
  if (!info.dockerRunning) return 'Docker 没有在运行'
  if (!info.state) return '这台服务器没有安装云浏览器'
  if (info.state === 'running') return '云浏览器已启动'
  return '云浏览器已关闭'
}
