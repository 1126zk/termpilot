package mcpx

import "regexp"

// 危险操作规则，逐字符照搬 TS McpService.ts 的 SENSITIVE / DANGEROUS。
// Go 的 regexp（RE2）与 JS 正则在这两条上没有语义差异。

// sensitiveRe 对应 TS SENSITIVE：系统目录与 Windows 系统盘目录。
var sensitiveRe = regexp.MustCompile(`(?i)^(/etc|/boot|/bin|/sbin|/usr|/dev|/sys|/proc)(/|$)|^[A-Za-z]:\\Windows\\`)

// dangerousRe 对应 TS DANGEROUS：删除/格式化/关机命令、递归改权限、重定向进系统目录。
var dangerousRe = regexp.MustCompile("(?i)(?:^|[;&|`\\n])\\s*(?:sudo\\s+)?(rm|rmdir|mkfs|dd|shutdown|reboot|poweroff|halt)\\b|chmod\\s+[^\\n]*-[^\\n]*R|chown\\s+[^\\n]*-[^\\n]*R|>\\s*/(?:dev|etc)\\b")
