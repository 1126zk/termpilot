//go:build windows && amd64

package terminal

import _ "embed"

//go:embed resources/conpty/win-x64/conpty.dll
var bundledConptyDLL []byte

//go:embed resources/conpty/win-x64/OpenConsole.exe
var bundledOpenConsole []byte
