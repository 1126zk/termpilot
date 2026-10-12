package sshx

import "testing"

func TestExpandProxyCommand(t *testing.T) {
	cases := []struct {
		name     string
		command  string
		host     string
		port     int
		username string
		want     string
	}{
		{"全部变量", "nc %h %p -u %r", "example.com", 2222, "alice", "nc example.com 2222 -u alice"},
		{"端口缺省按22", "nc %h %p", "example.com", 0, "alice", "nc example.com 22"},
		{"百分号转义", "echo 100%%", "h", 22, "u", "echo 100%"},
		{"%n 等同主机", "connect %n", "h", 22, "u", "connect h"},
		{"没有变量原样返回", "nc 10.0.0.1 22", "h", 22, "u", "nc 10.0.0.1 22"},
		{"未知令牌原样保留", "echo %x %h", "h", 22, "u", "echo %x h"},
		{"连续变量", "%h:%p", "h", 2200, "u", "h:2200"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ExpandProxyCommand(tc.command, tc.host, tc.port, tc.username)
			if got != tc.want {
				t.Fatalf("ExpandProxyCommand(%q, %q, %d, %q) = %q, want %q",
					tc.command, tc.host, tc.port, tc.username, got, tc.want)
			}
		})
	}
}
