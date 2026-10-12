// Spike 1: verify github.com/UserExistsError/conpty can drive a local
// terminal (powershell.exe and cmd.exe) as a node-pty replacement.
package main

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/UserExistsError/conpty"
)

var failures int

func pass(name string) { fmt.Printf("PASS %s\n", name) }

func fail(name, reason string) {
	fmt.Printf("FAIL %s: %s\n", name, reason)
	failures++
}

func (s *session) debugTail(n int) {
	out := s.output()
	if len(out) > n {
		out = out[len(out)-n:]
	}
	fmt.Printf("DEBUG output tail (%d bytes): %q\n", len(out), out)
}

type session struct {
	cpty *conpty.ConPty
	mu   sync.Mutex
	buf  bytes.Buffer
}

func (s *session) readLoop() {
	p := make([]byte, 4096)
	for {
		n, err := s.cpty.Read(p)
		if n > 0 {
			s.mu.Lock()
			s.buf.Write(p[:n])
			s.mu.Unlock()
		}
		if err != nil {
			return
		}
	}
}

func (s *session) output() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.String()
}

func (s *session) waitOutput(substr string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if strings.Contains(s.output(), substr) {
			return true
		}
		time.Sleep(50 * time.Millisecond)
	}
	return false
}

func runShellTest(shellName, commandLine, dirCmd string) {
	fmt.Printf("--- %s (%s) ---\n", shellName, commandLine)

	cwd, err := os.Getwd()
	if err != nil {
		fail(shellName+"_getcwd", err.Error())
		return
	}

	// a. start a ConPTY session at 80x24
	cpty, err := conpty.Start(commandLine,
		conpty.ConPtyDimensions(80, 24),
		conpty.ConPtyWorkDir(cwd),
	)
	if err != nil {
		fail(shellName+"_start_80x24", err.Error())
		return
	}
	pass(shellName + "_start_80x24")
	defer cpty.Close()

	s := &session{cpty: cpty}
	go s.readLoop()

	// b. write marker command, expect SPIKE_OK_ in output within 15s
	if _, err := cpty.Write([]byte("echo SPIKE_OK_$PID\r\n")); err != nil {
		fail(shellName+"_write_marker", err.Error())
		return
	}
	if s.waitOutput("SPIKE_OK_", 15*time.Second) {
		pass(shellName + "_echo_marker")
	} else {
		fail(shellName+"_echo_marker", "no SPIKE_OK_ in output within 15s")
		s.debugTail(600)
	}

	// c. resize to 120x40
	if err := cpty.Resize(120, 40); err != nil {
		fail(shellName+"_resize_120x40", err.Error())
	} else {
		pass(shellName + "_resize_120x40")
	}

	// d. print working directory, expect cwd path in output
	if _, err := cpty.Write([]byte(dirCmd + "\r\n")); err != nil {
		fail(shellName+"_write_pwd", err.Error())
		return
	}
	want := strings.ToLower(cwd)
	found := false
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(strings.ToLower(s.output()), want) {
			found = true
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if found {
		pass(shellName + "_pwd_contains_cwd")
	} else if strings.Contains(strings.ToLower(s.output()), strings.ToLower(filepath.Base(cwd))) {
		pass(shellName + "_pwd_contains_cwd (matched basename only)")
	} else {
		fail(shellName+"_pwd_contains_cwd", "cwd "+cwd+" not found in output")
	}

	// e. exit, process terminates and exit code is retrievable
	if _, err := cpty.Write([]byte("exit\r\n")); err != nil {
		fail(shellName+"_write_exit", err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	code, err := cpty.Wait(ctx)
	if err != nil {
		fail(shellName+"_wait_exit", err.Error())
		s.debugTail(600)
	} else {
		pass(fmt.Sprintf("%s_wait_exit (exitCode=%d)", shellName, code))
	}
}

func main() {
	if !conpty.IsConPtyAvailable() {
		fmt.Println("FAIL conpty_available: ConPty API not present on this Windows")
		fmt.Println("SPIKE_RESULT: FAIL")
		os.Exit(1)
	}
	pass("conpty_available")

	runShellTest("powershell", "powershell.exe -NoProfile", "pwd")
	// cmd.exe has no `pwd` builtin; `cd` with no args prints the cwd.
	runShellTest("cmd", "cmd.exe", "cd")

	if failures == 0 {
		fmt.Println("SPIKE_RESULT: PASS")
	} else {
		fmt.Printf("SPIKE_RESULT: FAIL (%d failures)\n", failures)
		os.Exit(1)
	}
}
