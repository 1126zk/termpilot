package sshx

import (
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func TestReadConcreteHosts(t *testing.T) {
	text := strings.Join([]string{
		"# 全局注释",
		"Include ~/.ssh/conf.d/*",
		"",
		"Host prod",
		"    HostName 10.0.0.1",
		"    User deploy",
		"    Port 2222",
		"    ProxyJump admin@bastion:2200,[2001:db8::1]",
		"    ProxyCommand nc %h %p",
		"",
		"Host *.internal",
		"    User ops",
		"",
		"Match user git",
		"    IdentityFile ~/.ssh/git",
		"",
		"Host one two",
		"    User multi",
	}, "\n")
	hosts := ReadConcreteHosts(text)
	if len(hosts) != 1 || hosts[0].Alias != "prod" {
		t.Fatalf("hosts = %+v", hosts)
	}
	fields := hosts[0].Fields
	if fields.HostName != "10.0.0.1" || fields.Username != "deploy" || fields.Port != 2222 {
		t.Fatalf("fields = %+v", fields)
	}
	if fields.ProxyCommand != "nc %h %p" {
		t.Fatalf("ProxyCommand = %q", fields.ProxyCommand)
	}
	wantJumps := []HopFields{
		{Host: "bastion", Port: 2200, Username: "admin"},
		{Host: "2001:db8::1", Port: 22},
	}
	if !reflect.DeepEqual(fields.Jumps, wantJumps) {
		t.Fatalf("Jumps = %+v, want %+v", fields.Jumps, wantJumps)
	}
}

func TestRenderUpsertIntoEmpty(t *testing.T) {
	got := RenderUpsert("", "prod", HostFields{HostName: "10.0.0.1", Port: 22, Username: "deploy"})
	// 与 TS 原版一致：空文本解析出一个含空行的 loose 段，结果带前导换行。
	want := "\nHost prod\n    HostName 10.0.0.1\n    User deploy\n"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestRenderUpsertAppendsWithBlankLine(t *testing.T) {
	text := "Host old\n    HostName 1.1.1.1\n"
	got := RenderUpsert(text, "prod", HostFields{HostName: "10.0.0.1", Port: 2200, Username: "deploy"})
	want := "Host old\n    HostName 1.1.1.1\n\nHost prod\n    HostName 10.0.0.1\n    User deploy\n    Port 2200\n"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestRenderUpsertUpdatesExisting(t *testing.T) {
	text := strings.Join([]string{
		"Host prod",
		"  HostName 10.0.0.1 # 旧地址",
		"  User deploy",
		"  Port 2222",
		"  Port 22", // 重复关键字，更新时清掉
		"  ProxyJump none",
		"",
		"Host *.internal",
		"  User ops",
	}, "\n")
	got := RenderUpsert(text, "prod", HostFields{
		HostName: "10.0.0.2", Port: 22, Username: "root",
		Jumps: []HopFields{{Host: "bastion", Port: 22, Username: "admin"}},
	})
	want := strings.Join([]string{
		"Host prod",
		"  HostName 10.0.0.2",
		"  User root",
		"  ProxyJump admin@bastion",
		"",
		"Host *.internal",
		"  User ops",
	}, "\n") + "\n"
	if got != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}
}

func TestRenderUpsertQuotesValues(t *testing.T) {
	got := RenderUpsert("", "prod", HostFields{
		HostName: "h", Port: 22, Username: "u",
		ProxyCommand: `ssh -W %h:%p "jump host"`,
	})
	if !strings.Contains(got, `ProxyCommand "ssh -W %h:%p \"jump host\""`+"\n") {
		t.Fatalf("ProxyCommand 未被正确引用:\n%s", got)
	}
}

func TestRenderUpsertPreservesCRLF(t *testing.T) {
	text := "Host old\r\n    HostName 1.1.1.1\r\n"
	got := RenderUpsert(text, "prod", HostFields{HostName: "h", Port: 22, Username: "u"})
	if !strings.Contains(got, "\r\n") || strings.Contains(strings.ReplaceAll(got, "\r\n", ""), "\n") {
		t.Fatalf("应保持 CRLF:\n%q", got)
	}
}

func TestRenderRemove(t *testing.T) {
	text := "Host prod\n    HostName 10.0.0.1\n\nHost other\n    HostName 2.2.2.2\n"
	got := RenderRemove(text, "prod")
	want := "Host other\n    HostName 2.2.2.2\n"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
	// 通配段不动
	if RenderRemove("Host *.internal\n  User ops\n", "prod") != "Host *.internal\n  User ops\n" {
		t.Fatal("不应改动其他段")
	}
}

func TestSuggestAlias(t *testing.T) {
	cases := []struct {
		name     string
		publicID string
		taken    map[string]bool
		want     string
	}{
		{"生产 服务器", "conn-1", nil, "tp-1"}, // 中文被清掉后为空 → 兜底
		{"my server", "conn-1", nil, "my-server"},
		{"  web.prod_01 ", "conn-1", nil, "web.prod_01"},
		{"my server", "conn-1", map[string]bool{"my-server": true}, "my-server-2"},
		{"my server", "conn-1", map[string]bool{"my-server": true, "my-server-2": true}, "my-server-3"},
		{"!!!", "conn-abc", nil, "tp-abc"},
	}
	for _, tc := range cases {
		got := SuggestAlias(tc.name, tc.publicID, tc.taken)
		if got != tc.want {
			t.Errorf("SuggestAlias(%q, %q) = %q, want %q", tc.name, tc.publicID, got, tc.want)
		}
	}
	long := SuggestAlias(strings.Repeat("a", 100), "conn-1", nil)
	if len(long) != 64 {
		t.Errorf("超长别名应截到 64，得到 %d", len(long))
	}
}

func TestParseHopAndFormat(t *testing.T) {
	cases := []struct {
		input string
		want  HopFields
		ok    bool
	}{
		{"bastion", HopFields{Host: "bastion", Port: 22}, true},
		{"admin@bastion", HopFields{Host: "bastion", Port: 22, Username: "admin"}, true},
		{"admin@bastion:2200", HopFields{Host: "bastion", Port: 2200, Username: "admin"}, true},
		{"[2001:db8::1]:2200", HopFields{Host: "2001:db8::1", Port: 2200}, true},
		{"u@[2001:db8::1]", HopFields{Host: "2001:db8::1", Port: 22, Username: "u"}, true},
		// 裸 IPv6 不带括号时末段数字会被当成端口（与 TS 原版行为一致，ProxyJump 里应写带括号形式）
		{"2001:db8::1", HopFields{Host: "2001:db8:", Port: 1}, true},
		{"host:abc", HopFields{Host: "host:abc", Port: 22}, true}, // 非数字端口不当端口
		{"[broken", HopFields{}, false},
		{"user@", HopFields{}, false},
	}
	for _, tc := range cases {
		got, ok := ParseHop(tc.input)
		if ok != tc.ok || (ok && !reflect.DeepEqual(got, tc.want)) {
			t.Errorf("ParseHop(%q) = %+v, %v; want %+v, %v", tc.input, got, ok, tc.want, tc.ok)
			continue
		}
		if ok && tc.input != "2001:db8::1" && tc.input != "host:abc" && FormatHop(got) != tc.input {
			t.Errorf("FormatHop(ParseHop(%q)) = %q", tc.input, FormatHop(got))
		}
	}
	if got := FormatHop(HopFields{Host: "2001:db8::1", Port: 22}); got != "[2001:db8::1]" {
		t.Errorf("IPv6 应加括号: %q", got)
	}
}

func TestUpsertRemoveFileRoundtrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".ssh", "config")
	fields := HostFields{HostName: "10.0.0.1", Port: 2222, Username: "deploy"}
	if err := UpsertSshHostFile(path, "prod", fields); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "Host prod") {
		t.Fatalf("文件内容:\n%s", data)
	}
	if runtime.GOOS != "windows" {
		info, _ := os.Stat(path)
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("权限 = %o, want 600", info.Mode().Perm())
		}
	}
	// 幂等：再写一次内容不变
	before, _ := os.Stat(path)
	if err := UpsertSshHostFile(path, "prod", fields); err != nil {
		t.Fatal(err)
	}
	after, _ := os.Stat(path)
	if !before.ModTime().Equal(after.ModTime()) {
		t.Fatal("内容不变时不应重写文件")
	}
	if aliases := ListConfigAliasesIn(path); !aliases["prod"] {
		t.Fatalf("aliases = %v", aliases)
	}
	if err := RemoveSshHostFile(path, "prod"); err != nil {
		t.Fatal(err)
	}
	if aliases := ListConfigAliasesIn(path); aliases["prod"] {
		t.Fatalf("删除后 aliases = %v", aliases)
	}
	// 删除不存在的文件/别名不报错
	if err := RemoveSshHostFile(filepath.Join(t.TempDir(), "nope"), "prod"); err != nil {
		t.Fatal(err)
	}
}

func TestReadConcreteHostsDefaults(t *testing.T) {
	hosts := ReadConcreteHosts("Host bare\n")
	if len(hosts) != 1 {
		t.Fatalf("hosts = %+v", hosts)
	}
	// HostName 回落到别名，Port 回落到 22
	if hosts[0].Fields.HostName != "bare" || hosts[0].Fields.Port != 22 {
		t.Fatalf("fields = %+v", hosts[0].Fields)
	}
}

func TestDirectiveOf(t *testing.T) {
	cases := []struct {
		line  string
		key   string
		value string
	}{
		{"  HostName 10.0.0.1", "hostname", "10.0.0.1"},
		{"Port=2222", "port", "2222"},
		{`ProxyCommand "nc %h %p"`, "proxycommand", "nc %h %p"},
		{"HostName 10.0.0.1 # 注释", "hostname", "10.0.0.1"},
		{"User 'dep loy'", "user", "dep loy"},
	}
	for _, tc := range cases {
		d := directiveOf(tc.line)
		if d == nil || d.key != tc.key || d.value != tc.value {
			t.Errorf("directiveOf(%q) = %+v, want %s=%q", tc.line, d, tc.key, tc.value)
		}
	}
	for _, line := range []string{"# comment", "   ", "", "#Host x"} {
		if d := directiveOf(line); d != nil {
			t.Errorf("directiveOf(%q) = %+v, want nil", line, d)
		}
	}
}
