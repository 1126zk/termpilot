package sftpx

import (
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"io"
	"net"
	"testing"

	"golang.org/x/crypto/ssh"

	"termpilot/internal/sshx"
)

func TestArmGaveUp(t *testing.T) {
	cases := []struct {
		err  error
		want bool
	}{
		{errors.New("ssh: unexpected packet in response to channel open: <nil>"), true},
		{errors.New("SFTP 子系统没有响应"), true},
		{io.EOF, true},
		{errors.New("read tcp 127.0.0.1:1->127.0.0.1:2: use of closed network connection"), true},
		{errors.New("ssh: subsystem request failed"), false},
		{errors.New("ssh: rejected: administratively prohibited"), false},
		{errors.New("SFTP 没有响应"), false},
		{nil, false},
	}
	for _, tc := range cases {
		if got := armGaveUp(tc.err); got != tc.want {
			t.Errorf("armGaveUp(%v) = %v, want %v", tc.err, got, tc.want)
		}
	}
}

func TestDeadSharedConnDropsPool(t *testing.T) {
	client := sshClientServerClosesOnChannel(t)
	var dropped []string
	svc := New(Options{
		Acquire: func(string) (*sshx.Hold, error) {
			return &sshx.Hold{Conn: &sshx.Conn{Client: client}}, nil
		},
		Drop: func(id string) { dropped = append(dropped, id) },
		OnInstall: func(InstallEvent) {
			t.Error("连接已经断了，不该再跑安装")
		},
	})
	if _, _, err := svc.List("s1", "/"); err == nil {
		t.Fatal("应该失败")
	}
	if len(dropped) != 1 || dropped[0] != "s1" {
		t.Fatalf("应该丢掉池里的连接，得到 %v", dropped)
	}
}

func TestRejectedChannelKeepsPool(t *testing.T) {
	client := sshClientServerRejectsChannels(t)
	dropped := false
	svc := New(Options{
		Acquire: func(string) (*sshx.Hold, error) {
			return &sshx.Hold{Conn: &sshx.Conn{Client: client}}, nil
		},
		Drop: func(string) { dropped = true },
	})
	if _, _, err := svc.List("s1", "/"); err == nil {
		t.Fatal("应该失败")
	}
	if dropped {
		t.Fatal("通道被拒绝时连接还在，不该丢掉")
	}
}

func sshClientServerClosesOnChannel(t *testing.T) *ssh.Client {
	t.Helper()
	return sshClientForTest(t, func(conn net.Conn, ch ssh.NewChannel) {
		_ = conn.Close()
	})
}

func sshClientServerRejectsChannels(t *testing.T) *ssh.Client {
	t.Helper()
	return sshClientForTest(t, func(_ net.Conn, ch ssh.NewChannel) {
		_ = ch.Reject(ssh.Prohibited, "no")
	})
}

func sshClientForTest(t *testing.T, onChannel func(net.Conn, ssh.NewChannel)) *ssh.Client {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(key)
	if err != nil {
		t.Fatal(err)
	}
	cfg := &ssh.ServerConfig{NoClientAuth: true}
	cfg.AddHostKey(signer)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		_, chans, reqs, err := ssh.NewServerConn(conn, cfg)
		if err != nil {
			return
		}
		go ssh.DiscardRequests(reqs)
		for ch := range chans {
			onChannel(conn, ch)
		}
	}()
	client, err := ssh.Dial("tcp", ln.Addr().String(), &ssh.ClientConfig{
		User:            "u",
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client
}
