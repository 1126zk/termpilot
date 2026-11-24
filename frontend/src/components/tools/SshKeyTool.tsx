import { useEffect, useRef, useState } from 'react'
import { Check, Copy, KeyRound, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { RemotePublicKey, SshKeyFile, SshKeyImport, SshKeyPair } from '../../../../shared/types'
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

function remoteRank(name: string): number {
  if (name === 'id_ed25519.pub') return 0
  if (name === 'id_rsa.pub') return 1
  return 2
}

/** 一把只显示公钥。多把按默认 ed、rsa、其余文件名的顺序，文件名和公钥各占一行，中间空一行。 */
function formatRemoteKeys(keys: RemotePublicKey[]): string {
  const ordered = [...keys].sort((a, b) => remoteRank(a.name) - remoteRank(b.name) || a.name.localeCompare(b.name))
  if (ordered.length === 1) return ordered[0].publicKey
  return ordered.map((key) => `${key.name}\n${key.publicKey}`).join('\n\n')
}

function isPublicKeyLine(line: string): boolean {
  const fields = line.trim().split(/\s+/)
  return fields.length >= 2 && /^(ssh-|ecdsa-|sk-)/.test(fields[0]) && /^[A-Za-z0-9+/]+={0,3}$/.test(fields[1]) && fields[1].length >= 16
}

interface ShownKey {
  name: string
  publicKey: string
}

/** 从框里的文本拆出公钥。文件名只是上一行的说明，不进公钥。 */
function shownKeys(text: string): ShownKey[] {
  const blocks: ShownKey[] = []
  let name = ''
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) {
      name = ''
      continue
    }
    if (isPublicKeyLine(line)) {
      blocks.push({ name, publicKey: line })
      name = ''
      continue
    }
    name = line
  }
  return blocks
}

/** 密钥管理：生成本地密钥对、导入私钥、把公钥写到已保存的主机。 */
export function SshKeyTool() {
  const sessions = useAppStore((s) => s.sessions)
  const setNotice = useAppStore((s) => s.setNotice)
  const [sessionId, setSessionId] = useState('')
  const [sourceId, setSourceId] = useState('')
  const [publicKey, setPublicKey] = useState('')
  const [fileKey, setFileKey] = useState<SshKeyFile | null>(null)
  const [placed, setPlaced] = useState<PlacedKey | null>(null)
  const [busy, setBusy] = useState(false)
  const [copiedId, setCopiedId] = useState('')
  const copyTimer = useRef(0)

  useEffect(() => {
    if (sessionId && !sessions.some((s) => s.id === sessionId)) setSessionId('')
    if (sourceId && !sessions.some((s) => s.id === sourceId)) setSourceId('')
  }, [sessions, sessionId, sourceId])

  const fail = (e: unknown) => setNotice(errText(e))

  const remember = (next: PlacedKey) => {
    setPlaced(next)
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
    const lines = publicKey.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    const keys = lines.filter(isPublicKeyLine)
    if (keys.length > 0) return keys
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

  const loadRemote = async (id: string) => {
    setSourceId(id)
    if (!id) return
    setBusy(true)
    try {
      const keys = (await window.api.sshkey.listRemote(id)) ?? []
      setFileKey(null)
      if (keys.length === 0) {
        setPublicKey('')
        setNotice('这台主机没有公钥')
        return
      }
      setPublicKey(formatRemoteKeys(keys))
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

  const copyKey = async (id: string, text: string) => {
    const key = text.trim()
    if (!key) return
    await navigator.clipboard.writeText(key)
    setCopiedId(id)
    setNotice('公钥已复制')
    window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopiedId(''), 1500)
  }

  const blocks = shownKeys(publicKey)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" className="h-8 shrink-0 gap-1.5" disabled={busy} onClick={() => void generate()}>
          <KeyRound className="size-3.5" />
          生成密钥对
        </Button>
        <Button type="button" size="sm" variant="outline" className="h-8 shrink-0 gap-1.5" disabled={busy} onClick={() => void importPrivate()}>
          <Upload className="size-3.5" />
          导入私钥
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <Label className="shrink-0 font-normal text-muted-foreground">读取公钥</Label>
          <Select value={sourceId || undefined} onValueChange={(id) => void loadRemote(id)}>
            <SelectTrigger className="w-44" disabled={busy}>
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
        </div>
      </div>
      {placed && (
        <div className="flex flex-col gap-1">
          <p className="text-sm break-all text-muted-foreground">私钥 {placed.path}</p>
          {placed.publicPath && <p className="text-sm break-all text-muted-foreground">公钥文件 {placed.publicPath}</p>}
          {placed.warning && <p className="text-sm text-foreground">{placed.warning}</p>}
        </div>
      )}
      {blocks.length > 1 ? (
        <div className="flex flex-col gap-4 rounded-lg border border-input px-3 py-3">
          {blocks.map((block, index) => (
            <div key={`${block.name}-${index}`} className="relative">
              {block.name && <p className="pr-10 font-mono text-sm leading-6 break-all text-foreground">{block.name}</p>}
              <p className="pr-10 font-mono text-sm leading-6 break-all text-foreground">{block.publicKey}</p>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                title="复制公钥"
                disabled={busy}
                onClick={() => void copyKey(String(index), block.publicKey)}
                className="absolute top-0 right-0 size-7 text-muted-foreground hover:text-foreground"
              >
                {copiedId === String(index) ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <div className="relative rounded-lg border border-input focus-within:border-ring">
          <textarea
            value={publicKey}
            spellCheck={false}
            placeholder="粘贴公钥，例如 ssh-ed25519 AAAA…"
            disabled={busy}
            onChange={(e) => {
              const value = e.target.value
              setPublicKey(value)
              if (fileKey && value.trim() !== fileKey.publicKey) setFileKey(null)
            }}
            rows={Math.min(20, Math.max(3, publicKey.split('\n').length + 1))}
            className="min-h-16 w-full resize-y bg-transparent py-3 pr-10 pl-3 font-mono text-sm leading-6 break-all text-foreground outline-none placeholder:text-muted-foreground/60 disabled:opacity-50"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            title="复制公钥"
            disabled={busy || !publicKey.trim()}
            onClick={() => void copyKey('single', blocks[0]?.publicKey ?? publicKey.trim())}
            className="absolute top-1.5 right-1 size-7 text-muted-foreground hover:text-foreground"
          >
            {copiedId === 'single' ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </Button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" className="h-8 shrink-0" disabled={busy} onClick={() => void pickFile()}>
          选择文件
        </Button>
        <Select value={sessionId || undefined} onValueChange={setSessionId}>
          <SelectTrigger className="w-auto min-w-52 flex-1">
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
        <Button type="button" size="sm" className="h-8 shrink-0" disabled={busy || !sessionId || keysToWrite().length === 0} onClick={() => void install()}>
          写入主机
        </Button>
      </div>
    </div>
  )
}
