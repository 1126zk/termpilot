// Package sshx 是 TermPilot SSH 层的 Go 移植：拨号（含多跳跳板与跳板 shell 回退）、
// 连接池、端口转发、exec 通道和 ~/.ssh/config 同步。
// 语义逐一对应 Electron 版的 src/main/ssh-config.ts、ssh-config-file.ts、
// forward.ts、services/SshPool.ts、services/ExecService.ts。
// 密码与跳板口令一律通过函数参数传入，本包不做任何存储。
package sshx

// ForwardType 端口映射方向：local 对应 ssh -L，remote 对应 ssh -R。
type ForwardType string

const (
	ForwardLocal  ForwardType = "local"
	ForwardRemote ForwardType = "remote"
)

// ForwardRule 一条端口映射规则。两头的 IP 都固定 127.0.0.1，用户只配端口。
type ForwardRule struct {
	Type       ForwardType
	ListenPort int
	TargetPort int
}

// Hop 一条跳板。用户名可以含冒号，那是名字的一部分。
type Hop struct {
	Host     string
	Port     int
	Username string
}

// AlgorithmOptions 保留 OpenSSH 的 + / ^ / - 前缀，拨号时展开成具体列表。
type AlgorithmOptions struct {
	Cipher        []string
	Kex           []string
	ServerHostKey []string
	HMAC          []string
}

// ConnectOptions 从 ssh 命令里认出来、连接时会用上的选项。
// 主机、端口、用户名、第一跳跳板仍放在会话自己的字段里。
type ConnectOptions struct {
	// 握手等待，毫秒。nil 用默认；0 表示命令里写了不超时，连接时改成有上限的等待。
	ReadyTimeoutMs *int
	// SSH 保活间隔，毫秒。nil 用默认（15s）；0 表示关掉。
	KeepaliveIntervalMs *int
	KeepaliveCountMax   *int
	Compress            bool
	Family              int // 0 不限制，4 只走 IPv4，6 只走 IPv6
	LocalAddress        string
	// "yes" / "no" / "accept-new"。
	StrictHostKeyChecking string
	Algorithms            *AlgorithmOptions
	// 没有跳板时，用这条本地命令代替直连。
	ProxyCommand string
}

// SessionConfig 拨号需要的会话字段（secret 不在本结构里，由调用方传入）。
type SessionConfig struct {
	ID       string
	Host     string
	Port     int
	Username string
	// UseKey 为真时按系统 ssh 的默认私钥登录，不使用传入的密码。
	UseKey bool
	// 按本机到目标主机的顺序排列的跳板；空表示直接连接。
	Jumps   []Hop
	Options *ConnectOptions
	// 端口映射规则，连接建立后挂在共享 SSH 连接上。
	Forwards []ForwardRule
}

// OsInfo 对端系统探测结果。Distro 是 /etc/os-release 的 ID 小写（如 debian），认不出为空。
type OsInfo struct {
	OS     string `json:"os"` // "windows" | "linux" | "macos" | "unknown"
	Distro string `json:"distro,omitempty"`
}

// ServerMetrics 运维面板的一次采集快照。内存、磁盘都是字节数；
// 远端某段采集失败时对应字段留零值，只有 exec 通道本身失败才返回 error。
type ServerMetrics struct {
	Hostname    string      `json:"hostname"`
	OsPretty    string      `json:"osPretty"`
	Kernel      string      `json:"kernel"`
	UptimeSec   int64       `json:"uptimeSec"`
	Cores       int         `json:"cores"`
	CpuPercent  float64     `json:"cpuPercent"`
	Load1       float64     `json:"load1"`
	Load5       float64     `json:"load5"`
	Load15      float64     `json:"load15"`
	MemTotal    uint64      `json:"memTotal"`
	MemAvail    uint64      `json:"memAvail"`
	Disks       []DiskUsage `json:"disks"`
	Procs       []ProcInfo  `json:"procs"`
	CollectedAt int64       `json:"collectedAt"` // 毫秒时间戳
}

// DiskUsage 一个挂载点的用量，字节数。
type DiskUsage struct {
	Mount      string  `json:"mount"`
	Total      uint64  `json:"total"`
	Used       uint64  `json:"used"`
	UsePercent float64 `json:"usePercent"`
}

// ProcInfo 一条进程。Rss 是字节数；Name 是命令首词的 basename，Cmd 是完整命令行。
type ProcInfo struct {
	Pid  int     `json:"pid"`
	User string  `json:"user"`
	Cpu  float64 `json:"cpu"`
	Mem  float64 `json:"mem"`
	Rss  uint64  `json:"rss"`
	Name string  `json:"name"`
	Cmd  string  `json:"cmd"`
}
