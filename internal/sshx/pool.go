package sshx

import (
	"context"
	"errors"
	"sort"
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
	// forwards 这条连接上正在监听的端口映射，按 ForwardRule.key 索引。连接关掉后置 nil。
	forwards map[string]*activeForward
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
// 并发 Acquire 同一会话时共享同一次拨号。端口映射不随建连自动开，见 StartForward；
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
	// 端口映射建连时不自动开，由用户在标签菜单里用 StartForward / StopForward 单条开关。
	p.mu.Lock()
	slot.conn = conn
	slot.forwards = map[string]*activeForward{}
	p.mu.Unlock()
	close(slot.ready)
	go func() {
		_ = conn.Wait()
		p.mu.Lock()
		if p.slots[session.ID] == slot {
			delete(p.slots, session.ID)
		}
		closing := slot.forwards
		slot.forwards = nil
		p.mu.Unlock()
		for _, f := range closing {
			_ = f.closer.Close()
		}
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

var errNotConnected = errors.New("这台服务器当前没有连着，先打开终端连上再启动端口映射")

// liveSlot 取会话已经连好的共享连接。调用方持有 p.mu。
func (p *Pool) liveSlot(sessionID string) *poolSlot {
	slot := p.slots[sessionID]
	if slot == nil || slot.conn == nil || slot.conn.Client == nil || slot.forwards == nil {
		return nil
	}
	return slot
}

// ActiveForwards 这个会话的共享连接上正在监听的端口映射。没连着时返回空。
func (p *Pool) ActiveForwards(sessionID string) []ForwardRule {
	p.mu.Lock()
	defer p.mu.Unlock()
	slot := p.liveSlot(sessionID)
	if slot == nil {
		return nil
	}
	rules := make([]ForwardRule, 0, len(slot.forwards))
	for _, f := range slot.forwards {
		rules = append(rules, f.rule)
	}
	sort.Slice(rules, func(i, j int) bool { return rules[i].key() < rules[j].key() })
	return rules
}

// StartForward 在已经连着的共享连接上启动一条端口映射。已经在跑就什么都不做。
func (p *Pool) StartForward(sessionID string, rule ForwardRule) error {
	p.mu.Lock()
	slot := p.liveSlot(sessionID)
	if slot == nil {
		p.mu.Unlock()
		return errNotConnected
	}
	if slot.forwards[rule.key()] != nil {
		p.mu.Unlock()
		return nil
	}
	client := slot.conn.Client
	p.mu.Unlock()

	// 远程转发要等服务器应答，不能在锁里做。
	closer, err := openForward(client, rule)
	if err != nil {
		return err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	// 等应答期间连接断了，或者另一次点击已经启动了同一条
	if p.liveSlot(sessionID) != slot {
		_ = closer.Close()
		return errNotConnected
	}
	if slot.forwards[rule.key()] != nil {
		_ = closer.Close()
		return nil
	}
	slot.forwards[rule.key()] = &activeForward{rule: rule, closer: closer}
	return nil
}

// StopForward 停掉一条端口映射。已经建立的转发连接不受影响，只是不再接新连接。
func (p *Pool) StopForward(sessionID string, rule ForwardRule) {
	p.mu.Lock()
	var f *activeForward
	if slot := p.liveSlot(sessionID); slot != nil {
		f = slot.forwards[rule.key()]
		delete(slot.forwards, rule.key())
	}
	p.mu.Unlock()
	if f != nil {
		_ = f.closer.Close()
	}
}
