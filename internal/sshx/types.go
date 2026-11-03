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
}

// OsInfo 对端系统探测结果。Distro 是 /etc/os-release 的 ID 小写（如 debian），认不出为空。
type OsInfo struct {
	OS     string `json:"os"` // "windows" | "linux" | "macos" | "unknown"
	Distro string `json:"distro,omitempty"`
}

// ServerMetrics 运维面板的一次动态采集快照。内存、磁盘都是字节数；
// 远端某段采集失败时对应字段留零值，只有 exec 通道本身失败才返回 error。
// 主机名/系统/内核/IP 这些静态身份在 ServerInfo，不在这里。
type ServerMetrics struct {
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
	// 本机正在监听的端口（TCP LISTEN 与 UDP），按端口升序
	Ports       []PortInfo  `json:"ports"`
	// 真实网卡合计的收发速度，字节/秒。不含回环和容器、虚拟机的虚拟网卡
	NetRxBps    float64 `json:"netRxBps"`
	NetTxBps    float64 `json:"netTxBps"`
	CollectedAt int64   `json:"collectedAt"` // 毫秒时间戳
}

// ServerInfo 服务器的静态身份，基本不变，面板打开时采一次并缓存。
// LanIps 是内网 IPv4（可能多个），WanIp 是公网 IP（先问云厂商元数据，外部服务兜底），拿不到时为空串。
type ServerInfo struct {
	Hostname string   `json:"hostname"`
	OsPretty string   `json:"osPretty"`
	Kernel   string   `json:"kernel"`
	LanIps   []string `json:"lanIps"`
	WanIp    string   `json:"wanIp"`
}

// DockerInfo 一次 Docker 采集。Available 为假表示服务器没装 docker。
type DockerInfo struct {
	Available  bool              `json:"available"`
	// Running 装了不等于在跑：daemon 活着（docker info 能通）才是 true。
	Running    bool              `json:"running"`
	Containers []DockerContainer `json:"containers"`
	Images     []DockerImage     `json:"images"`
	Volumes    []DockerVolume    `json:"volumes"`
	Networks   []DockerNetwork   `json:"networks"`
	// DaemonJson /etc/docker/daemon.json 原文；没装 docker 或文件不存在时是空串。
	DaemonJson string `json:"daemonJson"`
}

// DockerContainer 一个容器。State 是 running/exited 等原始状态，Status 是给人看的
// （Up 2 hours / Exited (0) 3 days ago）。
type DockerContainer struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Image  string `json:"image"`
	State  string `json:"state"`
	Status string `json:"status"`
	Ports  string `json:"ports"`
}

// DockerImage 一个镜像。Size、Created 直接用 docker 的人读格式（187MB、2 weeks ago）。
type DockerImage struct {
	Repository string `json:"repository"`
	Tag        string `json:"tag"`
	ID         string `json:"id"`
	Size       string `json:"size"`
	Created    string `json:"created"`
}

// DockerVolume 一个卷。docker volume ls 有用的就名字和驱动两列。
type DockerVolume struct {
	Name   string `json:"name"`
	Driver string `json:"driver"`
}

// DockerNetwork 一个网络。Scope 是 local / swarm / global。
type DockerNetwork struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Driver string `json:"driver"`
	Scope  string `json:"scope"`
}

// WebInfo 一次网站服务采集。网站服务一律容器化（固定容器名 nginx/caddy），
// 宿主机直装的不在管理范围内。DockerAvailable 为假表示服务器没装 docker。
type WebInfo struct {
	DockerAvailable bool           `json:"dockerAvailable"`
	Nginx           WebServiceInfo `json:"nginx"`
	Caddy           WebServiceInfo `json:"caddy"`
	// Certs nginx 各域名证书的剩余有效天数（certbot 签的）；caddy 自动续不跟踪。负数 = 已过期。
	Certs map[string]int `json:"certs"`
}

// WebServiceInfo 一个网站服务。State 是容器状态（running/exited 等），空串 = 还没装；
// Files 是配置文件的（路径, 原文）列表，空 = 一个配置文件都没有。
type WebServiceInfo struct {
	State string        `json:"state"`
	Files []WebConfFile `json:"files"`
}

// WebConfFile 一份配置文件原文。Content 为空串 = 文件存在但内容是空的。
type WebConfFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
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

// PortInfo 一个监听端口。Proto 是 tcp / udp；Addr 是监听地址（0.0.0.0、127.0.0.1、[::] 等）。
// 非 root 采集时其他进程的 Pid / Name 可能拿不到，分别为 0 和空串。
// Cmd 是 /proc/<pid>/cmdline 的完整命令行，Exe 是 readlink /proc/<pid>/exe 的可执行路径，
// 用来区分同名程序；读不到时为空串。
type PortInfo struct {
	Proto string `json:"proto"`
	Addr  string `json:"addr"`
	Port  int    `json:"port"`
	Pid   int    `json:"pid"`
	Name  string `json:"name"`
	Cmd   string `json:"cmd"`
	Exe   string `json:"exe"`
}
