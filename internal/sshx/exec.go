package sshx

import (
	"bufio"
	"errors"
	"io"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

// 对应 src/main/services/ExecService.ts：自动化命令通道。

// 单条流最多攒多少字节。超出后不再追加，防止输出洪水撑爆内存。
const execStreamCap = 1_000_000

// ExecOptions 一次自动化执行的参数。
type ExecOptions struct {
	Command   string
	Session   string // 命名 session：cd/export 持久化到远端 ~/.cache/termpilot/exec/
	Prelude   string
	TimeoutMs int
	MaxBytes  int
	// OnLine 非空时 stdout 逐行回调（装包/拉镜像的进度实时下发）；nil 时行为不变
	OnLine func(line string)
	// Cancel 被关闭时杀掉这次远端进程。nil 表示不能取消。
	Cancel <-chan struct{}
}

// ExecResult 一次自动化执行的结果。截断保留开头和结尾。
type ExecResult struct {
	Stdout   string
	Stderr   string
	ExitCode *int // 协议级退出码；对端没报（连接断等）为 nil
	// Duration 花了多少秒。
	Duration float64
	TimedOut bool
	// Canceled 调用方关闭了 Cancel。
	Canceled bool
	// Truncated stdout 或 stderr 因 MaxBytes 被截断时为 true。
	Truncated bool
}

// ExecService 在共用 SSH 会话上开独立 exec 通道，不占终端画面，天然并发。
// acquire 由调用方提供（一般接 Pool.Acquire + 存储层取密码），本包不碰凭据存储。
type ExecService struct {
	mu      sync.Mutex
	holds   map[string]*Hold
	pulls   map[string]*browserPull
	acquire func(sessionID string) (*Hold, error)
}

// NewExecService acquire 返回某会话的共享连接引用。
func NewExecService(acquire func(sessionID string) (*Hold, error)) *ExecService {
	return &ExecService{holds: map[string]*Hold{}, pulls: map[string]*browserPull{}, acquire: acquire}
}

// hold 每条连接缓存一个引用，和终端、文件树共用同一条 SSH 会话。
// 底层会话断开时主动丢掉缓存，下次 exec 重新拨号——否则缓存里一直留着死会话。
func (s *ExecService) hold(sessionID string) (*Hold, error) {
	s.mu.Lock()
	if cached := s.holds[sessionID]; cached != nil {
		s.mu.Unlock()
		return cached, nil
	}
	s.mu.Unlock()

	hold, err := s.acquire(sessionID)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	if cached := s.holds[sessionID]; cached != nil {
		// 并发获取撞上了，归还多余引用。
		s.mu.Unlock()
		hold.Release()
		return cached, nil
	}
	s.holds[sessionID] = hold
	s.mu.Unlock()
	go func() {
		_ = hold.Conn.Wait()
		s.mu.Lock()
		if s.holds[sessionID] == hold {
			delete(s.holds, sessionID)
		}
		s.mu.Unlock()
	}()
	return hold, nil
}

// Exec 跑一条命令。通道开不起来（连接已断）时丢掉缓存引用重拨一条再试一次——
// 此时命令从未发出，重试安全；重拨失败的错误（认证失败等）原样抛给调用方。
func (s *ExecService) Exec(sessionID string, opts ExecOptions) (*ExecResult, error) {
	hold, err := s.hold(sessionID)
	if err != nil {
		return nil, err
	}
	result, err := s.runOnce(hold, opts)
	if err == nil {
		return result, nil
	}
	s.mu.Lock()
	delete(s.holds, sessionID)
	s.mu.Unlock()
	hold.Release()
	hold, err = s.hold(sessionID)
	if err != nil {
		return nil, err
	}
	return s.runOnce(hold, opts)
}

var sessionNameRe = regexp.MustCompile(`[^\w-]`)

// ansiCSI 清掉终端控制序列，进度行里只留文字。
var ansiCSI = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]`)

// ansiOSC 清掉操作系统命令序列（标题、超链接一类）。
var ansiOSC = regexp.MustCompile(`\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)`)

// readProgress 把输出切成行。以 \r 结尾的片段是同一行的刷新，回调参数以 \r 开头；
// \r\n 和 \n 都是一行结束。调用方用前缀决定覆盖还是另起一行。
func readProgress(r io.Reader, onLine func(string)) {
	br := bufio.NewReaderSize(r, 64*1024)
	buf := make([]byte, 0, 256)
	flush := func(carriage bool) {
		text := strings.TrimRight(ansiCSI.ReplaceAllString(string(buf), ""), " \t")
		buf = buf[:0]
		if text == "" {
			return
		}
		if carriage {
			onLine("\r" + text)
			return
		}
		onLine(text)
	}
	for {
		b, err := br.ReadByte()
		if err != nil {
			if len(buf) > 0 {
				flush(false)
			}
			return
		}
		if b == '\n' {
			flush(false)
			continue
		}
		if b == '\r' {
			next, err2 := br.ReadByte()
			if err2 == nil && next == '\n' {
				flush(false)
				continue
			}
			if err2 == nil {
				_ = br.UnreadByte()
			}
			flush(true)
			if err2 != nil {
				return
			}
			continue
		}
		buf = append(buf, b)
		if len(buf) >= 8192 {
			flush(false)
		}
	}
}

// briefCommandOutput 从伪终端的原始输出里抽出最后一句有用的话。
// 回车符刷新和进度条行都丢掉，避免整段进度被当成错误提示。
func briefCommandOutput(s string) string {
	s = ansiOSC.ReplaceAllString(ansiCSI.ReplaceAllString(s, ""), "")
	var last string
	for _, line := range strings.Split(s, "\n") {
		if i := strings.LastIndex(line, "\r"); i >= 0 {
			line = line[i+1:]
		}
		line = strings.TrimSpace(strings.Map(func(r rune) rune {
			if r < 0x20 || r == 0x7f {
				return -1
			}
			return r
		}, line))
		if line == "" || isPullProgress(line) {
			continue
		}
		last = line
	}
	const maxRunes = 160
	if n := len([]rune(last)); n > maxRunes {
		last = string([]rune(last)[:maxRunes])
	}
	return last
}

func isPullProgress(s string) bool {
	switch {
	case strings.Contains(s, "Downloading"),
		strings.Contains(s, "Extracting"),
		strings.Contains(s, "Pulling fs layer"),
		strings.Contains(s, "Waiting"),
		strings.Contains(s, "Verifying Checksum"),
		strings.Contains(s, "Pull complete"),
		strings.Contains(s, "Download complete"),
		strings.Contains(s, "Pulling from "),
		strings.HasPrefix(s, "Using default tag"),
		strings.Contains(s, "Retrying"),
		strings.HasPrefix(s, "Digest:"),
		strings.HasPrefix(s, "Status:"):
		return true
	default:
		return false
	}
}

func (s *ExecService) runOnce(hold *Hold, opts ExecOptions) (*ExecResult, error) {
	client := hold.Conn.Client
	if client == nil {
		return nil, errors.New("连接未建立")
	}
	name := ""
	if opts.Session != "" {
		name = sessionNameRe.ReplaceAllString(opts.Session, "_")
	}
	script := BuildScript(name, opts.Prelude, opts.Command)
	started := time.Now()

	session, err := client.NewSession()
	if err != nil {
		return nil, err
	}
	defer func() { _ = session.Close() }()

	stdin, err := session.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := session.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := session.StderrPipe()
	if err != nil {
		return nil, err
	}
	// 脚本走 stdin 交给远端 bash（没有则 sh），命令原样嵌入，不经"键盘输入"，没有转义问题。
	if err := session.Start("command -v bash >/dev/null 2>&1 && exec bash -s || exec sh -s"); err != nil {
		return nil, err
	}
	go func() {
		_, _ = io.WriteString(stdin, script)
		_ = stdin.Close()
	}()

	outBuf := &cappedWriter{cap: execStreamCap}
	errBuf := &cappedWriter{cap: execStreamCap}
	var copyWg sync.WaitGroup
	copyWg.Add(2)
	if opts.OnLine != nil {
		// 流式输出：TeeReader 照常写满缓冲。docker pull 的百分比用回车符刷在同一行，
		// 这种行以 \r 开头交给调用方覆盖，换行才是新的一行。两路都要接。
		scan := func(r io.Reader, w io.Writer) {
			defer copyWg.Done()
			readProgress(io.TeeReader(r, w), opts.OnLine)
		}
		go scan(stdout, outBuf)
		go scan(stderr, errBuf)
	} else {
		go func() { defer copyWg.Done(); _, _ = io.Copy(outBuf, stdout) }()
		go func() { defer copyWg.Done(); _, _ = io.Copy(errBuf, stderr) }()
	}

	waitDone := make(chan error, 1)
	go func() { waitDone <- session.Wait() }()

	timedOut := false
	canceled := false
	var waitErr error
	timeout := time.Duration(opts.TimeoutMs) * time.Millisecond
	killRemote := func() {
		// Close 只是发 SSH_MSG_CHANNEL_CLOSE，对端 sshd 在子进程活着时会推迟回 CLOSE，
		// 本地管道读协程就收不到 EOF、一直阻塞。先 SIGKILL 杀远端子进程再 Close。
		_ = session.Signal(ssh.SIGKILL)
		_ = session.Close()
	}
	if timeout > 0 {
		select {
		case waitErr = <-waitDone:
		case <-opts.Cancel:
			canceled = true
			killRemote()
		case <-time.After(timeout):
			timedOut = true
			killRemote()
		}
	} else if opts.Cancel != nil {
		select {
		case waitErr = <-waitDone:
		case <-opts.Cancel:
			canceled = true
			killRemote()
		}
	} else {
		waitErr = <-waitDone
	}
	// 超时或取消时读协程可能仍阻塞（对端始终不回 CLOSE），最多再陪它们等 2 秒，
	// 到点直接返回；残留的读协程会在连接断开时自己退出
	if timedOut || canceled {
		drained := make(chan struct{})
		go func() { copyWg.Wait(); close(drained) }()
		select {
		case <-drained:
		case <-time.After(2 * time.Second):
		}
	} else {
		copyWg.Wait()
	}

	var exitCode *int
	if !timedOut && !canceled && waitErr == nil {
		code := 0
		exitCode = &code
	} else if !timedOut && !canceled {
		var exitErr *ssh.ExitError
		if errors.As(waitErr, &exitErr) {
			code := exitErr.ExitStatus()
			exitCode = &code
		}
		// 其余情况（io.EOF、连接断）没拿到协议级退出码，保持 nil。
	}

	outText, outTruncated := ClipStream(outBuf.String(), opts.MaxBytes)
	errText, errTruncated := ClipStream(errBuf.String(), opts.MaxBytes)
	return &ExecResult{
		Stdout:    outText,
		Stderr:    errText,
		ExitCode:  exitCode,
		Duration:  float64(time.Since(started).Milliseconds()) / 1000,
		TimedOut:  timedOut,
		Canceled:  canceled,
		Truncated: outTruncated || errTruncated,
	}, nil
}

// DetectOS 探测对端操作系统，给标签页和连接列表的图标用。先跑 uname -s（POSIX），
// Linux 再读 /etc/os-release 的 ID 拿发行版；BSD 直接按 uname 认。
// 认不出来再跑 ver（Windows cmd）。都不认就是 unknown。
// 不走 exec 的 bash 脚本通道——Windows 上没有 bash/sh，那条路必败。
func (s *ExecService) DetectOS(sessionID string) OsInfo {
	unknown := OsInfo{OS: "unknown"}
	hold, err := s.hold(sessionID)
	if err != nil {
		return unknown
	}
	defer hold.Release()
	if hold.Conn.Client == nil {
		return unknown
	}
	uname, err := rawExec(hold.Conn.Client, "uname -s", 5*time.Second)
	if err == nil {
		lower := strings.ToLower(uname)
		switch {
		case strings.Contains(lower, "linux"):
			release, _ := rawExec(hold.Conn.Client, "sh -c '. /etc/os-release 2>/dev/null; echo $ID'", 5*time.Second)
			fields := strings.Fields(strings.TrimSpace(release))
			if len(fields) > 0 {
				return OsInfo{OS: "linux", Distro: strings.ToLower(fields[0])}
			}
			return OsInfo{OS: "linux"}
		case strings.Contains(lower, "freebsd"):
			return OsInfo{OS: "linux", Distro: "freebsd"}
		case strings.Contains(lower, "openbsd"):
			return OsInfo{OS: "linux", Distro: "openbsd"}
		case strings.Contains(lower, "darwin"):
			return OsInfo{OS: "macos"}
		}
	}
	ver, err := rawExec(hold.Conn.Client, "ver", 5*time.Second)
	if err == nil && strings.Contains(strings.ToLower(ver), "windows") {
		return OsInfo{OS: "windows"}
	}
	return unknown
}

// rawExec 裸 exec：原样发命令，收集 stdout+stderr（最多 4096 字节），超时即止，返回已收到的部分。
func rawExec(client *ssh.Client, command string, timeout time.Duration) (string, error) {
	session, err := client.NewSession()
	if err != nil {
		return "", err
	}
	defer func() { _ = session.Close() }()
	buf := &cappedWriter{cap: 4096}
	session.Stdout = buf
	session.Stderr = buf
	done := make(chan error, 1)
	go func() { done <- session.Run(command) }()
	select {
	case err := <-done:
		return buf.String(), err
	case <-time.After(timeout):
		_ = session.Close()
		return buf.String(), nil
	}
}

// cappedWriter 攒到 cap 字节后不再追加（TS 版同样按"未满就整段收"判断，可能略超）。
type cappedWriter struct {
	buf strings.Builder
	cap int
}

func (w *cappedWriter) Write(p []byte) (int, error) {
	if w.buf.Len() < w.cap {
		w.buf.Write(p)
	}
	return len(p), nil
}

func (w *cappedWriter) String() string { return w.buf.String() }

// BuildScript 拼远端脚本。用户命令原样嵌在 { } 组里，stdin 重定向到 /dev/null，
// 防止命令自己读 stdin 时把脚本后半截吃掉。有 session 名时才回放和
// 保存环境状态（export -p 和 pwd）；没有就是全新环境，跑完即走。
func BuildScript(name, prelude, command string) string {
	var parts []string
	if name != "" {
		dir := "$HOME/.cache/termpilot/exec"
		parts = append(parts,
			`S="`+dir+`/`+name+`"`,
			`mkdir -p "`+dir+`" 2>/dev/null && chmod 700 "`+dir+`" 2>/dev/null`,
			`if [ -f "$S.env" ]; then . "$S.env" 2>/dev/null; fi`,
			`if [ -f "$S.pwd" ]; then cd "$(cat "$S.pwd")" 2>/dev/null || true; fi`,
		)
	}
	if strings.TrimSpace(prelude) != "" {
		parts = append(parts, prelude)
	}
	parts = append(parts, "{", command, "} < /dev/null")
	if name != "" {
		parts = append(parts,
			"rc=$?",
			`export -p > "$S.env" 2>/dev/null && chmod 600 "$S.env" 2>/dev/null`,
			`pwd > "$S.pwd" 2>/dev/null`,
			"exit $rc",
		)
	}
	return strings.Join(parts, "\n") + "\n"
}

// ClipStream 截断保留开头和结尾，中间注明原长。max <= 0 不截断。
func ClipStream(text string, max int) (string, bool) {
	runes := []rune(text)
	if max <= 0 || len(runes) <= max {
		return text, false
	}
	head := max / 2
	tail := max - head
	var b strings.Builder
	b.WriteString(string(runes[:head]))
	b.WriteString("\n…中间已截断，原长 ")
	b.WriteString(strconv.Itoa(len(runes)))
	b.WriteString(" 字符…\n")
	b.WriteString(string(runes[len(runes)-tail:]))
	return b.String(), true
}
