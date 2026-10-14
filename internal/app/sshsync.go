package app

import (
	"log"
	"os"
	"strings"

	"termpilot/internal/sshx"
	"termpilot/internal/storage"
)

// sshSync 对应 StorageService 里 ~/.ssh/config 的导入与写回：
// 启动时把具体 Host 段导入为连接（importSshConfig），会话增删改时写回配置文件
// （publishSsh / dropSshAlias）。writeEnabled 对应 TS 的 sshWrite 开关。
type sshSync struct {
	a            *App
	writeEnabled bool
}

func newSshSync(a *App) *sshSync {
	return &sshSync{a: a, writeEnabled: true}
}

func (s *sshSync) OnSessionSaved(session *storage.SessionConfig) {
	if !s.writeEnabled {
		return
	}
	s.publishSsh(session.ID)
}

func (s *sshSync) OnSessionDeleted(id string, alias string) {
	if alias == "" {
		return
	}
	if err := sshx.RemoveSshHost(alias); err != nil {
		log.Printf("[TermPilot] 从 SSH 配置移除主机失败: %v", err)
	}
}

// importSshConfig 对应 TS importSshConfig：启动时把 ~/.ssh/config 的具体主机读进来。
// 已关联的连接只更新 OpenSSH 字段。导入期间不写回配置文件。
func (s *sshSync) importSshConfig() {
	data, err := os.ReadFile(sshx.ConfigPath())
	if err != nil {
		return
	}
	hosts := sshx.ReadConcreteHosts(string(data))

	s.writeEnabled = false
	defer func() { s.writeEnabled = true }()

	aliasMap, err := s.a.store.ConfigHostMap()
	if err != nil {
		log.Printf("[TermPilot] 读取 config_host 失败: %v", err)
		return
	}
	for _, host := range hosts {
		if strings.TrimSpace(host.Fields.HostName) == "" {
			continue
		}
		if id, ok := aliasMap[host.Alias]; ok {
			s.applyConfig(id, host.Fields)
			continue
		}
		sessions, err := s.a.store.List()
		if err != nil {
			continue
		}
		var matched *storage.SessionConfig
		count := 0
		for _, session := range sessions {
			_, hasAlias, err := s.a.store.ConfigHostOf(session.ID)
			if err != nil || hasAlias {
				continue
			}
			username := host.Fields.Username
			if username == "" {
				username = sshx.LocalUsername()
			}
			if session.Host == host.Fields.HostName && session.Port == host.Fields.Port && session.Username == username {
				matched = session
				count++
			}
		}
		if count == 1 {
			if err := s.a.store.SetConfigHost(matched.ID, host.Alias); err == nil {
				s.applyConfig(matched.ID, host.Fields)
			}
		} else {
			s.insertConfig(host.Alias, host.Fields)
		}
	}
}

// applyConfig 对应 TS applyConfig（含错误日志）。
func (s *sshSync) applyConfig(id string, fields sshx.HostFields) {
	apply := storage.SshConfigApply{
		HostName:     fields.HostName,
		Port:         fields.Port,
		Username:     orLocalUser(fields.Username),
		ProxyCommand: fields.ProxyCommand,
	}
	for _, hop := range fields.Jumps {
		apply.Jumps = append(apply.Jumps, storage.SshHop{Host: hop.Host, Port: hop.Port, Username: hop.Username})
	}
	if err := s.a.store.ApplySshConfig(id, apply); err != nil {
		log.Printf("[TermPilot] 导入 SSH 配置失败: %v", err)
	}
}

// insertConfig 对应 TS insertConfig：配置文件里的主机变成一条新连接。
func (s *sshSync) insertConfig(alias string, fields sshx.HostFields) {
	input := &storage.SessionInput{
		Name:       s.uniqueName(alias),
		Group:      "",
		Host:       fields.HostName,
		Port:       fields.Port,
		Username:   orLocalUser(fields.Username),
		Remark:     strPtr(""),
		Jumps:      hopInputs(fields.Jumps),
		SshOptions: configOptionsFromFields(fields),
	}
	session, err := s.a.store.Create(input)
	if err != nil {
		log.Printf("[TermPilot] 导入 SSH 主机 %s 失败: %v", alias, err)
		return
	}
	if err := s.a.store.SetConfigHost(session.ID, alias); err != nil {
		log.Printf("[TermPilot] 关联 SSH 别名 %s 失败: %v", alias, err)
	}
}

// publishSsh 对应 TS publishSsh：会话变了就写回配置文件。
func (s *sshSync) publishSsh(id string) {
	session, err := s.a.store.Get(id)
	if err != nil || session == nil {
		return
	}
	if strings.TrimSpace(session.Host) == "" {
		s.dropSshAlias(id)
		return
	}
	alias := s.ensureAlias(session)
	if err := sshx.UpsertSshHost(alias, fieldsFromSession(session)); err != nil {
		log.Printf("[TermPilot] 写回 SSH 配置失败: %v", err)
	}
}

// dropSshAlias 对应 TS dropSshAlias：host 清空时撤掉配置文件里的段。
func (s *sshSync) dropSshAlias(id string) {
	alias, ok, err := s.a.store.ConfigHostOf(id)
	if err != nil || !ok {
		return
	}
	if err := s.a.store.SetConfigHost(id, ""); err != nil {
		return
	}
	if err := sshx.RemoveSshHost(alias); err != nil {
		log.Printf("[TermPilot] 从 SSH 配置移除主机失败: %v", err)
	}
}

// ensureAlias 对应 TS ensureAlias：没有别名就按名称生成一个不冲突的。
func (s *sshSync) ensureAlias(session *storage.SessionConfig) string {
	if alias, ok, err := s.a.store.ConfigHostOf(session.ID); err == nil && ok {
		return alias
	}
	taken := sshx.ListConfigAliases()
	if aliasMap, err := s.a.store.ConfigHostMap(); err == nil {
		for alias := range aliasMap {
			taken[alias] = true
		}
	}
	alias := sshx.SuggestAlias(session.Name, session.PublicID, taken)
	if err := s.a.store.SetConfigHost(session.ID, alias); err != nil {
		log.Printf("[TermPilot] 设置 SSH 别名失败: %v", err)
	}
	return alias
}

// uniqueName 对应 TS uniqueName。
func (s *sshSync) uniqueName(base string) string {
	sessions, err := s.a.store.List()
	if err != nil {
		return base
	}
	taken := map[string]bool{}
	for _, session := range sessions {
		taken[session.Name] = true
	}
	if !taken[base] {
		return base
	}
	for n := 2; ; n++ {
		name := base + " " + itoa(n)
		if !taken[name] {
			return name
		}
	}
}

// fieldsFromSession 对应 TS fieldsFromSession：会话 → 配置文件字段。
func fieldsFromSession(session *storage.SessionConfig) sshx.HostFields {
	fields := sshx.HostFields{
		HostName: strings.TrimSpace(session.Host),
		Port:     session.Port,
		Username: strings.TrimSpace(session.Username),
	}
	for _, hop := range session.Jumps {
		fields.Jumps = append(fields.Jumps, sshx.HopFields{
			Host: hop.Host, Port: hop.Port, Username: hop.Username,
		})
	}
	if session.SshOptions != nil {
		fields.ProxyCommand = session.SshOptions.ProxyCommand
	}
	return fields
}

func hopInputs(hops []sshx.HopFields) *[]storage.SshHopInput {
	out := make([]storage.SshHopInput, 0, len(hops))
	for _, hop := range hops {
		out = append(out, storage.SshHopInput{Host: hop.Host, Port: hop.Port, Username: hop.Username})
	}
	return &out
}

// configOptionsFromFields 对应 TS configOptions(proxyCommand)（无 prev 的版本）。
func configOptionsFromFields(fields sshx.HostFields) *storage.SshConnectOptions {
	return storage.SanitizeSshOptions(&storage.SshConnectOptions{ProxyCommand: fields.ProxyCommand})
}

func orLocalUser(username string) string {
	if username != "" {
		return username
	}
	return sshx.LocalUsername()
}

func strPtr(v string) *string { return &v }
func intPtr(v int) *int       { return &v }

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	digits := []byte{}
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	return string(digits)
}
