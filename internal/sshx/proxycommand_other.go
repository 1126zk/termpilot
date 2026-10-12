//go:build !windows

package sshx

import "os/exec"

func hideWindow(*exec.Cmd) {}
