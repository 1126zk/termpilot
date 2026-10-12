package terminal

import (
	"strings"
	"testing"
)

func TestRingBufferAppendAndTail(t *testing.T) {
	r := &ringBuffer{}
	r.appendText("hello ")
	r.appendText("world")
	if got := r.text(); got != "hello world" {
		t.Fatalf("text = %q", got)
	}
	if got := r.tail(5); got != "world" {
		t.Fatalf("tail(5) = %q", got)
	}
	if got := r.tail(100); got != "hello world" {
		t.Fatalf("tail(100) = %q", got)
	}
	if r.logicalEnd() != 11 {
		t.Fatalf("logicalEnd = %d", r.logicalEnd())
	}
}

func TestRingBufferDrop(t *testing.T) {
	r := &ringBuffer{}
	first := strings.Repeat("a", 60_000)
	second := strings.Repeat("b", 60_000)
	r.appendText(first)
	origin := r.logicalEnd() // 60_000，第二次 append 之前的末尾
	r.appendText(second)

	if r.dropped != 20_000 {
		t.Fatalf("dropped = %d, want 20000", r.dropped)
	}
	if len(r.buf) != outputCapRunes {
		t.Fatalf("len(buf) = %d, want %d", len(r.buf), outputCapRunes)
	}
	// 裁短之后仍只切出本次新增：origin 之后恰好是 second 全部
	if got := r.since(origin); got != second {
		t.Fatalf("since(origin) 长度 = %d, want %d", len(got), len(second))
	}
	// origin 落在已裁掉的区段时退回整个缓冲
	if got := r.since(100); len(got) != outputCapRunes {
		t.Fatalf("since(100) 长度 = %d, want %d", len(got), outputCapRunes)
	}
}

func TestRingBufferRunes(t *testing.T) {
	r := &ringBuffer{}
	r.appendText("中文测试")
	if r.logicalEnd() != 4 {
		t.Fatalf("logicalEnd = %d, want 4（按 rune 计）", r.logicalEnd())
	}
	if got := r.tail(2); got != "测试" {
		t.Fatalf("tail(2) = %q", got)
	}
}
