package mcpx

// 测试用的注入接口实现。

import (
	"context"
	"errors"
	"time"

	"termpilot/internal/sftpx"
	"termpilot/internal/sshx"
	"termpilot/internal/storage"
	"termpilot/internal/terminal"
)

type auditRecord struct {
	tool   string
	ok     bool
	detail string
}

type fakeStorage struct {
	sessions []*storage.SessionConfig
	settings storage.McpSettings
	audit    []auditRecord
	deleted  []string
	changed  int
}

func (f *fakeStorage) List() ([]*storage.SessionConfig, error) { return f.sessions, nil }

func (f *fakeStorage) Create(input *storage.SessionInput) (*storage.SessionConfig, error) {
	session := &storage.SessionConfig{
		ID:       "id-" + input.Name,
		PublicID: "conn-new0001",
		Name:     input.Name,
		Group:    input.Group,
		Host:     input.Host,
		Port:     input.Port,
		Username: input.Username,
		Remark:   input.Remark,
	}
	f.sessions = append(f.sessions, session)
	return session, nil
}

func (f *fakeStorage) Update(id string, patch *storage.SessionInput) (*storage.SessionConfig, error) {
	for _, s := range f.sessions {
		if s.ID == id {
			s.Name, s.Group, s.Host, s.Port, s.Username = patch.Name, patch.Group, patch.Host, patch.Port, patch.Username
			s.Remark = patch.Remark
			return s, nil
		}
	}
	return nil, nil
}

func (f *fakeStorage) Delete(id string) (bool, error) {
	f.deleted = append(f.deleted, id)
	for i, s := range f.sessions {
		if s.ID == id {
			f.sessions = append(f.sessions[:i], f.sessions[i+1:]...)
			return true, nil
		}
	}
	return false, nil
}

func (f *fakeStorage) GetMcpSettings() (*storage.McpSettings, error) {
	s := f.settings
	return &s, nil
}

func (f *fakeStorage) AppendAudit(tool string, ok bool, detail string) error {
	f.audit = append(f.audit, auditRecord{tool, ok, detail})
	return nil
}

type fakeTerminal struct {
	terms      []terminal.TermInfo
	created    []terminal.CreateOptions
	inputs     map[string][]string
	closed     []string
	reconnects []string
	labels     map[string]string
	tail       string
	execResult terminal.ExecResult
	bindErr    error
	statusErr  error
}

func newFakeTerminal() *fakeTerminal {
	return &fakeTerminal{inputs: map[string][]string{}, labels: map[string]string{}}
}

func (f *fakeTerminal) Create(opts terminal.CreateOptions) {
	f.created = append(f.created, opts)
}

func (f *fakeTerminal) Input(termID, data string) {
	f.inputs[termID] = append(f.inputs[termID], data)
}

func (f *fakeTerminal) Reconnect(termID string) error {
	f.reconnects = append(f.reconnects, termID)
	for i := range f.terms {
		if f.terms[i].ID == termID {
			f.terms[i].Status = "connected"
		}
	}
	return nil
}

func (f *fakeTerminal) Close(termID string) {
	f.closed = append(f.closed, termID)
}

func (f *fakeTerminal) ListTerms() []terminal.TermInfo { return f.terms }

func (f *fakeTerminal) SetLabel(termID string, patch terminal.LabelPatch) {
	if patch.Remark != nil {
		f.labels[termID] = *patch.Remark
	}
}

func (f *fakeTerminal) ExpectBind(termID string, timeout time.Duration) error { return f.bindErr }

func (f *fakeTerminal) WaitStatus(termID string, timeout time.Duration) error { return f.statusErr }

func (f *fakeTerminal) ReadTail(termID string, maxChars int) (string, error) { return f.tail, nil }

func (f *fakeTerminal) ExecCommand(termID, command string, timeout time.Duration) (terminal.ExecResult, error) {
	return f.execResult, nil
}

type fakeSftp struct {
	listed  []string
	made    []string
	removed []string
	closed  []string
}

func (f *fakeSftp) List(sessionID, dir string) (string, []sftpx.RemoteFile, error) {
	f.listed = append(f.listed, dir)
	return "/home/u", []sftpx.RemoteFile{{Name: "a.txt", Path: "/home/u/a.txt", Kind: sftpx.KindFile, Size: 3, Mtime: 1}}, nil
}

func (f *fakeSftp) MkdirPath(sessionID, path string) error {
	f.made = append(f.made, path)
	return nil
}

func (f *fakeSftp) Put(sessionID, localPath, remotePath string) error { return nil }

func (f *fakeSftp) Get(sessionID, remotePath, localPath string) error { return nil }

func (f *fakeSftp) Rename(sessionID, from, to string) error { return nil }

func (f *fakeSftp) Remove(sessionID, path string, kind sftpx.FileKind) error {
	f.removed = append(f.removed, path)
	return nil
}

func (f *fakeSftp) Close(sessionID string) {
	f.closed = append(f.closed, sessionID)
}

type fakeExec struct {
	lastSessionID string
	lastOpts      sshx.ExecOptions
	result        *sshx.ExecResult
	err           error
}

func (f *fakeExec) Exec(sessionID string, opts sshx.ExecOptions) (*sshx.ExecResult, error) {
	f.lastSessionID = sessionID
	f.lastOpts = opts
	if f.err != nil {
		return nil, f.err
	}
	if f.result != nil {
		return f.result, nil
	}
	zero := 0
	return &sshx.ExecResult{Stdout: "hello\n", ExitCode: &zero, Duration: 0.1}, nil
}

func newTestService() (*Service, *fakeStorage, *fakeTerminal, *fakeSftp, *fakeExec) {
	st := &fakeStorage{
		sessions: []*storage.SessionConfig{
			{ID: "s1", PublicID: "conn-1234abcd", Name: "web", Host: "1.2.3.4", Port: 22, Username: "u"},
		},
		settings: storage.McpSettings{Enabled: true, Port: 3927, Token: "test-token-123456", ConfirmDangerous: true},
	}
	term := newFakeTerminal()
	sftp := &fakeSftp{}
	exec := &fakeExec{}
	svc := New(Deps{Storage: st, Terminal: term, Sftp: sftp, Exec: exec})
	return svc, st, term, sftp, exec
}

var errBoom = errors.New("boom")

var _ = context.Background
