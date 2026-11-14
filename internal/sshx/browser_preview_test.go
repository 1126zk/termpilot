package sshx

import (
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"golang.org/x/crypto/ssh"
)

func listenLoopback(t *testing.T) net.Listener {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	return ln
}

func TestOpenBrowserPreviewRequiresConnection(t *testing.T) {
	p := NewPool()
	_, err := p.OpenBrowserPreview("missing", nil)
	if !errors.Is(err, errBrowserNotConnected) {
		t.Fatalf("got %v", err)
	}
}

func TestCloseBrowserPreviewRefcount(t *testing.T) {
	p := NewPool()
	ln := listenLoopback(t)
	view := &browserPreview{id: 3, refs: 2, closer: ln}
	p.slots["a"] = &poolSlot{
		conn:     &Conn{Client: &ssh.Client{}},
		refs:     1,
		forwards: map[string]*activeForward{},
		browser:  view,
	}

	p.CloseBrowserPreview("a", 99)
	if p.slots["a"].browser == nil {
		t.Fatal("wrong id closed the preview")
	}
	p.CloseBrowserPreview("a", 3)
	if p.slots["a"].browser == nil || p.slots["a"].browser.refs != 1 {
		t.Fatal("one close dropped the shared preview")
	}
	p.CloseBrowserPreview("a", 3)
	if p.slots["a"].browser != nil {
		t.Fatal("last close left the preview")
	}
	conn, err := net.DialTimeout("tcp", ln.Addr().String(), 200*time.Millisecond)
	if err == nil {
		_ = conn.Close()
		t.Fatal("listener still open")
	}
}

func TestCloseSideClosesBrowserPreview(t *testing.T) {
	ln := listenLoopback(t)
	slot := &poolSlot{
		forwards: map[string]*activeForward{},
		browser:  &browserPreview{id: 1, refs: 1, closer: ln},
	}
	forwards, browser := slot.takeSide()
	closeSide(forwards, browser)
	if slot.browser != nil || slot.forwards != nil {
		t.Fatal("side channels still attached")
	}
	conn, err := net.DialTimeout("tcp", ln.Addr().String(), 200*time.Millisecond)
	if err == nil {
		_ = conn.Close()
		t.Fatal("listener still open")
	}
}

func TestFetchAndParseCdpPages(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/json/list" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`[
			{"id":"b","type":"browser","title":"","url":"","webSocketDebuggerUrl":"ws://127.0.0.1/devtools/browser/b"},
			{"id":"p","type":"page","title":"hi","url":"about:blank","webSocketDebuggerUrl":"ws://127.0.0.1/devtools/page/p"}
		]`))
	}))
	defer srv.Close()

	body, err := fetchCDP(func() (net.Conn, error) {
		return net.Dial("tcp", srv.Listener.Addr().String())
	}, http.MethodGet, "/json/list")
	if err != nil {
		t.Fatal(err)
	}
	pages, err := parseCdpPages(body)
	if err != nil {
		t.Fatal(err)
	}
	if len(pages) != 1 || pages[0].ID != "p" || pages[0].URL != "about:blank" {
		t.Fatalf("pages: %+v", pages)
	}
	got, err := pickBrowserPage(pages, "")
	if err != nil || got.ID != "p" {
		t.Fatalf("pick: %+v %v", got, err)
	}
}

func TestBrowserPagesOpensBlankWhenEmpty(t *testing.T) {
	var opened string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/json/list":
			_, _ = w.Write([]byte(`[{"id":"b","type":"browser","webSocketDebuggerUrl":"ws://127.0.0.1/devtools/browser/b"}]`))
		case "/json/new":
			opened = r.Method + " " + r.URL.RequestURI()
			_, _ = w.Write([]byte(`{"id":"p","type":"page","title":"","url":"about:blank","webSocketDebuggerUrl":"ws://127.0.0.1/devtools/page/p"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	pages, err := browserPages(func() (net.Conn, error) {
		return net.Dial("tcp", srv.Listener.Addr().String())
	})
	if err != nil {
		t.Fatal(err)
	}
	if opened != "PUT /json/new?about:blank" {
		t.Fatalf("open: %s", opened)
	}
	if len(pages) != 1 || pages[0].ID != "p" || pages[0].URL != "about:blank" {
		t.Fatalf("pages: %+v", pages)
	}
}

type rejectDeadline struct{ net.Conn }

func (rejectDeadline) SetDeadline(time.Time) error {
	return errors.New("ssh: tcpChan: deadline not supported")
}
func (rejectDeadline) SetReadDeadline(time.Time) error {
	return errors.New("ssh: tcpChan: deadline not supported")
}
func (rejectDeadline) SetWriteDeadline(time.Time) error {
	return errors.New("ssh: tcpChan: deadline not supported")
}

func TestWebSocketDialSurvivesSSHDeadline(t *testing.T) {
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		_ = conn.Close()
	}))
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/devtools/page/p"
	dialer := websocket.Dialer{
		HandshakeTimeout: 10 * time.Second,
		NetDial: func(network, addr string) (net.Conn, error) {
			conn, err := net.Dial("tcp", srv.Listener.Addr().String())
			if err != nil {
				return nil, err
			}
			return noDeadline{rejectDeadline{conn}}, nil
		},
	}
	ws, _, err := dialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = ws.Close()
}

func TestCdpSessionAcksScreencast(t *testing.T) {
	ack := make(chan int, 1)
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.WriteJSON(map[string]any{
			"method": "Page.screencastFrame",
			"params": map[string]any{"data": "eQ==", "sessionId": 7, "metadata": map[string]int{"deviceWidth": 8, "deviceHeight": 6}},
		})
		var msg struct {
			Method string `json:"method"`
			Params struct {
				SessionID int `json:"sessionId"`
			} `json:"params"`
		}
		if err := conn.ReadJSON(&msg); err != nil {
			return
		}
		if msg.Method == "Page.screencastFrameAck" {
			ack <- msg.Params.SessionID
		}
	}))
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/devtools/page/p"
	dialer := websocket.Dialer{NetDial: func(network, addr string) (net.Conn, error) {
		return net.Dial("tcp", srv.Listener.Addr().String())
	}}
	ws, _, err := dialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	view := &browserPreview{id: 4, onEvent: func(id int, method string, _ json.RawMessage) {
		if method == "Page.screencastFrame" {
			t.Errorf("screencast frame was emitted")
		}
	}}
	session := &cdpSession{ws: ws, owner: view, pending: map[int]chan cdpResult{}, next: 1, done: make(chan struct{})}
	view.session = session
	view.closer = session
	session.accepted.Store(true)
	go session.readLoop()

	seq, jpeg, width, height, _, err := session.waitFrame(0, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if seq == 0 || len(jpeg) == 0 || width != 8 || height != 6 {
		t.Fatalf("frame seq=%d bytes=%d size=%dx%d", seq, len(jpeg), width, height)
	}
	select {
	case got := <-ack:
		if got != 7 {
			t.Fatalf("ack session %d", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("screencast was not acked")
	}
	_ = session.Close()
}
