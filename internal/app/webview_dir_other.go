//go:build !windows

package app

// WebviewDataDir 只有 Windows 需要（WebviewUserDataPath 是 Windows 专属选项）。
// 返回空串表示走默认。
func WebviewDataDir() string {
	return ""
}
