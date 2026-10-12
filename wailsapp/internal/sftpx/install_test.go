package sftpx

import (
	"strings"
	"testing"
)

func TestParseInstallResult(t *testing.T) {
	// switched：改成功了
	outcome, note := parseInstallResult(0, []string{"当前子系统: /usr/lib/openssh/sftp-server", "已改成 internal-sftp", "TERMPILOT_SFTP switched"})
	if outcome != installSwitched {
		t.Fatalf("应该识别 switched: %v", outcome)
	}
	if len(note) != 2 || note[0] != "当前子系统: /usr/lib/openssh/sftp-server" {
		t.Errorf("说明行应该去掉标记行: %v", note)
	}

	// already：本来就是 internal-sftp
	outcome, note = parseInstallResult(0, []string{"TERMPILOT_SFTP already"})
	if outcome != installAlready {
		t.Fatalf("应该识别 already: %v", outcome)
	}
	if len(note) != 0 {
		t.Errorf("already 不该有说明行: %v", note)
	}

	// 失败：非零退出码
	outcome, note = parseInstallResult(1, []string{"没有 sshd，不能改成内置 SFTP"})
	if outcome != installFailed {
		t.Fatalf("退出码 1 应该是 failed: %v", outcome)
	}
	if len(note) != 1 || note[0] != "没有 sshd，不能改成内置 SFTP" {
		t.Errorf("失败时说明行要保留: %v", note)
	}

	// 失败：退出码 0 但没标记（脚本被环境问题截断等）
	outcome, _ = parseInstallResult(0, []string{"一些输出"})
	if outcome != installFailed {
		t.Fatalf("没标记应该是 failed: %v", outcome)
	}

	// 退出码非零时标记不算数
	outcome, _ = parseInstallResult(1, []string{"TERMPILOT_SFTP switched"})
	if outcome != installFailed {
		t.Fatalf("非零退出码的标记不算数: %v", outcome)
	}
}

func TestLineCollector(t *testing.T) {
	var logged []string
	c := &lineCollector{onLog: func(line string) { logged = append(logged, line) }}

	// 跨块拼行、CRLF、空行跳过
	if _, err := c.Write([]byte("第一")); err != nil {
		t.Fatal(err)
	}
	if len(c.lines) != 0 {
		t.Fatal("没换行不该出行")
	}
	c.Write([]byte("行\r\n\r\nsecond\nthi"))
	c.Write([]byte("rd\r\n"))
	if got := strings.Join(c.lines, "|"); got != "第一行|second|third" {
		t.Errorf("行拆分不对: %q", got)
	}
	if len(logged) != 3 {
		t.Errorf("onLog 应该每行一次: %v", logged)
	}

	// 收尾：残留的非空尾巴 trim 后收进去
	c.Write([]byte("  尾巴没有换行  "))
	c.Flush()
	if got := c.lines[len(c.lines)-1]; got != "尾巴没有换行" {
		t.Errorf("Flush 应该 trim 残留: %q", got)
	}
	c.Flush()
	if len(c.lines) != 4 {
		t.Errorf("重复 Flush 不该重复收: %v", c.lines)
	}
}

func TestEmbeddedInstallScript(t *testing.T) {
	script, err := EmbeddedInstallScript()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(script, "\r") {
		t.Error("脚本应该统一成 LF")
	}
	if !strings.Contains(script, "TERMPILOT_SFTP switched") || !strings.Contains(script, "TERMPILOT_SFTP already") {
		t.Error("脚本应该带两个结果标记")
	}
	if !strings.HasPrefix(script, "#!/bin/sh") {
		t.Error("脚本应该以 shebang 开头")
	}
}
