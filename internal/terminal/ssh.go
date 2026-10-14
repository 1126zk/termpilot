package terminal

import (
	"context"
	"errors"
	"io"
	"strings"

	"golang.org/x/crypto/ssh"

	"termpilot/internal/sshx"
)

// SSH shell 通道与跳板禁转发回退，对应 TS TerminalService 的
// createSsh / bindShared / openJumpShell / sshChannel。

func (s *Service) createSSH(opts CreateOptions, retried bool) {
	if s.sessions == nil {
		s.sendStatus(opts.TermID, opts.SessionID, StatusError, "会话存储未装配")
		return
	}
	session := s.sessions.FindSession(opts.SessionID)
	if session == nil {
		s.sendStatus(opts.TermID, opts.SessionID, StatusError, "会话不存在")
		return
	}

	s.mu.Lock()
	entry := s.terms[opts.TermID]
	if entry == nil {
		entry = &Entry{
			id:        opts.TermID,
			sessionID: session.ID,
			kind:      KindSSH,
			title:     orDefault(strings.TrimSpace(opts.Title), "终端"),
		}
		s.terms[opts.TermID] = entry
	}
	s.mu.Unlock()
	gen := s.arm(entry)
	s.sendStatus(opts.TermID, session.ID, StatusConnecting, "")

	secret := s.sessions.GetSecret(session.ID)
	jumpSecret := s.sessions.GetJumpSecret(session.ID)
	hold, err := s.pool.Acquire(context.Background(), session, secret, jumpSecret)
	if err != nil {
		if !s.alive(entry, gen) {
			return
		}
		// 跳板禁止端口转发时，只给终端在跳板里再登录一次（JumpShell）。
		if strings.TrimSpace(session.JumpHost) != "" && isForwardDenied(err) {
			s.openJumpShell(entry, opts, session, secret, jumpSecret, gen)
			return
		}
		s.sendStatus(opts.TermID, session.ID, StatusError, friendlyConnectError(err))
		return
	}
	if !s.alive(entry, gen) {
		hold.Release()
		return
	}
	s.bindShared(entry, hold, opts, gen, retried)
}

// bindShared 转发已经通了。shell 开在这条会话上，不再向跳板要一次连接。
func (s *Service) bindShared(entry *Entry, hold *sshx.Hold, opts CreateOptions, gen int, retried bool) {
	sessionID := entry.sessionID
	s.mu.Lock()
	entry.release = hold.Release
	s.mu.Unlock()
	s.watchClient(entry, gen, sessionID, hold.Conn.Client)
	err := s.openShell(entry, hold.Conn.Client, opts, gen)
	if err == nil {
		return
	}
	if !s.alive(entry, gen) {
		return
	}
	// 池里拿到的是半死连接（心跳还没来得及判死）：清掉缓存重拨一次。
	// shell 还没开出来，重试没有副作用
	if !retried && sessionID != "" {
		s.releaseLive(entry)
		s.pool.Drop(sessionID)
		s.createSSH(opts, true)
		return
	}
	s.sendStatus(entry.id, sessionID, StatusError, "打开 shell 失败: "+err.Error())
}

// openJumpShell 跳板不许转发时，只给终端在跳板里再登录一次。
// 这条没有到目标机的 SSH 客户端，文件树用不上。
func (s *Service) openJumpShell(entry *Entry, opts CreateOptions, session *sshx.SessionConfig, secret, jumpSecret string, gen int) {
	cols, rows := s.sizeOf(entry.id, opts.Cols, opts.Rows)
	conn, err := sshx.Dial(context.Background(), session, secret, jumpSecret, &sshx.DialOptions{
		Cols:           cols,
		Rows:           rows,
		AllowJumpShell: true,
	})
	if !s.alive(entry, gen) {
		if conn != nil {
			conn.Close()
		}
		return
	}
	if err != nil {
		s.releaseLive(entry)
		s.sendStatus(entry.id, session.ID, StatusError, friendlyConnectError(err))
		return
	}
	s.mu.Lock()
	entry.conn = conn
	s.mu.Unlock()
	s.watchClient(entry, gen, session.ID, conn.Client)

	if conn.Shell != nil {
		ch := &jumpShellChannel{shell: conn.Shell}
		s.mu.Lock()
		entry.ch = ch
		s.mu.Unlock()
		s.sendStatus(entry.id, session.ID, StatusConnected, "")
		go func() {
			buf := make([]byte, 32*1024)
			for {
				n, rerr := conn.Shell.Stdout.Read(buf)
				if n > 0 {
					s.sendData(entry.id, buf[:n])
				}
				if rerr != nil {
					if s.alive(entry, gen) {
						s.releaseLive(entry)
						s.sendStatus(entry.id, session.ID, StatusDisconnected, "")
					}
					return
				}
			}
		}()
		return
	}
	// 转发其实是通的（或没走跳板）：当普通共享连接处理，只是引用在 conn 上。
	if err := s.openShell(entry, conn.Client, opts, gen); err != nil {
		if !s.alive(entry, gen) {
			return
		}
		s.sendStatus(entry.id, session.ID, StatusError, "打开 shell 失败: "+err.Error())
	}
}

// openShell 在已连好的 SSH 客户端上开交互 shell 并接好数据通路，对应 TS client.shell 回调。
func (s *Service) openShell(entry *Entry, client *ssh.Client, opts CreateOptions, gen int) error {
	sess, err := client.NewSession()
	if err != nil {
		return err
	}
	cols, rows := s.sizeOf(entry.id, opts.Cols, opts.Rows)
	if cols <= 0 {
		cols = 80
	}
	if rows <= 0 {
		rows = 24
	}
	if err := sess.RequestPty("xterm-256color", rows, cols, ssh.TerminalModes{}); err != nil {
		_ = sess.Close()
		return err
	}
	stdin, err := sess.StdinPipe()
	if err != nil {
		_ = sess.Close()
		return err
	}
	stdout, err := sess.StdoutPipe()
	if err != nil {
		_ = sess.Close()
		return err
	}
	stderr, err := sess.StderrPipe()
	if err != nil {
		_ = sess.Close()
		return err
	}
	if err := sess.Shell(); err != nil {
		_ = sess.Close()
		return err
	}
	s.attachChannel(entry, &sshShellChannel{sess: sess, stdin: stdin}, cols, rows)
	s.mu.Lock()
	sessionID := entry.sessionID
	s.mu.Unlock()
	s.sendStatus(entry.id, sessionID, StatusConnected, "")
	go pumpStream(stdout, func(b []byte) { s.sendData(entry.id, b) })
	go pumpStream(stderr, func(b []byte) { s.sendData(entry.id, b) })
	go func() {
		_ = sess.Wait()
		if !s.alive(entry, gen) {
			return
		}
		s.releaseLive(entry)
		s.sendStatus(entry.id, sessionID, StatusDisconnected, "")
	}()
	return nil
}

// watchClient 对应 TS 的 client.on('error'/'close')：底层连接断开时收掉这扇终端的通道。
func (s *Service) watchClient(entry *Entry, gen int, sessionID string, client *ssh.Client) {
	go func() {
		err := client.Conn.Wait()
		if !s.alive(entry, gen) {
			return
		}
		s.releaseLive(entry)
		if err == nil || errors.Is(err, io.EOF) {
			s.sendStatus(entry.id, sessionID, StatusDisconnected, "")
		} else {
			s.sendStatus(entry.id, sessionID, StatusError, friendlyConnectError(err))
		}
	}()
}

func pumpStream(r io.Reader, onData func([]byte)) {
	buf := make([]byte, 32*1024)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			onData(buf[:n])
		}
		if err != nil {
			return
		}
	}
}

// sshShellChannel SSH shell 通道。
type sshShellChannel struct {
	sess  *ssh.Session
	stdin io.Writer
}

func (c *sshShellChannel) Write(data []byte) error {
	_, err := c.stdin.Write(data)
	return err
}

// Resize 对应 TS 的 stream.setWindow(rows, cols, 0, 0)。
func (c *sshShellChannel) Resize(cols, rows int) error {
	return c.sess.WindowChange(rows, cols)
}

func (c *sshShellChannel) Close() error {
	return c.sess.Close()
}

// jumpShellChannel 跳板 shell 回退通道：写进跳板的 stdin，读它的 stdout。
// sshx.JumpShell 未暴露 WindowChange，resize 为空操作（TS 的 TerminalChannel.resize 也是可选的）。
type jumpShellChannel struct {
	shell *sshx.JumpShell
}

func (c *jumpShellChannel) Write(data []byte) error {
	_, err := c.shell.Stdin.Write(data)
	return err
}

func (c *jumpShellChannel) Resize(cols, rows int) error { return nil }

func (c *jumpShellChannel) Close() error {
	c.shell.Close()
	return nil
}

// friendlyConnectError 把 SSH/网络的英文错误翻成用户能看懂的中文，认不出来的保持原文。
// 对应 TS friendlyConnectError；额外覆盖 Go x/crypto 的认证失败措辞。
func friendlyConnectError(err error) string {
	if err == nil {
		return ""
	}
	message := err.Error()
	switch {
	case strings.Contains(message, "All configured authentication methods failed"),
		strings.Contains(message, "unable to authenticate"):
		return "认证失败：用户名或密码不对"
	case strings.Contains(message, "ENOTFOUND"), strings.Contains(message, "EAI_AGAIN"),
		strings.Contains(message, "no such host"):
		return "找不到主机：检查地址或网络"
	case strings.Contains(message, "ECONNREFUSED"), strings.Contains(message, "connection refused"):
		return "连接被拒绝：目标端口没有开放"
	case strings.Contains(message, "ETIMEDOUT"), strings.Contains(message, "Timed out while waiting for handshake"),
		strings.Contains(message, "i/o timeout"):
		return "连接超时"
	case strings.Contains(message, "EHOSTUNREACH"), strings.Contains(message, "ENETUNREACH"),
		strings.Contains(message, "unreachable"):
		return "主机不可达：检查网络"
	case strings.Contains(message, "Connection lost before handshake"):
		return "握手前连接中断"
	}
	return message
}

// isForwardDenied 对应 TS isForwardDenied：跳板不许转发的判定串来自 sshx.Dial。
func isForwardDenied(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(err.Error(), "跳板无法转到目标机")
}
