package sftpx

import (
	"strings"
	"testing"
)

func TestAssertEditSize(t *testing.T) {
	if err := AssertEditSize(MaxEditBytes); err != nil {
		t.Errorf("1.5MB 整应该放行: %v", err)
	}
	err := AssertEditSize(MaxEditBytes + 1)
	if err == nil || err.Error() != "文件超过 1.5MB，不在编辑器里打开" {
		t.Errorf("超 1.5MB 的错误文案不对: %v", err)
	}
}

func TestAssertTextBuffer(t *testing.T) {
	if err := AssertTextBuffer([]byte("hello 世界")); err != nil {
		t.Errorf("纯文本应该放行: %v", err)
	}
	err := AssertTextBuffer([]byte{'a', 0, 'b'})
	if err == nil || err.Error() != "这是二进制文件，不能用文本编辑器打开" {
		t.Errorf("含 NUL 的错误文案不对: %v", err)
	}
}

func TestCompareRemoteFiles(t *testing.T) {
	dir := RemoteFile{Name: "b", Kind: KindDir}
	file := RemoteFile{Name: "a", Kind: KindFile}
	if CompareRemoteFiles(dir, file) >= 0 {
		t.Error("目录应该排在文件前")
	}
	if CompareRemoteFiles(file, dir) <= 0 {
		t.Error("文件应该排在目录后")
	}
	a := RemoteFile{Name: "a", Kind: KindFile}
	b := RemoteFile{Name: "b", Kind: KindFile}
	if CompareRemoteFiles(a, b) >= 0 || CompareRemoteFiles(b, a) <= 0 || CompareRemoteFiles(a, a) != 0 {
		t.Error("同类按名字排")
	}
	link := RemoteFile{Name: "z", Kind: KindLink}
	if CompareRemoteFiles(link, dir) <= 0 {
		t.Error("链接不算目录，排在目录后")
	}
}

func TestRefuseHuge(t *testing.T) {
	if err := refuseHuge(MaxTransferBytes); err != nil {
		t.Errorf("512MB 整应该放行: %v", err)
	}
	err := refuseHuge(MaxTransferBytes + 1)
	if err == nil || !strings.Contains(err.Error(), "513 MB") || !strings.Contains(err.Error(), "超过 512 MB") {
		t.Errorf("刚超 512MB 的文案不对: %v", err)
	}
	err = refuseHuge(2*1024*1024*1024 + 512*1024*1024)
	if err == nil || !strings.Contains(err.Error(), "2.5 GB") {
		t.Errorf("GB 档文案不对: %v", err)
	}
}
