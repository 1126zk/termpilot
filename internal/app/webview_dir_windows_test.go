//go:build windows

package app

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestWebviewDataDir(t *testing.T) {
	// 首个窗口沿用默认目录（%AppData%\<exe>），不带 windows 子目录
	first := WebviewDataDir([]string{"TermPilot.exe"})
	if first == "" || strings.Contains(filepath.ToSlash(first), "/windows/") {
		t.Fatalf("first window should use base dir, got %q", first)
	}
	// 额外窗口抢槽位目录
	second := WebviewDataDir([]string{"TermPilot.exe", "--extra-window"})
	if filepath.Base(filepath.Dir(second)) != "windows" {
		t.Fatalf("extra window should get a slot dir, got %q", second)
	}
	// 再开一扇抢到下一个槽，不复用已占的
	third := WebviewDataDir([]string{"TermPilot.exe", "--extra-window"})
	if third == second {
		t.Fatalf("two extra windows should not share slot %q", second)
	}
}
