//go:build windows && arm64

package terminal

import _ "embed"

//go:embed resources/conpty/win-arm64/conpty.dll
var bundledConptyDLL []byte

//go:embed resources/conpty/win-arm64/OpenConsole.exe
var bundledOpenConsole []byte
