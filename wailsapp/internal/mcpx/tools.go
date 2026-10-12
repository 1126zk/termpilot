package mcpx

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"termpilot/app/internal/sftpx"
	"termpilot/app/internal/sshx"
	"termpilot/app/internal/storage"
	"termpilot/app/internal/terminal"
)

// invoke 对应 TS McpService.invoke：24 个工具的分发。
// 入参 raw 已经过了 schema 校验与 strip，但运行时校验（编号前缀、必填、
// 终端/连接存在性）与 TS 一样在这里做。
func (s *Service) invoke(ctx context.Context, tool string, raw map[string]any) (string, error) {
	switch tool {
	case "connection_list":
		sessions, err := s.deps.Storage.List()
		if err != nil {
			return "", err
		}
		views := make([]connectionView, 0, len(sessions))
		for _, session := range sessions {
			views = append(views, makeConnectionView(session))
		}
		return prettyJSON(views)
	case "connection_open":
		key, err := need(raw, "connection")
		if err != nil {
			return "", err
		}
		return s.connectSession(ctx, key)
	case "connection_close":
		key, err := need(raw, "connection")
		if err != nil {
			return "", err
		}
		return s.disconnectSession(key)
	case "connection_create":
		name, err := need(raw, "name")
		if err != nil {
			return "", err
		}
		patch, err := readSessionPatch(raw)
		if err != nil {
			return "", err
		}
		patch.name = &name
		return s.createSession(patch)
	case "connection_update":
		key, err := need(raw, "connection")
		if err != nil {
			return "", err
		}
		patch, err := readSessionPatch(raw)
		if err != nil {
			return "", err
		}
		if patch.name, err = textArg(raw, "name"); err != nil {
			return "", err
		}
		return s.updateSession(key, patch)
	case "connection_delete":
		key, err := need(raw, "connection")
		if err != nil {
			return "", err
		}
		return s.deleteSession(ctx, key)
	case "term_list":
		entries, err := s.listOpenTerms()
		if err != nil {
			return "", err
		}
		return prettyJSON(entries)
	case "term_update":
		key, err := need(raw, "termId")
		if err != nil {
			return "", err
		}
		termID, err := s.requireTerm(key)
		if err != nil {
			return "", err
		}
		remark, err := textArg(raw, "remark")
		if err != nil {
			return "", err
		}
		s.deps.Terminal.SetLabel(termID, terminal.LabelPatch{Remark: remark})
		return "已写上备注", nil
	case "term_reconnect":
		key, err := need(raw, "termId")
		if err != nil {
			return "", err
		}
		return s.reconnectTerm(key)
	case "term_exec":
		connKey, err := need(raw, "connection")
		if err != nil {
			return "", err
		}
		found, err := s.findSession(connKey)
		if err != nil {
			return "", err
		}
		command, err := need(raw, "command")
		if err != nil {
			return "", err
		}
		if err := s.guard(ctx, command); err != nil {
			return "", err
		}
		session, err := textArg(raw, "session")
		if err != nil {
			return "", err
		}
		prelude, err := textArg(raw, "prelude")
		if err != nil {
			return "", err
		}
		timeout, err := intArg(raw, "timeout")
		if err != nil {
			return "", err
		}
		maxBytes, err := intArg(raw, "maxBytes")
		if err != nil {
			return "", err
		}
		run, err := s.deps.Exec.Exec(found.ID, sshx.ExecOptions{
			Command:   command,
			Session:   deref(session),
			Prelude:   deref(prelude),
			TimeoutMs: derefInt(timeout, 20) * 1000,
			MaxBytes:  derefInt(maxBytes, 50_000),
		})
		if err != nil {
			return "", err
		}
		return compactJSON(execResultJSON{
			Stdout:    run.Stdout,
			Stderr:    run.Stderr,
			ExitCode:  run.ExitCode,
			Duration:  run.Duration,
			TimedOut:  run.TimedOut,
			Truncated: run.Truncated,
		})
	case "term_pty":
		key, err := need(raw, "termId")
		if err != nil {
			return "", err
		}
		termID, err := s.requireLive(key)
		if err != nil {
			return "", err
		}
		command, err := need(raw, "command")
		if err != nil {
			return "", err
		}
		if !strings.HasSuffix(command, "\n") {
			command += "\n"
		}
		if err := s.guard(ctx, command); err != nil {
			return "", err
		}
		timeout, err := intArg(raw, "timeout")
		if err != nil {
			return "", err
		}
		run, err := s.deps.Terminal.ExecCommand(termID, command, time.Duration(derefInt(timeout, 20))*time.Second)
		if err != nil {
			return "", err
		}
		output := clipCommand(agentText(run.Output), 16_000)
		if run.Finished && run.ExitCode != nil {
			return fmt.Sprintf("%s\n\nexit code: %d", output, *run.ExitCode), nil
		}
		if run.Finished {
			return output, nil
		}
		return output + "\n\n命令还在跑，以上是已经回来的内容。", nil
	case "term_write":
		return s.writeTerm(ctx, raw)
	case "term_read":
		key, err := need(raw, "termId")
		if err != nil {
			return "", err
		}
		termID, err := s.requireTerm(key)
		if err != nil {
			return "", err
		}
		maxChars, err := intArg(raw, "maxChars")
		if err != nil {
			return "", err
		}
		tail, err := s.deps.Terminal.ReadTail(termID, derefInt(maxChars, 8000))
		if err != nil {
			return "", err
		}
		return clip(agentText(tail), 16_000), nil
	case "term_close":
		key, err := need(raw, "termId")
		if err != nil {
			return "", err
		}
		termID, err := s.requireTerm(key)
		if err != nil {
			return "", err
		}
		s.deps.Terminal.Close(termID)
		s.emitCloseTab(termID)
		return "已关闭", nil
	case "term_open_local":
		return s.openLocal(ctx)
	case "term_lines":
		key, err := need(raw, "termId")
		if err != nil {
			return "", err
		}
		termID, err := s.requireTerm(key)
		if err != nil {
			return "", err
		}
		startLine, err := intArg(raw, "startLine")
		if err != nil {
			return "", err
		}
		endLine, err := intArg(raw, "endLine")
		if err != nil {
			return "", err
		}
		return s.lines(ctx, termID, startLine, endLine)
	case "term_screenshot":
		shot, err := lineShot(raw)
		if err != nil {
			return "", err
		}
		termID, err := s.requireTerm(shot.termID)
		if err != nil {
			return "", err
		}
		if shot.ranged {
			return s.capture(ctx, termID, "scrollback", shot.startLine, shot.endLine, true)
		}
		return s.capture(ctx, termID, "viewport", nil, nil, false)
	case "term_screenshot_scrollback":
		shot, err := lineShot(raw)
		if err != nil {
			return "", err
		}
		termID, err := s.requireTerm(shot.termID)
		if err != nil {
			return "", err
		}
		return s.capture(ctx, termID, "scrollback", shot.startLine, shot.endLine, shot.ranged)
	case "sftp_list":
		found, err := s.findSessionByKey(raw)
		if err != nil {
			return "", err
		}
		dir, err := textArg(raw, "path")
		if err != nil {
			return "", err
		}
		path, entries, err := s.deps.Sftp.List(found.ID, orDefault(deref(dir), "."))
		if err != nil {
			return "", err
		}
		if entries == nil {
			entries = []sftpx.RemoteFile{}
		}
		return prettyJSON(sftpListResult{Path: path, Entries: entries})
	case "sftp_mkdir":
		path, err := need(raw, "path")
		if err != nil {
			return "", err
		}
		found, err := s.findSessionByKey(raw)
		if err != nil {
			return "", err
		}
		if err := s.guardPath(ctx, path); err != nil {
			return "", err
		}
		if err := s.deps.Sftp.MkdirPath(found.ID, path); err != nil {
			return "", err
		}
		return fmt.Sprintf("已创建 %s", path), nil
	case "sftp_upload":
		remotePath, err := need(raw, "remotePath")
		if err != nil {
			return "", err
		}
		found, err := s.findSessionByKey(raw)
		if err != nil {
			return "", err
		}
		if err := s.guardPath(ctx, remotePath); err != nil {
			return "", err
		}
		localPath, err := need(raw, "localPath")
		if err != nil {
			return "", err
		}
		if err := s.deps.Sftp.Put(found.ID, localPath, remotePath); err != nil {
			return "", err
		}
		return fmt.Sprintf("已上传到 %s", remotePath), nil
	case "sftp_download":
		localPath, err := need(raw, "localPath")
		if err != nil {
			return "", err
		}
		found, err := s.findSessionByKey(raw)
		if err != nil {
			return "", err
		}
		remotePath, err := need(raw, "remotePath")
		if err != nil {
			return "", err
		}
		if err := s.deps.Sftp.Get(found.ID, remotePath, localPath); err != nil {
			return "", err
		}
		return fmt.Sprintf("已下载到 %s", localPath), nil
	case "sftp_rename":
		to, err := need(raw, "to")
		if err != nil {
			return "", err
		}
		found, err := s.findSessionByKey(raw)
		if err != nil {
			return "", err
		}
		if err := s.guardPath(ctx, to); err != nil {
			return "", err
		}
		from, err := need(raw, "from")
		if err != nil {
			return "", err
		}
		if err := s.deps.Sftp.Rename(found.ID, from, to); err != nil {
			return "", err
		}
		return fmt.Sprintf("已改名为 %s", to), nil
	case "sftp_remove":
		path, err := need(raw, "path")
		if err != nil {
			return "", err
		}
		kind, err := need(raw, "kind")
		if err != nil {
			return "", err
		}
		if kind != "file" && kind != "dir" && kind != "link" {
			return "", errors.New("kind 只能是 file、dir 或 link")
		}
		found, err := s.findSessionByKey(raw)
		if err != nil {
			return "", err
		}
		if err := s.guard(ctx, "rm "+path); err != nil {
			return "", err
		}
		if err := s.deps.Sftp.Remove(found.ID, path, sftpx.FileKind(kind)); err != nil {
			return "", err
		}
		return fmt.Sprintf("已删除 %s", path), nil
	default:
		return "", fmt.Errorf("未知命令: %s", tool)
	}
}

// findSessionByKey 对应 TS 里 findSession(need(raw, 'connection')) 的组合。
func (s *Service) findSessionByKey(raw map[string]any) (*storage.SessionConfig, error) {
	key, err := need(raw, "connection")
	if err != nil {
		return nil, err
	}
	return s.findSession(key)
}

// ------------------------------------------------ 连接 CRUD（对应 TS connectSession/createSession/updateSession/deleteSession/normalize）

func (s *Service) connectSession(ctx context.Context, key string) (string, error) {
	session, err := s.findSession(key)
	if err != nil {
		return "", err
	}
	n := 1
	for _, term := range s.deps.Terminal.ListTerms() {
		if term.SessionID != nil && *term.SessionID == session.ID {
			n++
		}
	}
	title := fmt.Sprintf("窗口 %d", n)
	termID := NewTermID()
	bound := make(chan error, 1)
	go func() { bound <- s.deps.Terminal.ExpectBind(termID, bindTimeout) }()
	s.emitOpenTab(TabOpen{TermID: termID, SessionID: &session.ID, Kind: string(terminal.KindSSH), Title: title})
	if err := <-bound; err != nil {
		s.emitCloseTab(termID)
		return "", err
	}
	connected := make(chan error, 1)
	go func() { connected <- s.deps.Terminal.WaitStatus(termID, connectTimeout) }()
	s.deps.Terminal.Create(terminal.CreateOptions{
		TermID:    termID,
		Kind:      terminal.KindSSH,
		SessionID: session.ID,
		Cols:      120,
		Rows:      32,
		Title:     title,
	})
	if err := <-connected; err != nil {
		s.deps.Terminal.Close(termID)
		s.emitCloseTab(termID)
		return "", err
	}
	return strings.Join([]string{
		fmt.Sprintf("已打开连接 %s（%s）。", session.PublicID, session.Name),
		fmt.Sprintf("终端：%s", termID),
		fmt.Sprintf("标题：%s", title),
		"操作这扇终端用 termId。连接用 conn- 编号。弄清这扇终端在做什么之后，用 term_update 写上备注。",
	}, "\n"), nil
}

func (s *Service) createSession(patch sessionPatch) (string, error) {
	input, err := s.normalize(nil, patch, true)
	if err != nil {
		return "", err
	}
	saved, err := s.deps.Storage.Create(input)
	if err != nil {
		return "", err
	}
	s.publishSessions()
	return prettyJSON(makeConnectionView(saved))
}

func (s *Service) updateSession(key string, patch sessionPatch) (string, error) {
	current, err := s.findSession(key)
	if err != nil {
		return "", err
	}
	input, err := s.normalize(current, patch, false)
	if err != nil {
		return "", err
	}
	saved, err := s.deps.Storage.Update(current.ID, input)
	if err != nil {
		return "", err
	}
	if saved == nil {
		return "", errors.New("连接已不存在")
	}
	s.publishSessions()
	return prettyJSON(makeConnectionView(saved))
}

func (s *Service) deleteSession(ctx context.Context, key string) (string, error) {
	session, err := s.findSession(key)
	if err != nil {
		return "", err
	}
	settings, err := s.deps.Storage.GetMcpSettings()
	if err != nil {
		return "", err
	}
	if settings.ConfirmDangerous {
		ok, err := s.ask(ctx, "删除连接 "+session.Name)
		if err != nil {
			return "", err
		}
		if !ok {
			return "", errors.New("已取消：删除未确认")
		}
	}
	message := s.disconnectByID(session)
	_ = message
	if _, err := s.deps.Storage.Delete(session.ID); err != nil {
		return "", err
	}
	s.publishSessions()
	return fmt.Sprintf("已删除 %s", session.Name), nil
}

// normalize 对应 TS normalize：合并补丁与现值并校验。MCP 不支持改跳板配置，沿用现有值。
func (s *Service) normalize(current *storage.SessionConfig, patch sessionPatch, creating bool) (*storage.SessionInput, error) {
	pick := func(p *string, cur string) string {
		if p != nil {
			return strings.TrimSpace(*p)
		}
		return strings.TrimSpace(cur)
	}
	var curName, curGroup, curHost, curUsername string
	var curRemark *string
	curPort := 22
	jumpHost, jumpUsername := "", ""
	jumpPort := 22
	if current != nil {
		curName, curGroup, curHost, curUsername = current.Name, current.Group, current.Host, current.Username
		curRemark = current.Remark
		curPort = current.Port
		if current.JumpHost != nil {
			jumpHost = *current.JumpHost
		}
		if current.JumpPort != nil {
			jumpPort = *current.JumpPort
		}
		if current.JumpUsername != nil {
			jumpUsername = *current.JumpUsername
		}
	}
	input := &storage.SessionInput{
		Name:     pick(patch.name, curName),
		Group:    pick(patch.group, curGroup),
		Host:     pick(patch.host, curHost),
		Username: pick(patch.username, curUsername),
		Port:     curPort,
		Remark:   curRemark,
	}
	if patch.port != nil {
		input.Port = *patch.port
	}
	if patch.remark != nil {
		input.Remark = patch.remark
	}
	if patch.secret != nil && *patch.secret != "" {
		input.Secret = patch.secret
	}
	if input.Name == "" {
		return nil, errors.New("名称不能为空")
	}
	if input.Host == "" || input.Username == "" {
		return nil, errors.New("主机和用户名不能为空")
	}
	if creating && input.Secret == nil {
		return nil, errors.New("需要填写密码（secret）")
	}
	if jumpHost != "" && jumpUsername == "" {
		return nil, errors.New("跳板需要用户名")
	}
	sessions, err := s.deps.Storage.List()
	if err != nil {
		return nil, err
	}
	for _, item := range sessions {
		if item.Name == input.Name && (current == nil || item.ID != current.ID) {
			return nil, fmt.Errorf("已有同名连接: %s", input.Name)
		}
	}
	// 跳板沿用现有值（TS 传的 jumpHost/jumpPort/jumpUsername 同理，jumpSecret 恒为 undefined）
	input.JumpHost = &jumpHost
	input.JumpPort = &jumpPort
	input.JumpUsername = &jumpUsername
	return input, nil
}

// publishSessions 对应 TS publishSessions：通知前端会话列表变了。
func (s *Service) publishSessions() {
	if s.deps.OnSessionChanged == nil || s.deps.Storage == nil {
		return
	}
	sessions, err := s.deps.Storage.List()
	if err != nil {
		return
	}
	s.deps.OnSessionChanged(sessions)
}

func (s *Service) disconnectSession(key string) (string, error) {
	session, err := s.findSession(key)
	if err != nil {
		return "", err
	}
	return s.disconnectByID(session), nil
}

// disconnectByID 对应 TS disconnectById：关掉这条连接的全部终端并断开文件通道。
func (s *Service) disconnectByID(session *storage.SessionConfig) string {
	closed := 0
	for _, term := range s.deps.Terminal.ListTerms() {
		if term.SessionID != nil && *term.SessionID == session.ID {
			s.deps.Terminal.Close(term.ID)
			s.emitCloseTab(term.ID)
			closed++
		}
	}
	s.deps.Sftp.Close(session.ID)
	return fmt.Sprintf("已断开 %s，关闭 %d 个终端", session.Name, closed)
}

// ------------------------------------------------ 终端工具辅助

// reconnectTerm 对应 TS reconnectTerm。
func (s *Service) reconnectTerm(termID string) (string, error) {
	id, err := s.requireTerm(termID)
	if err != nil {
		return "", err
	}
	var current *terminal.TermInfo
	for _, term := range s.deps.Terminal.ListTerms() {
		if term.ID == id {
			t := term
			current = &t
			break
		}
	}
	if current != nil && current.Status == "connected" {
		return fmt.Sprintf("终端 %s 已经连着。", id), nil
	}
	if err := s.deps.Terminal.Reconnect(id); err != nil {
		return "", err
	}
	lines := []string{fmt.Sprintf("已重新连接终端 %s。", id)}
	if current != nil && current.SessionID != nil {
		if sessions, err := s.deps.Storage.List(); err == nil {
			for _, item := range sessions {
				if item.ID == *current.SessionID {
					lines = append(lines, fmt.Sprintf("连接：%s（%s）", item.PublicID, item.Name))
					break
				}
			}
		}
	}
	lines = append(lines, "编号没变，上次退出时已经画好的行还在，新会话从下一行开始。")
	return strings.Join(lines, "\n"), nil
}

// writeTerm 对应 TS writeTerm。
func (s *Service) writeTerm(ctx context.Context, raw map[string]any) (string, error) {
	key, err := need(raw, "termId")
	if err != nil {
		return "", err
	}
	termID, err := s.requireLive(key)
	if err != nil {
		return "", err
	}
	keys, err := keyArg(raw)
	if err != nil {
		return "", err
	}
	text, err := textArg(raw, "text")
	if err != nil {
		return "", err
	}
	data, err := textArg(raw, "data")
	if err != nil {
		return "", err
	}
	submit, err := boolArg(raw, "submit")
	if err != nil {
		return "", err
	}
	if len(keys) == 0 && text == nil && data == nil && submit == nil {
		return "", errors.New("要提供 keys、text、submit 或 data")
	}
	applicationCursor := false
	for _, key := range keys {
		if moves[key] {
			applicationCursor = s.cursorMode(ctx, termID)
			break
		}
	}
	payload := EncodeTermInput(TermInput{
		Keys:              keys,
		Text:              deref(text),
		Data:              deref(data),
		Submit:            submit != nil && *submit,
		ApplicationCursor: applicationCursor,
	})
	if payload == "" {
		return "", errors.New("没有可发送的内容")
	}
	if strings.ContainsAny(payload, "\n\r") {
		if err := s.guard(ctx, payload); err != nil {
			return "", err
		}
	}
	s.deps.Terminal.Input(termID, payload)
	time.Sleep(writeSettle)
	out, err := s.lines(ctx, termID, nil, nil)
	if err != nil {
		return "已发送", nil
	}
	return out, nil
}

// openLocal 对应 TS openLocal。
func (s *Service) openLocal(ctx context.Context) (string, error) {
	n := 1
	for _, term := range s.deps.Terminal.ListTerms() {
		if term.Kind == terminal.KindLocal {
			n++
		}
	}
	title := fmt.Sprintf("窗口 %d", n)
	termID := NewTermID()
	bound := make(chan error, 1)
	go func() { bound <- s.deps.Terminal.ExpectBind(termID, bindTimeout) }()
	s.emitOpenTab(TabOpen{TermID: termID, Kind: string(terminal.KindLocal), Title: title})
	if err := <-bound; err != nil {
		s.emitCloseTab(termID)
		return "", err
	}
	connected := make(chan error, 1)
	go func() { connected <- s.deps.Terminal.WaitStatus(termID, localTimeout) }()
	s.deps.Terminal.Create(terminal.CreateOptions{
		TermID: termID,
		Kind:   terminal.KindLocal,
		Cols:   120,
		Rows:   32,
		Title:  title,
	})
	if err := <-connected; err != nil {
		s.deps.Terminal.Close(termID)
		s.emitCloseTab(termID)
		return "", err
	}
	return strings.Join([]string{
		fmt.Sprintf("已打开本机终端 %s。", termID),
		fmt.Sprintf("标题：%s", title),
		"它没有连接。弄清它在做什么之后，用 term_update 写上备注。",
	}, "\n"), nil
}

// requireLive 对应 TS requireLive。
func (s *Service) requireLive(termID string) (string, error) {
	id, err := s.requireTerm(termID)
	if err != nil {
		return "", err
	}
	for _, term := range s.deps.Terminal.ListTerms() {
		if term.ID == id {
			if term.Status != "connected" {
				return "", errors.New("终端已经断开。用 term_reconnect 恢复这扇终端，编号不变。")
			}
			return id, nil
		}
	}
	return "", errors.New("终端不存在或已断开")
}

// requireTerm 对应 TS requireTerm：conn- 编号误填、格式不对、不存在分别报错。
func (s *Service) requireTerm(termID string) (string, error) {
	id := strings.TrimSpace(termID)
	if IsConnID(id) {
		return "", fmt.Errorf("「%s」是连接编号。终端请填 term- 开头的编号。", id)
	}
	if !IsTermID(id) {
		return "", fmt.Errorf("「%s」不是终端编号。请先 term_list，再用 term- 开头的编号。", id)
	}
	for _, term := range s.deps.Terminal.ListTerms() {
		if term.ID == id {
			return id, nil
		}
	}
	return "", errors.New("终端不存在或已断开")
}

// findSession 对应 TS findSession：按 conn- 编号找连接。名称和备注不能用来查找。
func (s *Service) findSession(key string) (*storage.SessionConfig, error) {
	id := strings.TrimSpace(key)
	if IsTermID(id) {
		return nil, fmt.Errorf("「%s」是终端编号。连接请填 conn- 开头的编号。", id)
	}
	if !IsConnID(id) {
		return nil, fmt.Errorf("「%s」不是连接编号。请先 connection_list，再用 conn- 开头的编号。名称和备注不能用来查找。", id)
	}
	sessions, err := s.deps.Storage.List()
	if err != nil {
		return nil, err
	}
	for _, session := range sessions {
		if session.PublicID == id {
			return session, nil
		}
	}
	return nil, fmt.Errorf("找不到连接: %s", id)
}

// listOpenTerms 对应 TS listOpenTerms。
func (s *Service) listOpenTerms() ([]termListEntry, error) {
	sessions, err := s.deps.Storage.List()
	if err != nil {
		return nil, err
	}
	byID := make(map[string]*storage.SessionConfig, len(sessions))
	for _, session := range sessions {
		byID[session.ID] = session
	}
	out := make([]termListEntry, 0)
	for _, term := range s.deps.Terminal.ListTerms() {
		entry := termListEntry{
			TermID: term.ID,
			Title:  term.Title,
			Remark: term.Remark,
			Kind:   string(term.Kind),
			Status: term.Status,
		}
		if term.SessionID != nil {
			if session := byID[*term.SessionID]; session != nil {
				entry.Connection = &session.PublicID
				entry.ConnectionName = session.Name
			}
		}
		out = append(out, entry)
	}
	return out, nil
}

func (s *Service) emitOpenTab(tab TabOpen) {
	if s.deps.OnOpenTab != nil {
		s.deps.OnOpenTab(tab)
	}
}

func (s *Service) emitCloseTab(termID string) {
	if s.deps.OnCloseTab != nil {
		s.deps.OnCloseTab(termID)
	}
}

// ------------------------------------------------ 危险操作确认（对应 TS guard/guardPath）

// confirmOn 读设置里的确认开关（TS storage.getMcpSettings().confirmDangerous）。
func (s *Service) confirmOn() (bool, error) {
	settings, err := s.deps.Storage.GetMcpSettings()
	if err != nil {
		return false, err
	}
	return settings.ConfirmDangerous, nil
}

// guard 对应 TS guard：命中危险命令正则且开了确认开关时先询问。
func (s *Service) guard(ctx context.Context, command string) error {
	if !dangerousRe.MatchString(command) {
		return nil
	}
	on, err := s.confirmOn()
	if err != nil {
		return err
	}
	if !on {
		return nil
	}
	confirmed, err := s.ask(ctx, command)
	if err != nil {
		return err
	}
	if !confirmed {
		return errors.New("已取消：危险操作未确认")
	}
	return nil
}

// guardPath 对应 TS guardPath：命中敏感路径且开了确认开关时先询问。
func (s *Service) guardPath(ctx context.Context, path string) error {
	if !sensitiveRe.MatchString(path) {
		return nil
	}
	on, err := s.confirmOn()
	if err != nil {
		return err
	}
	if !on {
		return nil
	}
	confirmed, err := s.ask(ctx, path)
	if err != nil {
		return err
	}
	if !confirmed {
		return errors.New("已取消：危险路径未确认")
	}
	return nil
}

// ------------------------------------------------ 结构体与辅助

type connectionView struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Remark   string `json:"remark"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username"`
	Jump     bool   `json:"jump"`
}

// makeConnectionView 对应 TS connectionView。
func makeConnectionView(session *storage.SessionConfig) connectionView {
	remark := ""
	if session.Remark != nil {
		remark = *session.Remark
	}
	return connectionView{
		ID:       session.PublicID,
		Name:     session.Name,
		Remark:   remark,
		Host:     session.Host,
		Port:     session.Port,
		Username: session.Username,
		Jump:     session.JumpHost != nil && *session.JumpHost != "",
	}
}

type termListEntry struct {
	TermID         string  `json:"termId"`
	Connection     *string `json:"connection"`
	ConnectionName string  `json:"connectionName"`
	Title          string  `json:"title"`
	Remark         string  `json:"remark"`
	Kind           string  `json:"kind"`
	Status         string  `json:"status"`
}

type sftpListResult struct {
	Path    string             `json:"path"`
	Entries []sftpx.RemoteFile `json:"entries"`
}

// execResultJSON 对应 TS ExecService 的返回（term_exec 的 JSON 文本）。
type execResultJSON struct {
	Stdout    string  `json:"stdout"`
	Stderr    string  `json:"stderr"`
	ExitCode  *int    `json:"exitCode"`
	Duration  float64 `json:"duration"`
	TimedOut  bool    `json:"timedOut"`
	Truncated bool    `json:"truncated"`
}

type lineShotArgs struct {
	termID    string
	startLine *int
	endLine   *int
	ranged    bool
}

// lineShot 对应 TS lineShot。
func lineShot(raw map[string]any) (lineShotArgs, error) {
	termID, err := need(raw, "termId")
	if err != nil {
		return lineShotArgs{}, err
	}
	startLine, err := intArg(raw, "startLine")
	if err != nil {
		return lineShotArgs{}, err
	}
	endLine, err := intArg(raw, "endLine")
	if err != nil {
		return lineShotArgs{}, err
	}
	return lineShotArgs{
		termID:    termID,
		startLine: startLine,
		endLine:   endLine,
		ranged:    startLine != nil || endLine != nil,
	}, nil
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func derefInt(v *int, fallback int) int {
	if v == nil {
		return fallback
	}
	return *v
}

// prettyJSON 对应 JSON.stringify(v, null, 2)（不转义 HTML 字符）。
func prettyJSON(v any) (string, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		return "", err
	}
	return strings.TrimSuffix(buf.String(), "\n"), nil
}

// compactJSON 对应 JSON.stringify(v)。
func compactJSON(v any) (string, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return "", err
	}
	return strings.TrimSuffix(buf.String(), "\n"), nil
}

// withinDir 判断 path 落在 dir 之内（截图落盘限定 userData/screenshots）。
func withinDir(dir, path string) bool {
	absDir, err := filepath.Abs(dir)
	if err != nil {
		return false
	}
	absPath, err := filepath.Abs(path)
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(absDir, absPath)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}
