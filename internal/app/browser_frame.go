package app

import (
	"net/http"
	"strconv"
)

// BrowserFrameMiddleware 把预览画面从 Wails 事件里拿出来。
// 前端拉一帧画一帧，Go 在交出这帧之后才向 Chrome 确认，画面不会在链路上越堆越多。
func (a *App) BrowserFrameMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/__browser/frame" {
			a.serveBrowserFrame(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (a *App) serveBrowserFrame(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	preview, _ := strconv.Atoi(r.URL.Query().Get("preview"))
	after, _ := strconv.Atoi(r.URL.Query().Get("after"))
	if preview <= 0 {
		http.Error(w, "浏览器连接断了", http.StatusNotFound)
		return
	}
	seq, jpeg, width, height, ack, err := a.pool.WaitBrowserFrame(preview, after)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	if seq == 0 || len(jpeg) == 0 {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if ack != nil {
		ack()
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Frame-Seq", strconv.Itoa(seq))
	w.Header().Set("X-Device-Width", strconv.Itoa(width))
	w.Header().Set("X-Device-Height", strconv.Itoa(height))
	w.Header().Set("Content-Length", strconv.Itoa(len(jpeg)))
	_, _ = w.Write(jpeg)
}
