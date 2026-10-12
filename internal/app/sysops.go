package app

import (
	"crypto/rand"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"termpilot/internal/storage"
)

//go:embed resources/SKILL.md
var skillMD string

//go:embed resources/uninstall-path.ps1
var uninstallPS1 []byte

func cliBinName() string {
	if isWindows() {
		return "termpilot.exe"
	}
	return "termpilot"
}

// installSkill 把给 Agent 的使用说明写到 userData/SKILL.md，每次启动覆盖。
func (a *App) installSkill() {
	if err := os.WriteFile(filepath.Join(a.userData, "SKILL.md"), []byte(skillMD), 0o644); err != nil {
		log.Printf("[TermPilot] 写入 SKILL.md 失败: %v", err)
	}
}

// installCli 把 CLI 二进制放到 userData/bin 并写进当前用户 PATH（对应 install-cli.ts）。
func (a *App) installCli() {
	dir := filepath.Join(a.userData, "bin")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		log.Printf("[TermPilot] 没能创建 bin 目录: %v", err)
		return
	}
	target := filepath.Join(dir, cliBinName())
	if len(cliEXE) > 0 {
		if err := writeFileAtomic(target, cliEXE, 0o755); err != nil {
			log.Printf("[TermPilot] 没能更新命令: %v", err)
		}
		for _, stale := range []string{"termpilot.cmd", "termpilot.mjs"} {
			_ = os.Remove(filepath.Join(dir, stale))
		}
	} else {
		log.Printf("[TermPilot] CLI binary missing (embed 为空)")
	}

	launch := map[string]interface{}{"app": a.launchApp, "args": a.launchArgs}
	if data, err := json.MarshalIndent(launch, "", "  "); err == nil {
		_ = os.WriteFile(filepath.Join(dir, "launch.json"), append(data, '\n'), 0o644)
	}
	if len(uninstallPS1) > 0 {
		_ = os.WriteFile(filepath.Join(dir, "uninstall-path.ps1"), uninstallPS1, 0o644)
	}

	if isWindows() {
		ensureWindowsPath(dir)
	} else {
		linkUserBin(target)
	}
}

func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, perm); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// writeMcpFile 对应 StorageService.writeMcpFile：给 CLI / Agent 注册用的 mcp.json。
func (a *App) writeMcpFile(settings storage.McpSettings) error {
	payload := map[string]interface{}{
		"name":    "termpilot",
		"url":     fmt.Sprintf("http://%s:%d/mcp", settings.Host, settings.Port),
		"token":   settings.Token,
		"enabled": settings.Enabled,
		"cli":     filepath.Join(a.userData, "bin", cliBinName()),
		"app":     a.launchApp,
		"args":    a.launchArgs,
	}
	data, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(a.userData, "mcp.json"), append(data, '\n'), 0o600)
}

// ------------------------------------------------------------ 截图文件

func (a *App) screenshotsDir() string {
	return filepath.Join(a.userData, "screenshots")
}

// assertScreenshot 截图只能读 userData/screenshots 下的文件。
func (a *App) assertScreenshot(file string) (string, error) {
	dir, err := filepath.Abs(a.screenshotsDir())
	if err != nil {
		return "", err
	}
	target, err := filepath.Abs(file)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(dir, target)
	if err != nil || rel == "" || strings.HasPrefix(rel, "..") {
		return "", errors.New("不是已保存的截图")
	}
	return target, nil
}

func (a *App) hCaptureSave(args []interface{}) (interface{}, error) {
	pngs, err := arg[[]string](args, 0)
	if err != nil {
		return nil, err
	}
	if len(pngs) == 0 || len(pngs) > 40 {
		return nil, errors.New("没有可保存的截图")
	}
	dir := a.screenshotsDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	// 与 ipc.ts 同规则：20251012T123456 → 20251012-123456，去掉毫秒。
	stamp := time.Now().UTC().Format("20060102T150405.000Z")
	stamp = strings.ReplaceAll(stamp[:strings.Index(stamp, ".")], "-", "")
	stamp = strings.ReplaceAll(stamp, ":", "")
	stamp = strings.Replace(stamp, "T", "-", 1)
	var rb [3]byte
	_, _ = rand.Read(rb[:])
	batch := hex.EncodeToString(rb[:])
	paths := make([]string, 0, len(pngs))
	for i, png := range pngs {
		data, err := base64.StdEncoding.DecodeString(png)
		if err != nil {
			return nil, fmt.Errorf("第 %d 张截图不是 base64: %w", i+1, err)
		}
		file := filepath.Join(dir, fmt.Sprintf("%s-%s-%02d.png", stamp, batch, i+1))
		if err := os.WriteFile(file, data, 0o644); err != nil {
			return nil, err
		}
		paths = append(paths, file)
	}
	return paths, nil
}

func (a *App) hCaptureReveal(args []interface{}) (interface{}, error) {
	file, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	target, err := a.assertScreenshot(file)
	if err != nil {
		return nil, err
	}
	return nil, revealFile(target)
}

func (a *App) hCaptureCopy(args []interface{}) (interface{}, error) {
	file, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	target, err := a.assertScreenshot(file)
	if err != nil {
		return nil, err
	}
	return nil, copyImageToClipboard(target)
}

func (a *App) hCaptureRead(args []interface{}) (interface{}, error) {
	file, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	target, err := a.assertScreenshot(file)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(target)
	if err != nil {
		return nil, err
	}
	return base64.StdEncoding.EncodeToString(data), nil
}

func joinPath(dir, name string) string {
	return filepath.Join(dir, name)
}
