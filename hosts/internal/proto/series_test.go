package proto

import "testing"

func TestSeriesAndVolumes(t *testing.T) {
	r := &Report{
		CPU:     CPU{UsagePct: 12.34, Load: [3]float64{1.234, 0, 0}},
		Memory:  Memory{TotalBytes: 1000, UsedBytes: 250, SwapTotalBytes: 100, SwapUsedBytes: 50},
		Sensors: []Sensor{{ID: SensorCPU, TempC: 50.04}, {ID: SensorNVMe, TempC: 61.26}},
		Disks: []Disk{
			{Device: "sda", IO: &DiskIO{ReadBps: 2e6, WriteBps: 1e6}},
			{Device: "sdb", IO: &DiskIO{ReadBps: 1e6}},
		},
		Net: []NetIface{
			{Name: "bond0", Kind: "bond", RxBps: 1e6, TxBps: 2e6},
			{Name: "eno1", Kind: "ethernet", Master: "bond0", RxBps: 9e6},
			{Name: "bond0.10", Kind: "vlan", RxBps: 5e6},
		},
		Filesystems: []Filesystem{
			{Mount: "/", FSType: "ext4", SizeBytes: 100, UsedBytes: 50},
			{Mount: "/", FSType: "ext4", SizeBytes: 100, UsedBytes: 50}, // bind mount listed twice
			{Mount: "/tank/data", FSType: "zfs", SizeBytes: 100, UsedBytes: 99},
		},
		Pools: []Pool{{Name: "tank", SizeBytes: 200, AllocBytes: 50}},
		PVE:   &PVE{Storages: []PVEStorage{{ID: "local", Active: true, UsedBytes: 1, TotalBytes: 4}, {ID: "nfs", Active: false, TotalBytes: 4}}},
	}
	v := r.Series()
	want := map[string]float64{
		SeriesCPU: 12.3, SeriesMem: 25, SeriesLoad1: 1.23, SeriesSwap: 50,
		SensorSeries(SensorCPU): 50, SensorSeries(SensorNVMe): 61.3, SeriesTempMax: 61.3,
		SeriesDiskRead: 3, SeriesDiskWrite: 1,
		SeriesNetRx: 8, SeriesNetTx: 16, // the bond only: members and VLANs are part of it
		VolumeSeries("fs:/"): 50, VolumeSeries("pool:tank"): 25, VolumeSeries("storage:local"): 25,
	}
	for k, w := range want {
		if got, ok := v[k]; !ok || got != w {
			t.Errorf("%s = %v (present %v), want %v", k, got, ok, w)
		}
	}
	if _, ok := v[VolumeSeries("fs:/tank/data")]; ok {
		t.Error("ZFS datasets are covered by their pool")
	}
	if _, ok := v[VolumeSeries("storage:nfs")]; ok {
		t.Error("inactive storage listed")
	}
	if n := len(r.Volumes()); n != 3 {
		t.Errorf("volumes: %d", n)
	}
}

func TestSeriesWithoutNewData(t *testing.T) {
	// An older agent: no disk I/O or network data means no such series
	// (absent, not zero).
	v := (&Report{CPU: CPU{UsagePct: 1}}).Series()
	for _, k := range []string{SeriesNetRx, SeriesDiskRead, SeriesTempMax, SeriesSwap} {
		if _, ok := v[k]; ok {
			t.Errorf("%s present without data", k)
		}
	}
}
