package sftpx

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// eventLog 收集传输事件。
type eventLog struct {
	mu     sync.Mutex
	events []TransferEvent
}

func (l *eventLog) push(ev TransferEvent) {
	l.mu.Lock()
	l.events = append(l.events, ev)
	l.mu.Unlock()
}

func (l *eventLog) snapshot() []TransferEvent {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]TransferEvent(nil), l.events...)
}

func (l *eventLog) waitFor(t *testing.T, pred func(TransferEvent) bool) TransferEvent {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		for _, ev := range l.snapshot() {
			if pred(ev) {
				return ev
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("等不到想要的事件")
	return TransferEvent{}
}

func newTestService(log *eventLog) *Service {
	return New(Options{OnTransfer: log.push})
}

func assertSessionID(t *testing.T, events []TransferEvent, want string) {
	t.Helper()
	for _, ev := range events {
		if ev.SessionID != want {
			t.Errorf("事件 sessionId = %q, want %q: %+v", ev.SessionID, want, ev)
		}
	}
}

func memSource(data []byte) func() (io.ReadCloser, error) {
	return func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(data)), nil }
}

type bufferDest struct {
	buf bytes.Buffer
}

func (d *bufferDest) Write(p []byte) (int, error) { return d.buf.Write(p) }
func (d *bufferDest) Close() error                { return nil }

func memDest(d *bufferDest) func() (io.WriteCloser, error) {
	return func() (io.WriteCloser, error) { return d, nil }
}

func TestStreamTransferSuccess(t *testing.T) {
	log := &eventLog{}
	svc := newTestService(log)
	data := bytes.Repeat([]byte("x"), 100000) // 多块，确认进度累计
	dest := &bufferDest{}
	err := svc.streamTransfer(transferOptions{
		sessionID: "session-a", direction: DirectionDown, name: "f.bin", total: int64(len(data)),
		openSource: memSource(data), openDest: memDest(dest),
	})
	if err != nil {
		t.Fatalf("传输失败: %v", err)
	}
	if dest.buf.Len() != len(data) {
		t.Fatalf("落盘字节数 %d != %d", dest.buf.Len(), len(data))
	}
	events := log.snapshot()
	if len(events) < 3 {
		t.Fatalf("至少要有起始/进度/完成事件，只有 %d 条", len(events))
	}
	assertSessionID(t, events, "session-a")
	first, last := events[0], events[len(events)-1]
	if first.Done || first.Transferred != 0 || first.Total != int64(len(data)) {
		t.Errorf("起始事件不对: %+v", first)
	}
	if !last.Done || last.Error != "" || last.Transferred != int64(len(data)) {
		t.Errorf("完成事件不对: %+v", last)
	}
	// 中间的进度事件单调递增
	prev := int64(-1)
	for _, ev := range events[1 : len(events)-1] {
		if ev.Done || ev.Transferred <= prev {
			t.Errorf("进度事件不单调: %+v", ev)
		}
		prev = ev.Transferred
	}
}

func TestStreamTransferInterrupted(t *testing.T) {
	log := &eventLog{}
	svc := newTestService(log)
	cleaned := make(chan struct{}, 1)
	err := svc.streamTransfer(transferOptions{
		direction: DirectionDown, name: "f.bin", total: 100,
		openSource:     memSource([]byte("short")),
		openDest:       memDest(&bufferDest{}),
		cleanupPartial: func() { cleaned <- struct{}{} },
	})
	if err == nil || err.Error() != "传输中断" {
		t.Fatalf("字节数不够应该报传输中断: %v", err)
	}
	last := log.snapshot()[len(log.snapshot())-1]
	if !last.Done || last.Error != "传输中断" {
		t.Errorf("完成事件不对: %+v", last)
	}
	select {
	case <-cleaned:
	case <-time.After(2 * time.Second):
		t.Fatal("失败后没有清理残留")
	}
}

type failDest struct{}

func (failDest) Write(p []byte) (int, error) { return 0, errors.New("磁盘满了") }
func (failDest) Close() error                { return nil }

func TestStreamTransferWriteError(t *testing.T) {
	log := &eventLog{}
	svc := newTestService(log)
	cleaned := make(chan struct{}, 1)
	err := svc.streamTransfer(transferOptions{
		direction: DirectionUp, name: "f.bin", total: 10,
		openSource:     memSource([]byte("0123456789")),
		openDest:       func() (io.WriteCloser, error) { return failDest{}, nil },
		cleanupPartial: func() { cleaned <- struct{}{} },
	})
	if err == nil || err.Error() != "磁盘满了" {
		t.Fatalf("写失败应该透传: %v", err)
	}
	last := log.snapshot()[len(log.snapshot())-1]
	if !last.Done || last.Error != "磁盘满了" {
		t.Errorf("错误事件不对: %+v", last)
	}
	select {
	case <-cleaned:
	case <-time.After(2 * time.Second):
		t.Fatal("写失败后没有清理残留")
	}
}

func TestStreamTransferOpenFails(t *testing.T) {
	log := &eventLog{}
	svc := newTestService(log)
	err := svc.streamTransfer(transferOptions{
		sessionID: "session-a", direction: DirectionUp, name: "f.bin", total: 10,
		openSource: func() (io.ReadCloser, error) { return nil, errors.New("打不开") },
		openDest:   memDest(&bufferDest{}),
	})
	if err == nil || err.Error() != "打不开" {
		t.Fatalf("openSource 失败应该透传: %v", err)
	}
	events := log.snapshot()
	if len(events) != 2 || !events[1].Done || events[1].Error != "打不开" {
		t.Errorf("事件序列不对: %+v", events)
	}
	assertSessionID(t, events, "session-a")
}

func TestStreamTransferCancel(t *testing.T) {
	log := &eventLog{}
	svc := newTestService(log)
	srcReader, srcWriter := io.Pipe()
	defer srcWriter.Close()
	cleaned := make(chan struct{}, 1)
	done := make(chan error, 1)
	go func() {
		done <- svc.streamTransfer(transferOptions{
			direction: DirectionDown, name: "big.bin", total: 1 << 20,
			openSource:     func() (io.ReadCloser, error) { return srcReader, nil },
			openDest:       memDest(&bufferDest{}),
			cleanupPartial: func() { cleaned <- struct{}{} },
		})
	}()
	// 等起始事件拿到 id，写一点数据确认开传，再取消
	first := log.waitFor(t, func(ev TransferEvent) bool { return !ev.Done })
	if _, err := srcWriter.Write([]byte("hello")); err != nil {
		t.Fatalf("写入管道失败: %v", err)
	}
	log.waitFor(t, func(ev TransferEvent) bool { return !ev.Done && ev.Transferred > 0 })
	svc.CancelTransfer(first.ID)
	select {
	case err := <-done:
		if !errors.Is(err, ErrCancelled) {
			t.Fatalf("取消后应该返回 ErrCancelled: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("取消没有让传输退出")
	}
	last := log.waitFor(t, func(ev TransferEvent) bool { return ev.Done })
	if last.Error != "已取消" {
		t.Errorf("取消事件文案不对: %+v", last)
	}
	select {
	case <-cleaned:
	case <-time.After(2 * time.Second):
		t.Fatal("取消后没有清理残留")
	}
	// 再取消一次（已完成）应当无副作用
	svc.CancelTransfer(first.ID)
}

func TestCancelUnknownTransfer(t *testing.T) {
	svc := newTestService(&eventLog{})
	svc.CancelTransfer("不存在的id") // 不 panic 就行
}

func TestStreamTransferGroupAggregation(t *testing.T) {
	log := &eventLog{}
	svc := newTestService(log)
	group := svc.beginGroup("session-a", DirectionUp, "dir", 30)
	cleaned := false
	for i, data := range [][]byte{[]byte("0123456789"), []byte("01234567890123456789")} {
		err := svc.streamTransfer(transferOptions{
			sessionID: "session-a", direction: DirectionUp, name: "f", total: int64(len(data)), group: group,
			openSource:     memSource(data),
			openDest:       memDest(&bufferDest{}),
			cleanupPartial: func() { cleaned = true },
		})
		if err != nil {
			t.Fatalf("第 %d 个文件失败: %v", i, err)
		}
	}
	svc.endGroup(group, "")

	events := log.snapshot()
	assertSessionID(t, events, "session-a")
	if events[0].ID != group.id || events[0].Done {
		t.Errorf("beginGroup 的起始事件不对: %+v", events[0])
	}
	// 组内单文件不推 done、不清理残留
	for _, ev := range events[:len(events)-1] {
		if ev.Done {
			t.Errorf("组内单文件不该推 done: %+v", ev)
		}
		if ev.Name != "dir" || ev.Total != 30 {
			t.Errorf("组内事件应该用聚合名字和总量: %+v", ev)
		}
	}
	if cleaned {
		t.Error("组内单文件不该清理残留")
	}
	last := events[len(events)-1]
	if !last.Done || last.Transferred != 30 || last.Total != 30 || last.Error != "" {
		t.Errorf("endGroup 的完成事件不对: %+v", last)
	}
	// 聚合 transferred 跨文件累计：最后的进度事件应到 30
	var lastProgress TransferEvent
	for _, ev := range events {
		if !ev.Done {
			lastProgress = ev
		}
	}
	if lastProgress.Transferred != 30 {
		t.Errorf("聚合进度没累计到 30: %+v", lastProgress)
	}
}

func TestStreamTransferGroupCancel(t *testing.T) {
	log := &eventLog{}
	svc := newTestService(log)
	group := svc.beginGroup("session-a", DirectionDown, "dir", 1<<20)
	srcReader, srcWriter := io.Pipe()
	defer srcWriter.Close()
	done := make(chan error, 1)
	go func() {
		done <- svc.streamTransfer(transferOptions{
			sessionID: "session-a", direction: DirectionDown, name: "f", total: 1 << 20, group: group,
			openSource: func() (io.ReadCloser, error) { return srcReader, nil },
			openDest:   memDest(&bufferDest{}),
		})
	}()
	log.waitFor(t, func(ev TransferEvent) bool { return ev.ID == group.id })
	svc.CancelTransfer(group.id)
	select {
	case err := <-done:
		if !errors.Is(err, ErrCancelled) {
			t.Fatalf("组内取消应该返回 ErrCancelled: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("组取消没有让传输退出")
	}
	if !group.cancelled.Load() {
		t.Error("组没被标记 cancelled（遍历方靠它停下）")
	}
	svc.endGroup(group, "已取消")
	assertSessionID(t, log.snapshot(), "session-a")
	last := log.snapshot()[len(log.snapshot())-1]
	if !last.Done || last.Error != "已取消" || last.Transferred != 0 {
		t.Errorf("取消的收尾事件不对: %+v", last)
	}
}

func TestLocalTreeSize(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), make([]byte, 10), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "sub", "b.txt"), make([]byte, 20), 0o644); err != nil {
		t.Fatal(err)
	}
	total, err := localTreeSize(dir)
	if err != nil {
		t.Fatal(err)
	}
	if total != 30 {
		t.Errorf("localTreeSize = %d, want 30", total)
	}
}

func TestTransferEventJSONShape(t *testing.T) {
	// 确认事件字段名和前端 TS 类型一致（json tag 级）
	ev := TransferEvent{ID: "x", SessionID: "s", Direction: "up", Name: "n", Transferred: 1, Total: 2, Done: false}
	raw, err := json.Marshal(ev)
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	for _, key := range []string{`"id"`, `"sessionId"`, `"direction"`, `"name"`, `"transferred"`, `"total"`, `"done"`} {
		if !strings.Contains(text, key) {
			t.Errorf("事件 JSON 缺字段 %s: %s", key, text)
		}
	}
	if strings.Contains(text, "error") {
		t.Errorf("空 error 不该出现: %s", text)
	}
}
