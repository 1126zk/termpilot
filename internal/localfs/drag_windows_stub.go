//go:build windows && !amd64

package localfs

import "errors"

func dragMoveNative(_ []string) error {
	return errors.New("拖出窗口只支持 64 位 Windows")
}
