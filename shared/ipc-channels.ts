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

  termBindView: 'term:bind-view',
  termCreate: 'term:create',
  termInput: 'term:input',
  termResize: 'term:resize',
  termClose: 'term:close',
  /** renderer → main，标签标题变了 */
  termLabel: 'term:label',
  /** renderer → main，从屏幕提示符解析终端当前目录 */
  termCwd: 'term:cwd',
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
  sftpReadImage: 'sftp:read-image',
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

  mcpAudit: 'mcp:audit',
  mcpAuditExport: 'mcp:audit-export',
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
  /** main → renderer，右键打开带了一个目录，前端来取 */
  appOpenDir: 'app:open-dir',
  /** renderer → main，取走并清空待打开的目录 */
  appTakeDir: 'app:take-dir',

  /** 本机文件面板，参数为统一正斜杠路径，无 sessionId */
  localfsList: 'localfs:list',
  localfsMkdir: 'localfs:mkdir',
  localfsRemove: 'localfs:remove',
  localfsUpload: 'localfs:upload',
  localfsUploadPaths: 'localfs:upload-paths',
  localfsMovePaths: 'localfs:move-paths',
  localfsDragMove: 'localfs:drag-move',
  localfsDownload: 'localfs:download',
  localfsUploadDir: 'localfs:upload-dir',
  localfsDownloadDir: 'localfs:download-dir',
  localfsRename: 'localfs:rename',
  localfsRead: 'localfs:read',
  localfsReadImage: 'localfs:read-image',
  localfsWrite: 'localfs:write',
  sessionDetectOs: 'session:detect-os',
  sessionMetrics: 'session:metrics',
  sessionServerInfo: 'session:server-info',
  sessionKillProc: 'session:kill-proc',
  sessionDocker: 'session:docker',
  sessionDockerAction: 'session:docker-action',
  sessionDockerInstall: 'session:docker-install',
  sessionDockerInstallProgress: 'session:docker-install-progress',
  sessionDockerService: 'session:docker-service',
  sessionWeb: 'session:web',
  sessionWebInstall: 'session:web-install',
  sessionWebInstallProgress: 'session:web-install-progress',
  sessionWebSite: 'session:website',
  sessionWebSSL: 'session:web-ssl',
  sessionWebService: 'session:web-service',
  sessionDockerMirrorsSet: 'session:docker-mirrors-set',
  sessionScriptRun: 'session:script-run',
  sessionScriptRunProgress: 'session:script-run-progress',
  sessionCronList: 'session:cron-list',
  sessionCronAdd: 'session:cron-add',
  sessionCronDel: 'session:cron-del',
  sessionSetOs: 'session:set-os',
  sessionRevealSecret: 'session:reveal-secret',
  shellsList: 'shells:list',

  winMinimize: 'win:minimize',
  winToggleMaximize: 'win:toggle-maximize',
  winClose: 'win:close',
  winIsMaximized: 'win:is-maximized',
  winMaximizeChanged: 'win:maximize-changed',
  /** 再启动一份程序，打开另一扇窗口 */
  winNew: 'win:new'
} as const
