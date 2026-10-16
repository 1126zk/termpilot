//go:build windows

package app

import (
	"bytes"
	"crypto/sha1"
	"crypto/x509"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"unicode/utf16"

	"golang.org/x/sys/windows/registry"
)

// 右键菜单组件在构建时由 shell/contextmenu/build.ps1 生成，嵌进主程序。
// 第一次启动释放到 %APPDATA%\TermPilot\shell，再按当前用户注册稀疏包。

//go:embed resources/shell/TermPilotContextMenu.dll
var contextMenuDLL []byte

//go:embed resources/shell/TermPilotShellHost.exe
var contextMenuHost []byte

//go:embed resources/shell/ContextMenu.msix
var contextMenuMsix []byte

//go:embed resources/shell/ContextMenu.cer
var contextMenuCer []byte

//go:embed resources/shell/logo_150x150.png
var contextMenuLogo150 []byte

//go:embed resources/shell/logo_44x44.png
var contextMenuLogo44 []byte

const contextMenuPackage = "TermPilot.ContextMenu"

func (a *App) installContextMenu() {
	if err := a.installContextMenuErr(); err != nil {
		log.Printf("[TermPilot] 右键菜单没能装上: %v", err)
	}
}

func (a *App) installContextMenuErr() error {
	if os.Getenv("TERMPILOT_SMOKE") != "" {
		return nil
	}
	if runtime.GOARCH != "amd64" {
		return errors.New("右键菜单只提供 64 位版本")
	}
	if len(contextMenuDLL) == 0 || len(contextMenuHost) == 0 || len(contextMenuMsix) == 0 || len(contextMenuCer) == 0 {
		return errors.New("右键菜单组件缺失")
	}
	dir := filepath.Join(a.userData, "shell")
	if err := os.MkdirAll(filepath.Join(dir, "resources"), 0o755); err != nil {
		return err
	}
	if a.launchApp == "" {
		return errors.New("没有可执行文件路径")
	}
	exe, err := filepath.Abs(a.launchApp)
	if err != nil {
		return err
	}
	if _, err := writeIfChanged(filepath.Join(dir, "exe.path"), []byte(exe)); err != nil {
		return err
	}

	dllChanged, err := writeIfChanged(filepath.Join(dir, "TermPilotContextMenu.dll"), contextMenuDLL)
	if err != nil {
		return err
	}
	hostChanged, err := writeIfChanged(filepath.Join(dir, "TermPilotShellHost.exe"), contextMenuHost)
	if err != nil {
		return err
	}
	payloads := []struct {
		path string
		data []byte
	}{
		{filepath.Join(dir, "resources", "logo_150x150.png"), contextMenuLogo150},
		{filepath.Join(dir, "resources", "logo_44x44.png"), contextMenuLogo44},
		{filepath.Join(dir, "ContextMenu.msix"), contextMenuMsix},
		{filepath.Join(dir, "ContextMenu.cer"), contextMenuCer},
	}
	for _, item := range payloads {
		if _, err := writeIfChanged(item.path, item.data); err != nil {
			return err
		}
	}

	installed := contextMenuPackageInstalled()
	if !dllChanged && !hostChanged && installed {
		return nil
	}
	fresh, err := registerContextMenu(dir)
	if err != nil {
		return err
	}
	if fresh || dllChanged || hostChanged {
		log.Printf("[TermPilot] 右键菜单已注册，正在重启资源管理器")
		restartExplorer()
	}
	return nil
}

func writeIfChanged(path string, data []byte) (bool, error) {
	existing, err := os.ReadFile(path)
	if err == nil && bytes.Equal(existing, data) {
		return false, nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return false, err
	}
	if err := writeFileAtomic(path, data, 0o755); err != nil {
		return false, err
	}
	return true, nil
}

func contextMenuPackageInstalled() bool {
	key, err := registry.OpenKey(registry.CURRENT_USER, `Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages`, registry.ENUMERATE_SUB_KEYS)
	if err != nil {
		return false
	}
	defer key.Close()
	names, err := key.ReadSubKeyNames(-1)
	if err != nil {
		return false
	}
	prefix := contextMenuPackage + "_"
	for _, name := range names {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

// registerContextMenu 返回 fresh=true 表示这次新装上了包。已经装过则 fresh=false。
func registerContextMenu(dir string) (bool, error) {
	dir, err := filepath.Abs(dir)
	if err != nil {
		return false, err
	}
	// 包签名由系统服务校验，只认本机信任区，不认当前用户的证书库。
	if err := ensureMachineCert(filepath.Join(dir, "ContextMenu.cer")); err != nil {
		return false, err
	}
	script := `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$cerPath = $env:TERMPILOT_SHELL_CER
$dir = $env:TERMPILOT_SHELL_DIR
$msix = $env:TERMPILOT_SHELL_MSIX
if (-not $cerPath -or -not $dir -or -not $msix) { throw 'missing context menu paths' }
$cer = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($cerPath)
foreach ($name in @('TrustedPeople','Root')) {
  $store = New-Object System.Security.Cryptography.X509Certificates.X509Store($name,'CurrentUser')
  $store.Open('ReadWrite')
  try {
    $found = $store.Certificates.Find([System.Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint, $cer.Thumbprint, $false)
    if ($found.Count -eq 0) { [void]$store.Add($cer) }
  } finally {
    $store.Close()
  }
}
$pkg = Get-AppxPackage -Name 'TermPilot.ContextMenu' -ErrorAction SilentlyContinue
if ($null -ne $pkg) { exit 10 }
try {
  Add-AppxPackage -Path $msix -ExternalLocation $dir
} catch {
  [Console]::Out.WriteLine($_.Exception.Message)
  exit 1
}
exit 0
`
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodeUTF16LEBase64(script))
	hideConsole(cmd)
	cmd.Env = append(os.Environ(),
		"TERMPILOT_SHELL_CER="+filepath.Join(dir, "ContextMenu.cer"),
		"TERMPILOT_SHELL_DIR="+dir,
		"TERMPILOT_SHELL_MSIX="+filepath.Join(dir, "ContextMenu.msix"),
	)
	out, err := cmd.CombinedOutput()
	if err == nil {
		return true, nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && exitErr.ExitCode() == 10 {
		return false, nil
	}
	text := strings.TrimSpace(string(out))
	if text == "" {
		return false, err
	}
	return false, fmt.Errorf("%s", text)
}

func encodeUTF16LEBase64(s string) string {
	units := utf16.Encode([]rune(s))
	raw := make([]byte, len(units)*2)
	for i, unit := range units {
		raw[i*2] = byte(unit)
		raw[i*2+1] = byte(unit >> 8)
	}
	return base64.StdEncoding.EncodeToString(raw)
}

func machineCertInstalled(cer []byte) bool {
	cert, err := x509.ParseCertificate(cer)
	if err != nil {
		return false
	}
	// Windows 证书指纹是证书原文的 SHA-1。
	sum := sha1.Sum(cert.Raw)
	thumb := strings.ToUpper(hex.EncodeToString(sum[:]))
	for _, store := range []string{"ROOT", "TrustedPeople"} {
		key, err := registry.OpenKey(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\SystemCertificates\`+store+`\Certificates\`+thumb, registry.QUERY_VALUE)
		if err != nil {
			return false
		}
		key.Close()
	}
	return true
}

func ensureMachineCert(cerPath string) error {
	data, err := os.ReadFile(cerPath)
	if err != nil {
		return err
	}
	if machineCertInstalled(data) {
		return nil
	}
	if strings.Contains(cerPath, "'") {
		return errors.New("证书路径不能包含单引号")
	}
	inner := fmt.Sprintf(`$ErrorActionPreference = 'Stop'
$cer = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 '%s'
foreach ($name in @('Root','TrustedPeople')) {
  $store = New-Object System.Security.Cryptography.X509Certificates.X509Store($name,'LocalMachine')
  $store.Open('ReadWrite')
  try {
    $found = $store.Certificates.Find([System.Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint, $cer.Thumbprint, $false)
    if ($found.Count -eq 0) { [void]$store.Add($cer) }
  } finally { $store.Close() }
}
`, cerPath)
	outer := fmt.Sprintf(`$ErrorActionPreference = 'Stop'
$p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','%s')
if ($null -eq $p) { exit 1 }
exit $p.ExitCode
`, encodeUTF16LEBase64(inner))
	cmd := exec.Command("powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodeUTF16LEBase64(outer))
	hideConsole(cmd)
	out, err := cmd.CombinedOutput()
	if err != nil {
		text := strings.TrimSpace(string(out))
		if text == "" {
			text = err.Error()
		}
		return fmt.Errorf("需要允许一次管理员权限，才能信任右键菜单证书: %s", text)
	}
	if !machineCertInstalled(data) {
		return errors.New("证书没有写进系统信任区")
	}
	return nil
}

func restartExplorer() {
	cmd := exec.Command("powershell.exe", "-NoProfile", "-Command", "Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue; Start-Process explorer.exe")
	hideConsole(cmd)
	if out, err := cmd.CombinedOutput(); err != nil {
		log.Printf("[TermPilot] 没能重启资源管理器: %v %s", err, out)
	}
}
