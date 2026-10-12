//go:build windows

package secrets

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Windows 密文格式（Chromium OSCrypt，与 Electron safeStorage 逐字节一致）：
//
//	密文 = "v10" || nonce(12) || AES-256-GCM(key, nonce, plain) || tag(16)，再 base64。
//	key  = CryptUnprotectData(LocalState.os_crypt.encrypted_key 去掉 "DPAPI" 前缀)  → 32 字节。
//
// 老格式兜底："DPAPI" || CryptProtectData(plain)（Chromium 80 之前）。

const (
	localStateFile = "Local State"
	v10Prefix      = "v10"
	dpapiPrefix    = "DPAPI"
)

type windowsEncryptor struct {
	key []byte // 32 字节 AES-256 密钥
}

// New 加载（必要时创建）userData 目录下 Local State 里的加密密钥。
// userDataDir 即 Electron 的 app.getPath('userData')（如 %APPDATA%\TermPilot）。
func New(userDataDir string) (Encryptor, error) {
	key, err := loadOrCreateKey(userDataDir)
	if err != nil {
		return nil, err
	}
	return &windowsEncryptor{key: key}, nil
}

func (e *windowsEncryptor) IsAvailable() bool { return len(e.key) == 32 }

func (e *windowsEncryptor) EncryptString(plain string) (string, error) {
	if !e.IsAvailable() {
		return "", errors.New("加密密钥不可用")
	}
	gcm, err := e.gcm()
	if err != nil {
		return "", err
	}
	nonce := make([]byte, 12)
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	out := append([]byte(v10Prefix), nonce...)
	out = gcm.Seal(out, nonce, []byte(plain), nil)
	return base64.StdEncoding.EncodeToString(out), nil
}

func (e *windowsEncryptor) DecryptString(ciphertextB64 string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(ciphertextB64)
	if err != nil {
		return "", err
	}
	switch {
	case bytes.HasPrefix(raw, []byte(v10Prefix)):
		if !e.IsAvailable() {
			return "", errors.New("加密密钥不可用")
		}
		body := raw[len(v10Prefix):]
		if len(body) < 12+16 {
			return "", errors.New("密文太短")
		}
		gcm, err := e.gcm()
		if err != nil {
			return "", err
		}
		plain, err := gcm.Open(nil, body[:12], body[12:], nil)
		if err != nil {
			return "", err
		}
		return string(plain), nil
	case bytes.HasPrefix(raw, []byte(dpapiPrefix)):
		plain, err := cryptUnprotect(raw[len(dpapiPrefix):])
		if err != nil {
			return "", err
		}
		return string(plain), nil
	default:
		return "", errors.New("无法识别的密文格式（既非 v10 也非 DPAPI 前缀）")
	}
}

func (e *windowsEncryptor) gcm() (cipher.AEAD, error) {
	block, err := aes.NewCipher(e.key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// loadOrCreateKey 从 Local State 读 os_crypt.encrypted_key；没有就生成新密钥写回。
// 条目存在但解不开时直接报错——覆盖会弄丢全部存量密文。
func loadOrCreateKey(dir string) ([]byte, error) {
	path := filepath.Join(dir, localStateFile)
	state := map[string]any{}
	data, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if len(data) > 0 {
		if err := json.Unmarshal(data, &state); err != nil {
			return nil, fmt.Errorf("Local State 不是合法 JSON: %w", err)
		}
	}
	if osCrypt, ok := state["os_crypt"].(map[string]any); ok {
		if encoded, ok := osCrypt["encrypted_key"].(string); ok && encoded != "" {
			blob, err := base64.StdEncoding.DecodeString(encoded)
			if err != nil {
				return nil, fmt.Errorf("Local State 密钥不是 base64: %w", err)
			}
			if !bytes.HasPrefix(blob, []byte(dpapiPrefix)) {
				return nil, errors.New("Local State 密钥缺少 DPAPI 前缀")
			}
			key, err := cryptUnprotect(blob[len(dpapiPrefix):])
			if err != nil {
				return nil, fmt.Errorf("解不开 Local State 里的密钥（换了用户/机器？）: %w", err)
			}
			if len(key) != 32 {
				return nil, fmt.Errorf("Local State 密钥长度异常: %d", len(key))
			}
			return key, nil
		}
	}

	// 首次运行：与 Chromium 一样生成 32 字节随机密钥，DPAPI 保护后写回。
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	blob, err := cryptProtect(key)
	if err != nil {
		return nil, err
	}
	osCrypt, _ := state["os_crypt"].(map[string]any)
	if osCrypt == nil {
		osCrypt = map[string]any{}
	}
	osCrypt["encrypted_key"] = base64.StdEncoding.EncodeToString(append([]byte(dpapiPrefix), blob...))
	state["os_crypt"] = osCrypt
	out, err := json.Marshal(state)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, out, 0o600); err != nil {
		return nil, err
	}
	return key, nil
}

// cryptProtect 即 CryptProtectData（当前用户域，无额外 entropy、无提示窗），
// 与 Chromium 的调用参数一致。
func cryptProtect(plain []byte) ([]byte, error) {
	if len(plain) == 0 {
		return nil, errors.New("空数据")
	}
	in := windows.DataBlob{Size: uint32(len(plain)), Data: &plain[0]}
	var out windows.DataBlob
	if err := windows.CryptProtectData(&in, nil, nil, 0, nil, 0, &out); err != nil {
		return nil, err
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	return bytes.Clone(unsafe.Slice(out.Data, out.Size)), nil
}

// cryptUnprotect 即 CryptUnprotectData。
func cryptUnprotect(blob []byte) ([]byte, error) {
	if len(blob) == 0 {
		return nil, errors.New("空数据")
	}
	in := windows.DataBlob{Size: uint32(len(blob)), Data: &blob[0]}
	var out windows.DataBlob
	if err := windows.CryptUnprotectData(&in, nil, nil, 0, nil, 0, &out); err != nil {
		return nil, err
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	return bytes.Clone(unsafe.Slice(out.Data, out.Size)), nil
}
