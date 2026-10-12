package mcpx

import (
	"context"
	"time"

	"termpilot/app/internal/sftpx"
	"termpilot/app/internal/sshx"
	"termpilot/app/internal/storage"
	"termpilot/app/internal/terminal"
)

// 注入接口清单。全部依赖都由上层（bridge）装配，本包不直接 import Wails。
// 除截图/行读/光标模式/确认这四个请求-应答回调外，其余方法签名与既有
// Go 包（storage.Store / terminal.Service / sftpx.Service / sshx.ExecService）
// 的方法一一对应，bridge 直接透传即可。

// Storage 对应 TS StorageService 中 MCP 用到的部分。
type Storage interface {
	List() ([]*storage.SessionConfig, error)
	Create(input *storage.SessionInput) (*storage.SessionConfig, error)
	// Update 会话不存在时返回 (nil, nil)。
	Update(id string, patch *storage.SessionInput) (*storage.SessionConfig, error)
	Delete(id string) (bool, error)
	GetMcpSettings() (*storage.McpSettings, error)
	AppendAudit(tool string, ok bool, detail string) error
}

// Terminal 对应 TS TerminalService 中 MCP 用到的部分。
type Terminal interface {
	Create(opts terminal.CreateOptions)
	Input(termID, data string)
	Reconnect(termID string) error
	Close(termID string)
	ListTerms() []terminal.TermInfo
	SetLabel(termID string, patch terminal.LabelPatch)
	ExpectBind(termID string, timeout time.Duration) error
	WaitStatus(termID string, timeout time.Duration) error
	ReadTail(termID string, maxChars int) (string, error)
	ExecCommand(termID, command string, timeout time.Duration) (terminal.ExecResult, error)
}

// Sftp 对应 TS SftpService 中 MCP 用到的部分。
type Sftp interface {
	List(sessionID, dir string) (string, []sftpx.RemoteFile, error)
	MkdirPath(sessionID, path string) error
	Put(sessionID, localPath, remotePath string) error
	Get(sessionID, remotePath, localPath string) error
	Rename(sessionID, from, to string) error
	Remove(sessionID, path string, kind sftpx.FileKind) error
	Close(sessionID string)
}

// Exec 对应 TS ExecService。
type Exec interface {
	Exec(sessionID string, opts sshx.ExecOptions) (*sshx.ExecResult, error)
}

// Deps 服务依赖与前端桥接回调。
//
// 四个请求-应答回调对应 Electron 版里「wc.send(事件) + 等 IPC 回复」的链路，
// bridge 负责把请求发给前端并阻塞等待回复；超时与服务停止的兜底语义在
// 本包内（见 service.go 顶部的 timeout 变量），回调返回 error 会原样抛给 Agent。
//
//   - Confirm：IPC.mcpConfirm + mcp.confirm 回复。command 已截到 2000 字符。
//     返回 (false, nil) 即拒绝；nil 回调 = 窗口不可用。
//   - Capture：IPC.captureRun + capture.reply。落盘文件必须位于 ScreenshotDir
//     （userData/screenshots）下，超出目录的路径会被丢弃。
//   - Lines：IPC.termLines + term.lines 回复。
//   - Mode：IPC.termMode + term.mode 回复。失败按 applicationCursor=false。
//
// 四个事件回调对应 TS 的 send(channel, payload)，nil = 没有窗口，静默丢弃：
//
//   - OnOpenTab：IPC.mcpOpenTab（bridge 打开标签后应调 terminal.MarkBound）。
//   - OnCloseTab：IPC.mcpCloseTab。
//   - OnSessionChanged：IPC.sessionChanged，携带最新会话列表。
//   - OnState：IPC.mcpStateEvent，携带最新 McpRuntime。
type Deps struct {
	Storage  Storage
	Terminal Terminal
	Sftp     Sftp
	Exec     Exec

	Confirm func(ctx context.Context, command string) (bool, error)
	Capture func(ctx context.Context, req CaptureRequest) (CaptureReply, error)
	Lines   func(ctx context.Context, req TermLinesRequest) (TermLinesReply, error)
	Mode    func(ctx context.Context, req TermModeRequest) (TermModeReply, error)

	OnOpenTab        func(tab TabOpen)
	OnCloseTab       func(termID string)
	OnSessionChanged func(sessions []*storage.SessionConfig)
	OnState          func(state McpRuntime)

	// ScreenshotDir 截图落盘限定目录（userData/screenshots 的绝对路径）。
	// 为空则不校验 CaptureReply.Paths（不建议）。
	ScreenshotDir string
}
