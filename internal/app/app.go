package app

import (
	"context"
	"errors"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"termpilot/internal/localfs"
	"termpilot/internal/mcpx"
	"termpilot/internal/secrets"
	"termpilot/internal/sftpx"
	"termpilot/internal/sshx"
	"termpilot/internal/storage"
	"termpilot/internal/terminal"
)

// appVersion 与根 package.json 的 version 保持一致。
const appVersion = "0.0.8"

// App 应用装配：持有全部服务，负责启动/退出生命周期。
type App struct {
	ctx      context.Context
	ready    atomic.Bool
	userData string

	store    *storage.Store
	pool     *sshx.Pool
	terminal *terminal.Service
	sftp     *sftpx.Service
	exec     *sshx.ExecService
	local    *localfs.Service
	mcp      *mcpx.Service

	Bridge *Bridge

	launchApp  string
	launchArgs []string
	// 右键「在 TermPilot 中打开」传来的目录。前端挂上之后取走。
	launchMu  sync.Mutex
	launchDir string
}

// userDataDir 固定 %APPDATA%\TermPilot；TERMPILOT_USERDATA 供冒烟测试覆盖。
func userDataDir() string {
	if v := os.Getenv("TERMPILOT_USERDATA"); v != "" {
		return v
	}
	base, err := os.UserConfigDir()
	if err != nil {
		base = "."
	}
	return filepath.Join(base, "TermPilot")
}

// migrateLegacy 只在还没有数据库时把旧目录（%APPDATA%\termpilot）的 sessions.json 拷过来。
func migrateLegacy(dir string) {
	if os.Getenv("TERMPILOT_USERDATA") != "" {
		return
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return
	}
	legacy := filepath.Join(base, "termpilot", "sessions.json")
	current := filepath.Join(dir, "sessions.json")
	db := filepath.Join(dir, "termpilot.db")
	if _, err := os.Stat(db); err == nil {
		return
	}
	if _, err := os.Stat(current); err == nil {
		return
	}
	data, err := os.ReadFile(legacy)
	if err != nil {
		return
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return
	}
	_ = os.WriteFile(current, data, 0o600)
}

func NewApp() *App {
	dir := userDataDir()
	migrateLegacy(dir)

	a := &App{userData: dir, launchArgs: []string{}}
	if exe, err := os.Executable(); err == nil {
		a.launchApp = exe
	}

	// 凭据加密（DPAPI，与 Electron safeStorage 双向兼容）；不可用时带凭据的写入会被 store 拒绝。
	cipher, err := secrets.New(dir)
	if err != nil {
		log.Printf("[TermPilot] 凭据加密不可用: %v", err)
	}
	store, err := storage.Open(dir, cipher)
	if err != nil {
		log.Fatalf("[TermPilot] 打开数据库失败: %v", err)
	}
	a.store = store
	a.store.SetMcpSettingsWriter(a.writeMcpFile)
	// 冒烟模式只跳过写回钩子（避免污染真实 ~/.ssh/config）；导入是只读的，照常进行。
	syncer := newSshSync(a)
	if os.Getenv("TERMPILOT_SMOKE") == "" {
		a.store.AddSyncHook(syncer)
	}
	syncer.importSshConfig()

	a.pool = sshx.NewPool()
	a.terminal = terminal.NewService(sessionStoreAdapter{a}, historyStoreAdapter{a}, appEmitter{a}, a.pool)
	a.sftp = sftpx.New(sftpx.Options{
		Acquire:         a.acquire,
		AcquireIsolated: a.acquireIsolated,
		OnTransfer:      func(ev sftpx.TransferEvent) { a.emit("sftp:transfer", ev) },
		OnInstall:       func(ev sftpx.InstallEvent) { a.emit("sftp:install", ev) },
	})
	a.exec = sshx.NewExecService(a.acquire)
	a.local = localfs.New()
	a.mcp = mcpx.New(mcpx.Deps{
		Storage:  a.store,
		Terminal: a.terminal,
		Sftp:     a.sftp,
		Exec:     a.exec,

		Confirm: a.mcpConfirm,
		Capture: a.mcpCapture,
		Lines:   a.mcpLines,
		Mode:    a.mcpMode,

		OnOpenTab:        func(tab mcpx.TabOpen) { a.emit("mcp:open-tab", tab) },
		OnCloseTab:       func(termID string) { a.emit("mcp:close-tab", termID) },
		OnSessionChanged: func(sessions []*storage.SessionConfig) { a.emit("session:changed", sessions) },
		OnState:          func(state mcpx.McpRuntime) { a.emit("mcp:state-event", state) },

		ScreenshotDir: filepath.Join(dir, "screenshots"),
	})

	a.Bridge = newBridge(a)
	return a
}

func (a *App) Startup(ctx context.Context) {
	a.ctx = ctx
	a.noteLaunchDir(dirFromArgs(os.Args))
	if x, y, ok := posFromArgs(os.Args); ok {
		wailsRuntime.WindowSetPosition(ctx, x, y)
	}

	go a.watchMaximize()

	// 助手只占用一个端口。后开的窗口听不上时，接着用先打开的那个窗口。
	go a.startMcp()
	// 右键菜单、命令行是装一次就行。从「新窗口」起来的进程不再重装。
	if !extraWindow(os.Args) {
		a.installSkill()
		a.installCli()
		a.installContextMenu()
	}
}

func (a *App) startMcp() {
	settings, err := a.store.GetMcpSettings()
	if err != nil || settings == nil {
		return
	}
	if err := a.mcp.Apply(*settings); err != nil {
		if strings.Contains(err.Error(), "已被占用") {
			log.Printf("[TermPilot] MCP 已由另一个窗口监听")
			a.mcp.NoteOtherWindow(settings.Port)
			return
		}
		log.Printf("[TermPilot] MCP start failed: %v", err)
	}
}

func (a *App) Shutdown(ctx context.Context) {
	a.terminal.DisposeAll()
	a.sftp.DisposeAll()
	if err := a.mcp.Stop(); err != nil {
		log.Printf("[TermPilot] MCP stop: %v", err)
	}
	_ = a.store.Close()
}

// emit 下行事件总出口；前端还没就绪时事件丢弃（前端挂载后会主动拉取状态）。
// 注意必须等 DomReady：Wails v2 在页面加载完成前 EventsEmit 会把 JS eval 进
// 尚未初始化的 webview，实测会导致页面白屏（renderer 不挂载）。
func (a *App) emit(channel string, payload interface{}) {
	if a.ctx == nil || !a.ready.Load() {
		return
	}
	wailsRuntime.EventsEmit(a.ctx, channel, payload)
}

func (a *App) DomReady(ctx context.Context) {
	a.ready.Store(true)
	a.pingLaunchDir()
	// 对应 Electron 版 recoverBlankWindow 的尺寸 nudge：Windows 隐藏标题栏时
	// 第一帧偶发停在白底，显示后改一次尺寸强制系统重画。
	if isWindows() {
		go func() {
			time.Sleep(50 * time.Millisecond)
			w, h := wailsRuntime.WindowGetSize(a.ctx)
			wailsRuntime.WindowSetSize(a.ctx, w, h+1)
			wailsRuntime.WindowSetSize(a.ctx, w, h)
		}()
	}
}

// acquire 取会话共享连接（sftpx / exec 的注入回调）。
func (a *App) acquire(sessionID string) (*sshx.Hold, error) {
	session, err := a.store.Get(sessionID)
	if err != nil {
		return nil, err
	}
	if session == nil {
		return nil, errors.New("只能浏览正向 SSH 的文件")
	}
	secret, _ := a.store.GetSecret(sessionID)
	jumps, _ := a.store.GetJumpSecrets(sessionID)
	return a.pool.Acquire(context.Background(), toSshSession(session), secret, jumps)
}

func (a *App) acquireIsolated(sessionID string) (*sshx.Hold, error) {
	session, err := a.store.Get(sessionID)
	if err != nil {
		return nil, err
	}
	if session == nil {
		return nil, errors.New("只能浏览正向 SSH 的文件")
	}
	secret, _ := a.store.GetSecret(sessionID)
	jumps, _ := a.store.GetJumpSecrets(sessionID)
	return a.pool.AcquireIsolated(context.Background(), toSshSession(session), secret, jumps)
}

// watchMaximize 轮询最大化状态，变化时推 win:maximize-changed（Wails 没有原生最大化事件）。
func (a *App) watchMaximize() {
	last := wailsRuntime.WindowIsMaximised(a.ctx)
	for {
		time.Sleep(250 * time.Millisecond)
		if a.ctx == nil {
			return
		}
		cur := wailsRuntime.WindowIsMaximised(a.ctx)
		if cur != last {
			last = cur
			a.emit("win:maximize-changed", cur)
		}
	}
}

// ------------------------------------------------------------ 类型转换适配

// sessionStoreAdapter 把 storage.Store 适配成 terminal.SessionStore。
type sessionStoreAdapter struct{ a *App }

func (s sessionStoreAdapter) FindSession(id string) *sshx.SessionConfig {
	session, err := s.a.store.Get(id)
	if err != nil {
		return nil
	}
	return toSshSession(session)
}

func (s sessionStoreAdapter) GetSecret(sessionID string) string {
	v, _ := s.a.store.GetSecret(sessionID)
	return v
}

func (s sessionStoreAdapter) GetJumpSecrets(sessionID string) []string {
	v, _ := s.a.store.GetJumpSecrets(sessionID)
	return v
}

type historyStoreAdapter struct{ a *App }

func (h historyStoreAdapter) AppendHistory(termID, command string) bool {
	ok, err := h.a.store.AppendHistory(termID, command)
	return err == nil && ok
}

type appEmitter struct{ a *App }

func (e appEmitter) TermData(ev terminal.DataEvent)     { e.a.emit("term:data", ev) }
func (e appEmitter) TermStatus(ev terminal.StatusEvent) { e.a.emit("term:status", ev) }
func (e appEmitter) TermMeta(ev terminal.MetaEvent)     { e.a.emit("term:meta", ev) }
func (e appEmitter) HistoryChanged(termID string)       { e.a.emit("history:changed", termID) }

// toSshSession storage.SessionConfig → sshx.SessionConfig。
func toSshSession(s *storage.SessionConfig) *sshx.SessionConfig {
	if s == nil {
		return nil
	}
	out := &sshx.SessionConfig{
		ID:       s.ID,
		Host:     s.Host,
		Port:     s.Port,
		Username: s.Username,
		UseKey:   s.UseKey,
	}
	for _, hop := range s.Jumps {
		out.Jumps = append(out.Jumps, sshx.Hop{Host: hop.Host, Port: hop.Port, Username: hop.Username})
	}
	out.Options = toConnectOptions(s.SshOptions)
	return out
}

func toConnectOptions(o *storage.SshConnectOptions) *sshx.ConnectOptions {
	if o == nil {
		return nil
	}
	out := &sshx.ConnectOptions{
		ReadyTimeoutMs:        o.ReadyTimeoutMs,
		KeepaliveIntervalMs:   o.KeepaliveIntervalMs,
		KeepaliveCountMax:     o.KeepaliveCountMax,
		Compress:              o.Compress,
		Family:                o.Family,
		LocalAddress:          o.LocalAddress,
		StrictHostKeyChecking: o.StrictHostKeyChecking,
		ProxyCommand:          o.ProxyCommand,
	}
	if o.Algorithms != nil {
		out.Algorithms = &sshx.AlgorithmOptions{
			Cipher:        o.Algorithms.Cipher,
			Kex:           o.Algorithms.Kex,
			ServerHostKey: o.Algorithms.ServerHostKey,
			HMAC:          o.Algorithms.Hmac,
		}
	}
	return out
}
