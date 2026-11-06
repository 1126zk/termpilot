package sshx

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"golang.org/x/crypto/ssh"
)

// 本机密钥和写到主机 authorized_keys 的小工具。
// 免密登录认的是系统 SSH 会自动试的私钥文件名（id_ed25519 等），
// 所以生成和导入都尽量落在这些名字上，已有的文件不覆盖。

const maxKeyBytes = 64 << 10

// KeyPair 新生成的一对密钥。PublicKey 是单行 OpenSSH 公钥。
type KeyPair struct {
	PrivatePath string `json:"privatePath"`
	PublicPath  string `json:"publicPath"`
	PublicKey   string `json:"publicKey"`
}

// KeyImport 放进本机 .ssh 的私钥。Warning 非空时钥匙在，但免密登录还差一步。
type KeyImport struct {
	Path      string `json:"path"`
	PublicKey string `json:"publicKey"`
	Warning   string `json:"warning,omitempty"`
}

// KeyInstall 公钥写到主机之后的结果。Status 是 added 或 exists。
type KeyInstall struct {
	Status string `json:"status"`
}

// UserSSHDir 当前用户的 ~/.ssh。
func UserSSHDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return "", errors.New("找不到用户主目录")
	}
	return filepath.Join(home, ".ssh"), nil
}

// GenerateKeyPair 在 dir 里生成 ed25519 密钥对，文件名是 id_ed25519。
// 私钥已经存在就停下来，不覆盖。
func GenerateKeyPair(dir string) (KeyPair, error) {
	if err := ensureSSHDir(dir); err != nil {
		return KeyPair{}, err
	}
	privPath := filepath.Join(dir, "id_ed25519")
	pubPath := filepath.Join(dir, "id_ed25519.pub")
	if _, err := os.Stat(privPath); err == nil {
		return KeyPair{}, errors.New("本机已有 id_ed25519，没有覆盖")
	} else if err != nil && !os.IsNotExist(err) {
		return KeyPair{}, err
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return KeyPair{}, err
	}
	block, err := ssh.MarshalPrivateKey(priv, "termpilot")
	if err != nil {
		return KeyPair{}, err
	}
	sshPub, err := ssh.NewPublicKey(pub)
	if err != nil {
		return KeyPair{}, err
	}
	line := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(sshPub))) + " termpilot"
	if err := writePrivate(privPath, pem.EncodeToMemory(block)); err != nil {
		return KeyPair{}, err
	}
	if err := writePublic(pubPath, line); err != nil {
		_ = os.Remove(privPath)
		return KeyPair{}, err
	}
	return KeyPair{PrivatePath: privPath, PublicPath: pubPath, PublicKey: line}, nil
}

// ImportPrivateKey 把 src 这把私钥放进 dir。能对上默认文件名就用默认名，
// 默认位置已有另一把钥匙时改用原文件名，两种情况都不覆盖已有文件。
func ImportPrivateKey(dir, src string) (KeyImport, error) {
	raw, err := readKeyFile(src)
	if err != nil {
		return KeyImport{}, err
	}
	key, err := inspectPrivateKey(raw)
	if err != nil {
		return KeyImport{}, err
	}
	if err := ensureSSHDir(dir); err != nil {
		return KeyImport{}, err
	}
	return placePrivateKey(dir, src, key)
}

// InstallAuthorizedKey 把一把公钥追加到会话对应用户的 ~/.ssh/authorized_keys。
// 同一把已经在里面时不再追加。
func (s *ExecService) InstallAuthorizedKey(sessionID, publicKey string) (KeyInstall, error) {
	script, err := authorizedKeyScript(publicKey)
	if err != nil {
		return KeyInstall{}, err
	}
	res, err := s.Exec(sessionID, ExecOptions{Command: script, TimeoutMs: 20000})
	if err != nil {
		return KeyInstall{}, err
	}
	if res.TimedOut {
		return KeyInstall{}, errors.New("写入公钥超时")
	}
	if res.ExitCode != nil && *res.ExitCode != 0 {
		detail := strings.TrimSpace(res.Stderr)
		if detail == "" {
			detail = strings.TrimSpace(res.Stdout)
		}
		if detail == "" {
			detail = fmt.Sprintf("退出码 %d", *res.ExitCode)
		}
		return KeyInstall{}, fmt.Errorf("写入公钥失败：%s", clipRunes(detail, 400))
	}
	switch {
	case strings.Contains(res.Stdout, "ADDED"):
		return KeyInstall{Status: "added"}, nil
	case strings.Contains(res.Stdout, "EXISTS"):
		return KeyInstall{Status: "exists"}, nil
	default:
		return KeyInstall{}, errors.New("写入公钥没有得到结果")
	}
}

func clipRunes(text string, max int) string {
	r := []rune(text)
	if len(r) <= max {
		return text
	}
	return string(r[:max]) + "…"
}

type parsedPriv struct {
	raw        []byte
	keyType    string
	publicLine string
	encrypted  bool
}

func inspectPrivateKey(raw []byte) (parsedPriv, error) {
	signer, err := ssh.ParsePrivateKey(raw)
	if err == nil {
		pub := signer.PublicKey()
		return parsedPriv{
			raw:        raw,
			keyType:    pub.Type(),
			publicLine: strings.TrimSpace(string(ssh.MarshalAuthorizedKey(pub))),
		}, nil
	}
	var missing *ssh.PassphraseMissingError
	if errors.As(err, &missing) {
		out := parsedPriv{raw: raw, encrypted: true}
		if missing.PublicKey != nil {
			out.keyType = missing.PublicKey.Type()
			out.publicLine = strings.TrimSpace(string(ssh.MarshalAuthorizedKey(missing.PublicKey)))
		}
		return out, nil
	}
	if _, _, pubErr := parseOnePublicKey(string(raw)); pubErr == nil {
		return parsedPriv{}, errors.New("这是公钥。私钥才放进本机 .ssh，公钥写到主机上")
	}
	return parsedPriv{}, errors.New("这不是 OpenSSH 私钥，或文件已损坏")
}

func placePrivateKey(dir, src string, key parsedPriv) (KeyImport, error) {
	preferred := defaultIdentityName(key.keyType)
	srcName, srcErr := safeKeyFileName(filepath.Base(src))

	seen := map[string]bool{}
	var check []string
	if preferred != "" {
		check = append(check, preferred)
	}
	if srcErr == nil {
		check = append(check, srcName)
	}
	for _, name := range check {
		if seen[name] {
			continue
		}
		seen[name] = true
		path := filepath.Join(dir, name)
		existing, err := os.ReadFile(path)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return KeyImport{}, err
		}
		if bytes.Equal(bytes.TrimSpace(existing), bytes.TrimSpace(key.raw)) {
			return KeyImport{
				Path:      path,
				PublicKey: key.publicLine,
				Warning:   joinNotes("这把私钥已经在本机 .ssh 里。", keyNotes(key, name)),
			}, nil
		}
	}

	name := ""
	var notes []string
	if preferred != "" {
		_, err := os.Stat(filepath.Join(dir, preferred))
		switch {
		case err == nil:
			notes = append(notes, fmt.Sprintf("默认的 %s 已有另一把钥匙，没有覆盖。", preferred))
		case os.IsNotExist(err):
			name = preferred
		default:
			return KeyImport{}, err
		}
	}
	if name == "" && srcErr == nil {
		_, err := os.Stat(filepath.Join(dir, srcName))
		switch {
		case os.IsNotExist(err):
			name = srcName
		case err != nil:
			return KeyImport{}, err
		}
	}
	if name == "" {
		stem := "imported_key"
		if srcErr == nil {
			stem = srcName
		} else if preferred != "" {
			stem = preferred + ".imported"
		}
		var err error
		name, err = freeKeyName(dir, stem)
		if err != nil {
			return KeyImport{}, err
		}
	}
	notes = append(notes, keyNotes(key, name))

	path := filepath.Join(dir, name)
	if err := writePrivate(path, key.raw); err != nil {
		return KeyImport{}, err
	}
	if key.publicLine != "" {
		if _, err := os.Stat(path + ".pub"); os.IsNotExist(err) {
			_ = writePublic(path+".pub", key.publicLine)
		}
	}
	return KeyImport{Path: path, PublicKey: key.publicLine, Warning: joinNotes(notes...)}, nil
}

func keyNotes(key parsedPriv, name string) string {
	var notes []string
	if name != "" && !isDefaultIdentityName(name) {
		notes = append(notes, "这个文件名不在系统 SSH 的默认清单里，密钥登录不会自动用它。")
	}
	if key.encrypted {
		notes = append(notes, "这把钥匙有口令，当前的密钥登录读不了它。")
	}
	if key.publicLine == "" {
		notes = append(notes, "没能从这把私钥读出公钥。")
	}
	return joinNotes(notes...)
}

func joinNotes(parts ...string) string {
	var b strings.Builder
	for _, part := range parts {
		b.WriteString(part)
	}
	return b.String()
}

func defaultIdentityName(keyType string) string {
	switch keyType {
	case ssh.KeyAlgoRSA:
		return "id_rsa"
	case ssh.KeyAlgoECDSA256, ssh.KeyAlgoECDSA384, ssh.KeyAlgoECDSA521:
		return "id_ecdsa"
	case ssh.KeyAlgoED25519:
		return "id_ed25519"
	case ssh.InsecureKeyAlgoDSA:
		return "id_dsa"
	case ssh.KeyAlgoSKED25519:
		return "id_ed25519_sk"
	case ssh.KeyAlgoSKECDSA256:
		return "id_ecdsa_sk"
	default:
		return ""
	}
}

func isDefaultIdentityName(name string) bool {
	switch name {
	case "id_rsa", "id_ecdsa", "id_ecdsa_sk", "id_ed25519", "id_ed25519_sk", "id_xmss", "id_dsa":
		return true
	default:
		return false
	}
}

var keyNameRe = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

func safeKeyFileName(name string) (string, error) {
	name = filepath.Base(name)
	if !keyNameRe.MatchString(name) {
		return "", errors.New("私钥文件名不合法")
	}
	return name, nil
}

func freeKeyName(dir, stem string) (string, error) {
	if _, err := os.Stat(filepath.Join(dir, stem)); os.IsNotExist(err) {
		return stem, nil
	} else if err != nil {
		return "", err
	}
	for i := 2; i <= 50; i++ {
		name := fmt.Sprintf("%s.%d", stem, i)
		_, err := os.Stat(filepath.Join(dir, name))
		if os.IsNotExist(err) {
			return name, nil
		}
		if err != nil {
			return "", err
		}
	}
	return "", errors.New("本机 .ssh 里同名文件太多，没有写入")
}

func ensureSSHDir(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("建不了 .ssh 目录：%w", err)
	}
	_ = os.Chmod(dir, 0o700)
	return nil
}

func readKeyFile(path string) ([]byte, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, errors.New("读不了这个文件")
	}
	if info.IsDir() {
		return nil, errors.New("这是文件夹，不是密钥文件")
	}
	if info.Size() > maxKeyBytes {
		return nil, errors.New("文件太大，不像密钥")
	}
	return os.ReadFile(path)
}

func writePrivate(path string, data []byte) error {
	if err := writeNewFile(path, data, 0o600); err != nil {
		return err
	}
	if err := restrictPrivateKey(path); err != nil {
		_ = os.Remove(path)
		return err
	}
	return nil
}

func writePublic(path, line string) error {
	return writeNewFile(path, []byte(line+"\n"), 0o644)
}

func writeNewFile(path string, data []byte, mode os.FileMode) error {
	tmp := path + ".termpilot-tmp"
	if err := os.WriteFile(tmp, data, mode); err != nil {
		return err
	}
	_ = os.Chmod(tmp, mode)
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	_ = os.Chmod(path, mode)
	return nil
}

func parseOnePublicKey(text string) (ssh.PublicKey, string, error) {
	text = strings.TrimPrefix(strings.TrimSpace(text), "\uFEFF")
	if text == "" {
		return nil, "", errors.New("公钥是空的")
	}
	var lines []string
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		lines = append(lines, line)
	}
	if len(lines) != 1 {
		return nil, "", errors.New("一次只能写入一把公钥")
	}
	pub, comment, _, rest, err := ssh.ParseAuthorizedKey([]byte(lines[0]))
	if err != nil {
		if signer, keyErr := ssh.ParsePrivateKey([]byte(lines[0])); keyErr == nil && signer != nil {
			return nil, "", errors.New("这是私钥，这里要公钥")
		}
		return nil, "", errors.New("这不是 OpenSSH 公钥")
	}
	if strings.TrimSpace(string(rest)) != "" {
		return nil, "", errors.New("一次只能写入一把公钥")
	}
	return pub, comment, nil
}

var safeB64 = regexp.MustCompile(`^[A-Za-z0-9+/=]+$`)

// PublicKeyFile 选中的公钥文件，还没写到主机。
type PublicKeyFile struct {
	Name      string `json:"name"`
	PublicKey string `json:"publicKey"`
}

// ReadPublicKeyFile 读一把公钥文件。私钥和别的内容会报错。
func ReadPublicKeyFile(path string) (PublicKeyFile, error) {
	raw, err := readKeyFile(path)
	if err != nil {
		return PublicKeyFile{}, err
	}
	if _, perr := ssh.ParsePrivateKey(raw); perr == nil {
		return PublicKeyFile{}, errors.New("这是私钥，这里要公钥")
	} else {
		var missing *ssh.PassphraseMissingError
		if errors.As(perr, &missing) {
			return PublicKeyFile{}, errors.New("这是私钥，这里要公钥")
		}
	}
	line, err := canonicalPublicKey(string(raw))
	if err != nil {
		return PublicKeyFile{}, err
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return PublicKeyFile{}, err
	}
	return PublicKeyFile{Name: abs, PublicKey: line}, nil
}

func canonicalPublicKey(text string) (string, error) {
	pub, comment, err := parseOnePublicKey(text)
	if err != nil {
		return "", err
	}
	line := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(pub)))
	if comment != "" {
		line += " " + comment
	}
	fields := strings.Fields(line)
	if len(fields) < 2 || !safeB64.MatchString(fields[1]) {
		return "", errors.New("这不是 OpenSSH 公钥")
	}
	return line, nil
}

// authorizedKeyScript 拼一段远端脚本：建好目录和权限，公钥不在才追加。
// 公钥整行先做成 base64 再嵌进去，注释里的引号和 $() 进不了 shell。
func authorizedKeyScript(publicKey string) (string, error) {
	line, err := canonicalPublicKey(publicKey)
	if err != nil {
		return "", err
	}
	fields := strings.Fields(line)
	encoded := base64.StdEncoding.EncodeToString([]byte(line))
	if !safeB64.MatchString(encoded) {
		return "", errors.New("这不是 OpenSSH 公钥")
	}
	var b strings.Builder
	b.WriteString("umask 077\n")
	b.WriteString("if [ -z \"$HOME\" ]; then exit 1; fi\n")
	b.WriteString("mkdir -p \"$HOME/.ssh\" || exit 1\n")
	b.WriteString("chmod 700 \"$HOME/.ssh\" || exit 1\n")
	b.WriteString("touch \"$HOME/.ssh/authorized_keys\" || exit 1\n")
	b.WriteString("chmod 600 \"$HOME/.ssh/authorized_keys\" || exit 1\n")
	fmt.Fprintf(&b, "line=$(printf '%%s\\n' '%s' | base64 -d) || exit 1\n", encoded)
	fmt.Fprintf(&b, "if grep -F -- '%s' \"$HOME/.ssh/authorized_keys\" >/dev/null 2>&1; then\n", fields[1])
	b.WriteString("  printf '%s\\n' EXISTS\n")
	b.WriteString("else\n")
	b.WriteString("  printf '%s\\n' \"$line\" >> \"$HOME/.ssh/authorized_keys\" || exit 1\n")
	b.WriteString("  printf '%s\\n' ADDED\n")
	b.WriteString("fi\n")
	return b.String(), nil
}
