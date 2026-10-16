/* 构建时加载 DLL，确认类工厂和菜单标题可用。 */

#define COBJMACROS
#include "clsid.h"

#include <objbase.h>
#include <shobjidl.h>
#include <stdio.h>
#include <string.h>

int main(void) {
    HMODULE dll;
    HRESULT(STDAPICALLTYPE * getClass)(REFCLSID, REFIID, void **);
    IClassFactory *factory = NULL;
    IExplorerCommand *command = NULL;
    LPWSTR title = NULL;
    HRESULT hr;
    const wchar_t *expect = L"\u5728 TermPilot \u4E2D\u6253\u5F00";

    hr = CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
    if (FAILED(hr)) {
        printf("CoInitializeEx %08lx\n", (unsigned long)hr);
        return 1;
    }
    dll = LoadLibraryW(L"TermPilotContextMenu.dll");
    if (!dll) {
        printf("LoadLibrary %lu\n", GetLastError());
        return 1;
    }
    {
        FARPROC proc = GetProcAddress(dll, "DllGetClassObject");
        memcpy(&getClass, &proc, sizeof(getClass));
    }
    if (!getClass) {
        printf("no DllGetClassObject\n");
        return 1;
    }
    hr = getClass(&CLSID_TermPilotCommand, &IID_IClassFactory, (void **)&factory);
    if (FAILED(hr) || !factory) {
        printf("DllGetClassObject %08lx\n", (unsigned long)hr);
        return 1;
    }
    hr = IClassFactory_CreateInstance(factory, NULL, &IID_IExplorerCommand, (void **)&command);
    IClassFactory_Release(factory);
    if (FAILED(hr) || !command) {
        printf("CreateInstance %08lx\n", (unsigned long)hr);
        return 1;
    }
    hr = IExplorerCommand_GetTitle(command, NULL, &title);
    if (FAILED(hr) || !title || wcscmp(title, expect) != 0) {
        printf("GetTitle %08lx\n", (unsigned long)hr);
        IExplorerCommand_Release(command);
        return 1;
    }
    CoTaskMemFree(title);
    hr = IExplorerCommand_Invoke(command, NULL, NULL);
    IExplorerCommand_Release(command);
    if (hr != E_FAIL && hr != E_INVALIDARG) {
        printf("Invoke(NULL) %08lx\n", (unsigned long)hr);
        return 1;
    }
    printf("ok\n");
    return 0;
}
