// Package secrets 是 Electron safeStorage 凭据加密的 Go 移植。
//
// 落盘格式调查结论（依据 src/main/services/StorageService.ts 与对线上
// %APPDATA%\TermPilot\termpilot.db 的实测）：
//
//   - 代码里从未调用 safeStorage.setUseAppBoundEncryption，线上 Local State 也没有
//     os_crypt.app_bound_encrypted_key —— App-Bound Encryption 未启用。
//   - Electron（Chromium OSCrypt）在 Windows 上的 safeStorage 密文并不是裸 DPAPI blob：
//     实测密文以 "v10" 开头，格式为
//     "v10" || 12 字节 nonce || AES-256-GCM(key, nonce, 明文) || 16 字节 tag
//     其中 key 存在 userData/Local State 的 os_crypt.encrypted_key 里：
//     base64("DPAPI" || CryptProtectData(32 字节随机密钥))
//     整条密文再经 base64 后写入 sqlite TEXT 列。
//   - 因此 Go 版可以完全双向兼容：CryptUnprotectData 解出 AES 密钥后即可
//     解存量密文；按同一格式写出的新密文 Electron 版也能解。
//   - 兼容兜底：DecryptString 同时接受老式 "DPAPI" 前缀的裸 DPAPI blob
//     （Chromium 80 之前的格式），以及（仅 Linux 基本后端）"v11" 明文前缀。
//
// darwin/linux 用 zalando/go-keyring 取 Chromium 存放在系统钥匙串里的
// 口令（"<AppName> Safe Storage"），按 Chromium 规则派生 AES-128-CBC 密钥
// （salt "saltysalt"，darwin 1003 次 / linux 1 次 PBKDF2-HMAC-SHA1，IV 为 16 个空格），
// 密文同样带 "v10" 前缀，与 Electron 互通。
package secrets

// Encryptor 对应 safeStorage.encryptString/decryptString 对，
// 密文统一为 base64 字符串。实现见各平台文件。
type Encryptor interface {
	// EncryptString 明文 → base64 密文。
	EncryptString(plain string) (string, error)
	// DecryptString base64 密文 → 明文。
	DecryptString(ciphertextB64 string) (string, error)
	// IsAvailable 对应 safeStorage.isEncryptionAvailable()。
	IsAvailable() bool
}
