//go:build darwin || linux

package secrets

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"errors"
	"fmt"
	"runtime"

	"github.com/zalando/go-keyring"
	"golang.org/x/crypto/pbkdf2"
)

// darwin/linux 密文格式（Chromium OSCrypt，与 Electron safeStorage 一致）：
//
//	密文 = "v10" || AES-128-CBC(key, IV=16 个空格, PKCS7(明文))，再 base64。
//	key  = PBKDF2-HMAC-SHA1(钥匙串口令, salt="saltysalt", 迭代 1003(darwin)/1(linux), 16 字节)
//
// 钥匙串口令与 Electron 共用同一条目：service "<AppName> Safe Storage"、account "<AppName>"
// （Chrome 是 "Chrome Safe Storage"/"Chrome"，本应用按 userData 目录名 TermPilot 计）。
// 条目不存在时现场生成并写入，Electron 之后也会直接复用它。
//
// 已知限制：Linux 上若 Electron 走了 basic 后端（硬编码口令 "peanuts"）或密文是
// "v11" 明文前缀，解密路径做了兼容（见 DecryptString）。

const (
	keychainService = "TermPilot Safe Storage"
	keychainAccount = "TermPilot"

	v10Prefix = "v10"
	v11Prefix = "v11" // linux basic 后端：v11 后面就是明文

	osCryptSalt = "saltysalt"
)

var cbcIV = bytes.Repeat([]byte{' '}, 16)

type keyringEncryptor struct {
	password   string   // 钥匙串里的原始口令
	iterations int      // darwin 1003 / linux 1
	fallbacks  []string // 仅 linux：Electron 可能用了硬编码口令
}

// New 从系统钥匙串取（或创建）与 Electron 共用的口令。userDataDir 在该平台用不到。
func New(userDataDir string) (Encryptor, error) {
	iterations := 1
	if runtime.GOOS == "darwin" {
		iterations = 1003
	}
	e := &keyringEncryptor{iterations: iterations}
	password, err := keyring.Get(keychainService, keychainAccount)
	if errors.Is(err, keyring.ErrNotFound) {
		password, err = generatePassword()
		if err != nil {
			return nil, err
		}
		if err := keyring.Set(keychainService, keychainAccount, password); err != nil {
			return nil, fmt.Errorf("写入系统钥匙串失败: %w", err)
		}
	} else if err != nil {
		return nil, fmt.Errorf("读取系统钥匙串失败: %w", err)
	}
	e.password = password
	if runtime.GOOS == "linux" {
		e.fallbacks = []string{"peanuts"}
	}
	return e, nil
}

func (e *keyringEncryptor) IsAvailable() bool { return e.password != "" }

func (e *keyringEncryptor) EncryptString(plain string) (string, error) {
	if !e.IsAvailable() {
		return "", errors.New("系统钥匙串不可用")
	}
	block, err := aes.NewCipher(e.deriveKey(e.password))
	if err != nil {
		return "", err
	}
	out := append([]byte(v10Prefix), cbcEncrypt(block, []byte(plain))...)
	return base64.StdEncoding.EncodeToString(out), nil
}

func (e *keyringEncryptor) DecryptString(ciphertextB64 string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(ciphertextB64)
	if err != nil {
		return "", err
	}
	if bytes.HasPrefix(raw, []byte(v11Prefix)) {
		return string(raw[len(v11Prefix):]), nil
	}
	if !bytes.HasPrefix(raw, []byte(v10Prefix)) {
		return "", errors.New("无法识别的密文格式（缺少 v10 前缀）")
	}
	body := raw[len(v10Prefix):]
	for _, password := range append([]string{e.password}, e.fallbacks...) {
		if password == "" {
			continue
		}
		block, err := aes.NewCipher(e.deriveKey(password))
		if err != nil {
			continue
		}
		if plain, err := cbcDecrypt(block, body); err == nil {
			return string(plain), nil
		}
	}
	return "", errors.New("解密失败（钥匙串口令与密文不匹配）")
}

func (e *keyringEncryptor) deriveKey(password string) []byte {
	return pbkdf2.Key([]byte(password), []byte(osCryptSalt), e.iterations, 16, sha1.New)
}

// generatePassword 生成随机口令（可打印字符，避开 keyring 后端的编码坑）。
func generatePassword() (string, error) {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	out := make([]byte, len(b))
	for i, v := range b {
		out[i] = alphabet[int(v)%len(alphabet)]
	}
	return string(out), nil
}

func cbcEncrypt(block cipher.Block, plain []byte) []byte {
	pad := aes.BlockSize - len(plain)%aes.BlockSize
	plain = append(bytes.Clone(plain), bytes.Repeat([]byte{byte(pad)}, pad)...)
	out := make([]byte, len(plain))
	cipher.NewCBCEncrypter(block, cbcIV).CryptBlocks(out, plain)
	return out
}

func cbcDecrypt(block cipher.Block, blob []byte) ([]byte, error) {
	if len(blob) == 0 || len(blob)%aes.BlockSize != 0 {
		return nil, errors.New("密文长度不是块大小的整数倍")
	}
	out := make([]byte, len(blob))
	cipher.NewCBCDecrypter(block, cbcIV).CryptBlocks(out, blob)
	if len(out) == 0 {
		return nil, errors.New("空密文")
	}
	pad := int(out[len(out)-1])
	if pad < 1 || pad > aes.BlockSize || pad > len(out) {
		return nil, errors.New("PKCS7 填充损坏")
	}
	for _, b := range out[len(out)-pad:] {
		if int(b) != pad {
			return nil, errors.New("PKCS7 填充损坏")
		}
	}
	return out[:len(out)-pad], nil
}
