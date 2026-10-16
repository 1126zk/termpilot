/* Windows 11 新右键菜单加载的 COM DLL。资源管理器只认这个 DLL，不认 TermPilot.exe。
   点击后按 exe.path 启动主程序，并带上 --dir。主程序暂时不处理这个参数。 */

#define COBJMACROS
#include "clsid.h"
#include "exe_path.h"

#include <objbase.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <stdlib.h>
#include <wchar.h>

static const wchar_t kTitle[] = L"\u5728 TermPilot \u4E2D\u6253\u5F00";

typedef struct Command {
    IExplorerCommandVtbl *lpVtbl;
    LONG refs;
} Command;

typedef struct Factory {
    IClassFactoryVtbl *lpVtbl;
    LONG refs;
} Factory;

static HRESULT STDMETHODCALLTYPE Command_QueryInterface(IExplorerCommand *This, REFIID riid, void **ppv) {
    if (!ppv) return E_POINTER;
    if (IsEqualIID(riid, &IID_IUnknown) || IsEqualIID(riid, &IID_IExplorerCommand)) {
        *ppv = This;
        IExplorerCommand_AddRef(This);
        return S_OK;
    }
    *ppv = NULL;
    return E_NOINTERFACE;
}

static ULONG STDMETHODCALLTYPE Command_AddRef(IExplorerCommand *This) {
    Command *self = (Command *)This;
    return (ULONG)InterlockedIncrement(&self->refs);
}

static ULONG STDMETHODCALLTYPE Command_Release(IExplorerCommand *This) {
    Command *self = (Command *)This;
    LONG left = InterlockedDecrement(&self->refs);
    if (left == 0) free(self);
    return (ULONG)left;
}

static HRESULT STDMETHODCALLTYPE Command_GetTitle(IExplorerCommand *This, IShellItemArray *items, LPWSTR *name) {
    (void)This;
    (void)items;
    if (!name) return E_POINTER;
    return SHStrDupW(kTitle, name);
}

/* 图标放在 DLL 自己的资源里。exe 被挪走或删掉时，菜单文字还在，图标也不能丢。 */
static HRESULT STDMETHODCALLTYPE Command_GetIcon(IExplorerCommand *This, IShellItemArray *items, LPWSTR *icon) {
    HMODULE module = NULL;
    wchar_t dll[32768];
    wchar_t spec[32768];
    (void)This;
    (void)items;
    if (!icon) return E_POINTER;
    *icon = NULL;
    if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                            (LPCWSTR)(void *)&Command_GetIcon, &module)) {
        return E_FAIL;
    }
    if (GetModuleFileNameW(module, dll, 32768) == 0 || wcslen(dll) + 5 >= 32768) return E_FAIL;
    wcscpy(spec, dll);
    wcscat(spec, L",-101");
    return SHStrDupW(spec, icon);
}

static HRESULT STDMETHODCALLTYPE Command_GetToolTip(IExplorerCommand *This, IShellItemArray *items, LPWSTR *tip) {
    (void)This;
    (void)items;
    if (!tip) return E_POINTER;
    *tip = NULL;
    return E_NOTIMPL;
}

static HRESULT STDMETHODCALLTYPE Command_GetCanonicalName(IExplorerCommand *This, GUID *name) {
    (void)This;
    if (!name) return E_POINTER;
    *name = CLSID_TermPilotCommand;
    return S_OK;
}

static HRESULT STDMETHODCALLTYPE Command_GetState(IExplorerCommand *This, IShellItemArray *items, BOOL okToBeSlow,
                                                  EXPCMDSTATE *state) {
    (void)This;
    (void)items;
    (void)okToBeSlow;
    if (!state) return E_POINTER;
    *state = ECS_ENABLED;
    return S_OK;
}

static int firstFolder(IShellItemArray *items, wchar_t *out, DWORD cch) {
    DWORD count = 0;
    IShellItem *item = NULL;
    PWSTR path = NULL;
    HRESULT hr;

    if (!items) return 0;
    if (FAILED(IShellItemArray_GetCount(items, &count)) || count == 0) return 0;
    if (FAILED(IShellItemArray_GetItemAt(items, 0, &item)) || !item) return 0;
    hr = IShellItem_GetDisplayName(item, SIGDN_FILESYSPATH, &path);
    IShellItem_Release(item);
    if (FAILED(hr) || !path) return 0;
    if (wcschr(path, L'"') || wcslen(path) >= cch) {
        CoTaskMemFree(path);
        return 0;
    }
    wcscpy(out, path);
    CoTaskMemFree(path);
    return 1;
}

static HRESULT STDMETHODCALLTYPE Command_Invoke(IExplorerCommand *This, IShellItemArray *items, IBindCtx *ctx) {
    wchar_t exe[32768];
    wchar_t dir[32768];
    wchar_t params[32768];
    SHELLEXECUTEINFOW info;
    (void)This;
    (void)ctx;

    if (!termpilotExePath(exe, 32768)) return E_FAIL;
    if (!firstFolder(items, dir, 32768)) return E_INVALIDARG;
    if (wcslen(dir) + 8 >= 32768) return E_FAIL;
    wcscpy(params, L"--dir \"");
    wcscat(params, dir);
    wcscat(params, L"\"");

    ZeroMemory(&info, sizeof(info));
    info.cbSize = sizeof(info);
    info.fMask = SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI | SEE_MASK_NOCLOSEPROCESS;
    info.lpVerb = L"open";
    info.lpFile = exe;
    info.lpParameters = params;
    info.lpDirectory = dir;
    info.nShow = SW_SHOWNORMAL;
    if (!ShellExecuteExW(&info)) return E_FAIL;
    if (info.hProcess) CloseHandle(info.hProcess);
    return S_OK;
}

static HRESULT STDMETHODCALLTYPE Command_GetFlags(IExplorerCommand *This, EXPCMDFLAGS *flags) {
    (void)This;
    if (!flags) return E_POINTER;
    *flags = ECF_DEFAULT;
    return S_OK;
}

static HRESULT STDMETHODCALLTYPE Command_EnumSubCommands(IExplorerCommand *This, IEnumExplorerCommand **commands) {
    (void)This;
    if (!commands) return E_POINTER;
    *commands = NULL;
    return E_NOTIMPL;
}

static const IExplorerCommandVtbl kCommandVtbl = {
    Command_QueryInterface, Command_AddRef,          Command_Release, Command_GetTitle, Command_GetIcon,
    Command_GetToolTip,     Command_GetCanonicalName, Command_GetState, Command_Invoke,  Command_GetFlags,
    Command_EnumSubCommands,
};

static HRESULT STDMETHODCALLTYPE Factory_QueryInterface(IClassFactory *This, REFIID riid, void **ppv) {
    if (!ppv) return E_POINTER;
    if (IsEqualIID(riid, &IID_IUnknown) || IsEqualIID(riid, &IID_IClassFactory)) {
        *ppv = This;
        IClassFactory_AddRef(This);
        return S_OK;
    }
    *ppv = NULL;
    return E_NOINTERFACE;
}

static ULONG STDMETHODCALLTYPE Factory_AddRef(IClassFactory *This) {
    Factory *self = (Factory *)This;
    return (ULONG)InterlockedIncrement(&self->refs);
}

static ULONG STDMETHODCALLTYPE Factory_Release(IClassFactory *This) {
    Factory *self = (Factory *)This;
    LONG left = InterlockedDecrement(&self->refs);
    if (left == 0) free(self);
    return (ULONG)left;
}

static HRESULT STDMETHODCALLTYPE Factory_CreateInstance(IClassFactory *This, IUnknown *outer, REFIID riid, void **ppv) {
    Command *cmd;
    HRESULT hr;
    (void)This;
    if (outer) return CLASS_E_NOAGGREGATION;
    cmd = (Command *)calloc(1, sizeof(*cmd));
    if (!cmd) return E_OUTOFMEMORY;
    cmd->lpVtbl = (IExplorerCommandVtbl *)&kCommandVtbl;
    cmd->refs = 1;
    hr = IExplorerCommand_QueryInterface((IExplorerCommand *)cmd, riid, ppv);
    IExplorerCommand_Release((IExplorerCommand *)cmd);
    return hr;
}

static HRESULT STDMETHODCALLTYPE Factory_LockServer(IClassFactory *This, BOOL lock) {
    (void)This;
    (void)lock;
    return S_OK;
}

static const IClassFactoryVtbl kFactoryVtbl = {
    Factory_QueryInterface, Factory_AddRef, Factory_Release, Factory_CreateInstance, Factory_LockServer,
};

STDAPI DllGetClassObject(REFCLSID rclsid, REFIID riid, void **ppv) {
    Factory *factory;
    HRESULT hr;
    if (!ppv) return E_POINTER;
    *ppv = NULL;
    if (!IsEqualGUID(rclsid, &CLSID_TermPilotCommand)) return CLASS_E_CLASSNOTAVAILABLE;
    factory = (Factory *)calloc(1, sizeof(*factory));
    if (!factory) return E_OUTOFMEMORY;
    factory->lpVtbl = (IClassFactoryVtbl *)&kFactoryVtbl;
    factory->refs = 1;
    hr = IClassFactory_QueryInterface((IClassFactory *)factory, riid, ppv);
    IClassFactory_Release((IClassFactory *)factory);
    return hr;
}

STDAPI DllCanUnloadNow(void) { return S_FALSE; }
