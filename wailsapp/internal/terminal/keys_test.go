package terminal

import "testing"

func TestEncodeTermInputKeys(t *testing.T) {
	got, err := EncodeTermInput(InputOptions{Keys: []string{"up", "down", "left", "right"}})
	if err != nil {
		t.Fatal(err)
	}
	if want := "\x1b[A\x1b[B\x1b[D\x1b[C"; got != want {
		t.Errorf("普通光标模式 = %q, want %q", got, want)
	}

	got, err = EncodeTermInput(InputOptions{Keys: []string{"up", "home", "end"}, ApplicationCursor: true})
	if err != nil {
		t.Fatal(err)
	}
	if want := "\x1bOA\x1bOH\x1bOF"; got != want {
		t.Errorf("application 光标模式 = %q, want %q", got, want)
	}

	got, err = EncodeTermInput(InputOptions{Keys: []string{"home", "end"}})
	if err != nil {
		t.Fatal(err)
	}
	if want := "\x1b[H\x1b[F"; got != want {
		t.Errorf("home/end 普通模式 = %q, want %q", got, want)
	}
}

func TestEncodeTermInputOrder(t *testing.T) {
	// data → keys → text → submit，顺序对应 TS encodeTermInput
	got, err := EncodeTermInput(InputOptions{
		Data: "d", Keys: []string{"tab"}, Text: "t", Submit: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if want := "d\tt\r"; got != want {
		t.Errorf("= %q, want %q", got, want)
	}
}

func TestEncodeKeyTable(t *testing.T) {
	cases := map[string]string{
		"enter": "\r", "tab": "\t", "backspace": "\x7f", "esc": "\x1b", "space": " ",
		"pageup": "\x1b[5~", "pagedown": "\x1b[6~",
		"ctrl-c": "\x03", "ctrl-d": "\x04", "ctrl-z": "\x1a", "ctrl-l": "\x0c",
		"f1": "\x1bOP", "f4": "\x1bOS", "f5": "\x1b[15~", "f12": "\x1b[24~",
	}
	for key, want := range cases {
		got, err := encodeKey(key, false)
		if err != nil {
			t.Errorf("encodeKey(%q): %v", key, err)
			continue
		}
		if got != want {
			t.Errorf("encodeKey(%q) = %q, want %q", key, got, want)
		}
	}
	// 白名单里每个键都必须能编码
	for _, key := range TermKeys {
		if _, err := encodeKey(key, false); err != nil {
			t.Errorf("TermKeys 里的 %q 编码失败: %v", key, err)
		}
	}
	if _, err := encodeKey("ctrl-alt-delete", false); err == nil {
		t.Error("不认识的按键应该报错")
	}
}

func TestCanonicalKey(t *testing.T) {
	cases := map[string]string{
		"Ctrl+C":  "ctrl-c",
		"ctrl+c":  "ctrl-c",
		"^C":      "ctrl-c",
		"^d":      "ctrl-d",
		" Up ":    "up",
		"page up": "pageup",
	}
	for in, want := range cases {
		if got := CanonicalKey(in); got != want {
			t.Errorf("CanonicalKey(%q) = %q, want %q", in, got, want)
		}
	}
}
