package sftpx

import (
	"encoding/base64"
	"errors"
	"io"
	"os"
	"slices"
	"time"

	"github.com/pkg/sftp"
)

// 目录/文件操作与远程文本读写，对应 TS SftpService 的 list/mkdir/rename/remove/
// readText/writeText 及其文件级辅助函数。

// List 对应 TS list：realpath 没有自己的超时，10 秒没响应按原路径交给 readdir 的 20 秒兜底。
// 返回规范化后的路径与排序后的目录项。
func (s *Service) List(sessionID, dir string) (string, []RemoteFile, error) {
	requested := normalizeRemotePath(dir)
	if requested == "" {
		requested = "."
	}
	var path string
	entries := []RemoteFile{}
	err := s.run(sessionID, func(conn *liveConn) error {
		return conn.using(requested, func(target string) error {
			resolved, err := withTimeout(func() (string, error) { return conn.client.RealPath(target) },
				10*time.Second, "SFTP 没有响应")
			if err != nil || resolved == "" {
				resolved = target
			}
			list, err := withTimeout(func() ([]RemoteFile, error) { return readdir(conn.client, resolved) },
				20*time.Second, "读取目录超时")
			if err != nil {
				return err
			}
			path, entries = resolved, list
			return nil
		})
	})
	if err != nil {
		return "", nil, err
	}
	return path, entries, nil
}

// Mkdir 对应 TS mkdir：在 dir 下建 name。
func (s *Service) Mkdir(sessionID, dir, name string) error {
	target := remoteJoin(dirOrDot(normalizeRemotePath(dir)), name)
	return s.run(sessionID, func(conn *liveConn) error {
		return conn.using(target, conn.client.Mkdir)
	})
}

// MkdirPath 对应 TS mkdirPath。
func (s *Service) MkdirPath(sessionID, path string) error {
	return s.run(sessionID, func(conn *liveConn) error {
		return conn.using(normalizeRemotePath(path), conn.client.Mkdir)
	})
}

// Rename 对应 TS rename：noSuchFile 时回退到相对登录目录的写法再试一次。
func (s *Service) Rename(sessionID, from, to string) error {
	from = normalizeRemotePath(from)
	to = normalizeRemotePath(to)
	return s.run(sessionID, func(conn *liveConn) error {
		err := conn.client.Rename(from, to)
		if err == nil {
			return nil
		}
		nextFrom, nextTo := from, to
		if alt := loginRelativePath(conn.loginDir(), from); alt != "" {
			nextFrom = alt
		}
		if alt := loginRelativePath(conn.loginDir(), to); alt != "" {
			nextTo = alt
		}
		if !noSuchFile(err) || (nextFrom == from && nextTo == to) {
			return err
		}
		return conn.client.Rename(nextFrom, nextTo)
	})
}

// Remove 对应 TS remove：目录整棵递归删，其余 unlink。
func (s *Service) Remove(sessionID, path string, kind FileKind) error {
	return s.run(sessionID, func(conn *liveConn) error {
		return conn.using(normalizeRemotePath(path), func(target string) error {
			if kind == KindDir {
				return removeDir(conn, target, 0)
			}
			return conn.client.Remove(target)
		})
	})
}

// ReadText 对应 TS readText：20MB 上限，读出后按 NUL 字节判二进制。
func (s *Service) ReadText(sessionID, path string) (string, error) {
	var text string
	err := s.run(sessionID, func(conn *liveConn) error {
		return conn.using(normalizeRemotePath(path), func(target string) error {
			data, err := readTextAt(conn.client, target)
			if err != nil {
				return err
			}
			text = data
			return nil
		})
	})
	if err != nil {
		return "", err
	}
	return text, nil
}

// ReadImage 读出整张图片，base64 编码后交给界面预览。
func (s *Service) ReadImage(sessionID, path string) (string, error) {
	var encoded string
	err := s.run(sessionID, func(conn *liveConn) error {
		return conn.using(normalizeRemotePath(path), func(target string) error {
			size, err := statSize(conn.client, target)
			if err != nil {
				return err
			}
			if err := AssertImageSize(size); err != nil {
				return err
			}
			buf, err := readAll(conn.client, target)
			if err != nil {
				return err
			}
			encoded = base64.StdEncoding.EncodeToString(buf)
			return nil
		})
	})
	if err != nil {
		return "", err
	}
	return encoded, nil
}

// WriteText 对应 TS writeText：UTF-8 整写。
func (s *Service) WriteText(sessionID, path, text string) error {
	return s.run(sessionID, func(conn *liveConn) error {
		return conn.using(normalizeRemotePath(path), func(target string) error {
			return writeAll(conn.client, target, []byte(text))
		})
	})
}

// readdir 对应 TS readdir：滤掉 . 和 ..，按 compareRemoteFiles 排序。
func readdir(client *sftp.Client, dir string) ([]RemoteFile, error) {
	infos, err := client.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	entries := make([]RemoteFile, 0, len(infos))
	for _, info := range infos {
		name := info.Name()
		if name == "." || name == ".." {
			continue
		}
		mode := info.Mode()
		kind := KindFile
		if mode.IsDir() {
			kind = KindDir
		} else if mode&os.ModeSymlink != 0 {
			kind = KindLink
		}
		entries = append(entries, RemoteFile{
			Name:  name,
			Path:  remoteJoin(dir, name),
			Kind:  kind,
			Size:  info.Size(),
			Mtime: info.ModTime().UnixMilli(),
		})
	}
	slices.SortStableFunc(entries, CompareRemoteFiles)
	return entries, nil
}

// removeDir 对应 TS removeDir：层级超过 32 拒绝，读目录失败按空目录处理。
func removeDir(conn *liveConn, path string, depth int) error {
	if depth > 32 {
		return errors.New("目录层级过深")
	}
	entries, err := readdir(conn.client, path)
	if err != nil {
		entries = nil
	}
	for _, item := range entries {
		if item.Kind == KindDir {
			if err := removeDir(conn, item.Path, depth+1); err != nil {
				return err
			}
			continue
		}
		if err := conn.using(item.Path, conn.client.Remove); err != nil {
			return err
		}
	}
	return conn.client.RemoveDirectory(path)
}

// statSize 对应 TS statSize。
func statSize(client *sftp.Client, path string) (int64, error) {
	info, err := client.Stat(path)
	if err != nil {
		return 0, err
	}
	return info.Size(), nil
}

// readTextAt 对应 TS readTextAt。
func readTextAt(client *sftp.Client, path string) (string, error) {
	size, err := statSize(client, path)
	if err != nil {
		return "", err
	}
	if err := AssertEditSize(size); err != nil {
		return "", err
	}
	buf, err := readAll(client, path)
	if err != nil {
		return "", err
	}
	if err := AssertTextBuffer(buf); err != nil {
		return "", err
	}
	return string(buf), nil
}

// readAll 对应 TS readAll（TS 手动 32KB 分块读，这里 io.ReadAll 等价）。
func readAll(client *sftp.Client, path string) ([]byte, error) {
	file, err := client.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = file.Close() }()
	return io.ReadAll(file)
}

// writeAll 对应 TS writeAll：32KB 分块写；写失败时关句柄后抛，关失败也算失败。
func writeAll(client *sftp.Client, path string, data []byte) error {
	file, err := client.Create(path)
	if err != nil {
		return err
	}
	for pos := 0; pos < len(data); pos += chunkSize {
		end := pos + chunkSize
		if end > len(data) {
			end = len(data)
		}
		if _, err := file.Write(data[pos:end]); err != nil {
			_ = file.Close()
			return err
		}
	}
	return file.Close()
}
