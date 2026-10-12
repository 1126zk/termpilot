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
	cleaned := csiSeqRe.ReplaceAllString(oscSeqRe.ReplaceAllString(raw, ""), "")
	cleaned = strings.ReplaceAll(cleaned, "\r", "\n")
	last := ""
	for _, line := range strings.Split(cleaned, "\n") {
		if strings.TrimSpace(line) != "" {
			last = line
		}
	}
	return strings.TrimSpace(last)
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
