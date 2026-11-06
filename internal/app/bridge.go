package app

import (
	"encoding/json"
	"errors"
	"fmt"
)

// Bridge 是前端唯一可见的 Wails 绑定（window.go.app.Bridge）。
// channel 字符串与 shared/ipc-channels.ts 一一对应。
type Bridge struct {
	app *App
}

func newBridge(a *App) *Bridge {
	return &Bridge{app: a}
}

type handler func(args []interface{}) (interface{}, error)

// Invoke 统一调用入口。args 是原 preload 方法的参数数组。
// 原 ipcRenderer.send 的通道也走这里，调用方忽略返回值。
func (b *Bridge) Invoke(channel string, args []interface{}) (interface{}, error) {
	h, ok := b.routes()[channel]
	if !ok {
		return nil, fmt.Errorf("未知通道: %s", channel)
	}
	return h(args)
}

func (b *Bridge) routes() map[string]handler {
	a := b.app
	return map[string]handler{
		// 会话 CRUD
		"session:list":               func(_ []interface{}) (interface{}, error) { return a.store.List() },
		"session:create":             a.hSessionCreate,
		"session:update":             a.hSessionUpdate,
		"session:delete":             a.hSessionDelete,
		"session:duplicate":          a.hSessionDuplicate,
		"session:detect-os":          a.hSessionDetectOs,
		"session:metrics":            a.hSessionMetrics,
		"session:server-info":        a.hSessionServerInfo,
		"session:kill-proc":          a.hSessionKillProc,
		"session:docker":             a.hSessionDocker,
		"session:docker-action":      a.hSessionDockerAction,
		"session:docker-install":     a.hSessionDockerInstall,
		"session:docker-service":     a.hSessionDockerService,
		"session:docker-mirrors-set": a.hSessionDockerMirrorsSet,
		"session:script-run":         a.hSessionScriptRun,
		"session:cron-list":          a.hSessionCronList,
		"session:cron-add":           a.hSessionCronAdd,
		"session:cron-del":           a.hSessionCronDel,
		"session:web":                a.hSessionWeb,
		"session:web-install":        a.hSessionWebInstall,
		"session:website":            a.hSessionWebSite,
		"session:web-ssl":            a.hSessionWebSSL,
		"session:web-service":        a.hSessionWebService,
		"session:set-os":             a.hSessionSetOs,
		"session:reveal-secret":      a.hSessionRevealSecret,
		"forward:list":               a.hForwardList,
		"forward:start":              a.hForwardStart,
		"forward:stop":               a.hForwardStop,
		"host:note-list":             func(_ []interface{}) (interface{}, error) { return a.store.ListHostNotes() },
		"host:note-set":              a.hHostNoteSet,
		"shells:list":                a.hShellsList,
		"sshkey:generate":            a.hSshKeyGenerate,
		"sshkey:import-private":      a.hSshKeyImportPrivate,
		"sshkey:install-public":      a.hSshKeyInstallPublic,
		"sshkey:read-public-file":    a.hSshKeyReadPublicFile,

		// 终端
		"term:create":    a.hTermCreate,
		"term:cwd":       a.hTermCwd,
		"term:bind-view": a.hTermBindView,
		"term:input":     a.hTermInput,
		"term:resize":    a.hTermResize,
		"term:close":     a.hTermClose,
		"term:label":     a.hTermLabel,

		// SFTP
		"sftp:list":            a.hSftpList,
		"sftp:mkdir":           a.hSftpMkdir,
		"sftp:remove":          a.hSftpRemove,
		"sftp:rename":          a.hSftpRename,
		"sftp:upload":          a.hSftpUpload,
		"sftp:upload-dir":      a.hSftpUploadDir,
		"sftp:upload-paths":    a.hSftpUploadPaths,
		"sftp:download":        a.hSftpDownload,
		"sftp:download-dir":    a.hSftpDownloadDir,
		"sftp:read":            a.hSftpRead,
		"sftp:read-image":      a.hSftpReadImage,
		"sftp:write":           a.hSftpWrite,
		"sftp:save-paste":      a.hSftpSavePaste,
		"sftp:transfer-cancel": a.hSftpTransferCancel,

		// 本机文件
		"localfs:list":         a.hLocalList,
		"localfs:mkdir":        a.hLocalMkdir,
		"localfs:remove":       a.hLocalRemove,
		"localfs:rename":       a.hLocalRename,
		"localfs:upload":       a.hLocalUpload,
		"localfs:upload-dir":   a.hLocalUploadDir,
		"localfs:upload-paths": a.hLocalUploadPaths,
		"localfs:move-paths":   a.hLocalMovePaths,
		"localfs:drag-move":    a.hLocalDragMove,
		"localfs:download":     a.hLocalDownload,
		"localfs:download-dir": a.hLocalDownloadDir,
		"localfs:read":         a.hLocalRead,
		"localfs:read-image":   a.hLocalReadImage,
		"localfs:write":        a.hLocalWrite,
		"localfs:wsl-resolve":  a.hLocalWSLResolve,

		// 片段 / 历史
		"snippet:list":   func(_ []interface{}) (interface{}, error) { return a.store.ListSnippets() },
		"snippet:create": a.hSnippetCreate,
		"snippet:update": a.hSnippetUpdate,
		"snippet:delete": a.hSnippetDelete,
		"history:list":   a.hHistoryList,
		"history:clear":  a.hHistoryClear,

		// 外观 / MCP
		"appearance:get":    func(_ []interface{}) (interface{}, error) { return a.store.GetAppearance() },
		"appearance:save":   a.hAppearanceSave,
		"mcp:get":           func(_ []interface{}) (interface{}, error) { return a.store.GetMcpSettings() },
		"mcp:audit":         a.hMcpAudit,
		"mcp:audit-export":  a.hMcpAuditExport,
		"mcp:save":          a.hMcpSave,
		"mcp:state":         func(_ []interface{}) (interface{}, error) { return a.mcp.State(), nil },
		"mcp:bound":         a.hMcpBound,
		"mcp:confirm-reply": a.hMcpConfirmReply,

		// 截图
		"capture:save":   a.hCaptureSave,
		"capture:reveal": a.hCaptureReveal,
		"capture:copy":   a.hCaptureCopy,
		"capture:read":   a.hCaptureRead,
		"capture:reply":  a.hCaptureReply,

		// 终端缓冲读取 / 光标模式（MCP 请求-应答的回复侧）
		"term:lines-reply": a.hTermLinesReply,
		"term:mode-reply":  a.hTermModeReply,

		// 应用 / 窗口
		"app:version":         func(_ []interface{}) (interface{}, error) { return appVersion, nil },
		"app:take-dir":        func(_ []interface{}) (interface{}, error) { return a.takeLaunchDir(), nil },
		"win:minimize":        a.hWinMinimize,
		"win:toggle-maximize": a.hWinToggleMaximize,
		"win:close":           a.hWinClose,
		"win:is-maximized":    a.hWinIsMaximized,
		"win:new":             a.hWinNew,
	}
}

// arg 把第 i 个参数解码到 T（Wails 传过来的是 []interface{}，经 JSON 重编码进类型）。
func arg[T any](args []interface{}, i int) (T, error) {
	var out T
	if i >= len(args) {
		return out, fmt.Errorf("缺少第 %d 个参数", i+1)
	}
	raw, err := json.Marshal(args[i])
	if err != nil {
		return out, err
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return out, fmt.Errorf("第 %d 个参数类型不对: %w", i+1, err)
	}
	return out, nil
}

func argStr(args []interface{}, i int) (string, error) {
	return arg[string](args, i)
}

var errNoWindow = errors.New("窗口不可用")
