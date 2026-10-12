//go:build windows

package main

import _ "embed"

//go:embed resources/cli/termpilot.exe
var cliEXE []byte
