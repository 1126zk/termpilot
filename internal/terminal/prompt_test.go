package terminal

import (
	"strings"
	"testing"
)

func TestLastScreenLine(t *testing.T) {
	cases := []struct{ raw, want string }{
		{"line1\r\nline2$ ", "line2$"},
		{"\x1b[32muser@host:~$\x1b[0m ", "user@host:~$"},      // CSI 颜色
		{"a\x1b]0;窗口标题\x07b\r\nroot# ", "root#"},              // OSC 标题
		{"a\x1b]8;;http://x\x1b\\b\r\nPS C:\\> ", "PS C:\\>"}, // OSC 以 ESC\ 结尾
		{"only\r", "only"},
		{"\r\n\r\n", ""},
	}
	for _, c := range cases {
		if got := LastScreenLine(c.raw); got != c.want {
			t.Errorf("LastScreenLine(%q) = %q, want %q", c.raw, got, c.want)
		}
	}
}

func TestParsePromptCwd(t *testing.T) {
	cases := []struct{ prompt, want string }{
		{`PS C:\Users\foo>`, `C:\Users\foo`},
		{`PS D:\work\proj> `, `D:\work\proj`},
		{"user@host:~/proj$", "~/proj"},
		{"[user@host /var/log]#", "/var/log"},
		{"user@host ~>", "~"},
		{"root@web-01:/etc/nginx$ ", "/etc/nginx"},
		{"✨ starship ❯", ""}, // 自定义提示符认不出来
		{"", ""},
		{strings.Repeat("x", 301), ""},
	}
	for _, c := range cases {
		if got := ParsePromptCwd(c.prompt); got != c.want {
			t.Errorf("ParsePromptCwd(%q) = %q, want %q", c.prompt, got, c.want)
		}
	}
}

func TestIsPromptAgain(t *testing.T) {
	cases := []struct {
		last, before string
		want         bool
	}{
		{"", "x$", false},
		{strings.Repeat("y", 301), "x$", false},
		{"user@host:~$", "user@host:~$", true},    // 完全一样
		{"user@host:/etc$", "user@host:~$", true}, // cd 之后结尾 $ 不变
		{"user@host:~❯", "user@host:~❯", true},
		{"total 12", "user@host:~$", false}, // 命令输出不是提示符
		{"root#", "", true},                 // before 为空时靠结尾符号兜底
		{"hello world", "", false},
	}
	for _, c := range cases {
		if got := IsPromptAgain(c.last, c.before); got != c.want {
			t.Errorf("IsPromptAgain(%q, %q) = %v, want %v", c.last, c.before, got, c.want)
		}
	}
}
