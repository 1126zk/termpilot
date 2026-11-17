package sshx

import (
	"errors"
	"io"
	"net"
	"regexp"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

type NetworkReport struct {
	LatencyMs      float64 `json:"latencyMs"`
	LatencyMinMs   float64 `json:"latencyMinMs"`
	LatencyMaxMs   float64 `json:"latencyMaxMs"`
	BaseLatencyMs  float64 `json:"baseLatencyMs"`
	JitterMs       float64 `json:"jitterMs"`
	SampleSegments uint64  `json:"sampleSegments"`
	SampleRetrans  uint64  `json:"sampleRetrans"`
	TotalSegments  uint64  `json:"totalSegments"`
	TotalRetrans   uint64  `json:"totalRetrans"`
	Samples        int     `json:"samples"`
	DurationMs     int64   `json:"durationMs"`
	At             int64   `json:"at"`
	From           string  `json:"from"`
	To             string  `json:"to"`
}

type NetworkTick struct {
	Ratio  float64        `json:"ratio"`
	Report *NetworkReport `json:"report"`
}

const (
	networkSampleCount    = 10
	networkSampleInterval = time.Second
)

func (s *ExecService) MeasureNetwork(sessionID string, on func(NetworkTick)) (*NetworkReport, error) {
	client, release, err := s.networkClient(sessionID)
	if err != nil {
		return nil, err
	}
	defer release()

	key, from, to, err := readSSHConnection(client)
	if err != nil {
		return nil, err
	}
	started := time.Now()
	samples := make([]tcpSnap, 0, networkSampleCount)
	for i := 0; i < networkSampleCount; i++ {
		snap, err := readTCPSnapshot(client, key)
		if err != nil {
			return nil, err
		}
		samples = append(samples, snap)
		report, err := makeNetworkReport(samples, from, to, started)
		if err != nil {
			return nil, err
		}
		if on != nil {
			on(NetworkTick{Ratio: float64(len(samples)) / networkSampleCount * 0.9, Report: report})
		}
		if i+1 < networkSampleCount {
			time.Sleep(networkSampleInterval)
		}
	}
	return makeNetworkReport(samples, from, to, started)
}

func readSSHConnection(client *ssh.Client) (key, from, to string, err error) {
	text, err := collectOutput(client, `printf '%s\n' "$SSH_CONNECTION"`, 5*time.Second, 1024)
	if err != nil {
		return "", "", "", err
	}
	return sshConnectionKey(text)
}

func sshConnectionKey(text string) (key, from, to string, err error) {
	fields := strings.Fields(text)
	if len(fields) != 4 {
		return "", "", "", errors.New("没有识别到当前 SSH 连接")
	}
	peer := net.JoinHostPort(fields[0], fields[1])
	local := net.JoinHostPort(fields[2], fields[3])
	return local + " " + peer, fields[0], fields[2], nil
}

func makeNetworkReport(samples []tcpSnap, from, to string, started time.Time) (*NetworkReport, error) {
	if len(samples) == 0 {
		return nil, errors.New("没有采到网络状态")
	}
	first := samples[0]
	last := samples[len(samples)-1]
	if last.segments < first.segments || last.retrans < first.retrans {
		return nil, errors.New("SSH 连接统计已重置，请重新检测")
	}
	report := &NetworkReport{
		LatencyMs:      last.rtt,
		LatencyMinMs:   -1,
		LatencyMaxMs:   -1,
		BaseLatencyMs:  last.minRTT,
		JitterMs:       last.jitter,
		SampleSegments: last.segments - first.segments,
		SampleRetrans:  last.retrans - first.retrans,
		TotalSegments:  last.segments,
		TotalRetrans:   last.retrans,
		Samples:        len(samples),
		DurationMs:     time.Since(started).Milliseconds(),
		At:             time.Now().UnixMilli(),
		From:           from,
		To:             to,
	}
	for _, sample := range samples {
		if sample.rtt < 0 {
			continue
		}
		if report.LatencyMinMs < 0 || sample.rtt < report.LatencyMinMs {
			report.LatencyMinMs = sample.rtt
		}
		if sample.rtt > report.LatencyMaxMs {
			report.LatencyMaxMs = sample.rtt
		}
	}
	return report, nil
}

func (s *ExecService) networkClient(sessionID string) (*ssh.Client, func(), error) {
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

func readTCPSnapshot(client *ssh.Client, key string) (tcpSnap, error) {
	snaps := readTCP(client)
	if len(snaps) == 0 {
		return tcpSnap{}, errors.New("服务器没有返回 TCP 连接状态")
	}
	for _, snap := range snaps {
		if snap.id == key {
			return snap, nil
		}
	}
	return tcpSnap{}, errors.New("没有找到当前 SSH 连接的 TCP 状态")
}

type tcpSnap struct {
	id       string
	segments uint64
	retrans  uint64
	rtt      float64
	jitter   float64
	minRTT   float64
}

func readTCP(client *ssh.Client) []tcpSnap {
	for _, cmd := range []string{
		"ss -H -t -i -n state established",
		"/usr/sbin/ss -H -t -i -n state established",
		"/bin/ss -H -t -i -n state established",
	} {
		text, err := collectOutput(client, cmd, 5*time.Second, 64*1024)
		if err != nil {
			continue
		}
		if snaps := parseSS(text); len(snaps) > 0 {
			return snaps
		}
	}
	return nil
}

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
	return canonicalSocketAddress(ends[len(ends)-2]) + " " + canonicalSocketAddress(ends[len(ends)-1])
}

func canonicalSocketAddress(address string) string {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return address
	}
	return net.JoinHostPort(host, port)
}

var (
	ssRTT        = regexp.MustCompile(`rtt:([0-9.]+)/([0-9.]+)`)
	ssMinRTT     = regexp.MustCompile(`minrtt:([0-9.]+)`)
	ssSegments   = regexp.MustCompile(`data_segs_out:(\d+)`)
	ssRetransSeg = regexp.MustCompile(`retrans:\d+/(\d+)`)
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
				cur = &tcpSnap{id: id, rtt: -1, jitter: -1, minRTT: -1}
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
		if m := ssMinRTT.FindStringSubmatch(line); m != nil {
			cur.minRTT, _ = strconv.ParseFloat(m[1], 64)
		}
		if m := ssSegments.FindStringSubmatch(line); m != nil {
			cur.segments, _ = strconv.ParseUint(m[1], 10, 64)
		}
		if m := ssRetransSeg.FindStringSubmatch(line); m != nil {
			cur.retrans, _ = strconv.ParseUint(m[1], 10, 64)
		}
	}
	flush()
	return snaps
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
		return buf.String(), errors.New("读取网络状态超时")
	}
}
