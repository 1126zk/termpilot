package sftpx

import (
	"path"
	"strings"
)

// 远端路径在进包边界统一成正斜杠，之后一律按 POSIX 规则拼接（path 包），
// 不碰 filepath（那是本地路径用的）。对应 TS 里所有 posix.join / posix 语义。

// normalizeRemotePath 边界归一化：反斜杠改正斜杠。
func normalizeRemotePath(p string) string {
	return strings.ReplaceAll(p, "\\", "/")
}

// dirOrDot 对应 TS 的 dir || '.'。
func dirOrDot(dir string) string {
	if dir == "" {
		return "."
	}
	return dir
}

// remoteJoin 对应 TS posix.join。
func remoteJoin(elem ...string) string {
	return path.Join(elem...)
}

// remoteBase 对应 TS basename（远端路径按 POSIX 取）。
func remoteBase(p string) string {
	return path.Base(p)
}

// expandTilde 对应 TS using() 里的 ~ 展开：SFTP 协议不认 ~，展开成登录目录
// 的绝对路径。home 不是绝对路径（解析失败）时原样返回。
func expandTilde(p, home string) string {
	if p != "~" && !strings.HasPrefix(p, "~/") {
		return p
	}
	if !strings.HasPrefix(home, "/") {
		return p
	}
	return strings.TrimRight(home, "/") + p[1:]
}

// loginRelativePath 对应 TS loginRelative：把登录目录下的绝对路径换成相对路径
// （某些 SFTP 服务端只认相对登录目录的路径）。返回 "" 表示没有可用的替代写法。
func loginRelativePath(home, p string) string {
	if !strings.HasPrefix(p, "/") {
		return ""
	}
	root := strings.TrimRight(home, "/")
	if !strings.HasPrefix(root, "/") {
		return ""
	}
	prefix := root + "/"
	if root == "/" {
		prefix = "/"
	}
	if !strings.HasPrefix(p, prefix) {
		return ""
	}
	rest := p[len(prefix):]
	if rest != "" && rest != p {
		return rest
	}
	return ""
}
