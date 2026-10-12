package sshx

import (
	"math"
	"regexp"
	"strconv"
	"strings"
)

// 对应 src/shared/ssh-options.ts 的净化逻辑：输入是来自前端的不可信 JSON，
// 只收下认得的字段和合法取值，其余丢弃。

var algoNameRe = regexp.MustCompile(`^[+\-^]?[A-Za-z0-9][A-Za-z0-9@._-]{0,79}$`)

// SanitizeConnectOptions 从任意 JSON 对象里净化出 ConnectOptions；没有有效字段时返回 nil。
func SanitizeConnectOptions(value map[string]any) *ConnectOptions {
	if value == nil {
		return nil
	}
	options := &ConnectOptions{}

	if ready, ok := finiteNumber(value["readyTimeoutMs"]); ok && ready >= 0 && ready <= 300_000 {
		options.ReadyTimeoutMs = &ready
	}
	if alive, ok := finiteNumber(value["keepaliveIntervalMs"]); ok && alive >= 0 && alive <= 3_600_000 {
		options.KeepaliveIntervalMs = &alive
	}
	if count, ok := finiteNumber(value["keepaliveCountMax"]); ok && count >= 0 && count <= 100 {
		options.KeepaliveCountMax = &count
	}
	if value["compress"] == true {
		options.Compress = true
	}
	if family, ok := finiteNumber(value["family"]); ok && (family == 4 || family == 6) {
		options.Family = family
	}
	if addr, ok := value["localAddress"].(string); ok {
		if trimmed := strings.TrimSpace(addr); trimmed != "" && len(trimmed) <= 200 {
			options.LocalAddress = trimmed
		}
	}
	switch value["strictHostKeyChecking"] {
	case "yes", "no", "accept-new":
		options.StrictHostKeyChecking = value["strictHostKeyChecking"].(string)
	}

	if algorithms := sanitizeAlgorithms(value["algorithms"]); algorithms != nil {
		options.Algorithms = algorithms
	}
	if hops := sanitizeHops(value["extraJumps"]); hops != nil {
		options.ExtraJumps = hops
	}
	if command, ok := value["proxyCommand"].(string); ok {
		trimmed := strings.TrimSpace(command)
		if trimmed != "" && len(trimmed) <= 1000 && !strings.ContainsAny(trimmed, "\r\n") && strings.ToLower(trimmed) != "none" {
			options.ProxyCommand = trimmed
		}
	}

	if !HasConnectOptions(options) {
		return nil
	}
	return options
}

// OptionsForSession 没有第一跳时，后面的跳板没有落点。
func OptionsForSession(jumpHost string, options *ConnectOptions) *ConnectOptions {
	if options == nil {
		return nil
	}
	clean := *options
	if strings.TrimSpace(jumpHost) == "" {
		clean.ExtraJumps = nil
	}
	if !HasConnectOptions(&clean) {
		return nil
	}
	return &clean
}

// HasConnectOptions 报告选项里是否还有任何生效字段。
func HasConnectOptions(options *ConnectOptions) bool {
	if options == nil {
		return false
	}
	return options.ReadyTimeoutMs != nil ||
		options.KeepaliveIntervalMs != nil ||
		options.KeepaliveCountMax != nil ||
		options.Compress ||
		options.Family != 0 ||
		options.LocalAddress != "" ||
		options.StrictHostKeyChecking != "" ||
		options.Algorithms != nil ||
		len(options.ExtraJumps) > 0 ||
		options.ProxyCommand != ""
}

func sanitizeAlgorithms(value any) *AlgorithmOptions {
	raw, ok := value.(map[string]any)
	if !ok || raw == nil {
		return nil
	}
	algorithms := &AlgorithmOptions{}
	algorithms.Cipher = sanitizeAlgoList(raw["cipher"])
	algorithms.Kex = sanitizeAlgoList(raw["kex"])
	algorithms.ServerHostKey = sanitizeAlgoList(raw["serverHostKey"])
	algorithms.HMAC = sanitizeAlgoList(raw["hmac"])
	if algorithms.Cipher == nil && algorithms.Kex == nil && algorithms.ServerHostKey == nil && algorithms.HMAC == nil {
		return nil
	}
	return algorithms
}

func sanitizeHops(value any) []Hop {
	list, ok := value.([]any)
	if !ok {
		return nil
	}
	var hops []Hop
	for _, item := range list {
		raw, ok := item.(map[string]any)
		if !ok {
			continue
		}
		host, _ := raw["host"].(string)
		host = strings.TrimSpace(host)
		username, _ := raw["username"].(string)
		username = strings.TrimSpace(username)
		port, ok := finiteNumber(raw["port"])
		if host == "" || len(host) > 255 || len(username) > 500 {
			continue
		}
		if !ok || port < 1 || port > 65535 {
			continue
		}
		hops = append(hops, Hop{Host: host, Port: port, Username: username})
		if len(hops) >= 8 {
			break
		}
	}
	if len(hops) == 0 {
		return nil
	}
	return hops
}

func sanitizeAlgoList(value any) []string {
	list, ok := value.([]any)
	if !ok {
		return nil
	}
	var out []string
	for _, item := range list {
		text, ok := item.(string)
		if !ok {
			continue
		}
		text = strings.TrimSpace(text)
		if text == "" || len(text) > 80 || !algoNameRe.MatchString(text) {
			continue
		}
		out = append(out, text)
		if len(out) >= 32 {
			break
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// finiteNumber 对应 TS 的 finite()：数字或数字字符串，截断取整。
func finiteNumber(value any) (int, bool) {
	var n float64
	switch v := value.(type) {
	case float64:
		n = v
	case int:
		n = float64(v)
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
		if err != nil {
			return 0, false
		}
		n = parsed
	default:
		return 0, false
	}
	if math.IsNaN(n) || math.IsInf(n, 0) {
		return 0, false
	}
	return int(math.Trunc(n)), true
}
