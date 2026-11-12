package sshx

import "strings"

// FriendlyError 把 SSH、网络和 SFTP 的英文错误翻成界面上的中文。
// 认不出来的保持原文。跳板错误保留中文前缀，只翻译后面的原因。
func FriendlyError(err error) string {
	if err == nil {
		return ""
	}
	return friendlyMessage(err.Error())
}

func friendlyMessage(message string) string {
	const shellFail = "（shell 回退也失败:"
	for _, prefix := range []string{"跳板连接失败:", "跳板无法转到目标机:"} {
		if !strings.HasPrefix(message, prefix) {
			continue
		}
		rest := strings.TrimSpace(message[len(prefix):])
		if i := strings.Index(rest, shellFail); i >= 0 {
			head := strings.TrimSpace(rest[:i])
			inner := strings.TrimSuffix(rest[i+len(shellFail):], "）")
			return prefix + " " + translateSSH(head) + shellFail + " " + strings.TrimSpace(translateSSH(inner)) + "）"
		}
		return prefix + " " + translateSSH(rest)
	}
	return translateSSH(message)
}

func translateSSH(message string) string {
	lower := strings.ToLower(message)
	switch {
	case strings.Contains(message, "All configured authentication methods failed"),
		strings.Contains(message, "unable to authenticate"):
		return "认证失败：用户名或密码不对"
	case strings.Contains(lower, "no such host"),
		strings.Contains(message, "ENOTFOUND"),
		strings.Contains(message, "EAI_AGAIN"):
		return "找不到主机：检查地址或网络"
	case strings.Contains(lower, "actively refused"),
		strings.Contains(message, "ECONNREFUSED"),
		strings.Contains(lower, "connection refused"):
		return "连接被拒绝：目标端口没有开放"
	case strings.Contains(lower, "did not properly respond"),
		strings.Contains(lower, "failed to respond"),
		strings.Contains(message, "ETIMEDOUT"),
		strings.Contains(message, "Timed out while waiting for handshake"),
		strings.Contains(message, "i/o timeout"):
		return "连接超时"
	case strings.Contains(message, "EHOSTUNREACH"),
		strings.Contains(message, "ENETUNREACH"),
		strings.Contains(lower, "unreachable"):
		return "主机不可达：检查网络"
	case strings.Contains(lower, "connection reset by peer"),
		strings.Contains(lower, "forcibly closed by the remote host"):
		return "连接被对方重置"
	case strings.Contains(lower, "no common algorithm"):
		return "算法不兼容：和服务器没有共同的加密算法"
	case strings.Contains(lower, "overflow reading version string"),
		strings.Contains(lower, "invalid protocol version"):
		return "对方不是 SSH 服务：检查端口"
	case strings.Contains(message, "ssh: disconnect, reason"):
		return disconnectPhrase(message)
	case strings.Contains(message, "handshake failed") && strings.Contains(message, "EOF"):
		return "握手中断：已经连上，但对方在登录完成前关闭了连接"
	case strings.Contains(message, "Connection lost before handshake"):
		return "握手前连接中断"
	case strings.Contains(message, "pty-req failed"):
		return "对方拒绝分配终端"
	case strings.Contains(message, "command shell failed"):
		return "对方拒绝打开 shell"
	case strings.Contains(lower, "administratively prohibited"):
		return "对方拒绝了这个通道"
	case strings.Contains(lower, "permission denied"):
		return "没有权限"
	case strings.Contains(lower, "no such file"):
		return "文件不存在"
	case sftpFailure(message):
		return "远程操作失败"
	case message == "EOF" || strings.HasSuffix(message, ": EOF") || strings.Contains(message, "unexpected EOF"):
		return "对方关闭了连接"
	}
	return message
}

// disconnectPhrase 把服务器随断开带回来的那句收成短中文。认不出的不再展开原文。
func disconnectPhrase(message string) string {
	lower := strings.ToLower(message)
	switch {
	case strings.Contains(lower, "unexpected bytes"), strings.Contains(lower, "incomplete message"):
		return "数据包无效，服务器已断开"
	case strings.Contains(lower, "client not responding"):
		return "服务器保活超时"
	default:
		return "服务器已断开"
	}
}

// sftpFailure 只认 SFTP 的 Failure 状态，避免把别的 “failed” 误当成远程操作失败。
func sftpFailure(message string) bool {
	if !strings.Contains(strings.ToLower(message), "sftp:") {
		return false
	}
	return strings.Contains(message, `"Failure"`) || strings.Contains(strings.ToLower(message), "ssh_fx_failure")
}
