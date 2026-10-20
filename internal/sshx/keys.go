package sshx

import (
	"context"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
)

// 和当前这台 Windows 的 ssh -G 打印的默认顺序一致。ssh 自己能问出来时不用这份。
var fallbackIdentityFiles = []string{
	"~/.ssh/id_rsa",
	"~/.ssh/id_ecdsa",
	"~/.ssh/id_ecdsa_sk",
	"~/.ssh/id_ed25519",
	"~/.ssh/id_ed25519_sk",
	"~/.ssh/id_xmss",
	"~/.ssh/id_dsa",
}

// openSigners 按系统 ssh 的办法找私钥：先问 ssh -G 这次会试哪些文件，
// identitiesonly 不是 yes 时再加上密钥代理里的钥匙。不让用户另外指定。
func openSigners(host, user string, port int) ([]ssh.Signer, func(), error) {
	files, identitiesOnly := identityFilesFor(host, user, port)
	var out []ssh.Signer
	closer := func() {}
	if !identitiesOnly {
		if conn, err := dialAuthAgent(); err == nil {
			signers, err := agent.NewClient(conn).Signers()
			if err == nil && len(signers) > 0 {
				out = append(out, signers...)
				closer = func() { _ = conn.Close() }
			} else {
				_ = conn.Close()
			}
		}
	}
	for _, file := range files {
		raw, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		signer, err := ssh.ParsePrivateKey(raw)
		if err != nil {
			continue
		}
		out = append(out, signer)
	}
	if len(out) == 0 {
		return nil, nil, errors.New("没有找到可用的私钥")
	}
	return out, closer, nil
}

// identityFilesFor 问系统 ssh 这次登录会用哪些私钥。问失败时用它的默认清单。
func identityFilesFor(host, user string, port int) (files []string, identitiesOnly bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if port <= 0 {
		port = 22
	}
	out, err := exec.CommandContext(ctx, "ssh", "-G", "-p", strconv.Itoa(port), "-l", user, "--", host).Output()
	if err != nil {
		return expandIdentityPaths(fallbackIdentityFiles), false
	}
	files, identitiesOnly = parseSSHG(string(out))
	if len(files) == 0 {
		return expandIdentityPaths(fallbackIdentityFiles), identitiesOnly
	}
	return expandIdentityPaths(files), identitiesOnly
}

// parseSSHG 从 ssh -G 的输出里取出 identityfile 和 identitiesonly。
func parseSSHG(text string) (files []string, identitiesOnly bool) {
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		key, value, ok := strings.Cut(line, " ")
		if !ok {
			continue
		}
		switch strings.ToLower(key) {
		case "identityfile":
			if value != "" && !strings.EqualFold(value, "none") {
				files = append(files, value)
			}
		case "identitiesonly":
			identitiesOnly = strings.EqualFold(value, "yes") || value == "true"
		}
	}
	return files, identitiesOnly
}

func expandIdentityPaths(files []string) []string {
	home, err := os.UserHomeDir()
	out := make([]string, 0, len(files))
	for _, file := range files {
		file = strings.Trim(file, `"'`)
		if err == nil && (strings.HasPrefix(file, "~/") || strings.HasPrefix(file, `~\`)) {
			file = filepath.Join(home, file[2:])
		}
		out = append(out, file)
	}
	return out
}

type pipeAddr struct{}

func (pipeAddr) Network() string { return "pipe" }
func (pipeAddr) String() string  { return "ssh-agent" }

// agentConn 把同步打开的管道当成 net.Conn。签名在握手期间完成。
type agentConn struct{ f *os.File }

func (c agentConn) Read(b []byte) (int, error)         { return c.f.Read(b) }
func (c agentConn) Write(b []byte) (int, error)        { return c.f.Write(b) }
func (c agentConn) Close() error                       { return c.f.Close() }
func (c agentConn) LocalAddr() net.Addr                { return pipeAddr{} }
func (c agentConn) RemoteAddr() net.Addr               { return pipeAddr{} }
func (c agentConn) SetDeadline(time.Time) error        { return nil }
func (c agentConn) SetReadDeadline(time.Time) error    { return nil }
func (c agentConn) SetWriteDeadline(time.Time) error   { return nil }
