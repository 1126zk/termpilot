package sshx

import (
	"context"
	"fmt"
	"io"
	"net"
	"regexp"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

// DialOptions 拨号附加参数。
type DialOptions struct {
	// 跳板 shell 回退时用的终端尺寸。
	Cols, Rows int
	// AllowJumpShell 允许"跳板禁止转发时回退到在跳板 shell 里再 ssh + 自动应答密码"。
	// 只有终端场景能开：回退产出的是一个跑在跳板上的交互 shell，不是到目标机的
	// SSH 客户端，上面开不了 SFTP / exec / 端口转发通道。文件树等通道调用方必须保持 false。
	AllowJumpShell bool
}

// Conn 一条拨好的连接。Client 是到目标机的 SSH 客户端；
// 走了跳板 shell 回退时 Client 是最后一跳跳板，Shell 持有回退终端流。
type Conn struct {
	Client *ssh.Client
	Shell  *JumpShell
	jumps  []*ssh.Client
}

// Close 关掉整条链路（目标客户端 + 每一跳跳板），对应 TS 的 endJump + client.end()。
func (c *Conn) Close() {
	if c.Shell != nil {
		c.Shell.Close()
	}
	if c.Client != nil {
		_ = c.Client.Close()
	}
	for _, jump := range c.jumps {
		_ = jump.Close()
	}
}

// Wait 阻塞到目标客户端连接断开。
func (c *Conn) Wait() error {
	if c.Client == nil {
		return nil
	}
	return c.Client.Conn.Wait()
}

// Dial 拨到目标机，对应 TS 的 dialSsh。secret 是目标机密码，jumpSecrets 按跳板顺序排列，
// 空字符串表示没有。同步实现：TS 里是回调链，但语义上就是逐级穿透。
func Dial(ctx context.Context, session *SessionConfig, secret string, jumpSecrets []string, opts *DialOptions) (*Conn, error) {
	if opts == nil {
		opts = &DialOptions{}
	}
	options := session.Options
	hops := jumpHops(session, jumpSecrets)

	if len(hops) == 0 {
		cfg := targetConfig(session, secret)
		transport, err := openTransport(ctx, cfg, session.Host, or22(session.Port), session.Username, options)
		if err != nil {
			return nil, err
		}
		client, err := handshake(transport, cfg)
		if err != nil {
			_ = transport.Close()
			return nil, err
		}
		startKeepalive(client, options)
		return &Conn{Client: client}, nil
	}

	var jumps []*ssh.Client
	closeJumps := func() {
		for _, jump := range jumps {
			_ = jump.Close()
		}
	}

	var sock net.Conn // 上一跳 forwardOut 出来的隧道
	for i, hop := range hops {
		cfg := hopConfig(hop, options)
		var client *ssh.Client
		if sock == nil {
			// 第一跳直连。TS 里 ProxyCommand 只用于无跳板的正向连接，跳板链不走它。
			transport, err := dialTCP(ctx, cfg, hop.host, or22(hop.port), options)
			if err != nil {
				closeJumps()
				return nil, fmt.Errorf("跳板连接失败: %w", err)
			}
			client, err = handshake(transport, cfg)
			if err != nil {
				_ = transport.Close()
				closeJumps()
				return nil, fmt.Errorf("跳板连接失败: %w", err)
			}
		} else {
			var err error
			client, err = handshake(sock, cfg)
			if err != nil {
				_ = sock.Close()
				closeJumps()
				return nil, fmt.Errorf("跳板连接失败: %w", err)
			}
		}
		startKeepalive(client, options)
		jumps = append(jumps, client)

		nextHost, nextPort := session.Host, or22(session.Port)
		if i+1 < len(hops) {
			nextHost, nextPort = hops[i+1].host, or22(hops[i+1].port)
		}
		tunnel, err := client.Dial("tcp", net.JoinHostPort(nextHost, fmt.Sprintf("%d", nextPort)))
		if err == nil {
			sock = tunnel
			continue
		}
		// 转发被禁：最后一跳且调用方是终端时，回退到跳板 shell 里再 ssh。
		last := i == len(hops)-1
		if last && opts.AllowJumpShell {
			shell, shellErr := openJumpShell(client, session, secret, opts)
			if shellErr != nil {
				closeJumps()
				return nil, fmt.Errorf("跳板无法转到目标机: %v（shell 回退也失败: %v）", err, shellErr)
			}
			return &Conn{Client: client, Shell: shell, jumps: jumps}, nil
		}
		closeJumps()
		return nil, fmt.Errorf("跳板无法转到目标机: %w", err)
	}

	cfg := targetConfig(session, secret)
	client, err := handshake(sock, cfg)
	if err != nil {
		_ = sock.Close()
		closeJumps()
		return nil, err
	}
	startKeepalive(client, options)
	// 目标连接断开时顺带关掉整条跳板链（对应 TS 里 client.on('close') 回收 opened）。
	go func() {
		_ = client.Conn.Wait()
		for _, jump := range jumps {
			_ = jump.Close()
		}
	}()
	return &Conn{Client: client, jumps: jumps}, nil
}

// dialHop 一跳的拨号参数。Password 为空表示只靠 keyboard-interactive 应答（可能答空串）。
type dialHop struct {
	host     string
	port     int
	username string
	password string
}

// jumpHops 按 session.Jumps 的顺序展开跳板及各自密码。
// jt_ 开头的用户名把口令并进用户名（username:password），口令本身置空——
// 那是这类堡垒机的认证格式，不是普通密码登录。
func jumpHops(session *SessionConfig, jumpSecrets []string) []dialHop {
	hops := make([]dialHop, 0, len(session.Jumps))
	for i, hop := range session.Jumps {
		host := strings.TrimSpace(hop.Host)
		if host == "" {
			continue
		}
		username := strings.TrimSpace(hop.Username)
		if username == "" {
			username = session.Username
		}
		password := ""
		if i < len(jumpSecrets) {
			password = jumpSecrets[i]
		}
		if i == 0 && strings.HasPrefix(username, "jt_") && password != "" && !strings.Contains(username, ":") {
			username = username + ":" + password
			password = ""
		}
		hops = append(hops, dialHop{host: host, port: or22(hop.Port), username: username, password: password})
	}
	return hops
}

// targetConfig 对应 buildConnectConfig：密码认证，默认 15s 握手超时。
func targetConfig(session *SessionConfig, secret string) *ssh.ClientConfig {
	cfg := &ssh.ClientConfig{
		User:    session.Username,
		Timeout: 15 * time.Second,
		// TS（ssh2）默认不校验主机密钥，strictHostKeyChecking 只控制是否显式放行；
		// 这里保持一致全部放行。known_hosts 校验（"yes" 的真语义）尚未实现。
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
	}
	if secret != "" {
		cfg.Auth = append(cfg.Auth, ssh.Password(secret))
	}
	applyDialOptions(cfg, session.Options)
	applyAlgorithms(cfg, session.Options)
	return cfg
}

// hopConfig 跳板自己的连接参数：20s 握手超时，tryKeyboard（keyboard-interactive 全答密码）。
func hopConfig(hop dialHop, options *ConnectOptions) *ssh.ClientConfig {
	keyboard := ssh.KeyboardInteractive(func(_ string, _ string, questions []string, _ []bool) ([]string, error) {
		answers := make([]string, len(questions))
		for i := range answers {
			answers[i] = hop.password
		}
		return answers, nil
	})
	cfg := &ssh.ClientConfig{
		User:            hop.username,
		Auth:            []ssh.AuthMethod{keyboard},
		Timeout:         20 * time.Second,
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
	}
	if hop.password != "" {
		cfg.Auth = append([]ssh.AuthMethod{ssh.Password(hop.password)}, cfg.Auth...)
	}
	applyDialOptions(cfg, options)
	applyAlgorithms(cfg, options)
	return cfg
}

// applyDialOptions 对应 TS 的 applyDialOptions：readyTimeoutMs=0 改成 120s 上限。
func applyDialOptions(cfg *ssh.ClientConfig, options *ConnectOptions) {
	if options == nil {
		return
	}
	if options.ReadyTimeoutMs != nil {
		if *options.ReadyTimeoutMs == 0 {
			cfg.Timeout = 120 * time.Second
		} else {
			cfg.Timeout = time.Duration(*options.ReadyTimeoutMs) * time.Millisecond
		}
	}
}

// openTransport 无跳板时的传输层：有 ProxyCommand 用本地命令，否则 TCP 直连。
func openTransport(ctx context.Context, cfg *ssh.ClientConfig, host string, port int, username string, options *ConnectOptions) (net.Conn, error) {
	if options != nil && options.ProxyCommand != "" {
		return openProxyCommand(options.ProxyCommand, host, port, username)
	}
	return dialTCP(ctx, cfg, host, port, options)
}

func dialTCP(ctx context.Context, cfg *ssh.ClientConfig, host string, port int, options *ConnectOptions) (net.Conn, error) {
	network := "tcp"
	var localAddr *net.TCPAddr
	if options != nil {
		if options.Family == 4 {
			network = "tcp4"
		} else if options.Family == 6 {
			network = "tcp6"
		}
		if options.LocalAddress != "" {
			addr, err := net.ResolveTCPAddr(network, net.JoinHostPort(options.LocalAddress, "0"))
			if err != nil {
				return nil, fmt.Errorf("localAddress 无效: %w", err)
			}
			localAddr = addr
		}
	}
	dialer := &net.Dialer{Timeout: cfg.Timeout, LocalAddr: localAddr}
	return dialer.DialContext(ctx, network, net.JoinHostPort(host, fmt.Sprintf("%d", port)))
}

// handshake 在已有传输层上完成 SSH 握手，用 cfg.Timeout 做截止时间（对应 ssh2 的 readyTimeout）。
func handshake(conn net.Conn, cfg *ssh.ClientConfig) (*ssh.Client, error) {
	if cfg.Timeout > 0 {
		_ = conn.SetDeadline(time.Now().Add(cfg.Timeout))
		defer func() { _ = conn.SetDeadline(time.Time{}) }()
	}
	c, chans, reqs, err := ssh.NewClientConn(conn, conn.RemoteAddr().String(), cfg)
	if err != nil {
		return nil, err
	}
	return ssh.NewClient(c, chans, reqs), nil
}

// startKeepalive 对应 ssh2 的 keepaliveInterval/keepaliveCountMax：
// 每隔 interval 发一个协议层心跳，连续 countMax 次没回应就判死关连接。
// options 里显式给了 0 表示关掉。默认 15s / 4 次。
func startKeepalive(client *ssh.Client, options *ConnectOptions) {
	intervalMs, countMax := 15000, 4
	if options != nil {
		if options.KeepaliveIntervalMs != nil {
			intervalMs = *options.KeepaliveIntervalMs
		}
		if options.KeepaliveCountMax != nil {
			countMax = *options.KeepaliveCountMax
		}
	}
	if intervalMs <= 0 || countMax <= 0 {
		return
	}
	interval := time.Duration(intervalMs) * time.Millisecond
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		missed := 0
		for range ticker.C {
			replied := make(chan error, 1)
			go func() {
				_, _, err := client.SendRequest("keepalive@openssh.com", true, nil)
				replied <- err
			}()
			select {
			case err := <-replied:
				if err != nil {
					missed++
				} else {
					missed = 0
				}
			case <-time.After(interval):
				// 请求本身卡住也算一次没回应；连接关闭后挂起的请求会报错退出。
				missed++
			}
			if missed >= countMax {
				_ = client.Close()
				return
			}
		}
	}()
}

func or22(port int) int {
	if port <= 0 {
		return 22
	}
	return port
}

// ---- 跳板 shell 回退 ----

// JumpShell 跳板禁止端口转发时的回退通道：在跳板的交互 shell 里跑 ssh 到目标机。
// Stdout 是 TeeReader——读它的同时，自动应答器也在看同一份输出。
type JumpShell struct {
	session *ssh.Session
	Stdin   io.Writer
	Stdout  io.Reader
}

func (s *JumpShell) Close() {
	_ = s.session.Close()
}

func openJumpShell(jump *ssh.Client, session *SessionConfig, secret string, opts *DialOptions) (*JumpShell, error) {
	sess, err := jump.NewSession()
	if err != nil {
		return nil, err
	}
	cols, rows := opts.Cols, opts.Rows
	if cols <= 0 {
		cols = 80
	}
	if rows <= 0 {
		rows = 24
	}
	if err := sess.RequestPty("xterm-256color", rows, cols, ssh.TerminalModes{}); err != nil {
		_ = sess.Close()
		return nil, err
	}
	stdin, err := sess.StdinPipe()
	if err != nil {
		_ = sess.Close()
		return nil, err
	}
	stdout, err := sess.StdoutPipe()
	if err != nil {
		_ = sess.Close()
		return nil, err
	}
	sess.Stderr = io.Discard // 不回读也要挂个去向，免得扩展数据把通道窗口塞满
	if err := sess.Shell(); err != nil {
		_ = sess.Close()
		return nil, err
	}
	answerer := newLoginAnswerer(stdin, session, secret)
	return &JumpShell{session: sess, Stdin: stdin, Stdout: io.TeeReader(stdout, answerer)}, nil
}

// jumpSSHCommand 在跳板 shell 里执行的命令，对应 loginTargetFromJump 拼的那条。
func jumpSSHCommand(session *SessionConfig) string {
	host := session.Host
	if strings.Contains(host, ":") && !strings.HasPrefix(host, "[") {
		host = "[" + host + "]"
	}
	port := ""
	if session.Port != 0 && session.Port != 22 {
		port = fmt.Sprintf(" -p %d", session.Port)
	}
	return fmt.Sprintf("ssh -tt -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o NumberOfPasswordPrompts=1%s %s@%s\n",
		port, session.Username, host)
}

var (
	continueConnectingRe = regexp.MustCompile(`(?i)are you sure you want to continue connecting`)
	passwordPromptRe     = regexp.MustCompile(`(?i)(?:password|passphrase|密码)\s*[:：]\s*$`)
	shellPromptRe        = regexp.MustCompile(`[#$>]\s*$`)
)

// loginAnswerer 对应 loginTargetFromJump：盯着跳板 shell 的输出，
// 看到密码提示就送目标机密码，看到确认提示就答 yes，看到普通提示符就发出 ssh 命令。
type loginAnswerer struct {
	stdin   io.Writer
	command string
	secret  string
	mu      sync.Mutex
	phase   int // 0=wait 1=asked 2=done
}

func newLoginAnswerer(stdin io.Writer, session *SessionConfig, secret string) *loginAnswerer {
	a := &loginAnswerer{stdin: stdin, command: jumpSSHCommand(session), secret: secret}
	// 1.2 秒还没认出提示符就主动发命令（对应 TS 的 setTimeout(ask, 1200)）。
	time.AfterFunc(1200*time.Millisecond, a.ask)
	return a
}

func (a *loginAnswerer) ask() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.phase != 0 {
		return
	}
	a.phase = 1
	_, _ = io.WriteString(a.stdin, a.command)
}

func (a *loginAnswerer) Write(p []byte) (int, error) {
	text := stripControls(string(p))
	if continueConnectingRe.MatchString(text) {
		_, _ = io.WriteString(a.stdin, "yes\n")
		return len(p), nil
	}
	trimmed := strings.TrimSpace(text)
	a.mu.Lock()
	needAsk := false
	if a.secret != "" && a.phase != 2 && passwordPromptRe.MatchString(trimmed) {
		a.phase = 2
		_, _ = io.WriteString(a.stdin, a.secret+"\n")
	} else if a.phase == 0 && shellPromptRe.MatchString(trimmed) {
		needAsk = true
	}
	a.mu.Unlock()
	if needAsk {
		a.ask()
	}
	return len(p), nil
}

var (
	ansiCSIRe = regexp.MustCompile("\x1b\\[[0-9;?]*[ -/]*[@-~]")
	ansiOSCRe = regexp.MustCompile("\x1b\\][^\x07]*(?:\x07|\x1b\\\\)")
)

// stripControls 去掉 CSI / OSC 转义序列，避免 ANSI 干扰提示符识别。
func stripControls(text string) string {
	return ansiOSCRe.ReplaceAllString(ansiCSIRe.ReplaceAllString(text, ""), "")
}
