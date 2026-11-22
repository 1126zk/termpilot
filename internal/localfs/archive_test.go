package localfs

import (
	"archive/tar"
	"compress/gzip"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestArchiveWritesSiblingTarGz(t *testing.T) {
	svc := New()
	tmp := t.TempDir()
	dir := filepath.Join(tmp, "box")
	if err := os.MkdirAll(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(dir, "sub", "a.txt"), "hello")

	posix := strings.ReplaceAll(dir, "\\", "/")
	if err := svc.Archive(posix); err != nil {
		t.Fatal(err)
	}
	if err := svc.Archive(posix); err == nil || !strings.Contains(err.Error(), "已存在") {
		t.Fatalf("第二次应拒绝覆盖: %v", err)
	}

	f, err := os.Open(filepath.Join(tmp, "box.tar.gz"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	found := false
	for {
		h, err := tr.Next()
		if err != nil {
			break
		}
		if h.Name == "box/sub/a.txt" {
			found = true
		}
	}
	if !found {
		t.Fatal("压缩包里没有 box/sub/a.txt")
	}
}
