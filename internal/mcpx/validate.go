package mcpx

import (
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"

	"termpilot/internal/storage"
)

// parseToolArgs 对应 TS tool-catalog.ts 的 parseToolArgs：zod object 校验 +
// strip 未声明键。错误消息沿用 zod 的文案（`字段: 消息`，多行拼接）。
func parseToolArgs(name string, raw map[string]any) (map[string]any, error) {
	tool, err := FindTool(name)
	if err != nil {
		return nil, err
	}
	if len(tool.Input) == 0 {
		return map[string]any{}, nil
	}
	var issues []string
	out := make(map[string]any, len(tool.Input))
	for _, f := range tool.Input {
		value, present := raw[f.Name]
		if !present || value == nil {
			if f.Required {
				issues = append(issues, fmt.Sprintf("%s: Required", f.Name))
			}
			continue
		}
		if msg := checkField(f, f.Name, value); msg != "" {
			issues = append(issues, msg)
			continue
		}
		out[f.Name] = value
	}
	if len(issues) > 0 {
		return nil, errors.New(strings.Join(issues, "\n"))
	}
	return out, nil
}

// checkField 单字段校验，返回 zod 风格的错误消息（空串 = 通过）。
func checkField(f FieldSpec, path string, value any) string {
	switch f.Type {
	case "string":
		s, ok := value.(string)
		if !ok {
			return fmt.Sprintf("%s: Expected string, received %s", path, jsonTypeName(value))
		}
		if len(f.Enum) > 0 && !containsString(f.Enum, s) {
			return fmt.Sprintf("%s: Invalid enum value. Expected %s, received '%s'",
				path, enumExpectation(f.Enum), s)
		}
		if f.MaxLen > 0 && len([]rune(s)) > f.MaxLen {
			return fmt.Sprintf("%s: String must contain at most %d character(s)", path, f.MaxLen)
		}
	case "integer":
		n, ok := value.(float64)
		if !ok {
			return fmt.Sprintf("%s: Expected number, received %s", path, jsonTypeName(value))
		}
		if math.Trunc(n) != n {
			return fmt.Sprintf("%s: Expected integer, received float", path)
		}
		if f.Min != nil && n < float64(*f.Min) {
			return fmt.Sprintf("%s: Number must be greater than or equal to %d", path, *f.Min)
		}
		if f.Max != nil && n > float64(*f.Max) {
			return fmt.Sprintf("%s: Number must be less than or equal to %d", path, *f.Max)
		}
	case "boolean":
		if _, ok := value.(bool); !ok {
			return fmt.Sprintf("%s: Expected boolean, received %s", path, jsonTypeName(value))
		}
	case "array":
		list, ok := value.([]any)
		if !ok {
			return fmt.Sprintf("%s: Expected array, received %s", path, jsonTypeName(value))
		}
		if f.MaxItems > 0 && len(list) > f.MaxItems {
			return fmt.Sprintf("%s: Array must contain at most %d element(s)", path, f.MaxItems)
		}
		for i, item := range list {
			if len(f.ItemFields) > 0 {
				if msg := checkField(FieldSpec{Type: "object", ItemFields: f.ItemFields}, fmt.Sprintf("%s.%d", path, i), item); msg != "" {
					return msg
				}
				continue
			}
			s, ok := item.(string)
			if !ok {
				return fmt.Sprintf("%s.%d: Expected string, received %s", path, i, jsonTypeName(item))
			}
			if len(f.ItemEnum) > 0 && !containsString(f.ItemEnum, s) {
				return fmt.Sprintf("%s.%d: Invalid enum value. Expected %s, received '%s'",
					path, i, enumExpectation(f.ItemEnum), s)
			}
		}
	case "object":
		obj, ok := value.(map[string]any)
		if !ok {
			return fmt.Sprintf("%s: Expected object, received %s", path, jsonTypeName(value))
		}
		for _, field := range f.ItemFields {
			item, present := obj[field.Name]
			if !present || item == nil {
				if field.Required {
					return fmt.Sprintf("%s.%s: Required", path, field.Name)
				}
				continue
			}
			if msg := checkField(field, fmt.Sprintf("%s.%s", path, field.Name), item); msg != "" {
				return msg
			}
		}
	}
	return ""
}

func enumExpectation(values []string) string {
	quoted := make([]string, len(values))
	for i, v := range values {
		quoted[i] = "'" + v + "'"
	}
	return strings.Join(quoted, " | ")
}

func containsString(list []string, v string) bool {
	for _, item := range list {
		if item == v {
			return true
		}
	}
	return false
}

// jsonTypeName 对应 zod 的 received 类型名。
func jsonTypeName(v any) string {
	switch v.(type) {
	case nil:
		return "null"
	case string:
		return "string"
	case bool:
		return "boolean"
	case float64:
		return "number"
	case []any:
		return "array"
	case map[string]any:
		return "object"
	default:
		return "unknown"
	}
}

// ------------------------------------------------ 参数辅助（对齐 TS need/textArg/intArg/boolArg/keyArg）

func need(raw map[string]any, key string) (string, error) {
	value, err := textArg(raw, key)
	if err != nil {
		return "", err
	}
	if value == nil || *value == "" {
		return "", fmt.Errorf("缺少 %s", key)
	}
	return *value, nil
}

// textArg 对应 TS textArg：undefined / null / ” 都是没填；非字符串报错。
func textArg(raw map[string]any, key string) (*string, error) {
	value, ok := raw[key]
	if !ok || value == nil || value == "" {
		return nil, nil
	}
	s, ok := value.(string)
	if !ok {
		return nil, fmt.Errorf("%s 必须是字符串", key)
	}
	return &s, nil
}

// intArg 对应 TS intArg：接受 number 或数字字符串，必须整数。
func intArg(raw map[string]any, key string) (*int, error) {
	value, ok := raw[key]
	if !ok || value == nil || value == "" {
		return nil, nil
	}
	var parsed float64
	switch v := value.(type) {
	case float64:
		parsed = v
	case string:
		n, err := parseNumber(v)
		if err != nil {
			return nil, fmt.Errorf("%s 必须是整数", key)
		}
		parsed = n
	default:
		return nil, fmt.Errorf("%s 必须是整数", key)
	}
	if math.Trunc(parsed) != parsed {
		return nil, fmt.Errorf("%s 必须是整数", key)
	}
	n := int(parsed)
	return &n, nil
}

func parseNumber(s string) (float64, error) {
	// 对应 TS Number(s)："12abc" 这类半截数字是 NaN，不是 12。
	return strconv.ParseFloat(strings.TrimSpace(s), 64)
}

// boolArg 对应 TS boolArg：接受 true/false 或 "true"/"false"。
func boolArg(raw map[string]any, key string) (*bool, error) {
	value, ok := raw[key]
	if !ok || value == nil || value == "" {
		return nil, nil
	}
	switch v := value.(type) {
	case bool:
		return &v, nil
	case string:
		if v == "true" {
			t := true
			return &t, nil
		}
		if v == "false" {
			f := false
			return &f, nil
		}
	}
	return nil, fmt.Errorf("%s 必须是 true 或 false", key)
}

// keyArg 对应 TS keyArg：数组或逗号分隔字符串，逐个 canonicalKey 后校验白名单。
func keyArg(raw map[string]any) ([]string, error) {
	value, ok := raw["keys"]
	if !ok || value == nil || value == "" {
		return nil, nil
	}
	var list []any
	switch v := value.(type) {
	case []any:
		list = v
	case string:
		parts := strings.Split(v, ",")
		list = make([]any, len(parts))
		for i, p := range parts {
			list[i] = p
		}
	default:
		return nil, fmt.Errorf("keys 必须是按键列表")
	}
	keys := make([]string, 0, len(list))
	for _, item := range list {
		key := CanonicalKey(fmt.Sprintf("%v", item))
		if key != "" {
			keys = append(keys, key)
		}
	}
	for _, key := range keys {
		if !containsString(TermKeys, key) {
			return nil, fmt.Errorf("不认识的按键: %s", key)
		}
	}
	return keys, nil
}

// sessionPatch 对应 TS sessionPatch：连接字段的可选补丁。
type sessionPatch struct {
	name     *string
	host     *string
	port     *int
	username *string
	secret   *string
	group    *string
	remark   *string
	jumps    *[]storage.SshHopInput
}

func readSessionPatch(raw map[string]any) (sessionPatch, error) {
	var patch sessionPatch
	var err error
	if patch.host, err = textArg(raw, "host"); err != nil {
		return patch, err
	}
	if patch.port, err = intArg(raw, "port"); err != nil {
		return patch, err
	}
	if patch.username, err = textArg(raw, "username"); err != nil {
		return patch, err
	}
	if patch.secret, err = textArg(raw, "secret"); err != nil {
		return patch, err
	}
	if patch.group, err = textArg(raw, "group"); err != nil {
		return patch, err
	}
	if patch.remark, err = textArg(raw, "remark"); err != nil {
		return patch, err
	}
	if patch.jumps, err = hopsArg(raw, "jumps"); err != nil {
		return patch, err
	}
	return patch, nil
}

func hopsArg(raw map[string]any, key string) (*[]storage.SshHopInput, error) {
	value, present := raw[key]
	if !present || value == nil {
		return nil, nil
	}
	list, ok := value.([]any)
	if !ok {
		return nil, fmt.Errorf("%s 必须是数组", key)
	}
	out := make([]storage.SshHopInput, 0, len(list))
	for i, item := range list {
		obj, ok := item.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("%s.%d 必须是对象", key, i)
		}
		var hop storage.SshHopInput
		if host, ok := obj["host"].(string); ok {
			hop.Host = host
		}
		switch port := obj["port"].(type) {
		case float64:
			hop.Port = int(port)
		case int:
			hop.Port = port
		}
		if username, ok := obj["username"].(string); ok {
			hop.Username = username
		}
		if rawSecret, present := obj["secret"]; present {
			secret, ok := rawSecret.(string)
			if !ok {
				return nil, fmt.Errorf("%s.%d.secret 必须是字符串", key, i)
			}
			hop.Secret = &secret
		}
		out = append(out, hop)
	}
	return &out, nil
}

// auditDetail 对应 TS auditDetail：过滤掉 secret 和对象值，拼成 `k=v`，最多 500 字符。
func auditDetail(input map[string]any) string {
	parts := make([]string, 0, len(input))
	for key, value := range input {
		if key == "secret" || value == nil {
			continue
		}
		switch value.(type) {
		case string, bool, float64:
			parts = append(parts, fmt.Sprintf("%s=%v", key, value))
		}
	}
	return clipRunes(strings.Join(parts, " "), 500)
}
