package sshx

import "testing"

func TestMainland(t *testing.T) {
	if !mainland("223.5.5.5") || !mainland("114.114.114.114") {
		t.Fatal("大陆地址应判为国内")
	}
	if mainland("8.8.8.8") || mainland("38.127.133.5") {
		t.Fatal("国外和香港地址不应判为国内")
	}
	if mainland("") || mainland("10.0.0.1") {
		t.Fatal("空地址和内网不应判为国内")
	}
}

func TestParseSSAndMatch(t *testing.T) {
	text := "Recv-Q Send-Q Local Address:Port Peer Address:Port\n" +
		"0      0      10.222.65.221:ssh    100.64.0.3:11287\n" +
		"\t cubic rtt:29.478/21.657 bytes_sent:338001 bytes_retrans:82256 minrtt:1.284\n" +
		"0      0      10.0.0.8:443    1.2.3.4:9999\n" +
		"\t cubic rtt:5/1 bytes_sent:100 bytes_retrans:0\n"
	snaps := parseSS(text)
	if len(snaps) != 2 {
		t.Fatalf("snaps=%d", len(snaps))
	}
	if snaps[0].rtt != 29.478 || snaps[0].jitter != 21.657 || snaps[0].sent != 338001 || snaps[0].retrans != 82256 {
		t.Fatalf("ssh snap=%+v", snaps[0])
	}
	after := "0      48000      10.222.65.221:ssh    100.64.0.3:11287\n" +
		"\t cubic rtt:16.5/4 bytes_sent:438001 bytes_retrans:92256\n" +
		"0      0      10.0.0.8:443    1.2.3.4:9999\n" +
		"\t cubic rtt:5/1 bytes_sent:100 bytes_retrans:0\n"
	link := matchTCP(snaps, parseSS(after))
	if link == nil {
		t.Fatal("没有对上连接")
	}
	if link.rtt != 16.5 || link.jitter != 4 {
		t.Fatalf("rtt=%v jitter=%v", link.rtt, link.jitter)
	}
	// 发出 100000，重传 10000 → 10%
	if link.loss < 9.9 || link.loss > 10.1 {
		t.Fatalf("loss=%v", link.loss)
	}
}

func TestParseEgress(t *testing.T) {
	text := "#P#\n0.040\nfail\n0.030\n0.050\n#D#\n8388608 2 104.16.249.249\n#U#\n4194304 1\n#END#\n"
	report, err := parseEgress(text)
	if err != nil {
		t.Fatal(err)
	}
	if report.DownBps != 8388608/2 || report.UpBps != 4194304 || report.To != "104.16.249.249" {
		t.Fatalf("rate down=%v up=%v to=%s", report.DownBps, report.UpBps, report.To)
	}
	if report.LossPct != 25 {
		t.Fatalf("loss=%v", report.LossPct)
	}
	// 丢掉第一条 0.040，剩下 0.030 和 0.050，中位数 0.040 秒
	if report.LatencyMs < 39 || report.LatencyMs > 41 {
		t.Fatalf("latency=%v", report.LatencyMs)
	}
}

func TestParseEgressNoData(t *testing.T) {
	if _, err := parseEgress("#P#\nfail\n#D#\n0 0\n#END#\n"); err == nil {
		t.Fatal("没有数据时应失败")
	}
}
