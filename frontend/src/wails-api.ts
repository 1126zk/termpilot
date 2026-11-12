import { IPC } from '../../shared/ipc-channels'
import type {
  Appearance,
  CaptureReply,
  CaptureRun,
  CronEntry,
  DockerInfo,
  ForwardRule,
  HistoryEntry,
  LocalShellInfo,
  ConnLogEntry,
  McpAuditEntry,
  McpConfirmRequest,
  McpFiles,
  McpOpenTab,
  McpRuntime,
  McpSettings,
  McpSettingsInput,
  OsInfo,
  RemoteFile,
  SessionConfig,
  SessionInput,
  ServerInfo,
  ServerMetrics,
  SshKeyFile,
  SshKeyImport,
  SshKeyInstall,
  SshKeyPair,
  SftpInstallEvent,
  SftpTransferEvent,
  Snippet,
  TermCreateOptions,
  TermLinesReply,
  TermLinesRun,
  TermMetaEvent,
  TermModeReply,
  TermModeRun,
  TermStatusEvent,
  WebInfo
} from '../../shared/types'

/**
 * window.api 的 Wails 实现，与 Electron preload 导出的 Api 逐字段同构。
 * invoke 类调用 → Go 侧单一绑定 Bridge.Invoke(channel, args)；
 * 订阅类 → window.runtime.EventsOn(channel, cb)，返回值即退订函数。
 * 与原 preload 的差异：删掉 capture.page（不再实拍）和 sftp.filePath（拖入上传已移除）。
 */

// 默认 any：与原 preload 里未标类型的 ipcRenderer.invoke 返回值一致
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function invoke<T = any>(channel: string, args: unknown[]): Promise<T> {
  return window.go.app.Bridge.Invoke(channel, args) as Promise<T>
}

/** 原 ipcRenderer.send 的 fire-and-forget：返回值直接丢掉 */
function send(channel: string, ...args: unknown[]): void {
  void invoke<unknown>(channel, args).catch(() => {})
}

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  return window.runtime.EventsOn(channel, (payload: T) => cb(payload))
}

/** Go 侧 term:data 事件把字节按 base64 下发，这里解码回 Uint8Array，保持 preload 原形状 */
function base64ToBytes(base64: string): Uint8Array {
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
  return bytes
}

const api = {
  platform: __PLATFORM__,
  sessions: {
    list: () => invoke<SessionConfig[]>(IPC.sessionList, []),
    create: (input: SessionInput) => invoke(IPC.sessionCreate, [input]),
    update: (id: string, patch: SessionInput) => invoke(IPC.sessionUpdate, [id, patch]),
    delete: (id: string) => invoke(IPC.sessionDelete, [id]),
    duplicate: (id: string) => invoke<SessionConfig | null>(IPC.sessionDuplicate, [id]),
    detectOs: (id: string) => invoke<OsInfo>(IPC.sessionDetectOs, [id]),
    metrics: (id: string) => invoke<ServerMetrics>(IPC.sessionMetrics, [id]),
    serverInfo: (id: string) => invoke<ServerInfo>(IPC.sessionServerInfo, [id]),
    killProc: (id: string, pid: number) => invoke<void>(IPC.sessionKillProc, [id, pid]),
    docker: (id: string, sudoPassword = '') =>
      invoke<DockerInfo>(IPC.sessionDocker, sudoPassword ? [id, sudoPassword] : [id]),
    dockerInstall: (id: string, mirrors: string[]) => invoke<void>(IPC.sessionDockerInstall, [id, mirrors]),
    /** 安装过程的逐行输出订阅；返回退订函数 */
    onDockerInstallProgress: (id: string, cb: (line: string) => void) =>
      on<{ id: string; line: string }>(IPC.sessionDockerInstallProgress, (p) => {
        if (p.id === id) cb(p.line)
      }),
    dockerService: (id: string, op: string) => invoke<void>(IPC.sessionDockerService, [id, op]),
    setDockerMirrors: (id: string, content: string) => invoke<void>(IPC.sessionDockerMirrorsSet, [id, content]),
    /** 跑一段脚本；进度走 onScriptRunProgress 订阅 */
    runScript: (id: string, content: string) => invoke<void>(IPC.sessionScriptRun, [id, content]),
    onScriptRunProgress: (id: string, cb: (line: string) => void) =>
      on<{ id: string; line: string }>(IPC.sessionScriptRunProgress, (p) => {
        if (p.id === id) cb(p.line)
      }),
    cronList: (id: string) => invoke<CronEntry[]>(IPC.sessionCronList, [id]),
    cronAdd: (id: string, schedule: string, content: string, name = '') =>
      invoke<CronEntry>(IPC.sessionCronAdd, [id, schedule, content, name]),
    cronDel: (id: string, cronId: string) => invoke<void>(IPC.sessionCronDel, [id, cronId]),
    dockerAction: (id: string, action: string, target: string, name = '') =>
      invoke<string>(IPC.sessionDockerAction, [id, action, target, name]),
    web: (id: string) => invoke<WebInfo>(IPC.sessionWeb, [id]),
    webInstall: (id: string, name: string) => invoke<void>(IPC.sessionWebInstall, [id, name]),
    /** 安装过程的逐行输出订阅；返回退订函数 */
    onWebInstallProgress: (id: string, cb: (line: string) => void) =>
      on<{ id: string; line: string }>(IPC.sessionWebInstallProgress, (p) => {
        if (p.id === id) cb(p.line)
      }),
    webSite: (id: string, service: string, action: string, domain: string, port = '', siteType = '', target = '') =>
      invoke<void>(IPC.sessionWebSite, [id, service, action, domain, port, siteType, target]),
    webSSL: (id: string, domain: string, op: 'on' | 'renew' | 'off' = 'on') =>
      invoke<void>(IPC.sessionWebSSL, [id, domain, op]),
    webService: (id: string, service: string, op: 'start' | 'stop' | 'restart' | 'rm') =>
      invoke<void>(IPC.sessionWebService, [id, service, op]),
    revealSecret: (id: string) => invoke<string | null>(IPC.sessionRevealSecret, [id]),
    setOs: (id: string, os: string) => invoke(IPC.sessionSetOs, [id, os]),
    onChanged: (cb: (sessions: SessionConfig[]) => void) => on(IPC.sessionChanged, cb)
  },
  forwards: {
    list: (sessionId: string) => invoke<ForwardRule[]>(IPC.forwardList, [sessionId]),
    start: (sessionId: string, rule: ForwardRule) => invoke<void>(IPC.forwardStart, [sessionId, rule]),
    stop: (sessionId: string, rule: ForwardRule) => invoke<void>(IPC.forwardStop, [sessionId, rule])
  },
  shells: {
    list: () => invoke<LocalShellInfo[]>(IPC.shellsList, [])
  },
  sshkey: {
    generate: () => invoke<SshKeyPair>(IPC.sshkeyGenerate, []),
    /** 用户取消选择时返回 null */
    importPrivate: () => invoke<SshKeyImport | null>(IPC.sshkeyImportPrivate, []),
    installPublic: (sessionId: string, publicKey: string) =>
      invoke<SshKeyInstall>(IPC.sshkeyInstallPublic, [sessionId, publicKey]),
    /** 只读入公钥，不写主机。用户取消选择时返回 null */
    readPublicFile: () => invoke<SshKeyFile | null>(IPC.sshkeyReadPublicFile, [])
  },
  hosts: {
    list: () => invoke<Record<string, string>>(IPC.hostNoteList, []),
    setNote: (hostKey: string, remark: string) =>
      invoke<Record<string, string>>(IPC.hostNoteSet, [hostKey, remark])
  },
  term: {
    bindView: (termId: string) => send(IPC.termBindView, termId),
    create: (opts: TermCreateOptions) => invoke(IPC.termCreate, [opts]),
    input: (termId: string, data: string) => send(IPC.termInput, termId, data),
    resize: (termId: string, cols: number, rows: number) => send(IPC.termResize, termId, cols, rows),
    close: (termId: string) => send(IPC.termClose, termId),
    label: (termId: string, patch: { title?: string; remark?: string }) =>
      send(IPC.termLabel, termId, patch),
    cwd: (termId: string) => invoke<string | null>(IPC.termCwd, [termId]),
    onMeta: (cb: (e: TermMetaEvent) => void) => on(IPC.termMeta, cb),
    onData: (cb: (termId: string, data: Uint8Array) => void) =>
      on<{ termId: string; data: string }>(IPC.termData, (p) => cb(p.termId, base64ToBytes(p.data))),
    onStatus: (cb: (e: TermStatusEvent) => void) => on(IPC.termStatus, cb),
    linesReply: (result: TermLinesReply) => send(IPC.termLinesReply, result),
    onLines: (cb: (job: TermLinesRun) => void) => on(IPC.termLines, cb),
    modeReply: (result: TermModeReply) => send(IPC.termModeReply, result),
    onMode: (cb: (job: TermModeRun) => void) => on(IPC.termMode, cb)
  },
  sftp: {
    list: (sessionId: string, dir: string) =>
      invoke<{ path: string; entries: RemoteFile[] }>(IPC.sftpList, [sessionId, dir]),
    mkdir: (sessionId: string, dir: string, name: string) =>
      invoke(IPC.sftpMkdir, [sessionId, dir, name]),
    remove: (sessionId: string, path: string, kind: RemoteFile['kind']) =>
      invoke(IPC.sftpRemove, [sessionId, path, kind]),
    upload: (sessionId: string, dir: string) => invoke<number>(IPC.sftpUpload, [sessionId, dir]),
    uploadDir: (sessionId: string, dir: string) =>
      invoke<number>(IPC.sftpUploadDir, [sessionId, dir]),
    uploadPaths: (sessionId: string, dir: string, paths: string[]) =>
      invoke<number>(IPC.sftpUploadPaths, [sessionId, dir, paths]),
    cancelTransfer: (id: string) => invoke<void>(IPC.sftpTransferCancel, [id]),
    rename: (sessionId: string, from: string, to: string) =>
      invoke(IPC.sftpRename, [sessionId, from, to]),
    download: (sessionId: string, file: RemoteFile) =>
      invoke<boolean>(IPC.sftpDownload, [sessionId, file]),
    downloadDir: (sessionId: string, file: RemoteFile) =>
      invoke<boolean>(IPC.sftpDownloadDir, [sessionId, file]),
    read: (sessionId: string, path: string) => invoke<string>(IPC.sftpRead, [sessionId, path]),
    /** 整张图片的 base64 */
    readImage: (sessionId: string, path: string) => invoke<string>(IPC.sftpReadImage, [sessionId, path]),
    write: (sessionId: string, path: string, text: string) =>
      invoke(IPC.sftpWrite, [sessionId, path, text]),
    /** 粘贴的图片写到服务器 ~/.termpilot/paste，返回绝对路径 */
    savePaste: (sessionId: string, name: string, base64: string) =>
      invoke<string>(IPC.sftpSavePaste, [sessionId, name, base64]),
    onInstall: (cb: (event: SftpInstallEvent) => void) => on(IPC.sftpInstall, cb),
    onTransfer: (cb: (event: SftpTransferEvent) => void) => on(IPC.sftpTransfer, cb)
  },
  localfs: {
    list: (dir: string) => invoke<{ path: string; entries: RemoteFile[] }>(IPC.localfsList, [dir]),
    mkdir: (dir: string, name: string) => invoke(IPC.localfsMkdir, [dir, name]),
    remove: (path: string, kind: RemoteFile['kind']) => invoke(IPC.localfsRemove, [path, kind]),
    rename: (from: string, to: string) => invoke(IPC.localfsRename, [from, to]),
    upload: (dir: string) => invoke<number>(IPC.localfsUpload, [dir]),
    uploadDir: (dir: string) => invoke<number>(IPC.localfsUploadDir, [dir]),
    uploadPaths: (dir: string, paths: string[]) =>
      invoke<number>(IPC.localfsUploadPaths, [dir, paths]),
    movePaths: (dir: string, paths: string[]) =>
      invoke<number>(IPC.localfsMovePaths, [dir, paths]),
    /** 按住鼠标把本机文件拖出窗口，松手即移动 */
    dragMove: (paths: string[]) => invoke<void>(IPC.localfsDragMove, [paths]),
    download: (file: RemoteFile) => invoke<boolean>(IPC.localfsDownload, [file]),
    downloadDir: (file: RemoteFile) => invoke<boolean>(IPC.localfsDownloadDir, [file]),
    read: (path: string) => invoke<string>(IPC.localfsRead, [path]),
    /** 整张图片的 base64 */
    readImage: (path: string) => invoke<string>(IPC.localfsReadImage, [path]),
    write: (path: string, text: string) => invoke(IPC.localfsWrite, [path, text]),
    resolveWsl: (path: string) => invoke<string>(IPC.localfsWslResolve, [path])
  },
  appearance: {
    get: () => invoke<Appearance>(IPC.appearanceGet, []),
    save: (input: Appearance) => invoke<Appearance>(IPC.appearanceSave, [input])
  },
  snippets: {
    list: () => invoke<Snippet[]>(IPC.snippetList, []),
    create: (name: string, command: string) => invoke<Snippet>(IPC.snippetCreate, [name, command]),
    update: (id: string, name: string, command: string) =>
      invoke<void>(IPC.snippetUpdate, [id, name, command]),
    remove: (id: string) => invoke<void>(IPC.snippetDelete, [id])
  },
  history: {
    list: (termId: string) => invoke<HistoryEntry[]>(IPC.historyList, [termId]),
    clear: (termId: string) => invoke<void>(IPC.historyClear, [termId]),
    onChanged: (cb: (termId: string) => void) => on(IPC.historyChanged, cb)
  },
  mcp: {
    get: () => invoke<McpSettings>(IPC.mcpGet, []),
    files: () => invoke<McpFiles>(IPC.mcpFiles, []),
    audit: () => invoke<McpAuditEntry[]>(IPC.mcpAudit, []),
    exportAudit: () => invoke<boolean>(IPC.mcpAuditExport, []),
    save: (input: McpSettingsInput) => invoke(IPC.mcpSave, [input]),
    state: () => invoke<McpRuntime>(IPC.mcpState, []),
    bound: (termId: string) => send(IPC.mcpBound, termId),
    confirm: (id: string, ok: boolean) => send(IPC.mcpConfirmReply, id, ok),
    onState: (cb: (state: McpRuntime) => void) => on(IPC.mcpStateEvent, cb),
    onOpenTab: (cb: (tab: McpOpenTab) => void) => on(IPC.mcpOpenTab, cb),
    onCloseTab: (cb: (termId: string) => void) => on(IPC.mcpCloseTab, cb),
    onConfirm: (cb: (request: McpConfirmRequest) => void) => on(IPC.mcpConfirm, cb)
  },
  capture: {
    save: (pngs: string[]) => invoke<string[]>(IPC.captureSave, [pngs]),
    reveal: (file: string) => invoke<void>(IPC.captureReveal, [file]),
    copy: (file: string) => invoke<void>(IPC.captureCopy, [file]),
    read: (file: string) => invoke<string>(IPC.captureRead, [file]),
    reply: (result: CaptureReply) => send(IPC.captureReply, result),
    onRun: (cb: (job: CaptureRun) => void) => on(IPC.captureRun, cb)
  },
  conn: {
    log: () => invoke<ConnLogEntry[]>(IPC.connLog, [])
  },
  app: {
    version: () => invoke<string>(IPC.appVersion, []),
    takeDir: () => invoke<string>(IPC.appTakeDir, []),
    onOpenDir: (cb: (dir: string) => void) => on(IPC.appOpenDir, cb)
  },
  win: {
    minimize: () => invoke<void>(IPC.winMinimize, []),
    toggleMaximize: () => invoke<void>(IPC.winToggleMaximize, []),
    close: () => invoke<void>(IPC.winClose, []),
    isMaximized: () => invoke<boolean>(IPC.winIsMaximized, []),
    onMaximizeChanged: (cb: (maximized: boolean) => void) => on(IPC.winMaximizeChanged, cb),
    newWindow: () => invoke<void>(IPC.winNew, [])
  }
}

export type Api = typeof api

window.api = api
