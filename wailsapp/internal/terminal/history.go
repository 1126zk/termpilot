package terminal

import "strings"

// 按键流按行组装历史指令，对应 TS TerminalService.captureInput：
// 回车结算一行；退格删一个字符；含方向键、粘贴换行等其他控制字符的行丢弃；
// strip 后少于 2 个字符的也丢弃。CRLF 里的 LF 不算控制字符。

// lineState 每扇终端正在输入的那一行。回车结算进历史指令。
type lineState struct {
	buf   []rune
	dirty bool
	cr    bool
}

// 焦点事件报告（\x1b[I 进 / \x1b[O 出，focus() 会触发）和括号粘贴标记不是输入。
var inputNoise = strings.NewReplacer(
	"\x1b[I", "",
	"\x1b[O", "",
	"\x1b[200~", "",
	"\x1b[201~", "",
)

func (s *Service) captureInput(termID, data string) {
	cleaned := inputNoise.Replace(data)

	s.mu.Lock()
	st := s.lines[termID]
	if st == nil {
		st = &lineState{}
		s.lines[termID] = st
	}
	var settled []string
	for _, r := range cleaned {
		if r == '\r' {
			command := strings.TrimSpace(string(st.buf))
			if !st.dirty && len([]rune(command)) >= 2 {
				settled = append(settled, command)
			}
			*st = lineState{cr: true}
			continue
		}
		if r == '\n' && st.cr {
			st.cr = false
			continue
		}
		st.cr = false
		switch {
		case r == 0x7f || r == '\b':
			if len(st.buf) > 0 {
				st.buf = st.buf[:len(st.buf)-1]
			}
		case r < 0x20:
			st.dirty = true
		default:
			st.buf = append(st.buf, r)
		}
	}
	s.mu.Unlock()

	// 落库与事件通知放在锁外，避免外部实现回调进来时死锁。
	for _, command := range settled {
		if s.history != nil && s.history.AppendHistory(termID, command) && s.emitter != nil {
			s.emitter.HistoryChanged(termID)
		}
	}
}
