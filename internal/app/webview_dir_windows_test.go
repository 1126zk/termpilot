//go:build windows

package app

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestWebviewDataDir(t *testing.T) {
	// 第一个抢锁的进程沿用默认目录（%AppData%\<exe>），不带 windows 子目录
	first := WebviewDataDir()
	if first == "" || strings.Contains(filepath.ToSlash(first), "/windows/") {
		t.Fatalf("first window should use base dir, got %q", first)
	}
	// 基础目录已被占，后来的进程抢槽位目录——不管带不带 --extra-window
	second := WebviewDataDir()
	if filepath.Base(filepath.Dir(second)) != "windows" {
		t.Fatalf("second window should get a slot dir, got %q", second)
	}
	// 再开一扇抢到下一个槽，不复用已占的
	third := WebviewDataDir()
	if third == second || third == first {
		t.Fatalf("windows should not share dir: first=%q second=%q third=%q", first, second, third)
	}
	if filepath.Base(filepath.Dir(third)) != "windows" {
		t.Fatalf("third window should get a slot dir, got %q", third)
	}
}
