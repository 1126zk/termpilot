//go:build windows

package app

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWriteIfChanged(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "nested", "a.bin")
	changed, err := writeIfChanged(path, []byte("one"))
	if err != nil || !changed {
		t.Fatalf("首次写入 changed=%v err=%v", changed, err)
	}
	changed, err = writeIfChanged(path, []byte("one"))
	if err != nil || changed {
		t.Fatalf("相同内容 changed=%v err=%v", changed, err)
	}
	changed, err = writeIfChanged(path, []byte("two"))
	if err != nil || !changed {
		t.Fatalf("新内容 changed=%v err=%v", changed, err)
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != "two" {
		t.Fatalf("内容 %q err %v", got, err)
	}
}

func TestInstallContextMenuLive(t *testing.T) {
	if os.Getenv("TERMPILOT_INSTALL_MENU") != "1" {
		t.Skip()
	}
	exe := os.Getenv("TERMPILOT_MENU_EXE")
	if exe == "" {
		t.Fatal("缺少 TERMPILOT_MENU_EXE")
	}
	a := &App{userData: userDataDir(), launchApp: exe}
	if err := a.installContextMenuErr(); err != nil {
		t.Fatal(err)
	}
}

func TestInstallContextMenuSkipsSmoke(t *testing.T) {
	t.Setenv("TERMPILOT_SMOKE", "1")
	a := &App{userData: t.TempDir(), launchApp: `C:\nope\TermPilot.exe`}
	if err := a.installContextMenuErr(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(a.userData, "shell")); !os.IsNotExist(err) {
		t.Fatalf("冒烟模式不应写右键文件: %v", err)
	}
}
