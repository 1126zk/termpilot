package terminal

// consoleEnter 把换行收成单个 CR。
// PSReadLine 只认 CR 提交命令。若把 LF 写成 CRLF，CR 执行之后剩下的 LF
// 会被当成续行，本机 PowerShell 的提示符就变成 >>。
func consoleEnter(data []byte) []byte {
	out := make([]byte, 0, len(data))
	for i := 0; i < len(data); i++ {
		if data[i] == '\n' {
			if i == 0 || data[i-1] != '\r' {
				out = append(out, '\r')
			}
			continue
		}
		out = append(out, data[i])
	}
	return out
}
