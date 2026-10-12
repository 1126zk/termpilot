package terminal

import (
	"crypto/rand"
	"encoding/hex"
	"regexp"
	"strings"
)

// conn-/term- 短 ID 生成与校验，对应 src/shared/ids.ts。

func shortID() string {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err) // crypto/rand 不可用属系统级故障
	}
	return hex.EncodeToString(b[:])
}

// NewConnID 保存的连接。改名、改备注都不换这个编号。
func NewConnID() string { return "conn-" + shortID() }

// NewTermID 已经打开的终端。界面打开、助手打开、反向连入都用这一个前缀。
func NewTermID() string { return "term-" + shortID() }

var (
	connIDRe = regexp.MustCompile(`(?i)^conn-[0-9a-f]{8}$`)
	termIDRe = regexp.MustCompile(`(?i)^term-[0-9a-f]{8}$`)
)

func IsConnID(value string) bool { return connIDRe.MatchString(strings.TrimSpace(value)) }

func IsTermID(value string) bool { return termIDRe.MatchString(strings.TrimSpace(value)) }
