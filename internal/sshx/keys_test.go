package sshx

import (
	"strings"
	"testing"
)

func TestParseSSHG(t *testing.T) {
	text := strings.Join([]string{
		"user root",
		"hostname 203.0.113.5",
		"identitiesonly no",
		"identityfile ~/.ssh/id_rsa",
		"identityfile ~/.ssh/id_ed25519",
		"identityfile none",
	}, "\n")
	files, only := parseSSHG(text)
	if only {
		t.Fatal("identitiesonly 应为 no")
	}
	if len(files) != 2 || files[0] != "~/.ssh/id_rsa" || files[1] != "~/.ssh/id_ed25519" {
		t.Fatalf("files = %#v", files)
	}
	text = strings.Replace(text, "identitiesonly no", "identitiesonly yes", 1)
	_, only = parseSSHG(text)
	if !only {
		t.Fatal("identitiesonly yes 应关掉代理")
	}
}
