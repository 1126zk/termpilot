package terminal

import (
	"os"
	"strings"
)

// localWorkDir 校验右键传来的目录。不是现成的文件夹就退回用户主目录。
func localWorkDir(dir string) string {
	dir = strings.TrimSpace(dir)
	if dir != "" {
		info, err := os.Stat(dir)
		if err == nil && info.IsDir() {
			return dir
		}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return home
}

// 本机终端（对应 TS TerminalService.createLocal / localShellExe / detectLocalShells）。
// 平台相关部分在 pty_windows.go / pty_unix.go / shells_*.go。

func (s *Service) createLocal(opts CreateOptions) {
	exe := localShellExe(opts.Shell)

	s.mu.Lock()
	entry := s.terms[opts.TermID]
	if entry == nil {
		entry = &Entry{
			id:    opts.TermID,
			kind:  KindLocal,
			title: orDefault(strings.TrimSpace(opts.Title), "终端"),
		}
		s.terms[opts.TermID] = entry
	}
	s.mu.Unlock()

	cols, rows := s.sizeOf(opts.TermID, opts.Cols, opts.Rows)
	ch, wait, err := startLocalPty(exe, cols, rows, opts.Cwd, func(b []byte) {
		s.sendData(opts.TermID, b)
	})
	if err != nil {
		s.sendStatus(opts.TermID, "", StatusError, err.Error())
		return
	}
	s.attachChannel(entry, ch, cols, rows)
	s.sendStatus(opts.TermID, "", StatusConnected, "")
	gen := s.arm(entry)
	go func() {
		wait()
		if s.isParking() || !s.alive(entry, gen) {
			return
		}
		s.sendStatus(opts.TermID, "", StatusDisconnected, "")
		s.Close(opts.TermID)
	}()
}
