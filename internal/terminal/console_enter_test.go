package terminal

import "testing"

func TestConsoleEnter(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"ls\n", "ls\r"},
		{"ls\r\n", "ls\r"},
		{"ls\r", "ls\r"},
		{"a\nb\n", "a\rb\r"},
		{"", ""},
	}
	for _, c := range cases {
		got := string(consoleEnter([]byte(c.in)))
		if got != c.want {
			t.Errorf("consoleEnter(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
