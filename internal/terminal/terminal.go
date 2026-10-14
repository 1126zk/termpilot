// Package terminal 是 TermPilot 终端层的 Go 移植，语义逐一对应 Electron 版
// src/main/services/TerminalService.ts：统一管理 SSH shell 通道（golang.org/x/crypto/ssh）
// 和本机 PTY（Windows ConPTY / Unix ptmx），归一成 Channel。
// 数据下行与状态/meta/历史事件通过 Emitter 回调吐出，由桥接层转给前端；
// 会话与历史落库通过 SessionStore / HistoryStore 接口注入，本包不直接依赖 storage。
package terminal

import (
	crand "crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"termpilot/internal/sshx"
)

// Channel 一扇终端背后的活动通道：SSH shell 或本机 PTY，归一成这个形状。
// 对应 TS 的 TerminalChannel。数据下行和状态事件在创建通道时各自接线，
// 都汇进 Service 的 sendData / sendStatus。
type Channel interface {
	Write(data []byte) error
	// Resize 不支持的通道（如跳板 shell 回退）实现为空操作。
	Resize(cols, rows int) error
	Close() error
}

// Entry 一扇终端的运行态，对应 TS TermEntry。
type Entry struct {
	id        string
	sessionID string // 本机终端为空（TS 的 null）
	kind      Kind
	// 这扇终端的活动通道：SSH shell 或本机 PTY。只管数据通路；
	// 共享连接的池引用在 release 上，断开时一起交还。
	ch Channel
	// SSH 池的引用。最后一次交还才真正断开。
	release func()
	// 跳板禁转发回退（JumpShell）直登时整条连接挂在这上面，关掉终端一起断开。
	conn   *sshx.Conn
	title  string
	remark string
	// 每次拨号加一。旧连接迟到的关闭事件不再拆掉新的。
	liveGen int
}

// statusWatcher 状态事件的内部订阅者（WaitStatus / Reconnect 用）。
type statusWatcher struct {
	ch chan StatusEvent
}

// Service 终端服务，对应 TS TerminalService。数据下行通过 Emitter 推送，上行走方法调用。
type Service struct {
	sessions SessionStore
	history  HistoryStore
	emitter  Emitter
	pool     *sshx.Pool

	mu         sync.Mutex
	terms      map[string]*Entry
	output     map[string]*ringBuffer
	lastStatus map[string]StatusEvent
	watchers   map[*statusWatcher]struct{}
	// 界面已经订上输出。之前的内容先补一次，避免重启后的记录被新输出盖掉。
	viewReady   map[string]bool
	bindWaiters map[string]chan struct{}
	// 每扇终端正在输入的那一行。
	lines map[string]*lineState
	// 界面最后一次报上来的窗口大小。通道还没建好时报上来的也记着，建好后补上，
	// 否则 PTY 一直停在创建时的 80x24，光标和画面对不上。
	sizes map[string][2]int
	// 正在退出。此时断开不要把窗口从库里删掉。
	parking bool
}

// NewService 装配终端服务。pool 为 SSH 共享连接池；emitter / sessions / history 由上层注入，
// emitter 可以为 nil（事件丢弃），sessions 为 nil 时 SSH 终端不可用（本地终端不受影响）。
func NewService(sessions SessionStore, history HistoryStore, emitter Emitter, pool *sshx.Pool) *Service {
	return &Service{
		sessions:    sessions,
		history:     history,
		emitter:     emitter,
		pool:        pool,
		terms:       map[string]*Entry{},
		output:      map[string]*ringBuffer{},
		lastStatus:  map[string]StatusEvent{},
		watchers:    map[*statusWatcher]struct{}{},
		viewReady:   map[string]bool{},
		bindWaiters: map[string]chan struct{}{},
		lines:       map[string]*lineState{},
		sizes:       map[string][2]int{},
	}
}

// Create 对应 TS create。已经连着或正在连接时直接返回。
// 连接过程是同步的（拨号最长等到握手超时），结果通过状态事件下发。
func (s *Service) Create(opts CreateOptions) {
	s.mu.Lock()
	existing := s.terms[opts.TermID]
	busy := existing != nil && (existing.ch != nil ||
		(s.lastStatus[opts.TermID].TermID != "" && s.lastStatus[opts.TermID].Status == StatusConnecting))
	s.mu.Unlock()
	if busy {
		return
	}
	if opts.Kind == KindLocal {
		s.createLocal(opts)
		return
	}
	s.createSSH(opts, false)
}

// Input 对应 TS input：先结算按键流进历史，再写进通道。
func (s *Service) Input(termID, data string) {
	s.captureInput(termID, data)
	if ch := s.channelOf(termID); ch != nil {
		_ = ch.Write([]byte(data))
	}
}

// Resize 对应 TS resize。连接已断开时忽略错误。
func (s *Service) Resize(termID string, cols, rows int) {
	if cols <= 0 || rows <= 0 {
		return
	}
	s.mu.Lock()
	s.sizes[termID] = [2]int{cols, rows}
	var ch Channel
	if t := s.terms[termID]; t != nil {
		ch = t.ch
	}
	s.mu.Unlock()
	if ch != nil {
		_ = ch.Resize(cols, rows)
	}
}

// sizeOf 界面报过大小就用界面的，否则用创建参数。
func (s *Service) sizeOf(termID string, cols, rows int) (int, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if size, ok := s.sizes[termID]; ok {
		return size[0], size[1]
	}
	return cols, rows
}

// attachChannel 通道建好时挂上，并补上建的过程中界面报来的大小。
func (s *Service) attachChannel(entry *Entry, ch Channel, cols, rows int) {
	s.mu.Lock()
	entry.ch = ch
	size, ok := s.sizes[entry.id]
	s.mu.Unlock()
	if ok && (size[0] != cols || size[1] != rows) {
		_ = ch.Resize(size[0], size[1])
	}
}

// Reconnect 同一扇终端重新拨号。编号、标题、备注和已有输出都留着。已经连着时直接返回。
func (s *Service) Reconnect(termID string) error {
	s.mu.Lock()
	term := s.terms[termID]
	s.mu.Unlock()
	if term == nil {
		return errors.New("终端不存在或已关闭")
	}
	if term.kind != KindSSH || term.sessionID == "" {
		return errors.New("本机终端断开后不会保留，请用 term_open_local 再开一扇")
	}
	if s.sessions == nil || s.sessions.FindSession(term.sessionID) == nil {
		return errors.New("这条连接已经删除了")
	}
	if s.channelOf(termID) != nil {
		return nil
	}
	s.mu.Lock()
	connecting := s.lastStatus[termID].Status == StatusConnecting && s.lastStatus[termID].TermID != ""
	s.mu.Unlock()
	if connecting {
		return s.WaitStatus(termID, 20*time.Second)
	}
	s.releaseLive(term)
	// 只听这次拨号之后的状态，不把上次的失败当成这次的结果。
	pending := s.waitNextStatus(termID, 20*time.Second)
	s.Create(CreateOptions{
		TermID:    termID,
		Kind:      KindSSH,
		SessionID: term.sessionID,
		Title:     term.title,
		Cols:      120,
		Rows:      32,
	})
	return pending()
}

// Close 人关掉或助手关掉。编号不再恢复。
func (s *Service) Close(termID string) {
	s.mu.Lock()
	t := s.terms[termID]
	delete(s.terms, termID)
	delete(s.output, termID)
	delete(s.lines, termID)
	delete(s.lastStatus, termID)
	delete(s.viewReady, termID)
	delete(s.sizes, termID)
	s.mu.Unlock()
	s.releaseLive(t)
}

// BindView 界面订上之后，把这次运行里已经到达、还没画上的输出补上。
func (s *Service) BindView(termID string) {
	s.mu.Lock()
	ring := s.output[termID]
	text := ""
	if ring != nil {
		text = ring.text()
	}
	first := !s.viewReady[termID]
	s.viewReady[termID] = true
	s.mu.Unlock()
	if first && text != "" {
		s.push(termID, []byte(text))
	}
}

// ListTerms 对应 TS listTerms。按终端编号排序（TS 的 Map 是插入序，这里取确定序）。
func (s *Service) ListTerms() []TermInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]TermInfo, 0, len(s.terms))
	for _, t := range s.terms {
		status := "unknown"
		if st, ok := s.lastStatus[t.id]; ok {
			status = string(st.Status)
		}
		var sessionID *string
		if t.sessionID != "" {
			id := t.sessionID
			sessionID = &id
		}
		out = append(out, TermInfo{
			ID:        t.id,
			SessionID: sessionID,
			Kind:      t.kind,
			Status:    status,
			Title:     t.title,
			Remark:    t.remark,
		})
	}
	sortTermInfos(out)
	return out
}

// LabelPatch 标签标题或助手备注。编号不变。nil 字段不修改。
type LabelPatch struct {
	Title  *string
	Remark *string
}

// SetLabel 对应 TS setLabel。
func (s *Service) SetLabel(termID string, patch LabelPatch) {
	s.mu.Lock()
	term := s.terms[termID]
	if term != nil {
		if patch.Title != nil {
			if title := clipRunes(strings.TrimSpace(*patch.Title), 80); title != "" {
				term.title = title
			}
		}
		if patch.Remark != nil {
			term.remark = clipRunes(strings.TrimSpace(*patch.Remark), 200)
		}
	}
	s.mu.Unlock()
	if term != nil {
		s.sendMeta(term)
	}
}

// ExpectBind 界面把 xterm 订上之后再放行 SSH，避免登录横幅丢在订阅之前。
func (s *Service) ExpectBind(termID string, timeout time.Duration) error {
	ch := make(chan struct{})
	s.mu.Lock()
	s.bindWaiters[termID] = ch
	s.mu.Unlock()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-ch:
		return nil
	case <-timer.C:
		s.mu.Lock()
		if s.bindWaiters[termID] == ch {
			delete(s.bindWaiters, termID)
		}
		s.mu.Unlock()
		return errors.New("界面没有打开终端")
	}
}

// MarkBound 对应 TS markBound。
func (s *Service) MarkBound(termID string) {
	s.mu.Lock()
	ch := s.bindWaiters[termID]
	delete(s.bindWaiters, termID)
	s.mu.Unlock()
	if ch != nil {
		close(ch)
	}
}

// WaitStatus 对应 TS waitStatus：等到 connected / error / disconnected，或超时。
func (s *Service) WaitStatus(termID string, timeout time.Duration) error {
	s.mu.Lock()
	if cur, ok := s.lastStatus[termID]; ok {
		switch cur.Status {
		case StatusConnected:
			s.mu.Unlock()
			return nil
		case StatusError:
			s.mu.Unlock()
			return errors.New(orDefault(cur.Error, "连接失败"))
		}
	}
	w := s.addWatcherLocked()
	s.mu.Unlock()
	defer s.removeWatcher(w)

	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for {
		select {
		case ev := <-w.ch:
			if ev.TermID != termID {
				continue
			}
			switch ev.Status {
			case StatusConnected:
				return nil
			case StatusError, StatusDisconnected:
				return errors.New(orDefault(ev.Error, "连接失败"))
			}
		case <-timer.C:
			return errors.New("连接超时")
		}
	}
}

// ReadTail 对应 TS readTail：取输出缓冲末尾最多 maxChars 个字符。
func (s *Service) ReadTail(termID string, maxChars int) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.terms[termID]; !ok {
		return "", errors.New("终端不存在或已断开")
	}
	if ring := s.output[termID]; ring != nil {
		return ring.tail(maxChars), nil
	}
	return "", nil
}

// CwdOf 从屏幕最后的提示符里解析终端当前目录，解析不到返回空串。不往终端里打字。
func (s *Service) CwdOf(termID string) string {
	tail, err := s.ReadTail(termID, 4000)
	if err != nil {
		return ""
	}
	return ParsePromptCwd(LastScreenLine(tail))
}

// ExecCommand 等命令跑完再返回。完成信号是提示符：发命令前记下当时提示符的长相，
// 等输出安静下来，最后一行又变回提示符就是跑完了。POSIX shell 还会顺手打一个看不见
// 的标记带回退出码；本机 Windows 的 PowerShell 没有这一步，只靠提示符。
// 到 timeout 还没跑完，就把已经回来的内容交出去（finished=false），命令还在远端跑。
func (s *Service) ExecCommand(termID, command string, timeout time.Duration) (ExecResult, error) {
	s.mu.Lock()
	term := s.terms[termID]
	s.mu.Unlock()
	if term == nil || s.channelOf(termID) == nil {
		return ExecResult{}, errors.New("终端已经断开。用 term_reconnect 恢复这扇终端，编号不变。")
	}
	origin := s.logicalEnd(termID)
	promptBefore := LastScreenLine(s.readTailString(termID, 4000))
	body := strings.TrimSuffix(command, "\n")
	// SSH 和本机 POSIX shell 有退出码探针；本机 Windows 的 PowerShell 只靠提示符
	posix := term.kind == KindSSH || runtime.GOOS != "windows"
	marker := "__TP_DONE_" + randBase36(8) + "__"
	probe := ""
	if posix {
		// 标记打印完立刻用光标回退抹掉，同一个数据块里写完就擦，屏幕上基本看不到
		probe = fmt.Sprintf("\nprintf '%s%%s\\n\\033[2A\\033[2K\\033[1B\\033[2K\\033[1A' \"$?\"", marker)
	}
	s.Input(termID, body+probe+"\n")

	deadline := time.Now().Add(timeout)
	var exitCode *int
	finished := false
	seen := ""
	quietAt := time.Now()
	markerRe := regexp.MustCompile(regexp.QuoteMeta(marker) + `(\d+)`)
	for time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
		out := s.since(termID, origin)
		if posix {
			if m := markerRe.FindStringSubmatch(out); m != nil {
				code := 0
				_, _ = fmt.Sscanf(m[1], "%d", &code)
				exitCode = &code
				finished = true
				break
			}
		}
		if out != seen {
			seen = out
			quietAt = time.Now()
			continue
		}
		// 输出安静了一小会儿，且最后一行又变回提示符，就是跑完了
		if time.Since(quietAt) >= 600*time.Millisecond && IsPromptAgain(LastScreenLine(out), promptBefore) {
			finished = true
			break
		}
	}
	// 标记行和回显的 printf 行都带 marker 字样，一起剔掉
	lines := strings.Split(s.since(termID, origin), "\n")
	kept := make([]string, 0, len(lines))
	for _, line := range lines {
		if !strings.Contains(line, marker) {
			kept = append(kept, line)
		}
	}
	return ExecResult{Output: strings.Join(kept, "\n"), ExitCode: exitCode, Finished: finished}, nil
}

// DisposeAll 退出时全部断开并清空，不持久化。
func (s *Service) DisposeAll() {
	s.mu.Lock()
	s.parking = true
	terms := make([]*Entry, 0, len(s.terms))
	for _, t := range s.terms {
		terms = append(terms, t)
	}
	s.terms = map[string]*Entry{}
	s.viewReady = map[string]bool{}
	s.mu.Unlock()
	for _, t := range terms {
		s.releaseLive(t)
	}
}

// ---------------------------------------------------------------- 内部

func (s *Service) channelOf(termID string) Channel {
	s.mu.Lock()
	defer s.mu.Unlock()
	if t := s.terms[termID]; t != nil {
		return t.ch
	}
	return nil
}

func (s *Service) logicalEnd(termID string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	if ring := s.output[termID]; ring != nil {
		return ring.logicalEnd()
	}
	return 0
}

func (s *Service) since(termID string, origin int) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if ring := s.output[termID]; ring != nil {
		return ring.since(origin)
	}
	return ""
}

func (s *Service) readTailString(termID string, maxChars int) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if ring := s.output[termID]; ring != nil {
		return ring.tail(maxChars)
	}
	return ""
}

// sendData 对应 TS sendData：进环形缓冲，界面已订阅则同步下发。
func (s *Service) sendData(termID string, data []byte) {
	s.mu.Lock()
	ring := s.output[termID]
	if ring == nil {
		ring = &ringBuffer{}
		s.output[termID] = ring
	}
	ring.appendText(string(data))
	ready := s.viewReady[termID]
	s.mu.Unlock()
	if ready {
		s.push(termID, data)
	}
}

func (s *Service) push(termID string, data []byte) {
	if s.emitter == nil {
		return
	}
	s.emitter.TermData(DataEvent{TermID: termID, Data: base64.StdEncoding.EncodeToString(data)})
}

func (s *Service) sendMeta(term *Entry) {
	if s.emitter == nil {
		return
	}
	s.mu.Lock()
	payload := MetaEvent{TermID: term.id, Title: term.title, Remark: term.remark}
	s.mu.Unlock()
	s.emitter.TermMeta(payload)
}

// sendStatus 对应 TS sendStatus：记下最新状态，通知内部等待者，再推给界面。
func (s *Service) sendStatus(termID, sessionID string, status Status, errText string) {
	payload := StatusEvent{TermID: termID, Status: status, Error: errText}
	if sessionID != "" {
		payload.SessionID = &sessionID
	}
	s.mu.Lock()
	s.lastStatus[termID] = payload
	watchers := make([]*statusWatcher, 0, len(s.watchers))
	for w := range s.watchers {
		watchers = append(watchers, w)
	}
	s.mu.Unlock()
	for _, w := range watchers {
		select {
		case w.ch <- payload:
		default: // 等待者堆积时丢最旧的订阅通道不急，状态以 lastStatus 为准
		}
	}
	if s.emitter != nil {
		s.emitter.TermStatus(payload)
	}
}

// arm 每次拨号加一，返回本次的代际号。
func (s *Service) arm(entry *Entry) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry.liveGen++
	return entry.liveGen
}

// alive 旧连接迟到的关闭事件不再拆掉新的。
func (s *Service) alive(entry *Entry, gen int) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.terms[entry.id] == entry && entry.liveGen == gen
}

// waitNextStatus 只听注册之后到达的状态。返回的闭包阻塞到结果或超时。
func (s *Service) waitNextStatus(termID string, timeout time.Duration) func() error {
	s.mu.Lock()
	w := s.addWatcherLocked()
	s.mu.Unlock()
	timer := time.NewTimer(timeout)
	return func() error {
		defer s.removeWatcher(w)
		defer timer.Stop()
		for {
			select {
			case ev := <-w.ch:
				if ev.TermID != termID || ev.Status == StatusConnecting {
					continue
				}
				if ev.Status == StatusConnected {
					return nil
				}
				return errors.New(orDefault(ev.Error, "连接失败"))
			case <-timer.C:
				return errors.New("连接超时")
			}
		}
	}
}

func (s *Service) addWatcherLocked() *statusWatcher {
	w := &statusWatcher{ch: make(chan StatusEvent, 16)}
	s.watchers[w] = struct{}{}
	return w
}

func (s *Service) removeWatcher(w *statusWatcher) {
	s.mu.Lock()
	delete(s.watchers, w)
	s.mu.Unlock()
}

// releaseLive 对应 TS releaseLive：断开阶段的异常忽略。
func (s *Service) releaseLive(term *Entry) {
	if term == nil {
		return
	}
	s.mu.Lock()
	ch := term.ch
	release := term.release
	conn := term.conn
	term.ch = nil
	term.release = nil
	term.conn = nil
	s.mu.Unlock()
	if ch != nil {
		_ = ch.Close()
	}
	if release != nil {
		release()
	} else if conn != nil {
		conn.Close()
	}
}

func (s *Service) isParking() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.parking
}

func orDefault(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}

func sortTermInfos(infos []TermInfo) {
	sort.Slice(infos, func(i, j int) bool { return infos[i].ID < infos[j].ID })
}

func clipRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}

const base36Chars = "0123456789abcdefghijklmnopqrstuvwxyz"

// randBase36 对应 TS Math.random().toString(36).slice(2, 10) 的 8 位随机串。
func randBase36(n int) string {
	var b [16]byte
	if _, err := crand.Read(b[:]); err != nil {
		panic(err)
	}
	out := make([]byte, n)
	for i := range out {
		out[i] = base36Chars[int(b[i])%len(base36Chars)]
	}
	return string(out)
}
