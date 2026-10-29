//go:build !windows

package localfs

import "errors"

func (s *Service) ResolveWSL(string) (string, error) {
	return "", errors.New("WSL 文件面板仅支持 Windows")
}
