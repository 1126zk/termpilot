package app

import "testing"

func TestDirFromArgs(t *testing.T) {
	got := dirFromArgs([]string{"TermPilot.exe", "--dir", `C:\work\demo`})
	if got != `C:\work\demo` {
		t.Fatalf("got %q", got)
	}
	got = dirFromArgs([]string{`--dir=D:\proj`})
	if got != `D:\proj` {
		t.Fatalf("equals form got %q", got)
	}
	if dirFromArgs([]string{"--dir"}) != "" {
		t.Fatal("missing value should be empty")
	}
}

func TestExtraWindowAndPos(t *testing.T) {
	args := []string{"TermPilot.exe", "--extra-window", "--pos", "120", "80", "--dir", `C:\work`}
	if !extraWindow(args) {
		t.Fatal("expected extra window")
	}
	if extraWindow([]string{"TermPilot.exe"}) {
		t.Fatal("plain launch is not an extra window")
	}
	x, y, ok := posFromArgs(args)
	if !ok || x != 120 || y != 80 {
		t.Fatalf("pos %d %d ok=%v", x, y, ok)
	}
	if _, _, ok := posFromArgs([]string{"--pos", "nope"}); ok {
		t.Fatal("bad pos should be ignored")
	}
	if dirFromArgs(args) != `C:\work` {
		t.Fatal("dir should still parse beside pos")
	}
}

func TestLaunchDirTakeOnce(t *testing.T) {
	a := &App{}
	a.noteLaunchDir(` C:\work `)
	if got := a.takeLaunchDir(); got != `C:\work` {
		t.Fatalf("take %q", got)
	}
	if got := a.takeLaunchDir(); got != "" {
		t.Fatalf("second take %q", got)
	}
}
