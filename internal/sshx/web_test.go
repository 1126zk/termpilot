package sshx

import (
	"strings"
	"testing"
)

func TestParseCaddyCertHosts(t *testing.T) {
	got := parseCaddyCertHosts("Example.COM\n\n/tmp/noise\nblog.example.com\n")
	if !got["example.com"] || !got["blog.example.com"] || got["/tmp/noise"] {
		t.Fatalf("主机名不对: %#v", got)
	}
	if len(got) != 2 {
		t.Fatalf("多收了: %#v", got)
	}
}

func TestCaddyCertReloadScript(t *testing.T) {
	got := caddyCertReloadScript("blog.example.com")
	for _, part := range []string{
		`dom="blog.example.com"`,
		`[ -e "$1" ] || rm -rf "$d"`,
		`issue_cert_*_${dom}.lock`,
		`caddy reload --config /etc/caddy/Caddyfile`,
	} {
		if !strings.Contains(got, part) {
			t.Fatalf("缺少 %q\n%s", part, got)
		}
	}
}
