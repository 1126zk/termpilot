//go:build windows && amd64

package localfs

import (
	"encoding/binary"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

func TestOleStructSizes(t *testing.T) {
	if unsafe.Sizeof(formatETC{}) != 32 {
		t.Fatalf("FORMATETC size %d", unsafe.Sizeof(formatETC{}))
	}
	if unsafe.Sizeof(stgMedium{}) != 24 {
		t.Fatalf("STGMEDIUM size %d", unsafe.Sizeof(stgMedium{}))
	}
}

func TestDragNoButtonReturns(t *testing.T) {
	dir := t.TempDir()
	file := dir + `\a.txt`
	writeFile(t, file, "a")
	done := make(chan error, 1)
	go func() { done <- New().DragMove([]string{file}) }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("松开鼠标时不应开始拖放")
		}
		t.Log(err)
	case <-time.After(8 * time.Second):
		t.Fatal("拖放没有返回")
	}
}
func TestBuildHDROP(t *testing.T) {
	buf, err := buildHDROP([]string{`C:\a.txt`})
	if err != nil {
		t.Fatal(err)
	}
	if binary.LittleEndian.Uint32(buf[0:4]) != 20 {
		t.Fatalf("pFiles %d", binary.LittleEndian.Uint32(buf[0:4]))
	}
	if binary.LittleEndian.Uint32(buf[16:20]) != 1 {
		t.Fatal("fWide")
	}
	// C:\a.txt 的 UTF-16，再加字符串结尾和一个列表结尾。
	units := (len(buf) - 20) / 2
	if units < 3 || buf[len(buf)-1] != 0 || buf[len(buf)-2] != 0 || buf[len(buf)-3] != 0 || buf[len(buf)-4] != 0 {
		t.Fatalf("missing double NUL, len %d", len(buf))
	}
}

func TestDragOnWindowThreadReturns(t *testing.T) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	className, err := windows.UTF16PtrFromString("winc_Form")
	if err != nil {
		t.Fatal(err)
	}
	title, err := windows.UTF16PtrFromString("TermPilot")
	if err != nil {
		t.Fatal(err)
	}
	defWindowProc := user32.NewProc("DefWindowProcW")
	registerClass := user32.NewProc("RegisterClassExW")
	createWindow := user32.NewProc("CreateWindowExW")
	showWindow := user32.NewProc("ShowWindow")
	destroyWindow := user32.NewProc("DestroyWindow")
	peekMessage := user32.NewProc("PeekMessageW")
	translateMessage := user32.NewProc("TranslateMessage")
	dispatchMessage := user32.NewProc("DispatchMessageW")
	wndproc := syscall.NewCallback(func(hwnd, msg, wp, lp uintptr) uintptr {
		ret, _, _ := defWindowProc.Call(hwnd, msg, wp, lp)
		return ret
	})
	type wndClassEx struct {
		cbSize        uint32
		style         uint32
		lpfnWndProc   uintptr
		cbClsExtra    int32
		cbWndExtra    int32
		hInstance     uintptr
		hIcon         uintptr
		hCursor       uintptr
		hbrBackground uintptr
		lpszMenuName  uintptr
		lpszClassName uintptr
		hIconSm       uintptr
	}
	wc := wndClassEx{
		lpfnWndProc:   wndproc,
		hbrBackground: 6,
		lpszClassName: uintptr(unsafe.Pointer(className)),
	}
	wc.cbSize = uint32(unsafe.Sizeof(wc))
	if r, _, regErr := registerClass.Call(uintptr(unsafe.Pointer(&wc))); r == 0 && regErr != syscall.Errno(1410) {
		t.Fatalf("RegisterClassEx: %v", regErr)
	}
	hwnd, _, createErr := createWindow.Call(
		0,
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(title)),
		0x00CF0000|0x10000000,
		0x80000000, 0x80000000, 240, 180,
		0, 0, 0, 0,
	)
	if hwnd == 0 {
		t.Fatalf("CreateWindow: %v", createErr)
	}
	defer destroyWindow.Call(hwnd)
	showWindow.Call(hwnd, 5)

	dir := t.TempDir()
	file := dir + `\a.txt`
	writeFile(t, file, "a")
	done := make(chan error, 1)
	go func() {
		time.Sleep(200 * time.Millisecond)
		done <- New().DragMove([]string{file})
	}()
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		ticker := time.NewTicker(30 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				_, _, _ = procPostMessageW.Call(hwnd, 0x0200, 0, 0)
			}
		}
	}()

	deadline := time.Now().Add(6 * time.Second)
	var msg [48]byte
	for time.Now().Before(deadline) {
		r, _, _ := peekMessage.Call(uintptr(unsafe.Pointer(&msg[0])), 0, 0, 0, 1)
		if r != 0 {
			_, _, _ = translateMessage.Call(uintptr(unsafe.Pointer(&msg[0])))
			_, _, _ = dispatchMessage.Call(uintptr(unsafe.Pointer(&msg[0])))
		} else {
			time.Sleep(10 * time.Millisecond)
		}
		select {
		case dragErr := <-done:
			if dragErr != nil && strings.Contains(dragErr.Error(), "找不到窗口") {
				t.Fatal(dragErr)
			}
			t.Log(dragErr)
			return
		default:
		}
	}
	t.Fatal("拖放没有返回")
}
