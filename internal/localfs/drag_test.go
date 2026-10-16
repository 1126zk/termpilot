package localfs

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestPrepareDragRejectsHomeAndRoot(t *testing.T) {
	svc := New()
	if _, err := svc.prepareDragPaths([]string{"."}); err == nil {
		t.Fatal("家目录应被拒绝")
	}
	root := "/"
	if runtime.GOOS == "windows" {
		root = "C:/"
	}
	if _, err := svc.prepareDragPaths([]string{root}); err == nil {
		t.Fatal("磁盘根目录应被拒绝")
	}
}

func TestRefuseBroadMove(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	homeAbs, err := filepath.Abs(home)
	if err != nil {
		t.Fatal(err)
	}
	if err := refuseBroadMove(homeAbs, homeAbs); err == nil {
		t.Fatal("家目录应被拒绝")
	}
	root := "/"
	if runtime.GOOS == "windows" {
		root = filepath.VolumeName(homeAbs) + `\`
	}
	if err := refuseBroadMove(root, homeAbs); err == nil {
		t.Fatal("磁盘根目录应被拒绝")
	}
	if err := refuseBroadMove(t.TempDir(), homeAbs); err != nil {
		t.Fatal(err)
	}
}

func TestPrepareDragFile(t *testing.T) {
	svc := New()
	dir := t.TempDir()
	file := filepath.Join(dir, "a.txt")
	writeFile(t, file, "a")
	missing := filepath.Join(dir, "missing")
	got, err := svc.prepareDragPaths([]string{strings.ReplaceAll(file, "\\", "/"), missing})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || !samePath(got[0], file) {
		t.Fatalf("got %v", got)
	}
}
