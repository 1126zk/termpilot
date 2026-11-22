package localfs

import (
	"archive/tar"
	"compress/gzip"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// Archive 把目录打成旁边的同名 .tar.gz。已有同名压缩包时不覆盖。
func (s *Service) Archive(dir string) error {
	target, err := s.ToNative(dir)
	if err != nil {
		return err
	}
	info, err := os.Lstat(target)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return errors.New("只能压缩文件夹")
	}
	name := filepath.Base(target)
	if name == "" || name == "." || name == ".." {
		return errors.New("这个目录不能压缩")
	}
	dest := filepath.Join(filepath.Dir(target), name+".tar.gz")
	out, err := os.OpenFile(dest, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		if os.IsExist(err) {
			return errors.New("压缩包已存在")
		}
		return err
	}
	ok := false
	defer func() {
		_ = out.Close()
		if !ok {
			_ = os.Remove(dest)
		}
	}()

	gz := gzip.NewWriter(out)
	tw := tar.NewWriter(gz)
	parent := filepath.Dir(target)
	err = filepath.WalkDir(target, func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(parent, p)
		if err != nil {
			return err
		}
		fi, err := d.Info()
		if err != nil {
			return err
		}
		link := ""
		if fi.Mode()&os.ModeSymlink != 0 {
			link, err = os.Readlink(p)
			if err != nil {
				return err
			}
		}
		header, err := tar.FileInfoHeader(fi, link)
		if err != nil {
			return err
		}
		header.Name = filepath.ToSlash(rel)
		if d.IsDir() && !strings.HasSuffix(header.Name, "/") {
			header.Name += "/"
		}
		if err := tw.WriteHeader(header); err != nil {
			return err
		}
		if !fi.Mode().IsRegular() {
			return nil
		}
		file, err := os.Open(p)
		if err != nil {
			return err
		}
		_, err = io.Copy(tw, file)
		_ = file.Close()
		return err
	})
	if err != nil {
		return err
	}
	if err := tw.Close(); err != nil {
		return err
	}
	if err := gz.Close(); err != nil {
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	ok = true
	return nil
}
