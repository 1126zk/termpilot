//go:build !windows

package app

import _ "embed"

//go:embed resources/cli/termpilot
var cliEXE []byte
