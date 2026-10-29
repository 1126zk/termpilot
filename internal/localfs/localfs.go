// Package localfs 是本机文件面板的 Go 移植，语义逐条对应 Electron 版
// src/main/services/LocalFsService.ts。与原版一样只做纯文件系统操作：
// 「上传/下载」的系统对话框由上层（Wails runtime）弹出，本包只提供
// 把本地路径复制/移动进目标目录、复制到指定目标的原语。
//
// 路径边界统一正斜杠（Windows 形如 C:/Users/...）：入参接受反斜杠，
// 出参（List 的 Path 与各条目的 Path）一律正斜杠。进文件系统前经
// ToNative 转成 native 绝对路径。
package localfs

import (
	"encoding/base64"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"termpilot/internal/sftpx"
)

// Service 本机文件操作。无状态，方法可直接挂 Wails 桥接层。
type Service struct{}

// New 对应 TS new LocalFsService()。
func New() *Service { return &Service{} }

// ListResult 对应 TS list 的返回值 { path, entries }。
type ListResult struct {
	Path    string             `json:"path"`
	Entries []sftpx.RemoteFile `json:"entries"`
}

// ToNative 对应 TS toNative："" 或 "." 解析为用户主目录；接受正/反斜杠
// 输入；返回 native 绝对路径（resolve 语义：相对路径按进程工作目录展开）。
func (s *Service) ToNative(p string) (string, error) {
	raw := p
	if raw == "" || raw == "." {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		raw = home
	}
	if mounted, ok := wslUNCMountedDrive(strings.ReplaceAll(raw, `\`, "/")); ok {
		raw = mounted
	}
	return filepath.Abs(nativeSlashes(raw))
}

// ToPosix 对应 TS toPosix：反斜杠一律改正斜杠。
func (s *Service) ToPosix(p string) string {
	return strings.ReplaceAll(p, "\\", "/")
}

// nativeSlashes 只做斜杠转换，不做主目录/绝对路径解析。
// 用于对话框返回的 native 路径等已经是完整路径的输入。
func nativeSlashes(p string) string {
	if os.PathSeparator == '\\' {
		return strings.ReplaceAll(p, "/", "\\")
	}
	return p
}

// List 对应 TS list：读目录，目录在前、同级按名字排；
// 没权限 lstat 的条目保留名字，大小时间按 0。
func (s *Service) List(dir string) (ListResult, error) {
	target, err := s.ToNative(dir)
	if err != nil {
		return ListResult{}, err
	}
	dirents, err := os.ReadDir(target)
	if err != nil {
		return ListResult{}, err
	}
	entries := make([]sftpx.RemoteFile, 0, len(dirents))
	for _, item := range dirents {
		full := filepath.Join(target, item.Name())
		kind := sftpx.KindFile
		switch {
		case item.IsDir():
			kind = sftpx.KindDir
		case item.Type()&fs.ModeSymlink != 0:
			kind = sftpx.KindLink
		}
		var size, mtime int64
		if info, statErr := os.Lstat(full); statErr == nil {
			size = info.Size()
			mtime = info.ModTime().UnixMilli()
		}
		entries = append(entries, sftpx.RemoteFile{
			Name:  item.Name(),
			Path:  s.ToPosix(full),
			Kind:  kind,
			Size:  size,
			Mtime: mtime,
		})
	}
	slices.SortStableFunc(entries, sftpx.CompareRemoteFiles)
	return ListResult{Path: s.ToPosix(target), Entries: entries}, nil
}

// Mkdir 对应 TS mkdir：在 dir 下新建 name，父目录必须已存在（不递归）。
func (s *Service) Mkdir(dir, name string) error {
	target, err := s.ToNative(dir)
	if err != nil {
		return err
	}
	return os.Mkdir(filepath.Join(target, name), 0o755)
}

// Remove 对应 TS remove：kind 为 dir 时递归删除，否则删单个文件/链接。
// 目录在删之前先 lstat，路径不存在时与原版 rm({recursive:true}) 一样报错。
func (s *Service) Remove(path string, kind sftpx.FileKind) error {
	target, err := s.ToNative(path)
	if err != nil {
		return err
	}
	if kind == sftpx.KindDir {
		if _, err := os.Lstat(target); err != nil {
			return err
		}
		return os.RemoveAll(target)
	}
	return os.Remove(target)
}

// Rename 对应 TS rename。
func (s *Service) Rename(from, to string) error {
	src, err := s.ToNative(from)
	if err != nil {
		return err
	}
	dst, err := s.ToNative(to)
	if err != nil {
		return err
	}
	return os.Rename(src, dst)
}

// ReadText 对应 TS readText：先按 20MB 上限挡，读出后按 NUL 字节判二进制。
func (s *Service) ReadText(path string) (string, error) {
	target, err := s.ToNative(path)
	if err != nil {
		return "", err
	}
	info, err := os.Lstat(target)
	if err != nil {
		return "", err
	}
	if err := sftpx.AssertEditSize(info.Size()); err != nil {
		return "", err
	}
	buf, err := os.ReadFile(target)
	if err != nil {
		return "", err
	}
	if err := sftpx.AssertTextBuffer(buf); err != nil {
		return "", err
	}
	return string(buf), nil
}

// ReadImage 读出整张图片，base64 编码后交给界面预览。
func (s *Service) ReadImage(path string) (string, error) {
	target, err := s.ToNative(path)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(target)
	if err != nil {
		return "", err
	}
	if err := sftpx.AssertImageSize(info.Size()); err != nil {
		return "", err
	}
	buf, err := os.ReadFile(target)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(buf), nil
}

// WriteText 对应 TS writeText：整文件覆盖写 UTF-8 文本。
func (s *Service) WriteText(path, text string) error {
	target, err := s.ToNative(path)
	if err != nil {
		return err
	}
	return os.WriteFile(target, []byte(text), 0o644)
}
