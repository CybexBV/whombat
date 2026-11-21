package proto

import "math"

// Series names stored by the hub. They match the keys of
// GET /servers/{id}/metrics (docs/handoff/docs/API.md 2.4).
const (
	SeriesCPU         = "cpu_pct"
	SeriesMem         = "mem_pct"
	SeriesGuestDiskIO = "guest_disk_io_mbs" // sum over running guests, MB/s (1e6 bytes)
	SeriesGuestNet    = "guest_net_mbps"    // sum over running guests, Mb/s (1e6 bits)

	SeriesLoad1     = "load1"
	SeriesSwap      = "swap_pct"
	SeriesNetRx     = "net_rx_mbps" // host interfaces (bonds once, not their members), Mb/s
	SeriesNetTx     = "net_tx_mbps"
	SeriesDiskRead  = "disk_read_mbs" // physical disks, MB/s
	SeriesDiskWrite = "disk_write_mbs"
	SeriesTempMax   = "temp_max_c" // the hottest sensor of the host
)

// VolumeSeries is the used-space series of a volume ("vol_pct:fs:/srv",
// "vol_pct:pool:tank", "vol_pct:storage:local"): the history behind the
// "full in N days" forecast. The entity naming matches the space alerts.
func VolumeSeries(entity string) string { return "vol_pct:" + entity }

// MaxVolumeSeries bounds the volume series of one report.
const MaxVolumeSeries = 32

// SensorSeries returns the series name for a sensor group, e.g.
// "temp_cpu_package_c".
func SensorSeries(sensorID string) string { return "temp_" + sensorID + "_c" }

// Series extracts the stored time series values from a report. The agent
// calls it for every report and buffers the result while offline; the hub
// stores exactly these values.
func (r *Report) Series() map[string]float64 {
	v := make(map[string]float64, 12)
	v[SeriesCPU] = round1(r.CPU.UsagePct)
	if r.Memory.TotalBytes > 0 {
		v[SeriesMem] = round1(float64(r.Memory.UsedBytes) / float64(r.Memory.TotalBytes) * 100)
	}
	for _, s := range r.Sensors {
		v[SensorSeries(s.ID)] = round1(s.TempC)
	}
	var io, net float64
	var haveGuests bool
	for _, g := range r.AllGuests() {
		if g.Kind != "vm" && g.Kind != "container" {
			continue
		}
		haveGuests = true
		if g.DiskReadBps != nil {
			io += *g.DiskReadBps
		}
		if g.DiskWriteBps != nil {
			io += *g.DiskWriteBps
		}
		if g.NetRxBps != nil {
			net += *g.NetRxBps
		}
		if g.NetTxBps != nil {
			net += *g.NetTxBps
		}
	}
	if haveGuests {
		v[SeriesGuestDiskIO] = round1(io / 1e6)
		v[SeriesGuestNet] = round1(net * 8 / 1e6)
	}

	v[SeriesLoad1] = math.Round(r.CPU.Load[0]*100) / 100
	if r.Memory.SwapTotalBytes > 0 {
		v[SeriesSwap] = round1(float64(r.Memory.SwapUsedBytes) / float64(r.Memory.SwapTotalBytes) * 100)
	}
	if len(r.Net) > 0 {
		var rx, tx float64
		for _, n := range r.Net {
			if n.Master != "" && n.Kind != "vlan" { // bond members count through their bond
				continue
			}
			if n.Kind == "vlan" { // a VLAN's traffic is part of its parent's
				continue
			}
			rx += n.RxBps
			tx += n.TxBps
		}
		v[SeriesNetRx] = round1(rx * 8 / 1e6)
		v[SeriesNetTx] = round1(tx * 8 / 1e6)
	}
	var rd, wr float64
	var haveIO bool
	for _, d := range r.Disks {
		if d.IO != nil {
			haveIO = true
			rd += d.IO.ReadBps
			wr += d.IO.WriteBps
		}
	}
	if haveIO {
		v[SeriesDiskRead] = round1(rd / 1e6)
		v[SeriesDiskWrite] = round1(wr / 1e6)
	}
	if len(r.Sensors) > 0 {
		hot := math.Inf(-1)
		for _, s := range r.Sensors {
			if s.TempC > hot {
				hot = s.TempC
			}
		}
		v[SeriesTempMax] = round1(hot)
	}
	n := 0
	for _, vol := range r.Volumes() {
		if n >= MaxVolumeSeries {
			break
		}
		v[VolumeSeries(vol.Entity)] = round1(float64(vol.Used) / float64(vol.Total) * 100)
		n++
	}
	return v
}

// Volume is a volume watched for space: a filesystem ("fs:/srv", ZFS
// datasets excluded since their pool covers them), a pool ("pool:tank") or
// an active Proxmox storage ("storage:local"). Entities match the
// disk.space_high alerts.
type Volume struct {
	Entity, Label string
	Used, Total   uint64
}

// Volumes lists the report's volumes of known size.
func (r *Report) Volumes() []Volume {
	var out []Volume
	add := func(entity, label string, used, total uint64) {
		if total > 0 {
			out = append(out, Volume{Entity: entity, Label: label, Used: used, Total: total})
		}
	}
	seen := map[string]bool{}
	for _, f := range r.Filesystems {
		if f.FSType == "zfs" || seen[f.Mount] || f.Mount == "" {
			continue
		}
		seen[f.Mount] = true
		add("fs:"+f.Mount, f.Mount, f.UsedBytes, f.SizeBytes)
	}
	for _, p := range r.Pools {
		add("pool:"+p.Name, "Pool "+p.Name, p.AllocBytes, p.SizeBytes)
	}
	if r.PVE != nil {
		for _, s := range r.PVE.Storages {
			if s.Active {
				add("storage:"+s.ID, "Storage "+s.ID, s.UsedBytes, s.TotalBytes)
			}
		}
	}
	return out
}

// AllGuests returns the guests of every platform with their platform name.
func (r *Report) AllGuests() []PlatformGuest {
	var out []PlatformGuest
	add := func(platform string, gs []Guest) {
		for i := range gs {
			out = append(out, PlatformGuest{Platform: platform, Guest: &gs[i]})
		}
	}
	if r.Docker != nil {
		add(PlatformDocker, r.Docker.Guests)
	}
	if r.Incus != nil {
		add(PlatformIncus, r.Incus.Guests)
	}
	if r.Libvirt != nil {
		add(PlatformLibvirt, r.Libvirt.Guests)
	}
	if r.PVE != nil {
		add(PlatformPVE, r.PVE.Guests)
	}
	return out
}

// PlatformGuest is a guest together with its platform.
type PlatformGuest struct {
	Platform string
	*Guest
}

// FindGuest returns the guest with the given platform and id, or nil.
func (r *Report) FindGuest(platform, id string) *Guest {
	for _, g := range r.AllGuests() {
		if g.Platform == platform && g.ID == id {
			return g.Guest
		}
	}
	return nil
}

func round1(f float64) float64 { return math.Round(f*10) / 10 }
