package proto

import "time"

// Host health data added in protocol version 1 (all optional: an older agent
// leaves them empty; an older hub ignores them). See docs/AGENT-PROTOCOL.md
// "Host health".

// More sensor groups (each reports its hottest member, like the others).
const (
	SensorNIC = "nic_hottest" // network adapters (PHY / MAC temperature)
	SensorGPU = "gpu_hottest"
)

// Guest state in addition to running / stopped / unhealthy: a paused or
// frozen VM or container (libvirt paused / pmsuspended, Incus frozen,
// Docker paused, PVE paused).
const StatePaused = "paused"

// Pressure is Linux pressure stall information (/proc/pressure/*), the
// avg10 values in percent of wall time.
type Pressure struct {
	CPUSome    float64 `cbor:"cpu"`
	MemorySome float64 `cbor:"mem"`
	MemoryFull float64 `cbor:"mem_full"`
	IOSome     float64 `cbor:"io"`
	IOFull     float64 `cbor:"io_full"`
}

// SystemInfo is operating-system health: packages, services, time.
type SystemInfo struct {
	// Packages. UpdatesPending is nil when the agent cannot tell (no known
	// package manager, the check failed or has not run yet). The check runs
	// every 6 hours from the package manager's cache (the agent never
	// refreshes package lists itself, except on Unraid's plugin list).
	PackageManager   string    `cbor:"pm,omitempty"` // apt | dnf | yum | zypper | apk | pacman | unraid
	UpdatesPending   *int      `cbor:"updates,omitempty"`
	SecurityUpdates  *int      `cbor:"sec_updates,omitempty"`
	UpdatesCheckedAt time.Time `cbor:"updates_at,omitempty"`
	UpdatesError     string    `cbor:"updates_err,omitempty"`
	// RebootRequired: /var/run/reboot-required (Debian family),
	// needs-restarting -r (Fedora family), or a newer installed kernel than
	// the running one. RebootReason says which.
	RebootRequired bool   `cbor:"reboot,omitempty"`
	RebootReason   string `cbor:"reboot_reason,omitempty"` // "Kernel 6.12.111 is installed, 6.12.107 runs"
	// PackageTask: the package task running now; PackageLast: the last
	// one that ended (kept across agent restarts; packages.go).
	PackageTask *PackageTask `cbor:"pkg_task,omitempty"`
	PackageLast *PackageLast `cbor:"pkg_last,omitempty"`

	// Services. FailedUnits lists at most 32 names; FailedCount is the total.
	InitSystem  string   `cbor:"init,omitempty"` // systemd | openrc | sysv | unraid
	FailedUnits []string `cbor:"failed,omitempty"`
	FailedCount int      `cbor:"failed_n,omitempty"`

	// Time synchronisation (adjtimex; chrony / timesyncd / ntpd).
	TimeSynced   *bool    `cbor:"ntp,omitempty"`
	TimeOffsetMs *float64 `cbor:"ntp_offset,omitempty"`
	TimeSource   string   `cbor:"ntp_src,omitempty"` // chrony | timesyncd | ntpd | ""

	// Kernel counters.
	OOMKills     uint64 `cbor:"oom,omitempty"`   // cumulative since boot (/proc/vmstat oom_kill)
	ProcessCount int    `cbor:"procs,omitempty"` // tasks
	Arch         string `cbor:"arch,omitempty"`  // runtime.GOARCH of the agent: amd64 | arm64

	// OOMLimitKills (LM-04): of OOMKills, the kills the kernel made because
	// a cgroup reached its own memory limit (a container's, a VM's, a
	// service's: constraint CONSTRAINT_MEMCG), not because the machine ran
	// out. The agent counts them in the kernel log since boot, as far as
	// the log reaches; a kill it did not see there counts as the
	// machine's. Never more than OOMKills. nil: the agent cannot read the
	// kernel log (or is older), so every kill counts as the machine's.
	OOMLimitKills *uint64 `cbor:"oom_limit,omitempty"`
	// OOMLimited are those kills of the last hour, newest last, at most
	// OOMLimitedMax.
	OOMLimited []OOMKill `cbor:"oom_limited,omitempty"`
}

// OOMLimitedMax bounds SystemInfo.OOMLimited.
const OOMLimitedMax = 16

// OOMKill is a process the kernel killed because a cgroup reached its own
// memory limit (LM-04).
type OOMKill struct {
	At      time.Time `cbor:"at"`
	Process string    `cbor:"proc,omitempty"` // the killed process's name (comm)
	// Cgroup is the cgroup whose limit was reached (the kernel's
	// oom_memcg, with systemd's \x escapes), "" when the kernel left its
	// summary line out (rate-limited).
	Cgroup string `cbor:"cgroup,omitempty"`
	// Platform and GuestID name the guest that cgroup belongs to (a guest
	// of this report, Guest.ID), when the agent could tell.
	Platform string `cbor:"platform,omitempty"`
	GuestID  string `cbor:"guest,omitempty"`
}

// NetIface is a host network interface: physical adapters, bonds, VLANs on
// them and Wi-Fi. Bridges, veth, tap and tunnel devices are left out (guest
// traffic is reported per guest).
type NetIface struct {
	Name      string   `cbor:"name"`
	Kind      string   `cbor:"kind"` // ethernet | bond | vlan | wireless
	Up        bool     `cbor:"up"`   // operstate up
	Carrier   bool     `cbor:"carrier"`
	SpeedMbps int      `cbor:"speed,omitempty"` // 0 = unknown
	MTU       int      `cbor:"mtu,omitempty"`
	MAC       string   `cbor:"mac,omitempty"`
	Addresses []string `cbor:"addrs,omitempty"`   // IPv4 and global IPv6, CIDR
	Master    string   `cbor:"master,omitempty"`  // bond or bridge this interface belongs to
	Members   []string `cbor:"members,omitempty"` // bond members
	// Throughput over the last interval and cumulative error counters.
	RxBps    float64 `cbor:"rx"`
	TxBps    float64 `cbor:"tx"`
	RxErrors uint64  `cbor:"rx_err"`
	TxErrors uint64  `cbor:"tx_err"`
	RxDrops  uint64  `cbor:"rx_drop"`
	TxDrops  uint64  `cbor:"tx_drop"`
}

// DiskIO is a disk's throughput over the last interval (/proc/diskstats).
type DiskIO struct {
	ReadBps   float64 `cbor:"rd"`
	WriteBps  float64 `cbor:"wr"`
	ReadIOPS  float64 `cbor:"riops"`
	WriteIOPS float64 `cbor:"wiops"`
	UtilPct   float64 `cbor:"util"`  // time busy
	AwaitMs   float64 `cbor:"await"` // average request latency
}

// SelfTest is the most recent SMART self-test.
type SelfTest struct {
	Type         string `cbor:"type"`   // short | long | conveyance | offline
	Result       string `cbor:"result"` // passed | failed | aborted | interrupted | running
	PowerOnHours uint64 `cbor:"poh"`    // when it ran (drive power-on hours)
}

// RAIDArray is a Linux md array or the Unraid array.
type RAIDArray struct {
	Name      string   `cbor:"name"`  // md127 | unraid
	Level     string   `cbor:"level"` // raid1 | raid5 | ... | unraid
	State     string   `cbor:"state"` // clean | degraded | resyncing | recovering | checking | failed | inactive | stopped
	Devices   int      `cbor:"devs"`  // members the array should have
	Active    int      `cbor:"active"`
	Members   []string `cbor:"members,omitempty"`
	Failed    []string `cbor:"failed,omitempty"` // faulty or missing members
	SyncPct   *float64 `cbor:"sync,omitempty"`   // resync / recovery / check progress
	SizeBytes uint64   `cbor:"size,omitempty"`
	// Unraid: parity check result and errors of the last check.
	LastCheck       time.Time `cbor:"last_check,omitempty"`
	LastCheckErrors *uint64   `cbor:"check_errors,omitempty"`
}

// UPS is a UPS seen through NUT (upsc) or apcupsd (apcaccess).
type UPS struct {
	Name      string   `cbor:"name"`
	Source    string   `cbor:"src"` // nut | apcupsd
	Model     string   `cbor:"model,omitempty"`
	Status    string   `cbor:"status"`        // online | on_battery | low_battery | offline | unknown
	StatusRaw string   `cbor:"raw,omitempty"` // "OL CHRG", "ONBATT"
	ChargePct *float64 `cbor:"charge,omitempty"`
	RuntimeS  *int     `cbor:"runtime,omitempty"`
	LoadPct   *float64 `cbor:"load,omitempty"`
}

// GPU is a graphics or compute adapter (nvidia-smi, amdgpu / i915 sysfs).
type GPU struct {
	Index         int      `cbor:"i"`
	Name          string   `cbor:"name"`
	Vendor        string   `cbor:"vendor"` // nvidia | amd | intel
	UtilPct       *float64 `cbor:"util,omitempty"`
	MemUsedBytes  *uint64  `cbor:"mem_used,omitempty"`
	MemTotalBytes *uint64  `cbor:"mem_total,omitempty"`
	TempC         *float64 `cbor:"temp,omitempty"`
	PowerW        *float64 `cbor:"power,omitempty"`
}

// Fan is a hwmon fan input.
type Fan struct {
	Label  string  `cbor:"label"`  // "CPU fan", "fan2"
	Source string  `cbor:"source"` // "nct6798 · fan2"
	RPM    float64 `cbor:"rpm"`
	MinRPM float64 `cbor:"min,omitempty"` // hwmon fanN_min when set
}

// PlatformWarning is a warning the platform itself raises (Incus
// /1.0/warnings, Docker daemon warnings).
type PlatformWarning struct {
	Type     string    `cbor:"type"`
	Message  string    `cbor:"msg"`
	Count    int       `cbor:"count,omitempty"`
	LastSeen time.Time `cbor:"last,omitempty"`
	Project  string    `cbor:"project,omitempty"`
}

// PVETask is a Proxmox task (cluster task list): failed tasks of the last
// 48 hours and running ones, newest first, at most 50.
type PVETask struct {
	UPID   string     `cbor:"upid"`
	Type   string     `cbor:"type"` // vzdump | qmstart | vzmigrate | ...
	ID     string     `cbor:"id,omitempty"`
	Node   string     `cbor:"node"`
	User   string     `cbor:"user,omitempty"`
	Start  time.Time  `cbor:"start"`
	End    *time.Time `cbor:"end,omitempty"`
	Status string     `cbor:"status"` // "OK", "running", or the error text
	OK     bool       `cbor:"ok"`
}

// PVEReplication is a storage replication job of a guest on this node.
type PVEReplication struct {
	ID        string    `cbor:"id"` // "100-0"
	Guest     string    `cbor:"guest"`
	Target    string    `cbor:"target"`
	LastSync  time.Time `cbor:"last,omitempty"`
	Error     string    `cbor:"err,omitempty"`
	FailCount int       `cbor:"fails,omitempty"`
}

// CephHealth is the cluster's Ceph health when Ceph is configured.
type CephHealth struct {
	Status  string   `cbor:"status"`            // HEALTH_OK | HEALTH_WARN | HEALTH_ERR
	Summary []string `cbor:"summary,omitempty"` // check summaries, at most 16
}
