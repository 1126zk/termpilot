package localfs

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
)

// 复制/移动原语。对应 TS 的 uploadPaths / uploadDir / download / downloadDir
// 里对话框之后的文件操作；对话框本身由上层（Wails runtime）弹出后把路径传进来。

// UploadPaths 对应 TS uploadPaths：把本地文件/目录按名字复制进 dir，
// 目录递归复制。路径失效的源跳过；返回成功复制的个数。
func (s *Service) UploadPaths(dir string, localPaths []string) (int, error) {
	return s.copyInto(dir, localPaths)
}

// MoveInto 把本地文件/目录按名字移动进 dir。同盘直接 rename；
// 跨盘回退「复制后删除源」。路径失效的源跳过；返回成功移动的个数。
func (s *Service) MoveInto(dir string, localPaths []string) (int, error) {
	target, err := s.ToNative(dir)
	if err != nil {
		return 0, err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return 0, err
	}
	homeAbs, err := filepath.Abs(home)
	if err != nil {
		return 0, err
	}
	items := collectItems(localPaths)
	for _, item := range items {
		if err := refuseBroadMove(item.path, homeAbs); err != nil {
			return 0, err
		}
	}
	done := 0
	for _, item := range items {
		dst := filepath.Join(target, filepath.Base(item.path))
		if err := os.Rename(item.path, dst); err != nil {
			sameVolume := filepath.VolumeName(item.path) == filepath.VolumeName(target)
			if sameVolume && !errors.Is(err, syscall.EXDEV) {
				return done, err
			}
			if err := copyAny(item.path, dst, item.isDir); err != nil {
				return done, err
			}
			if err := removeAny(item.path, item.isDir); err != nil {
				return done, err
			}
		}
		done++
	}
	return done, nil
}

// CopyTo 对应原版 download/downloadDir 的复制动作：把 src（文件或目录，
// 目录递归）复制到完整目标路径 dst。src 走正斜杠边界归一，dst 是上层
// 对话框给出的路径，只做斜杠转换。
func (s *Service) CopyTo(src, dst string) error {
	srcNative, err := s.ToNative(src)
	if err != nil {
		return err
	}
	dstNative := nativeSlashes(dst)
	info, err := os.Lstat(srcNative)
	if err != nil {
		return err
	}
	return copyAny(srcNative, dstNative, info.IsDir())
}

// copyInto 对应 TS uploadPaths 的主体。
func (s *Service) copyInto(dir string, localPaths []string) (int, error) {
	target, err := s.ToNative(dir)
	if err != nil {
		return 0, err
	}
	done := 0
	for _, item := range collectItems(localPaths) {
		dst := filepath.Join(target, filepath.Base(item.path))
		if err := copyAny(item.path, dst, item.isDir); err != nil {
			return done, err
		}
		done++
	}
	return done, nil
}

type pathItem struct {
	path  string
	isDir bool
}

// collectItems 对应 TS uploadPaths 的过滤段：lstat 失败的跳过，
// 只留普通文件和目录。
func collectItems(paths []string) []pathItem {
	var items []pathItem
	for _, p := range paths {
		native := nativeSlashes(p)
		info, err := os.Lstat(native)
		if err != nil {
			continue
		}
		if info.IsDir() || info.Mode().IsRegular() {
			items = append(items, pathItem{path: native, isDir: info.IsDir()})
		}
	}
	return items
}

func copyAny(src, dst string, isDir bool) error {
	if isDir {
		return copyTree(src, dst)
	}
	return copyFile(src, dst)
}

func removeAny(path string, isDir bool) error {
	if isDir {
		return os.RemoveAll(path)
	}
	return os.Remove(path)
}

// copyFile 对应 TS copyFile。
func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	info, err := in.Stat()
	if err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, info.Mode().Perm())
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// copyTree 对应 TS cp(src, dst, {recursive:true})：递归复制目录树，
// 保留各文件的权限位；符号链接按链接重建，非常规文件（管道、套接字等）跳过。
func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(p string, de fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		switch {
		case de.IsDir():
			return os.MkdirAll(target, 0o755)
		case de.Type()&fs.ModeSymlink != 0:
			link, err := os.Readlink(p)
			if err != nil {
				return err
			}
			return os.Symlink(link, target)
		case de.Type().IsRegular():
			return copyFile(p, target)
		default:
			return nil
		}
	})
}
