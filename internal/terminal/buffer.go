package terminal

// 对应 TS TerminalService 的 output/dropped 双 map：每扇终端一个 100K 字符上限的
// 环形输出缓冲。TS 以 JS 字符串（UTF-16 码元）计数，这里以 rune（码点）计数，
// 日常 ASCII 输出下完全一致；dropped 与切片用同一单位，内部自洽。

// outputCapRunes 对应 TS 的 100_000 上限。
const outputCapRunes = 100_000

type ringBuffer struct {
	buf     []rune
	dropped int // 从头部丢掉的字符数，用来在裁短之后仍只切出本次新增
}

func (r *ringBuffer) appendText(s string) {
	r.buf = append(r.buf, []rune(s)...)
	if len(r.buf) > outputCapRunes {
		drop := len(r.buf) - outputCapRunes
		r.dropped += drop
		// 拷到新切片，释放头部不再引用的底层数组
		rest := make([]rune, outputCapRunes)
		copy(rest, r.buf[drop:])
		r.buf = rest
	}
}

func (r *ringBuffer) text() string { return string(r.buf) }

// tail 取末尾最多 maxChars 个字符，对应 TS 的 slice(-maxChars)。
func (r *ringBuffer) tail(maxChars int) string {
	if maxChars < 0 {
		maxChars = 0
	}
	if maxChars < len(r.buf) {
		return string(r.buf[len(r.buf)-maxChars:])
	}
	return string(r.buf)
}

// logicalEnd 对应 TS logicalEnd：dropped + 当前长度，裁短后仍单调递增。
func (r *ringBuffer) logicalEnd() int { return r.dropped + len(r.buf) }

// since 只取 origin 之后新写入的输出。origin 落在已被裁掉的区段时退回整个缓冲，
// 对应 TS since 的越界兜底。
func (r *ringBuffer) since(origin int) string {
	from := origin - r.dropped
	if from >= 0 && from <= len(r.buf) {
		return string(r.buf[from:])
	}
	return string(r.buf)
}
