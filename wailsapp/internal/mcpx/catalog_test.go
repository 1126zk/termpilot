package mcpx

import (
	"strings"
	"testing"
)

// toolExpect 一个工具的 schema 快照期望（从 TS tool-catalog.ts 逐一抄来）。
type toolExpect struct {
	name     string
	readOnly bool
	images   string
	// props: 字段名 → 类型（"s"=string, "i"=integer, "b"=boolean, "a"=array）
	props    map[string]string
	required []string
}

var toolExpectations = []toolExpect{
	{name: "connection_list", readOnly: true, props: map[string]string{}, required: nil},
	{name: "connection_open", props: map[string]string{"connection": "s"}, required: []string{"connection"}},
	{name: "connection_close", props: map[string]string{"connection": "s"}, required: []string{"connection"}},
	{
		name: "connection_create",
		props: map[string]string{
			"name": "s", "host": "s", "port": "i", "username": "s", "secret": "s", "group": "s", "remark": "s",
		},
		required: []string{"name"},
	},
	{
		name: "connection_update",
		props: map[string]string{
			"connection": "s", "name": "s", "host": "s", "port": "i", "username": "s", "secret": "s", "group": "s", "remark": "s",
		},
		required: []string{"connection"},
	},
	{name: "connection_delete", props: map[string]string{"connection": "s"}, required: []string{"connection"}},
	{name: "term_list", readOnly: true, props: map[string]string{}, required: nil},
	{
		name: "term_exec",
		props: map[string]string{
			"connection": "s", "command": "s", "session": "s", "prelude": "s", "timeout": "i", "maxBytes": "i",
		},
		required: []string{"connection", "command"},
	},
	{
		name:     "term_pty",
		props:    map[string]string{"termId": "s", "command": "s", "timeout": "i"},
		required: []string{"termId", "command"},
	},
	{
		name: "term_write",
		props: map[string]string{
			"termId": "s", "keys": "a", "text": "s", "submit": "b", "data": "s",
		},
		required: []string{"termId"},
	},
	{
		name:     "term_read",
		readOnly: true,
		props:    map[string]string{"termId": "s", "maxChars": "i"},
		required: []string{"termId"},
	},
	{name: "term_reconnect", props: map[string]string{"termId": "s"}, required: []string{"termId"}},
	{name: "term_close", props: map[string]string{"termId": "s"}, required: []string{"termId"}},
	{
		name:     "term_update",
		props:    map[string]string{"termId": "s", "remark": "s"},
		required: []string{"termId", "remark"},
	},
	{name: "term_open_local", props: map[string]string{}, required: nil},
	{
		name:     "term_lines",
		readOnly: true,
		props:    map[string]string{"termId": "s", "startLine": "i", "endLine": "i"},
		required: []string{"termId"},
	},
	{
		name:     "term_screenshot",
		readOnly: true,
		images:   "always",
		props:    map[string]string{"termId": "s", "startLine": "i", "endLine": "i"},
		required: []string{"termId"},
	},
	{
		name:     "term_screenshot_scrollback",
		readOnly: true,
		images:   "ranged",
		props:    map[string]string{"termId": "s", "startLine": "i", "endLine": "i"},
		required: []string{"termId"},
	},
	{
		name:     "sftp_list",
		readOnly: true,
		props:    map[string]string{"connection": "s", "path": "s"},
		required: []string{"connection"},
	},
	{
		name:     "sftp_mkdir",
		props:    map[string]string{"connection": "s", "path": "s"},
		required: []string{"connection", "path"},
	},
	{
		name:     "sftp_upload",
		props:    map[string]string{"connection": "s", "localPath": "s", "remotePath": "s"},
		required: []string{"connection", "localPath", "remotePath"},
	},
	{
		name:     "sftp_download",
		props:    map[string]string{"connection": "s", "remotePath": "s", "localPath": "s"},
		required: []string{"connection", "remotePath", "localPath"},
	},
	{
		name:     "sftp_rename",
		props:    map[string]string{"connection": "s", "from": "s", "to": "s"},
		required: []string{"connection", "from", "to"},
	},
	{
		name:     "sftp_remove",
		props:    map[string]string{"connection": "s", "path": "s", "kind": "s"},
		required: []string{"connection", "path", "kind"},
	},
}

// TestToolCatalogSnapshot 24 个工具的名称/顺序/只读标记/必填字段/字段类型与
// TS tool-catalog.ts 逐一对齐。
func TestToolCatalogSnapshot(t *testing.T) {
	if len(TOOLS) != len(toolExpectations) {
		t.Fatalf("工具数量: got %d, want %d", len(TOOLS), len(toolExpectations))
	}
	for i, want := range toolExpectations {
		tool := TOOLS[i]
		if tool.Name != want.name {
			t.Errorf("TOOLS[%d]: name got %q, want %q", i, tool.Name, want.name)
			continue
		}
		if tool.ReadOnly != want.readOnly {
			t.Errorf("%s: readOnly got %v, want %v", tool.Name, tool.ReadOnly, want.readOnly)
		}
		if tool.Images != want.images {
			t.Errorf("%s: images got %q, want %q", tool.Name, tool.Images, want.images)
		}
		if tool.Description == "" {
			t.Errorf("%s: description 为空", tool.Name)
		}
		if len(tool.Input) != len(want.props) {
			t.Errorf("%s: 字段数 got %d, want %d", tool.Name, len(tool.Input), len(want.props))
		}
		var gotRequired []string
		for _, f := range tool.Input {
			wantType, ok := want.props[f.Name]
			if !ok {
				t.Errorf("%s: 多余字段 %s", tool.Name, f.Name)
				continue
			}
			typeCode := map[string]string{"string": "s", "integer": "i", "boolean": "b", "array": "a"}[f.Type]
			if typeCode != wantType {
				t.Errorf("%s.%s: 类型 got %s, want %s", tool.Name, f.Name, f.Type, wantType)
			}
			if f.Description == "" {
				t.Errorf("%s.%s: description 为空", tool.Name, f.Name)
			}
			if f.Required {
				gotRequired = append(gotRequired, f.Name)
			}
		}
		if strings.Join(gotRequired, ",") != strings.Join(want.required, ",") {
			t.Errorf("%s: required got %v, want %v", tool.Name, gotRequired, want.required)
		}
	}
}

// TestSchemaConstraints 抽查数值范围、枚举与数组约束。
func TestSchemaConstraints(t *testing.T) {
	exec, _ := FindTool("term_exec")
	timeout := exec.field("timeout")
	if timeout == nil || timeout.Min == nil || *timeout.Min != 1 || timeout.Max == nil || *timeout.Max != 3600 {
		t.Errorf("term_exec.timeout 范围: %+v", timeout)
	}
	maxBytes := exec.field("maxBytes")
	if maxBytes == nil || *maxBytes.Min != 1000 || *maxBytes.Max != 1000000 {
		t.Errorf("term_exec.maxBytes 范围: %+v", maxBytes)
	}
	write, _ := FindTool("term_write")
	keys := write.field("keys")
	if keys == nil || keys.MaxItems != 40 || len(keys.ItemEnum) != len(TermKeys) {
		t.Errorf("term_write.keys: %+v", keys)
	}
	if text := write.field("text"); text == nil || text.MaxLen != 4096 {
		t.Errorf("term_write.text: %+v", text)
	}
	if data := write.field("data"); data == nil || data.MaxLen != 65536 {
		t.Errorf("term_write.data: %+v", data)
	}
	read, _ := FindTool("term_read")
	if maxChars := read.field("maxChars"); maxChars == nil || *maxChars.Min != 200 || *maxChars.Max != 50000 {
		t.Errorf("term_read.maxChars: %+v", maxChars)
	}
	remove, _ := FindTool("sftp_remove")
	kind := remove.field("kind")
	if kind == nil || strings.Join(kind.Enum, ",") != "file,dir,link" {
		t.Errorf("sftp_remove.kind: %+v", kind)
	}
	create, _ := FindTool("connection_create")
	if port := create.field("port"); port == nil || *port.Min != 1 || *port.Max != 65535 {
		t.Errorf("connection_create.port: %+v", port)
	}
}

// TestSchemaTextGolden 逐字节对齐 TS schemaText('sftp_remove') 的输出
// （JSON.stringify(…, null, 2)，字段序 = 声明序）。
func TestSchemaTextGolden(t *testing.T) {
	want := `{
  "name": "sftp_remove",
  "description": "删除远端文件或目录。目录会连同里面的内容一起删除。",
  "inputSchema": {
    "type": "object",
    "properties": {
      "connection": {
        "type": "string",
        "description": "连接编号，conn- 开头。不要填名称或备注，也不要填 term- 开头的终端编号"
      },
      "path": {
        "type": "string",
        "description": "远端路径"
      },
      "kind": {
        "type": "string",
        "description": "file、dir 或 link",
        "enum": [
          "file",
          "dir",
          "link"
        ]
      }
    },
    "required": [
      "connection",
      "path",
      "kind"
    ]
  }
}`
	got, err := SchemaText("sftp_remove")
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Errorf("schemaText 输出不一致:\n--- got ---\n%s\n--- want ---\n%s", got, want)
	}
}

// TestSchemaTextGoldenNoInput 无入参工具的 schema（TS toolSchema 恒含 properties/required）。
func TestSchemaTextGoldenNoInput(t *testing.T) {
	want := `{
  "name": "term_open_local",
  "description": "打开一扇本机终端，返回 termId。没有连接。之后用 term_pty 执行命令，并用 term_update 写上备注。",
  "inputSchema": {
    "type": "object",
    "properties": {},
    "required": []
  }
}`
	got, err := SchemaText("term_open_local")
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Errorf("schemaText 输出不一致:\n--- got ---\n%s\n--- want ---\n%s", got, want)
	}
}

func TestSchemaTextUnknown(t *testing.T) {
	if _, err := SchemaText("no_such_tool"); err == nil || !strings.Contains(err.Error(), "未知命令") {
		t.Errorf("未知工具应报错: %v", err)
	}
}

func TestToolsText(t *testing.T) {
	text := ToolsText()
	for _, tool := range TOOLS {
		if !strings.Contains(text, `"name": "`+tool.Name+`"`) {
			t.Errorf("toolsText 缺 %s", tool.Name)
		}
	}
	if !strings.HasPrefix(text, "[\n  {\n") {
		t.Errorf("toolsText 缩进形状不对: %.40q", text)
	}
}

// TestToolsTextGolden 逐字节对齐 TS toolsText() 的第一项。
func TestToolsTextGolden(t *testing.T) {
	want := `[
  {
    "name": "connection_list",
    "description": "列出已保存的正向 SSH 连接。id 是 conn- 编号，用来调用。name 和 remark 只帮助认出这条连接是干什么的，不能拿去当参数。不含密码。"
  },`
	got := ToolsText()
	if !strings.HasPrefix(got, want) {
		t.Errorf("toolsText 前缀不一致:\n--- got ---\n%.400s", got)
	}
}
