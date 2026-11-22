package sftpx

import (
	"bytes"
	"os"
	"strings"
	"testing"
)

func TestRelayStep(t *testing.T) {
	write, remove, descend := relayStep("skip", false, destFile)
	if write || remove || descend {
		t.Fatal("跳过应留下已有文件")
	}
	write, remove, descend = relayStep("skip", false, destNone)
	if !write || remove || descend {
		t.Fatal("跳过应传还没有的文件")
	}
	write, remove, descend = relayStep("skip", true, destFile)
	if write || remove || descend {
		t.Fatal("跳过不应把目录盖到文件上")
	}
	write, remove, descend = relayStep("overwrite", false, destFile)
	if !write || remove || descend {
		t.Fatal("覆盖应重写同名文件，不先删掉它")
	}
	write, remove, descend = relayStep("overwrite", false, destDir)
	if !write || !remove || descend {
		t.Fatal("覆盖遇到同名目录挡着文件时，应先清掉这个目录再写文件")
	}
	write, remove, descend = relayStep("overwrite", true, destDir)
	if write || remove || !descend {
		t.Fatal("覆盖目录应走进去换同名文件，不删整棵目录")
	}
	_, _, descend = relayStep("", true, destNone)
	if !descend {
		t.Fatal("没有同名时应走进目录")
	}
}

func TestRelayCheck(t *testing.T) {
	name, dest, err := relayCheck("/var/log/app", "/tmp", false)
	if err != nil || name != "app" || dest != "/tmp/app" {
		t.Fatalf("got %q %q %v", name, dest, err)
	}
	if _, _, err := relayCheck("/", "/tmp", false); err == nil {
		t.Fatal("根目录应拒绝")
	}
	if _, _, err := relayCheck("/data", "/data/backup", true); err == nil {
		t.Fatal("不能传到自己里面")
	}
	if _, _, err := relayCheck("/data/a", "/data", true); err == nil {
		t.Fatal("已经在目标目录里")
	}
	if _, dest, err := relayCheck("/data/a", "/data", false); err != nil || dest != "/data/a" {
		t.Fatalf("不同主机应允许同路径，got %q %v", dest, err)
	}
}

func TestNoSuchFile(t *testing.T) {
	if !noSuchFile(os.ErrNotExist) {
		t.Fatal("目标还没有这个文件时，应视为不存在")
	}
}

func TestRelayPipeWritesAsItReads(t *testing.T) {
	payload := strings.Repeat("abc", chunkSize)
	var dst bytes.Buffer
	svc := &Service{}
	group := &transferGroup{id: "relay", sessionID: "to", direction: DirectionRelay, name: "f", total: int64(len(payload))}
	if err := svc.relayPipe(strings.NewReader(payload), &dst, group); err != nil {
		t.Fatal(err)
	}
	if dst.String() != payload {
		t.Fatalf("写出 %d 字节，源是 %d", dst.Len(), len(payload))
	}
	if group.transferred.Load() != int64(len(payload)) {
		t.Fatalf("进度 %d", group.transferred.Load())
	}
}
