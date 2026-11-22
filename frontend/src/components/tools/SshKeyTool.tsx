import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, Copy, KeyRound, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { SshKeyFile, SshKeyImport, SshKeyPair } from '../../../../shared/types'
import { useAppStore } from '../../stores/useAppStore'

interface PlacedKey {
  path: string
  publicPath?: string
  publicKey: string
  warning?: string
}

function errText(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e)
  return message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
}

/** 密钥管理：生成本地密钥对、导入私钥、把公钥写到已保存的主机。 */
export function SshKeyTool() {
  const sessions = useAppStore((s) => s.sessions)
  const setNotice = useAppStore((s) => s.setNotice)
  const [sessionId, setSessionId] = useState('')
  const [publicKey, setPublicKey] = useState('')
  const [fileKey, setFileKey] = useState<SshKeyFile | null>(null)
  const [placed, setPlaced] = useState<PlacedKey | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [keyCopied, setKeyCopied] = useState(false)
  const keyBoxRef = useRef<HTMLDivElement>(null)
  const keyRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (sessionId && !sessions.some((s) => s.id === sessionId)) setSessionId('')
  }, [sessions, sessionId])

  useLayoutEffect(() => {
    const el = keyRef.current
    const fit = () => {
      if (!el) return
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight}px`
    }
    fit()
    const box = keyBoxRef.current
    if (!box) return
    const observer = new ResizeObserver(fit)
    observer.observe(box)
    return () => observer.disconnect()
  }, [publicKey, fileKey])

  const fail = (e: unknown) => setNotice(errText(e))

  const remember = (next: PlacedKey) => {
    setPlaced(next)
    setCopied(false)
    setFileKey(null)
    if (next.publicKey) setPublicKey(next.publicKey)
  }

  const generate = async () => {
    setBusy(true)
    try {
      const pair = (await window.api.sshkey.generate()) as SshKeyPair
      remember({ path: pair.privatePath, publicPath: pair.publicPath, publicKey: pair.publicKey })
      setNotice('密钥对已生成')
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }

  const importPrivate = async () => {
    setBusy(true)
    try {
      const imported = (await window.api.sshkey.importPrivate()) as SshKeyImport | null
      if (!imported) return
      remember({ path: imported.path, publicKey: imported.publicKey, warning: imported.warning })
      setNotice('私钥已放入本机 .ssh')
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }

  const keysToWrite = () => {
    const pasted = publicKey.trim()
    return pasted ? [pasted] : []
  }

  const install = async () => {
    const keys = keysToWrite()
    if (!sessionId || keys.length === 0) return
    setBusy(true)
    try {
      let added = false
      for (const key of keys) {
        const res = await window.api.sshkey.installPublic(sessionId, key)
        if (res.status === 'added') added = true
      }
      setNotice(added ? '公钥已写入这台主机' : '这把公钥已经在这台主机上')
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }

  const pickFile = async () => {
    setBusy(true)
    try {
      const file = (await window.api.sshkey.readPublicFile()) as SshKeyFile | null
      if (!file) return
      setFileKey(file)
      setPublicKey(file.publicKey)
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    if (!placed?.publicKey) return
    await navigator.clipboard.writeText(placed.publicKey)
    setCopied(true)
    setNotice('公钥已复制')
    window.setTimeout(() => setCopied(false), 1500)
  }

  const copyPublic = async () => {
    const text = publicKey.trim()
    if (!text) return
    await navigator.clipboard.writeText(text)
    setKeyCopied(true)
    setNotice('公钥已复制')
    window.setTimeout(() => setKeyCopied(false), 1500)
  }

  return (
    <div className="flex flex-col gap-3">
      {placed && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs break-all text-muted-foreground">私钥 {placed.path}</p>
          {placed.publicPath && <p className="text-xs break-all text-muted-foreground">公钥文件 {placed.publicPath}</p>}
          {placed.warning && <p className="text-xs text-foreground">{placed.warning}</p>}
          {placed.publicKey && (
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1 rounded-md bg-muted px-3 py-2 font-mono text-xs break-all text-foreground">
                {placed.publicKey}
              </div>
              <Button type="button" size="sm" variant="outline" className="h-9 shrink-0 gap-1.5" onClick={() => void copy()}>
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                {copied ? '已复制' : '复制'}
              </Button>
            </div>
          )}
        </div>
      )}
      <div className="flex flex-col gap-2">
        <div ref={keyBoxRef} className="relative min-h-16 rounded-lg border border-input focus-within:border-ring">
          {fileKey ? (
            <textarea
              ref={keyRef}
              value={publicKey}
              spellCheck={false}
              rows={1}
              disabled={busy}
              onChange={(e) => {
                const value = e.target.value
                setPublicKey(value)
                if (value.trim() !== fileKey.publicKey) setFileKey(null)
              }}
              className="w-full resize-none overflow-hidden break-all bg-transparent py-2 pr-9 pl-2.5 font-mono text-xs leading-5 text-foreground outline-none disabled:opacity-50"
            />
          ) : (
            <textarea
              value={publicKey}
              spellCheck={false}
              rows={3}
              placeholder="粘贴公钥，例如 ssh-ed25519 AAAA…"
              disabled={busy}
              onChange={(e) => setPublicKey(e.target.value)}
              className="min-h-16 w-full resize-y bg-transparent py-2 pr-9 pl-2.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 disabled:opacity-50"
            />
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            title="复制公钥"
            disabled={busy || !publicKey.trim()}
            onClick={() => void copyPublic()}
            className="absolute top-1 right-1 size-7 text-muted-foreground hover:text-foreground"
          >
            {keyCopied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" className="h-8 gap-1.5" disabled={busy} onClick={() => void generate()}>
            <KeyRound className="size-3.5" />
            生成密钥对
          </Button>
          <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5" disabled={busy} onClick={() => void importPrivate()}>
            <Upload className="size-3.5" />
            导入私钥
          </Button>
          <div className="ml-auto flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 shrink-0"
              disabled={busy}
              onClick={() => void pickFile()}
            >
              选择文件
            </Button>
            <Select value={sessionId || undefined} onValueChange={setSessionId}>
              <SelectTrigger className="w-52 shrink-0">
                <SelectValue placeholder={sessions.length === 0 ? '还没有主机' : '选择主机'} />
              </SelectTrigger>
              <SelectContent>
                {sessions.length === 0 ? (
                  <SelectItem value="__empty" disabled>
                    还没有主机
                  </SelectItem>
                ) : (
                  sessions.map((session) => (
                    <SelectItem key={session.id} value={session.id}>
                      {session.name}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
            <Button type="button" size="sm" className="h-8" disabled={busy || !sessionId || keysToWrite().length === 0} onClick={() => void install()}>
              写入主机
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
