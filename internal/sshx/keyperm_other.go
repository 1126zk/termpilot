//go:build !windows

package sshx

import "os"

func restrictPrivateKey(path string) error {
	return os.Chmod(path, 0o600)
}
