package storage

import "database/sql"

// SshConfigApply 是 ~/.ssh/config 一个具体 Host 段落到会话上的字段集
// （对应 TS StorageService.applyConfig 的入参 fields）。
type SshConfigApply struct {
	HostName     string
	Port         int
	Username     string
	JumpHost     string // 空 = 无第一跳跳板
	JumpPort     int
	JumpUsername string
	ExtraJumps   []SshHop
	ProxyCommand string
}

// ApplySshConfig 对应 TS applyConfig：启动导入 ~/.ssh/config 时按字段更新已关联会话。
// 只更新 OpenSSH 关心的字段（主机/端口/用户/跳板/ssh_options 里的 extraJumps 与
// proxyCommand），名称、备注、凭据不动；跳板变了就丢掉跳板口令。
func (s *Store) ApplySshConfig(id string, fields SshConfigApply) error {
	var rawOptions, rawJumpHost, rawJumpSecret sql.NullString
	err := s.db.QueryRow(
		"SELECT ssh_options, jump_host, jump_secret_encrypted FROM sessions WHERE id = ?", id,
	).Scan(&rawOptions, &rawJumpHost, &rawJumpSecret)
	if err != nil {
		return err
	}

	previousJump := rawJumpHost.String
	keepSecret := fields.JumpHost != "" && fields.JumpHost == previousJump

	// configOptions(extra, proxyCommand, prev)：prev 为底，extraJumps/proxyCommand 覆盖或删除。
	options := decodeOptions(nullStr(rawOptions))
	if options == nil {
		options = &SshConnectOptions{}
	}
	if len(fields.ExtraJumps) > 0 {
		options.ExtraJumps = fields.ExtraJumps
	} else {
		options.ExtraJumps = nil
	}
	options.ProxyCommand = fields.ProxyCommand
	encoded, err := encodeOptions(options)
	if err != nil {
		return err
	}
	var jumpPort, jumpUsername any
	var jumpSecret any
	if fields.JumpHost != "" {
		port := fields.JumpPort
		if port == 0 {
			port = 22
		}
		jumpPort = port
		jumpUsername = nullStrArg(fields.JumpUsername)
	}
	if keepSecret && rawJumpSecret.Valid {
		jumpSecret = rawJumpSecret.String
	}

	_, err = s.db.Exec(
		`UPDATE sessions SET
		  host = ?, port = ?, username = ?,
		  jump_host = ?, jump_port = ?, jump_username = ?, jump_secret_encrypted = ?,
		  ssh_options = ?, updated_at = ?
		WHERE id = ?`,
		fields.HostName, fields.Port, fields.Username,
		nullStrArg(fields.JumpHost), jumpPort, jumpUsername, jumpSecret,
		encoded, nowMillis(),
		id,
	)
	return err
}
