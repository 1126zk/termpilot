package terminal

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

// 提示符回归检测与 cwd 解析，逐一对应 TS TerminalService.ts 末尾的
// lastScreenLine / isPromptAgain / parsePromptCwd。

var (
	// OSC 序列：ESC ] ... (BEL | ESC \)。
	oscSeqRe = regexp.MustCompile("\x1b\\][^\x07\x1b]*(?:\x07|\x1b\\\\)")
	// CSI 序列：ESC [ 参数 中间字节 最终字节。
	csiSeqRe = regexp.MustCompile("\x1b\\[[0-?]*[ -/]*[@-~]")
	// 提示符结尾的 $、#、>、%、❯、» 那一段。
	promptTailRe = regexp.MustCompile(`[$#>%❯»]\s*$`)
	// PowerShell 提示符：PS C:\path>。
	psPromptRe = regexp.MustCompile(`PS\s+([A-Za-z]:[\\/][^>]*?)(?:>|$)`)
	// POSIX 默认形态：user@host:~/x$、[user@host /var/log]#、user@host ~>。
	posixPromptRe = regexp.MustCompile(`\[?\S+@\S+?[:\s](~[^\]$#%❯»>\s\x00-\x1f]*|/[^\]$#%❯»>\x00-\x1f]*)\]?[$#%❯»>]\s*$`)
)

// LastScreenLine 画面最后一个非空行，去掉 ANSI（CSI 和 OSC）。提示符就长这样。
func LastScreenLine(raw string) string {
	return strings.TrimSpace(screenLine(raw))
}

// screenLine 画面最后一个非空行，保留行尾空格。空格也占列，算折行时不能丢掉。
func screenLine(raw string) string {
	cleaned := csiSeqRe.ReplaceAllString(oscSeqRe.ReplaceAllString(raw, ""), "")
	cleaned = strings.ReplaceAll(cleaned, "\r", "\n")
	last := ""
	for _, line := range strings.Split(cleaned, "\n") {
		if strings.TrimSpace(line) != "" {
			last = line
		}
	}
	return last
}

// displayWidth 终端列数。ASCII 占 1 列，中日韩等宽字符占 2 列。
func displayWidth(s string) int {
	w := 0
	for _, r := range s {
		w += runeWidth(r)
	}
	return w
}

func runeWidth(r rune) int {
	if r < 0x20 || r == 0x7f {
		return 0
	}
	if isWideRune(r) {
		return 2
	}
	return 1
}

func isWideRune(r rune) bool {
	switch {
	case r >= 0x1100 && r <= 0x115F,
		r >= 0x2329 && r <= 0x232A,
		r >= 0x2E80 && r <= 0xA4CF,
		r >= 0xAC00 && r <= 0xD7A3,
		r >= 0xF900 && r <= 0xFAFF,
		r >= 0xFE10 && r <= 0xFE19,
		r >= 0xFE30 && r <= 0xFE6F,
		r >= 0xFF00 && r <= 0xFF60,
		r >= 0xFFE0 && r <= 0xFFE6,
		r >= 0x1F300 && r <= 0x1F64F,
		r >= 0x1F900 && r <= 0x1F9FF,
		r >= 0x20000 && r <= 0x3FFFD:
		return true
	default:
		return false
	}
}

// IsPromptAgain 最后一行是不是又回到了提示符。
func IsPromptAgain(last, before string) bool {
	if last == "" || utf8.RuneCountInString(last) > 300 {
		return false
	}
	if before != "" && last == before {
		return true
	}
	// 命令 cd 到别处后提示符前半截会变，结尾的 $、#、❯ 那一段不变
	if tail := strings.TrimSpace(promptTailRe.FindString(before)); tail != "" && strings.HasSuffix(last, tail) {
		return true
	}
	return promptTailRe.MatchString(last)
}

// ParsePromptCwd 从提示符里抠当前目录。认识 PowerShell 的 `PS C:\path>`，以及 POSIX
// 默认形态的 `user@host:~/x$`、`[user@host /var/log]#`、`user@host ~>`。
// `~` 原样返回，由 SFTP 层展开成登录目录。自定义提示符（starship、两行提示符等）
// 认不出来，返回空串。
func ParsePromptCwd(prompt string) string {
	if prompt == "" || utf8.RuneCountInString(prompt) > 300 {
		return ""
	}
	if m := psPromptRe.FindStringSubmatch(prompt); m != nil {
		return strings.TrimSpace(m[1])
	}
	m := posixPromptRe.FindStringSubmatch(prompt)
	if m == nil {
		return ""
	}
	return strings.TrimSpace(m[1])
}
