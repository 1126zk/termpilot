package sshx

import (
	"strings"
	"testing"
)

func TestBuildScript(t *testing.T) {
	t.Run("无 session 全新环境", func(t *testing.T) {
		got := BuildScript("", "", "echo hi")
		want := "{\necho hi\n} < /dev/null\n"
		if got != want {
			t.Fatalf("got %q, want %q", got, want)
		}
	})
	t.Run("prelude 插在命令前", func(t *testing.T) {
		got := BuildScript("", "export A=1", "echo hi")
		want := "export A=1\n{\necho hi\n} < /dev/null\n"
		if got != want {
			t.Fatalf("got %q, want %q", got, want)
		}
	})
	t.Run("命名 session 回放并保存环境", func(t *testing.T) {
		got := BuildScript("build", "", "make")
		for _, want := range []string{
			`S="$HOME/.cache/termpilot/exec/build"`,
			`mkdir -p "$HOME/.cache/termpilot/exec"`,
			`if [ -f "$S.env" ]; then . "$S.env" 2>/dev/null; fi`,
			`if [ -f "$S.pwd" ]; then cd "$(cat "$S.pwd")" 2>/dev/null || true; fi`,
			"{\nmake\n} < /dev/null",
			"rc=$?",
			`export -p > "$S.env" 2>/dev/null && chmod 600 "$S.env" 2>/dev/null`,
			`pwd > "$S.pwd" 2>/dev/null`,
			"exit $rc",
		} {
			if !strings.Contains(got, want) {
				t.Fatalf("脚本缺少 %q:\n%s", want, got)
			}
		}
		if !strings.HasSuffix(got, "\n") {
			t.Fatalf("脚本应以换行结尾: %q", got)
		}
	})
}

func TestSessionNameSanitize(t *testing.T) {
	if got := sessionNameRe.ReplaceAllString("my session/1", "_"); got != "my_session_1" {
		t.Fatalf("got %q", got)
	}
	if got := sessionNameRe.ReplaceAllString("build-v2_amd64", "_"); got != "build-v2_amd64" {
		t.Fatalf("got %q", got)
	}
}

func TestClipStream(t *testing.T) {
	t.Run("不超上限原样返回", func(t *testing.T) {
		text, truncated := ClipStream("hello", 10)
		if truncated || text != "hello" {
			t.Fatalf("text=%q truncated=%v", text, truncated)
		}
	})
	t.Run("max<=0 不截断", func(t *testing.T) {
		text, truncated := ClipStream("hello", 0)
		if truncated || text != "hello" {
			t.Fatalf("text=%q truncated=%v", text, truncated)
		}
	})
	t.Run("截断保留开头结尾并注明原长", func(t *testing.T) {
		full := strings.Repeat("a", 100)
		text, truncated := ClipStream(full, 10)
		if !truncated {
			t.Fatal("应标记截断")
		}
		if !strings.HasPrefix(text, "aaaaa") || !strings.HasSuffix(text, "aaaaa") {
			t.Fatalf("text=%q", text)
		}
		if !strings.Contains(text, "原长 100 字符") {
			t.Fatalf("text=%q", text)
		}
	})
	t.Run("多字节字符按 rune 截断", func(t *testing.T) {
		full := strings.Repeat("汉", 100)
		text, truncated := ClipStream(full, 10)
		if !truncated || !strings.Contains(text, "原长 100 字符") {
			t.Fatalf("text=%q", text)
		}
		if strings.ContainsRune(text, '\uFFFD') {
			t.Fatal("不应出现替换字符")
		}
	})
}

func TestCappedWriter(t *testing.T) {
	w := &cappedWriter{cap: 4}
	w.Write([]byte("ab"))
	w.Write([]byte("cdef")) // 未满就整段收（与 TS 一致，可略超上限）
	w.Write([]byte("gh"))   // 已满，丢弃
	if w.String() != "abcdef" {
		t.Fatalf("got %q", w.String())
	}
}
