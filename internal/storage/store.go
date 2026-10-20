// Package storage 是 TermPilot 会话存储的 Go 移植版（原 src/main/services/StorageService.ts）。
//
// 数据库：userData/termpilot.db（modernc.org/sqlite，WAL）。schema 从 Electron 版沿用，
// 可以直接打开旧库；打开时会删掉已废弃的 appearance.experimental_screenshot。
// 凭据只以密文写入 secret_encrypted / jumps /
// mcp_config.token_encrypted，密文编码与 Electron safeStorage 落盘格式一致（见 internal/secrets）。
package storage

import (
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	_ "modernc.org/sqlite"
)

// Cipher 对应 Electron 的 safeStorage.encryptString/decryptString 对。
// 密文是 base64 字符串，直接落进 TEXT 列。internal/secrets 提供平台实现。
type Cipher interface {
	// EncryptString 明文 → base64 密文。
	EncryptString(plain string) (string, error)
	// DecryptString base64 密文 → 明文。
	DecryptString(ciphertextB64 string) (string, error)
	// IsAvailable 对应 safeStorage.isEncryptionAvailable。
	IsAvailable() bool
}

// SessionSyncHook 同步钩子：~/.ssh/config 的导入/写回由另一个包实现，
// 会话落库后通过这里回调。对应 TS 里的 publishSsh / delete 时移除别名的逻辑。
// 实现方应自己吞掉错误（TS 里只 console.error，不阻断 CRUD）。
type SessionSyncHook interface {
	// OnSessionSaved create/update/duplicate 落库后回调。
	OnSessionSaved(session *SessionConfig)
	// OnSessionDeleted delete 成功后回调；alias 是删除前的 config_host，可能为空。
	OnSessionDeleted(id string, alias string)
}

// Store 会话存储主体。
type Store struct {
	db     *sql.DB
	cipher Cipher
	hooks  []SessionSyncHook
	// onMcpSettings 对应 TS 的 writeMcpFile：拿到最新设置后写 userData/mcp.json。
	onMcpSettings func(settings McpSettings) error
}

// schema 从 Electron 版 StorageService.ts 的 CREATE 语句沿用。
// experimental_screenshot 已删除，打开旧库时再删列。
const schema = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  public_id TEXT,
  name TEXT NOT NULL,
  group_name TEXT NOT NULL DEFAULT '',
  host TEXT NOT NULL DEFAULT '',
  port INTEGER NOT NULL DEFAULT 22,
  username TEXT NOT NULL DEFAULT '',
  remark TEXT,
  secret_encrypted TEXT,
  jumps TEXT,
  ssh_options TEXT,
  config_host TEXT,
  forwards TEXT,
  os TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  use_key INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_public_id ON sessions(public_id);
CREATE TABLE IF NOT EXISTS mcp_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  port INTEGER NOT NULL DEFAULT 3927,
  token_encrypted TEXT,
  confirm_dangerous INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS appearance (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  theme TEXT,
  terminal_font TEXT,
  terminal_size INTEGER
);
CREATE TABLE IF NOT EXISTS host_notes (
  host_key TEXT PRIMARY KEY,
  remark TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mcp_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  tool TEXT NOT NULL,
  ok INTEGER NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS snippets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  command TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  term_id TEXT,
  command TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_config_host ON sessions(config_host) WHERE config_host IS NOT NULL;
`

// Open 打开（必要时创建）dir 下的 termpilot.db 并建表。
// cipher 为 nil 时，带凭据的写入会报「系统钥匙串不可用」，读取密文返回空。
func Open(dir string, cipher Cipher) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, "termpilot.db")
	dsn := fmt.Sprintf("file:%s?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)",
		filepath.ToSlash(path))
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("建表失败: %w", err)
	}
	if err := dropColumnIfExists(db, "appearance", "experimental_screenshot"); err != nil {
		db.Close()
		return nil, fmt.Errorf("清理外观表失败: %w", err)
	}
	if err := ensureColumn(db, "sessions", "jumps", "TEXT"); err != nil {
		db.Close()
		return nil, fmt.Errorf("添加 jumps 列失败: %w", err)
	}
	if err := ensureColumn(db, "sessions", "use_key", "INTEGER NOT NULL DEFAULT 0"); err != nil {
		db.Close()
		return nil, fmt.Errorf("添加 use_key 列失败: %w", err)
	}
	for _, column := range []string{"jump_host", "jump_port", "jump_username", "jump_secret_encrypted"} {
		if err := dropColumnIfExists(db, "sessions", column); err != nil {
			db.Close()
			return nil, fmt.Errorf("清理旧跳板字段失败: %w", err)
		}
	}
	return &Store{db: db, cipher: cipher}, nil
}

// dropColumnIfExists 删掉旧库里已经不用的列。新库没有这一列时直接返回。
func dropColumnIfExists(db *sql.DB, table, column string) error {
	rows, err := db.Query("SELECT name FROM pragma_table_info(?)", table)
	if err != nil {
		return err
	}
	found := false
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			return err
		}
		if name == column {
			found = true
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if !found {
		return nil
	}
	_, err = db.Exec(fmt.Sprintf("ALTER TABLE %s DROP COLUMN %s", table, column))
	return err
}

func ensureColumn(db *sql.DB, table, column, definition string) error {
	rows, err := db.Query("SELECT name FROM pragma_table_info(?)", table)
	if err != nil {
		return err
	}
	found := false
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			return err
		}
		if name == column {
			found = true
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if found {
		return nil
	}
	_, err = db.Exec(fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s", table, column, definition))
	return err
}

// Close 关闭数据库。
func (s *Store) Close() error { return s.db.Close() }

// AddSyncHook 注册会话同步钩子（ssh-config 写回）。
func (s *Store) AddSyncHook(h SessionSyncHook) { s.hooks = append(s.hooks, h) }

// SetMcpSettingsWriter 注册 mcp.json 写入回调（对应 writeMcpFile）。
func (s *Store) SetMcpSettingsWriter(fn func(settings McpSettings) error) { s.onMcpSettings = fn }

func nowMillis() int64 { return time.Now().UnixMilli() }

func newUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	var buf [36]byte
	hex.Encode(buf[0:8], b[0:4])
	buf[8] = '-'
	hex.Encode(buf[9:13], b[4:6])
	buf[13] = '-'
	hex.Encode(buf[14:18], b[6:8])
	buf[18] = '-'
	hex.Encode(buf[19:23], b[8:10])
	buf[23] = '-'
	hex.Encode(buf[24:36], b[10:16])
	return string(buf[:])
}

// newConnID 对应 shared/ids.ts newConnId：conn- + 4 字节随机 hex。
func newConnID() string {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return "conn-" + hex.EncodeToString(b[:])
}

// allocatePublicId 对应 TS allocatePublicId。
func (s *Store) allocatePublicID() (string, error) {
	for {
		publicID := newConnID()
		var one int
		err := s.db.QueryRow("SELECT 1 FROM sessions WHERE public_id = ?", publicID).Scan(&one)
		if errors.Is(err, sql.ErrNoRows) {
			return publicID, nil
		}
		if err != nil {
			return "", err
		}
	}
}

// hostKeyOf 对应 shared/host-key.ts：同一台机器的备注按这个键归在一起。
func hostKeyOf(host string) string {
	key := strings.ToLower(strings.TrimSpace(host))
	key = strings.TrimPrefix(key, "[")
	key = strings.TrimSuffix(key, "]")
	if key == "" {
		return "unknown"
	}
	return key
}

func truncateRunes(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	r := []rune(s)
	return string(r[:max])
}

func boolInt(v bool) int {
	if v {
		return 1
	}
	return 0
}

// encryptSecret 对应 TS encryptSecret：空明文存 NULL；钥匙串不可用时拒绝保存。
func (s *Store) encryptSecret(secret *string) (*string, error) {
	if secret == nil || *secret == "" {
		return nil, nil
	}
	if s.cipher == nil || !s.cipher.IsAvailable() {
		return nil, errors.New("系统钥匙串不可用，无法安全保存凭据")
	}
	encrypted, err := s.cipher.EncryptString(*secret)
	if err != nil {
		return nil, err
	}
	return &encrypted, nil
}

// decryptSecret 对应 TS readSecret/decryptToken：解密失败安静返回空。
func (s *Store) decryptSecret(encrypted *string) string {
	if encrypted == nil || *encrypted == "" || s.cipher == nil {
		return ""
	}
	plain, err := s.cipher.DecryptString(*encrypted)
	if err != nil {
		return ""
	}
	return plain
}

// ------------------------------------------------------------- 会话 CRUD

type sessionRow struct {
	id         string
	publicID   sql.NullString
	name       string
	group      string
	host       string
	port       int64
	username   string
	remark     sql.NullString
	secret     sql.NullString
	jumps      sql.NullString
	sshOptions sql.NullString
	configHost sql.NullString
	forwards   sql.NullString
	os         sql.NullString
	createdAt  int64
	updatedAt  int64
	useKey     int64
}

const sessionColumns = `id, public_id, name, group_name, host, port, username,
  remark, secret_encrypted, jumps, ssh_options, config_host, forwards, os, created_at, updated_at, use_key`

func (r *sessionRow) scan(row interface{ Scan(...any) error }) error {
	return row.Scan(&r.id, &r.publicID, &r.name, &r.group, &r.host, &r.port, &r.username,
		&r.remark, &r.secret, &r.jumps, &r.sshOptions, &r.configHost, &r.forwards, &r.os, &r.createdAt, &r.updatedAt, &r.useKey)
}

func nullStr(s sql.NullString) *string {
	if !s.Valid || s.String == "" {
		return nil
	}
	v := s.String
	return &v
}

func nullInt(s sql.NullInt64) *int {
	if !s.Valid {
		return nil
	}
	v := int(s.Int64)
	return &v
}

// toPublic 对应 TS toPublic。
func (r *sessionRow) toPublic() *SessionConfig {
	return &SessionConfig{
		ID:         r.id,
		PublicID:   r.publicID.String,
		Name:       r.name,
		Group:      r.group,
		Host:       r.host,
		Port:       int(r.port),
		Username:   r.username,
		Remark:     nullStr(r.remark),
		HasSecret:  r.secret.Valid && r.secret.String != "",
		UseKey:     r.useKey != 0,
		Jumps:      publicJumps(decodeJumps(nullStr(r.jumps))),
		SshOptions: decodeOptions(nullStr(r.sshOptions)),
		Forwards:   decodeForwards(nullStr(r.forwards)),
		Os:         nullStr(r.os),
		CreatedAt:  r.createdAt,
		UpdatedAt:  r.updatedAt,
	}
}

// List 对应 TS list()。
func (s *Store) List() ([]*SessionConfig, error) {
	rows, err := s.db.Query("SELECT " + sessionColumns + " FROM sessions ORDER BY created_at ASC, rowid ASC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*SessionConfig{}
	for rows.Next() {
		var r sessionRow
		if err := r.scan(rows); err != nil {
			return nil, err
		}
		out = append(out, r.toPublic())
	}
	return out, rows.Err()
}

// Get 对应 TS require()：不存在时返回 (nil, nil)。
func (s *Store) Get(id string) (*SessionConfig, error) {
	var r sessionRow
	err := r.scan(s.db.QueryRow("SELECT "+sessionColumns+" FROM sessions WHERE id = ?", id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return r.toPublic(), nil
}

func (s *Store) publishSaved(id string) {
	session, err := s.Get(id)
	if err != nil || session == nil {
		return
	}
	for _, h := range s.hooks {
		h.OnSessionSaved(session)
	}
}

// Create 对应 TS create()。
func (s *Store) Create(input *SessionInput) (*SessionConfig, error) {
	now := nowMillis()
	id := newUUID()
	publicID, err := s.allocatePublicID()
	if err != nil {
		return nil, err
	}
	secret, err := s.encryptSecret(input.Secret)
	if err != nil {
		return nil, err
	}
	var jumps *string
	if input.Jumps != nil {
		jumps, err = s.encodeJumps(*input.Jumps, nil)
		if err != nil {
			return nil, err
		}
	}
	options, err := encodeOptions(input.SshOptions)
	if err != nil {
		return nil, err
	}
	forwards, err := encodeForwards(derefForwards(input.Forwards))
	if err != nil {
		return nil, err
	}
	useKey := 0
	if input.UseKey != nil && *input.UseKey {
		useKey = 1
	}
	_, err = s.db.Exec(
		`INSERT INTO sessions (
		  id, public_id, name, group_name, host, port, username,
		  remark, secret_encrypted, created_at, updated_at,
		  jumps, ssh_options, forwards, use_key
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, publicID, input.Name, input.Group, input.Host, input.Port, input.Username,
		nullStringArg(input.Remark), nullStringArg(secret), now, now,
		nullStringArg(jumps), nullStringArg(options), nullStringArg(forwards), useKey,
	)
	if err != nil {
		return nil, err
	}
	saved, err := s.Get(id)
	if err != nil {
		return nil, err
	}
	s.publishSaved(id)
	return saved, nil
}

// Update 对应 TS update()：会话不存在返回 (nil, nil)。
func (s *Store) Update(id string, patch *SessionInput) (*SessionConfig, error) {
	var existing struct {
		secret     sql.NullString
		jumps      sql.NullString
		sshOptions sql.NullString
		forwards   sql.NullString
		useKey     int64
	}
	err := s.db.QueryRow(
		`SELECT secret_encrypted, jumps, ssh_options, forwards, use_key FROM sessions WHERE id = ?`, id,
	).Scan(&existing.secret, &existing.jumps, &existing.sshOptions, &existing.forwards, &existing.useKey)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	var secret any
	if patch.Secret != nil {
		enc, err := s.encryptSecret(patch.Secret)
		if err != nil {
			return nil, err
		}
		secret = nullStringArg(enc)
	} else {
		secret = nullSQL(existing.secret)
	}

	var jumps *string
	if patch.Jumps == nil {
		jumps = nullStr(existing.jumps)
	} else {
		jumps, err = s.encodeJumps(*patch.Jumps, decodeJumps(nullStr(existing.jumps)))
		if err != nil {
			return nil, err
		}
	}

	var options *string
	if patch.SshOptions == nil {
		options = nullStr(existing.sshOptions)
	} else {
		options, err = encodeOptions(patch.SshOptions)
		if err != nil {
			return nil, err
		}
	}
	var forwards *string
	if patch.Forwards == nil {
		forwards = nullStr(existing.forwards)
	} else {
		forwards, err = encodeForwards(*patch.Forwards)
		if err != nil {
			return nil, err
		}
	}

	useKey := existing.useKey
	if patch.UseKey != nil {
		useKey = 0
		if *patch.UseKey {
			useKey = 1
		}
	}
	_, err = s.db.Exec(
		`UPDATE sessions SET
		  name = ?, group_name = ?, host = ?, port = ?, username = ?,
		  remark = ?,
		  secret_encrypted = ?, updated_at = ?,
		  jumps = ?, ssh_options = ?, forwards = ?, use_key = ?
		WHERE id = ?`,
		patch.Name, patch.Group, patch.Host, patch.Port, patch.Username,
		nullStringArg(patch.Remark), secret, nowMillis(),
		nullStringArg(jumps), nullStringArg(options), nullStringArg(forwards), useKey, id,
	)
	if err != nil {
		return nil, err
	}
	saved, err := s.Get(id)
	if err != nil {
		return nil, err
	}
	s.publishSaved(id)
	return saved, nil
}

// Delete 对应 TS delete()。
func (s *Store) Delete(id string) (bool, error) {
	alias, _, err := s.ConfigHostOf(id)
	if err != nil {
		return false, err
	}
	result, err := s.db.Exec("DELETE FROM sessions WHERE id = ?", id)
	if err != nil {
		return false, err
	}
	changes, err := result.RowsAffected()
	if err != nil {
		return false, err
	}
	if changes > 0 {
		for _, h := range s.hooks {
			h.OnSessionDeleted(id, alias)
		}
	}
	return changes > 0, nil
}

var copySuffixRe = regexp.MustCompile(` 副本(?: \d+)?$`)

// copyName 对应 TS copyName。
func (s *Store) copyName(name string) (string, error) {
	base := copySuffixRe.ReplaceAllString(name, "")
	if base == "" {
		base = name
	}
	taken, err := s.nameSet()
	if err != nil {
		return "", err
	}
	first := base + " 副本"
	if !taken[first] {
		return first, nil
	}
	n := 2
	for taken[fmt.Sprintf("%s 副本 %d", base, n)] {
		n++
	}
	return fmt.Sprintf("%s 副本 %d", base, n), nil
}

func (s *Store) nameSet() (map[string]bool, error) {
	rows, err := s.db.Query("SELECT name FROM sessions")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	taken := map[string]bool{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		taken[name] = true
	}
	return taken, rows.Err()
}

// Duplicate 对应 TS duplicate()：凭据密文原样带上，不把密码交回界面。
func (s *Store) Duplicate(id string) (*SessionConfig, error) {
	var r sessionRow
	err := r.scan(s.db.QueryRow("SELECT "+sessionColumns+" FROM sessions WHERE id = ?", id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	now := nowMillis()
	newID := newUUID()
	publicID, err := s.allocatePublicID()
	if err != nil {
		return nil, err
	}
	name, err := s.copyName(r.name)
	if err != nil {
		return nil, err
	}
	_, err = s.db.Exec(
		`INSERT INTO sessions (
		  id, public_id, name, group_name, host, port, username,
		  remark, secret_encrypted, created_at, updated_at,
		  jumps, ssh_options, forwards, use_key
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		newID, publicID, name, r.group, r.host, r.port, r.username,
		nullSQL(r.remark), nullSQL(r.secret), now, now,
		nullSQL(r.jumps), nullSQL(r.sshOptions), nullSQL(r.forwards), r.useKey,
	)
	if err != nil {
		return nil, err
	}
	saved, err := s.Get(newID)
	if err != nil {
		return nil, err
	}
	s.publishSaved(newID)
	return saved, nil
}

// SetOs 探测到对端系统/发行版后存下来，连接列表的图标用。
func (s *Store) SetOs(id string, os string) error {
	_, err := s.db.Exec("UPDATE sessions SET os = ? WHERE id = ?", os, id)
	return err
}

// ------------------------------------------------------- config_host 原语
// ~/.ssh/config 的导入/写回由 ssh-config 包实现，这里只暴露它需要的 CRUD 原语。

// ConfigHostOf 返回会话当前关联的 ~/.ssh/config Host 别名。
func (s *Store) ConfigHostOf(id string) (string, bool, error) {
	var alias sql.NullString
	err := s.db.QueryRow("SELECT config_host FROM sessions WHERE id = ?", id).Scan(&alias)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	if !alias.Valid || alias.String == "" {
		return "", false, nil
	}
	return alias.String, true, nil
}

// SetConfigHost 关联/清除 config 别名（空字符串 = 清除，对应 TS 里置 NULL）。
func (s *Store) SetConfigHost(id string, alias string) error {
	_, err := s.db.Exec("UPDATE sessions SET config_host = ? WHERE id = ?", nullStrArg(alias), id)
	return err
}

// ConfigHostMap 返回 alias → session id 全表（ensureAlias / 导入去重用）。
func (s *Store) ConfigHostMap() (map[string]string, error) {
	rows, err := s.db.Query("SELECT config_host, id FROM sessions WHERE config_host IS NOT NULL")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var alias, id string
		if err := rows.Scan(&alias, &id); err != nil {
			return nil, err
		}
		out[alias] = id
	}
	return out, rows.Err()
}

// ------------------------------------------------------------- 主机备注

// ListHostNotes 对应 TS listHostNotes()。
func (s *Store) ListHostNotes() (map[string]string, error) {
	rows, err := s.db.Query("SELECT host_key, remark FROM host_notes")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	notes := map[string]string{}
	for rows.Next() {
		var key, remark string
		if err := rows.Scan(&key, &remark); err != nil {
			return nil, err
		}
		if key != "" && remark != "" {
			notes[key] = remark
		}
	}
	return notes, rows.Err()
}

// SetHostNote 对应 TS setHostNote()：空备注会删掉。
func (s *Store) SetHostNote(hostKey, remark string) (map[string]string, error) {
	key := hostKeyOf(hostKey)
	note := truncateRunes(strings.TrimSpace(remark), 80)
	if note == "" {
		if _, err := s.db.Exec("DELETE FROM host_notes WHERE host_key = ?", key); err != nil {
			return nil, err
		}
	} else {
		var existing string
		err := s.db.QueryRow("SELECT host_key FROM host_notes WHERE host_key = ?", key).Scan(&existing)
		switch {
		case errors.Is(err, sql.ErrNoRows):
			if _, err := s.db.Exec("INSERT INTO host_notes (host_key, remark) VALUES (?, ?)", key, note); err != nil {
				return nil, err
			}
		case err != nil:
			return nil, err
		default:
			if _, err := s.db.Exec("UPDATE host_notes SET remark = ? WHERE host_key = ?", note, key); err != nil {
				return nil, err
			}
		}
	}
	return s.ListHostNotes()
}

// ------------------------------------------------------------- MCP 配置

// GetMcpSettings 对应 TS getMcpSettings()：没有令牌时现场生成一个。
func (s *Store) GetMcpSettings() (*McpSettings, error) {
	if _, err := s.db.Exec(
		"INSERT OR IGNORE INTO mcp_config (id, enabled, port, confirm_dangerous) VALUES (1, 0, ?, 1)",
		MCPDefaultPort,
	); err != nil {
		return nil, err
	}
	var enabled, port, confirm int64
	var tokenEncrypted sql.NullString
	err := s.db.QueryRow(
		"SELECT enabled, port, token_encrypted, confirm_dangerous FROM mcp_config WHERE id = 1",
	).Scan(&enabled, &port, &tokenEncrypted, &confirm)
	if err != nil {
		return nil, errors.New("MCP 配置不存在")
	}

	token := s.decryptSecret(nullStr(tokenEncrypted))
	if token == "" {
		var b [24]byte
		if _, err := rand.Read(b[:]); err != nil {
			return nil, err
		}
		token = base64.RawURLEncoding.EncodeToString(b[:])
		enc, err := s.encryptSecret(&token)
		if err != nil {
			return nil, err
		}
		if _, err := s.db.Exec("UPDATE mcp_config SET token_encrypted = ? WHERE id = 1", nullStringArg(enc)); err != nil {
			return nil, err
		}
	}

	settings := McpSettings{
		Enabled:          enabled == 1,
		Host:             MCPHost,
		Port:             int(port),
		Token:            token,
		ConfirmDangerous: confirm == 1,
	}
	if s.onMcpSettings != nil {
		if err := s.onMcpSettings(settings); err != nil {
			return nil, err
		}
	}
	return &settings, nil
}

// SaveMcpSettings 对应 TS saveMcpSettings()。
func (s *Store) SaveMcpSettings(input *McpSettingsInput) (*McpSettings, error) {
	if input.Port < 1 || input.Port > 65535 {
		return nil, errors.New("端口需要在 1–65535")
	}
	token := strings.TrimSpace(input.Token)
	if utf8.RuneCountInString(token) < 16 {
		return nil, errors.New("令牌至少 16 位")
	}
	if _, err := s.GetMcpSettings(); err != nil {
		return nil, err
	}
	enc, err := s.encryptSecret(&token)
	if err != nil {
		return nil, err
	}
	if _, err := s.db.Exec(
		`UPDATE mcp_config
		 SET enabled = ?, port = ?, token_encrypted = ?, confirm_dangerous = ?
		 WHERE id = 1`,
		boolInt(input.Enabled), input.Port, nullStringArg(enc), boolInt(input.ConfirmDangerous),
	); err != nil {
		return nil, err
	}
	return s.GetMcpSettings()
}

// ListAudit 对应 TS listAudit(limit = 40)。
func (s *Store) ListAudit(limit int) ([]McpAuditEntry, error) {
	if limit <= 0 {
		limit = 40
	}
	rows, err := s.db.Query("SELECT at, tool, ok, detail FROM mcp_audit ORDER BY id DESC LIMIT ?", limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []McpAuditEntry{}
	for rows.Next() {
		var e McpAuditEntry
		var ok int64
		if err := rows.Scan(&e.At, &e.Tool, &ok, &e.Detail); err != nil {
			return nil, err
		}
		e.Ok = ok == 1
		out = append(out, e)
	}
	return out, rows.Err()
}

// AppendAudit 对应 TS appendAudit()。
func (s *Store) AppendAudit(tool string, ok bool, detail string) error {
	_, err := s.db.Exec(
		"INSERT INTO mcp_audit (at, tool, ok, detail) VALUES (?, ?, ?, ?)",
		nowMillis(), tool, boolInt(ok), truncateRunes(detail, 500),
	)
	return err
}

// ------------------------------------------------------------- 外观

// GetAppearance 对应 TS getAppearance()。
func (s *Store) GetAppearance() (Appearance, error) {
	if _, err := s.db.Exec("INSERT OR IGNORE INTO appearance (id) VALUES (1)"); err != nil {
		return Appearance{}, err
	}
	var theme, font sql.NullString
	var size sql.NullInt64
	err := s.db.QueryRow(
		"SELECT theme, terminal_font, terminal_size FROM appearance WHERE id = 1",
	).Scan(&theme, &font, &size)
	if errors.Is(err, sql.ErrNoRows) {
		return ParseAppearance(Appearance{}), nil
	}
	if err != nil {
		return Appearance{}, err
	}
	out := Appearance{
		Theme:        theme.String,
		TerminalFont: font.String,
	}
	if size.Valid {
		out.TerminalSize = int(size.Int64)
	}
	return ParseAppearance(out), nil
}

// SaveAppearance 对应 TS saveAppearance()。
func (s *Store) SaveAppearance(input Appearance) (Appearance, error) {
	next := ParseAppearance(input)
	if _, err := s.GetAppearance(); err != nil {
		return Appearance{}, err
	}
	_, err := s.db.Exec(
		`UPDATE appearance
		 SET theme = ?, terminal_font = ?, terminal_size = ?
		 WHERE id = 1`,
		next.Theme, next.TerminalFont, next.TerminalSize,
	)
	if err != nil {
		return Appearance{}, err
	}
	return next, nil
}

// ------------------------------------------------------------- 片段

// ListSnippets 对应 TS listSnippets()。
func (s *Store) ListSnippets() ([]Snippet, error) {
	rows, err := s.db.Query("SELECT id, name, command, created_at FROM snippets ORDER BY created_at ASC, rowid ASC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Snippet{}
	for rows.Next() {
		var sn Snippet
		if err := rows.Scan(&sn.ID, &sn.Name, &sn.Command, &sn.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, sn)
	}
	return out, rows.Err()
}

// CreateSnippet 对应 TS createSnippet()。
func (s *Store) CreateSnippet(name, command string) (Snippet, error) {
	snippet := Snippet{ID: newUUID(), Name: strings.TrimSpace(name), Command: command, CreatedAt: nowMillis()}
	_, err := s.db.Exec(
		"INSERT INTO snippets (id, name, command, created_at) VALUES (?, ?, ?, ?)",
		snippet.ID, snippet.Name, snippet.Command, snippet.CreatedAt,
	)
	return snippet, err
}

// UpdateSnippet 对应 TS updateSnippet()。
func (s *Store) UpdateSnippet(id, name, command string) error {
	_, err := s.db.Exec("UPDATE snippets SET name = ?, command = ? WHERE id = ?",
		strings.TrimSpace(name), command, id)
	return err
}

// DeleteSnippet 对应 TS deleteSnippet()。
func (s *Store) DeleteSnippet(id string) error {
	_, err := s.db.Exec("DELETE FROM snippets WHERE id = ?", id)
	return err
}

// ------------------------------------------------------------- 历史

// ListHistory 对应 TS listHistory()。
func (s *Store) ListHistory(termID string) ([]HistoryEntry, error) {
	rows, err := s.db.Query(
		"SELECT id, command, at FROM history WHERE term_id = ? ORDER BY id DESC LIMIT 200", termID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []HistoryEntry{}
	for rows.Next() {
		var e HistoryEntry
		e.TermID = termID
		if err := rows.Scan(&e.ID, &e.Command, &e.At); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// AppendHistory 对应 TS appendHistory()：连续重复不再插，只留最近 200 条。
func (s *Store) AppendHistory(termID, command string) (bool, error) {
	cmd := truncateRunes(strings.TrimSpace(command), 500)
	if utf8.RuneCountInString(cmd) < 2 {
		return false, nil
	}
	var latest string
	err := s.db.QueryRow(
		"SELECT command FROM history WHERE term_id = ? ORDER BY id DESC LIMIT 1", termID,
	).Scan(&latest)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return false, err
	}
	if err == nil && latest == cmd {
		return false, nil
	}
	if _, err := s.db.Exec(
		"INSERT INTO history (term_id, command, at) VALUES (?, ?, ?)", termID, cmd, nowMillis(),
	); err != nil {
		return false, err
	}
	if _, err := s.db.Exec(
		`DELETE FROM history WHERE term_id = ? AND id NOT IN
		 (SELECT id FROM history WHERE term_id = ? ORDER BY id DESC LIMIT 200)`,
		termID, termID,
	); err != nil {
		return false, err
	}
	return true, nil
}

// ClearHistory 对应 TS clearHistory()。
func (s *Store) ClearHistory(termID string) error {
	_, err := s.db.Exec("DELETE FROM history WHERE term_id = ?", termID)
	return err
}

// ------------------------------------------------------------- 凭据读取

// GetSecret 取解密后的凭据；没有或解密失败返回空字符串（对应 TS 的 null）。
func (s *Store) GetSecret(id string) (string, error) {
	return s.readSecret(id, "secret_encrypted")
}

// GetJumpSecrets 按跳板顺序取解密后的密码，与目标机密码分开存。
func (s *Store) GetJumpSecrets(id string) ([]string, error) {
	var raw sql.NullString
	err := s.db.QueryRow(`SELECT jumps FROM sessions WHERE id = ?`, id).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return []string{}, nil
	}
	if err != nil {
		return nil, err
	}
	records := decodeJumps(nullStr(raw))
	secrets := make([]string, len(records))
	for i, record := range records {
		secrets[i] = s.decryptSecret(&record.SecretEncrypted)
	}
	return secrets, nil
}

func (s *Store) readSecret(id string, column string) (string, error) {
	var encrypted sql.NullString
	err := s.db.QueryRow(
		fmt.Sprintf("SELECT %s AS secret FROM sessions WHERE id = ?", column), id,
	).Scan(&encrypted)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return s.decryptSecret(nullStr(encrypted)), nil
}

// ------------------------------------------------------------- 参数工具

func nullStringArg(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

func nullStrArg(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func nullSQL(s sql.NullString) any {
	if !s.Valid {
		return nil
	}
	return s.String
}

func nullSQLInt(s sql.NullInt64) any {
	if !s.Valid {
		return nil
	}
	return s.Int64
}

func derefForwards(f *[]ForwardRule) []ForwardRule {
	if f == nil {
		return nil
	}
	return *f
}
