package mcpx

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// TestDangerousRegex 危险命令正则与 TS DANGEROUS 同语义。
func TestDangerousRegex(t *testing.T) {
	dangerous := []string{
		"rm -rf /tmp/x",
		"sudo rm -rf /",
		"ls; rm x",
		"ls && rmdir y",
		"dd if=/dev/zero of=/dev/sda",
		"mkfs.ext4 /dev/sda1",
		"shutdown -h now",
		"reboot",
		"poweroff",
		"halt",
		"chmod -R 777 /data",
		"chown -R root:root /data",
		"echo x > /etc/hosts",
		"cat x > /dev/sda",
		"ls\nrm x",
	}
	for _, cmd := range dangerous {
		if !dangerousRe.MatchString(cmd) {
			t.Errorf("应判危险: %q", cmd)
		}
	}
	safe := []string{
		"ls -la",
		"grep rm README.md",
		"format disk",
		"npm run build",
		"chmod +x run.sh",
		"echo hello > /tmp/out.txt",
		"cat /etc/hostname",
	}
	for _, cmd := range safe {
		if dangerousRe.MatchString(cmd) {
			t.Errorf("不应判危险: %q", cmd)
		}
	}
}

// TestSensitiveRegex 敏感路径正则与 TS SENSITIVE 同语义。
func TestSensitiveRegex(t *testing.T) {
	sensitive := []string{
		"/etc", "/etc/nginx", "/boot/vmlinuz", "/bin/sh", "/sbin/init",
		"/usr/local", "/dev/sda", "/sys/kernel", "/proc/cpuinfo",
		`C:\Windows\System32`, `c:\windows\`, `D:\Windows\temp`,
	}
	for _, p := range sensitive {
		if !sensitiveRe.MatchString(p) {
			t.Errorf("应判敏感: %q", p)
		}
	}
	safe := []string{
		"/home/user/file", "etc/hosts", "/tmp/etc-backup", `/usr2/x`, "C:\\WindowsOld\\x",
	}
	for _, p := range safe {
		if sensitiveRe.MatchString(p) {
			t.Errorf("不应判敏感: %q", p)
		}
	}
}

// TestGuardConfirmPaths 危险确认：放行 / 拒绝 / 超时 / 开关关闭。
func TestGuardConfirmPaths(t *testing.T) {
	ctx := context.Background()

	// 放行
	svc, st, _, _, exec := newTestService()
	var asked atomic.Int32
	svc.deps.Confirm = func(_ context.Context, command string) (bool, error) {
		asked.Add(1)
		if command != "sudo rm -rf /tmp/x" {
			t.Errorf("确认内容: %q", command)
		}
		return true, nil
	}
	out, err := svc.invoke(ctx, "term_exec", map[string]any{
		"connection": "conn-1234abcd", "command": "sudo rm -rf /tmp/x",
	})
	if err != nil || !strings.Contains(out, "hello") {
		t.Errorf("放行: out=%q err=%v", out, err)
	}
	if asked.Load() != 1 {
		t.Errorf("应询问 1 次, got %d", asked.Load())
	}
	if exec.lastSessionID != "s1" || exec.lastOpts.TimeoutMs != 20_000 || exec.lastOpts.MaxBytes != 50_000 {
		t.Errorf("exec 参数: %+v", exec.lastOpts)
	}

	// 拒绝
	svc, st2, _, _, _ := newTestService()
	svc.deps.Confirm = func(context.Context, string) (bool, error) { return false, nil }
	_, err = svc.invoke(ctx, "term_exec", map[string]any{
		"connection": "conn-1234abcd", "command": "rm -rf /tmp/x",
	})
	if err == nil || !strings.Contains(err.Error(), "已取消：危险操作未确认") {
		t.Errorf("拒绝: err=%v", err)
	}

	// 超时（缩小超时，回调不应答 → 按拒绝）
	svc, _, _, _, _ = newTestService()
	restore := confirmTimeout
	confirmTimeout = 50 * time.Millisecond
	defer func() { confirmTimeout = restore }()
	svc.deps.Confirm = func(ctx context.Context, _ string) (bool, error) {
		select {} // 永不回答
	}
	_, err = svc.invoke(ctx, "term_exec", map[string]any{
		"connection": "conn-1234abcd", "command": "rm x",
	})
	if err == nil || !strings.Contains(err.Error(), "已取消：危险操作未确认") {
		t.Errorf("超时: err=%v", err)
	}

	// 开关关闭：不问直接跑
	svc, st3, _, _, _ := newTestService()
	st3.settings.ConfirmDangerous = false
	svc.deps.Confirm = func(context.Context, string) (bool, error) {
		t.Error("开关关闭时不应询问")
		return false, nil
	}
	if _, err := svc.invoke(ctx, "term_exec", map[string]any{
		"connection": "conn-1234abcd", "command": "rm x",
	}); err != nil {
		t.Errorf("开关关闭: err=%v", err)
	}

	// 确认回调不可用（无窗口）
	svc, _, _, _, _ = newTestService()
	_, err = svc.invoke(ctx, "term_exec", map[string]any{
		"connection": "conn-1234abcd", "command": "rm x",
	})
	if err == nil || !strings.Contains(err.Error(), "窗口不可用，无法确认危险操作") {
		t.Errorf("无窗口: err=%v", err)
	}

	_ = st
	_ = st2
}

// TestGuardSensitivePath 敏感路径触发确认（sftp_mkdir）。
func TestGuardSensitivePath(t *testing.T) {
	ctx := context.Background()
	svc, _, _, sftp, _ := newTestService()
	var gotPath string
	svc.deps.Confirm = func(_ context.Context, p string) (bool, error) {
		gotPath = p
		return true, nil
	}
	out, err := svc.invoke(ctx, "sftp_mkdir", map[string]any{
		"connection": "conn-1234abcd", "path": "/etc/termpilot",
	})
	if err != nil || out != "已创建 /etc/termpilot" {
		t.Errorf("敏感路径放行: out=%q err=%v", out, err)
	}
	if gotPath != "/etc/termpilot" {
		t.Errorf("确认内容应是路径: %q", gotPath)
	}
	if len(sftp.made) != 1 {
		t.Errorf("mkdir 未执行: %v", sftp.made)
	}

	// 非敏感路径不问
	svc2, _, _, sftp2, _ := newTestService()
	svc2.deps.Confirm = func(context.Context, string) (bool, error) {
		t.Error("非敏感路径不应询问")
		return false, nil
	}
	if _, err := svc2.invoke(ctx, "sftp_mkdir", map[string]any{
		"connection": "conn-1234abcd", "path": "/home/u/dir",
	}); err != nil {
		t.Errorf("非敏感路径: err=%v", err)
	}
	if len(sftp2.made) != 1 {
		t.Errorf("mkdir 未执行: %v", sftp2.made)
	}

	// 敏感路径 + 拒绝
	svc3, _, _, sftp3, _ := newTestService()
	svc3.deps.Confirm = func(context.Context, string) (bool, error) { return false, nil }
	_, err = svc3.invoke(ctx, "sftp_remove", map[string]any{
		"connection": "conn-1234abcd", "path": "/etc/passwd", "kind": "file",
	})
	// sftp_remove 走的是 guard('rm ' + path)：命中 rm 正则
	if err == nil || !strings.Contains(err.Error(), "已取消：危险操作未确认") {
		t.Errorf("sftp_remove 拒绝: err=%v", err)
	}
	if len(sftp3.removed) != 0 {
		t.Errorf("不应执行 remove: %v", sftp3.removed)
	}
}

// TestDeleteSessionConfirm connection_delete 的确认文案与拒绝语义。
func TestDeleteSessionConfirm(t *testing.T) {
	ctx := context.Background()
	svc, st, _, _, _ := newTestService()
	svc.deps.Confirm = func(_ context.Context, command string) (bool, error) {
		if command != "删除连接 web" {
			t.Errorf("确认内容: %q", command)
		}
		return false, nil
	}
	_, err := svc.invoke(ctx, "connection_delete", map[string]any{"connection": "conn-1234abcd"})
	if err == nil || !strings.Contains(err.Error(), "已取消：删除未确认") {
		t.Errorf("删除拒绝: err=%v", err)
	}
	if len(st.deleted) != 0 {
		t.Errorf("不应删除: %v", st.deleted)
	}
}

// TestRunAudit 审计字段与 TS appendAudit 一致：tool/ok/detail，失败时 detail 带错误消息。
func TestRunAudit(t *testing.T) {
	svc, st, _, _, _ := newTestService()

	// 成功：detail 是 `k=v` 拼接，secret 不出现
	result := svc.run("connection_create", auditDetail(map[string]any{
		"name": "db", "host": "2.2.2.2", "secret": "topsecret", "port": float64(22),
	}), func() (string, error) {
		return `{"id":"conn-new0001"}`, nil
	})
	if result.IsError {
		t.Fatal("不应 isError")
	}
	if len(st.audit) != 1 {
		t.Fatalf("审计条数: %d", len(st.audit))
	}
	rec := st.audit[0]
	if rec.tool != "connection_create" || !rec.ok {
		t.Errorf("审计: %+v", rec)
	}
	if strings.Contains(rec.detail, "secret") || strings.Contains(rec.detail, "topsecret") {
		t.Errorf("secret 泄漏进审计: %q", rec.detail)
	}
	for _, frag := range []string{"name=db", "host=2.2.2.2", "port=22"} {
		if !strings.Contains(rec.detail, frag) {
			t.Errorf("审计 detail 缺 %q: %q", frag, rec.detail)
		}
	}

	// 失败：detail 尾部带错误消息
	result = svc.run("term_read", "termId=term-12345678", func() (string, error) {
		return "", errors.New("终端不存在或已断开")
	})
	if !result.IsError {
		t.Fatal("应 isError")
	}
	rec = st.audit[1]
	if rec.ok || rec.detail != "termId=term-12345678 终端不存在或已断开" {
		t.Errorf("失败审计: %+v", rec)
	}
	text := resultText(result)
	if text != "终端不存在或已断开" {
		t.Errorf("isError 文本: %q", text)
	}
}
