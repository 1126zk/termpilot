package localfs

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"termpilot/app/internal/sftpx"
)

// posixTmp 返回正斜杠形式的临时目录路径，作为传给 Service 的边界输入。
func posixTmp(t *testing.T) string {
	t.Helper()
	return strings.ReplaceAll(t.TempDir(), "\\", "/")
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestListSortsAndNormalizes(t *testing.T) {
	svc := New()
	tmp := t.TempDir()
	posix := strings.ReplaceAll(tmp, "\\", "/")

	for _, dir := range []string{"zdir", "adir"} {
		if err := os.Mkdir(filepath.Join(tmp, dir), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	writeFile(t, filepath.Join(tmp, "b.txt"), "b")
	writeFile(t, filepath.Join(tmp, "a.txt"), "aa")

	res, err := svc.List(posix)
	if err != nil {
		t.Fatal(err)
	}

	// 返回路径一律正斜杠，无反斜杠残留
	if res.Path != posix {
		t.Fatalf("path = %q, want %q", res.Path, posix)
	}
	// 目录在前，同级按名字排
	wantOrder := []struct {
		name string
		kind sftpx.FileKind
	}{
		{"adir", sftpx.KindDir},
		{"zdir", sftpx.KindDir},
		{"a.txt", sftpx.KindFile},
		{"b.txt", sftpx.KindFile},
	}
	if len(res.Entries) != len(wantOrder) {
		t.Fatalf("entries = %d, want %d", len(res.Entries), len(wantOrder))
	}
	for i, want := range wantOrder {
		got := res.Entries[i]
		if got.Name != want.name || got.Kind != want.kind {
			t.Fatalf("entries[%d] = %v (%v), want %v (%v)", i, got.Name, got.Kind, want.name, want.kind)
		}
		if strings.ContainsRune(got.Path, '\\') {
			t.Fatalf("entry path 含反斜杠: %q", got.Path)
		}
		if got.Path != posix+"/"+got.Name {
			t.Fatalf("entry path = %q", got.Path)
		}
	}
	// a.txt 写了两个字节
	if res.Entries[2].Size != 2 {
		t.Fatalf("a.txt size = %d, want 2", res.Entries[2].Size)
	}
	if res.Entries[2].Mtime <= 0 {
		t.Fatalf("a.txt mtime = %d, want > 0", res.Entries[2].Mtime)
	}
}

func TestListEmptyDirMeansHome(t *testing.T) {
	svc := New()
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("no home dir")
	}
	want := strings.ReplaceAll(home, "\\", "/")
	for _, input := range []string{"", "."} {
		res, err := svc.List(input)
		if err != nil {
			t.Fatalf("List(%q): %v", input, err)
		}
		if res.Path != want {
			t.Fatalf("List(%q).Path = %q, want %q", input, res.Path, want)
		}
	}
}

func TestPathNormalization(t *testing.T) {
	svc := New()
	if runtime.GOOS != "windows" {
		t.Skip("盘符语义只在 Windows 上验证")
	}
	a, err := svc.ToNative(`C:\foo\bar`)
	if err != nil {
		t.Fatal(err)
	}
	b, err := svc.ToNative("C:/foo/bar")
	if err != nil {
		t.Fatal(err)
	}
	if a != b {
		t.Fatalf(`ToNative("C:\foo\bar")=%q, ToNative("C:/foo/bar")=%q`, a, b)
	}
	if got := svc.ToPosix(a); strings.ContainsRune(got, '\\') {
		t.Fatalf("ToPosix 残留反斜杠: %q", got)
	}
	// 盘符根归一为 C:/ 形式
	root, err := svc.ToNative("C:/")
	if err != nil {
		t.Fatal(err)
	}
	if got := svc.ToPosix(root); got != "C:/" {
		t.Fatalf(`盘符根 = %q, want "C:/"`, got)
	}
}

func TestListVolumeRoot(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("盘符根列表只在 Windows 上验证")
	}
	svc := New()
	vol := filepath.VolumeName(t.TempDir()) // 形如 C:
	res, err := svc.List(vol + `\`)
	if err != nil {
		t.Skipf("列盘符根失败（权限等）: %v", err)
	}
	if res.Path != vol+"/" {
		t.Fatalf("盘符根 Path = %q, want %q", res.Path, vol+"/")
	}
	for _, e := range res.Entries {
		if strings.ContainsRune(e.Path, '\\') {
			t.Fatalf("盘符根下条目含反斜杠: %q", e.Path)
		}
		if !strings.HasPrefix(e.Path, vol+"/") {
			t.Fatalf("条目 %q 不在盘符根前缀下", e.Path)
		}
	}
}

func TestMkdirRenameRemove(t *testing.T) {
	svc := New()
	posix := posixTmp(t)
	native := filepath.FromSlash(posix)

	if err := svc.Mkdir(posix, "sub"); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(filepath.Join(native, "sub")); err != nil || !info.IsDir() {
		t.Fatalf("mkdir 后 sub 不存在: %v", err)
	}

	writeFile(t, filepath.Join(native, "old.txt"), "x")
	if err := svc.Rename(posix+"/old.txt", posix+"/new.txt"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(native, "new.txt")); err != nil {
		t.Fatalf("rename 后 new.txt 不存在: %v", err)
	}

	// 目录递归删
	writeFile(t, filepath.Join(native, "sub", "deep.txt"), "deep")
	if err := svc.Mkdir(posix+"/sub", "inner"); err != nil {
		t.Fatal(err)
	}
	if err := svc.Remove(posix+"/sub", sftpx.KindDir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(native, "sub")); !os.IsNotExist(err) {
		t.Fatalf("递归删除后 sub 仍存在: %v", err)
	}
	// 删不存在的目录要报错（对应原版 rm 无 force）
	if err := svc.Remove(posix+"/sub", sftpx.KindDir); err == nil {
		t.Fatal("删不存在的目录应报错")
	}

	// 文件单删
	if err := svc.Remove(posix+"/new.txt", sftpx.KindFile); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(native, "new.txt")); !os.IsNotExist(err) {
		t.Fatalf("删除后 new.txt 仍存在: %v", err)
	}
}

func TestReadWriteText(t *testing.T) {
	svc := New()
	posix := posixTmp(t)
	native := filepath.FromSlash(posix)

	if err := svc.WriteText(posix+"/note.txt", "你好，终端\n第二行"); err != nil {
		t.Fatal(err)
	}
	got, err := svc.ReadText(posix + "/note.txt")
	if err != nil {
		t.Fatal(err)
	}
	if got != "你好，终端\n第二行" {
		t.Fatalf("ReadText = %q", got)
	}

	// 超过 1.5MB 拒绝
	big := filepath.Join(native, "big.txt")
	if err := os.WriteFile(big, make([]byte, sftpx.MaxEditBytes+1), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ReadText(posix + "/big.txt"); err == nil || !strings.Contains(err.Error(), "1.5MB") {
		t.Fatalf("超大文件应报 1.5MB 错误, got %v", err)
	}

	// 含 NUL 按二进制拒绝
	if err := os.WriteFile(filepath.Join(native, "bin.dat"), []byte{'a', 0, 'b'}, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ReadText(posix + "/bin.dat"); err == nil || !strings.Contains(err.Error(), "二进制") {
		t.Fatalf("二进制文件应拒绝, got %v", err)
	}
}

func TestUploadPaths(t *testing.T) {
	svc := New()
	srcPosix := posixTmp(t)
	src := filepath.FromSlash(srcPosix)
	dstPosix := posixTmp(t)
	dst := filepath.FromSlash(dstPosix)

	writeFile(t, filepath.Join(src, "one.txt"), "1")
	if err := os.MkdirAll(filepath.Join(src, "tree", "nested"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(src, "tree", "nested", "leaf.txt"), "leaf")

	done, err := svc.UploadPaths(dstPosix, []string{
		srcPosix + "/one.txt",
		srcPosix + "/tree",
		srcPosix + "/gone.txt", // 失效路径跳过
	})
	if err != nil {
		t.Fatal(err)
	}
	if done != 2 {
		t.Fatalf("done = %d, want 2", done)
	}
	for _, p := range []string{"one.txt", filepath.Join("tree", "nested", "leaf.txt")} {
		data, err := os.ReadFile(filepath.Join(dst, p))
		if err != nil {
			t.Fatalf("复制目标缺失 %s: %v", p, err)
		}
		want := "1"
		if p != "one.txt" {
			want = "leaf"
		}
		if string(data) != want {
			t.Fatalf("%s 内容 = %q, want %q", p, data, want)
		}
	}
}

func TestMoveInto(t *testing.T) {
	svc := New()
	srcPosix := posixTmp(t)
	src := filepath.FromSlash(srcPosix)
	dstPosix := posixTmp(t)
	dst := filepath.FromSlash(dstPosix)

	writeFile(t, filepath.Join(src, "mv.txt"), "m")
	done, err := svc.MoveInto(dstPosix, []string{srcPosix + "/mv.txt"})
	if err != nil {
		t.Fatal(err)
	}
	if done != 1 {
		t.Fatalf("done = %d, want 1", done)
	}
	if _, err := os.Lstat(filepath.Join(src, "mv.txt")); !os.IsNotExist(err) {
		t.Fatalf("移动后源仍在: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(dst, "mv.txt"))
	if err != nil || string(data) != "m" {
		t.Fatalf("移动目标内容 = %q, err = %v", data, err)
	}
	// 失效路径跳过
	done, err = svc.MoveInto(dstPosix, []string{srcPosix + "/nope"})
	if err != nil || done != 0 {
		t.Fatalf("失效路径: done = %d, err = %v", done, err)
	}
}

func TestCopyTo(t *testing.T) {
	svc := New()
	srcPosix := posixTmp(t)
	src := filepath.FromSlash(srcPosix)
	dstPosix := posixTmp(t)
	dst := filepath.FromSlash(dstPosix)

	// 文件 → 完整目标路径（对应 download 的另存为）
	writeFile(t, filepath.Join(src, "a.txt"), "alpha")
	if err := svc.CopyTo(srcPosix+"/a.txt", filepath.Join(dst, "saved.txt")); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(filepath.Join(dst, "saved.txt")); err != nil || string(data) != "alpha" {
		t.Fatalf("saved.txt = %q, err = %v", data, err)
	}

	// 目录 → 完整目标路径，递归（对应 downloadDir）
	if err := os.MkdirAll(filepath.Join(src, "pack", "in"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(src, "pack", "in", "f.txt"), "f")
	if err := svc.CopyTo(srcPosix+"/pack", filepath.Join(dst, "pack-copy")); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(filepath.Join(dst, "pack-copy", "in", "f.txt")); err != nil || string(data) != "f" {
		t.Fatalf("pack-copy/in/f.txt = %q, err = %v", data, err)
	}
}
