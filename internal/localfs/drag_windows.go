//go:build windows && amd64

package localfs

import (
	"encoding/binary"
	"errors"
	"fmt"
	"runtime"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// 系统拖放只提供 CF_HDROP，并且只允许 DROPEFFECT_MOVE。
// Preferred DropEffect 也写成移动，资源管理器松手后自己把文件移走。
// 落回本窗口时 WebView2 只把路径交回来，源文件由前端 MoveInto 移走。
// DoDragDrop 返回后这里绝不删除源文件，避免和目标各删一次。

const (
	sOK                        = 0
	eNotImpl                   = 0x80004001
	eNoInterface               = 0x80004002
	ePointer                   = 0x80004003
	eOutOfMemory               = 0x8007000E
	dvEFormatEtc               = 0x80040064
	oleEAdviseNotSupported     = 0x80040003
	dragdropSDrop              = 0x00040100
	dragdropSCancel            = 0x00040101
	dragdropSUseDefaultCursors = 0x00040102
	cfHDROP                    = 15
	tyMedHGlobal               = 1
	dvAspectContent            = 1
	dataDirGet                 = 1
	dropEffectMove             = 2
	gmemMoveable               = 0x0002
	gmemZeroInit               = 0x0040
	vkLButton                  = 0x01
	mkLButton                  = 0x0001
	rpcEChangedMode            = 0x80010106
	wmStartDrag                = 0x8000 + 81
)

type guid struct {
	data1 uint32
	data2 uint16
	data3 uint16
	data4 [8]byte
}

var (
	iidIUnknown       = guid{0x00000000, 0x0000, 0x0000, [8]byte{0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46}}
	iidIDataObject    = guid{0x0000010e, 0x0000, 0x0000, [8]byte{0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46}}
	iidIDropSource    = guid{0x00000121, 0x0000, 0x0000, [8]byte{0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46}}
	iidIEnumFORMATETC = guid{0x00000103, 0x0000, 0x0000, [8]byte{0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46}}
)

// FORMATETC / STGMEDIUM 的内存布局必须和 64 位 COM 一致。
type formatETC struct {
	cfFormat uint16
	ptd      uintptr
	dwAspect uint32
	lindex   int32
	tymed    uint32
}

type stgMedium struct {
	tymed          uint32
	hGlobal        uintptr
	pUnkForRelease uintptr
}

type dataVtbl struct {
	queryInterface        uintptr
	addRef                uintptr
	release               uintptr
	getData               uintptr
	getDataHere           uintptr
	queryGetData          uintptr
	getCanonicalFormatEtc uintptr
	setData               uintptr
	enumFormatEtc         uintptr
	dAdvise               uintptr
	dUnadvise             uintptr
	enumDAdvise           uintptr
}

type dropVtbl struct {
	queryInterface    uintptr
	addRef            uintptr
	release           uintptr
	queryContinueDrag uintptr
	giveFeedback      uintptr
}

type enumVtbl struct {
	queryInterface uintptr
	addRef         uintptr
	release        uintptr
	next           uintptr
	skip           uintptr
	reset          uintptr
	clone          uintptr
}

var (
	dataV dataVtbl
	dropV dropVtbl
	enumV enumVtbl

	ole32                    = windows.NewLazySystemDLL("ole32.dll")
	procOleInitialize        = ole32.NewProc("OleInitialize")
	procOleUninitialize      = ole32.NewProc("OleUninitialize")
	procDoDragDrop           = ole32.NewProc("DoDragDrop")
	procReleaseStgMedium     = ole32.NewProc("ReleaseStgMedium")
	kernel32                 = windows.NewLazySystemDLL("kernel32.dll")
	procGlobalAlloc          = kernel32.NewProc("GlobalAlloc")
	procGlobalLock           = kernel32.NewProc("GlobalLock")
	procGlobalUnlock         = kernel32.NewProc("GlobalUnlock")
	procGlobalFree           = kernel32.NewProc("GlobalFree")
	user32                   = windows.NewLazySystemDLL("user32.dll")
	procGetAsyncKeyState     = user32.NewProc("GetAsyncKeyState")
	procGetKeyState          = user32.NewProc("GetKeyState")
	procRegisterClipboardFmt = user32.NewProc("RegisterClipboardFormatW")
	procEnumWindows          = user32.NewProc("EnumWindows")
	procGetWindowThreadPID   = user32.NewProc("GetWindowThreadProcessId")
	procIsWindowVisible      = user32.NewProc("IsWindowVisible")
	procGetWindowTextW       = user32.NewProc("GetWindowTextW")
	procPostMessageW         = user32.NewProc("PostMessageW")
	procSetWindowLongPtrW    = user32.NewProc("SetWindowLongPtrW")
	procCallWindowProcW      = user32.NewProc("CallWindowProcW")

	prefFormat     uint32
	dragMu         sync.Mutex
	dragSawButton  atomic.Bool
	dragPending    atomic.Pointer[dragRequest]
	subclassReady  atomic.Uintptr
	origWndProc    uintptr
	enumProc       uintptr
	subclassProc   uintptr
	enumFound      uintptr
	dragStartedAt  time.Time
	errWrongThread = errors.New("拖放线程模式不对")
)

type dragRequest struct {
	paths []string
	errc  chan error
}

func init() {
	if unsafe.Sizeof(formatETC{}) != 32 || unsafe.Sizeof(stgMedium{}) != 24 {
		panic("ole drag struct size mismatch")
	}
	dataV = dataVtbl{
		queryInterface:        syscall.NewCallback(dataQueryInterface),
		addRef:                syscall.NewCallback(dataAddRef),
		release:               syscall.NewCallback(dataRelease),
		getData:               syscall.NewCallback(dataGetData),
		getDataHere:           syscall.NewCallback(dataNotImpl3),
		queryGetData:          syscall.NewCallback(dataQueryGetData),
		getCanonicalFormatEtc: syscall.NewCallback(dataGetCanonical),
		setData:               syscall.NewCallback(dataSetData),
		enumFormatEtc:         syscall.NewCallback(dataEnumFormatEtc),
		dAdvise:               syscall.NewCallback(dataAdviseNotSupported5),
		dUnadvise:             syscall.NewCallback(dataNotImpl2),
		enumDAdvise:           syscall.NewCallback(dataNotImpl2),
	}
	dropV = dropVtbl{
		queryInterface:    syscall.NewCallback(dropQueryInterface),
		addRef:            syscall.NewCallback(dropAddRef),
		release:           syscall.NewCallback(dropRelease),
		queryContinueDrag: syscall.NewCallback(dropQueryContinue),
		giveFeedback:      syscall.NewCallback(dropGiveFeedback),
	}
	enumV = enumVtbl{
		queryInterface: syscall.NewCallback(enumQueryInterface),
		addRef:         syscall.NewCallback(enumAddRef),
		release:        syscall.NewCallback(enumRelease),
		next:           syscall.NewCallback(enumNext),
		skip:           syscall.NewCallback(enumSkip),
		reset:          syscall.NewCallback(enumReset),
		clone:          syscall.NewCallback(enumClone),
	}
	enumProc = syscall.NewCallback(enumTermPilotWindow)
	subclassProc = syscall.NewCallback(dragWndProc)
}

type dataObject struct {
	vtbl    *dataVtbl
	refs    int32
	pin     *runtime.Pinner
	hdrop   []byte
	effect  []byte
	formats []formatETC
	enums   []*enumFormat
}

type dropSource struct {
	vtbl *dropVtbl
	refs int32
}

type enumFormat struct {
	vtbl    *enumVtbl
	refs    int32
	formats []formatETC
	index   int
}

func dragMoveNative(paths []string) error {
	dragMu.Lock()
	defer dragMu.Unlock()
	// 浏览器拖拽被取消后，DoDragDrop 必须跑在窗口自己的线程上。
	// 新线程读不到鼠标按键，拖放会立刻被当成已经松手。
	if hwnd := termPilotHWND(); hwnd != 0 && ensureDragHook(hwnd) {
		if err := postDrag(hwnd, paths); !errors.Is(err, errWrongThread) {
			return err
		}
	}
	return errors.New("找不到窗口，拖不出去")
}

func postDrag(hwnd uintptr, paths []string) error {
	req := &dragRequest{paths: paths, errc: make(chan error, 1)}
	if !dragPending.CompareAndSwap(nil, req) {
		return errors.New("正在拖放")
	}
	if r, _, err := procPostMessageW.Call(hwnd, wmStartDrag, 0, 0); r == 0 {
		dragPending.Store(nil)
		return fmt.Errorf("无法开始拖放: %v", err)
	}
	return <-req.errc
}

func termPilotHWND() uintptr {
	enumFound = 0
	_, _, _ = procEnumWindows.Call(enumProc, 0)
	return enumFound
}

func enumTermPilotWindow(hwnd, _ uintptr) uintptr {
	var pid uint32
	_, _, _ = procGetWindowThreadPID.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
	if pid != windows.GetCurrentProcessId() {
		return 1
	}
	visible, _, _ := procIsWindowVisible.Call(hwnd)
	if visible == 0 {
		return 1
	}
	buf := make([]uint16, 64)
	_, _, _ = procGetWindowTextW.Call(hwnd, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	if windows.UTF16ToString(buf) == "TermPilot" {
		enumFound = hwnd
		return 0
	}
	if enumFound == 0 && windowClass(hwnd) == "winc_Form" {
		enumFound = hwnd
	}
	return 1
}

func windowClass(hwnd uintptr) string {
	buf := make([]uint16, 64)
	procGetClassNameW := user32.NewProc("GetClassNameW")
	n, _, _ := procGetClassNameW.Call(hwnd, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	if n == 0 {
		return ""
	}
	return windows.UTF16ToString(buf)
}

func ensureDragHook(hwnd uintptr) bool {
	if subclassReady.Load() == hwnd && origWndProc != 0 {
		return true
	}
	nIndex := int32(-4) // GWLP_WNDPROC
	prev, _, _ := procSetWindowLongPtrW.Call(hwnd, uintptr(nIndex), subclassProc)
	if prev == 0 {
		return false
	}
	origWndProc = prev
	subclassReady.Store(hwnd)
	return true
}

func dragWndProc(hwnd, msg, wparam, lparam uintptr) uintptr {
	if uint32(msg) == wmStartDrag {
		if req := dragPending.Swap(nil); req != nil {
			req.errc <- runDrag(req.paths, false)
		}
		return 0
	}
	if origWndProc == 0 {
		return 0
	}
	ret, _, _ := procCallWindowProcW.Call(origWndProc, hwnd, msg, wparam, lparam)
	return ret
}

func runDrag(paths []string, releaseCOM bool) error {
	if err := ensurePrefFormat(); err != nil {
		return err
	}
	hdrop, err := buildHDROP(paths)
	if err != nil {
		return err
	}
	obj := &dataObject{
		vtbl:   &dataV,
		refs:   1,
		hdrop:  hdrop,
		effect: buildMoveEffect(),
		formats: []formatETC{
			{cfFormat: cfHDROP, dwAspect: dvAspectContent, lindex: -1, tymed: tyMedHGlobal},
			{cfFormat: uint16(prefFormat), dwAspect: dvAspectContent, lindex: -1, tymed: tyMedHGlobal},
		},
	}
	src := &dropSource{vtbl: &dropV, refs: 1}
	var pin runtime.Pinner
	obj.pin = &pin
	pin.Pin(obj)
	pin.Pin(src)
	defer pin.Unpin()

	hr, _, _ := procOleInitialize.Call(0)
	if uint32(hr) == rpcEChangedMode {
		return errWrongThread
	}
	if int32(hr) < 0 {
		return fmt.Errorf("拖放初始化失败 (%08x)", uint32(hr))
	}
	// 窗口线程上的 COM 是界面自己的，拖完不能 OleUninitialize。
	if hr == sOK && releaseCOM {
		defer procOleUninitialize.Call()
	}

	dragSawButton.Store(false)
	dragStartedAt = time.Now()
	var effect uint32
	hr, _, _ = procDoDragDrop.Call(
		uintptr(unsafe.Pointer(obj)),
		uintptr(unsafe.Pointer(src)),
		dropEffectMove,
		uintptr(unsafe.Pointer(&effect)),
	)
	runtime.KeepAlive(obj)
	runtime.KeepAlive(src)
	if int32(hr) < 0 {
		return fmt.Errorf("拖放失败 (%08x)", uint32(hr))
	}
	if !dragSawButton.Load() {
		return errors.New("拖放没有开始，请按住文件再拖")
	}
	return nil
}

func ensurePrefFormat() error {
	if prefFormat != 0 {
		return nil
	}
	name, err := windows.UTF16PtrFromString("Preferred DropEffect")
	if err != nil {
		return err
	}
	id, _, callErr := procRegisterClipboardFmt.Call(uintptr(unsafe.Pointer(name)))
	if id == 0 {
		return fmt.Errorf("注册拖放格式失败: %v", callErr)
	}
	prefFormat = uint32(id)
	return nil
}

func buildHDROP(paths []string) ([]byte, error) {
	var units []uint16
	for _, p := range paths {
		u, err := windows.UTF16FromString(p)
		if err != nil {
			return nil, err
		}
		units = append(units, u...)
	}
	units = append(units, 0)
	buf := make([]byte, 20+len(units)*2)
	binary.LittleEndian.PutUint32(buf[0:4], 20)
	binary.LittleEndian.PutUint32(buf[16:20], 1)
	for i, u := range units {
		binary.LittleEndian.PutUint16(buf[20+i*2:], u)
	}
	return buf, nil
}

func buildMoveEffect() []byte {
	buf := make([]byte, 4)
	binary.LittleEndian.PutUint32(buf, dropEffectMove)
	return buf
}

func (o *dataObject) payload(cf uint16) ([]byte, bool) {
	switch cf {
	case cfHDROP:
		return o.hdrop, true
	case uint16(prefFormat):
		return o.effect, true
	default:
		return nil, false
	}
}

func formatOK(f *formatETC) bool {
	if f.dwAspect != 0 && f.dwAspect != dvAspectContent {
		return false
	}
	if f.tymed != 0 && f.tymed&tyMedHGlobal == 0 {
		return false
	}
	return true
}

func globalBytes(b []byte) (uintptr, uintptr) {
	h, _, _ := procGlobalAlloc.Call(gmemMoveable|gmemZeroInit, uintptr(len(b)))
	if h == 0 {
		return 0, eOutOfMemory
	}
	ptr, _, _ := procGlobalLock.Call(h)
	if ptr == 0 {
		procGlobalFree.Call(h)
		return 0, eOutOfMemory
	}
	dst := unsafe.Slice((*byte)(unsafe.Pointer(ptr)), len(b))
	copy(dst, b)
	procGlobalUnlock.Call(h)
	return h, sOK
}

func writeInterface(ppv, obj uintptr) {
	*(*uintptr)(unsafe.Pointer(ppv)) = obj
}

func dataQueryInterface(this, riid, ppv uintptr) uintptr {
	if ppv == 0 {
		return ePointer
	}
	id := (*guid)(unsafe.Pointer(riid))
	if *id == iidIUnknown || *id == iidIDataObject {
		writeInterface(ppv, this)
		dataAddRef(this)
		return sOK
	}
	writeInterface(ppv, 0)
	return eNoInterface
}

func dataAddRef(this uintptr) uintptr {
	o := (*dataObject)(unsafe.Pointer(this))
	return uintptr(atomic.AddInt32(&o.refs, 1))
}

func dataRelease(this uintptr) uintptr {
	o := (*dataObject)(unsafe.Pointer(this))
	n := atomic.AddInt32(&o.refs, -1)
	if n < 0 {
		atomic.StoreInt32(&o.refs, 0)
		return 0
	}
	return uintptr(n)
}

func dataGetData(this, pFmt, pMed uintptr) uintptr {
	if pFmt == 0 || pMed == 0 {
		return ePointer
	}
	o := (*dataObject)(unsafe.Pointer(this))
	f := (*formatETC)(unsafe.Pointer(pFmt))
	payload, ok := o.payload(f.cfFormat)
	if !ok || !formatOK(f) {
		return dvEFormatEtc
	}
	h, hr := globalBytes(payload)
	if hr != sOK {
		return hr
	}
	*(*stgMedium)(unsafe.Pointer(pMed)) = stgMedium{tymed: tyMedHGlobal, hGlobal: h}
	return sOK
}

func dataQueryGetData(this, pFmt uintptr) uintptr {
	if pFmt == 0 {
		return ePointer
	}
	o := (*dataObject)(unsafe.Pointer(this))
	f := (*formatETC)(unsafe.Pointer(pFmt))
	if _, ok := o.payload(f.cfFormat); !ok || !formatOK(f) {
		return dvEFormatEtc
	}
	return sOK
}

func dataEnumFormatEtc(this, direction, ppenum uintptr) uintptr {
	if ppenum == 0 {
		return ePointer
	}
	if direction != dataDirGet {
		writeInterface(ppenum, 0)
		return eNotImpl
	}
	o := (*dataObject)(unsafe.Pointer(this))
	formats := make([]formatETC, len(o.formats))
	copy(formats, o.formats)
	enum := &enumFormat{vtbl: &enumV, refs: 1, formats: formats}
	o.enums = append(o.enums, enum)
	if o.pin != nil {
		o.pin.Pin(enum)
	}
	writeInterface(ppenum, uintptr(unsafe.Pointer(enum)))
	return sOK
}

func dataGetCanonical(_, in, out uintptr) uintptr {
	if in != 0 && out != 0 {
		*(*formatETC)(unsafe.Pointer(out)) = *(*formatETC)(unsafe.Pointer(in))
	}
	return 0x00040130 // DATA_S_SAMEFORMATETC
}

func dataSetData(_, _, medium, release uintptr) uintptr {
	if release != 0 && medium != 0 {
		_, _, _ = procReleaseStgMedium.Call(medium)
	}
	return sOK
}

func dataNotImpl2(_, _ uintptr) uintptr       { return eNotImpl }
func dataNotImpl3(_, _, _ uintptr) uintptr    { return eNotImpl }
func dataNotImpl4(_, _, _, _ uintptr) uintptr { return eNotImpl }
func dataAdviseNotSupported5(_, _, _, _, _ uintptr) uintptr {
	return oleEAdviseNotSupported
}

func dropQueryInterface(this, riid, ppv uintptr) uintptr {
	if ppv == 0 {
		return ePointer
	}
	id := (*guid)(unsafe.Pointer(riid))
	if *id == iidIUnknown || *id == iidIDropSource {
		writeInterface(ppv, this)
		dropAddRef(this)
		return sOK
	}
	writeInterface(ppv, 0)
	return eNoInterface
}

func dropAddRef(this uintptr) uintptr {
	o := (*dropSource)(unsafe.Pointer(this))
	return uintptr(atomic.AddInt32(&o.refs, 1))
}

func dropRelease(this uintptr) uintptr {
	o := (*dropSource)(unsafe.Pointer(this))
	n := atomic.AddInt32(&o.refs, -1)
	if n < 0 {
		atomic.StoreInt32(&o.refs, 0)
		return 0
	}
	return uintptr(n)
}

func dropQueryContinue(_, escape, keyState uintptr) uintptr {
	if escape != 0 {
		return dragdropSCancel
	}
	down := keyState&mkLButton != 0
	if !down {
		state, _, _ := procGetAsyncKeyState.Call(vkLButton)
		down = uint16(state)&0x8000 != 0
	}
	if !down {
		state, _, _ := procGetKeyState.Call(vkLButton)
		down = uint16(state)&0x8000 != 0
	}
	if down {
		dragSawButton.Store(true)
		return sOK
	}
	// 刚进拖放循环时按键状态可能还是空的，先保持循环，等鼠标消息进来。
	if !dragSawButton.Load() && time.Since(dragStartedAt) < 400*time.Millisecond {
		return sOK
	}
	return dragdropSDrop
}

func dropGiveFeedback(_ uintptr, _ uintptr) uintptr {
	return dragdropSUseDefaultCursors
}

func enumQueryInterface(this, riid, ppv uintptr) uintptr {
	if ppv == 0 {
		return ePointer
	}
	id := (*guid)(unsafe.Pointer(riid))
	if *id == iidIUnknown || *id == iidIEnumFORMATETC {
		writeInterface(ppv, this)
		enumAddRef(this)
		return sOK
	}
	writeInterface(ppv, 0)
	return eNoInterface
}

func enumAddRef(this uintptr) uintptr {
	o := (*enumFormat)(unsafe.Pointer(this))
	return uintptr(atomic.AddInt32(&o.refs, 1))
}

func enumRelease(this uintptr) uintptr {
	o := (*enumFormat)(unsafe.Pointer(this))
	n := atomic.AddInt32(&o.refs, -1)
	if n < 0 {
		atomic.StoreInt32(&o.refs, 0)
		return 0
	}
	return uintptr(n)
}

func enumNext(this, celt, rgelt, fetched uintptr) uintptr {
	if rgelt == 0 {
		return ePointer
	}
	if celt != 1 && fetched == 0 {
		return ePointer
	}
	o := (*enumFormat)(unsafe.Pointer(this))
	n := int(celt)
	written := 0
	for written < n && o.index < len(o.formats) {
		dst := unsafe.Add(unsafe.Pointer(rgelt), written*int(unsafe.Sizeof(formatETC{})))
		*(*formatETC)(dst) = o.formats[o.index]
		o.index++
		written++
	}
	if fetched != 0 {
		*(*uint32)(unsafe.Pointer(fetched)) = uint32(written)
	}
	if written == n {
		return sOK
	}
	return 1 // S_FALSE
}

func enumSkip(this, celt uintptr) uintptr {
	o := (*enumFormat)(unsafe.Pointer(this))
	o.index += int(celt)
	if o.index > len(o.formats) {
		o.index = len(o.formats)
		return 1
	}
	return sOK
}

func enumReset(this uintptr) uintptr {
	(*enumFormat)(unsafe.Pointer(this)).index = 0
	return sOK
}

func enumClone(_, _ uintptr) uintptr { return eNotImpl }
