// Package mcpx 是 TermPilot 本机 MCP 服务的 Go 移植，语义逐一对应 Electron 版
// src/main/services/McpService.ts + tool-catalog.ts：
//   - 24 个工具（connection_* / term_* / sftp_*）的定义、描述、入参校验与 TS 完全一致；
//   - StreamableHTTP 挂 127.0.0.1:<port>/mcp（go-sdk），/cli 端点提供
//     op=tools/schema/call 的命令行协议（与 wailsapp/spikes/mcp 验证的契约一致）；
//   - Host 白名单 + 回环地址 + Bearer 令牌（crypto/subtle 常量时间比较）；
//   - 危险命令/敏感路径确认、审计、截图与行读取的前端合成链路，
//     都通过注入接口交给上层 bridge（见 deps.go），本包不依赖 Wails。
package mcpx

import (
	"fmt"
	"strings"

	"github.com/google/jsonschema-go/jsonschema"
)

// 注意：go-sdk v1.8.0 用的 jsonschema-go v0.4.3 只支持从 jsonschema tag 推 description，
// enum / minimum / maximum / maxItems 等约束无法靠 tag 表达。所以这里不用结构体推断，
// 而由这张字段规格表同时生成：MCP 注册的 inputSchema、/cli 的 schema 文本、
// 以及 /cli call 的参数校验——三处共享一份定义，与 TS tool-catalog.ts 的 zod shape 对应。

// FieldSpec 一个入参字段的规格，对应 TS 里 zod shape 的一个条目。
type FieldSpec struct {
	Name        string
	Type        string // "string" | "integer" | "boolean" | "array"
	Required    bool
	Description string
	Enum        []string // Type=string 时的枚举（sftp_remove.kind）
	ItemEnum    []string // Type=array 时的元素枚举（term_write.keys）
	Min         *int     // integer 下界
	Max         *int     // integer 上界
	MaxLen      int      // string 的 maxLength
	MaxItems    int      // array 的 maxItems
}

// ToolDef 一个工具的定义，对应 TS ToolDef。
type ToolDef struct {
	Name        string
	Description string
	ReadOnly    bool
	// Images 截图类工具把图片附在 MCP 结果里（"always" | "ranged"）；/cli 只返回路径。
	Images string
	Input  []FieldSpec
}

func intPtr(v int) *int { return &v }

var (
	connIDField = FieldSpec{
		Name: "connection", Type: "string", Required: true,
		Description: "连接编号，conn- 开头。不要填名称或备注，也不要填 term- 开头的终端编号",
	}
	termIDField = FieldSpec{
		Name: "termId", Type: "string", Required: true,
		Description: "终端编号，term- 开头",
	}
)

// sessionFields 对应 TS 的 sessionFields。
func sessionFields() []FieldSpec {
	return []FieldSpec{
		{Name: "host", Type: "string", Description: "SSH 主机"},
		{Name: "port", Type: "integer", Min: intPtr(1), Max: intPtr(65535), Description: "SSH 端口，默认 22"},
		{Name: "username", Type: "string", Description: "SSH 登录用户"},
		{Name: "secret", Type: "string", Description: "密码。加密保存，之后不会再返回。留空表示不修改"},
		{Name: "group", Type: "string", Description: "侧边栏分组，留空归入未分组"},
		{Name: "remark", Type: "string", Description: "备注"},
	}
}

// lineFields 对应 TS 的 lineFields。
func lineFields() []FieldSpec {
	return []FieldSpec{
		termIDField,
		{Name: "startLine", Type: "integer", Min: intPtr(0), Description: "起始行，包含。0 是最旧的一行"},
		{Name: "endLine", Type: "integer", Min: intPtr(0), Description: "结束行，包含"},
	}
}

func withFields(head []FieldSpec, tail ...FieldSpec) []FieldSpec {
	out := make([]FieldSpec, 0, len(head)+len(tail))
	out = append(out, head...)
	out = append(out, tail...)
	return out
}

// TOOLS 与 TS tool-catalog.ts 的 TOOLS 逐一对应（顺序一致）。
var TOOLS = []ToolDef{
	{
		Name:        "connection_list",
		Description: "列出已保存的正向 SSH 连接。id 是 conn- 编号，用来调用。name 和 remark 只帮助认出这条连接是干什么的，不能拿去当参数。不含密码。",
		ReadOnly:    true,
	},
	{
		Name:        "connection_open",
		Description: "按 conn- 编号打开一条 SSH 连接，并新开一扇终端。返回的 termId 只属于这扇终端。",
		Input:       []FieldSpec{connIDField},
	},
	{
		Name:        "connection_close",
		Description: "关掉某条连接下的全部终端，并断开它的文件通道。",
		Input:       []FieldSpec{connIDField},
	},
	{
		Name:        "connection_create",
		Description: "新建并保存一条正向 SSH 连接，返回 conn- 编号。要 host/username/secret（密码加密存在本机）。弄清它是干什么的之后，用 connection_update 写上 remark。",
		Input: withFields([]FieldSpec{
			{Name: "name", Type: "string", Required: true, Description: "显示名称，不能和已有连接重名"},
		}, sessionFields()...),
	},
	{
		Name:        "connection_update",
		Description: "修改已保存的连接。connection 填 conn- 编号。写备注填 remark。名称和备注都不参与查找。已经打开的终端不会自动重连。",
		Input: withFields([]FieldSpec{
			connIDField,
			{Name: "name", Type: "string", Description: "新的显示名称"},
		}, sessionFields()...),
	},
	{
		Name:        "connection_delete",
		Description: "删除一条已保存的连接，并关掉它打开的终端。开启危险确认时会先询问。",
		Input:       []FieldSpec{connIDField},
	},
	{
		Name:        "term_list",
		Description: "列出打开过、还没关掉的终端。status 为 connected 表示还连着，disconnected 或 error 表示已经断开。重启之后编号、标题和备注还在，上次退出时已经画好的行也会按行写回，新会话从下一行开始。断开时用 term_reconnect 恢复同一扇，不要再 connection_open。termId 是 term- 编号。",
		ReadOnly:    true,
	},
	{
		Name:        "term_exec",
		Description: "执行命令的默认工具。在独立 exec 通道上跑，不占终端画面，可以并发，也不需要先开终端。返回 JSON：stdout 和 stderr 分流返回，都是原始字节流（不折行、无回显、无 ANSI）；exitCode 来自协议事件；另有 duration（秒）、timedOut、truncated。命令原样交给远端 bash（没有则 sh）执行，多行、heredoc、引号都支持，不要自己转义。session 填同一个名字时，cd 和 export 跨调用承接（存在远端 ~/.cache/termpilot/exec/ 下）；不填则每次全新环境。prelude 在每次执行前注入固定的 source/export。交互式操作、TUI、要看终端画面或截图时用 term_pty。",
		Input: []FieldSpec{
			connIDField,
			{Name: "command", Type: "string", Required: true, Description: "要执行的命令，原样嵌入远端脚本，不需要转义"},
			{Name: "session", Type: "string", Description: "环境会话名。填了就在同名会话间承接 cd 和 export；不填每次全新环境"},
			{Name: "prelude", Type: "string", Description: "每次执行前先注入的片段，比如 source 环境脚本。固定不变的环境配置放这里"},
			{Name: "timeout", Type: "integer", Min: intPtr(1), Max: intPtr(3600), Description: "最多等多少秒，默认 20。到点后断开通道（timedOut 为 true）并返回已经收到的内容，远端进程可能已被挂断。命令预计要跑很久时，把这个值调大。"},
			{Name: "maxBytes", Type: "integer", Min: intPtr(1000), Max: intPtr(1000000), Description: "stdout 和 stderr 各自最多返回多少字符，默认 50000。超出时保留开头和结尾，truncated 为 true"},
		},
	},
	{
		Name:        "term_pty",
		Description: "把命令打进这扇已经打开的终端。等它跑完（提示符回到画面）后，只返回这次新出现的内容；POSIX shell 还会带回退出码。输出是终端渲染结果：有回显、按窗口宽度折行、可能带颜色，不要拿去给程序解析——解析用 term_exec。到 timeout 还没跑完，就先把已经回来的内容交出去，命令还在远端跑。菜单、安装向导和 TUI 还在跑时不要用它，改用 term_write。停掉前台命令用 term_write，keys 填 [\"ctrl-c\"]。",
		Input: []FieldSpec{
			termIDField,
			{Name: "command", Type: "string", Required: true, Description: "要执行的命令。末尾没有换行时会自动补上"},
			{Name: "timeout", Type: "integer", Min: intPtr(1), Max: intPtr(3600), Description: "这次调用最多等多少秒，默认 20。不是命令的时限。到点后还没回到提示符，就先把已经回来的内容交出去，命令还在远端跑。命令预计要跑很久时，把这个值调大。"},
		},
	},
	{
		Name:        "term_write",
		Description: "向当前终端发送按键或文字，用于上下左右选择、输入内容、回车确认和 TUI。仅作用于 PTY 终端。keys 按顺序先发，然后输入 text，submit 为 true 时最后回车。发完返回当前画面。密码和验证码不要代填。",
		Input: []FieldSpec{
			termIDField,
			{Name: "keys", Type: "array", ItemEnum: TermKeys, MaxItems: 40, Description: "按键名，按顺序发送"},
			{Name: "text", Type: "string", MaxLen: 4096, Description: "紧接在 keys 后面输入的文字"},
			{Name: "submit", Type: "boolean", Description: "输入后再补一次回车"},
			{Name: "data", Type: "string", MaxLen: 65536, Description: "原始字节，只在 keys 无法表达时使用"},
		},
	},
	{
		Name:        "term_read",
		Description: "读取终端最近输出，已去掉 ANSI 控制符。仅作用于 PTY 终端。",
		ReadOnly:    true,
		Input: []FieldSpec{
			termIDField,
			{Name: "maxChars", Type: "integer", Min: intPtr(200), Max: intPtr(50000), Description: "最多返回多少字符，默认 8000"},
		},
	},
	{
		Name:        "term_reconnect",
		Description: "把已经断开的终端重新连上。编号、标题和备注保留，上次退出时已经画好的行也会按行写回。已经连着时直接返回。不要为此再调用 connection_open。",
		Input:       []FieldSpec{termIDField},
	},
	{
		Name:        "term_close",
		Description: "断开并关闭一个终端标签。",
		Input:       []FieldSpec{termIDField},
	},
	{
		Name:        "term_update",
		Description: "给一扇已经打开的终端写备注，方便以后认出它在做什么。编号不变。",
		Input: []FieldSpec{
			termIDField,
			{Name: "remark", Type: "string", Required: true, Description: "这扇终端正在做什么。空字符串表示清掉"},
		},
	},
	{
		Name:        "term_open_local",
		Description: "打开一扇本机终端，返回 termId。没有连接。之后用 term_pty 执行命令，并用 term_update 写上备注。",
	},
	{
		Name:        "term_lines",
		Description: "读出终端缓冲里的文字，每行带行号。仅作用于 PTY 终端。不填范围就是当前画面。0 是最旧的一行。先用它确定行号，再交给 term_screenshot。",
		ReadOnly:    true,
		Input:       lineFields(),
	},
	{
		Name:        "term_screenshot",
		Description: "截取终端画面。仅作用于 PTY 终端。不填行号就截当前这一屏。填了 startLine 和 endLine（两端都包含，0 是最旧的一行）就只返回这一段裁好的图。一次大约 20 屏，更长就只保留末尾，结果里写明缓冲总行数和实际截到的行。行号用 term_lines 查。设置里打开「合成算法」时按缓冲拼图，不滚动正在看的画面；关闭时拍摄已经画出来的画面。",
		ReadOnly:    true,
		Images:      "always",
		Input:       lineFields(),
	},
	{
		Name:        "term_screenshot_scrollback",
		Description: "把终端缓冲接成长图。仅作用于 PTY 终端。startLine / endLine 两端都包含，0 是最旧的一行；填了范围就只返回裁好的这一段。一次大约 20 屏，超过后分成多张并只保留末尾，结果写明「缓冲共 X 行，已截取第 A–B 行（超出上限）」。设置里打开「合成算法」时按缓冲拼图，不滚动正在看的画面；关闭时逐屏拍摄再接上。",
		ReadOnly:    true,
		Images:      "ranged",
		Input:       lineFields(),
	},
	{
		Name:        "sftp_list",
		Description: "列出正向 SSH 会话的远端目录。",
		ReadOnly:    true,
		Input: []FieldSpec{
			connIDField,
			{Name: "path", Type: "string", Description: "远端目录，默认家目录"},
		},
	},
	{
		Name:        "sftp_mkdir",
		Description: "在正向 SSH 上新建远端目录。path 是完整远端路径。",
		Input: []FieldSpec{
			connIDField,
			{Name: "path", Type: "string", Required: true, Description: "完整远端路径"},
		},
	},
	{
		Name:        "sftp_upload",
		Description: "把本机绝对路径的文件上传到远端路径。超过 512MB 会拒绝。",
		Input: []FieldSpec{
			connIDField,
			{Name: "localPath", Type: "string", Required: true, Description: "本机绝对路径"},
			{Name: "remotePath", Type: "string", Required: true, Description: "远端路径"},
		},
	},
	{
		Name:        "sftp_download",
		Description: "把远端文件下载到本机绝对路径。超过 512MB 会拒绝。几个 GB 的文件留在远程机器上处理。",
		Input: []FieldSpec{
			connIDField,
			{Name: "remotePath", Type: "string", Required: true, Description: "远端路径"},
			{Name: "localPath", Type: "string", Required: true, Description: "本机绝对路径"},
		},
	},
	{
		Name:        "sftp_rename",
		Description: "重命名或移动远端文件。from 和 to 都是远端路径。",
		Input: []FieldSpec{
			connIDField,
			{Name: "from", Type: "string", Required: true, Description: "原远端路径"},
			{Name: "to", Type: "string", Required: true, Description: "新远端路径"},
		},
	},
	{
		Name:        "sftp_remove",
		Description: "删除远端文件或目录。目录会连同里面的内容一起删除。",
		Input: []FieldSpec{
			connIDField,
			{Name: "path", Type: "string", Required: true, Description: "远端路径"},
			{Name: "kind", Type: "string", Required: true, Enum: []string{"file", "dir", "link"}, Description: "file、dir 或 link"},
		},
	},
}

// FindTool 对应 TS findTool。
func FindTool(name string) (*ToolDef, error) {
	for i := range TOOLS {
		if TOOLS[i].Name == name {
			return &TOOLS[i], nil
		}
	}
	return nil, fmt.Errorf("未知命令: %s", name)
}

func (t *ToolDef) field(name string) *FieldSpec {
	for i := range t.Input {
		if t.Input[i].Name == name {
			return &t.Input[i]
		}
	}
	return nil
}

// stripUnknown 对应 zod object 的 strip 行为：未声明的键不进 invoke，也不进审计。
func (t *ToolDef) stripUnknown(raw map[string]any) map[string]any {
	if len(t.Input) == 0 {
		return map[string]any{}
	}
	out := make(map[string]any, len(t.Input))
	for _, f := range t.Input {
		if v, ok := raw[f.Name]; ok {
			out[f.Name] = v
		}
	}
	return out
}

// mcpInputSchema 生成注册给 go-sdk 的 inputSchema。与 TS 的 zod shape 经
// zod-to-json-schema 展开后的约束一致（type/description/enum/items/minimum/
// maximum/maxLength/maxItems/required）。
func (t *ToolDef) mcpInputSchema() *jsonschema.Schema {
	schema := &jsonschema.Schema{Type: "object"}
	if len(t.Input) == 0 {
		return schema
	}
	schema.Properties = make(map[string]*jsonschema.Schema, len(t.Input))
	for _, f := range t.Input {
		fs := &jsonschema.Schema{Type: f.Type, Description: f.Description}
		if len(f.Enum) > 0 {
			fs.Enum = stringEnums(f.Enum)
		}
		if len(f.ItemEnum) > 0 {
			fs.Items = &jsonschema.Schema{Type: "string", Enum: stringEnums(f.ItemEnum)}
		}
		if f.Min != nil {
			v := float64(*f.Min)
			fs.Minimum = &v
		}
		if f.Max != nil {
			v := float64(*f.Max)
			fs.Maximum = &v
		}
		if f.MaxLen > 0 {
			v := f.MaxLen
			fs.MaxLength = &v
		}
		if f.MaxItems > 0 {
			v := f.MaxItems
			fs.MaxItems = &v
		}
		schema.Properties[f.Name] = fs
		if f.Required {
			schema.Required = append(schema.Required, f.Name)
		}
	}
	return schema
}

func stringEnums(values []string) []any {
	out := make([]any, len(values))
	for i, v := range values {
		out[i] = v
	}
	return out
}

// ------------------------------------------------ /cli 文本（对齐 TS toolsText / schemaText / toolSchema）

// ToolsText 对应 TS toolsText()：JSON.stringify([{name, description}], null, 2)。
func ToolsText() string {
	list := make([]any, len(TOOLS))
	for i, t := range TOOLS {
		list[i] = omap{{"name", t.Name}, {"description", t.Description}}
	}
	return marshalJSON(list, 2)
}

// SchemaText 对应 TS schemaText(name?)：不给名字返回全部，否则返回单个。
func SchemaText(name string) (string, error) {
	if name == "" {
		list := make([]any, len(TOOLS))
		for i := range TOOLS {
			list[i] = toolSchema(&TOOLS[i])
		}
		return marshalJSON(list, 2), nil
	}
	tool, err := FindTool(name)
	if err != nil {
		return "", err
	}
	return marshalJSON(toolSchema(tool), 2), nil
}

// toolSchema 对应 TS toolSchema：{name, description, inputSchema:{type, properties, required}}。
// properties 的键序保持声明顺序（TS 的 Object.entries 是插入序）。
func toolSchema(tool *ToolDef) any {
	properties := make(omap, 0, len(tool.Input))
	required := make([]any, 0, len(tool.Input))
	for _, f := range tool.Input {
		properties = append(properties, kv{f.Name, fieldSchema(f)})
		if f.Required {
			required = append(required, f.Name)
		}
	}
	return omap{
		{"name", tool.Name},
		{"description", tool.Description},
		{"inputSchema", omap{
			{"type", "object"},
			{"properties", properties},
			{"required", required},
		}},
	}
}

// fieldSchema 对应 TS fieldJson：{type, description?, enum?, items?, minimum?, maximum?}。
func fieldSchema(f FieldSpec) any {
	out := omap{{"type", f.Type}}
	if f.Description != "" {
		out = append(out, kv{"description", f.Description})
	}
	if len(f.Enum) > 0 {
		vals := make([]any, len(f.Enum))
		for i, v := range f.Enum {
			vals[i] = v
		}
		out = append(out, kv{"enum", vals})
	}
	if len(f.ItemEnum) > 0 {
		vals := make([]any, len(f.ItemEnum))
		for i, v := range f.ItemEnum {
			vals[i] = v
		}
		out = append(out, kv{"items", omap{{"type", "string"}, {"enum", vals}}})
	}
	if f.Min != nil {
		out = append(out, kv{"minimum", *f.Min})
	}
	if f.Max != nil {
		out = append(out, kv{"maximum", *f.Max})
	}
	return out
}

// ------------------------------------------------ 保序 JSON（对齐 JSON.stringify(v, null, 2)）

// kv / omap 保序的 JSON 对象。Go 的 map 序列化按键排序，与 TS Object.entries
// 的插入序不同；toolsText/schemaText 要与 TS 输出逐字节一致，对象一律用 omap。
type kv struct {
	key string
	val any
}
type omap []kv

func marshalJSON(v any, indent int) string {
	var b strings.Builder
	writeOrdered(&b, v, indent, 0)
	return b.String()
}

func writeOrdered(b *strings.Builder, v any, indent, level int) {
	switch value := v.(type) {
	case omap:
		if len(value) == 0 {
			b.WriteString("{}")
			return
		}
		b.WriteString("{")
		for i, pair := range value {
			if i > 0 {
				b.WriteString(",")
			}
			writeNewlineIndent(b, indent, level+1)
			b.WriteString(jsonString(pair.key))
			b.WriteString(": ")
			writeOrdered(b, pair.val, indent, level+1)
		}
		writeNewlineIndent(b, indent, level)
		b.WriteString("}")
	case []any:
		if len(value) == 0 {
			b.WriteString("[]")
			return
		}
		b.WriteString("[")
		for i, item := range value {
			if i > 0 {
				b.WriteString(",")
			}
			writeNewlineIndent(b, indent, level+1)
			writeOrdered(b, item, indent, level+1)
		}
		writeNewlineIndent(b, indent, level)
		b.WriteString("]")
	case string:
		b.WriteString(jsonString(value))
	case int:
		fmt.Fprintf(b, "%d", value)
	case bool:
		if value {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case nil:
		b.WriteString("null")
	default:
		panic(fmt.Sprintf("marshalJSON: 不支持的类型 %T", v))
	}
}

func writeNewlineIndent(b *strings.Builder, indent, level int) {
	if indent <= 0 {
		return
	}
	b.WriteString("\n")
	b.WriteString(strings.Repeat(" ", indent*level))
}
