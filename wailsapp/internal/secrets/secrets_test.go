package secrets

import (
	"encoding/base64"
	"runtime"
	"strings"
	"testing"
)

func newEncryptor(t *testing.T, dir string) Encryptor {
	t.Helper()
	e, err := New(dir)
	if err != nil {
		if runtime.GOOS != "windows" {
			t.Skipf("系统钥匙串不可用（无 dbus/keychain 的测试环境）: %v", err)
		}
		t.Fatalf("New: %v", err)
	}
	return e
}

func TestRoundtrip(t *testing.T) {
	e := newEncryptor(t, t.TempDir())
	if !e.IsAvailable() {
		t.Fatal("IsAvailable = false")
	}
	for _, plain := range []string{"p@ssw0rd", "中文密码", "with space & sym~!", "🔐 emoji"} {
		enc, err := e.EncryptString(plain)
		if err != nil {
			t.Fatalf("EncryptString(%q): %v", plain, err)
		}
		if enc == plain {
			t.Fatalf("密文与明文相同: %q", enc)
		}
		dec, err := e.DecryptString(enc)
		if err != nil {
			t.Fatalf("DecryptString: %v", err)
		}
		if dec != plain {
			t.Fatalf("往返不一致: %q -> %q", plain, dec)
		}
	}
}

// 同一份 userData 密钥，新实例应能解旧实例写的密文（重启场景）。
func TestCrossInstance(t *testing.T) {
	dir := t.TempDir()
	e1 := newEncryptor(t, dir)
	enc, err := e1.EncryptString("重启前的密码")
	if err != nil {
		t.Fatal(err)
	}
	e2 := newEncryptor(t, dir)
	dec, err := e2.DecryptString(enc)
	if err != nil {
		t.Fatalf("跨实例解密: %v", err)
	}
	if dec != "重启前的密码" {
		t.Fatalf("跨实例往返不一致: %q", dec)
	}
}

func TestCorruptInput(t *testing.T) {
	e := newEncryptor(t, t.TempDir())
	if _, err := e.DecryptString("!!not-base64!!"); err == nil {
		t.Fatal("非法 base64 应报错")
	}
	if _, err := e.DecryptString(base64.StdEncoding.EncodeToString([]byte("garbage-without-prefix"))); err == nil {
		t.Fatal("无前缀密文应报错")
	}
	// 前缀正确但内容损坏
	if _, err := e.DecryptString(base64.StdEncoding.EncodeToString([]byte("v10" + strings.Repeat("\x00", 40)))); err == nil {
		t.Fatal("损坏密文应报错")
	}
}
