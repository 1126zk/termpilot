package sshx

import (
	"strings"
	"testing"
)

func TestReadProgressCarriageReturn(t *testing.T) {
	var got []string
	readProgress(strings.NewReader("Pulling fs layer\nDownloading 1%\rDownloading 2%\rDownload complete\n"), func(line string) {
		got = append(got, line)
	})
	want := []string{"Pulling fs layer", "\rDownloading 1%", "\rDownloading 2%", "Download complete"}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("got %#v", got)
	}
}

func TestReadProgressCRLF(t *testing.T) {
	var got []string
	readProgress(strings.NewReader("bar 1\rbar 2\r\nnext\n"), func(line string) {
		got = append(got, line)
	})
	want := []string{"\rbar 1", "bar 2", "next"}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("got %#v", got)
	}
}

func TestBriefCommandOutputDropsProgress(t *testing.T) {
	raw := "Using default tag: latest\r\n" +
		"latest: Pulling from chromedp/headless-shell\n" +
		"deeff7fa601f: Downloading [=>] 22MB/131MB\rdeeff7fa601f: Downloading [==>] 40MB/131MB\n" +
		"\x1b[2KError response from daemon: i/o timeout\n"
	got := briefCommandOutput(raw)
	if got != "Error response from daemon: i/o timeout" {
		t.Fatalf("got %q", got)
	}
	onlyBar := "\x1b[2Kdeeff7fa601f: Downloading [======>] 22.02MB/131.5MB\r"
	if briefCommandOutput(onlyBar) != "" {
		t.Fatalf("progress dump should not become the error, got %q", briefCommandOutput(onlyBar))
	}
}

func TestReadProgressStripsANSI(t *testing.T) {
	var got []string
	readProgress(strings.NewReader("\x1b[2K\rDownloading [=>] 1MB\r"), func(line string) {
		got = append(got, line)
	})
	if len(got) != 1 || got[0] != "\rDownloading [=>] 1MB" {
		t.Fatalf("got %#v", got)
	}
}
