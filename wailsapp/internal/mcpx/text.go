package mcpx

import (
	"fmt"
	"os"
	"regexp"
	"strings"
	"unicode/utf8"
)

// 文本处理辅助，对应 TS McpService.ts 里的 stripAnsi / agentText / clip /
// clipCommand / formatLines / pngsIn。

var (
	oscRe      = regexp.MustCompile("\x1b\\][^\x07]*(\x07|\x1b\\\\)")
	csiRe      = regexp.MustCompile("\x1b\\[[0-?]*[ -/]*[@-~]")
	trailWSRe  = regexp.MustCompile(`[ \t]+$`)
	multiNLRe  = regexp.MustCompile(`\n{3,}`)
	pngLineRe  = regexp.MustCompile(`(?i)\.png$`)
	maxPNGSize = 6_000_000
)

// stripANSI 对应 TS stripAnsi：去掉 OSC 和 CSI 控制序列。
func stripANSI(text string) string {
	text = oscRe.ReplaceAllString(text, "")
	return csiRe.ReplaceAllString(text, "")
}

// agentText 对应 TS agentText：交给助手的回显。去掉控制符，回车收拢成换行，
// 行尾空白去掉，连续的空行只留一个。行首缩进和行内的对齐保留。
func agentText(text string) string {
	text = stripANSI(text)
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		lines[i] = trailWSRe.ReplaceAllString(line, "")
	}
	text = strings.Join(lines, "\n")
	text = multiNLRe.ReplaceAllString(text, "\n\n")
	return strings.TrimSpace(text)
}

// clip 对应 TS clip：超长只留最后 max 个字符。
func clip(text string, max int) string {
	if utf8.RuneCountInString(text) <= max {
		return text
	}
	runes := []rune(text)
	return fmt.Sprintf("%s\n…已截断，只保留最后 %d 个字符", string(runes[len(runes)-max:]), max)
}

// clipCommand 对应 TS clipCommand：只截这次命令自己的输出。头尾都留。
func clipCommand(text string, max int) string {
	runes := []rune(text)
	if len(runes) <= max {
		return text
	}
	head := max / 2
	tail := max - head
	return string(runes[:head]) + "\n…中间已截断…\n" + string(runes[len(runes)-tail:])
}

// formatLines 对应 TS formatLines。
func formatLines(result TermLinesReply) string {
	lines := result.Lines
	length := 0
	if result.Length != nil {
		length = *result.Length
	}
	from := 0
	if result.ViewportY != nil {
		from = *result.ViewportY
	}
	rows := 1
	if result.Rows != nil {
		rows = *result.Rows
	}
	to := from + max(0, rows-1)
	if len(lines) == 0 {
		if length == 0 {
			return "缓冲是空的"
		}
		return fmt.Sprintf("行号超出缓冲，一共 %d 行", length)
	}
	var body strings.Builder
	for i, line := range lines {
		if i > 0 {
			body.WriteString("\n")
		}
		fmt.Fprintf(&body, "%d|%s", line.N, line.Text)
	}
	cap := ""
	if len(lines) >= 200 {
		cap = "\n一次最多返回 200 行，其余请缩小范围再查。"
	}
	return fmt.Sprintf("缓冲共 %d 行，当前画面是第 %d–%d 行。\n%s%s", length, from, to, body.String(), cap)
}

// pngsIn 对应 TS pngsIn：从结果文本里找 .png 行，读文件转成 base64 图片。
// 空文件和超过 6MB 的跳过。
func pngsIn(text string) []pngImage {
	var images []pngImage
	for _, line := range strings.Split(text, "\n") {
		file := strings.TrimSpace(line)
		if !pngLineRe.MatchString(file) {
			continue
		}
		data, err := os.ReadFile(file)
		if err != nil || len(data) == 0 || len(data) > maxPNGSize {
			continue
		}
		images = append(images, pngImage{data: data})
	}
	return images
}

func clipRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}

// jsonString 对应 JSON.stringify 的字符串编码：不转义 HTML 字符（<, >, &），
// 非 ASCII 字符原样保留。
func jsonString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		default:
			if r < 0x20 {
				fmt.Fprintf(&b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}
