package storage

import "database/sql"

// SshConfigApply 是 ~/.ssh/config 一个具体 Host 段落到会话上的字段集
// （对应 TS StorageService.applyConfig 的入参 fields）。
type SshConfigApply struct {
	HostName     string
	Port         int
	Username     string
	Jumps        []SshHop
	ProxyCommand string
}

// ApplySshConfig 对应 TS applyConfig：启动导入 ~/.ssh/config 时按字段更新已关联会话。
// 只更新 OpenSSH 关心的字段（主机/端口/用户/跳板/ssh_options 里的 proxyCommand），
// 名称、备注、目标机凭据不动；跳板密码按跳的身份保留。
func (s *Store) ApplySshConfig(id string, fields SshConfigApply) error {
	var rawOptions, rawJumps sql.NullString
	err := s.db.QueryRow(
		"SELECT ssh_options, jumps FROM sessions WHERE id = ?", id,
	).Scan(&rawOptions, &rawJumps)
	if err != nil {
		return err
	}

	options := decodeOptions(nullStr(rawOptions))
	if options == nil {
		options = &SshConnectOptions{}
	}
	options.ProxyCommand = fields.ProxyCommand
	encodedOptions, err := encodeOptions(options)
	if err != nil {
		return err
	}
	jumpInputs := make([]SshHopInput, 0, len(fields.Jumps))
	for _, hop := range fields.Jumps {
		jumpInputs = append(jumpInputs, SshHopInput{Host: hop.Host, Port: hop.Port, Username: hop.Username})
	}
	encodedJumps, err := s.encodeJumps(jumpInputs, decodeJumps(nullStr(rawJumps)))
	if err != nil {
		return err
	}

	_, err = s.db.Exec(
		`UPDATE sessions SET
		  host = ?, port = ?, username = ?,
		  jumps = ?, ssh_options = ?, updated_at = ?
		WHERE id = ?`,
		fields.HostName, fields.Port, fields.Username,
		nullStringArg(encodedJumps), nullStringArg(encodedOptions), nowMillis(),
		id,
	)
	return err
}
