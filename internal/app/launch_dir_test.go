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
