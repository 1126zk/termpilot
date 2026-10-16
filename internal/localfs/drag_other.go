//go:build !windows

package localfs

import "errors"

func dragMoveNative(_ []string) error {
	return errors.New("只有 Windows 可以把文件拖出窗口")
}
