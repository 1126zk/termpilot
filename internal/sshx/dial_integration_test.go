package sshx

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

type directTCPMsg struct {
	Addr       string
	Port       uint32
	OriginAddr string
	OriginPort uint32
}

type testSSHServer struct {
	name     string
	listener net.Listener
	config   *ssh.ServerConfig
}

func newTestSSHServer(t *testing.T, username, password string) *testSSHServer {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(privateKey)
	if err != nil {
		t.Fatal(err)
	}
	config := &ssh.ServerConfig{
		PasswordCallback: func(metadata ssh.ConnMetadata, provided []byte) (*ssh.Permissions, error) {
			if metadata.User() != username || string(provided) != password {
				return nil, fmt.Errorf("用户名或密码错误")
			}
			return nil, nil
		},
	}
	config.AddHostKey(signer)
	server := &testSSHServer{name: username, listener: listener, config: config}
	go server.serve()
	t.Cleanup(func() { _ = listener.Close() })
	return server
}

func (s *testSSHServer) addr() (string, int) {
	host, portText, err := net.SplitHostPort(s.listener.Addr().String())
	if err != nil {
		return "", 0
	}
	port, _ := strconv.Atoi(portText)
	return host, port
}

func (s *testSSHServer) serve() {
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			return
		}
		go s.handleConn(conn)
	}
}

func (s *testSSHServer) handleConn(conn net.Conn) {
	defer conn.Close()
	_, channels, requests, err := ssh.NewServerConn(conn, s.config)
	if err != nil {
		return
	}
	go handleTestGlobalRequests(requests)
	for channel := range channels {
		switch channel.ChannelType() {
		case "direct-tcpip":
			var msg directTCPMsg
			if err := ssh.Unmarshal(channel.ExtraData(), &msg); err != nil {
				_ = channel.Reject(ssh.ConnectionFailed, "forward failed")
				continue
			}
			upstream, err := net.Dial("tcp", net.JoinHostPort(msg.Addr, strconv.Itoa(int(msg.Port))))
			if err != nil {
				_ = channel.Reject(ssh.ConnectionFailed, "forward failed")
				continue
			}
			channel, _, err := channel.Accept()
			if err != nil {
				_ = upstream.Close()
				continue
			}
			go proxySSHChannel(channel, upstream)
		case "session":
			channel, channelRequests, err := channel.Accept()
			if err != nil {
				continue
			}
			go handleTestSession(channel, channelRequests)
		default:
			_ = channel.Reject(ssh.UnknownChannelType, "unsupported")
		}
	}
}

func handleTestGlobalRequests(requests <-chan *ssh.Request) {
	for request := range requests {
		_ = request.Reply(request.Type == "keepalive@openssh.com", nil)
	}
}

func proxySSHChannel(channel ssh.Channel, upstream net.Conn) {
	defer channel.Close()
	defer upstream.Close()
	done := make(chan struct{})
	go func() {
		_, _ = io.Copy(upstream, channel)
		_ = upstream.Close()
		done <- struct{}{}
	}()
	go func() {
		_, _ = io.Copy(channel, upstream)
		_ = channel.CloseWrite()
	}()
	<-done
}

func handleTestSession(channel ssh.Channel, requests <-chan *ssh.Request) {
	defer channel.Close()
	for request := range requests {
		if request.Type == "keepalive@openssh.com" {
			_ = request.Reply(true, nil)
			continue
		}
		if request.Type != "exec" {
			_ = request.Reply(false, nil)
			continue
		}
		var payload struct{ Command string }
		if err := ssh.Unmarshal(request.Payload, &payload); err != nil {
			_ = request.Reply(false, nil)
			continue
		}
		if !strings.Contains(payload.Command, "target-ok") {
			_ = request.Reply(false, nil)
			continue
		}
		if _, err := channel.Write([]byte("target-ok")); err != nil {
			return
		}
		_ = request.Reply(true, nil)
		_ = channel.CloseWrite()
	}
}

func TestDialTwoHops(t *testing.T) {
	target := newTestSSHServer(t, "target", "target-pw")
	second := newTestSSHServer(t, "j2", "j2-pw")
	first := newTestSSHServer(t, "j1", "j1-pw")
	targetHost, targetPort := target.addr()
	firstHost, firstPort := first.addr()
	secondHost, secondPort := second.addr()

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	conn, err := Dial(ctx, &SessionConfig{
		Host: targetHost, Port: targetPort, Username: "target",
		Jumps: []Hop{
			{Host: firstHost, Port: firstPort, Username: "j1"},
			{Host: secondHost, Port: secondPort, Username: "j2"},
		},
		Options: &ConnectOptions{KeepaliveIntervalMs: new(int)},
	}, "target-pw", []string{"j1-pw", "j2-pw"}, nil)
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

func TestDialSecondHopRejectsWrongPassword(t *testing.T) {
	target := newTestSSHServer(t, "target", "target-pw")
	second := newTestSSHServer(t, "j2", "j2-pw")
	first := newTestSSHServer(t, "j1", "j1-pw")
	targetHost, targetPort := target.addr()
	firstHost, firstPort := first.addr()
	secondHost, secondPort := second.addr()

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	conn, err := Dial(ctx, &SessionConfig{
		Host: targetHost, Port: targetPort, Username: "target",
		Jumps: []Hop{
			{Host: firstHost, Port: firstPort, Username: "j1"},
			{Host: secondHost, Port: secondPort, Username: "j2"},
		},
	}, "target-pw", []string{"j1-pw", "wrong"}, nil)
	if err == nil {
		if conn != nil {
			conn.Close()
		}
		t.Fatal("第二跳使用错误密码时不应连接成功")
	}
}
