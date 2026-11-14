package app

import (
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// frameStream 把最新一帧从本机推给界面。
// 资源服务那条路每帧都要整包拷进界面线程，画面一大就先卡在那里。
type frameStream struct {
	token string
	ln    net.Listener
	srv   *http.Server
	app   *App
	up    websocket.Upgrader
}

func (a *App) listenFrames() error {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return err
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	fs := &frameStream{
		token: hex.EncodeToString(buf),
		ln:    ln,
		app:   a,
		up: websocket.Upgrader{
			CheckOrigin:     func(*http.Request) bool { return true },
			ReadBufferSize:  1024,
			WriteBufferSize: 256 << 10,
		},
	}
	fs.srv = &http.Server{Handler: fs, ReadHeaderTimeout: 5 * time.Second}
	a.frames = fs
	go func() { _ = fs.srv.Serve(ln) }()
	return nil
}

func (a *App) closeFrames() {
	if a.frames == nil || a.frames.srv == nil {
		return
	}
	_ = a.frames.srv.Close()
}

func (a *App) frameSocketURL(previewID int) (string, error) {
	if a.frames == nil || previewID <= 0 {
		return "", errors.New("画面通道没开")
	}
	return "ws://" + a.frames.ln.Addr().String() + "/frame?preview=" + strconv.Itoa(previewID) + "&token=" + a.frames.token, nil
}

func (fs *frameStream) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if origin == "" {
		origin = "*"
	}
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Private-Network", "true")
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.Header().Set("Vary", "Origin")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.URL.Query().Get("token") != fs.token {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	previewID, err := strconv.Atoi(r.URL.Query().Get("preview"))
	if err != nil || previewID <= 0 {
		http.Error(w, "bad preview", http.StatusBadRequest)
		return
	}
	header := http.Header{}
	header.Set("Access-Control-Allow-Origin", origin)
	header.Set("Access-Control-Allow-Private-Network", "true")
	conn, err := fs.up.Upgrade(w, r, header)
	if err != nil {
		return
	}
	defer conn.Close()

	done := make(chan struct{})
	var once sync.Once
	finish := func() { once.Do(func() { close(done) }) }
	go func() {
		defer finish()
		conn.SetReadLimit(1024)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()

	after := 0
	for {
		seq, jpeg, width, height, _, err := fs.app.pool.WaitBrowserFrame(previewID, after)
		select {
		case <-done:
			return
		default:
		}
		if err != nil {
			return
		}
		if seq == 0 || len(jpeg) == 0 {
			if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(time.Second)); err != nil {
				return
			}
			continue
		}
		buf := make([]byte, 12+len(jpeg))
		binary.BigEndian.PutUint32(buf[0:], uint32(width))
		binary.BigEndian.PutUint32(buf[4:], uint32(height))
		binary.BigEndian.PutUint32(buf[8:], uint32(seq))
		copy(buf[12:], jpeg)
		_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
		if err := conn.WriteMessage(websocket.BinaryMessage, buf); err != nil {
			return
		}
		after = seq
	}
}
