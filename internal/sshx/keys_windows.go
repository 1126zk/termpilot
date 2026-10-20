//go:build windows

package sshx

import (
	"net"
	"os"
	"time"

	"golang.org/x/sys/windows"
)

func dialAuthAgent() (net.Conn, error) {
	if sock := os.Getenv("SSH_AUTH_SOCK"); sock != "" {
		if conn, err := net.DialTimeout("unix", sock, 2*time.Second); err == nil {
			return conn, nil
		}
	}
	path, err := windows.UTF16PtrFromString(`\\.\pipe\openssh-ssh-agent`)
	if err != nil {
		return nil, err
	}
	handle, err := windows.CreateFile(
		path,
		windows.GENERIC_READ|windows.GENERIC_WRITE,
		0,
		nil,
		windows.OPEN_EXISTING,
		windows.FILE_ATTRIBUTE_NORMAL,
		0,
	)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(handle), "ssh-agent")
	if file == nil {
		_ = windows.CloseHandle(handle)
		return nil, os.ErrInvalid
	}
	return agentConn{file}, nil
}
