package mcpx

import (
	"strings"
)

// 对应 src/shared/term-keys.ts：Agent 可以用名字发送的按键及其终端编码。

// TermKeys 对应 TS TERM_KEYS（顺序一致，term_write.keys 的枚举值）。
var TermKeys = []string{
	"up", "down", "left", "right",
	"enter", "tab", "backspace", "esc", "space", "home", "end",
	"pageup", "pagedown",
	"ctrl-c", "ctrl-d", "ctrl-z", "ctrl-l",
	"f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
}

// moves 会触发光标模式查询的按键（TS MOVES）。
var moves = map[string]bool{
	"up": true, "down": true, "left": true, "right": true, "home": true, "end": true,
}

var arrowLetters = map[string]string{
	"up": "A", "down": "B", "right": "C", "left": "D",
}

var fnKeys = map[string]string{
	"f1": "\x1bOP", "f2": "\x1bOQ", "f3": "\x1bOR", "f4": "\x1bOS",
	"f5": "\x1b[15~", "f6": "\x1b[17~", "f7": "\x1b[18~", "f8": "\x1b[19~",
	"f9": "\x1b[20~", "f10": "\x1b[21~", "f11": "\x1b[23~", "f12": "\x1b[24~",
}

// CanonicalKey 对应 TS canonicalKey：把 Ctrl+C、^C 收成 ctrl-c 这种名字。
func CanonicalKey(name string) string {
	key := strings.ToLower(strings.TrimSpace(name))
	key = strings.Join(strings.Fields(key), "")
	key = strings.ReplaceAll(key, "+", "-")
	if strings.HasPrefix(key, "^") && len(key) == 2 {
		return "ctrl-" + key[1:]
	}
	return key
}

// TermInput 对应 TS encodeTermInput 的参数。
type TermInput struct {
	Keys              []string
	Text              string
	Data              string
	Submit            bool
	ApplicationCursor bool
}

// EncodeTermInput 对应 TS encodeTermInput：先按 keys，再输入 text，submit 为真时最后补回车。
func EncodeTermInput(opts TermInput) string {
	var out strings.Builder
	out.WriteString(opts.Data)
	for _, key := range opts.Keys {
		out.WriteString(encodeKey(key, opts.ApplicationCursor))
	}
	out.WriteString(opts.Text)
	if opts.Submit {
		out.WriteString("\r")
	}
	return out.String()
}

func encodeKey(key string, applicationCursor bool) string {
	if letter, ok := arrowLetters[key]; ok {
		if applicationCursor {
			return "\x1bO" + letter
		}
		return "\x1b[" + letter
	}
	switch key {
	case "enter":
		return "\r"
	case "tab":
		return "\t"
	case "backspace":
		return "\x7f"
	case "esc":
		return "\x1b"
	case "space":
		return " "
	case "home":
		if applicationCursor {
			return "\x1bOH"
		}
		return "\x1b[H"
	case "end":
		if applicationCursor {
			return "\x1bOF"
		}
		return "\x1b[F"
	case "pageup":
		return "\x1b[5~"
	case "pagedown":
		return "\x1b[6~"
	case "ctrl-c":
		return "\x03"
	case "ctrl-d":
		return "\x04"
	case "ctrl-z":
		return "\x1a"
	case "ctrl-l":
		return "\x0c"
	}
	if seq, ok := fnKeys[key]; ok {
		return seq
	}
	return ""
}
