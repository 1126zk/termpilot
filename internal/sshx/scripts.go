package sshx

import (
	"encoding/base64"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// 脚本库（面板"脚本"页）：脚本内容存本地（前端 localStorage），执行和定时任务都走这里。
// 执行就是 Exec 套壳：set -e + 逐行输出 + 超时/退出码检查。
// 定时任务落在用户 crontab：脚本内容写到 ~/.termpilot/scripts/<id>.sh，crontab 行尾带
// # termpilot:<id> 标记——列出和删除都认这个标记，用户自己手写的条目只读不动。

// CronEntry 一条 crontab 条目。Ours=true 是面板建的（行尾有标记），可以删；
// 其余是用户自己写的，只展示。
type CronEntry struct {
	ID       string `json:"id"`
	Schedule string `json:"schedule"`
	Command  string `json:"command"`
	Ours     bool   `json:"ours"`
}

// cronMarkerRe 行尾标记：# termpilot:<id>
var cronMarkerRe = regexp.MustCompile(`\s*# termpilot:([a-zA-Z0-9._-]+)\s*$`)

// cronScheduleRe 五段表达式或 @daily 这类关键字，字符白名单防注入。
var cronScheduleRe = regexp.MustCompile(`^([0-9*/,-]+( [0-9*/,-]+){4}|@(reboot|yearly|annually|monthly|weekly|daily|midnight|hourly))$`)

// RunScript 在当前会话上跑一段脚本，输出逐行回调。超时 10 分钟。
func (s *ExecService) RunScript(sessionID, content string, onLine func(string)) error {
	if strings.TrimSpace(content) == "" {
		return fmt.Errorf("脚本是空的")
	}
	res, err := s.Exec(sessionID, ExecOptions{Command: "set -e\n" + content, TimeoutMs: 600000, OnLine: onLine})
	if err != nil {
		return err
	}
	if res.TimedOut {
		return fmt.Errorf("执行超时（10 分钟）")
	}
	if res.ExitCode != nil && *res.ExitCode != 0 {
		return fmt.Errorf("执行失败（退出码 %d）", *res.ExitCode)
	}
	return nil
}

// CronList 读当前用户的 crontab。crontab 不存在时 crontab -l 报错，按空列表处理。
func (s *ExecService) CronList(sessionID string) ([]CronEntry, error) {
	res, err := s.Exec(sessionID, ExecOptions{Command: "crontab -l 2>/dev/null || true", TimeoutMs: 10000})
	if err != nil {
		return nil, err
	}
	entries := []CronEntry{}
	for _, line := range strings.Split(res.Stdout, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		entry := CronEntry{Command: line}
		if m := cronMarkerRe.FindStringSubmatch(line); len(m) == 2 {
			entry.ID = m[1]
			entry.Ours = true
			entry.Command = strings.TrimSpace(cronMarkerRe.ReplaceAllString(line, ""))
		}
		// 前 5 段是周期，剩下是命令；@daily 这类关键字单独一段
		if strings.HasPrefix(entry.Command, "@") {
			parts := strings.SplitN(entry.Command, " ", 2)
			entry.Schedule = parts[0]
			if len(parts) == 2 {
				entry.Command = strings.TrimSpace(parts[1])
			} else {
				entry.Command = ""
			}
		} else {
			parts := strings.SplitN(entry.Command, " ", 6)
			if len(parts) == 6 {
				entry.Schedule = strings.Join(parts[:5], " ")
				entry.Command = strings.TrimSpace(parts[5])
			}
		}
		entries = append(entries, entry)
	}
	return entries, nil
}

// CronAdd 加一条定时任务：脚本内容写到 ~/.termpilot/scripts/<id>.sh，crontab 追加一行。
// id 面板生成（t+时间戳），重名不冲突。
func (s *ExecService) CronAdd(sessionID, schedule, content string) (CronEntry, error) {
	if !cronScheduleRe.MatchString(strings.TrimSpace(schedule)) {
		return CronEntry{}, fmt.Errorf("周期写法不对：五段表达式（如 0 3 * * *）或 @daily 这类关键字，收到 %q", schedule)
	}
	if strings.TrimSpace(content) == "" {
		return CronEntry{}, fmt.Errorf("脚本是空的")
	}
	id := fmt.Sprintf("t%d", time.Now().Unix())
	encoded := base64.StdEncoding.EncodeToString([]byte(content))
	// base64 过 SSH 防引号/换行；crontab 追加用管道整体写回
	script := fmt.Sprintf(`set -e
dir="$HOME/.termpilot/scripts"
mkdir -p "$dir"
{ echo %s | base64 -d; echo; } > "$dir/%s.sh"
chmod +x "$dir/%s.sh"
( crontab -l 2>/dev/null; echo '%s bash "$HOME/.termpilot/scripts/%s.sh" # termpilot:%s' ) | crontab -
`, encoded, id, id, strings.TrimSpace(schedule), id, id)
	res, err := s.Exec(sessionID, ExecOptions{Command: script, TimeoutMs: 15000})
	if err != nil {
		return CronEntry{}, err
	}
	if res.ExitCode != nil && *res.ExitCode != 0 {
		return CronEntry{}, fmt.Errorf("添加定时任务失败（退出码 %d）：%s", *res.ExitCode, strings.TrimSpace(res.Stderr))
	}
	return CronEntry{ID: id, Schedule: strings.TrimSpace(schedule), Command: content, Ours: true}, nil
}

// CronDel 删面板建的任务：crontab 里按标记过滤掉，再删脚本文件。只认标记 id，别人的条目不动。
func (s *ExecService) CronDel(sessionID, id string) error {
	if !cronMarkerRe.MatchString(" # termpilot:" + id) {
		return fmt.Errorf("非法的任务 id：%q", id)
	}
	script := fmt.Sprintf(`crontab -l 2>/dev/null | grep -v '# termpilot:%s$' | crontab -
rm -f "$HOME/.termpilot/scripts/%s.sh"
`, id, id)
	res, err := s.Exec(sessionID, ExecOptions{Command: script, TimeoutMs: 15000})
	if err != nil {
		return err
	}
	if res.ExitCode != nil && *res.ExitCode != 0 {
		return fmt.Errorf("删除定时任务失败（退出码 %d）：%s", *res.ExitCode, strings.TrimSpace(res.Stderr))
	}
	return nil
}
