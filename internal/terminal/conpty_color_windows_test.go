//go:build windows

package terminal

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"termpilot/internal/winconpty"
)

// 子进程发出和 Pi 一样的背景色查询。系统自带的 ConPTY 会把查询吞掉，
// 随程序带的那份会把它转到宿主，再把宿主的回答送回子进程。
func TestBundledConptyForwardsBackgroundQuery(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("没有 node")
	}
	ensureBundledConpty()
	if !strings.EqualFold(filepath.Base(winconpty.LoadedPath()), "conpty.dll") {
		t.Fatalf("没有用随程序的 ConPTY: %q", winconpty.LoadedPath())
	}

	script := filepath.Join(t.TempDir(), "probe.cjs")
	if err := os.WriteFile(script, []byte(backgroundProbeScript), 0o644); err != nil {
		t.Fatal(err)
	}
	cpty, err := winconpty.Start("node "+script, winconpty.ConPtyDimensions(80, 24))
	if err != nil {
		t.Fatal(err)
	}
	defer cpty.Close()

	var mu sync.Mutex
	var out strings.Builder
	done := make(chan struct{})
	go func() {
		defer close(done)
		buf := make([]byte, 4096)
		for {
			n, rerr := cpty.Read(buf)
			if n > 0 {
				mu.Lock()
				out.Write(buf[:n])
				mu.Unlock()
			}
			if rerr != nil {
				return
			}
		}
	}()

	reply := []byte("\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\")
	answered := false
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		text := out.String()
		mu.Unlock()
		if !answered && strings.Contains(text, "]11;?") {
			answered = true
			if _, err := cpty.Write(reply); err != nil {
				t.Fatal(err)
			}
		}
		if strings.Contains(text, "PROBE_DONE") {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	go func() { _, _ = cpty.Wait(t.Context()) }()

	mu.Lock()
	text := out.String()
	mu.Unlock()
	if !strings.Contains(text, "]11;?") {
		t.Fatalf("宿主没看到背景色查询:\n%s", text)
	}
	if !strings.Contains(text, "CHILD_BG_OK") {
		t.Fatalf("子进程没收到背景色:\n%s", text)
	}
}

const backgroundProbeScript = `
process.stdin.setRawMode(true);
process.stdin.resume();
let got = "";
process.stdin.on("data", (chunk) => {
  got += chunk.toString("latin1");
});
process.stdout.write("\x1b]11;?\x07");
setTimeout(() => {
  const ok = got.includes("]11;rgb:1e1e/1e1e/1e1e");
  process.stdout.write("\r\n" + (ok ? "CHILD_BG_OK" : "CHILD_BG_MISSING") + "\r\nPROBE_DONE\r\n");
  process.exit(0);
}, 2000);
`
