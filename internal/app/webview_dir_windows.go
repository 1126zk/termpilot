//go:build windows

package app

import (
	"os"
	"path/filepath"
	"strconv"

	"golang.org/x/sys/windows"
)

// WebviewDataDir 决定这扇窗口的 WebView2 用户数据目录。
//
// 不设这个选项时两扇窗口共用同一目录，也就是共用同一个浏览器进程。
// Chromium 的输入法桥是浏览器进程里的单例，两窗来回切之后微软拼音可能
// 拿不到光标位置，候选框钉在窗口左上角自绘。每扇窗口各占一个数据目录，
// 浏览器进程随之分开，输入法各管各的。
//
// 不能靠启动参数（--extra-window）判断要不要隔离：双击 exe、任务栏、
// 右键菜单等入口都不带参数，一样会开出第二扇窗。所以一律按实际占用抢锁：
// 先抢基础目录（槽位 0），抢到就用它——首个窗口沿用 go-webview2 的默认
// 路径，老用户的 localStorage 不丢；抢不到说明已有窗口在跑，再抢
// windows\1..16 的槽位目录。
func WebviewDataDir() string {
	exe, err := os.Executable()
	if err != nil {
		return "" // 走 go-webview2 默认
	}
	base := filepath.Join(os.Getenv("AppData"), filepath.Base(exe))
	if tryLockSlot(base) {
		return base
	}
	// 槽位目录：抢第一个空闲槽。槽上的文件锁随进程退出自动释放，
	// 崩溃也不会留下被占的槽。目录数上限就是历史最大同时窗口数。
	for slot := 1; slot <= 16; slot++ {
		dir := filepath.Join(base, "windows", strconv.Itoa(slot))
		if tryLockSlot(dir) {
			return dir
		}
	}
	// 槽全占满（17 扇窗）就退回共用，至少窗口还能开。
	return base
}

// webviewSlotLock 持有槽位锁文件，防 GC 关掉句柄提前放锁。进程退出时系统统一释放。
var webviewSlotLock *os.File

func tryLockSlot(dir string) bool {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return false
	}
	f, err := os.OpenFile(filepath.Join(dir, "slot.lock"), os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return false
	}
	err = windows.LockFileEx(
		windows.Handle(f.Fd()),
		windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY,
		0, 1, 0, &windows.Overlapped{},
	)
	if err != nil {
		f.Close()
		return false
	}
	webviewSlotLock = f
	return true
}
