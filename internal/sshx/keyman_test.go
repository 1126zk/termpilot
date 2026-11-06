package sshx

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
)

func TestGenerateAndImportPrivateKey(t *testing.T) {
	dir := t.TempDir()
	pair, err := GenerateKeyPair(dir)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(pair.PrivatePath) != "id_ed25519" || filepath.Base(pair.PublicPath) != "id_ed25519.pub" {
		t.Fatalf("paths = %s %s", pair.PrivatePath, pair.PublicPath)
	}
	if !strings.HasPrefix(pair.PublicKey, "ssh-ed25519 ") {
		t.Fatalf("public = %q", pair.PublicKey)
	}
	info, err := os.Stat(pair.PrivatePath)
	if err != nil {
		t.Fatal(err)
	}
	// Windows 上 Go 看到的 mode 不可靠，权限交给 ssh-keygen 那条测试。
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("private mode = %o", info.Mode().Perm())
	}
	if _, err := GenerateKeyPair(dir); err == nil || !strings.Contains(err.Error(), "没有覆盖") {
		t.Fatalf("second generate = %v", err)
	}

	other := t.TempDir()
	pemPath := filepath.Join(other, "cloud.pem")
	raw, err := os.ReadFile(pair.PrivatePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(pemPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	again, err := ImportPrivateKey(dir, pemPath)
	if err != nil {
		t.Fatal(err)
	}
	if again.Path != pair.PrivatePath || !strings.Contains(again.Warning, "已经在") {
		t.Fatalf("import same = %+v", again)
	}

	fresh := t.TempDir()
	imported, err := ImportPrivateKey(fresh, pemPath)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(imported.Path) != "id_ed25519" {
		t.Fatalf("imported name = %s warning=%q", imported.Path, imported.Warning)
	}
	if imported.PublicKey == "" || imported.Warning != "" {
		t.Fatalf("imported = %+v", imported)
	}

	second := mustPrivatePEM(t)
	secondPath := filepath.Join(other, "other.pem")
	if err := os.WriteFile(secondPath, second, 0o600); err != nil {
		t.Fatal(err)
	}
	moved, err := ImportPrivateKey(fresh, secondPath)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(moved.Path) != "other.pem" {
		t.Fatalf("collision name = %s", moved.Path)
	}
	if !strings.Contains(moved.Warning, "没有覆盖") || !strings.Contains(moved.Warning, "不会自动用它") {
		t.Fatalf("warning = %q", moved.Warning)
	}
	dup, err := ImportPrivateKey(fresh, secondPath)
	if err != nil {
		t.Fatal(err)
	}
	if dup.Path != moved.Path || !strings.Contains(dup.Warning, "已经在") || !strings.Contains(dup.Warning, "不会自动用它") {
		t.Fatalf("second import = %+v", dup)
	}
}

func TestImportEncryptedAndPublic(t *testing.T) {
	dir := t.TempDir()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	block, err := ssh.MarshalPrivateKeyWithPassphrase(priv, "termpilot", []byte("secret"))
	if err != nil {
		t.Fatal(err)
	}
	src := filepath.Join(t.TempDir(), "locked.pem")
	if err := os.WriteFile(src, pem.EncodeToMemory(block), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := ImportPrivateKey(dir, src)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(got.Path) != "id_ed25519" {
		t.Fatalf("path = %s", got.Path)
	}
	if !strings.Contains(got.Warning, "口令") || got.PublicKey == "" {
		t.Fatalf("encrypted import = %+v", got)
	}

	pub := filepath.Join(t.TempDir(), "id_ed25519.pub")
	if err := os.WriteFile(pub, []byte(got.PublicKey+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := ImportPrivateKey(t.TempDir(), pub); err == nil || !strings.Contains(err.Error(), "公钥") {
		t.Fatalf("public as private = %v", err)
	}
}

func TestAuthorizedKeyScript(t *testing.T) {
	dir := t.TempDir()
	pair, err := GenerateKeyPair(dir)
	if err != nil {
		t.Fatal(err)
	}
	// 生成结果已经带了 termpilot 注释，再拼一段恶意注释，确认它只出现在 base64 里。
	pub, _, _, _, err := ssh.ParseAuthorizedKey([]byte(pair.PublicKey))
	if err != nil {
		t.Fatal(err)
	}
	line := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(pub))) + " $(touch /tmp/pwned)'\"`"
	script, err := authorizedKeyScript(line)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(script, "pwned") {
		t.Fatalf("script leaked comment:\n%s", script)
	}
	if !strings.Contains(script, "authorized_keys") || !strings.Contains(script, "ADDED") {
		t.Fatalf("script = %s", script)
	}
	if _, err := authorizedKeyScript(line + "\n" + line); err == nil {
		t.Fatal("two keys should be rejected")
	}
	if _, err := authorizedKeyScript("not a key"); err == nil {
		t.Fatal("garbage should be rejected")
	}
}

func TestSSHAcceptsGeneratedKey(t *testing.T) {
	if _, err := exec.LookPath("ssh-keygen"); err != nil {
		t.Skip("没有 ssh-keygen")
	}
	pair, err := GenerateKeyPair(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("ssh-keygen", "-y", "-f", pair.PrivatePath)
	hideWindow(cmd)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("ssh-keygen -y: %v\n%s", err, out)
	}
	got := strings.TrimSpace(string(out))
	want := strings.Fields(pair.PublicKey)[1]
	if !bytes.Contains([]byte(got), []byte(want)) {
		t.Fatalf("ssh-keygen = %q, want blob %s", got, want)
	}
}

func mustPrivatePEM(t *testing.T) []byte {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	block, err := ssh.MarshalPrivateKey(priv, "termpilot")
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(block)
}
