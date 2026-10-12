package terminal

import "testing"

func TestIDGeneration(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 100; i++ {
		connID := NewConnID()
		termID := NewTermID()
		if !IsConnID(connID) {
			t.Errorf("NewConnID() = %q 未通过 IsConnID", connID)
		}
		if !IsTermID(termID) {
			t.Errorf("NewTermID() = %q 未通过 IsTermID", termID)
		}
		if IsConnID(termID) || IsTermID(connID) {
			t.Errorf("前缀串台: %q / %q", connID, termID)
		}
		if seen[connID] || seen[termID] {
			t.Errorf("ID 重复: %q / %q", connID, termID)
		}
		seen[connID] = true
		seen[termID] = true
	}
}

func TestIDValidation(t *testing.T) {
	if !IsConnID("conn-0A1b2C3d") {
		t.Error("大写十六进制应该通过（对应 TS 的 /i）")
	}
	if !IsTermID(" term-1234abcd ") {
		t.Error("带空白应该 trim 后通过")
	}
	for _, bad := range []string{"", "conn-", "conn-123", "conn-123456789", "conn-ghijklmn", "term-1234abcg", "xterm-1234abcd"} {
		if IsConnID(bad) || IsTermID(bad) {
			t.Errorf("%q 不应该通过校验", bad)
		}
	}
}
