package sftpx

import (
	_ "embed"
	"errors"
	"io"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

// 远端没有 SFTP 子系统时的修复：在共享连接上执行 install-sftp.sh，
// 按输出的 TERMPILOT_SFTP 标记决定结果。对应 TS 的 execScript/installScript 与
// decide 里的标记解析。

// embeddedInstallScript 打包进二进制的 install-sftp.sh（resources/ 下同名脚本的副本，
// 改动以 resources 为准后同步过来）。加载时统一成 LF。
//
//go:embed install_sftp.sh
var embeddedInstallScript string

// EmbeddedInstallScript 返回内嵌的安装脚本（CRLF 归一成 LF，对应 TS installScript 的 replace）。
func EmbeddedInstallScript() (string, error) {
	return strings.ReplaceAll(embeddedInstallScript, "\r\n", "\n"), nil
}

// installOutcome 安装脚本的结果。
type installOutcome int

const (
	installFailed   installOutcome = iota // 没改成内置（含脚本本身失败）
	installSwitched                       // 这次改成了 internal-sftp
	installAlready                        // 本来就是 internal-sftp
)

// installMarker 脚本输出里的结果标记前缀。
const installMarker = "TERMPILOT_SFTP "

// parseInstallResult 解析脚本输出。返回结果与去掉标记行后的说明文本
// （对应 TS decide 里的 lines.filter + 两个 some 判断）。
func parseInstallResult(code int, lines []string) (installOutcome, []string) {
	note := make([]string, 0, len(lines))
	switched, already := false, false
	for _, line := range lines {
		if strings.HasPrefix(line, installMarker) {
			switch line {
			case installMarker + "switched":
				switched = true
			case installMarker + "already":
				already = true
			}
			continue
		}
		note = append(note, line)
	}
	if code == 0 && switched {
		return installSwitched, note
	}
	if code == 0 && already {
		return installAlready, note
	}
	return installFailed, note
}

// scriptResult 对应 TS execScript 的 { code, lines }。
type scriptResult struct {
	Code  int
	Lines []string
}

// lineCollector 对应 TS execScript 里的 take()：按行切开，去掉行尾 \r，跳过空行；
// Flush 对应 close 时把残留的非空尾巴收进去。
type lineCollector struct {
	mu      sync.Mutex
	pending string
	lines   []string
	onLog   func(string)
}

func (c *lineCollector) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.pending += string(p)
	for {
		nl := strings.IndexByte(c.pending, '\n')
		if nl < 0 {
			break
		}
		line := strings.TrimSuffix(c.pending[:nl], "\r")
		c.pending = c.pending[nl+1:]
		if strings.TrimSpace(line) != "" {
			c.lines = append(c.lines, line)
			if c.onLog != nil {
				c.onLog(line)
			}
		}
	}
	return len(p), nil
}

// Flush 收尾：还有残留的非空内容按一行收（TS 里是 pending.trim()）。
func (c *lineCollector) Flush() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if trimmed := strings.TrimSpace(c.pending); trimmed != "" {
		c.lines = append(c.lines, trimmed)
		if c.onLog != nil {
			c.onLog(trimmed)
		}
	}
	c.pending = ""
}

// execScript 对应 TS execScript：sh -s 从 stdin 喂脚本，stdout/stderr 一起按行收，
// 15 秒不结束判超时。退出码对端没报（连接断等）按 1。
func execScript(client *ssh.Client, script string, onLog func(string)) (*scriptResult, error) {
	session, err := client.NewSession()
	if err != nil {
		return nil, err
	}
	stdin, err := session.StdinPipe()
	if err != nil {
		_ = session.Close()
		return nil, err
	}
	stdout, err := session.StdoutPipe()
	if err != nil {
		_ = session.Close()
		return nil, err
	}
	stderr, err := session.StderrPipe()
	if err != nil {
		_ = session.Close()
		return nil, err
	}
	if err := session.Start("sh -s"); err != nil {
		_ = session.Close()
		return nil, err
	}
	go func() {
		_, _ = io.WriteString(stdin, script)
		_ = stdin.Close()
	}()

	collector := &lineCollector{onLog: onLog}
	var copyWg sync.WaitGroup
	copyWg.Add(2)
	go func() { defer copyWg.Done(); _, _ = io.Copy(collector, stdout) }()
	go func() { defer copyWg.Done(); _, _ = io.Copy(collector, stderr) }()

	waitDone := make(chan error, 1)
	go func() { waitDone <- session.Wait() }()

	select {
	case waitErr := <-waitDone:
		copyWg.Wait()
		collector.Flush()
		code := 0
		if waitErr != nil {
			var exitErr *ssh.ExitError
			if errors.As(waitErr, &exitErr) {
				code = exitErr.ExitStatus()
			} else {
				code = 1
			}
		}
		return &scriptResult{Code: code, Lines: collector.lines}, nil
	case <-time.After(15 * time.Second):
		_ = session.Close()
		copyWg.Wait()
		return nil, errors.New("检查 SFTP 子系统超时")
	}
}
