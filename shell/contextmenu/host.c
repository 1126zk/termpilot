/* 稀疏包要求清单里有一个 exe。菜单点击不走这里，走 command.c。
   万一系统把这个宿主拉起来，就按 exe.path 转去打开真正的 TermPilot。 */

#include "exe_path.h"

int WINAPI wWinMain(HINSTANCE inst, HINSTANCE prev, LPWSTR cmd, int show) {
    wchar_t exe[32768];
    wchar_t self[32768];
    (void)inst;
    (void)prev;
    (void)cmd;
    (void)show;
    if (!termpilotExePath(exe, 32768)) return 0;
    if (GetModuleFileNameW(NULL, self, 32768) > 0 &&
        CompareStringOrdinal(self, -1, exe, -1, TRUE) == CSTR_EQUAL) {
        return 0;
    }
    ShellExecuteW(NULL, L"open", exe, NULL, NULL, SW_SHOWNORMAL);
    return 0;
}
