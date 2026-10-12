package mcpx

// 与 Electron 版 src/shared/types.ts 对齐的 MCP 运行态与前端合成链路结构。
// JSON tag 沿用 camelCase。

// McpRuntime 对应 TS McpRuntime：监听进程的当前状态，不写入数据库。
type McpRuntime struct {
	Running bool   `json:"running"`
	Port    int    `json:"port"`
	Clients int    `json:"clients"`
	Error   string `json:"error,omitempty"`
}

// TabOpen 对应 TS 发到 IPC.mcpOpenTab 的载荷。
type TabOpen struct {
	TermID    string  `json:"termId"`
	SessionID *string `json:"sessionId"`
	Kind      string  `json:"kind"` // "ssh" | "local"
	Title     string  `json:"title"`
}

// CaptureRequest 对应 TS CaptureRun（IPC.captureRun）。
// 行号两端都包含，0 是最旧的一行；发给前端时 EndLine 已被 +1 成开区间（对齐 TS）。
type CaptureRequest struct {
	ID        string `json:"id"`
	TermID    string `json:"termId"`
	Mode      string `json:"mode"` // "viewport" | "scrollback"
	StartLine *int   `json:"startLine,omitempty"`
	EndLine   *int   `json:"endLine,omitempty"`
	CropOnly  bool   `json:"cropOnly"`
}

// CaptureReply 对应 TS CaptureReply（IPC.captureReply）。
type CaptureReply struct {
	ID    string   `json:"id"`
	Paths []string `json:"paths,omitempty"`
	Note  string   `json:"note,omitempty"`
	Error string   `json:"error,omitempty"`
}

// TermLinesRequest 对应 TS 发到 IPC.termLines 的载荷。
// 发给前端时 EndLine 已被 +1 成开区间（对齐 TS）。
type TermLinesRequest struct {
	ID        string `json:"id"`
	TermID    string `json:"termId"`
	StartLine *int   `json:"startLine,omitempty"`
	EndLine   *int   `json:"endLine,omitempty"`
}

// TermLine 对应 TS TermLinesReply.lines 的元素。
type TermLine struct {
	N    int    `json:"n"`
	Text string `json:"text"`
}

// TermLinesReply 对应 TS TermLinesReply（IPC.termLinesReply）。
type TermLinesReply struct {
	ID        string     `json:"id"`
	Error     string     `json:"error,omitempty"`
	Length    *int       `json:"length,omitempty"`
	ViewportY *int       `json:"viewportY,omitempty"`
	Rows      *int       `json:"rows,omitempty"`
	Lines     []TermLine `json:"lines,omitempty"`
}

// TermModeRequest 对应 TS TermModeRun（IPC.termMode）。
type TermModeRequest struct {
	ID     string `json:"id"`
	TermID string `json:"termId"`
}

// TermModeReply 对应 TS TermModeReply（IPC.termModeReply）。
type TermModeReply struct {
	ID                string `json:"id"`
	ApplicationCursor *bool  `json:"applicationCursor,omitempty"`
	Error             string `json:"error,omitempty"`
}

// pngImage 一张待附到 MCP 结果里的截图（base64 前的原始字节）。
type pngImage struct {
	data []byte
}

// cliResult 对应 TS /cli 的 {ok, text} 形状。
type cliResult struct {
	OK   bool   `json:"ok"`
	Text string `json:"text"`
}
