//go:build !windows

package app

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

func isWindows() bool { return false }

func ensureWindowsPath(dir string) {}

// linkUserBin 对应 install-cli.ts：~/.local/bin/termpilot 软链 + 写 profile。
func linkUserBin(target string) {
	home, err := os.UserHomeDir()
	if err != nil {
		return
	}
	dir := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return
	}
	link := filepath.Join(dir, "termpilot")
	current, _ := os.Readlink(link)
	if current != target {
		if _, err := os.Lstat(link); err == nil && current == "" {
			println("[TermPilot] ~/.local/bin/termpilot 已有别的文件，没有覆盖")
		} else {
			_ = os.Remove(link)
			_ = os.Symlink(target, link)
		}
	}
	ensureUnixPath(home)
}

func ensureUnixPath(home string) {
	var files []string
	if runtime.GOOS == "darwin" {
		files = []string{filepath.Join(home, ".zprofile")}
	} else {
		files = []string{filepath.Join(home, ".profile"), filepath.Join(home, ".bashrc")}
	}
	const line = `export PATH="$HOME/.local/bin:$PATH" # TermPilot`
	for _, file := range files {
		data, _ := os.ReadFile(file)
		text := string(data)
		if strings.Contains(text, ".local/bin") {
			continue
		}
		if text != "" && !strings.HasSuffix(text, "\n") {
			text += "\n"
		}
		_ = os.WriteFile(file, []byte(text+line+"\n"), 0o644)
	}
}

func revealFile(path string) error {
	if runtime.GOOS == "darwin" {
		return exec.Command("open", "-R", path).Start()
	}
	return exec.Command("xdg-open", filepath.Dir(path)).Start()
}

func copyImageToClipboard(path string) error {
	if runtime.GOOS == "darwin" {
		script := fmt.Sprintf(`set the clipboard to (read (POSIX file %q) as «class PNGf»)`, path)
		return exec.Command("osascript", "-e", script).Run()
	}
	return errors.New("当前平台暂不支持复制图片到剪贴板")
}
