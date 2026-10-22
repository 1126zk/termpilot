//go:build windows

package terminal

import (
	"os"
	"os/exec"
	"regexp"
	"strings"
	"syscall"

	"golang.org/x/sys/windows"
)

// 本机 shell 探测（Windows），照搬 TS localShellExe / detectLocalShells 的顺序与判定。

const (
	pwshExePath    = `C:\Program Files\PowerShell\7\pwsh.exe`
	gitBashExePath = `C:\Program Files\Git\bin\bash.exe`
	wslExePath     = `C:\Windows\System32\wsl.exe`
)

var (
	gitPathHint  = regexp.MustCompile(`(?i)git`)
	pwshPathHint = regexp.MustCompile(`(?i)pwsh|powershell`)
)

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// findExe 用 where.exe 在 PATH 里找程序，按路径特征过滤（比如 bash.exe 要 Git 的，
// 不要 WSL 的）。where 找到的不查 fileExists：WindowsApps 商店别名是 reparse point，
// fs 探不到但能启动。
func findExe(name string, pathHint *regexp.Regexp, fallbacks ...string) string {
	cmd := exec.Command("where.exe", name)
	// GUI 程序起控制台子进程会闪黑窗，藏掉（同 sshx hideWindow）。
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
	out, err := cmd.Output()
	if err == nil {
		for _, line := range strings.Split(string(out), "\n") {
			p := strings.TrimSpace(line)
			if p != "" && pathHint.MatchString(p) {
				return p
			}
		}
	}
	for _, candidate := range fallbacks {
		if fileExists(candidate) {
			return candidate
		}
	}
	return ""
}

func gitBashExe() string {
	return findExe("bash.exe", gitPathHint, gitBashExePath, `C:\Program Files (x86)\Git\bin\bash.exe`)
}

func pwshExe() string {
	return findExe("pwsh.exe", pwshPathHint, pwshExePath)
}

// localShellExe 本机终端按壳类型取可执行程序。找不到对应程序时退回 PowerShell。
func localShellExe(shell string) string {
	switch shell {
	case "cmd":
		return "cmd.exe"
	case "pwsh":
		if exe := pwshExe(); exe != "" {
			return exe
		}
	case "gitbash":
		if exe := gitBashExe(); exe != "" {
			return exe
		}
	case "wsl":
		if fileExists(wslExePath) {
			return wslExePath
		}
	}
	return "powershell.exe"
}

// DetectLocalShells 探测这台机器上实际存在的本机壳，+ 菜单只展示探测到的。
func DetectLocalShells() []LocalShellInfo {
	shells := []LocalShellInfo{
		{ID: "powershell", Label: "PowerShell", Exe: "powershell.exe"},
		{ID: "cmd", Label: "CMD", Exe: "cmd.exe"},
	}
	if exe := pwshExe(); exe != "" {
		shells = append(shells, LocalShellInfo{ID: "pwsh", Label: "PowerShell 7", Exe: exe})
	}
	if exe := gitBashExe(); exe != "" {
		shells = append(shells, LocalShellInfo{ID: "gitbash", Label: "Git Bash", Exe: exe})
	}
	if fileExists(wslExePath) {
		shells = append(shells, LocalShellInfo{ID: "wsl", Label: "WSL", Exe: wslExePath})
	}
	return shells
}
