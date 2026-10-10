import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import { Client, type ClientChannel } from 'ssh2'
import type { IPty } from 'node-pty'
import { IPC } from '../../shared/ipc-channels'
import type { TermCreateOptions, TermDataEvent, TermMetaEvent, TermStatusEvent, SessionConfig, LocalShell, LocalShellInfo } from '../../shared/types'
import { dialSsh, endJump } from '../ssh-config'
import type { StorageService } from './StorageService'
import type { SshHold, SshPool } from './SshPool'

/**
 * node-pty 是原生模块，且需要匹配 Electron ABI（electron-rebuild）。
 * 用 createRequire 动态加载并兜底：加载失败时 SSH 终端仍可用，
 * 仅本地终端报友好错误，不至于拖垮整个主进程。
 */
let pty: typeof import('node-pty') | null = null
let ptyLoadError: string | null = null
try {
  const req = createRequire(join(__dirname, 'require-shim.js'))
  pty = req('node-pty') as typeof import('node-pty')
} catch (e) {
  ptyLoadError = e instanceof Error ? e.message : String(e)
  console.error('[TermPilot] node-pty 加载失败（本地终端不可用）:', ptyLoadError)
}

interface TermEntry {
  id: string
  sessionId: string | null
  kind: 'ssh' | 'local'
  /**
   * 这扇终端的活动通道：SSH shell 或本机 PTY，统一成 TerminalChannel。
   * 只管数据通路；共享连接的池引用在 release 上，断开时一起交还。
   */
  channel?: TerminalChannel
  /** SSH 池的引用。最后一次交还才真正断开。 */
  release?: () => void
  /** 跳板直登（无池）时整条 SSH 连接挂在这上面。关掉终端要一起断开。 */
  client?: Client
  /** 经过跳板时，目标连接挂在这上面。关掉终端要一起断开。 */
  jump?: Client
  title: string
  remark: string
  /** kind = local 时的壳类型，重启恢复用 */
  shell?: LocalShell
  /** 每次拨号加一。旧连接迟到的关闭事件不再拆掉新的。 */
  liveGen: number
}

/**
 * 终端服务：统一管理 SSH shell 通道（ssh2）和本地 PTY（node-pty），归一成 TerminalChannel。
 * 数据下行通过 webContents.send 推送，上行走 IPC send。
 */
export class TerminalService {
  private terms = new Map<string, TermEntry>()
  private output = new Map<string, string>()
  /** 上次退出时已经画好的行。打开窗口时按行写回，不再解析原始流。 */
  private savedLines = new Map<string, string>()
  /** 缓冲从头部丢掉的字节数。用来在裁短之后仍只切出本次新增。 */
  private dropped = new Map<string, number>()
  private lastStatus = new Map<string, TermStatusEvent>()
  private statusListeners = new Set<(event: TermStatusEvent) => void>()
  private bindWaiters = new Map<string, () => void>()
  /** 界面已经订上输出。之前的内容先补一次，避免重启后的记录被新输出盖掉。 */
  private viewReady = new Set<string>()
  /** 正在退出。此时断开不要把窗口从库里删掉。 */
  private parking = false
  /** 每扇终端正在输入的那一行。回车结算进历史指令。 */
  private commandLines = new Map<string, { buf: string; dirty: boolean; cr: boolean }>()

  constructor(
    private storage: StorageService,
    private getSender: () => WebContents | null,
    private sshPool: SshPool
  ) {
    this.hydrate()
  }

  async create(opts: TermCreateOptions): Promise<void> {
    const existing = this.terms.get(opts.termId)
    if (existing?.channel) return
    if (existing && this.lastStatus.get(opts.termId)?.status === 'connecting') return

    if (opts.kind === 'local') {
      this.createLocal(opts)
      return
    }
    await this.createSsh(opts)
  }

  input(termId: string, data: string): void {
    this.captureInput(termId, data)
    this.terms.get(termId)?.channel?.write(data)
  }

  /**
   * 按键流按行组装历史指令：回车结算一行；退格删一个字符；含方向键、粘贴换行等
   * 其他控制字符的行丢弃；strip 后少于 2 个字符的也丢弃。CRLF 里的 LF 不算控制字符。
   */
  private captureInput(termId: string, data: string): void {
    // 滤掉非输入序列：焦点事件报告（\x1b[I 进 / \x1b[O 出，focus() 会触发）和括号粘贴标记
    const cleaned = data
      .replaceAll('\x1b[I', '')
      .replaceAll('\x1b[O', '')
      .replaceAll('\x1b[200~', '')
      .replaceAll('\x1b[201~', '')
    let state = this.commandLines.get(termId) ?? { buf: '', dirty: false, cr: false }
    for (const ch of cleaned) {
      if (ch === '\r') {
        const command = state.buf.trim()
        if (!state.dirty && command.length >= 2 && this.storage.appendHistory(termId, command)) {
          const wc = this.getSender()
          if (wc && !wc.isDestroyed()) wc.send(IPC.historyChanged, termId)
        }
        state = { buf: '', dirty: false, cr: true }
        continue
      }
      if (ch === '\n' && state.cr) {
        state.cr = false
        continue
      }
      state.cr = false
      if (ch === '\x7f' || ch === '\b') {
        state.buf = state.buf.slice(0, -1)
        continue
      }
      if (ch.charCodeAt(0) < 0x20) {
        state.dirty = true
        continue
      }
      state.buf += ch
    }
    this.commandLines.set(termId, state)
  }

  resize(termId: string, cols: number, rows: number): void {
    const t = this.terms.get(termId)
    if (!t || cols <= 0 || rows <= 0) return
    try {
      t.channel?.resize?.(cols, rows)
    } catch {
      /* 连接已断开时忽略 resize 错误 */
    }
  }

  /**
   * 同一扇终端重新拨号。编号、标题、备注和已有输出都留着。
   * 已经连着时直接返回。
   */
  async reconnect(termId: string): Promise<void> {
    const term = this.terms.get(termId)
    if (!term) throw new Error('终端不存在或已关闭')
    if (term.kind !== 'ssh' || !term.sessionId) throw new Error('本机终端断开后不会保留，请用 term_open_local 再开一扇')
    const session = this.storage.list().find((item) => item.id === term.sessionId)
    if (!session) throw new Error('这条连接已经删除了')
    if (term.channel) return
    if (this.lastStatus.get(termId)?.status === 'connecting') {
      await this.waitStatus(termId, 20_000)
      return
    }
    this.releaseLive(term)
    const pending = this.waitNextStatus(termId, 20_000)
    await this.create({
      termId,
      kind: 'ssh',
      sessionId: term.sessionId,
      title: term.title,
      cols: 120,
      rows: 32
    })
    await pending
  }

  /** 人关掉或助手关掉。编号不再恢复。 */
  close(termId: string): void {
    const t = this.terms.get(termId)
    this.releaseLive(t)
    this.terms.delete(termId)
    this.output.delete(termId)
    this.savedLines.delete(termId)
    this.commandLines.delete(termId)
    this.dropped.delete(termId)
    this.lastStatus.delete(termId)
    this.viewReady.delete(termId)
    this.storage.forgetOpenTerm(termId)
  }

  /** 恢复窗口时取出上次退出时已经画好的行。不是原始流，按行写回即可。 */
  history(termId: string): { text: string } {
    return { text: this.savedLines.get(termId) ?? '' }
  }

  /** 界面把当前缓冲里的行交过来。存这份，下次打开按行写回。 */
  saveScrollback(termId: string, text: string): void {
    if (!this.terms.has(termId) || typeof text !== 'string') return
    this.storage.saveTermScrollback(termId, text)
  }

  /** 界面订上之后，把这次运行里已经到达、还没画上的输出补上。 */
  bindView(termId: string): void {
    const text = this.output.get(termId) ?? ''
    const first = !this.viewReady.has(termId)
    this.viewReady.add(termId)
    if (first && text) this.push(termId, Buffer.from(text, 'utf8'))
  }

  saved(): { id: string; sessionId: string | null; kind: 'ssh' | 'local'; title: string; remark: string; shell?: LocalShell }[] {
    return this.storage.listOpenTerms().map((term) => ({
      id: term.id,
      sessionId: term.sessionId,
      kind: term.kind,
      title: term.title,
      remark: term.remark,
      shell: term.shell as LocalShell | undefined
    }))
  }

  listTerms(): {
    id: string
    sessionId: string | null
    kind: TermEntry['kind']
    status: string
    title: string
    remark: string
  }[] {
    return [...this.terms.values()].map((t) => ({
      id: t.id,
      sessionId: t.sessionId,
      kind: t.kind,
      status: this.lastStatus.get(t.id)?.status ?? 'unknown',
      title: t.title,
      remark: t.remark
    }))
  }

  /** 窗口短标题或助手备注。编号不变。 */
  setLabel(termId: string, patch: { title?: string; remark?: string }): void {
    const term = this.terms.get(termId)
    if (!term) return
    if (patch.title !== undefined) term.title = patch.title.trim().slice(0, 80) || term.title
    if (patch.remark !== undefined) term.remark = patch.remark.trim().slice(0, 200)
    this.persist(term)
    this.sendMeta(term)
  }

  /** 界面把 xterm 订上之后再放行 SSH，避免登录横幅丢在订阅之前 */
  expectBind(termId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.bindWaiters.delete(termId)
        reject(new Error('界面没有打开终端'))
      }, timeoutMs)
      this.bindWaiters.set(termId, () => {
        clearTimeout(timer)
        this.bindWaiters.delete(termId)
        resolve()
      })
    })
  }

  markBound(termId: string): void {
    this.bindWaiters.get(termId)?.()
  }

  waitStatus(termId: string, timeoutMs: number): Promise<void> {
    const current = this.lastStatus.get(termId)
    if (current?.status === 'connected') return Promise.resolve()
    if (current?.status === 'error') return Promise.reject(new Error(current.error ?? '连接失败'))

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.statusListeners.delete(onStatus)
        reject(new Error('连接超时'))
      }, timeoutMs)
      const onStatus = (event: TermStatusEvent) => {
        if (event.termId !== termId) return
        if (event.status === 'connected') {
          clearTimeout(timer)
          this.statusListeners.delete(onStatus)
          resolve()
        } else if (event.status === 'error' || event.status === 'disconnected') {
          clearTimeout(timer)
          this.statusListeners.delete(onStatus)
          reject(new Error(event.error ?? '连接失败'))
        }
      }
      this.statusListeners.add(onStatus)
    })
  }

  readTail(termId: string, maxChars: number): string {
    if (!this.terms.has(termId)) throw new Error('终端不存在或已断开')
    return (this.output.get(termId) ?? '').slice(-maxChars)
  }

  /**
   * 等命令跑完再返回。完成信号是提示符：发命令前记下当时提示符的长相，
   * 等输出安静下来，最后一行又变回提示符就是跑完了。POSIX shell 还会顺手
   * 打一个看不见的标记带回退出码；本机 Windows 的 PowerShell 没有这一步，
   * 只靠提示符。到 timeoutMs 还没跑完，就把已经回来的内容交出去，命令还在远端跑。
   */
  async execCommand(
    termId: string,
    command: string,
    timeoutMs: number
  ): Promise<{ output: string; exitCode: number | null; finished: boolean }> {
    const term = this.terms.get(termId)
    if (!term?.channel) throw new Error('终端已经断开。用 term_reconnect 恢复这扇终端，编号不变。')
    const origin = this.logicalEnd(termId)
    const promptBefore = lastScreenLine(this.readTail(termId, 4000))
    const body = command.endsWith('\n') ? command.slice(0, -1) : command
    // SSH 和本机 POSIX shell 有退出码探针；本机 Windows 的 PowerShell 只靠提示符
    const posix = term.kind === 'ssh' || process.platform !== 'win32'
    const marker = `__TP_DONE_${Math.random().toString(36).slice(2, 10)}__`
    // 标记打印完立刻用光标回退抹掉，同一个数据块里写完就擦，屏幕上基本看不到
    const probe = posix ? `\nprintf '${marker}%s\\n\\033[2A\\033[2K\\033[1B\\033[2K\\033[1A' "$?"` : ''
    this.input(termId, `${body}${probe}\n`)
    const deadline = Date.now() + timeoutMs
    let exitCode: number | null = null
    let finished = false
    let seen = 0
    let quietAt = Date.now()
    while (Date.now() < deadline) {
      await delay(100)
      const out = this.since(termId, origin)
      const found = posix ? out.match(new RegExp(`${marker}(\\d+)`)) : null
      if (found) {
        exitCode = Number(found[1])
        finished = true
        break
      }
      if (out.length !== seen) {
        seen = out.length
        quietAt = Date.now()
        continue
      }
      // 输出安静了一小会儿，且最后一行又变回提示符，就是跑完了
      if (Date.now() - quietAt >= 600 && isPromptAgain(lastScreenLine(out), promptBefore)) {
        finished = true
        break
      }
    }
    // 标记行和回显的 printf 行都带 marker 字样，一起剔掉
    const output = this.since(termId, origin)
      .split('\n')
      .filter((line) => !line.includes(marker))
      .join('\n')
    return { output, exitCode, finished }
  }

  /** 退出时断开。窗口编号和备注留着，输出不写入磁盘。 */
  disposeAll(): void {
    this.parking = true
    for (const term of this.terms.values()) this.releaseLive(term)
    this.terms.clear()
    this.viewReady.clear()
  }

  // ---------------------------------------------------------------- ssh

  private async createSsh(opts: TermCreateOptions, retried = false): Promise<void> {
    const session = this.storage.list().find((s) => s.id === opts.sessionId)
    if (!session) {
      this.sendStatus(opts.termId, opts.sessionId ?? null, 'error', '会话不存在')
      return
    }

    const prior = this.terms.get(opts.termId)
    const entry: TermEntry = prior ?? {
      id: opts.termId,
      sessionId: session.id,
      kind: 'ssh',
      title: opts.title?.trim() || '窗口',
      remark: '',
      liveGen: 0
    }
    if (!prior) {
      this.terms.set(opts.termId, entry)
      this.persist(entry)
    }
    const gen = this.arm(entry)
    this.sendStatus(opts.termId, session.id, 'connecting')

    const secret = this.storage.getSecret(session.id)
    const jumpSecret = this.storage.getJumpSecret(session.id)
    try {
      const hold = await this.sshPool.acquire(session, secret, jumpSecret)
      if (!this.alive(entry, gen)) {
        hold.release()
        return
      }
      this.bindShared(entry, hold, opts, gen, retried)
      return
    } catch (error) {
      if (!this.alive(entry, gen)) return
      if (session.jumpHost?.trim() && isForwardDenied(error)) {
        this.openJumpShell(entry, opts, session, secret, jumpSecret, gen)
        return
      }
      this.sendStatus(opts.termId, session.id, 'error', error instanceof Error ? error.message : String(error))
    }
  }

  /** 转发已经通了。shell 开在这条会话上，不再向跳板要一次连接。 */
  private bindShared(entry: TermEntry, hold: SshHold, opts: TermCreateOptions, gen: number, retried: boolean): void {
    const sessionId = entry.sessionId
    entry.release = hold.release
    hold.client.on('error', (err) => {
      if (!this.alive(entry, gen)) return
      this.releaseLive(entry)
      this.sendStatus(opts.termId, sessionId, 'error', err.message)
    })
    hold.client.on('close', () => {
      if (!this.alive(entry, gen)) return
      this.releaseLive(entry)
      this.sendStatus(opts.termId, sessionId, 'disconnected')
    })
    hold.client.shell({ term: 'xterm-256color', cols: opts.cols, rows: opts.rows }, (err, stream) => {
      if (!this.alive(entry, gen)) return
      if (err || !stream) {
        // 池里拿到的是半死连接（心跳还没来得及判死）：清掉缓存重拨一次。
        // shell 还没开出来，重试没有副作用
        if (!retried && sessionId) {
          this.releaseLive(entry)
          this.sshPool.drop(sessionId)
          void this.createSsh(opts, true)
          return
        }
        this.sendStatus(opts.termId, sessionId, 'error', `打开 shell 失败: ${err?.message ?? '未知原因'}`)
        return
      }
      entry.channel = sshChannel(stream)
      this.sendStatus(opts.termId, sessionId, 'connected')
      stream.on('data', (d: Buffer) => this.sendData(opts.termId, d))
      stream.stderr.on('data', (d: Buffer) => this.sendData(opts.termId, d))
      stream.on('close', () => {
        if (!this.alive(entry, gen)) return
        this.releaseLive(entry)
        this.sendStatus(opts.termId, sessionId, 'disconnected')
      })
    })
  }

  /** 跳板不许转发时，只给终端在跳板里再登录一次。这条没有 SSH 会话，文件树用不上。 */
  private openJumpShell(
    entry: TermEntry,
    opts: TermCreateOptions,
    session: SessionConfig,
    secret: string | null,
    jumpSecret: string | null,
    gen: number
  ): void {
    const client = new Client()
    entry.client = client
    client
      .on('error', (err) => {
        if (!this.alive(entry, gen)) return
        this.releaseLive(entry)
        this.sendStatus(opts.termId, session.id, 'error', err.message)
      })
      .on('close', () => {
        if (!this.alive(entry, gen)) return
        this.releaseLive(entry)
        this.sendStatus(opts.termId, session.id, 'disconnected')
      })
    try {
      entry.jump = dialSsh(session, secret, jumpSecret, client, {
        cols: opts.cols,
        rows: opts.rows,
        onJumpShell: (stream) => {
          if (!this.alive(entry, gen)) return
          entry.channel = sshChannel(stream)
          this.sendStatus(opts.termId, session.id, 'connected')
          stream.on('data', (d: Buffer) => this.sendData(opts.termId, d))
          stream.stderr.on('data', (d: Buffer) => this.sendData(opts.termId, d))
          stream.on('close', () => {
            if (!this.alive(entry, gen)) return
            this.releaseLive(entry)
            this.sendStatus(opts.termId, session.id, 'disconnected')
          })
        }
      })
    } catch (e) {
      if (!this.alive(entry, gen)) return
      this.releaseLive(entry)
      this.sendStatus(opts.termId, session.id, 'error', e instanceof Error ? e.message : String(e))
    }
  }

  // -------------------------------------------------------------- local

  private createLocal(opts: TermCreateOptions): void {
    if (!pty) {
      this.sendStatus(
        opts.termId,
        null,
        'error',
        `node-pty 不可用: ${ptyLoadError ?? '未知原因'}（原生模块需 electron-rebuild）`
      )
      return
    }
    const shell = localShellExe(opts.shell)

    const prior = this.terms.get(opts.termId)
    const entry: TermEntry = prior ?? {
      id: opts.termId,
      sessionId: null,
      kind: 'local',
      title: opts.title?.trim() || '窗口',
      remark: '',
      shell: opts.shell ?? 'powershell',
      liveGen: 0
    }
    if (!prior) {
      this.terms.set(opts.termId, entry)
      this.persist(entry)
    }

    try {
      const proc = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: opts.cols,
        rows: opts.rows,
        cwd: homedir(),
        env: process.env as Record<string, string>
      })
      entry.channel = ptyChannel(proc)
      this.sendStatus(opts.termId, null, 'connected')
      proc.onData((d) => this.sendData(opts.termId, Buffer.from(d, 'utf-8')))
      const gen = this.arm(entry)
      proc.onExit(() => {
        if (this.parking || !this.alive(entry, gen)) return
        this.sendStatus(opts.termId, null, 'disconnected')
        this.close(opts.termId)
      })
    } catch (e) {
      this.sendStatus(opts.termId, null, 'error', e instanceof Error ? e.message : String(e))
    }
  }

  private sendMeta(term: TermEntry): void {
    const wc = this.getSender()
    if (!wc || wc.isDestroyed()) return
    const payload: TermMetaEvent = { termId: term.id, title: term.title, remark: term.remark }
    wc.send(IPC.termMeta, payload)
  }

  private logicalEnd(termId: string): number {
    return (this.dropped.get(termId) ?? 0) + (this.output.get(termId) ?? '').length
  }

  /** 只取 origin 之后新写入的输出。缓冲从头部裁短时也不把更早的记录算进去。 */
  private since(termId: string, origin: number): string {
    const text = this.output.get(termId) ?? ''
    const from = origin - (this.dropped.get(termId) ?? 0)
    if (from >= 0 && from <= text.length) return text.slice(from)
    return text
  }

  private sendData(termId: string, data: Buffer): void {
    const prev = this.output.get(termId) ?? ''
    const next = prev + data.toString('utf8')
    if (next.length > 100_000) {
      const drop = next.length - 100_000
      this.dropped.set(termId, (this.dropped.get(termId) ?? 0) + drop)
      this.output.set(termId, next.slice(drop))
    } else {
      this.output.set(termId, next)
    }
    if (this.viewReady.has(termId)) this.push(termId, data)
  }

  private hydrate(): void {
    for (const saved of this.storage.listOpenTerms()) {
      if (saved.kind === 'ssh' && !this.storage.list().some((session) => session.id === saved.sessionId)) {
        this.storage.forgetOpenTerm(saved.id)
        continue
      }
      this.terms.set(saved.id, {
        id: saved.id,
        sessionId: saved.sessionId,
        kind: saved.kind,
        title: saved.title,
        remark: saved.remark,
        liveGen: 0
      })
      if (saved.scrollback) this.savedLines.set(saved.id, saved.scrollback)
      this.lastStatus.set(saved.id, {
        termId: saved.id,
        sessionId: saved.sessionId,
        status: 'disconnected'
      })
    }
  }

  private persist(term: TermEntry): void {
    this.storage.saveOpenTerm({
      id: term.id,
      sessionId: term.sessionId,
      kind: term.kind,
      title: term.title,
      remark: term.remark,
      shell: term.shell
    })
  }

  private arm(entry: TermEntry): number {
    entry.liveGen += 1
    return entry.liveGen
  }

  private alive(entry: TermEntry, gen: number): boolean {
    return this.terms.get(entry.id) === entry && entry.liveGen === gen
  }

  /** 只听这次拨号之后的状态，不把上次的失败当成这次的结果。 */
  private waitNextStatus(termId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.statusListeners.delete(onStatus)
        reject(new Error('连接超时'))
      }, timeoutMs)
      const onStatus = (event: TermStatusEvent) => {
        if (event.termId !== termId) return
        if (event.status === 'connecting') return
        clearTimeout(timer)
        this.statusListeners.delete(onStatus)
        if (event.status === 'connected') resolve()
        else reject(new Error(event.error ?? '连接失败'))
      }
      this.statusListeners.add(onStatus)
    })
  }

  private releaseLive(term: TermEntry | undefined): void {
    if (!term) return
    const channel = term.channel
    const release = term.release
    const client = term.client
    const jump = term.jump
    term.channel = undefined
    term.release = undefined
    term.client = undefined
    term.jump = undefined
    try {
      channel?.close()
      if (release) release()
      else client?.end()
      endJump(jump)
    } catch {
      /* 断开阶段的异常忽略 */
    }
  }

  private push(termId: string, data: Buffer): void {
    const wc = this.getSender()
    if (!wc || wc.isDestroyed()) return
    const payload: TermDataEvent = { termId, data }
    wc.send(IPC.termData, payload)
  }

  private sendStatus(
    termId: string,
    sessionId: string | null,
    status: TermStatusEvent['status'],
    error?: string
  ): void {
    const payload: TermStatusEvent = { termId, sessionId, status, error }
    this.lastStatus.set(termId, payload)
    for (const listener of [...this.statusListeners]) listener(payload)
    const wc = this.getSender()
    if (!wc || wc.isDestroyed()) return
    wc.send(IPC.termStatus, payload)
  }
}

/**
 * 一扇终端背后的活动通道：SSH shell 或本机 PTY，归一成这个形状。
 * 数据下行和状态事件在创建通道时各自接线，都汇进 TerminalService 的 sendData / sendStatus。
 */
interface TerminalChannel {
  write(data: string | Buffer): void
  resize?(cols: number, rows: number): void
  close(): void
}

/** SSH shell 通道。 */
function sshChannel(stream: ClientChannel): TerminalChannel {
  return {
    write: (data) => stream.write(data),
    resize: (cols, rows) => stream.setWindow(rows, cols, 0, 0),
    close: () => {
      try {
        stream.close()
      } catch {
        /* 已经断了 */
      }
    }
  }
}

/** 本机终端（node-pty）。 */
function ptyChannel(proc: IPty): TerminalChannel {
  return {
    write: (data) => proc.write(typeof data === 'string' ? data : data.toString('utf8')),
    resize: (cols, rows) => proc.resize(cols, rows),
    close: () => {
      try {
        proc.kill()
      } catch {
        /* 已经退出 */
      }
    }
  }
}

/** 画面最后一个非空行，去掉 ANSI。提示符就长这样。 */
function lastScreenLine(raw: string): string {
  const lines = raw
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '\n')
    .split('\n')
  return (lines.filter((line) => line.trim().length > 0).pop() ?? '').trim()
}

/** 最后一行是不是又回到了提示符。 */
function isPromptAgain(last: string, before: string): boolean {
  if (!last || last.length > 300) return false
  if (before && last === before) return true
  // 命令 cd 到别处后提示符前半截会变，结尾的 $、#、❯ 那一段不变
  const tail = before.match(/[$#>%❯»]\s*$/)?.[0]?.trim()
  if (tail && last.endsWith(tail)) return true
  return /[$#>%❯»]\s*$/.test(last)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isForwardDenied(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('跳板无法转到目标机')
}

const PWSH_EXE = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const GIT_BASH_EXE = 'C:\\Program Files\\Git\\bin\\bash.exe'
const WSL_EXE = 'C:\\Windows\\System32\\wsl.exe'

/** 用 where.exe 在 PATH 里找程序，按路径特征过滤（比如 bash.exe 要 Git 的，不要 WSL 的）。
 *  where 找到的不查 existsSync：WindowsApps 商店别名是 reparse point，fs 探不到但能启动。 */
function findExe(name: string, pathHint: RegExp, fallbacks: string[]): string | null {
  try {
    const out = execFileSync('where.exe', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    for (const line of out.split(/\r?\n/)) {
      const p = line.trim()
      if (p && pathHint.test(p)) return p
    }
  } catch {
    /* 没找到就走候选路径 */
  }
  for (const candidate of fallbacks) if (existsSync(candidate)) return candidate
  return null
}

function gitBashExe(): string | null {
  return findExe('bash.exe', /git/i, [GIT_BASH_EXE, 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'])
}

function pwshExe(): string | null {
  return findExe('pwsh.exe', /pwsh|powershell/i, [PWSH_EXE])
}

/** 本机终端按壳类型取可执行程序。找不到对应程序时退回 PowerShell。 */
function localShellExe(shell?: LocalShell): string {
  if (process.platform !== 'win32') return process.env.SHELL || '/bin/bash'
  if (shell === 'cmd') return 'cmd.exe'
  if (shell === 'pwsh') {
    const exe = pwshExe()
    if (exe) return exe
  }
  if (shell === 'gitbash') {
    const exe = gitBashExe()
    if (exe) return exe
  }
  if (shell === 'wsl' && existsSync(WSL_EXE)) return WSL_EXE
  return 'powershell.exe'
}

/** 探测这台机器上实际存在的本机壳，+ 菜单只展示探测到的。 */
export function detectLocalShells(): LocalShellInfo[] {
  if (process.platform !== 'win32') {
    const exe = process.env.SHELL || '/bin/bash'
    return [{ id: 'powershell', label: exe.split('/').pop() ?? 'bash', exe }]
  }
  const shells: LocalShellInfo[] = [
    { id: 'powershell', label: 'PowerShell', exe: 'powershell.exe' },
    { id: 'cmd', label: 'CMD', exe: 'cmd.exe' }
  ]
  const pwsh = pwshExe()
  if (pwsh) shells.push({ id: 'pwsh', label: 'PowerShell 7', exe: pwsh })
  const gitbash = gitBashExe()
  if (gitbash) shells.push({ id: 'gitbash', label: 'Git Bash', exe: gitbash })
  if (existsSync(WSL_EXE)) shells.push({ id: 'wsl', label: 'WSL', exe: WSL_EXE })
  return shells
}
