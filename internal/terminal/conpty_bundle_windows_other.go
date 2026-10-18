//go:build windows && !amd64 && !arm64

package terminal

var bundledConptyDLL []byte
var bundledOpenConsole []byte
