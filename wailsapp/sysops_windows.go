//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

func isWindows() bool { return true }

// ensureWindowsPath 把 bin 目录写进当前用户 PATH（对应 install-cli.ts 的 PowerShell 脚本）。
func ensureWindowsPath(dir string) {
	script := `
$dir = $env:TERMPILOT_BIN
if (-not $dir) { exit 0 }
$path = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $path) { $path = '' }
$norm = $dir.TrimEnd('\')
$seen = $false
$items = New-Object System.Collections.Generic.List[string]
foreach ($item in $path.Split(';')) {
  if (-not $item) { continue }
  if ($item.TrimEnd('\').Equals($norm, [StringComparison]::OrdinalIgnoreCase)) { $seen = $true; continue }
  $items.Add($item)
}
if ($seen) { exit 0 }
$items.Add($dir)
[Environment]::SetEnvironmentVariable('Path', ($items -join ';'), 'User')
`
	cmd := exec.Command("powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script)
	cmd.Env = append(os.Environ(), "TERMPILOT_BIN="+dir)
	if out, err := cmd.CombinedOutput(); err != nil {
		println("[TermPilot] 没能写入用户 PATH:", err.Error(), string(out))
	}
}

// linkUserBin Windows 不用，占位。
func linkUserBin(target string) {}

// revealFile 对应 shell.showItemInFolder。
func revealFile(path string) error {
	return exec.Command("explorer.exe", "/select,"+path).Start()
}

// copyImageToClipboard 用 PowerShell 把 PNG 放到剪贴板（Wails 没有图片剪贴板 API）。
func copyImageToClipboard(path string) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	script := fmt.Sprintf(
		`Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; [System.Windows.Forms.Clipboard]::SetImage([System.Drawing.Image]::FromFile(%q))`,
		abs)
	cmd := exec.Command("powershell.exe", "-NoProfile", "-STA", "-Command", script)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("复制图片失败: %v %s", err, out)
	}
	return nil
}
