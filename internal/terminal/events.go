package terminal

import "termpilot/internal/sshx"

// 与 Electron 版 src/shared/types.ts 对齐的终端事件与请求结构。
// JSON tag 沿用 camelCase，Wails 桥接层直接序列化即与现版形状一致。
// 下行事件不再走 webContents.send，而是由 Emitter 回调交给桥接层。

// Kind 终端种类。对应 TS TabKind。
type Kind string

const (
	KindSSH   Kind = "ssh"
	KindLocal Kind = "local"
)

// Status 终端状态。对应 TS TermStatusEvent.status（SessionStatus | 'error'）。
type Status string

const (
	StatusConnecting   Status = "connecting"
	StatusConnected    Status = "connected"
	StatusDisconnected Status = "disconnected"
	StatusError        Status = "error"
)

// CreateOptions 创建终端的请求（对应 TS TermCreateOptions）。
type CreateOptions struct {
	TermID string `json:"termId"`
	Kind   Kind   `json:"kind"`
	// kind = ssh 时必填。
	SessionID string `json:"sessionId,omitempty"`
	Title     string `json:"title,omitempty"`
	// kind = local 时的壳类型，缺省 powershell。
	Shell string `json:"shell,omitempty"`
	// 本机终端的起始目录。空则用用户主目录。
	Cwd  string `json:"cwd,omitempty"`
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
}

// MetaEvent 终端标题或备注变了（对应 TS TermMetaEvent）。
type MetaEvent struct {
	TermID string `json:"termId"`
	Title  string `json:"title"`
	Remark string `json:"remark"`
}

// StatusEvent 终端状态推送（对应 TS TermStatusEvent）。SessionID nil 对应 TS 的 null。
type StatusEvent struct {
	TermID    string  `json:"termId"`
	SessionID *string `json:"sessionId"`
	Status    Status  `json:"status"`
	Error     string  `json:"error,omitempty"`
}

// DataEvent 终端数据推送（对应 TS TermDataEvent）。
// TS 里 data 是 Uint8Array；过 Wails 桥统一成 base64 字符串，前端适配层负责解码。
type DataEvent struct {
	TermID string `json:"termId"`
	Data   string `json:"data"` // base64
}

// TermInfo 对应 TS listTerms 的返回项。
type TermInfo struct {
	ID        string  `json:"id"`
	SessionID *string `json:"sessionId"`
	Kind      Kind    `json:"kind"`
	Status    string  `json:"status"`
	Title     string  `json:"title"`
	Remark    string  `json:"remark"`
}

// ExecResult 对应 TS execCommand 的返回。ExitCode nil 表示没拿到退出码
// （本机 Windows 的 PowerShell 没有探针，或命令超期未跑完）。
type ExecResult struct {
	Output   string `json:"output"`
	ExitCode *int   `json:"exitCode"`
	Finished bool   `json:"finished"`
}

// LocalShellInfo 探测到的一个本机壳（对应 TS LocalShellInfo）。
type LocalShellInfo struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Exe   string `json:"exe"`
}

// Emitter 下行事件出口，对应 TS 里 webContents.send 的那一面。由桥接层实现后注入。
type Emitter interface {
	TermData(e DataEvent)
	TermStatus(e StatusEvent)
	TermMeta(e MetaEvent)
	// HistoryChanged 对应 TS 的 IPC.historyChanged：结算出一条历史指令后通知界面刷新。
	HistoryChanged(termID string)
}

// SessionStore 会话与凭据来源，对应 TS 里 TerminalService 用到的 StorageService 部分。
// 本包不直接依赖 storage，由上层（bridge）装配适配器。
type SessionStore interface {
	// FindSession 找不到返回 nil。
	FindSession(id string) *sshx.SessionConfig
	// 没有凭据时返回空串（对应 TS 的 null）。
	GetSecret(sessionID string) string
	GetJumpSecrets(sessionID string) []string
}

// HistoryStore 历史指令落库。AppendHistory 返回 false 表示这条没写进去（如与上一条重复），
// 对应 TS StorageService.appendHistory 的返回值语义。
type HistoryStore interface {
	AppendHistory(termID, command string) bool
}
