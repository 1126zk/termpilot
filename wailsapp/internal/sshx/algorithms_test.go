package sshx

import (
	"reflect"
	"slices"
	"testing"

	"golang.org/x/crypto/ssh"
)

func TestResolveAlgorithmList(t *testing.T) {
	base := []string{"a", "b", "c"}
	cases := []struct {
		name   string
		values []string
		base   []string
		want   []string
	}{
		{"空列表保持默认", nil, base, nil},
		{"无前缀整体替换", []string{"x", "y"}, base, []string{"x", "y"}},
		// 与 ssh2 一致：只要有无前缀条目，前缀条目全部被忽略。
		{"混合时前缀被忽略", []string{"+tail", "x", "^head"}, base, []string{"x"}},
		{"追加", []string{"+d"}, base, []string{"a", "b", "c", "d"}},
		{"前插", []string{"^z"}, base, []string{"z", "a", "b", "c"}},
		{"删除", []string{"-b"}, base, []string{"a", "c"}},
		{"组合", []string{"-b", "^z", "+d"}, base, []string{"z", "a", "c", "d"}},
		{"前插已存在的名字去重", []string{"^b"}, base, []string{"b", "a", "c"}},
		{"追加已存在的名字去重", []string{"+a"}, base, []string{"b", "c", "a"}},
		{"删除不存在的名字无影响", []string{"-nope"}, base, []string{"a", "b", "c"}},
		{"保持前缀条目顺序", []string{"+d", "+e", "^y", "^z"}, base, []string{"y", "z", "a", "b", "c", "d", "e"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ResolveAlgorithmList(tc.values, tc.base)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("ResolveAlgorithmList(%v, %v) = %v, want %v", tc.values, tc.base, got, tc.want)
			}
		})
	}
}

func TestApplyAlgorithms(t *testing.T) {
	t.Run("无选项保持默认", func(t *testing.T) {
		cfg := &ssh.ClientConfig{}
		applyAlgorithms(cfg, nil)
		if cfg.Ciphers != nil || cfg.KeyExchanges != nil || cfg.MACs != nil || cfg.HostKeyAlgorithms != nil {
			t.Fatalf("期望全部保持默认，得到 %+v", cfg.Config)
		}
	})
	t.Run("整体替换加密算法", func(t *testing.T) {
		cfg := &ssh.ClientConfig{}
		applyAlgorithms(cfg, &ConnectOptions{Algorithms: &AlgorithmOptions{Cipher: []string{"aes256-gcm@openssh.com"}}})
		if !reflect.DeepEqual(cfg.Ciphers, []string{"aes256-gcm@openssh.com"}) {
			t.Fatalf("Ciphers = %v", cfg.Ciphers)
		}
	})
	t.Run("基于默认列表删除", func(t *testing.T) {
		cfg := &ssh.ClientConfig{}
		supported := ssh.SupportedAlgorithms()
		victim := supported.Ciphers[0]
		applyAlgorithms(cfg, &ConnectOptions{Algorithms: &AlgorithmOptions{Cipher: []string{"-" + victim}}})
		if slices.Contains(cfg.Ciphers, victim) {
			t.Fatalf("%s 应被删除: %v", victim, cfg.Ciphers)
		}
		if len(cfg.Ciphers) != len(supported.Ciphers)-1 {
			t.Fatalf("删除后期望 %d 个，得到 %d", len(supported.Ciphers)-1, len(cfg.Ciphers))
		}
	})
	t.Run("主机密钥算法落到 HostKeyAlgorithms", func(t *testing.T) {
		cfg := &ssh.ClientConfig{}
		applyAlgorithms(cfg, &ConnectOptions{Algorithms: &AlgorithmOptions{ServerHostKey: []string{"ssh-ed25519"}}})
		if !reflect.DeepEqual(cfg.HostKeyAlgorithms, []string{"ssh-ed25519"}) {
			t.Fatalf("HostKeyAlgorithms = %v", cfg.HostKeyAlgorithms)
		}
	})
	t.Run("kex 前插到默认列表", func(t *testing.T) {
		cfg := &ssh.ClientConfig{}
		supported := ssh.SupportedAlgorithms()
		applyAlgorithms(cfg, &ConnectOptions{Algorithms: &AlgorithmOptions{Kex: []string{"^curve25519-sha256"}}})
		if len(cfg.KeyExchanges) == 0 || cfg.KeyExchanges[0] != "curve25519-sha256" {
			t.Fatalf("KeyExchanges = %v", cfg.KeyExchanges)
		}
		if len(cfg.KeyExchanges) > len(supported.KeyExchanges) {
			t.Fatalf("前插已支持的名字不应变长: %v", cfg.KeyExchanges)
		}
	})
}
