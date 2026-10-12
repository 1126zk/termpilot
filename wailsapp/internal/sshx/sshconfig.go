package sshx

import (
	"os"
	"os/user"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// 对应 src/main/ssh-config-file.ts。
// ~/.ssh/config 只保存 OpenSSH 认得的字段。密码、备注和窗口留在 TermPilot 的数据库里，
// 不写进这个文件。带通配符的 Host、Match、Include 原样保留，不导入也不改写。

// HopFields ssh config 里一跳跳板的字段。
type HopFields struct {
	Host     string
	Port     int
	Username string
}

// HostFields 一个具体 Host 段里 TermPilot 关心的字段。
type HostFields struct {
	HostName     string
	Port         int
	Username     string
	Jumps        []HopFields
	ProxyCommand string
}

// ConcreteHost 配置文件里一个具体（非通配）Host 段。
type ConcreteHost struct {
	Alias  string
	Fields HostFields
}

var (
	aliasRe    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,127}$`)
	wildcardRe = regexp.MustCompile(`[*?!]`)
)

// ConfigPath 返回 ~/.ssh/config。
func ConfigPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join(".ssh", "config")
	}
	return filepath.Join(home, ".ssh", "config")
}

// LocalUsername 本机用户名，User 缺省时的兜底。
func LocalUsername() string {
	current, err := user.Current()
	if err != nil {
		return ""
	}
	return current.Username
}

// ReadConcreteHosts 读出所有具体 Host 段；通配 Host、Match、Include 跳过。
func ReadConcreteHosts(text string) []ConcreteHost {
	var out []ConcreteHost
	for _, section := range parseSections(text) {
		if section.kind == sectionHost && section.concrete && section.alias != "" {
			out = append(out, ConcreteHost{Alias: section.alias, Fields: fieldsOf(section.lines, LocalUsername())})
		}
	}
	return out
}

// RenderUpsert 在 text 里插入或更新 alias 的 Host 段，返回新全文。其他内容原样保留。
func RenderUpsert(text, alias string, fields HostFields) string {
	newline := "\n"
	if strings.Contains(text, "\r\n") {
		newline = "\r\n"
	}
	sections := parseSections(strings.ReplaceAll(text, "\r\n", "\n"))
	index := -1
	for i, section := range sections {
		if section.kind == sectionHost && section.alias == alias {
			index = i
			break
		}
	}
	var lines []string
	if index >= 0 {
		lines = applyFields(sections[index].lines, alias, fields)
		sections[index] = section{kind: sectionHost, alias: alias, concrete: true, lines: lines}
	} else {
		lines = newBlock(alias, fields)
		if n := len(sections); n > 0 && sections[n-1].lines[len(sections[n-1].lines)-1] != "" {
			sections = append(sections, section{kind: sectionLoose, lines: []string{""}})
		}
		sections = append(sections, section{kind: sectionHost, alias: alias, concrete: true, lines: lines})
	}
	return finishConfig(joinSections(sections), newline)
}

// RenderRemove 从 text 里删掉 alias 的 Host 段。
func RenderRemove(text, alias string) string {
	newline := "\n"
	if strings.Contains(text, "\r\n") {
		newline = "\r\n"
	}
	var kept []section
	for _, section := range parseSections(strings.ReplaceAll(text, "\r\n", "\n")) {
		if section.kind == sectionHost && section.alias == alias {
			continue
		}
		kept = append(kept, section)
	}
	return finishConfig(joinSections(kept), newline)
}

// SuggestAlias 给会话建议一个不冲突的 ssh config 别名。
func SuggestAlias(name, publicID string, taken map[string]bool) string {
	cleaned := strings.TrimSpace(name)
	cleaned = whitespaceRunRe.ReplaceAllString(cleaned, "-")
	cleaned = invalidAliasCharRe.ReplaceAllString(cleaned, "")
	cleaned = leadingNonAlnumRe.ReplaceAllString(cleaned, "")
	if runes := []rune(cleaned); len(runes) > 64 {
		cleaned = string(runes[:64])
	}
	base := cleaned
	if !aliasRe.MatchString(cleaned) || wildcardRe.MatchString(cleaned) {
		base = "tp-" + strings.TrimPrefix(publicID, "conn-")
	}
	if !taken[base] {
		return base
	}
	for n := 2; ; n++ {
		candidate := base + "-" + strconv.Itoa(n)
		if !taken[candidate] {
			return candidate
		}
	}
}

// UpsertSshHost 把 alias 写入 ~/.ssh/config（内容不变则不动文件）。
func UpsertSshHost(alias string, fields HostFields) error {
	return UpsertSshHostFile(ConfigPath(), alias, fields)
}

// UpsertSshHostFile 同 UpsertSshHost，但作用于指定路径（便于测试）。
func UpsertSshHostFile(path, alias string, fields HostFields) error {
	current := ""
	if data, err := os.ReadFile(path); err == nil {
		current = string(data)
	}
	next := RenderUpsert(current, alias, fields)
	if normalizeConfig(next) == normalizeConfig(current) {
		return nil
	}
	return writeConfig(path, next)
}

// RemoveSshHost 从 ~/.ssh/config 删掉 alias。
func RemoveSshHost(alias string) error {
	return RemoveSshHostFile(ConfigPath(), alias)
}

// RemoveSshHostFile 同 RemoveSshHost，但作用于指定路径。
func RemoveSshHostFile(path, alias string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	current := string(data)
	next := RenderRemove(current, alias)
	if normalizeConfig(next) == normalizeConfig(current) {
		return nil
	}
	return writeConfig(path, next)
}

// ListConfigAliases 列出 ~/.ssh/config 里所有具体 Host 别名。
func ListConfigAliases() map[string]bool {
	return ListConfigAliasesIn(ConfigPath())
}

// ListConfigAliasesIn 同 ListConfigAliases，但作用于指定路径。
func ListConfigAliasesIn(path string) map[string]bool {
	out := map[string]bool{}
	data, err := os.ReadFile(path)
	if err != nil {
		return out
	}
	for _, host := range ReadConcreteHosts(string(data)) {
		out[host.Alias] = true
	}
	return out
}

// writeConfig 原子写入：tmp + rename + chmod 0600（Windows 上 chmod 失败忽略）。
func writeConfig(path, text string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".termpilot-tmp"
	if err := os.WriteFile(tmp, []byte(text), 0o600); err != nil {
		return err
	}
	_ = os.Chmod(tmp, 0o600)
	return os.Rename(tmp, path)
}

type sectionKind int

const (
	sectionLoose sectionKind = iota
	sectionMatch
	sectionHost
)

type section struct {
	kind     sectionKind
	lines    []string
	alias    string
	concrete bool
}

func parseSections(text string) []section {
	var sections []section
	current := section{kind: sectionLoose}
	push := func() {
		if len(current.lines) > 0 {
			sections = append(sections, current)
		}
	}
	for _, line := range strings.Split(text, "\n") {
		directive := directiveOf(line)
		if directive != nil && directive.key == "host" {
			push()
			tokens := strings.Fields(directive.value)
			alias := ""
			if len(tokens) > 0 {
				alias = tokens[0]
			}
			current = section{
				kind:     sectionHost,
				lines:    []string{line},
				alias:    alias,
				concrete: len(tokens) == 1 && aliasRe.MatchString(alias) && !wildcardRe.MatchString(alias),
			}
			continue
		}
		if directive != nil && directive.key == "match" {
			push()
			current = section{kind: sectionMatch, lines: []string{line}}
			continue
		}
		current.lines = append(current.lines, line)
	}
	push()
	return sections
}

func fieldsOf(lines []string, fallbackUser string) HostFields {
	values := keywordsOf(lines)
	alias := ""
	for _, line := range lines {
		if d := directiveOf(line); d != nil && d.key == "host" {
			tokens := strings.Fields(d.value)
			if len(tokens) > 0 {
				alias = tokens[0]
			}
			break
		}
	}
	find := func(key string) string {
		for _, item := range values {
			if item.key == key {
				return item.value
			}
		}
		return ""
	}
	username := find("user")
	if username == "" {
		username = fallbackUser
	}
	hostName := find("hostname")
	if hostName == "" {
		hostName = alias
	}
	fields := HostFields{
		HostName: hostName,
		Port:     numberOr(find("port"), 22),
		Username: username,
	}
	if proxy := find("proxyjump"); proxy != "" && strings.ToLower(proxy) != "none" {
		fields.Jumps = parseJumps(proxy)
	}
	if command := find("proxycommand"); command != "" && strings.ToLower(command) != "none" {
		fields.ProxyCommand = command
	}
	return fields
}

func applyFields(lines []string, alias string, fields HostFields) []string {
	next := make([]string, len(lines))
	copy(next, lines)
	for i, line := range next {
		directive := directiveOf(line)
		if directive == nil || directive.key != "host" {
			continue
		}
		indent := leadingWhitespace(line)
		next[i] = indent + "Host " + alias
	}
	next = setKeyword(next, "hostname", ptr(fields.HostName))
	next = setKeyword(next, "user", ptr(fields.Username))
	if fields.Port == 22 {
		next = setKeyword(next, "port", nil)
	} else {
		next = setKeyword(next, "port", ptr(strconv.Itoa(fields.Port)))
	}
	if len(fields.Jumps) > 0 {
		parts := make([]string, len(fields.Jumps))
		for i, hop := range fields.Jumps {
			parts[i] = FormatHop(hop)
		}
		next = setKeyword(next, "proxyjump", ptr(strings.Join(parts, ",")))
	} else {
		next = setKeyword(next, "proxyjump", nil)
	}
	if fields.ProxyCommand != "" {
		next = setKeyword(next, "proxycommand", ptr(fields.ProxyCommand))
	} else {
		next = setKeyword(next, "proxycommand", nil)
	}
	return next
}

func newBlock(alias string, fields HostFields) []string {
	return applyFields([]string{"Host " + alias}, alias, fields)
}

func ptr(s string) *string { return &s }

// setKeyword 更新某个关键字：value 为 nil 表示删掉所有出现；
// 否则保留最后一处（从后往前第一个）改写、删掉其余重复，都没有就插入。
func setKeyword(lines []string, key string, value *string) []string {
	seen := false
	for i := len(lines) - 1; i >= 0; i-- {
		directive := directiveOf(lines[i])
		if directive == nil || directive.key != key {
			continue
		}
		if value == nil || seen {
			lines = append(lines[:i], lines[i+1:]...)
			continue
		}
		lines[i] = lineWithValue(lines[i], directive, *value)
		seen = true
	}
	if value != nil && !seen {
		lines = insertKeyword(lines, key, *value)
	}
	return lines
}

func insertKeyword(lines []string, key, value string) []string {
	prefix := ""
	for _, line := range lines {
		if d := directiveOf(line); d != nil && d.key != "host" {
			prefix = leadingWhitespace(line)
			break
		}
	}
	if prefix == "" {
		prefix = "    "
	}
	row := prefix + canonical(key) + " " + quoteValue(value)
	at := len(lines)
	for at > 0 && strings.TrimSpace(lines[at-1]) == "" {
		at--
	}
	lines = append(lines, "")
	copy(lines[at+1:], lines[at:])
	lines[at] = row
	return lines
}

func lineWithValue(line string, directive *configDirective, value string) string {
	at := strings.Index(line, directive.rawValue)
	if at < 0 {
		return strings.TrimRight(line, " \t\r") + " " + quoteValue(value)
	}
	return line[:at] + quoteValue(value)
}

type configDirective struct {
	key      string
	value    string
	rawValue string
}

var (
	directiveRe    = regexp.MustCompile(`^\s*([A-Za-z][A-Za-z0-9]*)\s*(=\s*)?(.*)$`)
	spaceCommentRe = regexp.MustCompile(`\s#`)
)

func directiveOf(line string) *configDirective {
	match := directiveRe.FindStringSubmatch(line)
	if match == nil {
		return nil
	}
	if strings.HasPrefix(strings.TrimSpace(line), "#") {
		return nil
	}
	rawValue := match[3]
	if at := spaceCommentRe.FindStringIndex(rawValue); at != nil {
		rawValue = rawValue[:at[0]]
	}
	rawValue = strings.TrimSpace(rawValue)
	value := rawValue
	if len(value) >= 2 &&
		((value[0] == '"' && value[len(value)-1] == '"') ||
			(value[0] == '\'' && value[len(value)-1] == '\'')) {
		value = value[1 : len(value)-1]
	}
	return &configDirective{key: strings.ToLower(match[1]), value: value, rawValue: rawValue}
}

func keywordsOf(lines []string) []configDirective {
	var out []configDirective
	for _, line := range lines {
		if d := directiveOf(line); d != nil {
			out = append(out, *d)
		}
	}
	return out
}

func parseJumps(value string) []HopFields {
	var out []HopFields
	for _, part := range strings.Split(value, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if hop, ok := ParseHop(part); ok {
			out = append(out, hop)
		}
	}
	return out
}

// ParseHop 解析 user@host:port / [v6]:port 形式的跳板描述。
func ParseHop(value string) (HopFields, bool) {
	userPart := ""
	hostPort := value
	if at := strings.LastIndex(value, "@"); at >= 0 {
		userPart = value[:at]
		hostPort = value[at+1:]
	}
	if hostPort == "" {
		return HopFields{}, false
	}
	if strings.HasPrefix(hostPort, "[") {
		end := strings.Index(hostPort, "]")
		if end < 0 {
			return HopFields{}, false
		}
		host := hostPort[1:end]
		rest := hostPort[end+1:]
		port := 22
		if strings.HasPrefix(rest, ":") {
			port = numberOr(rest[1:], 22)
		}
		return HopFields{Host: host, Port: port, Username: userPart}, true
	}
	if colon := strings.LastIndex(hostPort, ":"); colon > 0 && isDigits(hostPort[colon+1:]) {
		return HopFields{Host: hostPort[:colon], Port: numberOr(hostPort[colon+1:], 22), Username: userPart}, true
	}
	return HopFields{Host: hostPort, Port: 22, Username: userPart}, true
}

// FormatHop 把跳板描述格式回 user@host:port（IPv6 加方括号，22 省略端口）。
func FormatHop(hop HopFields) string {
	host := hop.Host
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	target := host
	if hop.Port != 22 {
		target = host + ":" + strconv.Itoa(hop.Port)
	}
	if hop.Username != "" {
		return hop.Username + "@" + target
	}
	return target
}

func canonical(key string) string {
	switch key {
	case "hostname":
		return "HostName"
	case "user":
		return "User"
	case "port":
		return "Port"
	case "proxyjump":
		return "ProxyJump"
	case "proxycommand":
		return "ProxyCommand"
	}
	return key
}

var quoteNeededRe = regexp.MustCompile(`[\s#"]`)

func quoteValue(value string) string {
	if quoteNeededRe.MatchString(value) {
		return `"` + strings.ReplaceAll(value, `"`, `\"`) + `"`
	}
	return value
}

// numberOr 对应 TS 的 numberOr：1–65535 的整数，否则回退。
func numberOr(value string, fallback int) int {
	n, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
	if err != nil {
		return fallback
	}
	port := int(n)
	if float64(port) == n && port > 0 && port <= 65535 {
		return port
	}
	return fallback
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func leadingWhitespace(line string) string {
	for i, r := range line {
		if r != ' ' && r != '\t' {
			return line[:i]
		}
	}
	return line
}

func joinSections(sections []section) string {
	var out []string
	for _, section := range sections {
		out = append(out, section.lines...)
	}
	return strings.Join(out, "\n")
}

func finishConfig(text, newline string) string {
	body := strings.ReplaceAll(text, "\n", newline)
	if body == "" || strings.HasSuffix(body, newline) {
		return body
	}
	return body + newline
}

func normalizeConfig(text string) string {
	return strings.TrimRight(strings.ReplaceAll(text, "\r\n", "\n"), " \t\r\n")
}

var (
	whitespaceRunRe    = regexp.MustCompile(`\s+`)
	invalidAliasCharRe = regexp.MustCompile(`[^A-Za-z0-9_.@:-]`)
	leadingNonAlnumRe  = regexp.MustCompile(`^[^A-Za-z0-9]+`)
)
