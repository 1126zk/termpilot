package sshx

import (
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// metricsScript 一条 POSIX sh 命令采完面板要的动态数据，段之间用 #TP-名字# 标记行
// 分隔，Go 端按标记切段解析。每段命令独立加 2>/dev/null，一段失败只是那段没数据，
// 不拖垮整体。CPU 行采两次（中间 sleep 1），用差值算使用率，比采瞬时值稳。
// 进程用 ps aux 而不是 ps --sort，busybox 的 ps 不认 --sort。
// 主机名/系统/内核/IP 是静态身份，不在这里，由 serverInfoScript 一次性采集。
const metricsScript = `
echo '#TP-CPU1#'
grep '^cpu ' /proc/stat 2>/dev/null
grep -c '^cpu[0-9]' /proc/stat 2>/dev/null
sleep 1
echo '#TP-CPU2#'
grep '^cpu ' /proc/stat 2>/dev/null
echo '#TP-MEM#'
grep -E '^(MemTotal|MemAvailable):' /proc/meminfo 2>/dev/null
echo '#TP-LOAD#'
cat /proc/loadavg 2>/dev/null
echo '#TP-UPTIME#'
cat /proc/uptime 2>/dev/null
echo '#TP-DF#'
df -P -x tmpfs -x devtmpfs 2>/dev/null || df -P 2>/dev/null
echo '#TP-PS#'
ps aux 2>/dev/null
echo '#TP-END#'
`

// CollectMetrics 采一次服务器指标，给运维面板轮询用，只支持 Linux。
// 与 DetectOS 一样走共享 SSH 连接的 exec 通道，不占终端画面。
func (s *ExecService) CollectMetrics(sessionID string) (*ServerMetrics, error) {
	res, err := s.Exec(sessionID, ExecOptions{Command: metricsScript, TimeoutMs: 20000})
	if err != nil {
		return nil, err
	}
	sec := splitSections(res.Stdout)
	m := &ServerMetrics{
		Disks:       []DiskUsage{},
		Procs:       []ProcInfo{},
		CollectedAt: time.Now().UnixMilli(),
	}

	// CPU1 段两行：一行 cpu 汇总，一行核数。
	var stat1, stat2 *cpuStat
	for _, line := range strings.Split(sec["CPU1"], "\n") {
		if strings.HasPrefix(line, "cpu ") {
			stat1 = parseCpuStat(line)
		} else if n, err := strconv.Atoi(strings.TrimSpace(line)); err == nil {
			m.Cores = n
		}
	}
	for _, line := range strings.Split(sec["CPU2"], "\n") {
		if strings.HasPrefix(line, "cpu ") {
			stat2 = parseCpuStat(line)
		}
	}
	if stat1 != nil && stat2 != nil && stat2.total > stat1.total && stat2.idle >= stat1.idle {
		dTotal := stat2.total - stat1.total
		dIdle := stat2.idle - stat1.idle
		m.CpuPercent = float64(dTotal-dIdle) * 100 / float64(dTotal)
	}

	for _, line := range strings.Split(sec["MEM"], "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		kb, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			continue
		}
		switch fields[0] {
		case "MemTotal:":
			m.MemTotal = kb * 1024
		case "MemAvailable:":
			m.MemAvail = kb * 1024
		}
	}

	if fields := strings.Fields(sec["LOAD"]); len(fields) >= 3 {
		m.Load1, _ = strconv.ParseFloat(fields[0], 64)
		m.Load5, _ = strconv.ParseFloat(fields[1], 64)
		m.Load15, _ = strconv.ParseFloat(fields[2], 64)
	}

	if fields := strings.Fields(sec["UPTIME"]); len(fields) >= 1 {
		if v, err := strconv.ParseFloat(fields[0], 64); err == nil {
			m.UptimeSec = int64(v)
		}
	}

	m.Disks = parseDf(sec["DF"])
	m.Procs = parsePs(sec["PS"])
	return m, nil
}

// splitSections 按 #TP-名字# 标记行把输出切成段，标记行本身不进任何段。
func splitSections(out string) map[string]string {
	sec := map[string]string{}
	cur := ""
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimRight(line, "\r")
		if strings.HasPrefix(line, "#TP-") && strings.HasSuffix(line, "#") {
			cur = strings.TrimSuffix(strings.TrimPrefix(line, "#TP-"), "#")
			continue
		}
		sec[cur] += line + "\n"
	}
	return sec
}

// cpuStat /proc/stat 里 cpu 汇总行拆出的两组 jiffies：idle 含 iowait，total 是全部列之和。
type cpuStat struct {
	idle  uint64
	total uint64
}

func parseCpuStat(line string) *cpuStat {
	fields := strings.Fields(line)
	// 至少要有 user nice system idle 四列
	if len(fields) < 5 {
		return nil
	}
	var total uint64
	vals := make([]uint64, 0, len(fields)-1)
	for _, f := range fields[1:] {
		n, err := strconv.ParseUint(f, 10, 64)
		if err != nil {
			return nil
		}
		vals = append(vals, n)
		total += n
	}
	idle := vals[3]
	if len(vals) > 4 {
		idle += vals[4] // iowait 也算闲
	}
	return &cpuStat{idle: idle, total: total}
}

// parseDf 解析 df -P 的输出：文件系统、总量、已用、可用、使用率、挂载点六列，
// 挂载点含空格时并入最后一列。
func parseDf(text string) []DiskUsage {
	disks := []DiskUsage{}
	for _, line := range strings.Split(text, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 6 || fields[0] == "Filesystem" {
			continue
		}
		blocks, err1 := strconv.ParseUint(fields[1], 10, 64)
		used, err2 := strconv.ParseUint(fields[2], 10, 64)
		if err1 != nil || err2 != nil {
			continue
		}
		pct, err := strconv.ParseFloat(strings.TrimSuffix(fields[4], "%"), 64)
		if err != nil && blocks > 0 {
			pct = float64(used) * 100 / float64(blocks)
		}
		disks = append(disks, DiskUsage{
			Mount:      strings.Join(fields[5:], " "),
			Total:      blocks * 1024,
			Used:       used * 1024,
			UsePercent: pct,
		})
	}
	return disks
}

// parsePs 解析 ps aux（procps 与 busybox 同列序）：
// USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND，COMMAND 从第 11 列起拼接。
// 按 %CPU 降序留前 30，面板只看最吃资源的。
func parsePs(text string) []ProcInfo {
	procs := []ProcInfo{}
	for _, line := range strings.Split(text, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 11 || fields[0] == "USER" {
			continue
		}
		pid, err := strconv.Atoi(fields[1])
		if err != nil {
			continue
		}
		cpu, _ := strconv.ParseFloat(fields[2], 64)
		mem, _ := strconv.ParseFloat(fields[3], 64)
		rssKb, _ := strconv.ParseUint(fields[5], 10, 64)
		name := fields[10]
		if i := strings.LastIndex(name, "/"); i >= 0 {
			name = name[i+1:]
		}
		procs = append(procs, ProcInfo{
			Pid:  pid,
			User: fields[0],
			Cpu:  cpu,
			Mem:  mem,
			Rss:  rssKb * 1024,
			Name: name,
			Cmd:  strings.Join(fields[10:], " "),
		})
	}
	sort.SliceStable(procs, func(i, j int) bool { return procs[i].Cpu > procs[j].Cpu })
	if len(procs) > 30 {
		procs = procs[:30]
	}
	return procs
}

// serverInfoScript 一次性采集静态身份：主机名、系统、内核、内网 IPv4、外网出口 IP。
// 内网用 ip 命令并滤掉 docker/veth 等虚拟网桥，没有 ip 就退回 hostname -I。
// 外网要服务器发一次出站请求，curl 两个服务互备、wget 兜底，3 秒拿不到就放弃。
const serverInfoScript = `
echo '#TP-HOST#'
hostname 2>/dev/null
echo '#TP-OS#'
(PRETTY_NAME=; [ -r /etc/os-release ] && . /etc/os-release; echo "$PRETTY_NAME")
echo '#TP-KERNEL#'
uname -r 2>/dev/null
echo '#TP-LAN#'
lan=$(ip -4 -o addr show scope global 2>/dev/null | awk '$2 !~ /^(lo|docker|br-|veth)/ {sub(/\/.*$/, "", $4); print $4}')
[ -z "$lan" ] && lan=$(hostname -I 2>/dev/null)
echo "$lan"
echo '#TP-WAN#'
curl -fsS --max-time 3 https://ifconfig.me 2>/dev/null || curl -fsS --max-time 3 https://api.ipify.org 2>/dev/null || wget -qO- --timeout=3 https://ifconfig.me 2>/dev/null
echo '#TP-END#'
`

// ipv4Re 从外网服务的响应里捞 IPv4。有的服务会回 HTML 页面，不能直接当 IP 用。
var ipv4Re = regexp.MustCompile(`(\d{1,3}\.){3}\d{1,3}`)

// CollectServerInfo 采一次静态身份（主机名/系统/内核/内网/外网 IP）。这些基本不变，
// 面板打开时采一次并缓存，不进 3 秒轮询——外网那次出站请求每轮都发就太慢太吵了。
func (s *ExecService) CollectServerInfo(sessionID string) (*ServerInfo, error) {
	res, err := s.Exec(sessionID, ExecOptions{Command: serverInfoScript, TimeoutMs: 12000})
	if err != nil {
		return nil, err
	}
	sec := splitSections(res.Stdout)
	info := &ServerInfo{
		Hostname: strings.TrimSpace(sec["HOST"]),
		OsPretty: strings.TrimSpace(sec["OS"]),
		Kernel:   strings.TrimSpace(sec["KERNEL"]),
		LanIps:   []string{},
	}
	for _, f := range strings.Fields(sec["LAN"]) {
		// 只留 IPv4 全局地址，滤掉 IPv6 和回环（hostname -I 兜底路径会带进来）
		if strings.Count(f, ".") == 3 && !strings.HasPrefix(f, "127.") {
			info.LanIps = append(info.LanIps, f)
		}
	}
	info.WanIp = ipv4Re.FindString(sec["WAN"])
	return info, nil
}
