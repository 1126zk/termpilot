//go:build !windows

package sshx

import (
	"net"
	"os"
	"time"
)

func dialAuthAgent() (net.Conn, error) {
	sock := os.Getenv("SSH_AUTH_SOCK")
	if sock == "" {
		return nil, os.ErrNotExist
	}
	return net.DialTimeout("unix", sock, 2*time.Second)
}
