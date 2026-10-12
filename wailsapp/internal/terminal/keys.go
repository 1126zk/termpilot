package terminal

import (
	"fmt"
	"regexp"
	"strings"
)

// Agent 按键白名单 → ANSI 序列，对应 src/shared/term-keys.ts。
// 方向键会按终端当前的光标模式（applicationCursor）编码。

// TermKeys 对应 TS TERM_KEYS：Agent 可以用名字发送的按键。
var TermKeys = []string{
	"up", "down", "left", "right",
	"enter", "tab", "backspace", "esc", "space",
	"home", "end", "pageup", "pagedown",
	"ctrl-c", "ctrl-d", "ctrl-z", "ctrl-l",
	"f1", "f2", "f3", "f4", "f5", "f6",
	"f7", "f8", "f9", "f10", "f11", "f12",
}

var arrowKeys = map[string]string{
	"up": "A", "down": "B", "right": "C", "left": "D",
}

var fnKeys = map[string]string{
	"f1": "\x1bOP", "f2": "\x1bOQ", "f3": "\x1bOR", "f4": "\x1bOS",
	"f5": "\x1b[15~", "f6": "\x1b[17~", "f7": "\x1b[18~", "f8": "\x1b[19~",
	"f9": "\x1b[20~", "f10": "\x1b[21~", "f11": "\x1b[23~", "f12": "\x1b[24~",
}

// InputOptions 对应 TS encodeTermInput 的参数。
type InputOptions struct {
	// 先按 keys，再输入 text，submit 为真时最后补回车。
	Keys              []string
	Text              string
	Data              string
	Submit            bool
	ApplicationCursor bool
}

// EncodeTermInput 对应 TS encodeTermInput。按键名不认识时返回错误。
func EncodeTermInput(opts InputOptions) (string, error) {
	var out strings.Builder
	out.WriteString(opts.Data)
	for _, key := range opts.Keys {
		seq, err := encodeKey(key, opts.ApplicationCursor)
		if err != nil {
			return "", err
		}
		out.WriteString(seq)
	}
	out.WriteString(opts.Text)
	if opts.Submit {
		out.WriteByte('\r')
	}
	return out.String(), nil
}

var keySpacesRe = regexp.MustCompile(`\s+`)

// CanonicalKey 对应 TS canonicalKey：把 Ctrl+C、^C 收成 ctrl-c 这种名字。
func CanonicalKey(name string) string {
	key := strings.ToLower(strings.TrimSpace(name))
	key = keySpacesRe.ReplaceAllString(key, "")
	key = strings.ReplaceAll(key, "+", "-")
	if strings.HasPrefix(key, "^") && len(key) == 2 {
		return "ctrl-" + key[1:]
	}
	return key
}

func encodeKey(key string, applicationCursor bool) (string, error) {
	if letter, ok := arrowKeys[key]; ok {
		if applicationCursor {
			return "\x1bO" + letter, nil
		}
		return "\x1b[" + letter, nil
	}
	switch key {
	case "enter":
		return "\r", nil
	case "tab":
		return "\t", nil
	case "backspace":
		return "\x7f", nil
	case "esc":
		return "\x1b", nil
	case "space":
		return " ", nil
	case "home":
		if applicationCursor {
			return "\x1bOH", nil
		}
		return "\x1b[H", nil
	case "end":
		if applicationCursor {
			return "\x1bOF", nil
		}
		return "\x1b[F", nil
	case "pageup":
		return "\x1b[5~", nil
	case "pagedown":
		return "\x1b[6~", nil
	case "ctrl-c":
		return "\x03", nil
	case "ctrl-d":
		return "\x04", nil
	case "ctrl-z":
		return "\x1a", nil
	case "ctrl-l":
		return "\x0c", nil
	}
	if seq, ok := fnKeys[key]; ok {
		return seq, nil
	}
	return "", fmt.Errorf("不认识的按键: %s", key)
}
