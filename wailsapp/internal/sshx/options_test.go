package sshx

import (
	"reflect"
	"testing"
)

func TestSanitizeConnectOptions(t *testing.T) {
	t.Run("空输入", func(t *testing.T) {
		if got := SanitizeConnectOptions(nil); got != nil {
			t.Fatalf("got %+v", got)
		}
		if got := SanitizeConnectOptions(map[string]any{}); got != nil {
			t.Fatalf("got %+v", got)
		}
	})
	t.Run("收下合法字段", func(t *testing.T) {
		got := SanitizeConnectOptions(map[string]any{
			"readyTimeoutMs":        float64(5000),
			"keepaliveIntervalMs":   "30000",
			"keepaliveCountMax":     float64(3),
			"compress":              true,
			"family":                float64(4),
			"localAddress":          " 192.168.1.2 ",
			"strictHostKeyChecking": "accept-new",
			"proxyCommand":          "nc %h %p",
		})
		if got == nil {
			t.Fatal("期望非 nil")
		}
		if *got.ReadyTimeoutMs != 5000 || *got.KeepaliveIntervalMs != 30000 || *got.KeepaliveCountMax != 3 {
			t.Fatalf("数字字段: %+v", got)
		}
		if !got.Compress || got.Family != 4 || got.LocalAddress != "192.168.1.2" {
			t.Fatalf("%+v", got)
		}
		if got.StrictHostKeyChecking != "accept-new" || got.ProxyCommand != "nc %h %p" {
			t.Fatalf("%+v", got)
		}
	})
	t.Run("越界字段丢弃", func(t *testing.T) {
		got := SanitizeConnectOptions(map[string]any{
			"readyTimeoutMs":        float64(300_001),
			"keepaliveIntervalMs":   float64(-1),
			"keepaliveCountMax":     float64(101),
			"family":                float64(5),
			"strictHostKeyChecking": "maybe",
			"localAddress":          "   ",
		})
		if got != nil {
			t.Fatalf("全部非法应为 nil，得到 %+v", got)
		}
	})
	t.Run("ProxyCommand 拒绝换行和 none", func(t *testing.T) {
		for _, bad := range []string{"nc %h %p\nrm -rf /", "nc %h %p\r\nx", "None", "  "} {
			got := SanitizeConnectOptions(map[string]any{"proxyCommand": bad})
			if got != nil {
				t.Fatalf("proxyCommand %q 应被拒绝，得到 %+v", bad, got)
			}
		}
	})
	t.Run("算法名单净化保留前缀", func(t *testing.T) {
		got := SanitizeConnectOptions(map[string]any{
			"algorithms": map[string]any{
				"cipher": []any{"aes256-gcm@openssh.com", "+aes128-ctr", "bad name!", "^chacha20-poly1305@openssh.com"},
			},
		})
		if got == nil || got.Algorithms == nil {
			t.Fatal("期望算法被收下")
		}
		want := []string{"aes256-gcm@openssh.com", "+aes128-ctr", "^chacha20-poly1305@openssh.com"}
		if !reflect.DeepEqual(got.Algorithms.Cipher, want) {
			t.Fatalf("Cipher = %v, want %v", got.Algorithms.Cipher, want)
		}
	})
	t.Run("extraJumps 过滤坏条目", func(t *testing.T) {
		got := SanitizeConnectOptions(map[string]any{
			"extraJumps": []any{
				map[string]any{"host": "jump1", "port": float64(22), "username": "u"},
				map[string]any{"host": "", "port": float64(22)},
				map[string]any{"host": "jump2", "port": float64(70000)},
				"not-an-object",
			},
		})
		if got == nil || len(got.ExtraJumps) != 1 || got.ExtraJumps[0].Host != "jump1" {
			t.Fatalf("ExtraJumps = %+v", got)
		}
	})
}

func TestOptionsForSession(t *testing.T) {
	withJumps := &ConnectOptions{ExtraJumps: []Hop{{Host: "j2", Port: 22}}}
	t.Run("没有第一跳时丢弃后续跳板", func(t *testing.T) {
		if got := OptionsForSession("", withJumps); got != nil {
			t.Fatalf("got %+v", got)
		}
		if got := OptionsForSession("  ", withJumps); got != nil {
			t.Fatalf("got %+v", got)
		}
	})
	t.Run("有第一跳时保留", func(t *testing.T) {
		got := OptionsForSession("jump1", withJumps)
		if got == nil || len(got.ExtraJumps) != 1 {
			t.Fatalf("got %+v", got)
		}
	})
	t.Run("还有其他字段时不因丢跳板而清空", func(t *testing.T) {
		opts := &ConnectOptions{Compress: true, ExtraJumps: []Hop{{Host: "j2", Port: 22}}}
		got := OptionsForSession("", opts)
		if got == nil || !got.Compress || got.ExtraJumps != nil {
			t.Fatalf("got %+v", got)
		}
	})
}

func TestHasConnectOptions(t *testing.T) {
	if HasConnectOptions(nil) || HasConnectOptions(&ConnectOptions{}) {
		t.Fatal("空选项应为 false")
	}
	zero := 0
	if !HasConnectOptions(&ConnectOptions{ReadyTimeoutMs: &zero}) {
		t.Fatal("显式 0 超时应算有效选项")
	}
}
