package localfs

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// DragMove 把本机文件或目录交给系统拖放。调用期间鼠标按着，
// 松手后由系统或窗口内的落点完成移动；这里不删除源文件。
func (s *Service) DragMove(paths []string) error {
	native, err := s.prepareDragPaths(paths)
	if err != nil {
		return err
	}
	return dragMoveNative(native)
}

// prepareDragPaths 把边界路径收成可拖出的 native 绝对路径。
// 家目录和磁盘根目录直接拒绝，避免一次拖走整个用户目录。
func (s *Service) prepareDragPaths(paths []string) ([]string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	homeAbs, err := filepath.Abs(home)
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(paths))
	for _, p := range paths {
		native, err := s.ToNative(p)
		if err != nil {
			return nil, err
		}
		if err := refuseBroadMove(native, homeAbs); err != nil {
			return nil, err
		}
		info, err := os.Lstat(native)
		if err != nil {
			continue
		}
		mode := info.Mode()
		if info.IsDir() || mode.IsRegular() || mode&os.ModeSymlink != 0 {
			out = append(out, native)
		}
	}
	if len(out) == 0 {
		return nil, errors.New("没有可以移动的文件")
	}
	return out, nil
}

func refuseBroadMove(native, homeAbs string) error {
	if samePath(native, homeAbs) {
		return errors.New("不能移动家目录")
	}
	if filepath.Dir(native) == native {
		return errors.New("不能移动磁盘根目录")
	}
	return nil
}

func samePath(a, b string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}
