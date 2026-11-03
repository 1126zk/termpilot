package sshx

import "testing"

func TestNetRateSkipsVirtualIfaces(t *testing.T) {
	before := `1000.00 3900.00
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 5000 10 0 0 0 0 0 0 5000 10 0 0 0 0 0 0
  eth0: 100000 50 0 0 0 0 0 0 20000 30 0 0 0 0 0 0
docker0: 900000 10 0 0 0 0 0 0 900000 10 0 0 0 0 0 0
vethab12: 900000 10 0 0 0 0 0 0 900000 10 0 0 0 0 0 0
`
	after := `1002.00 3901.00
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 99999 10 0 0 0 0 0 0 99999 10 0 0 0 0 0 0
  eth0: 300000 50 0 0 0 0 0 0 30000 30 0 0 0 0 0 0
docker0: 9900000 10 0 0 0 0 0 0 9900000 10 0 0 0 0 0 0
vethab12: 9900000 10 0 0 0 0 0 0 9900000 10 0 0 0 0 0 0
`
	rx, tx := netRate(before, after)
	// 只算 eth0：两秒收 200000、发 10000
	if rx != 100000 || tx != 5000 {
		t.Fatalf("rx=%v tx=%v, want 100000 5000", rx, tx)
	}
}

func TestNetRateCounterWrapAndMissing(t *testing.T) {
	before := "10.00 0\n  eth0: 500 0 0 0 0 0 0 0 500 0 0 0 0 0 0 0\n"
	// eth0 计数变小（回绕或网卡重建）不算；eth1 第一次才出现也不算
	after := "11.00 0\n  eth0: 100 0 0 0 0 0 0 0 100 0 0 0 0 0 0 0\n  eth1: 800 0 0 0 0 0 0 0 800 0 0 0 0 0 0 0\n"
	if rx, tx := netRate(before, after); rx != 0 || tx != 0 {
		t.Fatalf("rx=%v tx=%v, want 0 0", rx, tx)
	}
	// 某次没采到（段为空）时给 0，不报错
	if rx, tx := netRate("", after); rx != 0 || tx != 0 {
		t.Fatalf("empty: rx=%v tx=%v", rx, tx)
	}
}

func TestParsePortsSs(t *testing.T) {
	text := `Netid State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process
udp   UNCONN 0      0      127.0.0.53%lo:53   0.0.0.0:*        users:(("systemd-resolve",pid=123,fd=12))
tcp   LISTEN 0      128    0.0.0.0:22         0.0.0.0:*        users:(("sshd",pid=1234,fd=3))
tcp   LISTEN 0      128    [::]:22             [::]:*           users:(("sshd",pid=1234,fd=4))
tcp   LISTEN 0      128    0.0.0.0:8080       0.0.0.0:*
`
	ports := parsePorts(text)
	if len(ports) != 4 {
		t.Fatalf("len=%d, want 4: %+v", len(ports), ports)
	}
	// 按端口升序：22 的两条（IPv4 在前）、53、8080
	if ports[0].Port != 22 || ports[0].Addr != "0.0.0.0" || ports[0].Pid != 1234 || ports[0].Name != "sshd" {
		t.Fatalf("ports[0]=%+v", ports[0])
	}
	if ports[1].Port != 22 || ports[1].Addr != "[::]" || ports[1].Proto != "tcp" {
		t.Fatalf("ports[1]=%+v", ports[1])
	}
	if ports[2].Port != 53 || ports[2].Proto != "udp" || ports[2].Addr != "127.0.0.53" || ports[2].Pid != 123 || ports[2].Name != "systemd-resolve" {
		t.Fatalf("ports[2]=%+v", ports[2])
	}
	// 没权限的一行：端口留住，PID/程序名为空
	if ports[3].Port != 8080 || ports[3].Pid != 0 || ports[3].Name != "" {
		t.Fatalf("ports[3]=%+v", ports[3])
	}
}

func TestParsePortsNetstat(t *testing.T) {
	text := `Active Internet connections (only servers)
Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name
tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN      1234/sshd
udp        0      0 127.0.0.53:53           0.0.0.0:*                           123/systemd-resolve
tcp        0      0 0.0.0.0:8080            0.0.0.0:*               LISTEN      -
`
	ports := parsePorts(text)
	if len(ports) != 3 {
		t.Fatalf("len=%d, want 3: %+v", len(ports), ports)
	}
	if ports[0].Port != 22 || ports[0].Pid != 1234 || ports[0].Name != "sshd" {
		t.Fatalf("ports[0]=%+v", ports[0])
	}
	if ports[1].Port != 53 || ports[1].Pid != 123 || ports[1].Name != "systemd-resolve" {
		t.Fatalf("ports[1]=%+v", ports[1])
	}
	if ports[2].Port != 8080 || ports[2].Pid != 0 || ports[2].Name != "" {
		t.Fatalf("ports[2]=%+v", ports[2])
	}
	if got := parsePorts(""); len(got) != 0 {
		t.Fatalf("empty: %+v", got)
	}
}

func TestParsePortCmds(t *testing.T) {
	text := `#PID:1234#
/usr/sbin/sshd -D
/usr/sbin/sshd
#PID:123#
/lib/systemd/systemd-resolved
/lib/systemd/systemd-resolved
#PID:999#


`
	cmds := parsePortCmds(text)
	if cmds[1234].cmd != "/usr/sbin/sshd -D" || cmds[1234].exe != "/usr/sbin/sshd" {
		t.Fatalf("1234=%+v", cmds[1234])
	}
	if cmds[123].cmd != "/lib/systemd/systemd-resolved" || cmds[123].exe != "/lib/systemd/systemd-resolved" {
		t.Fatalf("123=%+v", cmds[123])
	}
	// 读不到的两行留空，不串到下一个 PID
	if cmds[999].cmd != "" || cmds[999].exe != "" {
		t.Fatalf("999=%+v", cmds[999])
	}
}
