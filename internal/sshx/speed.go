package sshx

import (
	"errors"
	"fmt"
	"io"
	"net"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"golang.org/x/crypto/ssh"
)

// SpeedReport 一次测速。未测到的速率或丢包是负数。
// Link 是本机到这台服务器的 SSH。Egress 是服务器到外网，Route 为 cn 或 intl。
type SpeedReport struct {
	Kind      string  `json:"kind"`
	Route     string  `json:"route,omitempty"`
	LatencyMs float64 `json:"latencyMs"`
	JitterMs  float64 `json:"jitterMs"`
	DownBps   float64 `json:"downBps"`
	UpBps     float64 `json:"upBps"`
	LossPct   float64 `json:"lossPct"`
	// At 测完的时间，毫秒。
	At   int64  `json:"at,omitempty"`
	From string `json:"from,omitempty"`
	To   string `json:"to,omitempty"`
}

// SpeedTick 测速过程中的一段进度。速率还没出来时是负数。
type SpeedTick struct {
	Phase   string  `json:"phase"`
	Ratio   float64 `json:"ratio"`
	DownBps float64 `json:"downBps"`
	UpBps   float64 `json:"upBps"`
}

const (
	// 固定测这么久，按实际字节算速度。字节封顶会在快链路上变成几十毫秒的突发。
	speedWindow = 6 * time.Second
	// 结果没回来之前进度停在这里。前端拿到报告再拉满。
	speedRatioCap = 0.9
)

// MeasureSpeed kind 为 link（本机到服务器）或 egress（服务器到外网）。
// on 可以为 nil。进度回调可能在别的 goroutine 上。
func (s *ExecService) MeasureSpeed(sessionID, kind string, on func(SpeedTick)) (*SpeedReport, error) {
	switch kind {
	case "link":
		return s.measureLink(sessionID, on)
	case "egress":
		return s.measureEgress(sessionID, on)
	default:
		return nil, errors.New("未知测速")
	}
}

func emitTick(on func(SpeedTick), tick SpeedTick) {
	if on != nil {
		on(tick)
	}
}

func (s *ExecService) measureLink(sessionID string, on func(SpeedTick)) (*SpeedReport, error) {
	client, release, err := s.speedClient(sessionID)
	if err != nil {
		return nil, err
	}
	defer release()

	beforeCh := make(chan []tcpSnap, 1)
	go func() { beforeCh <- readTCP(client) }()
	from, to := connEnds(client)
	var lastDown time.Time
	downStart := time.Now()
	emitTick(on, SpeedTick{Phase: "down", Ratio: 0, DownBps: -1, UpBps: -1})
	down, downElapsed, err := countDownload(client, speedWindow, func(n int64) {
		if time.Since(lastDown) < 200*time.Millisecond {
			return
		}
		lastDown = time.Now()
		emitTick(on, SpeedTick{Phase: "down", Ratio: windowRatio(time.Since(downStart)) * 0.5, DownBps: liveBps(n, time.Since(downStart)), UpBps: -1})
	})
	if err != nil {
		return nil, err
	}
	downBps := -1.0
	if down >= 1024 && downElapsed > 0 {
		downBps = float64(down) / downElapsed.Seconds()
	}
	emitTick(on, SpeedTick{Phase: "down", Ratio: 0.5, DownBps: downBps, UpBps: -1})
	var lastUp time.Time
	upStart := time.Now()
	up, upElapsed, upErr := countUpload(client, speedWindow, func(n int64) {
		if time.Since(lastUp) < 200*time.Millisecond {
			return
		}
		lastUp = time.Now()
		emitTick(on, SpeedTick{Phase: "up", Ratio: capRatio(0.5 + windowRatio(time.Since(upStart))*0.4), DownBps: downBps, UpBps: liveBps(n, time.Since(upStart))})
	})
	afterCh := make(chan []tcpSnap, 1)
	go func() { afterCh <- readTCP(client) }()
	before := <-beforeCh
	after := <-afterCh
	if down < 1024 || downElapsed <= 0 {
		return nil, errors.New("测速没有拿到数据")
	}
	link := matchTCP(before, after)
	report := &SpeedReport{
		Kind:      "link",
		DownBps:   float64(down) / downElapsed.Seconds(),
		UpBps:     -1,
		LatencyMs: -1,
		JitterMs:  -1,
		LossPct:   -1,
	}
	if upErr == nil && up >= 1024 && upElapsed > 0 {
		report.UpBps = float64(up) / upElapsed.Seconds()
	}
	if link != nil {
		report.LatencyMs = link.rtt
		report.JitterMs = link.jitter
		report.LossPct = link.loss
	}
	report.At = time.Now().UnixMilli()
	report.From = from
	report.To = to
	return report, nil
}

func windowRatio(elapsed time.Duration) float64 {
	p := elapsed.Seconds() / speedWindow.Seconds()
	if p < 0 {
		return 0
	}
	if p > 1 {
		return 1
	}
	return p
}

func capRatio(ratio float64) float64 {
	if ratio > speedRatioCap {
		return speedRatioCap
	}
	return ratio
}

func liveBps(n int64, elapsed time.Duration) float64 {
	if n <= 0 || elapsed <= 0 {
		return -1
	}
	return float64(n) / elapsed.Seconds()
}

func connEnds(client *ssh.Client) (string, string) {
	if client == nil || client.Conn == nil {
		return "", ""
	}
	return addrHost(client.LocalAddr()), addrHost(client.RemoteAddr())
}

func addrHost(addr net.Addr) string {
	if addr == nil {
		return ""
	}
	host, _, err := net.SplitHostPort(addr.String())
	if err != nil {
		return addr.String()
	}
	return host
}

func (s *ExecService) measureEgress(sessionID string, on func(SpeedTick)) (*SpeedReport, error) {
	info, err := s.CollectServerInfo(sessionID)
	if err != nil {
		return nil, err
	}
	if info.WanIp == "" {
		return nil, errors.New("没有查到外网地址")
	}
	intl := !mainland(info.WanIp)
	section := ""
	probes := 0
	downBps := -1.0
	upBps := -1.0
	var paceStop chan struct{}
	stopPace := func() {
		if paceStop == nil {
			return
		}
		close(paceStop)
		paceStop = nil
	}
	defer stopPace()
	startPace := func(phase string, from, to float64) {
		stopPace()
		ch := make(chan struct{})
		paceStop = ch
		start := time.Now()
		emitTick(on, SpeedTick{Phase: phase, Ratio: from, DownBps: -1, UpBps: -1})
		go func() {
			ticker := time.NewTicker(200 * time.Millisecond)
			defer ticker.Stop()
			for {
				select {
				case <-ch:
					return
				case <-ticker.C:
					p := windowRatio(time.Since(start))
					emitTick(on, SpeedTick{Phase: phase, Ratio: from + (to-from)*p, DownBps: -1, UpBps: -1})
				}
			}
		}()
	}
	res, err := s.Exec(sessionID, ExecOptions{
		Command:   egressScript(intl),
		TimeoutMs: 60000,
		OnLine: func(line string) {
			line = strings.TrimSpace(strings.TrimPrefix(line, "\r"))
			switch line {
			case "#P#":
				section = "p"
				emitTick(on, SpeedTick{Phase: "probe", Ratio: 0.02, DownBps: -1, UpBps: -1})
			case "#D#":
				section = "d"
				startPace("down", 0.32, 0.58)
			case "#U#":
				section = "u"
				startPace("up", 0.58, speedRatioCap)
			case "", "#END#":
			default:
				switch section {
				case "p":
					probes++
					emitTick(on, SpeedTick{Phase: "probe", Ratio: 0.02 + float64(probes)/10*0.28, DownBps: -1, UpBps: -1})
				case "d":
					var bytes, sec float64
					if _, err := fmt.Sscanf(line, "%f %f", &bytes, &sec); err == nil && bytes >= 1024 && sec > 0 {
						stopPace()
						downBps = bytes / sec
						next := 0.58
						if !intl {
							next = speedRatioCap
						}
						emitTick(on, SpeedTick{Phase: "down", Ratio: next, DownBps: downBps, UpBps: -1})
					}
				case "u":
					var bytes, sec float64
					if _, err := fmt.Sscanf(line, "%f %f", &bytes, &sec); err == nil && bytes >= 1024 && sec > 0 {
						stopPace()
						upBps = bytes / sec
						emitTick(on, SpeedTick{Phase: "up", Ratio: speedRatioCap, DownBps: downBps, UpBps: upBps})
					}
				}
			}
		},
	})
	if err != nil {
		return nil, err
	}
	if res.TimedOut {
		return nil, errors.New("测速超时")
	}
	report, err := parseEgress(res.Stdout)
	if err != nil {
		return nil, err
	}
	report.Kind = "egress"
	report.At = time.Now().UnixMilli()
	report.From = info.WanIp
	if intl {
		report.Route = "intl"
	} else {
		report.Route = "cn"
	}
	return report, nil
}

// speedClient 拿出能开通道的连接。共享连接被终端占满时另拨一条，用完归还。
func (s *ExecService) speedClient(sessionID string) (*ssh.Client, func(), error) {
	hold, err := s.hold(sessionID)
	if err != nil {
		return nil, nil, err
	}
	client := hold.Conn.Client
	if client == nil {
		return nil, nil, errors.New("连接未建立")
	}
	sess, err := client.NewSession()
	if err == nil {
		_ = sess.Close()
		return client, func() {}, nil
	}
	if s.isolate == nil || !channelRejected(err) {
		return nil, nil, err
	}
	iso, isoErr := s.isolate(sessionID)
	if isoErr != nil {
		return nil, nil, isoErr
	}
	if iso.Conn.Client == nil {
		iso.Release()
		return nil, nil, errors.New("连接未建立")
	}
	return iso.Conn.Client, iso.Release, nil
}

func countDownload(client *ssh.Client, window time.Duration, on func(int64)) (int64, time.Duration, error) {
	session, err := client.NewSession()
	if err != nil {
		return 0, 0, err
	}
	stdout, err := session.StdoutPipe()
	if err != nil {
		_ = session.Close()
		return 0, 0, err
	}
	if err := session.Start("cat /dev/zero"); err != nil {
		_ = session.Close()
		return 0, 0, err
	}
	var got atomic.Int64
	done := make(chan struct{})
	go func() {
		defer close(done)
		buf := make([]byte, 32*1024)
		for {
			nr, rerr := stdout.Read(buf)
			if nr > 0 {
				got.Add(int64(nr))
			}
			if rerr != nil {
				return
			}
		}
	}()
	return waitTransfer(session, done, window, func() int64 { return got.Load() }, on)
}

func countUpload(client *ssh.Client, window time.Duration, on func(int64)) (int64, time.Duration, error) {
	session, err := client.NewSession()
	if err != nil {
		return 0, 0, err
	}
	stdin, err := session.StdinPipe()
	if err != nil {
		_ = session.Close()
		return 0, 0, err
	}
	if err := session.Start("cat >/dev/null"); err != nil {
		_ = session.Close()
		return 0, 0, err
	}
	var sent atomic.Int64
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer func() { _ = stdin.Close() }()
		buf := make([]byte, 32*1024)
		for {
			nw, werr := stdin.Write(buf)
			if nw > 0 {
				sent.Add(int64(nw))
			}
			if werr != nil {
				return
			}
		}
	}()
	return waitTransfer(session, done, window, func() int64 { return sent.Load() }, on)
}

// waitTransfer 到点就记下字节数并返回。关通道在后台做，不挡住后面的 ss。
func waitTransfer(session *ssh.Session, done <-chan struct{}, window time.Duration, bytes func() int64, on func(int64)) (int64, time.Duration, error) {
	start := time.Now()
	ticker := time.NewTicker(200 * time.Millisecond)
	deadline := time.NewTimer(window)
	defer ticker.Stop()
	defer deadline.Stop()
	for {
		select {
		case <-done:
			n := bytes()
			elapsed := time.Since(start)
			releaseSession(session, done)
			return n, elapsed, nil
		case <-deadline.C:
			n := bytes()
			elapsed := time.Since(start)
			releaseSession(session, done)
			return n, elapsed, nil
		case <-ticker.C:
			if on != nil {
				on(bytes())
			}
		}
	}
}

func releaseSession(session *ssh.Session, done <-chan struct{}) {
	_ = session.Signal(ssh.SIGKILL)
	_ = session.Close()
	go func() {
		select {
		case <-done:
		case <-time.After(2 * time.Second):
		}
		_ = session.Wait()
	}()
}

type tcpSnap struct {
	id      string
	sent    uint64
	retrans uint64
	rtt     float64
	jitter  float64
}

type tcpLink struct {
	rtt, jitter, loss float64
}

func readTCP(client *ssh.Client) []tcpSnap {
	for _, cmd := range []string{"ss -ti state established", "/usr/sbin/ss -ti state established", "/bin/ss -ti state established"} {
		text, _ := collectOutput(client, cmd, 5*time.Second, 64*1024)
		if snaps := parseSS(text); len(snaps) > 0 {
			return snaps
		}
	}
	return nil
}

// socketID 只留本地地址和对端地址。队列数字会变，不能拿整行当同一条连接。
func socketID(line string) string {
	var ends []string
	for _, field := range strings.Fields(line) {
		if strings.Contains(field, ":") {
			ends = append(ends, field)
		}
	}
	if len(ends) < 2 {
		return ""
	}
	return ends[len(ends)-2] + " " + ends[len(ends)-1]
}

// matchTCP 找出测速期间发出字节增加最多的那条连接，丢包按这段增量算。
func matchTCP(before, after []tcpSnap) *tcpLink {
	prev := map[string]tcpSnap{}
	for _, snap := range before {
		prev[snap.id] = snap
	}
	var best *tcpLink
	var bestSent uint64
	for _, snap := range after {
		old, ok := prev[snap.id]
		if !ok || snap.sent < old.sent || snap.retrans < old.retrans {
			continue
		}
		sent := snap.sent - old.sent
		if best != nil && sent < bestSent {
			continue
		}
		loss := -1.0
		if sent > 0 {
			loss = float64(snap.retrans-old.retrans) * 100 / float64(sent)
			if loss < 0 {
				loss = 0
			}
			if loss > 100 {
				loss = 100
			}
		}
		bestSent = sent
		best = &tcpLink{rtt: snap.rtt, jitter: snap.jitter, loss: loss}
	}
	return best
}

var (
	ssRTT     = regexp.MustCompile(`rtt:([0-9.]+)/([0-9.]+)`)
	ssSent    = regexp.MustCompile(`bytes_sent:(\d+)`)
	ssRetrans = regexp.MustCompile(`bytes_retrans:(\d+)`)
)

func parseSS(text string) []tcpSnap {
	var snaps []tcpSnap
	var cur *tcpSnap
	flush := func() {
		if cur == nil {
			return
		}
		snaps = append(snaps, *cur)
		cur = nil
	}
	for _, line := range strings.Split(text, "\n") {
		if strings.Contains(line, "Recv-Q") {
			continue
		}
		if !strings.HasPrefix(line, "\t") && !strings.HasPrefix(line, " ") {
			flush()
			if id := socketID(line); id != "" {
				cur = &tcpSnap{id: id}
			}
			continue
		}
		if cur == nil {
			continue
		}
		if m := ssRTT.FindStringSubmatch(line); m != nil {
			cur.rtt, _ = strconv.ParseFloat(m[1], 64)
			cur.jitter, _ = strconv.ParseFloat(m[2], 64)
		}
		if m := ssSent.FindStringSubmatch(line); m != nil {
			cur.sent, _ = strconv.ParseUint(m[1], 10, 64)
		}
		if m := ssRetrans.FindStringSubmatch(line); m != nil {
			cur.retrans, _ = strconv.ParseUint(m[1], 10, 64)
		}
	}
	flush()
	return snaps
}

func egressScript(intl bool) string {
	if intl {
		return `echo '#P#'
url='https://speed.cloudflare.com/__down?bytes=64'
i=0
while [ "$i" -lt 10 ]; do
  t=$(curl -sS -o /dev/null -w '%{time_starttransfer}' --connect-timeout 3 --max-time 3 "$url" 2>/dev/null) || t=fail
  echo "$t"
  i=$((i+1))
done
echo '#D#'
start=$(date +%s%N)
total=0
ip=""
while :; do
  now=$(date +%s%N)
  left_ns=$((6000000000 - (now - start)))
  if [ "$left_ns" -le 200000000 ]; then
    break
  fi
  left=$(((left_ns + 999999999) / 1000000000))
  line=$(curl -sS -o /dev/null -w '%{size_download} %{remote_ip}' --connect-timeout 5 --max-time "$left" 'https://speed.cloudflare.com/__down?bytes=50000000' 2>/dev/null || true)
  n=${line%% *}
  case "$n" in
    ''|*[!0-9]*) n=0 ;;
  esac
  total=$((total + n))
  rest=${line#* }
  if [ -n "$rest" ] && [ "$rest" != "$line" ]; then
    ip=$rest
  fi
done
end=$(date +%s%N)
awk -v t="$total" -v s="$start" -v e="$end" -v ip="$ip" 'BEGIN { printf "%d %.3f %s\n", t, (e - s) / 1000000000, ip }'
echo '#U#'
start=$(date +%s%N)
total=0
while :; do
  now=$(date +%s%N)
  left_ns=$((6000000000 - (now - start)))
  if [ "$left_ns" -le 200000000 ]; then
    break
  fi
  left=$(((left_ns + 999999999) / 1000000000))
  line=$(head -c 25000000 /dev/zero | curl -sS -o /dev/null -w '%{size_upload}' --connect-timeout 5 --max-time "$left" -X POST --data-binary @- https://speed.cloudflare.com/__up 2>/dev/null || true)
  n=${line%% *}
  case "$n" in
    ''|*[!0-9]*) n=0 ;;
  esac
  total=$((total + n))
done
end=$(date +%s%N)
awk -v t="$total" -v s="$start" -v e="$end" 'BEGIN { printf "%d %.3f\n", t, (e - s) / 1000000000 }'
echo '#END#'`
	}
	return `echo '#P#'
url=""
for u in \
  "http://speedtest.zju.edu.cn/100M" \
  "https://mirrors.aliyun.com/nodejs-release/v22.14.0/node-v22.14.0-linux-x64.tar.xz" \
  "https://mirrors.cloud.tencent.com/nodejs-release/v22.14.0/node-v22.14.0-linux-x64.tar.xz"
do
  code=$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 8 -r 0-1023 "$u" 2>/dev/null || true)
  if [ "$code" = 206 ] || [ "$code" = 200 ]; then
    url=$u
    break
  fi
done
if [ -z "$url" ]; then
  echo fail
  echo '#D#'
  echo '0 0'
  echo '#END#'
  exit 0
fi
i=0
while [ "$i" -lt 10 ]; do
  t=$(curl -sS -o /dev/null -w '%{time_starttransfer}' --connect-timeout 3 --max-time 3 -r 0-63 "$url" 2>/dev/null) || t=fail
  echo "$t"
  i=$((i+1))
done
echo '#D#'
start=$(date +%s%N)
total=0
ip=""
while :; do
  now=$(date +%s%N)
  left_ns=$((6000000000 - (now - start)))
  if [ "$left_ns" -le 200000000 ]; then
    break
  fi
  left=$(((left_ns + 999999999) / 1000000000))
  line=$(curl -sS -o /dev/null -w '%{size_download} %{remote_ip}' --connect-timeout 5 --max-time "$left" -r 0-104857599 "$url" 2>/dev/null || true)
  n=${line%% *}
  case "$n" in
    ''|*[!0-9]*) n=0 ;;
  esac
  total=$((total + n))
  rest=${line#* }
  if [ -n "$rest" ] && [ "$rest" != "$line" ]; then
    ip=$rest
  fi
done
end=$(date +%s%N)
awk -v t="$total" -v s="$start" -v e="$end" -v ip="$ip" 'BEGIN { printf "%d %.3f %s\n", t, (e - s) / 1000000000, ip }'
echo '#END#'`
}

func parseEgress(text string) (*SpeedReport, error) {
	section := ""
	var probes []float64
	fails := 0
	seen := 0
	var downBytes, upBytes float64
	var downSec, upSec float64
	var remote string
	gotDown := false
	gotUp := false
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		switch line {
		case "#P#":
			section = "p"
			continue
		case "#D#":
			section = "d"
			continue
		case "#U#":
			section = "u"
			continue
		case "#END#", "":
			continue
		}
		switch section {
		case "p":
			seen++
			if line == "fail" {
				fails++
				continue
			}
			v, err := strconv.ParseFloat(line, 64)
			if err != nil || v <= 0 {
				fails++
				continue
			}
			probes = append(probes, v)
		case "d":
			if gotDown {
				continue
			}
			if _, err := fmt.Sscanf(line, "%f %f %s", &downBytes, &downSec, &remote); err != nil && downSec <= 0 {
				continue
			}
			gotDown = true
		case "u":
			if gotUp {
				continue
			}
			fmt.Sscanf(line, "%f %f", &upBytes, &upSec)
			gotUp = true
		}
	}
	if !gotDown || downBytes < 1024 || downSec <= 0 {
		return nil, errors.New("测速没有拿到数据")
	}
	report := &SpeedReport{
		DownBps:   downBytes / downSec,
		UpBps:     -1,
		LatencyMs: -1,
		JitterMs:  -1,
		LossPct:   -1,
		To:        remote,
	}
	if gotUp && upBytes >= 1024 && upSec > 0 {
		report.UpBps = upBytes / upSec
	}
	if seen > 0 {
		report.LossPct = float64(fails) * 100 / float64(seen)
	}
	if len(probes) > 1 {
		samples := probes[1:]
		report.LatencyMs = median(samples) * 1000
		report.JitterMs = mad(samples, report.LatencyMs/1000) * 1000
	} else if len(probes) == 1 {
		report.LatencyMs = probes[0] * 1000
		report.JitterMs = 0
	}
	return report, nil
}

func median(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	sorted := append([]float64(nil), values...)
	sort.Float64s(sorted)
	mid := len(sorted) / 2
	if len(sorted)%2 == 1 {
		return sorted[mid]
	}
	return (sorted[mid-1] + sorted[mid]) / 2
}

func mad(values []float64, center float64) float64 {
	if len(values) == 0 {
		return 0
	}
	devs := make([]float64, len(values))
	for i, v := range values {
		d := v - center
		if d < 0 {
			d = -d
		}
		devs[i] = d
	}
	return median(devs)
}

func mainland(ip string) bool {
	parsed := net.ParseIP(ip).To4()
	if parsed == nil {
		return false
	}
	v := uint32(parsed[0])<<24 | uint32(parsed[1])<<16 | uint32(parsed[2])<<8 | uint32(parsed[3])
	lo, hi := 0, len(cnRanges)
	for lo < hi {
		mid := (lo + hi) / 2
		if cnRanges[mid][1] < v {
			lo = mid + 1
			continue
		}
		hi = mid
	}
	return lo < len(cnRanges) && v >= cnRanges[lo][0] && v <= cnRanges[lo][1]
}

func collectOutput(client *ssh.Client, command string, timeout time.Duration, cap int) (string, error) {
	session, err := client.NewSession()
	if err != nil {
		return "", err
	}
	defer func() { _ = session.Close() }()
	buf := &cappedWriter{cap: cap}
	session.Stdout = buf
	session.Stderr = io.Discard
	done := make(chan error, 1)
	go func() { done <- session.Run(command) }()
	select {
	case err := <-done:
		return buf.String(), err
	case <-time.After(timeout):
		_ = session.Signal(ssh.SIGKILL)
		_ = session.Close()
		return buf.String(), errors.New("测速超时")
	}
}
