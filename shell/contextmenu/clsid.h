#pragma once

#include <windows.h>

/* 右键命令的 CLSID，必须和 AppxManifest.xml 里的 Verb Clsid 一致。 */
static const GUID CLSID_TermPilotCommand = {
    0x6462009c, 0x09ad, 0x4372, {0x83, 0xd0, 0x48, 0xef, 0x02, 0xe7, 0xf6, 0x35}};
