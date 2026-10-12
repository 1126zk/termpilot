package sftpx

import "testing"

func TestNormalizeRemotePath(t *testing.T) {
	cases := map[string]string{
		`C:\a\b`:   "C:/a/b",
		`/etc/ssh`: "/etc/ssh",
		`~\docs`:   "~/docs",
		"":         "",
	}
	for in, want := range cases {
		if got := normalizeRemotePath(in); got != want {
			t.Errorf("normalizeRemotePath(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestRemoteJoin(t *testing.T) {
	cases := []struct {
		elems []string
		want  string
	}{
		{[]string{".", "a.txt"}, "a.txt"},
		{[]string{"/var", "log"}, "/var/log"},
		{[]string{"/var/", "/log"}, "/var/log"},
		{[]string{"/a", ".."}, "/"},
	}
	for _, c := range cases {
		if got := remoteJoin(c.elems...); got != c.want {
			t.Errorf("remoteJoin(%v) = %q, want %q", c.elems, got, c.want)
		}
	}
}

func TestExpandTilde(t *testing.T) {
	cases := []struct {
		p, home, want string
	}{
		{"~", "/home/u", "/home/u"},
		{"~/a/b", "/home/u", "/home/u/a/b"},
		{"~", "/home/u/", "/home/u"}, // 尾斜杠去掉
		{"~/a", "/", "/a"},           // 根目录
		{"~/a", "", "~/a"},           // 登录目录解析失败：原样
		{"/etc", "/home/u", "/etc"},  // 不含 ~ 不动
		{"~x/a", "/home/u", "~x/a"},  // ~ 后不是 / 不动
	}
	for _, c := range cases {
		if got := expandTilde(c.p, c.home); got != c.want {
			t.Errorf("expandTilde(%q, %q) = %q, want %q", c.p, c.home, got, c.want)
		}
	}
}

func TestLoginRelativePath(t *testing.T) {
	cases := []struct {
		home, p, want string
	}{
		{"/home/u", "/home/u/a.txt", "a.txt"},
		{"/home/u/", "/home/u/a.txt", "a.txt"}, // 尾斜杠归一
		{"/home/u", "/etc/passwd", ""},         // 不在登录目录下
		{"/home/u", "a.txt", ""},               // 相对路径不处理
		{"", "/home/u/a.txt", ""},              // 登录目录未知
		{"/", "/x", ""},                        // home=/ 时 TS 按未解析处理
		{"/home/u", "/home/u", ""},             // rest 为空
		{"/home/u", "/home/u2/a", ""},          // 前缀边界：u2 不是 u 的子路径
	}
	for _, c := range cases {
		if got := loginRelativePath(c.home, c.p); got != c.want {
			t.Errorf("loginRelativePath(%q, %q) = %q, want %q", c.home, c.p, got, c.want)
		}
	}
}
