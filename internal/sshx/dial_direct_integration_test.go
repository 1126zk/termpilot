package sshx

import (
	"context"
	"io"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

func TestDialDirectExec(t *testing.T) {
	target := newTestSSHServer(t, "target", "target-pw")
	targetHost, targetPort := target.addr()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	conn, err := Dial(ctx, &SessionConfig{
		Host:     targetHost,
		Port:     targetPort,
		Username: "target",
		Options:  nil,
	}, "target-pw", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	channel, _, err := conn.Client.OpenChannel("session", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer channel.Close()
	if _, err := channel.SendRequest("exec", true, ssh.Marshal(struct{ Command string }{Command: "echo target-ok"})); err != nil {
		t.Fatal(err)
	}
	result, err := io.ReadAll(channel)
	if err != nil {
		t.Fatal(err)
	}
	if string(result) != "target-ok" {
		t.Fatalf("result = %q, want target-ok", result)
	}
}
