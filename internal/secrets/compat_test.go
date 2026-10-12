package secrets_test

import (
	"os"
	"path/filepath"
	"testing"
	"unicode/utf8"

	"termpilot/internal/secrets"
	"termpilot/internal/storage"
)

// TestElectronCompat 用 Electron 版真实生成的 userData 验证存量密文能解。
// 默认跳过；手动验证时设置环境变量：
//
//	TERMPILOT_ELECTRON_USERDATA=C:\Users\<you>\AppData\Roaming\TermPilot go test ./internal/secrets/ -run ElectronCompat -v
func TestElectronCompat(t *testing.T) {
	src := os.Getenv("TERMPILOT_ELECTRON_USERDATA")
	if src == "" {
		t.Skip("未设置 TERMPILOT_ELECTRON_USERDATA，跳过存量库兼容验证")
	}
	enc, err := secrets.New(src)
	if err != nil {
		t.Fatalf("加载 Electron 版 Local State 密钥: %v", err)
	}

	// 复制 db（含 WAL）到临时目录再打开，避免碰线上库。
	dst := t.TempDir()
	for _, ext := range []string{"", "-wal", "-shm"} {
		data, err := os.ReadFile(filepath.Join(src, "termpilot.db"+ext))
		if err != nil {
			if ext == "" {
				t.Fatalf("读 termpilot.db: %v", err)
			}
			continue
		}
		if err := os.WriteFile(filepath.Join(dst, "termpilot.db"+ext), data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	store, err := storage.Open(dst, enc)
	if err != nil {
		t.Fatalf("打开 Electron 版数据库: %v", err)
	}
	defer store.Close()

	sessions, err := store.List()
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("读到 %d 条会话", len(sessions))
	checked := 0
	for _, s := range sessions {
		if s.HasSecret {
			secret, err := store.GetSecret(s.ID)
			if err != nil {
				t.Fatalf("会话 %s 解密报错: %v", s.Name, err)
			}
			if secret == "" || !utf8.ValidString(secret) {
				t.Fatalf("会话 %s 的存量密文解不开", s.Name)
			}
			checked++
		}
		if s.HasJumpSecret {
			if secret, _ := store.GetJumpSecret(s.ID); secret == "" || !utf8.ValidString(secret) {
				t.Fatalf("会话 %s 的跳板密文解不开", s.Name)
			}
		}
	}
	mcp, err := store.GetMcpSettings()
	if err != nil {
		t.Fatal(err)
	}
	if mcp.Token == "" || !utf8.ValidString(mcp.Token) {
		t.Fatal("MCP token 密文解不开")
	}
	t.Logf("存量密文全部解开：会话密码 %d 条 + MCP token", checked)

	// 反向：Go 写的新密文必须符合 Electron 格式（v10 前缀 AES-GCM）。
	re, err := enc.EncryptString("来回验证")
	if err != nil {
		t.Fatal(err)
	}
	if dec, err := enc.DecryptString(re); err != nil || dec != "来回验证" {
		t.Fatalf("自写自读失败: %v %q", err, dec)
	}
}
