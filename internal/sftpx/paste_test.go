package sftpx

import "testing"

func TestSavePasteRejectsBadNames(t *testing.T) {
	s := &Service{}
	// 名字不合法时在碰连接之前就拒绝，不会写到 PasteDir 以外
	for _, name := range []string{"../a.png", "a/b.png", "/etc/x.png", "a.sh", ".png", "a b.png"} {
		if _, err := s.SavePaste("sess", name, []byte{1}); err == nil {
			t.Fatalf("%q should be rejected", name)
		}
	}
}

func TestPasteNameAcceptsTimestamps(t *testing.T) {
	for _, name := range []string{"20261101-103215.png", "20261101-103215-2.jpeg", "x.webp"} {
		if !pasteName.MatchString(name) {
			t.Fatalf("%q should be accepted", name)
		}
	}
}
