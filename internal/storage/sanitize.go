package storage

import (
	"encoding/json"
	"regexp"
	"strings"
)

// sanitize.go：ssh_options / forwards 列的 JSON 编解码与清洗，
// 逐条对应 src/shared/ssh-options.ts 与 StorageService.ts 里的 encode/decode 逻辑。

var algoNameRe = regexp.MustCompile(`^[+-^]?[A-Za-z0-9][A-Za-z0-9@._-]{0,79}$`)

func trimSpace(s string) string { return strings.TrimSpace(s) }

func intPtr(v int) *int { return &v }

// SanitizeSshOptions 对应 TS sanitizeSshOptions：逐字段校验范围，全空返回 nil。
func SanitizeSshOptions(value *SshConnectOptions) *SshConnectOptions {
	if value == nil {
		return nil
	}
	var options SshConnectOptions

	if value.ReadyTimeoutMs != nil && *value.ReadyTimeoutMs >= 0 && *value.ReadyTimeoutMs <= 300_000 {
		options.ReadyTimeoutMs = intPtr(*value.ReadyTimeoutMs)
	}
	if value.KeepaliveIntervalMs != nil && *value.KeepaliveIntervalMs >= 0 && *value.KeepaliveIntervalMs <= 3_600_000 {
		options.KeepaliveIntervalMs = intPtr(*value.KeepaliveIntervalMs)
	}
	if value.KeepaliveCountMax != nil && *value.KeepaliveCountMax >= 0 && *value.KeepaliveCountMax <= 100 {
		options.KeepaliveCountMax = intPtr(*value.KeepaliveCountMax)
	}
	if value.Compress {
		options.Compress = true
	}
	if value.Family == 4 || value.Family == 6 {
		options.Family = value.Family
	}
	if addr := trimSpace(value.LocalAddress); addr != "" && len(addr) <= 200 {
		options.LocalAddress = addr
	}
	switch value.StrictHostKeyChecking {
	case "yes", "no", "accept-new":
		options.StrictHostKeyChecking = value.StrictHostKeyChecking
	}

	options.Algorithms = sanitizeAlgorithms(value.Algorithms)

	if command := trimSpace(value.ProxyCommand); command != "" && len(command) <= 1000 &&
		!strings.ContainsAny(command, "\r\n") && !strings.EqualFold(command, "none") {
		options.ProxyCommand = command
	}

	if !hasSshOptions(&options) {
		return nil
	}
	return &options
}

// hasSshOptions 对应 TS hasSshOptions：任一字段非零值即有效。
func hasSshOptions(o *SshConnectOptions) bool {
	return o.ReadyTimeoutMs != nil || o.KeepaliveIntervalMs != nil || o.KeepaliveCountMax != nil ||
		o.Compress || o.Family != 0 || o.LocalAddress != "" || o.StrictHostKeyChecking != "" ||
		o.Algorithms != nil || o.ProxyCommand != ""
}

func sanitizeAlgorithms(value *SshAlgorithms) *SshAlgorithms {
	if value == nil {
		return nil
	}
	var algorithms SshAlgorithms
	algorithms.Cipher = algoList(value.Cipher)
	algorithms.Kex = algoList(value.Kex)
	algorithms.ServerHostKey = algoList(value.ServerHostKey)
	algorithms.Hmac = algoList(value.Hmac)
	if algorithms.Cipher == nil && algorithms.Kex == nil &&
		algorithms.ServerHostKey == nil && algorithms.Hmac == nil {
		return nil
	}
	return &algorithms
}

type jumpRecord struct {
	Host            string `json:"host"`
	Port            int    `json:"port"`
	Username        string `json:"username"`
	SecretEncrypted string `json:"secretEncrypted,omitempty"`
}

func publicJumps(records []jumpRecord) []SshHop {
	out := make([]SshHop, 0, len(records))
	for _, record := range records {
		out = append(out, SshHop{
			Host: record.Host, Port: record.Port, Username: record.Username,
			HasSecret: record.SecretEncrypted != "",
		})
	}
	return out
}

func sanitizeJumpInputs(value []SshHopInput) []SshHopInput {
	var out []SshHopInput
	for _, item := range value {
		host := trimSpace(item.Host)
		username := trimSpace(item.Username)
		if host == "" || len(host) > 255 || username == "" || len(username) > 500 {
			continue
		}
		if item.Port < 1 || item.Port > 65535 {
			continue
		}
		out = append(out, SshHopInput{Host: host, Port: item.Port, Username: username, Secret: item.Secret})
		if len(out) >= 9 {
			break
		}
	}
	return out
}

func (s *Store) encodeJumps(value []SshHopInput, previous []jumpRecord) (*string, error) {
	clean := sanitizeJumpInputs(value)
	if len(clean) == 0 {
		return nil, nil
	}
	records := make([]jumpRecord, 0, len(clean))
	for _, hop := range clean {
		record := jumpRecord{Host: hop.Host, Port: hop.Port, Username: hop.Username}
		if hop.Secret != nil {
			encrypted, err := s.encryptSecret(hop.Secret)
			if err != nil {
				return nil, err
			}
			if encrypted != nil {
				record.SecretEncrypted = *encrypted
			}
		} else if old, ok := findJumpRecord(previous, hop); ok {
			record.SecretEncrypted = old.SecretEncrypted
		}
		records = append(records, record)
	}
	data, err := json.Marshal(records)
	if err != nil {
		return nil, err
	}
	encoded := string(data)
	return &encoded, nil
}

func decodeJumps(value *string) []jumpRecord {
	if value == nil || *value == "" {
		return nil
	}
	var raw []jumpRecord
	if err := json.Unmarshal([]byte(*value), &raw); err != nil {
		return nil
	}
	out := make([]jumpRecord, 0, len(raw))
	for _, record := range raw {
		record.Host = trimSpace(record.Host)
		record.Username = trimSpace(record.Username)
		if record.Host == "" || len(record.Host) > 255 || record.Username == "" || len(record.Username) > 500 {
			continue
		}
		if record.Port < 1 || record.Port > 65535 {
			continue
		}
		out = append(out, record)
		if len(out) >= 9 {
			break
		}
	}
	return out
}

func findJumpRecord(records []jumpRecord, hop SshHopInput) (jumpRecord, bool) {
	for _, record := range records {
		if record.Host == hop.Host && record.Port == hop.Port && record.Username == hop.Username {
			return record, true
		}
	}
	return jumpRecord{}, false
}

func algoList(value []string) []string {
	list := stringList(value, 32, 80)
	var out []string
	for _, item := range list {
		if algoNameRe.MatchString(item) {
			out = append(out, item)
		}
	}
	return out
}

func stringList(value []string, max int, itemMax int) []string {
	if value == nil {
		return nil
	}
	var list []string
	for _, item := range value {
		item = trimSpace(item)
		if len(item) > 0 && len(item) <= itemMax {
			list = append(list, item)
		}
		if len(list) >= max {
			break
		}
	}
	return list
}

// encodeOptions 对应 TS encodeOptions：清洗后序列化，空结果存 NULL。
func encodeOptions(value *SshConnectOptions) (*string, error) {
	clean := SanitizeSshOptions(value)
	if clean == nil {
		return nil, nil
	}
	data, err := json.Marshal(clean)
	if err != nil {
		return nil, err
	}
	s := string(data)
	return &s, nil
}

// decodeOptions 对应 TS decodeOptions：坏 JSON 安静回落 nil。
func decodeOptions(value *string) *SshConnectOptions {
	if value == nil || *value == "" {
		return nil
	}
	var options SshConnectOptions
	if err := json.Unmarshal([]byte(*value), &options); err != nil {
		return nil
	}
	return SanitizeSshOptions(&options)
}

// sanitizeForwards 对应 TS sanitizeForwards：只保留端口合法的规则，残缺的丢弃。
func sanitizeForwards(input []ForwardRule) []ForwardRule {
	var rules []ForwardRule
	for _, item := range input {
		if item.Type != "local" && item.Type != "remote" {
			continue
		}
		if !(item.ListenPort >= 1 && item.ListenPort <= 65535) ||
			!(item.TargetPort >= 1 && item.TargetPort <= 65535) {
			continue
		}
		rules = append(rules, ForwardRule{Type: item.Type, ListenPort: item.ListenPort, TargetPort: item.TargetPort})
	}
	return rules
}

// encodeForwards 对应 TS encodeForwards：空数组不占存储，写 NULL。
func encodeForwards(value []ForwardRule) (*string, error) {
	rules := sanitizeForwards(value)
	if len(rules) == 0 {
		return nil, nil
	}
	data, err := json.Marshal(rules)
	if err != nil {
		return nil, err
	}
	s := string(data)
	return &s, nil
}

// decodeForwards 对应 TS decodeForwards。
func decodeForwards(value *string) []ForwardRule {
	if value == nil || *value == "" {
		return nil
	}
	var raw []ForwardRule
	if err := json.Unmarshal([]byte(*value), &raw); err != nil {
		return nil
	}
	rules := sanitizeForwards(raw)
	if len(rules) == 0 {
		return nil
	}
	return rules
}
