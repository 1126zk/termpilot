package sshx

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"golang.org/x/crypto/ssh"
)

const browserCDPAddr = "127.0.0.1:9222"

// BrowserPage 一个浏览器标签。
type BrowserPage struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	URL   string `json:"url"`
}

// BrowserPreview 一次预览。前端用 id 成对关掉，画面从本机 WebSocket 推过来。
type BrowserPreview struct {
	ID     int           `json:"id"`
	PageID string        `json:"pageId"`
	Pages  []BrowserPage `json:"pages"`
}

// BrowserCdpEvent 预览过程中的 CDP 事件。画面在 params.data 里，已经是 base64。
type BrowserCdpEvent struct {
	SessionID string          `json:"sessionId"`
	PreviewID int             `json:"previewId"`
	Method    string          `json:"method"`
	Params    json.RawMessage `json:"params,omitempty"`
}

type browserEvent func(previewID int, method string, params json.RawMessage)

type cdpPage struct {
	BrowserPage
	Type string `json:"type"`
	WS   string `json:"webSocketDebuggerUrl"`
}

type cdpIncoming struct {
	ID     int             `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Message string `json:"message"`
	} `json:"error"`
}

type cdpResult struct {
	result json.RawMessage
	err    error
}

// BrowserInput 一条按序号排队的输入。序号由前端分配，后端按序写到 CDP。
type BrowserInput struct {
	Seq    int             `json:"seq"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

// browserPreview 一条 SSH 上的 CDP 连接。refs 是还没关掉的预览面板数。
type browserPreview struct {
	id       int
	refs     int
	targetID string
	closer   io.Closer
	session  *cdpSession
	onEvent  browserEvent
	mu       sync.Mutex

	inputStop    chan struct{}
	inputKick    chan struct{}
	inputPending map[int]BrowserInput
	inputNext    int
}

func (b *browserPreview) Close() error {
	b.mu.Lock()
	c := b.closer
	b.closer = nil
	b.session = nil
	stop := b.inputStop
	b.inputStop = nil
	b.mu.Unlock()
	if stop != nil {
		close(stop)
	}
	if c != nil {
		return c.Close()
	}
	return nil
}

func (b *browserPreview) alive() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.session != nil && !b.session.closed.Load()
}

func (b *browserPreview) emit(method string, params json.RawMessage) {
	b.mu.Lock()
	fn := b.onEvent
	id := b.id
	b.mu.Unlock()
	if fn != nil {
		fn(id, method, params)
	}
}

func (b *browserPreview) swapSession(next *cdpSession, targetID string) {
	b.mu.Lock()
	old := b.session
	b.session = next
	b.closer = next
	b.targetID = targetID
	b.mu.Unlock()
	if old != nil && old != next {
		_ = old.Close()
	}
}

var errBrowserNotConnected = errors.New("终端还没连上")

// OpenBrowserPreview 经 SSH 连上服务器本机的浏览器调试端口，并开始推画面。
// 同一个会话上再次打开时复用连接，多记一次引用。
func (p *Pool) OpenBrowserPreview(sessionID string, onEvent browserEvent) (BrowserPreview, error) {
	p.mu.Lock()
	slot := p.liveSlot(sessionID)
	if slot == nil {
		p.mu.Unlock()
		return BrowserPreview{}, errBrowserNotConnected
	}
	client := slot.conn.Client
	existing := slot.browser
	p.mu.Unlock()

	pages, err := listBrowserPages(client)
	if err != nil {
		return BrowserPreview{}, err
	}
	if existing != nil && existing.alive() {
		p.mu.Lock()
		if p.liveSlot(sessionID) == slot && slot.browser == existing && existing.alive() {
			existing.refs++
			existing.onEvent = onEvent
			out := BrowserPreview{ID: existing.id, PageID: existing.targetID, Pages: publicPages(pages)}
			p.mu.Unlock()
			return out, nil
		}
		p.mu.Unlock()
	}

	target, err := pickBrowserPage(pages, "")
	if err != nil {
		return BrowserPreview{}, err
	}
	p.mu.Lock()
	p.tunnelSeq++
	id := p.tunnelSeq
	p.mu.Unlock()

	session, err := dialBrowserPage(client, target)
	if err != nil {
		return BrowserPreview{}, errors.New("连不上浏览器")
	}
	view := &browserPreview{id: id, refs: 1, targetID: target.ID, onEvent: onEvent, session: session, closer: session}
	session.owner = view
	go session.readLoop()
	if err := session.arm(); err != nil {
		_ = session.Close()
		return BrowserPreview{}, err
	}

	p.mu.Lock()
	defer p.mu.Unlock()
	if p.liveSlot(sessionID) != slot {
		_ = session.Close()
		return BrowserPreview{}, errBrowserNotConnected
	}
	if slot.browser != nil && slot.browser.alive() {
		slot.browser.refs++
		slot.browser.onEvent = onEvent
		_ = session.Close()
		return BrowserPreview{ID: slot.browser.id, PageID: slot.browser.targetID, Pages: publicPages(pages)}, nil
	}
	slot.browser = view
	session.accepted.Store(true)
	view.startInput()
	return BrowserPreview{ID: id, PageID: target.ID, Pages: publicPages(pages)}, nil
}

// CloseBrowserPreview 归还一次预览引用。id 对不上说明已经换过，什么都不做。
func (p *Pool) CloseBrowserPreview(sessionID string, id int) {
	p.mu.Lock()
	slot := p.liveSlot(sessionID)
	if slot == nil || slot.browser == nil || slot.browser.id != id {
		p.mu.Unlock()
		return
	}
	slot.browser.refs--
	if slot.browser.refs > 0 {
		p.mu.Unlock()
		return
	}
	view := slot.browser
	slot.browser = nil
	p.mu.Unlock()
	_ = view.Close()
}

// SwitchBrowserPreview 换到另一个标签，并把它拉到前台。
func (p *Pool) SwitchBrowserPreview(sessionID string, id int, pageID string) error {
	view, client, err := p.browserClient(sessionID, id)
	if err != nil {
		return err
	}
	pages, err := listBrowserPages(client)
	if err != nil {
		return err
	}
	target, err := pickBrowserPage(pages, pageID)
	if err != nil {
		return err
	}
	session, err := dialBrowserPage(client, target)
	if err != nil {
		return errors.New("连不上浏览器")
	}
	session.owner = view
	go session.readLoop()
	if err := session.arm(); err != nil {
		_ = session.Close()
		return err
	}
	_, _ = session.call("Page.bringToFront", json.RawMessage(`{}`))
	session.accepted.Store(true)
	view.swapSession(session, target.ID)
	return nil
}

// ListBrowserPages 读当前有哪些标签。
func (p *Pool) ListBrowserPages(sessionID string) ([]BrowserPage, error) {
	p.mu.Lock()
	slot := p.liveSlot(sessionID)
	if slot == nil {
		p.mu.Unlock()
		return nil, errBrowserNotConnected
	}
	client := slot.conn.Client
	p.mu.Unlock()
	pages, err := listBrowserPages(client)
	if err != nil {
		return nil, err
	}
	return publicPages(pages), nil
}

// BrowserCommand 把一条 CDP 命令送到当前页面，等浏览器回应。
func (p *Pool) BrowserCommand(sessionID string, id int, method string, params json.RawMessage) (any, error) {
	if method == "" {
		return nil, errors.New("浏览器拒绝了操作")
	}
	view, _, err := p.browserClient(sessionID, id)
	if err != nil {
		return nil, err
	}
	raw, err := view.call(method, params)
	if err != nil {
		return nil, err
	}
	if len(raw) == 0 || string(raw) == "null" {
		return map[string]any{}, nil
	}
	var out any
	if err := json.Unmarshal(raw, &out); err != nil {
		return map[string]any{}, nil
	}
	return out, nil
}

// PushBrowserInput 按序号把输入排进同一条队列，写到 CDP 时不等回包。
func (p *Pool) PushBrowserInput(sessionID string, id int, events []BrowserInput) error {
	view, _, err := p.browserClient(sessionID, id)
	if err != nil {
		return err
	}
	view.pushInput(events)
	return nil
}

// WaitBrowserFrame 等到比 after 更新的一帧。超时没有新帧时 seq 为 0。
// 帧在读到时已经向 Chrome 确认过，返回的 ack 恒为 nil。
func (p *Pool) WaitBrowserFrame(id int, after int) (seq int, jpeg []byte, width, height int, ack func(), err error) {
	p.mu.Lock()
	var view *browserPreview
	for _, slot := range p.slots {
		if slot.browser != nil && slot.browser.id == id && slot.browser.alive() {
			view = slot.browser
			break
		}
	}
	p.mu.Unlock()
	if view == nil {
		return 0, nil, 0, 0, nil, errors.New("浏览器连接断了")
	}
	view.mu.Lock()
	session := view.session
	view.mu.Unlock()
	if session == nil || session.closed.Load() {
		return 0, nil, 0, 0, nil, errors.New("浏览器连接断了")
	}
	return session.waitFrame(after, 20*time.Second)
}

func (b *browserPreview) startInput() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.inputStop != nil {
		return
	}
	b.inputStop = make(chan struct{})
	b.inputKick = make(chan struct{}, 1)
	b.inputPending = map[int]BrowserInput{}
	b.inputNext = 1
	go b.inputLoop()
}

func (b *browserPreview) pushInput(events []BrowserInput) {
	b.startInput()
	b.mu.Lock()
	for _, event := range events {
		if event.Seq < 1 || !inputMethod(event.Method) {
			continue
		}
		b.inputPending[event.Seq] = event
	}
	b.mu.Unlock()
	select {
	case b.inputKick <- struct{}{}:
	default:
	}
}

func inputMethod(method string) bool {
	switch method {
	case "Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.insertText", "Input.dispatchTouchEvent":
		return true
	default:
		return false
	}
}

func (b *browserPreview) inputLoop() {
	gap := time.NewTimer(time.Hour)
	if !gap.Stop() {
		<-gap.C
	}
	defer gap.Stop()
	gapOn := false
	for {
		b.mu.Lock()
		stop := b.inputStop
		event, ok := b.inputPending[b.inputNext]
		if ok {
			delete(b.inputPending, b.inputNext)
			b.inputNext++
		}
		session := b.session
		pending := len(b.inputPending) > 0
		b.mu.Unlock()
		if stop == nil {
			return
		}
		if ok {
			if gapOn {
				if !gap.Stop() {
					select {
					case <-gap.C:
					default:
					}
				}
				gapOn = false
			}
			if session != nil && !session.closed.Load() {
				_ = session.write(session.allocID(), event.Method, event.Params)
			}
			continue
		}
		if pending && !gapOn {
			gap.Reset(200 * time.Millisecond)
			gapOn = true
		}
		select {
		case <-b.inputKick:
		case <-gap.C:
			gapOn = false
			b.skipInputGap()
		case <-stop:
			return
		}
	}
}

func (b *browserPreview) skipInputGap() {
	b.mu.Lock()
	defer b.mu.Unlock()
	min := 0
	for seq := range b.inputPending {
		if seq < b.inputNext {
			delete(b.inputPending, seq)
			continue
		}
		if min == 0 || seq < min {
			min = seq
		}
	}
	if min > b.inputNext {
		b.inputNext = min
	}
}

func (p *Pool) browserClient(sessionID string, id int) (*browserPreview, *ssh.Client, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	slot := p.liveSlot(sessionID)
	if slot == nil || slot.browser == nil || slot.browser.id != id || !slot.browser.alive() {
		return nil, nil, errors.New("浏览器连接断了")
	}
	return slot.browser, slot.conn.Client, nil
}

func (b *browserPreview) call(method string, params json.RawMessage) (json.RawMessage, error) {
	b.mu.Lock()
	session := b.session
	b.mu.Unlock()
	if session == nil {
		return nil, errors.New("浏览器连接断了")
	}
	return session.call(method, params)
}

func listBrowserPages(client *ssh.Client) ([]cdpPage, error) {
	return browserPages(func() (net.Conn, error) {
		return client.Dial("tcp", browserCDPAddr)
	})
}

// browserPages 读取已有标签。一个都没有时让 Chrome 打开 about:blank，再把这个标签交回去。
func browserPages(dial func() (net.Conn, error)) ([]cdpPage, error) {
	body, err := fetchCDP(dial, http.MethodGet, "/json/list")
	if err != nil {
		return nil, errors.New("调试端口没有打开")
	}
	pages, err := parseCdpPages(body)
	if err == nil {
		return pages, nil
	}
	if err.Error() != "浏览器还没有页面" {
		return nil, err
	}
	created, err := fetchCDP(dial, http.MethodPut, "/json/new?about:blank")
	if err != nil {
		return nil, errors.New("浏览器还没有页面")
	}
	var page cdpPage
	if json.Unmarshal(created, &page) != nil || page.Type != "page" || page.ID == "" || page.WS == "" {
		return nil, errors.New("浏览器还没有页面")
	}
	return []cdpPage{page}, nil
}

func pickBrowserPage(pages []cdpPage, want string) (cdpPage, error) {
	if want != "" {
		for _, page := range pages {
			if page.ID == want {
				return page, nil
			}
		}
		return cdpPage{}, errors.New("这个标签已经关了")
	}
	if len(pages) == 0 {
		return cdpPage{}, errors.New("浏览器还没有页面")
	}
	return pages[len(pages)-1], nil
}

func publicPages(pages []cdpPage) []BrowserPage {
	out := make([]BrowserPage, 0, len(pages))
	for _, page := range pages {
		out = append(out, page.BrowserPage)
	}
	return out
}

func fetchCDP(dial func() (net.Conn, error), method, path string) ([]byte, error) {
	conn, err := dial()
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	req, err := http.NewRequest(method, "http://"+browserCDPAddr+path, nil)
	if err != nil {
		return nil, err
	}
	if err := req.Write(conn); err != nil {
		return nil, err
	}
	resp, err := http.ReadResponse(bufio.NewReader(conn), req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, errors.New("调试端口没有打开")
	}
	return io.ReadAll(io.LimitReader(resp.Body, 1<<20))
}

func parseCdpPages(body []byte) ([]cdpPage, error) {
	var all []cdpPage
	if err := json.Unmarshal(body, &all); err != nil {
		return nil, errors.New("连不上浏览器")
	}
	pages := make([]cdpPage, 0, len(all))
	for _, page := range all {
		if page.Type == "page" && page.ID != "" && page.WS != "" {
			pages = append(pages, page)
		}
	}
	if len(pages) == 0 {
		return nil, errors.New("浏览器还没有页面")
	}
	return pages, nil
}

type cdpSession struct {
	ws       *websocket.Conn
	owner    *browserPreview
	writeMu  sync.Mutex
	mu       sync.Mutex
	next     int
	pending  map[int]chan cdpResult
	accepted atomic.Bool
	closed   atomic.Bool

	done      chan struct{}
	doneOnce  sync.Once
	frameMu   sync.Mutex
	frame     liveFrame
	frameWait []chan struct{}
}

type liveFrame struct {
	seq    int
	jpeg   []byte
	width  int
	height int
	ackID  int
	acked  bool
}

// noDeadline 去掉超时设置。SSH 直连通道不支持 SetDeadline，握手前调用会直接失败。
type noDeadline struct{ net.Conn }

func (noDeadline) SetDeadline(time.Time) error     { return nil }
func (noDeadline) SetReadDeadline(time.Time) error { return nil }
func (noDeadline) SetWriteDeadline(time.Time) error {
	return nil
}

func dialBrowserPage(client *ssh.Client, page cdpPage) (*cdpSession, error) {
	dialer := websocket.Dialer{
		HandshakeTimeout: 10 * time.Second,
		NetDial: func(network, addr string) (net.Conn, error) {
			conn, err := client.Dial("tcp", browserCDPAddr)
			if err != nil {
				return nil, err
			}
			return noDeadline{conn}, nil
		},
	}
	ws, _, err := dialer.Dial(page.WS, nil)
	if err != nil {
		return nil, err
	}
	ws.SetReadLimit(16 << 20)
	session := &cdpSession{ws: ws, pending: map[int]chan cdpResult{}, next: 1, done: make(chan struct{})}
	session.ws.SetPingHandler(func(data string) error {
		session.writeMu.Lock()
		defer session.writeMu.Unlock()
		return session.ws.WriteControl(websocket.PongMessage, []byte(data), time.Now().Add(time.Second))
	})
	return session, nil
}

func (s *cdpSession) Close() error {
	s.closed.Store(true)
	if s.done != nil {
		s.doneOnce.Do(func() { close(s.done) })
	}
	s.frameMu.Lock()
	waiters := s.frameWait
	s.frameWait = nil
	s.frameMu.Unlock()
	for _, ch := range waiters {
		close(ch)
	}
	if s.ws == nil {
		return nil
	}
	return s.ws.Close()
}

func (s *cdpSession) arm() error {
	_, err := s.call("Page.enable", json.RawMessage(`{}`))
	return err
}

func (s *cdpSession) call(method string, params json.RawMessage) (json.RawMessage, error) {
	if s.closed.Load() {
		return nil, errors.New("浏览器连接断了")
	}
	if len(params) == 0 {
		params = json.RawMessage(`{}`)
	}
	id := s.allocID()
	ch := make(chan cdpResult, 1)
	s.mu.Lock()
	if s.pending == nil {
		s.pending = map[int]chan cdpResult{}
	}
	s.pending[id] = ch
	s.mu.Unlock()
	if err := s.write(id, method, params); err != nil {
		s.drop(id)
		return nil, errors.New("浏览器连接断了")
	}
	timer := time.NewTimer(8 * time.Second)
	defer timer.Stop()
	select {
	case res := <-ch:
		return res.result, res.err
	case <-timer.C:
		s.drop(id)
		return nil, errors.New("浏览器没有回应")
	}
}

func (s *cdpSession) readLoop() {
	defer func() {
		s.closed.Store(true)
		s.failPending(errors.New("浏览器连接断了"))
		owner := s.owner
		if owner == nil || !s.accepted.Load() {
			return
		}
		owner.mu.Lock()
		still := owner.session == s
		if still {
			owner.session = nil
		}
		owner.mu.Unlock()
		if still {
			owner.emit("preview.closed", nil)
		}
	}()
	for {
		_, data, err := s.ws.ReadMessage()
		if err != nil {
			return
		}
		var msg cdpIncoming
		if json.Unmarshal(data, &msg) != nil {
			continue
		}
		if msg.ID != 0 {
			s.deliver(msg)
			continue
		}
		if msg.Method == "" || s.owner == nil {
			continue
		}
		if msg.Method == "Page.screencastFrame" {
			s.storeScreencast(msg.Params)
			continue
		}
		if msg.Method != "Page.frameNavigated" {
			continue
		}
		s.owner.emit(msg.Method, msg.Params)
	}
}

func (s *cdpSession) storeScreencast(params json.RawMessage) {
	var frame struct {
		SessionID int    `json:"sessionId"`
		Data      string `json:"data"`
		Metadata  struct {
			DeviceWidth  int `json:"deviceWidth"`
			DeviceHeight int `json:"deviceHeight"`
		} `json:"metadata"`
	}
	if json.Unmarshal(params, &frame) != nil {
		return
	}
	// 马上确认。拖到前端取走再确认时，Chrome 会停住绘制，预览就卡在空白帧上。
	s.ackFrameID(frame.SessionID)
	if frame.Data == "" {
		return
	}
	jpeg, err := base64.StdEncoding.DecodeString(frame.Data)
	if err != nil {
		jpeg, err = base64.RawStdEncoding.DecodeString(frame.Data)
		if err != nil || len(jpeg) == 0 {
			return
		}
	}
	s.frameMu.Lock()
	s.frame.seq++
	s.frame.jpeg = jpeg
	s.frame.width = frame.Metadata.DeviceWidth
	s.frame.height = frame.Metadata.DeviceHeight
	s.frame.ackID = frame.SessionID
	s.frame.acked = true
	waiters := s.frameWait
	s.frameWait = nil
	s.frameMu.Unlock()
	for _, ch := range waiters {
		close(ch)
	}
}

func (s *cdpSession) ackFrameID(sessionID int) {
	if sessionID == 0 {
		return
	}
	raw, err := json.Marshal(map[string]int{"sessionId": sessionID})
	if err != nil {
		return
	}
	_ = s.write(s.allocID(), "Page.screencastFrameAck", raw)
}

func (s *cdpSession) waitFrame(after int, timeout time.Duration) (seq int, jpeg []byte, width, height int, ack func(), err error) {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for {
		s.frameMu.Lock()
		if s.closed.Load() {
			s.frameMu.Unlock()
			return 0, nil, 0, 0, nil, errors.New("浏览器连接断了")
		}
		if s.frame.seq > after && len(s.frame.jpeg) > 0 {
			seq = s.frame.seq
			jpeg = s.frame.jpeg
			width = s.frame.width
			height = s.frame.height
			s.frameMu.Unlock()
			return seq, jpeg, width, height, nil, nil
		}
		ch := make(chan struct{})
		s.frameWait = append(s.frameWait, ch)
		s.frameMu.Unlock()
		select {
		case <-ch:
		case <-timer.C:
			s.dropFrameWaiter(ch)
			return 0, nil, 0, 0, nil, nil
		case <-s.done:
			s.dropFrameWaiter(ch)
			return 0, nil, 0, 0, nil, errors.New("浏览器连接断了")
		}
	}
}

func (s *cdpSession) dropFrameWaiter(ch chan struct{}) {
	s.frameMu.Lock()
	defer s.frameMu.Unlock()
	next := s.frameWait[:0]
	for _, waiter := range s.frameWait {
		if waiter != ch {
			next = append(next, waiter)
		}
	}
	s.frameWait = next
}

func (s *cdpSession) allocID() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.next++
	return s.next
}

func (s *cdpSession) drop(id int) {
	s.mu.Lock()
	delete(s.pending, id)
	s.mu.Unlock()
}

func (s *cdpSession) deliver(msg cdpIncoming) {
	s.mu.Lock()
	ch := s.pending[msg.ID]
	delete(s.pending, msg.ID)
	s.mu.Unlock()
	if ch == nil {
		return
	}
	res := cdpResult{result: msg.Result}
	if msg.Error != nil {
		if msg.Error.Message != "" {
			res.err = errors.New(msg.Error.Message)
		} else {
			res.err = errors.New("浏览器拒绝了操作")
		}
	}
	ch <- res
}

func (s *cdpSession) failPending(err error) {
	s.mu.Lock()
	pending := s.pending
	s.pending = map[int]chan cdpResult{}
	s.mu.Unlock()
	for _, ch := range pending {
		ch <- cdpResult{err: err}
	}
}

func (s *cdpSession) write(id int, method string, params json.RawMessage) error {
	if len(params) == 0 {
		params = json.RawMessage(`{}`)
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.ws.WriteJSON(struct {
		ID     int             `json:"id"`
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
	}{id, method, params})
}

// takeSide 摘下这条连接上还开着的端口映射和浏览器预览。调用方持有池锁。
func (slot *poolSlot) takeSide() ([]*activeForward, *browserPreview) {
	closing := make([]*activeForward, 0, len(slot.forwards))
	for _, f := range slot.forwards {
		closing = append(closing, f)
	}
	slot.forwards = nil
	browser := slot.browser
	slot.browser = nil
	return closing, browser
}

func closeSide(forwards []*activeForward, browser *browserPreview) {
	for _, f := range forwards {
		if f != nil && f.closer != nil {
			_ = f.closer.Close()
		}
	}
	if browser != nil {
		_ = browser.Close()
	}
}
