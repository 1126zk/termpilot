/** IPC 通道常量，main / preload / renderer 共用 */
export const IPC = {
  sessionList: 'session:list',
  sessionCreate: 'session:create',
  sessionUpdate: 'session:update',
  sessionDelete: 'session:delete',
  sessionDuplicate: 'session:duplicate',
  /** main → renderer，Agent 改了会话列表 */
  sessionChanged: 'session:changed',
  hostNoteList: 'host:note-list',
  hostNoteSet: 'host:note-set',

  termSaved: 'term:saved',
  /** 恢复窗口时取出上次退出时已经画好的行。不再回放原始流。 */
  termHistory: 'term:history',
  /** 界面把当前缓冲里的行交给主进程存盘 */
  termScrollSave: 'term:scroll-save',
  termBindView: 'term:bind-view',
  termCreate: 'term:create',
  termInput: 'term:input',
  termResize: 'term:resize',
  termClose: 'term:close',
  /** renderer → main，窗口短标题变了 */
  termLabel: 'term:label',
  /** main → renderer，助手改了终端备注 */
  termMeta: 'term:meta',
  /** main → renderer 事件 */
  termData: 'term:data',
  termStatus: 'term:status',

  sftpList: 'sftp:list',
  sftpMkdir: 'sftp:mkdir',
  sftpRemove: 'sftp:remove',
  sftpUpload: 'sftp:upload',
  sftpDownload: 'sftp:download',
  sftpUploadDir: 'sftp:upload-dir',
  sftpDownloadDir: 'sftp:download-dir',
  sftpRead: 'sftp:read',
  sftpWrite: 'sftp:write',
  sftpRename: 'sftp:rename',
  /** main → renderer，安装 SFTP 的进度和远程日志 */
  sftpInstall: 'sftp:install',
  /** 拖入上传：renderer 把本地路径数组交给主进程 */
  sftpUploadPaths: 'sftp:upload-paths',
  /** main → renderer，单个文件传输进度 */
  sftpTransfer: 'sftp:transfer',
  /** renderer → main，取消一条进行中的传输 */
  sftpTransferCancel: 'sftp:transfer-cancel',

  snippetList: 'snippet:list',
  snippetCreate: 'snippet:create',
  snippetUpdate: 'snippet:update',
  snippetDelete: 'snippet:delete',

  historyList: 'history:list',
  historyClear: 'history:clear',
  /** main → renderer，写入了新的历史指令 */
  historyChanged: 'history:changed',

  mcpAgents: 'mcp:agents',
  mcpApplyAgent: 'mcp:apply-agent',
  mcpAudit: 'mcp:audit',
  mcpGet: 'mcp:get',
  mcpSave: 'mcp:save',

  appearanceGet: 'appearance:get',
  appearanceSave: 'appearance:save',
  mcpState: 'mcp:state',
  mcpStateEvent: 'mcp:state-event',
  mcpBound: 'mcp:bound',
  mcpOpenTab: 'mcp:open-tab',
  mcpCloseTab: 'mcp:close-tab',
  mcpConfirm: 'mcp:confirm',
  mcpConfirmReply: 'mcp:confirm-reply',

  /** 截取页面上真实的终端视图 */
  capturePage: 'capture:page',
  captureSave: 'capture:save',
  captureReveal: 'capture:reveal',
  captureCopy: 'capture:copy',
  captureRead: 'capture:read',
  captureRun: 'capture:run',
  captureReply: 'capture:reply',
  termLines: 'term:lines',
  termLinesReply: 'term:lines-reply',
  termMode: 'term:mode',
  termModeReply: 'term:mode-reply',

  appVersion: 'app:version',

  /** 本机文件面板，参数为统一正斜杠路径，无 sessionId */
  localfsList: 'localfs:list',
  localfsMkdir: 'localfs:mkdir',
  localfsRemove: 'localfs:remove',
  localfsUpload: 'localfs:upload',
  localfsUploadPaths: 'localfs:upload-paths',
  localfsDownload: 'localfs:download',
  localfsUploadDir: 'localfs:upload-dir',
  localfsDownloadDir: 'localfs:download-dir',
  localfsRename: 'localfs:rename',
  localfsRead: 'localfs:read',
  localfsWrite: 'localfs:write',
  sessionDetectOs: 'session:detect-os',
  sessionSetOs: 'session:set-os',

  winMinimize: 'win:minimize',
  winToggleMaximize: 'win:toggle-maximize',
  winClose: 'win:close',
  winIsMaximized: 'win:is-maximized',
  winMaximizeChanged: 'win:maximize-changed'
} as const
