package mcpx

import (
	"crypto/rand"
	"encoding/hex"
	"regexp"
	"strings"
)

// 对应 src/shared/ids.ts：conn- / term- 编号。

var (
	connIDRe = regexp.MustCompile(`(?i)^conn-[0-9a-f]{8}$`)
	termIDRe = regexp.MustCompile(`(?i)^term-[0-9a-f]{8}$`)
)

// NewTermID 对应 TS newTermId：term- + 4 字节随机 hex。
func NewTermID() string {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return "term-" + hex.EncodeToString(b[:])
}

// IsConnID 对应 TS isConnId。
func IsConnID(value string) bool {
	return connIDRe.MatchString(strings.TrimSpace(value))
}

// IsTermID 对应 TS isTermId。
func IsTermID(value string) bool {
	return termIDRe.MatchString(strings.TrimSpace(value))
}
