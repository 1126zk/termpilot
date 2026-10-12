package sshx

import (
	"golang.org/x/crypto/ssh"
)

// 对应 ssh-config.ts 的 algoList / toAlgorithms。
// OpenSSH 算法前缀语法：无前缀的条目表示全量替换默认列表；
// 全是前缀条目时，+ 追加、^ 前插、- 从默认列表删除（前缀条目里出现过的名字
// 同时从默认列表去掉，避免重复）。

// ResolveAlgorithmList 把带前缀的用户列表展开成具体算法列表。
// values 为空返回 nil（调用方保持默认）。base 是默认算法列表。
func ResolveAlgorithmList(values []string, base []string) []string {
	if len(values) == 0 {
		return nil
	}
	var append_, prepend, remove, plain []string
	for _, item := range values {
		switch {
		case len(item) > 1 && item[0] == '+':
			append_ = append(append_, item[1:])
		case len(item) > 1 && item[0] == '^':
			prepend = append(prepend, item[1:])
		case len(item) > 1 && item[0] == '-':
			remove = append(remove, item[1:])
		default:
			plain = append(plain, item)
		}
	}
	// 与 ssh2 一致：只要有无前缀条目就忽略所有前缀条目，整体替换。
	if len(plain) > 0 {
		return plain
	}
	excluded := map[string]bool{}
	for _, name := range remove {
		excluded[name] = true
	}
	for _, name := range prepend {
		excluded[name] = true
	}
	for _, name := range append_ {
		excluded[name] = true
	}
	out := make([]string, 0, len(prepend)+len(base)+len(append_))
	out = append(out, prepend...)
	for _, name := range base {
		if !excluded[name] {
			out = append(out, name)
		}
	}
	out = append(out, append_...)
	return out
}

// applyAlgorithms 把展开后的算法写进 ClientConfig；任何一类为空就保持 x/crypto 默认。
// 注意 TS 版 compress=true 会协商 zlib@openssh.com，x/crypto/ssh 不支持压缩，
// 这里只能忽略该选项（行为退化为不压缩，连接本身不受影响）。
func applyAlgorithms(cfg *ssh.ClientConfig, options *ConnectOptions) {
	if options == nil || options.Algorithms == nil {
		return
	}
	supported := ssh.SupportedAlgorithms()
	if list := ResolveAlgorithmList(options.Algorithms.Cipher, supported.Ciphers); list != nil {
		cfg.Ciphers = list
	}
	if list := ResolveAlgorithmList(options.Algorithms.Kex, supported.KeyExchanges); list != nil {
		cfg.KeyExchanges = list
	}
	if list := ResolveAlgorithmList(options.Algorithms.HMAC, supported.MACs); list != nil {
		cfg.MACs = list
	}
	if list := ResolveAlgorithmList(options.Algorithms.ServerHostKey, supported.HostKeys); list != nil {
		cfg.HostKeyAlgorithms = list
	}
}
