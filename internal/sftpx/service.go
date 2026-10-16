package sftpx

import (
	"errors"
	"io"
	"regexp"
	"sync"
	"time"

	"github.com/pkg/sftp"

	"termpilot/internal/sshx"
)

// routeKind 这台机器的文件通道走哪条 SSH（TS SftpService.route）。
// fresh 表示刚改过 sshd 子系统，不能复用登录时的旧会话。
type routeKind int

const (
	routeShared routeKind = iota
	routeFresh
)

// Options 服务依赖。会话查找与取密码由上层做好，包内不碰存储。
type Options struct {
	// Acquire 取会话的共享连接引用（一般接 sshx.Pool.Acquire + 存储层取密码）。
	// 找不到会话时应返回「只能浏览正向 SSH 的文件」。
	Acquire func(sessionID string) (*sshx.Hold, error)
	// AcquireIsolated 另拨一条独立连接（sshx.Pool.AcquireIsolated）。
	// 改过 sshd 子系统之后必须走它，旧会话仍按登录时的配置执行 SFTP。
	AcquireIsolated func(sessionID string) (*sshx.Hold, error)
	// InstallScript 远端修复脚本的内容来源，可注入；nil 用内嵌的 install-sftp.sh。
	InstallScript func() (string, error)
	// OnTransfer 传输进度事件（TS 里推到 IPC.sftpTransfer）。
	OnTransfer func(TransferEvent)
	// OnInstall 安装进度事件（TS 里推到 IPC.sftpInstall）。
	OnInstall func(InstallEvent)
}

// liveConn 一条活着的文件通道（TS LiveConn）。
type liveConn struct {
	client *sftp.Client
	hold   *sshx.Hold

	mu       sync.Mutex
	home     string // 登录目录缓存（TS loginDirs WeakMap），解析失败也缓存空串
	homeDone bool
}

// loginDir 对应 TS loginDir：realpath('.')，10 秒超时，失败按空串缓存。
func (c *liveConn) loginDir() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.homeDone {
		return c.home
	}
	home, err := withTimeout(func() (string, error) { return c.client.RealPath(".") },
		10*time.Second, "SFTP 没有响应")
	if err != nil {
		home = ""
	}
	c.home = home
	c.homeDone = true
	return c.home
}

// using 对应 TS using()：~ 展开成登录目录绝对路径；操作报 noSuchFile 时
// 回退到相对登录目录的写法再试一次。
func (c *liveConn) using(p string, run func(string) error) error {
	if p == "~" || len(p) > 1 && p[:2] == "~/" {
		expanded := expandTilde(p, c.loginDir())
		if err := run(expanded); err != nil {
			if alt := loginRelativePath(c.loginDir(), expanded); alt != "" && noSuchFile(err) {
				return run(alt)
			} else {
				return err
			}
		}
		return nil
	}
	if err := run(p); err != nil {
		if alt := loginRelativePath(c.loginDir(), p); alt != "" && noSuchFile(err) {
			return run(alt)
		} else {
			return err
		}
	}
	return nil
}

// connEntry 对应 TS conns 里存的 Promise<LiveConn>：并发打开同一会话共享同一次连接。
type connEntry struct {
	ready chan struct{}
	conn  *liveConn
	err   error
}

type chooseEntry struct {
	done chan struct{}
	kind routeKind
	err  error
}

// Service 文件通道服务，对应 TS SftpService。
type Service struct {
	opts Options

	mu         sync.Mutex
	conns      map[string]*connEntry
	active     map[string]func() // 进行中的传输：id → 取消函数
	route      map[string]routeKind
	choosing   map[string]*chooseEntry
	switchNote map[string][]string // 没改成内置时留下的说明，原来的通道也打不开才显示
}

// New 建服务。
func New(opts Options) *Service {
	return &Service{
		opts:       opts,
		conns:      map[string]*connEntry{},
		active:     map[string]func(){},
		route:      map[string]routeKind{},
		choosing:   map[string]*chooseEntry{},
		switchNote: map[string][]string{},
	}
}

func (s *Service) emitTransfer(ev TransferEvent) {
	if ev.Error != "" {
		ev.Error = sshx.FriendlyError(errors.New(ev.Error))
	}
	if s.opts.OnTransfer != nil {
		s.opts.OnTransfer(ev)
	}
}

func (s *Service) emitInstall(sessionID string, phase InstallPhase, text string) {
	if s.opts.OnInstall != nil {
		s.opts.OnInstall(InstallEvent{SessionID: sessionID, Phase: phase, Text: text})
	}
}

// run 所有 SFTP 操作的入口。通道半死（对端没响应、连接已断）时把缓存的连接扔掉，
// 下次调用重新拨号——不然一次网络抖动之后文件面板会永远卡死。
func (s *Service) run(sessionID string, op func(conn *liveConn) error) error {
	conn, err := s.sftpOf(sessionID)
	if err != nil {
		return present(err)
	}
	if err := op(conn); err != nil {
		if isDeadChannel(err) {
			s.Close(sessionID)
		}
		return present(err)
	}
	return nil
}

// sftpOf 对应 TS sftpOf：拿这台机器的 SFTP 通道；打不开且像缺子系统时，
// 先跑安装脚本再决定走共享还是 fresh 连接。
func (s *Service) sftpOf(sessionID string) (*liveConn, error) {
	s.mu.Lock()
	entry := s.conns[sessionID]
	s.mu.Unlock()
	if entry != nil {
		<-entry.ready
		if entry.err != nil {
			s.dropEntry(sessionID, entry)
			return nil, present(entry.err)
		}
		return entry.conn, nil
	}
	if s.routeOf(sessionID) == routeFresh {
		conn, err := s.openFresh(sessionID)
		return conn, present(err)
	}
	conn, err := s.open(sessionID)
	if err == nil {
		return conn, nil
	}
	if s.hasRoute(sessionID) || !isMissingSftp(err) {
		return nil, present(err)
	}
	kind, chooseErr := s.choose(sessionID)
	if chooseErr != nil {
		s.setSwitchNote(sessionID, []string{chooseErr.Error()})
		s.setRoute(sessionID, routeShared)
		kind = routeShared
	}
	if kind != routeFresh {
		if note := s.takeSwitchNote(sessionID); len(note) > 0 {
			s.emitInstall(sessionID, InstallStart, "文件通道没有打开")
			for _, line := range note {
				s.emitInstall(sessionID, InstallLog, line)
			}
			s.emitInstall(sessionID, InstallError, sshx.FriendlyError(err))
		}
		return nil, present(err)
	}
	conn, err = s.openFresh(sessionID)
	return conn, present(err)
}

// open 走共享连接开 SFTP（TS open/connect）。
func (s *Service) open(sessionID string) (*liveConn, error) {
	s.mu.Lock()
	if entry := s.conns[sessionID]; entry != nil {
		s.mu.Unlock()
		<-entry.ready
		if entry.err != nil {
			s.dropEntry(sessionID, entry)
			return nil, entry.err
		}
		return entry.conn, nil
	}
	entry := &connEntry{ready: make(chan struct{})}
	s.conns[sessionID] = entry
	s.mu.Unlock()

	conn, err := s.armSftp(sessionID, false)
	entry.conn, entry.err = conn, err
	close(entry.ready)
	if err != nil {
		s.dropEntry(sessionID, entry)
		return nil, err
	}
	s.watchClose(sessionID, entry, conn.hold)
	return conn, nil
}

// openFresh 安装脚本改的是 sshd 配置，必须新开一条连接，旧会话不会读到新子系统。
func (s *Service) openFresh(sessionID string) (*liveConn, error) {
	s.mu.Lock()
	old := s.conns[sessionID]
	delete(s.conns, sessionID)
	s.mu.Unlock()
	if old != nil {
		go func() {
			<-old.ready
			if old.conn != nil {
				old.conn.hold.Release()
			}
		}()
	}

	entry := &connEntry{ready: make(chan struct{})}
	s.mu.Lock()
	s.conns[sessionID] = entry
	s.mu.Unlock()

	conn, err := s.armSftp(sessionID, true)
	entry.conn, entry.err = conn, err
	close(entry.ready)
	if err != nil {
		s.dropEntry(sessionID, entry)
		return nil, err
	}
	s.watchClose(sessionID, entry, conn.hold)
	return conn, nil
}

// armSftp 对应 TS armSftp：在拨好的连接上开 SFTP 子系统，12 秒不响应就算失败。
func (s *Service) armSftp(sessionID string, isolated bool) (*liveConn, error) {
	acquire := s.opts.Acquire
	if isolated {
		acquire = s.opts.AcquireIsolated
	}
	if acquire == nil {
		return nil, errors.New("只能浏览正向 SSH 的文件")
	}
	hold, err := acquire(sessionID)
	if err != nil {
		return nil, err
	}
	if hold.Conn == nil || hold.Conn.Client == nil {
		hold.Release()
		return nil, errors.New("只能浏览正向 SSH 的文件")
	}
	client, err := withTimeout(func() (*sftp.Client, error) {
		return sftp.NewClient(hold.Conn.Client)
	}, 12*time.Second, "SFTP 子系统没有响应")
	if err != nil {
		hold.Release()
		return nil, err
	}
	return &liveConn{client: client, hold: hold}, nil
}

// watchClose 底层 SSH 断开时丢掉缓存条目并归还引用（TS connect 里的 client.on('close')）。
func (s *Service) watchClose(sessionID string, entry *connEntry, hold *sshx.Hold) {
	go func() {
		_ = hold.Conn.Wait()
		s.dropEntry(sessionID, entry)
		hold.Release()
	}()
}

// Close 关掉某会话的文件通道（归还连接引用；共享连接上还有终端在用时不影响对方）。
func (s *Service) Close(sessionID string) {
	s.mu.Lock()
	entry := s.conns[sessionID]
	delete(s.conns, sessionID)
	s.mu.Unlock()
	if entry == nil {
		return
	}
	go func() {
		<-entry.ready
		if entry.conn != nil {
			entry.conn.hold.Release()
		}
	}()
}

// DisposeAll 关掉所有文件通道。
func (s *Service) DisposeAll() {
	s.mu.Lock()
	ids := make([]string, 0, len(s.conns))
	for id := range s.conns {
		ids = append(ids, id)
	}
	s.mu.Unlock()
	for _, id := range ids {
		s.Close(id)
	}
}

// choose 对应 TS choose：原来的通道打不开时才决定要不要改 sshd；并发调用共享同一次决定。
func (s *Service) choose(sessionID string) (routeKind, error) {
	s.mu.Lock()
	if kind, ok := s.route[sessionID]; ok {
		s.mu.Unlock()
		return kind, nil
	}
	if pending := s.choosing[sessionID]; pending != nil {
		s.mu.Unlock()
		<-pending.done
		return pending.kind, pending.err
	}
	entry := &chooseEntry{done: make(chan struct{})}
	s.choosing[sessionID] = entry
	s.mu.Unlock()

	entry.kind, entry.err = s.decide(sessionID)
	close(entry.done)
	s.mu.Lock()
	delete(s.choosing, sessionID)
	s.mu.Unlock()
	return entry.kind, entry.err
}

// decide 对应 TS decide：在共享连接上执行 install-sftp.sh，按 TERMPILOT_SFTP 标记决定路由。
func (s *Service) decide(sessionID string) (routeKind, error) {
	if s.opts.Acquire == nil {
		return routeShared, errors.New("只能浏览正向 SSH 的文件")
	}
	hold, err := s.opts.Acquire(sessionID)
	if err != nil {
		return routeShared, err
	}
	defer hold.Release()
	if hold.Conn == nil || hold.Conn.Client == nil {
		return routeShared, errors.New("只能浏览正向 SSH 的文件")
	}
	source := s.opts.InstallScript
	if source == nil {
		source = EmbeddedInstallScript
	}
	script, err := source()
	if err != nil {
		return routeShared, err
	}
	result, err := execScript(hold.Conn.Client, script, nil)
	if err != nil {
		return routeShared, err
	}
	outcome, note := parseInstallResult(result.Code, result.Lines)
	switch outcome {
	case installSwitched:
		s.emitInstall(sessionID, InstallStart, "这台机器还没用 sshd 自带的 SFTP，先改过去")
		for _, line := range note {
			s.emitInstall(sessionID, InstallLog, line)
		}
		s.emitInstall(sessionID, InstallDone, "已经改成内置 SFTP，正在连接")
		s.setRoute(sessionID, routeFresh)
		return routeFresh, nil
	case installAlready:
		s.setRoute(sessionID, routeShared)
		return routeShared, nil
	default:
		s.setSwitchNote(sessionID, note)
		s.setRoute(sessionID, routeShared)
		return routeShared, nil
	}
}

func (s *Service) dropEntry(sessionID string, entry *connEntry) {
	s.mu.Lock()
	if s.conns[sessionID] == entry {
		delete(s.conns, sessionID)
	}
	s.mu.Unlock()
}

func (s *Service) routeOf(sessionID string) routeKind {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.route[sessionID]
}

func (s *Service) hasRoute(sessionID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.route[sessionID]
	return ok
}

func (s *Service) setRoute(sessionID string, kind routeKind) {
	s.mu.Lock()
	s.route[sessionID] = kind
	s.mu.Unlock()
}

func (s *Service) setSwitchNote(sessionID string, note []string) {
	s.mu.Lock()
	s.switchNote[sessionID] = note
	s.mu.Unlock()
}

func (s *Service) takeSwitchNote(sessionID string) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	note := s.switchNote[sessionID]
	delete(s.switchNote, sessionID)
	return note
}

// present 把返回给界面的错误换成中文。认不出来的保持原错误，方便 errors.Is。
func present(err error) error {
	if err == nil {
		return nil
	}
	msg := sshx.FriendlyError(err)
	if msg == err.Error() {
		return err
	}
	return errors.New(msg)
}

// withTimeout 对应 TS withTimeout：到时间就报错返回，底层操作留给连接关闭时自然收场。
func withTimeout[T any](fn func() (T, error), d time.Duration, message string) (T, error) {
	type result struct {
		v   T
		err error
	}
	done := make(chan result, 1)
	go func() {
		v, err := fn()
		done <- result{v, err}
	}()
	select {
	case r := <-done:
		return r.v, r.err
	case <-time.After(d):
		var zero T
		return zero, errors.New(message)
	}
}

var (
	missingSftpRe = regexp.MustCompile(`(?i)exit code 127|establishing SFTP|sftp subsystem|sftp-server|subsystem request failed|没有响应|子系统超时`)
	deadChannelRe = regexp.MustCompile(`(?i)没有响应|超时|timed out|Not connected|通道已关闭|connection.*(closed|lost)|channel.*closed`)
)

// isMissingSftp 对应 TS isMissingSftp：像是对端没开 SFTP 子系统。
func isMissingSftp(err error) bool {
	if err == nil {
		return false
	}
	return missingSftpRe.MatchString(err.Error())
}

// isDeadChannel 对应 TS isDeadChannel：等对端响应超时、底层连接已断。
// 这种错误要丢掉缓存连接重拨。
func isDeadChannel(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, io.ErrClosedPipe) {
		return true
	}
	return deadChannelRe.MatchString(err.Error())
}

// noSuchFile 对应 TS noSuchFile（codeOf(err) === 2，SSH_FX_NO_SUCH_FILE）。
func noSuchFile(err error) bool {
	var se *sftp.StatusError
	if errors.As(err, &se) {
		return se.Code == 2
	}
	return false
}
