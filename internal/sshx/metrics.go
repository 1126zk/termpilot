package sshx

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// metricsScript 一条 POSIX sh 命令采完面板要的动态数据，段之间用 #TP-名字# 标记行
// 分隔，Go 端按标记切段解析。每段命令独立加 2>/dev/null，一段失败只是那段没数据，
// 不拖垮整体。CPU 行采两次（中间 sleep 1），用差值算使用率，比采瞬时值稳。
// 网卡计数跟着 CPU 一起采两次，各带一行 /proc/uptime 当时间戳，按实际间隔算网速。
// 进程用 ps aux 而不是 ps --sort，busybox 的 ps 不认 --sort。
// 主机名/系统/内核/IP 是静态身份，不在这里，由 serverInfoScript 一次性采集。
const metricsScript = `
echo '#TP-CPU1#'
grep '^cpu ' /proc/stat 2>/dev/null
grep -c '^cpu[0-9]' /proc/stat 2>/dev/null
echo '#TP-NET1#'
cat /proc/uptime 2>/dev/null
cat /proc/net/dev 2>/dev/null
sleep 1
echo '#TP-CPU2#'
grep '^cpu ' /proc/stat 2>/dev/null
echo '#TP-NET2#'
cat /proc/uptime 2>/dev/null
cat /proc/net/dev 2>/dev/null
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
echo '#TP-PORTS#'
(ss -tulnp 2>/dev/null || netstat -tulnp 2>/dev/null)
echo '#TP-PORTCMDS#'
for pid in $( (ss -tulnp 2>/dev/null || netstat -tulnp 2>/dev/null) | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p; s#.* \([0-9][0-9]*\)/.*#\1#p' | sort -u ); do
  echo "#PID:$pid#"
  tr '\0' ' ' < /proc/$pid/cmdline 2>/dev/null
  echo
  readlink /proc/$pid/exe 2>/dev/null
done
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
		Ports:       []PortInfo{},
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
	m.Ports = parsePorts(sec["PORTS"])
	// 按 PID 补完整命令行和可执行路径，面板展开时用来区分同名程序
	cmds := parsePortCmds(sec["PORTCMDS"])
	for i := range m.Ports {
		if c, ok := cmds[m.Ports[i].Pid]; ok {
			m.Ports[i].Cmd = c.cmd
			m.Ports[i].Exe = c.exe
		}
	}
	m.NetRxBps, m.NetTxBps = netRate(sec["NET1"], sec["NET2"])
	return m, nil
}

// netCounters 一次网卡采样：uptime 秒数和真实网卡的收发字节合计（按网卡名存，算差值时一一对上）。
type netCounters struct {
	at float64
	rx map[string]uint64
	tx map[string]uint64
}

// virtualIfacePrefixes 不算进网速的网卡：回环和容器/虚拟机/集群网络的虚拟网卡。
// 容器之间互相传数据也会走这些网卡，算进去网速会虚高。
var virtualIfacePrefixes = []string{"lo", "docker", "veth", "br-", "virbr", "cni", "flannel", "cali", "vxlan", "kube"}

// parseNetDev 解析一段「/proc/uptime 一行 + /proc/net/dev」。
// net/dev 每行是「网卡名: 收字节 收包 … 发字节 …」，冒号后第 1 列是收、第 9 列是发。
func parseNetDev(text string) *netCounters {
	lines := strings.Split(text, "\n")
	if len(lines) == 0 {
		return nil
	}
	up := strings.Fields(lines[0])
	if len(up) == 0 {
		return nil
	}
	at, err := strconv.ParseFloat(up[0], 64)
	if err != nil {
		return nil
	}
	c := &netCounters{at: at, rx: map[string]uint64{}, tx: map[string]uint64{}}
lines:
	for _, line := range lines[1:] {
		name, rest, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		name = strings.TrimSpace(name)
		for _, prefix := range virtualIfacePrefixes {
			if strings.HasPrefix(name, prefix) {
				continue lines
			}
		}
		fields := strings.Fields(rest)
		if len(fields) < 9 {
			continue
		}
		rx, err1 := strconv.ParseUint(fields[0], 10, 64)
		tx, err2 := strconv.ParseUint(fields[8], 10, 64)
		if err1 != nil || err2 != nil {
			continue
		}
		c.rx[name] = rx
		c.tx[name] = tx
	}
	return c
}

// netRate 两次采样之间真实网卡的收发速度（字节/秒）。计数回绕或网卡中途出现的不算。
func netRate(before, after string) (rxBps, txBps float64) {
	a, b := parseNetDev(before), parseNetDev(after)
	if a == nil || b == nil || b.at <= a.at {
		return 0, 0
	}
	var rx, tx uint64
	for name, v := range b.rx {
		if old, ok := a.rx[name]; ok && v >= old {
			rx += v - old
		}
	}
	for name, v := range b.tx {
		if old, ok := a.tx[name]; ok && v >= old {
			tx += v - old
		}
	}
	dt := b.at - a.at
	return float64(rx) / dt, float64(tx) / dt
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
// 按 %CPU 和 %MEM 各留前 30 再合并去重：面板一节看 CPU 一节看内存，只按一种排会漏另一种。
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
	top := func(more func(a, b ProcInfo) bool) []ProcInfo {
		sorted := make([]ProcInfo, len(procs))
		copy(sorted, procs)
		sort.SliceStable(sorted, func(i, j int) bool { return more(sorted[i], sorted[j]) })
		if len(sorted) > 30 {
			sorted = sorted[:30]
		}
		return sorted
	}
	seen := map[int]bool{}
	merged := []ProcInfo{}
	for _, p := range top(func(a, b ProcInfo) bool { return a.Cpu > b.Cpu }) {
		seen[p.Pid] = true
		merged = append(merged, p)
	}
	for _, p := range top(func(a, b ProcInfo) bool { return a.Mem > b.Mem }) {
		if !seen[p.Pid] {
			merged = append(merged, p)
		}
	}
	return merged
}

// ssProcRe 从 ss 的 Process 列提取程序名和 PID：users:(("nginx",pid=1234,fd=6),...)
var ssProcRe = regexp.MustCompile(`"([^"]+)",pid=(\d+)`)

// localPortRe 找「地址:数字端口」字段，Peer 一列是 * 不会被误当本地地址。
var localPortRe = regexp.MustCompile(`:\d+$`)

// parsePorts 解析 ss -tulnp 或 netstat -tulnp 的输出，统一成监听端口列表。
// 两种输出都只含监听 socket：ss 的 Local 在第 5 列、netstat 在第 4 列，
// 这里不按列号，直接找第一个「:数字」结尾的字段当本地地址，兼容两种格式。
// 非 root 时其他进程的 PID/程序名为空，分别留 0 和空串。
func parsePorts(text string) []PortInfo {
	ports := []PortInfo{}
	for _, line := range strings.Split(text, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}
		proto := strings.ToLower(fields[0])
		if proto != "tcp" && proto != "udp" {
			continue
		}
		local := ""
		for _, f := range fields[1:] {
			if localPortRe.MatchString(f) {
				local = f
				break
			}
		}
		if local == "" {
			continue
		}
		// IPv6 是 [::]:22，按最后一个冒号切开；ss 的地址可能带 %eth0 后缀，去掉
		i := strings.LastIndex(local, ":")
		if i < 0 {
			continue
		}
		addr := local[:i]
		if j := strings.Index(addr, "%"); j >= 0 {
			addr = addr[:j]
		}
		port, err := strconv.Atoi(local[i+1:])
		if err != nil {
			continue
		}
		p := PortInfo{Proto: proto, Addr: addr, Port: port}
		if m := ssProcRe.FindStringSubmatch(line); m != nil {
			p.Name = m[1]
			p.Pid, _ = strconv.Atoi(m[2])
		} else if j := strings.Index(fields[len(fields)-1], "/"); j > 0 {
			// netstat 的 PID/Program name 列：1234/sshd
			last := fields[len(fields)-1]
			if pid, err := strconv.Atoi(last[:j]); err == nil {
				p.Pid = pid
				p.Name = last[j+1:]
			}
		}
		ports = append(ports, p)
	}
	sort.SliceStable(ports, func(i, j int) bool {
		if ports[i].Port != ports[j].Port {
			return ports[i].Port < ports[j].Port
		}
		if ports[i].Proto != ports[j].Proto {
			return ports[i].Proto < ports[j].Proto
		}
		return ports[i].Addr < ports[j].Addr
	})
	return ports
}

// portCmd 一个监听进程的完整命令行和可执行路径。
type portCmd struct {
	cmd string
	exe string
}

// parsePortCmds 解析 PORTCMDS 段：#PID:<pid># 行开始一条，接下来两行分别是
// cmdline（NUL 已换成空格，可能为空行）和 exe 路径（可能为空）。
func parsePortCmds(text string) map[int]portCmd {
	out := map[int]portCmd{}
	pid := 0
	lineIdx := 0
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(line, "#PID:") && strings.HasSuffix(line, "#") {
			pid, _ = strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(line, "#PID:"), "#"))
			lineIdx = 0
			continue
		}
		if pid == 0 {
			continue
		}
		c := out[pid]
		switch lineIdx {
		case 0:
			c.cmd = strings.TrimSpace(line)
		case 1:
			c.exe = strings.TrimSpace(line)
		}
		out[pid] = c
		lineIdx++
	}
	return out
}

// KillProcess 给远端进程发 SIGTERM（温和杀）。面板杀进程按钮用；
// 通道失败或对端拒绝（权限不够等）都返回 error。
func (s *ExecService) KillProcess(sessionID string, pid int) error {
	res, err := s.Exec(sessionID, ExecOptions{Command: "kill " + strconv.Itoa(pid), TimeoutMs: 5000})
	if err != nil {
		return err
	}
	if res.TimedOut {
		return fmt.Errorf("结束进程 %d 超时", pid)
	}
	if res.ExitCode != nil && *res.ExitCode != 0 {
		stderr := strings.TrimSpace(res.Stderr)
		if strings.Contains(strings.ToLower(stderr), "no such process") {
			return fmt.Errorf("进程 %d 不存在或已退出", pid)
		}
		return fmt.Errorf("kill 失败（退出码 %d）：%s", *res.ExitCode, stderr)
	}
	return nil
}

// serverInfoScript 一次性采集静态身份：主机名、系统、内核、内网 IPv4、外网出口 IP。
// 内网用 ip 命令并滤掉 docker/veth 等虚拟网桥，没有 ip 就退回 hostname -I。
// 外网 IP：先问云厂商元数据服务（虚拟化层本地应答，不出机房，毫秒级）——阿里云/腾讯云/AWS 通用；
// 答不上才出站问外部服务（curl 两个互备、wget 兜底）。超时预算总和压在采集超时（10s）以内。
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
curl -fsS --max-time 1 http://100.100.100.200/latest/meta-data/eipv4 2>/dev/null || curl -fsS --max-time 1 http://metadata.tencentyun.com/latest/meta-data/public-ipv4 2>/dev/null || curl -fsS --max-time 1 http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || curl -fsS --max-time 3 https://ifconfig.me 2>/dev/null || curl -fsS --max-time 3 https://api.ipify.org 2>/dev/null || wget -qO- --timeout=3 https://ifconfig.me 2>/dev/null
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
