package storage

// 与 Electron 版 src/shared/types.ts 对齐的数据结构。
// JSON tag 沿用 camelCase，保证 Wails 桥接层/落盘 JSON 与现版形状一致。
// 时间戳一律是 Unix 毫秒（对应 TS 的 Date.now()）。

const (
	// MCPHost MCP 只监听本机回环，不允许改成其他地址。
	MCPHost = "127.0.0.1"
	// MCPDefaultPort 对应 TS 的 MCP_DEFAULT_PORT。
	MCPDefaultPort = 3927
)

// ForwardRule 一条端口映射规则。local 对应 ssh -L，remote 对应 ssh -R。
type ForwardRule struct {
	Type       string `json:"type"` // "local" | "remote"
	ListenPort int    `json:"listenPort"`
	TargetPort int    `json:"targetPort"`
}

// SshHop 一条跳板。用户名可以含冒号，那是名字的一部分。
type SshHop struct {
	Host      string `json:"host"`
	Port      int    `json:"port"`
	Username  string `json:"username"`
	HasSecret bool   `json:"hasSecret,omitempty"`
}

// SshHopInput 创建或修改一跳的输入，Secret 为明文，只在 IPC 调用内存中短暂存在。
type SshHopInput struct {
	Host     string  `json:"host"`
	Port     int     `json:"port"`
	Username string  `json:"username"`
	Secret   *string `json:"secret,omitempty"`
}

// SshAlgorithms 保留 OpenSSH 的 + / ^ / - 前缀，拨号时再交给 ssh2。
type SshAlgorithms struct {
	Cipher        []string `json:"cipher,omitempty"`
	Kex           []string `json:"kex,omitempty"`
	ServerHostKey []string `json:"serverHostKey,omitempty"`
	Hmac          []string `json:"hmac,omitempty"`
}

// SshConnectOptions 从 ssh 命令里认出来、连接时会用上的选项。
// 数字字段用指针以区分「未设置」和 0（0 是合法值：不超时/关保活）。
type SshConnectOptions struct {
	ReadyTimeoutMs        *int           `json:"readyTimeoutMs,omitempty"`
	KeepaliveIntervalMs   *int           `json:"keepaliveIntervalMs,omitempty"`
	KeepaliveCountMax     *int           `json:"keepaliveCountMax,omitempty"`
	Compress              bool           `json:"compress,omitempty"`
	Family                int            `json:"family,omitempty"` // 4 | 6
	LocalAddress          string         `json:"localAddress,omitempty"`
	StrictHostKeyChecking string         `json:"strictHostKeyChecking,omitempty"` // yes|no|accept-new
	Algorithms            *SshAlgorithms `json:"algorithms,omitempty"`
	ProxyCommand          string         `json:"proxyCommand,omitempty"`
}

// SessionConfig 会话配置（secret 不落盘在本结构里，单独加密存储）。认证只用密码。
type SessionConfig struct {
	ID         string             `json:"id"`
	PublicID   string             `json:"publicId"`
	Name       string             `json:"name"`
	Group      string             `json:"group"`
	Host       string             `json:"host"`
	Port       int                `json:"port"`
	Username   string             `json:"username"`
	Remark     *string            `json:"remark,omitempty"`
	HasSecret  bool               `json:"hasSecret"`
	Jumps      []SshHop           `json:"jumps,omitempty"`
	SshOptions *SshConnectOptions `json:"sshOptions,omitempty"`
	Forwards   []ForwardRule      `json:"forwards,omitempty"`
	Os         *string            `json:"os,omitempty"`
	CreatedAt  int64              `json:"createdAt"`
	UpdatedAt  int64              `json:"updatedAt"`
}

// SessionInput 创建/更新会话时的输入，Secret 为明文。
// 指针字段语义对应 TS 的 undefined（nil = 不修改/不写入）；
// 空字符串 Secret 表示清掉已存凭据。
type SessionInput struct {
	Name     string  `json:"name"`
	Group    string  `json:"group"`
	Host     string  `json:"host"`
	Port     int     `json:"port"`
	Username string  `json:"username"`
	Remark   *string `json:"remark,omitempty"`
	Secret   *string `json:"secret,omitempty"`
	// nil = 不修改；非 nil = 按本机到目标主机的顺序整体替换（空切片清掉）。
	Jumps *[]SshHopInput `json:"jumps,omitempty"`
	// nil = 不修改；非 nil（哪怕零值结构）= 整体替换，清洗后为空则存 NULL。
	SshOptions *SshConnectOptions `json:"sshOptions,omitempty"`
	// nil = 不修改；非 nil = 整体替换（空切片清掉）。
	Forwards *[]ForwardRule `json:"forwards,omitempty"`
}

// Snippet 一条命令片段。
type Snippet struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Command   string `json:"command"`
	CreatedAt int64  `json:"createdAt"`
}

// HistoryEntry 一条历史指令，按终端窗口隔离。
type HistoryEntry struct {
	ID      int64  `json:"id"`
	TermID  string `json:"termId"`
	Command string `json:"command"`
	At      int64  `json:"at"`
}

// Appearance 外观设置。
type Appearance struct {
	Theme        string `json:"theme"`
	TerminalFont string `json:"terminalFont"`
	TerminalSize int    `json:"terminalSize"`
}

// McpSettings 已保存的 MCP 服务端配置，token 为明文。
type McpSettings struct {
	Enabled          bool   `json:"enabled"`
	Host             string `json:"host"`
	Port             int    `json:"port"`
	Token            string `json:"token"`
	ConfirmDangerous bool   `json:"confirmDangerous"`
}

// McpSettingsInput MCP 设置输入。
type McpSettingsInput struct {
	Enabled          bool   `json:"enabled"`
	Port             int    `json:"port"`
	Token            string `json:"token"`
	ConfirmDangerous bool   `json:"confirmDangerous"`
}

// McpAuditEntry 一条 MCP 工具调用审计。
type McpAuditEntry struct {
	At     int64  `json:"at"`
	Tool   string `json:"tool"`
	Ok     bool   `json:"ok"`
	Detail string `json:"detail"`
}

// DefaultAppearance 对应 TS 的 DEFAULT_APPEARANCE。
var DefaultAppearance = Appearance{
	Theme:        "termius-dark",
	TerminalFont: "Source Code Pro",
	TerminalSize: 14,
}

// legacyThemeIDs 废弃主题 id 的归宿（TS LEGACY_THEME_IDS）。
var legacyThemeIDs = map[string]string{
	"dark":     "termius-dark",
	"light":    "termius-light",
	"one-dark": "atom-one-dark",
	"nord":     "nord-dark",
}

// unifiedThemeIDs 统一主题 id 全集（与 TS UNIFIED_THEMES / TERMINAL_THEMES 的 id 一致）。
var unifiedThemeIDs = map[string]bool{
	"termius-dark": true, "termius-light": true,
	"flexoki-dark": true, "flexoki-light": true,
	"kanagawa-wave": true, "kanagawa-dragon": true, "kanagawa-lotus": true,
	"hacker-blue": true, "hacker-green": true, "hacker-red": true,
	"everforest-dark": true, "everforest-light": true,
	"night-owl": true, "light-owl": true,
	"aura":      true,
	"rose-pine": true, "rose-pine-moon": true, "rose-pine-dawn": true,
	"cobalt2":      true,
	"octocat-dark": true, "octocat-light": true,
	"ayu-dark": true, "ayu-light": true,
	"cyberpunk": true, "cyberpunk-scarlet": true,
	"romania-night": true, "romania-day": true,
	"aubergine": true, "peach-fresh": true,
	"1984-dark": true, "1984-light": true,
	"winter-night": true, "winter-day": true,
	"tokyo-night": true, "tokyo-day": true,
	"catppuccin-latte": true, "catppuccin-mocha": true,
	"diwali": true, "movember": true,
	"atom-one-dark": true, "atom-one-light": true,
	"halloween": true, "dia-de-muertos": true,
	"gruvbox-dark": true, "gruvbox-light": true,
	"material-dark": true, "material-light": true,
	"manhattan": true, "plastic-world": true,
	"basic": true, "homebrew": true, "grass": true, "man-page": true,
	"novel": true, "ocean": true, "pro": true, "red-sands": true,
	"solarized-dark": true, "solarized-light": true,
	"silver-aerogel": true, "dracula": true, "monokai": true,
	"nord-light": true, "nord-dark": true,
}

// unifiedThemeID 按 id 找统一主题，废弃 id 先映射，找不到回退「深色」。
func unifiedThemeID(id string) string {
	if mapped, ok := legacyThemeIDs[id]; ok {
		id = mapped
	}
	if unifiedThemeIDs[id] {
		return id
	}
	return DefaultAppearance.Theme
}

// ParseAppearance 对应 TS 的 parseAppearance：宽容地清洗输入，全部字段回落到默认值。
func ParseAppearance(input Appearance) Appearance {
	out := DefaultAppearance
	if input.Theme != "" {
		out.Theme = unifiedThemeID(input.Theme)
	}
	if trimmed := trimSpace(input.TerminalFont); trimmed != "" {
		out.TerminalFont = trimmed
	}
	if input.TerminalSize >= 10 && input.TerminalSize <= 24 {
		out.TerminalSize = input.TerminalSize
	}
	return out
}
