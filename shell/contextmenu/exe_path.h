#pragma once

#include <shlwapi.h>
#include <stdio.h>
#include <string.h>

/* 主程序每次启动把 exe 绝对路径写成 DLL 旁边的 exe.path（UTF-8）。
   菜单进程不靠注册表，避免包身份把 HKCU 虚拟化掉。 */
static int termpilotExePath(wchar_t *out, DWORD cch) {
    HMODULE module = NULL;
    wchar_t self[32768];
    wchar_t file[32768];
    HANDLE handle;
    char buf[32768];
    DWORD read = 0;
    const char *start;
    size_t len;
    int wide;

    if (!out || cch < 2) return 0;
    out[0] = 0;
    if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                                GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                            (LPCWSTR)(void *)&termpilotExePath, &module)) {
        return 0;
    }
    if (GetModuleFileNameW(module, self, 32768) == 0) return 0;
    if (!PathRemoveFileSpecW(self)) return 0;
    if (!PathCombineW(file, self, L"exe.path")) return 0;

    handle = CreateFileW(file, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL,
                         OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (handle == INVALID_HANDLE_VALUE) return 0;
    if (!ReadFile(handle, buf, sizeof(buf) - 1, &read, NULL)) {
        CloseHandle(handle);
        return 0;
    }
    CloseHandle(handle);
    if (read == 0) return 0;
    buf[read] = 0;
    start = buf;
    if (read >= 3 && (unsigned char)buf[0] == 0xEF && (unsigned char)buf[1] == 0xBB &&
        (unsigned char)buf[2] == 0xBF) {
        start = buf + 3;
    }
    len = strlen(start);
    while (len > 0 && (start[len - 1] == '\n' || start[len - 1] == '\r' || start[len - 1] == ' ' ||
                       start[len - 1] == '\t')) {
        len--;
    }
    if (len == 0) return 0;
    wide = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, start, (int)len, out, (int)cch - 1);
    if (wide <= 0) return 0;
    out[wide] = 0;
    return GetFileAttributesW(out) != INVALID_FILE_ATTRIBUTES;
}
