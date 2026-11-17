package sshx

import (
	"testing"
	"time"
)

func TestSSHConnectionKey(t *testing.T) {
	key, from, to, err := sshConnectionKey("100.64.0.3 58241 10.222.65.221 22\n")
	if err != nil {
		t.Fatal(err)
	}
	if key != "10.222.65.221:22 100.64.0.3:58241" || from != "100.64.0.3" || to != "10.222.65.221" {
		t.Fatalf("key=%q from=%q to=%q", key, from, to)
	}

	key, _, _, err = sshConnectionKey("2001:db8::1 58241 2001:db8::2 22")
	if err != nil {
		t.Fatal(err)
	}
	if key != "[2001:db8::2]:22 [2001:db8::1]:58241" {
		t.Fatalf("IPv6 key=%q", key)
	}
	if _, _, _, err := sshConnectionKey(""); err == nil {
		t.Fatal("空 SSH_CONNECTION 应报错")
	}
}

func TestParseSSAndNetworkReport(t *testing.T) {
	beforeText := "ESTAB 0 0 10.222.65.221:22 100.64.0.3:58241\n" +
		"\t cubic rtt:360.986/26.188 minrtt:336.613 bytes_sent:465273 bytes_retrans:103136 data_segs_out:735 retrans:0/155\n" +
		"ESTAB 0 0 10.0.0.8:443 1.2.3.4:9999\n" +
		"\t cubic rtt:5/1 minrtt:4 data_segs_out:100000 retrans:1/1\n"
	afterText := "ESTAB 0 0 10.222.65.221:22 100.64.0.3:58241\n" +
		"\t cubic rtt:447.12/30.5 minrtt:336.613 bytes_sent:483116 bytes_retrans:110000 data_segs_out:815 retrans:0/174\n" +
		"ESTAB 0 0 10.0.0.8:443 1.2.3.4:9999\n" +
		"\t cubic rtt:6/1.5 minrtt:4 data_segs_out:200000 retrans:1/2\n"
	key := "10.222.65.221:22 100.64.0.3:58241"
	before := snapshotForTest(t, parseSS(beforeText), key)
	after := snapshotForTest(t, parseSS(afterText), key)
	if before.rtt != 360.986 || before.jitter != 26.188 || before.minRTT != 336.613 || before.segments != 735 || before.retrans != 155 {
		t.Fatalf("before=%+v", before)
	}
	if after.segments != 815 || after.retrans != 174 {
		t.Fatalf("after=%+v", after)
	}
	middle := before
	middle.rtt = 454.2
	middle.segments = 780
	middle.retrans = 160
	report, err := makeNetworkReport([]tcpSnap{before, middle, after}, "100.64.0.3", "10.222.65.221", time.Now().Add(-10*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if report.LatencyMs != 447.12 || report.LatencyMinMs != 360.986 || report.LatencyMaxMs != 454.2 || report.BaseLatencyMs != 336.613 || report.JitterMs != 30.5 {
		t.Fatalf("latency report=%+v", report)
	}
	if report.SampleSegments != 80 || report.SampleRetrans != 19 || report.TotalSegments != 815 || report.TotalRetrans != 174 {
		t.Fatalf("retrans report=%+v", report)
	}
	if report.Samples != 3 || report.DurationMs < 10000 || report.At == 0 {
		t.Fatalf("sample report=%+v", report)
	}
}

func TestNetworkReportCounters(t *testing.T) {
	snap := tcpSnap{id: "one", rtt: 20, jitter: 2, minRTT: 18, segments: 10, retrans: 2}
	report, err := makeNetworkReport([]tcpSnap{snap}, "", "", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if report.SampleSegments != 0 || report.SampleRetrans != 0 {
		t.Fatalf("首次采样不应产生增量：%+v", report)
	}
	reset := snap
	reset.segments = 9
	if _, err := makeNetworkReport([]tcpSnap{snap, reset}, "", "", time.Now()); err == nil {
		t.Fatal("计数倒退应报错")
	}
}

func snapshotForTest(t *testing.T, snaps []tcpSnap, key string) tcpSnap {
	t.Helper()
	for _, snap := range snaps {
		if snap.id == key {
			return snap
		}
	}
	t.Fatalf("没有找到 %q：%+v", key, snaps)
	return tcpSnap{}
}
