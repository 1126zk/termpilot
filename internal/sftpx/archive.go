package sftpx

import (
	"errors"
	"fmt"
	"path"
	"strconv"
	"strings"
)

// TarGzCommand 在文件夹旁边生成同名 .tar.gz 的远端命令。
// 路径按 shell 单引号转义，不直接拼进脚本。
// 有 GNU tar 时每约 1MB 未压缩数据打一行 TP N，前面先打 TP_TOTAL。
func TarGzCommand(dir string) (string, error) {
	parent, name, dest, err := tarGzPlan(dir)
	if err != nil {
		return "", err
	}
	src := path.Join(parent, name)
	q := shSingle
	return fmt.Sprintf(`if [ -e %s ]; then echo '压缩包已存在' >&2; exit 1; fi
total=$(du -sb -- %s 2>/dev/null | awk 'NR==1 { print $1; exit }')
printf 'TP_TOTAL %%s\n' "$total"
if tar --help 2>&1 | grep -q checkpoint-action; then
  tar -czf %s -C %s --record-size=10240 --checkpoint=100 --checkpoint-action='echo=TP %%u' -- %s
else
  tar -czf %s -C %s -- %s
fi
status=$?
if [ "$status" -ne 0 ]; then rm -f %s; exit "$status"; fi
`, q(dest), q(src), q(dest), q(parent), q(name), q(dest), q(parent), q(name), q(dest)), nil
}

// ArchiveTickBytes 一条 TP 进度相当于多少未压缩字节（100 个 10KB 记录）。
const ArchiveTickBytes int64 = 10240 * 100

// ParseArchiveLine 认出进度行。total 为目录字节数，tick 为第几次检查点。
func ParseArchiveLine(line string) (total, tick int64, kind string, ok bool) {
	line = strings.TrimSpace(strings.TrimPrefix(line, "\r"))
	line = strings.TrimPrefix(line, "tar: ")
	switch {
	case strings.HasPrefix(line, "TP_TOTAL "):
		n, err := strconv.ParseInt(strings.TrimSpace(strings.TrimPrefix(line, "TP_TOTAL ")), 10, 64)
		if err != nil || n < 0 {
			return 0, 0, "", false
		}
		return n, 0, "total", true
	case strings.HasPrefix(line, "TP "):
		n, err := strconv.ParseInt(strings.TrimSpace(strings.TrimPrefix(line, "TP ")), 10, 64)
		if err != nil || n < 0 {
			return 0, 0, "", false
		}
		return 0, n, "tick", true
	default:
		return 0, 0, "", false
	}
}

// ArchiveFailText 从命令输出里取出给人看的失败原因，进度行不算。
func ArchiveFailText(stderr, stdout string) string {
	for _, blob := range []string{stderr, stdout} {
		for _, line := range strings.Split(blob, "\n") {
			line = strings.TrimSpace(strings.TrimPrefix(line, "\r"))
			if line == "" {
				continue
			}
			if _, _, _, ok := ParseArchiveLine(line); ok {
				continue
			}
			if len(line) > 200 {
				line = line[:200]
			}
			return line
		}
	}
	return "压缩失败"
}

func TarGzDest(dir string) (string, error) {
	_, _, dest, err := tarGzPlan(dir)
	return dest, err
}

func tarGzPlan(dir string) (parent, name, dest string, err error) {
	clean := path.Clean(normalizeRemotePath(strings.TrimSpace(dir)))
	if clean == "." || clean == "/" || clean == "" {
		return "", "", "", errors.New("这个目录不能压缩")
	}
	name = path.Base(clean)
	parent = path.Dir(clean)
	if name == "." || name == "/" || name == ".." {
		return "", "", "", errors.New("这个目录不能压缩")
	}
	return parent, name, path.Join(parent, name+".tar.gz"), nil
}

func shSingle(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
