//go:build windows

package terminal

import (
	"bytes"
	"errors"
	"log"
	"os"
	"path/filepath"
	"sync"

	"termpilot/internal/winconpty"
)

// 和 scripts/prebuild.mjs 的 CONPTY_VERSION 保持一致。
// 目录带版本号，换包时写到新目录，不会撞上还开着的 OpenConsole.exe。
const bundledConptyVersion = "1.25.260930003"

var conptyOnce sync.Once

// ensureBundledConpty 把内嵌的 conpty.dll 和 OpenConsole.exe 释放到用户目录并加载。
// 失败就留在系统自带的 ConPTY 上，本机终端仍能开。
func ensureBundledConpty() {
	conptyOnce.Do(func() {
		if err := installBundledConpty(); err != nil {
			log.Printf("[TermPilot] 随程序的 ConPTY 没用上，沿用系统自带的: %v", err)
		}
	})
}

func installBundledConpty() error {
	if len(bundledConptyDLL) == 0 || len(bundledOpenConsole) == 0 {
		return errors.New("没有内嵌 ConPTY")
	}
	dir := bundledConptyDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	dllPath := filepath.Join(dir, "conpty.dll")
	if err := writeIfChanged(dllPath, bundledConptyDLL); err != nil {
		return err
	}
	if err := writeIfChanged(filepath.Join(dir, "OpenConsole.exe"), bundledOpenConsole); err != nil {
		return err
	}
	abs, err := filepath.Abs(dllPath)
	if err != nil {
		return err
	}
	if err := winconpty.UseLibrary(abs); err != nil {
		return err
	}
	log.Printf("[TermPilot] 本机终端使用随程序的 ConPTY（%s）", bundledConptyVersion)
	return nil
}

func bundledConptyDir() string {
	if v := os.Getenv("TERMPILOT_USERDATA"); v != "" {
		return filepath.Join(v, "conpty", bundledConptyVersion)
	}
	base, err := os.UserConfigDir()
	if err != nil {
		base = "."
	}
	return filepath.Join(base, "TermPilot", "conpty", bundledConptyVersion)
}

func writeIfChanged(path string, data []byte) error {
	existing, err := os.ReadFile(path)
	if err == nil && bytes.Equal(existing, data) {
		return nil
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o755); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
