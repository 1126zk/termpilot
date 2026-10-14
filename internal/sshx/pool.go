package sshx

import (
	"context"
	"sync"
)

// 对应 src/main/services/SshPool.ts：同一个保存的连接只拨号一次，
// 终端和文件树在同一条会话上开通道，各算一次引用。

// Hold 一条已连好的 SSH 会话的引用。用完后调用 Release。
type Hold struct {
	Conn      *Conn
	once      sync.Once
	releaseFn func()
}

// Release 归还引用；最后一个引用归还时关闭底层连接。
func (h *Hold) Release() {
	h.once.Do(func() {
		if h.releaseFn != nil {
			h.releaseFn()
		}
	})
}

type poolSlot struct {
	conn  *Conn
	refs  int
	ready chan struct{}
	err   error
}

// Pool 连接池。dial 可替换（测试用），默认是包级 Dial。
type Pool struct {
	mu    sync.Mutex
	slots map[string]*poolSlot
	dial  func(ctx context.Context, session *SessionConfig, secret string, jumpSecrets []string, opts *DialOptions) (*Conn, error)
}

// NewPool 建一个空池。
func NewPool() *Pool {
	return &Pool{slots: map[string]*poolSlot{}, dial: Dial}
}

// SetDialer 替换底层拨号函数（测试或定制传输用）。
func (p *Pool) SetDialer(dial func(ctx context.Context, session *SessionConfig, secret string, jumpSecrets []string, opts *DialOptions) (*Conn, error)) {
	p.dial = dial
}

// Acquire 取这个会话的共享连接；没有就拨号，有就加一次引用。
// 并发 Acquire 同一会话时共享同一次拨号。共享连接建立后挂端口映射；
// 连接断开自动出池，下次 Acquire 重拨。
// 注意：共享池不走跳板 shell 回退（回退流上开不了通道）。
func (p *Pool) Acquire(ctx context.Context, session *SessionConfig, secret string, jumpSecrets []string) (*Hold, error) {
	p.mu.Lock()
	if slot := p.slots[session.ID]; slot != nil {
		slot.refs++
		p.mu.Unlock()
		<-slot.ready
		hold := &Hold{Conn: slot.conn, releaseFn: func() { p.release(session.ID, slot) }}
		if slot.err != nil {
			hold.Release()
			return nil, slot.err
		}
		return hold, nil
	}
	slot := &poolSlot{refs: 1, ready: make(chan struct{})}
	p.slots[session.ID] = slot
	p.mu.Unlock()

	conn, err := p.dial(ctx, session, secret, jumpSecrets, nil)
	if err != nil {
		p.mu.Lock()
		if p.slots[session.ID] == slot {
			delete(p.slots, session.ID)
		}
		slot.err = err
		p.mu.Unlock()
		close(slot.ready)
		return nil, err
	}
	slot.conn = conn
	// 端口映射只在共享连接上挂一次；断开回收后重拨会重新挂上。
	if conn.Client != nil && len(session.Forwards) > 0 {
		AttachForwards(conn.Client, session.Forwards)
	}
	close(slot.ready)
	go func() {
		_ = conn.Wait()
		p.mu.Lock()
		if p.slots[session.ID] == slot {
			delete(p.slots, session.ID)
		}
		p.mu.Unlock()
	}()
	return &Hold{Conn: conn, releaseFn: func() { p.release(session.ID, slot) }}, nil
}

// AcquireIsolated 另拨一条独立连接，不放进共用池。
// 改过 sshd 子系统之后，原来那条会话仍按登录时的配置执行 SFTP。
func (p *Pool) AcquireIsolated(ctx context.Context, session *SessionConfig, secret string, jumpSecrets []string) (*Hold, error) {
	conn, err := p.dial(ctx, session, secret, jumpSecrets, nil)
	if err != nil {
		return nil, err
	}
	return &Hold{Conn: conn, releaseFn: conn.Close}, nil
}

// Drop 强制丢掉某条会话的缓存连接。池里的连接半死但还没被心跳判死时，
// 上层（终端开 shell 失败等）用它来立刻清场，下次 Acquire 重新拨号。
func (p *Pool) Drop(sessionID string) {
	p.mu.Lock()
	slot := p.slots[sessionID]
	delete(p.slots, sessionID)
	p.mu.Unlock()
	if slot != nil && slot.conn != nil {
		slot.conn.Close()
	}
}

func (p *Pool) release(sessionID string, slot *poolSlot) {
	p.mu.Lock()
	slot.refs--
	if slot.refs > 0 {
		p.mu.Unlock()
		return
	}
	if p.slots[sessionID] == slot {
		delete(p.slots, sessionID)
	}
	p.mu.Unlock()
	if slot.conn != nil {
		slot.conn.Close()
	}
}
