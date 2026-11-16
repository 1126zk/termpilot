package sftpx

import (
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"net"
	"testing"

	"golang.org/x/crypto/ssh"

	"termpilot/internal/sshx"
)

func TestDeadSharedConnClosesThatConn(t *testing.T) {
	client := sshClientServerClosesOnChannel(t)
	svc := New(Options{
		Acquire: func(string) (*sshx.Hold, error) {
			return &sshx.Hold{Conn: &sshx.Conn{Client: client}}, nil
		},
		InstallScript: func() (string, error) {
			t.Error("连接已经断了，不该再跑安装")
			return "", errors.New("skip")
		},
	})
	if _, _, err := svc.List("s1", "/"); err == nil {
		t.Fatal("应该失败")
	}
	if !connClosed(client) {
		t.Fatal("断了的连接应该被关掉")
	}
}

func TestRejectedChannelKeepsConn(t *testing.T) {
	client := sshClientServerRejectsChannels(t)
	svc := New(Options{
		Acquire: func(string) (*sshx.Hold, error) {
			return &sshx.Hold{Conn: &sshx.Conn{Client: client}}, nil
		},
		InstallScript: func() (string, error) { return "", errors.New("skip") },
	})
	if _, _, err := svc.List("s1", "/"); err == nil {
		t.Fatal("应该失败")
	}
	if connClosed(client) {
		t.Fatal("通道被拒绝时连接还在，不该关掉")
	}
}

// sftp-server 起不来时 NewClient 也报 EOF，但 SSH 还活着，不能把终端一起关掉。
func TestSubsystemEOFKeepsConn(t *testing.T) {
	client := sshClientForTest(t, func(_ net.Conn, nc ssh.NewChannel) {
		ch, reqs, err := nc.Accept()
		if err != nil {
			return
		}
		go func() {
			for req := range reqs {
				_ = req.Reply(true, nil)
				_ = ch.Close()
			}
		}()
	})
	svc := New(Options{
		Acquire: func(string) (*sshx.Hold, error) {
			return &sshx.Hold{Conn: &sshx.Conn{Client: client}}, nil
		},
		InstallScript: func() (string, error) { return "", errors.New("skip") },
	})
	if _, _, err := svc.List("s1", "/"); err == nil {
		t.Fatal("应该失败")
	}
	if connClosed(client) {
		t.Fatal("子系统退出不代表 SSH 断了，不该关连接")
	}
}

func connClosed(client *ssh.Client) bool {
	_, _, err := client.SendRequest("keepalive@openssh.com", true, nil)
	return err != nil
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
