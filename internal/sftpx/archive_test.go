package sftpx

import (
	"strings"
	"testing"
)

func TestTarGzCommand(t *testing.T) {
	got, err := TarGzCommand("/root/leapbase")
	if err != nil {
		t.Fatal(err)
	}
	for _, part := range []string{
		"if [ -e '/root/leapbase.tar.gz' ]; then echo '压缩包已存在' >&2; exit 1; fi",
		"du -sb -- '/root/leapbase'",
		"printf 'TP_TOTAL %s\\n' \"$total\"",
		"tar -czf '/root/leapbase.tar.gz' -C '/root' --record-size=10240 --checkpoint=100 --checkpoint-action='echo=TP %u' -- 'leapbase'",
		"tar -czf '/root/leapbase.tar.gz' -C '/root' -- 'leapbase'",
		"rm -f '/root/leapbase.tar.gz'",
	} {
		if !strings.Contains(got, part) {
			t.Fatalf("缺少 %q\n%s", part, got)
		}
	}

	if total, tick, kind, ok := ParseArchiveLine("TP_TOTAL 4096"); !ok || kind != "total" || total != 4096 || tick != 0 {
		t.Fatalf("总量行: %d %d %s %v", total, tick, kind, ok)
	}
	if _, tick, kind, ok := ParseArchiveLine("\rTP 3"); !ok || kind != "tick" || tick != 3 {
		t.Fatalf("进度行: %d %s %v", tick, kind, ok)
	}
	if got := ArchiveFailText("TP 1\n压缩包已存在\n", "TP_TOTAL 1"); got != "压缩包已存在" {
		t.Fatalf("失败原因 = %q", got)
	}

	got, err = TarGzCommand(`/tmp/a b/o'hare`)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, `'/tmp/a b/o'\''hare.tar.gz'`) || !strings.Contains(got, `-- 'o'\''hare'`) {
		t.Fatalf("引号不对: %s", got)
	}

	if _, err := TarGzCommand("/"); err == nil {
		t.Fatal("根目录不应压缩")
	}
}
