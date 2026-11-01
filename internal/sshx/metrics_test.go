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
