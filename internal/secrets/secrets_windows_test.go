//go:build windows

package secrets

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// 老式 "DPAPI" 前缀的裸 DPAPI blob（Chromium 80 之前 safeStorage 的格式）也要能解。
func TestLegacyDPAPIFormat(t *testing.T) {
	e := newEncryptor(t, t.TempDir())
	blob, err := cryptProtect([]byte("旧格式密码"))
	if err != nil {
		t.Fatal(err)
	}
	enc := base64.StdEncoding.EncodeToString(append([]byte(dpapiPrefix), blob...))
	dec, err := e.DecryptString(enc)
	if err != nil {
		t.Fatalf("旧格式解密: %v", err)
	}
	if dec != "旧格式密码" {
		t.Fatalf("旧格式往返不一致: %q", dec)
	}
}

// 密钥必须真实落在 Local State 里（Electron 兼容的关键路径）。
func TestLocalStateKey(t *testing.T) {
	dir := t.TempDir()
	e := newEncryptor(t, dir)
	we, ok := e.(*windowsEncryptor)
	if !ok {
		t.Fatal("类型不对")
	}
	data, err := os.ReadFile(filepath.Join(dir, localStateFile))
	if err != nil {
		t.Fatal(err)
	}
	var state map[string]any
	if err := json.Unmarshal(data, &state); err != nil {
		t.Fatal(err)
	}
	encoded, ok := state["os_crypt"].(map[string]any)["encrypted_key"].(string)
	if !ok || encoded == "" {
		t.Fatal("Local State 缺少 os_crypt.encrypted_key")
	}
	blob, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if string(blob[:5]) != dpapiPrefix {
		t.Fatalf("encrypted_key 缺 DPAPI 前缀: %q", blob[:5])
	}
	key, err := cryptUnprotect(blob[5:])
	if err != nil {
		t.Fatal(err)
	}
	if len(key) != 32 || string(key) != string(we.key) {
		t.Fatal("Local State 里的密钥与内存不一致")
	}
}
