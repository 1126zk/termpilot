package storage

import (
	"encoding/base64"
	"strings"
	"testing"
)

// fakeCipher 用可逆变换模拟 safeStorage，避免单测依赖真实系统钥匙串。
type fakeCipher struct{}

func (fakeCipher) IsAvailable() bool { return true }

func (fakeCipher) EncryptString(plain string) (string, error) {
	b := []byte(plain)
	for i, j := 0, len(b)-1; i < j; i, j = i+1, j-1 {
		b[i], b[j] = b[j], b[i]
	}
	return base64.StdEncoding.EncodeToString(b), nil
}

func (fakeCipher) DecryptString(ciphertextB64 string) (string, error) {
	b, err := base64.StdEncoding.DecodeString(ciphertextB64)
	if err != nil {
		return "", err
	}
	for i, j := 0, len(b)-1; i < j; i, j = i+1, j-1 {
		b[i], b[j] = b[j], b[i]
	}
	return string(b), nil
}

func strPtr(s string) *string { return &s }
func intP(v int) *int         { return &v }

func newStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(t.TempDir(), fakeCipher{})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

type hookRecorder struct {
	saved   []*SessionConfig
	deleted []string
	aliases []string
}

func (h *hookRecorder) OnSessionSaved(s *SessionConfig) { h.saved = append(h.saved, s) }
func (h *hookRecorder) OnSessionDeleted(id, alias string) {
	h.deleted = append(h.deleted, id)
	h.aliases = append(h.aliases, alias)
}

func TestSchemaAndWAL(t *testing.T) {
	s := newStore(t)
	var mode string
	if err := s.db.QueryRow("PRAGMA journal_mode").Scan(&mode); err != nil {
		t.Fatal(err)
	}
	if mode != "wal" {
		t.Fatalf("journal_mode = %q, want wal", mode)
	}
	tables := map[string]bool{}
	rows, err := s.db.Query("SELECT name FROM sqlite_master WHERE type = 'table'")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		tables[name] = true
	}
	for _, want := range []string{"sessions", "mcp_config", "appearance", "host_notes", "mcp_audit", "snippets", "history"} {
		if !tables[want] {
			t.Fatalf("缺表 %s，现有 %v", want, tables)
		}
	}
	indexes := map[string]bool{}
	rows2, err := s.db.Query("SELECT name FROM sqlite_master WHERE type = 'index'")
	if err != nil {
		t.Fatal(err)
	}
	defer rows2.Close()
	for rows2.Next() {
		var name string
		if err := rows2.Scan(&name); err != nil {
			t.Fatal(err)
		}
		indexes[name] = true
	}
	if !indexes["sessions_public_id"] || !indexes["sessions_config_host"] {
		t.Fatalf("缺索引，现有 %v", indexes)
	}
	// 抽查 sessions 列（与 Electron 版逐一对应）
	cols := map[string]bool{}
	rows3, err := s.db.Query("SELECT name FROM pragma_table_info('sessions')")
	if err != nil {
		t.Fatal(err)
	}
	defer rows3.Close()
	for rows3.Next() {
		var name string
		if err := rows3.Scan(&name); err != nil {
			t.Fatal(err)
		}
		cols[name] = true
	}
	for _, want := range []string{"id", "public_id", "name", "group_name", "host", "port", "username",
		"remark", "secret_encrypted", "jump_host", "jump_port", "jump_username", "jump_secret_encrypted",
		"ssh_options", "config_host", "forwards", "os", "created_at", "updated_at"} {
		if !cols[want] {
			t.Fatalf("sessions 缺列 %s", want)
		}
	}
}

func TestSessionCRUD(t *testing.T) {
	s := newStore(t)
	hook := &hookRecorder{}
	s.AddSyncHook(hook)

	created, err := s.Create(&SessionInput{
		Name: "百度云服务器", Group: "生产", Host: "1.2.3.4", Port: 22, Username: "root",
		Remark: strPtr("主力机"), Secret: strPtr("p@ssw0rd"),
		JumpHost: strPtr("10.0.0.1"), JumpPort: intP(2222), JumpUsername: strPtr("ops"),
		JumpSecret: strPtr("jump-pw"),
		SshOptions: &SshConnectOptions{ReadyTimeoutMs: intP(15000), Family: 4},
		Forwards:   &[]ForwardRule{{Type: "local", ListenPort: 8080, TargetPort: 80}},
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if !strings.HasPrefix(created.PublicID, "conn-") || len(created.PublicID) != 13 {
		t.Fatalf("PublicID 格式不对: %q", created.PublicID)
	}
	if !created.HasSecret || !created.HasJumpSecret {
		t.Fatal("密文标志位不对")
	}
	if created.JumpHost == nil || *created.JumpHost != "10.0.0.1" || created.JumpPort == nil || *created.JumpPort != 2222 {
		t.Fatalf("跳板字段不对: %+v", created)
	}
	if created.SshOptions == nil || created.SshOptions.ReadyTimeoutMs == nil || *created.SshOptions.ReadyTimeoutMs != 15000 {
		t.Fatalf("sshOptions 没存住: %+v", created.SshOptions)
	}
	if len(created.Forwards) != 1 || created.Forwards[0].ListenPort != 8080 {
		t.Fatalf("forwards 没存住: %+v", created.Forwards)
	}
	if secret, _ := s.GetSecret(created.ID); secret != "p@ssw0rd" {
		t.Fatalf("GetSecret = %q", secret)
	}
	if secret, _ := s.GetJumpSecret(created.ID); secret != "jump-pw" {
		t.Fatalf("GetJumpSecret = %q", secret)
	}
	if len(hook.saved) != 1 {
		t.Fatalf("钩子应触发 1 次，实际 %d", len(hook.saved))
	}

	// 部分更新：Secret=nil 保留原密文；Forwards=nil 保留
	updated, err := s.Update(created.ID, &SessionInput{
		Name: "改名后", Group: "生产", Host: "1.2.3.4", Port: 22, Username: "root",
	})
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if updated.Name != "改名后" || !updated.HasSecret || len(updated.Forwards) != 1 {
		t.Fatalf("部分更新语义不对: %+v", updated)
	}
	if secret, _ := s.GetSecret(created.ID); secret != "p@ssw0rd" {
		t.Fatalf("未提交的 secret 被清了: %q", secret)
	}
	// 空串清凭据；空结构清 sshOptions；空切片清 forwards
	updated, err = s.Update(created.ID, &SessionInput{
		Name: "改名后", Group: "生产", Host: "1.2.3.4", Port: 22, Username: "root",
		Secret: strPtr(""), SshOptions: &SshConnectOptions{}, Forwards: &[]ForwardRule{},
	})
	if err != nil {
		t.Fatalf("Update2: %v", err)
	}
	if updated.HasSecret || updated.SshOptions != nil || updated.Forwards != nil {
		t.Fatalf("清除语义不对: %+v", updated)
	}

	// 更新不存在的会话
	got, err := s.Update("no-such-id", &SessionInput{Name: "x"})
	if err != nil || got != nil {
		t.Fatalf("Update 不存在应返回 (nil,nil)，实际 %v %v", got, err)
	}

	// 复制：密文原样带过去
	secret := "copy-me"
	dup, err := s.Duplicate(created.ID)
	if err != nil || dup == nil {
		t.Fatalf("Duplicate: %v", err)
	}
	if dup.Name != "改名后 副本" {
		t.Fatalf("副本名 = %q", dup.Name)
	}
	dup2, _ := s.Duplicate(created.ID)
	if dup2.Name != "改名后 副本 2" {
		t.Fatalf("第二个副本名 = %q", dup2.Name)
	}
	if _, err := s.Update(created.ID, &SessionInput{
		Name: "改名后", Group: "生产", Host: "h", Port: 22, Username: "u", Secret: &secret,
	}); err != nil {
		t.Fatal(err)
	}
	dup3, _ := s.Duplicate(created.ID)
	if got, _ := s.GetSecret(dup3.ID); got != "copy-me" {
		t.Fatalf("副本凭据丢了: %q", got)
	}

	// SetOs
	if err := s.SetOs(created.ID, "debian"); err != nil {
		t.Fatal(err)
	}
	back, _ := s.Get(created.ID)
	if back.Os == nil || *back.Os != "debian" {
		t.Fatalf("os 没存住: %+v", back.Os)
	}

	// 删除 + 钩子
	if err := s.SetConfigHost(created.ID, "my-alias"); err != nil {
		t.Fatal(err)
	}
	ok, err := s.Delete(created.ID)
	if err != nil || !ok {
		t.Fatalf("Delete: %v %v", ok, err)
	}
	if len(hook.deleted) != 1 || hook.aliases[0] != "my-alias" {
		t.Fatalf("删除钩子不对: %+v", hook)
	}
	ok, _ = s.Delete(created.ID)
	if ok {
		t.Fatal("重复删除应返回 false")
	}
}

func TestPublicIDUnique(t *testing.T) {
	s := newStore(t)
	seen := map[string]bool{}
	for i := 0; i < 50; i++ {
		c, err := s.Create(&SessionInput{Name: "s", Group: "", Host: "h", Port: 22, Username: "u"})
		if err != nil {
			t.Fatal(err)
		}
		if seen[c.PublicID] {
			t.Fatalf("PublicID 重复: %s", c.PublicID)
		}
		seen[c.PublicID] = true
	}
	list, err := s.List()
	if err != nil || len(list) != 50 {
		t.Fatalf("List: %v %d", err, len(list))
	}
}

func TestHostNotes(t *testing.T) {
	s := newStore(t)
	notes, err := s.SetHostNote("[FE80::1] ", "  跳板机  ")
	if err != nil {
		t.Fatal(err)
	}
	if notes["fe80::1"] != "跳板机" {
		t.Fatalf("host key 归一化不对: %+v", notes)
	}
	// 覆盖
	if _, err := s.SetHostNote("fe80::1", "新备注"); err != nil {
		t.Fatal(err)
	}
	notes, _ = s.ListHostNotes()
	if notes["fe80::1"] != "新备注" {
		t.Fatalf("覆盖失败: %+v", notes)
	}
	// 超长截断到 80
	long := strings.Repeat("长", 100)
	notes, _ = s.SetHostNote("a", long)
	if len([]rune(notes["a"])) != 80 {
		t.Fatalf("截断不对: %d", len([]rune(notes["a"])))
	}
	// 空备注删除
	notes, _ = s.SetHostNote("a", "")
	if _, ok := notes["a"]; ok {
		t.Fatal("空备注应删除")
	}
}

func TestAppearance(t *testing.T) {
	s := newStore(t)
	def, err := s.GetAppearance()
	if err != nil {
		t.Fatal(err)
	}
	if def != DefaultAppearance {
		t.Fatalf("默认外观 = %+v", def)
	}
	saved, err := s.SaveAppearance(Appearance{
		Theme: "dracula", TerminalFont: " Consolas ", TerminalSize: 16, ExperimentalScreenshot: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if saved.TerminalFont != "Consolas" || saved.TerminalSize != 16 || !saved.ExperimentalScreenshot {
		t.Fatalf("保存结果 = %+v", saved)
	}
	back, _ := s.GetAppearance()
	if back.Theme != "dracula" || back.TerminalSize != 16 {
		t.Fatalf("读回 = %+v", back)
	}
	// 废弃 id 映射 + 非法字号回落
	weird, _ := s.SaveAppearance(Appearance{Theme: "dark", TerminalFont: "x", TerminalSize: 99})
	if weird.Theme != "termius-dark" || weird.TerminalSize != 14 {
		t.Fatalf("回落不对: %+v", weird)
	}
	unknown, _ := s.SaveAppearance(Appearance{Theme: "不存在的主题"})
	if unknown.Theme != "termius-dark" {
		t.Fatalf("未知主题应回落深色: %+v", unknown)
	}
}

func TestSnippets(t *testing.T) {
	s := newStore(t)
	a, err := s.CreateSnippet(" 列表 ", "ls -la")
	if err != nil {
		t.Fatal(err)
	}
	if a.Name != "列表" {
		t.Fatalf("name 应 trim: %q", a.Name)
	}
	if _, err := s.CreateSnippet("", "pwd"); err != nil {
		t.Fatal(err)
	}
	if err := s.UpdateSnippet(a.ID, "改名", "ls -lah"); err != nil {
		t.Fatal(err)
	}
	list, _ := s.ListSnippets()
	if len(list) != 2 || list[0].Name != "改名" || list[0].Command != "ls -lah" {
		t.Fatalf("列表不对: %+v", list)
	}
	if err := s.DeleteSnippet(a.ID); err != nil {
		t.Fatal(err)
	}
	list, _ = s.ListSnippets()
	if len(list) != 1 {
		t.Fatalf("删除后应剩 1 条: %+v", list)
	}
}

func TestHistory(t *testing.T) {
	s := newStore(t)
	// 太短的命令不记
	if ok, _ := s.AppendHistory("term-1", "x"); ok {
		t.Fatal("单字符不应入库")
	}
	if ok, _ := s.AppendHistory("term-1", "ls -la"); !ok {
		t.Fatal("应写入")
	}
	// 连续重复不记
	if ok, _ := s.AppendHistory("term-1", "ls -la"); ok {
		t.Fatal("连续重复不应入库")
	}
	if ok, _ := s.AppendHistory("term-1", "pwd"); !ok {
		t.Fatal("应写入")
	}
	// 非连续重复可以记
	if ok, _ := s.AppendHistory("term-1", "ls -la"); !ok {
		t.Fatal("非连续重复应写入")
	}
	list, _ := s.ListHistory("term-1")
	if len(list) != 3 || list[0].Command != "ls -la" || list[2].Command != "ls -la" {
		t.Fatalf("顺序（新→旧）不对: %+v", list)
	}
	// 按终端隔离
	if ok, _ := s.AppendHistory("term-2", "echo hi"); !ok {
		t.Fatal()
	}
	list2, _ := s.ListHistory("term-2")
	if len(list2) != 1 {
		t.Fatalf("term-2 应只有 1 条: %+v", list2)
	}
	// 只留最近 200 条
	for i := 0; i < 205; i++ {
		if _, err := s.AppendHistory("term-3", strings.Repeat("a", 2)+strings.Repeat("b", i%3)+string(rune('a'+i%26))+strings.Repeat("c", i%7)); err != nil {
			t.Fatal(err)
		}
	}
	var count int
	if err := s.db.QueryRow("SELECT COUNT(*) FROM history WHERE term_id = 'term-3'").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count > 200 {
		t.Fatalf("历史应封顶 200，实际 %d", count)
	}
	if err := s.ClearHistory("term-1"); err != nil {
		t.Fatal(err)
	}
	list, _ = s.ListHistory("term-1")
	if len(list) != 0 {
		t.Fatalf("清空失败: %+v", list)
	}
}

func TestMcpSettings(t *testing.T) {
	s := newStore(t)
	var written []McpSettings
	s.SetMcpSettingsWriter(func(m McpSettings) error {
		written = append(written, m)
		return nil
	})
	got, err := s.GetMcpSettings()
	if err != nil {
		t.Fatal(err)
	}
	if got.Enabled || got.Port != MCPDefaultPort || got.Host != MCPHost || !got.ConfirmDangerous {
		t.Fatalf("默认 MCP 配置不对: %+v", got)
	}
	if len(got.Token) != 32 {
		t.Fatalf("令牌应是 24 字节 base64url = 32 字符，实际 %d", len(got.Token))
	}
	if len(written) != 1 {
		t.Fatalf("mcp.json 钩子应触发一次，实际 %d", len(written))
	}
	// 再取一次：令牌稳定
	again, _ := s.GetMcpSettings()
	if again.Token != got.Token {
		t.Fatal("令牌不应变化")
	}
	// 校验
	if _, err := s.SaveMcpSettings(&McpSettingsInput{Port: 70000, Token: strings.Repeat("a", 16)}); err == nil ||
		!strings.Contains(err.Error(), "端口需要在 1–65535") {
		t.Fatalf("端口校验: %v", err)
	}
	if _, err := s.SaveMcpSettings(&McpSettingsInput{Port: 3927, Token: "short"}); err == nil ||
		!strings.Contains(err.Error(), "令牌至少 16 位") {
		t.Fatalf("令牌校验: %v", err)
	}
	newToken := strings.Repeat("b", 24)
	saved, err := s.SaveMcpSettings(&McpSettingsInput{Enabled: true, Port: 4000, Token: newToken, ConfirmDangerous: false})
	if err != nil {
		t.Fatal(err)
	}
	if !saved.Enabled || saved.Port != 4000 || saved.Token != newToken || saved.ConfirmDangerous {
		t.Fatalf("保存结果不对: %+v", saved)
	}

	// 审计
	for i := 0; i < 45; i++ {
		if err := s.AppendAudit("term_exec", i%2 == 0, strings.Repeat("d", i)); err != nil {
			t.Fatal(err)
		}
	}
	audit, err := s.ListAudit(0)
	if err != nil {
		t.Fatal(err)
	}
	if len(audit) != 40 {
		t.Fatalf("默认 limit 40，实际 %d", len(audit))
	}
	if audit[0].Detail != strings.Repeat("d", 44) {
		t.Fatal("审计应按 id 倒序（最新在前）")
	}
	// detail 截断 500
	if err := s.AppendAudit("tool", true, strings.Repeat("x", 600)); err != nil {
		t.Fatal(err)
	}
	audit, _ = s.ListAudit(1)
	if len([]rune(audit[0].Detail)) != 500 {
		t.Fatalf("detail 截断不对: %d", len([]rune(audit[0].Detail)))
	}
}

func TestNoCipher(t *testing.T) {
	s, err := Open(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err := s.Create(&SessionInput{
		Name: "x", Group: "", Host: "h", Port: 22, Username: "u", Secret: strPtr("pw"),
	}); err == nil || !strings.Contains(err.Error(), "系统钥匙串不可用") {
		t.Fatalf("无 cipher 时应拒绝存凭据: %v", err)
	}
}

func TestReopenPersists(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir, fakeCipher{})
	if err != nil {
		t.Fatal(err)
	}
	c, err := s.Create(&SessionInput{
		Name: "持久", Group: "", Host: "h", Port: 22, Username: "u", Secret: strPtr("pw1"),
	})
	if err != nil {
		t.Fatal(err)
	}
	s.Close()

	s2, err := Open(dir, fakeCipher{})
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	back, err := s2.Get(c.ID)
	if err != nil || back == nil {
		t.Fatalf("重开后读不到: %v", err)
	}
	if secret, _ := s2.GetSecret(c.ID); secret != "pw1" {
		t.Fatalf("重开后密文解不开: %q", secret)
	}
}
