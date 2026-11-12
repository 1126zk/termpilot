package sshx

import "testing"

func TestFriendlyError(t *testing.T) {
	cases := map[string]string{
		"All configured authentication methods failed": "认证失败：用户名或密码不对",
		"ssh: handshake failed: ssh: unable to authenticate, attempted methods [none password], no supported methods remain": "认证失败：用户名或密码不对",
		"dial tcp: lookup x: ENOTFOUND":                        "找不到主机：检查地址或网络",
		"dial tcp: lookup example.com: No such host is known.": "找不到主机：检查地址或网络",
		"dial tcp 1.2.3.4:22: connectex: No connection could be made because the target machine actively refused it.": "连接被拒绝：目标端口没有开放",
		"dial tcp 1.2.3.4:22: connect: connection refused":                                                            "连接被拒绝：目标端口没有开放",
		"read: ETIMEDOUT": "连接超时",
		"dial tcp 1.2.3.4:22: connectex: A connection attempt failed because the connected party did not properly respond after a period of time, or established connection failed because connected host has failed to respond.": "连接超时",
		"dial tcp: EHOSTUNREACH":                                                                                     "主机不可达：检查网络",
		"read tcp 1.2.3.4:1->5.6.7.8:22: connection reset by peer":                                                   "连接被对方重置",
		"wsarecv: An existing connection was forcibly closed by the remote host.":                                    "连接被对方重置",
		"ssh: handshake failed: ssh: no common algorithm for key exchange; client offered: [a], server offered: [b]": "算法不兼容：和服务器没有共同的加密算法",
		"ssh: handshake failed: ssh: overflow reading version string":                                                "对方不是 SSH 服务：检查端口",
		`ssh: handshake failed: ssh: invalid protocol version "HTTP/1.1"`:                                            "对方不是 SSH 服务：检查端口",
		"ssh: disconnect, reason 11: bye":                                                                            "服务器已断开",
		"ssh: disconnect, reason 2: channel_input_data: unexpected bytes remain after decoding":                      "数据包无效，服务器已断开",
		"ssh: disconnect, reason 2: channel_input_data: get data: incomplete message":                                "数据包无效，服务器已断开",
		"ssh: disconnect, reason 2: Timeout, client not responding":                                                  "服务器保活超时",
		"ssh: handshake failed: EOF":                                                                                 "握手中断：已经连上，但对方在登录完成前关闭了连接",
		"Connection lost before handshake":                                                                           "握手前连接中断",
		"ssh: pty-req failed":                                                                                        "对方拒绝分配终端",
		"ssh: command shell failed":                                                                                  "对方拒绝打开 shell",
		"ssh: rejected: administratively prohibited (open failed)":                                                   "对方拒绝了这个通道",
		"EOF":                                 "对方关闭了连接",
		"read tcp 1.2.3.4:1->5.6.7.8:22: EOF": "对方关闭了连接",
		`sftp: "Permission denied" (SSH_FX_PERMISSION_DENIED)`: "没有权限",
		`sftp: "No such file" (SSH_FX_NO_SUCH_FILE)`:           "文件不存在",
		`sftp: "Failure" (SSH_FX_FAILURE)`:                     "远程操作失败",
		"跳板连接失败: ssh: handshake failed: EOF":                   "跳板连接失败: 握手中断：已经连上，但对方在登录完成前关闭了连接",
		"跳板无法转到目标机: dial tcp 1.2.3.4:22: connect: connection refused（shell 回退也失败: ssh: handshake failed: EOF）": "跳板无法转到目标机: 连接被拒绝：目标端口没有开放（shell 回退也失败: 握手中断：已经连上，但对方在登录完成前关闭了连接）",
		"别的错误": "别的错误",
	}
	for in, want := range cases {
		if got := FriendlyError(errString(in)); got != want {
			t.Errorf("FriendlyError(%q)\n got %q\nwant %q", in, got, want)
		}
	}
}

type errString string

func (e errString) Error() string { return string(e) }
