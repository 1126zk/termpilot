//go:build windows

package localfs

import (
	"fmt"
	"os/exec"
	"strings"
	"syscall"

	"golang.org/x/sys/windows"
)

const wslExePath = `C:\Windows\System32\wsl.exe`

// ResolveWSL 把默认 WSL 发行版里的主目录和绝对路径映射到 Windows UNC 路径。
func (s *Service) ResolveWSL(p string) (string, error) {
	cmd := exec.Command(wslExePath, "--exec", "sh", "-c", `printf '%s\n%s' "$WSL_DISTRO_NAME" "$HOME"`)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("读取 WSL 主目录失败: %w", err)
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if len(lines) != 2 {
		return "", fmt.Errorf("读取 WSL 主目录失败: 返回内容无法识别")
	}
	return wslUNCPath(strings.TrimSpace(lines[0]), strings.TrimSpace(lines[1]), p)
}
