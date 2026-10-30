// Package sftpx 是 TermPilot 文件通道的 Go 移植，语义逐条对应 Electron 版
// src/main/services/SftpService.ts：SFTP 挂在 sshx.Pool 的共享连接上，
// 半死通道丢掉重拨；远端没有 SFTP 子系统时执行 install-sftp.sh 改成
// internal-sftp 后走独立新连接。事件一律经回调吐出，不依赖 Wails。
package sftpx

// FileKind 目录项种类，对应 TS RemoteFile.kind。
type FileKind string

const (
	KindDir  FileKind = "dir"
	KindFile FileKind = "file"
	KindLink FileKind = "link"
)

// RemoteFile SFTP 目录项，对应 TS RemoteFile。Mtime 是 Unix 毫秒。
type RemoteFile struct {
	Name  string   `json:"name"`
	Path  string   `json:"path"`
	Kind  FileKind `json:"kind"`
	Size  int64    `json:"size"`
	Mtime int64    `json:"mtime"`
}

// 传输方向，对应 TS SftpTransferEvent.direction。
const (
	DirectionUp   = "up"
	DirectionDown = "down"
)

// TransferEvent 上传/下载进度，对应 TS SftpTransferEvent。
// 文件夹传输整棵树共用一个 id，Transferred 跨文件累计。
type TransferEvent struct {
	ID          string `json:"id"`
	SessionID   string `json:"sessionId"`
	Direction   string `json:"direction"`
	Name        string `json:"name"`
	Transferred int64  `json:"transferred"`
	Total       int64  `json:"total"`
	Done        bool   `json:"done"`
	Error       string `json:"error,omitempty"`
}

// InstallPhase 对应 TS SftpInstallEvent.phase。
type InstallPhase string

const (
	InstallStart InstallPhase = "start"
	InstallLog   InstallPhase = "log"
	InstallDone  InstallPhase = "done"
	InstallError InstallPhase = "error"
)

// InstallEvent 远端安装 SFTP 时推给界面的进度，对应 TS SftpInstallEvent。
type InstallEvent struct {
	SessionID string       `json:"sessionId"`
	Phase     InstallPhase `json:"phase"`
	Text      string       `json:"text"`
}
