// Package proto defines the messages exchanged between whombat-agent and
// whombat-hosts. Both sides are Go, so the Go structs are the schema; they are
// encoded as CBOR (see package wire).
//
// Transport: the agent dials the hub over a TLS WebSocket with a client
// certificate, then runs yamux on top. The agent opens exactly one stream
// (kind "control") on which it sends Hello, then Report / Backfill / Event
// messages. The hub opens one short-lived stream per request (action,
// thumbnail, console). The first frame on every stream is a StreamHeader.
package proto

import "time"

// Version is the agent <-> hub protocol version. Bump on incompatible changes.
const Version = 1

// Stream kinds (StreamHeader.Kind).
const (
	StreamControl   = "control"   // agent-opened, long-lived
	StreamAction    = "action"    // hub-opened RPC: ActionRequest -> ActionResponse
	StreamThumbnail = "thumbnail" // hub-opened RPC: ThumbnailRequest -> ThumbnailResponse
	StreamConsole   = "console"   // hub-opened: ConsoleRequest -> ConsoleResponse, then console frames
)

// StreamHeader is the first CBOR frame on every yamux stream.
type StreamHeader struct {
	Kind string `cbor:"kind"`
}

// Control-stream message types (Envelope.Type).
const (
	MsgHello    = "hello"     // agent -> hub, first message
	MsgHelloAck = "hello_ack" // hub -> agent
	MsgReport   = "report"    // agent -> hub, every ReportInterval
	MsgBackfill = "backfill"  // agent -> hub, buffered samples after a reconnect
	MsgEvent    = "event"     // agent -> hub, immediate notifications
	MsgPing     = "ping"      // either way; peer answers MsgPong with the same body
	MsgPong     = "pong"
	// MsgHubAddrs (hub -> agent, HubAddrs): the hub's addresses changed.
	// Agents that don't know it ignore it, as every unknown type.
	MsgHubAddrs = "hub_addrs"
	// MsgHubMove (hub -> agent, HubMove): connect to the hub at this
	// address instead, before the old one goes away (the box moves to
	// another network card). Older agents ignore it and find the hub by
	// themselves once the old address stops answering.
	MsgHubMove = "hub_move"
)

// Envelope wraps every message on the control stream.
type Envelope struct {
	Type string `cbor:"t"`
	Body []byte `cbor:"b"` // CBOR-encoded body for Type
}

// ReportInterval is how often the agent sends a Report (and so the heartbeat).
const ReportInterval = 10 * time.Second

// Hello is the agent's first control message.
type Hello struct {
	ProtocolVersion int       `cbor:"pv"`
	AgentVersion    string    `cbor:"av"`
	MachineID       string    `cbor:"mid"`
	Hostname        string    `cbor:"host"`
	Clock           time.Time `cbor:"clock"` // agent wall clock, for skew detection
	// CSR is a PEM certificate signing request, set when the agent wants its
	// client certificate renewed (the hub answers with HelloAck.Certificate).
	CSR []byte `cbor:"csr,omitempty"`
	// BufferedSamples is how many samples the agent will backfill.
	BufferedSamples int `cbor:"buffered,omitempty"`
}

// HelloAck is the hub's answer to Hello.
type HelloAck struct {
	ServerID    string    `cbor:"sid"`
	HubVersion  string    `cbor:"hv"`
	HubClock    time.Time `cbor:"clock"`
	Certificate []byte    `cbor:"cert,omitempty"` // renewed client cert (PEM), if CSR was sent
	// Rejected is set when the hub refuses the agent (revoked, version too old).
	Rejected string `cbor:"rejected,omitempty"`
	// Addrs are every address of the hub's agent listener an agent may
	// reach it on (wss URLs, the agents' URL first). The agent remembers
	// them to find the hub when its saved address stops working (HS-170).
	Addrs []string `cbor:"addrs,omitempty"`
}

// HubAddrs is the body of MsgHubAddrs: the same list as HelloAck.Addrs,
// sent when it changes.
type HubAddrs struct {
	Addrs []string `cbor:"addrs"`
}

// HubMove is the body of MsgHubMove: one of the hub's own addresses (a
// wss URL from HelloAck.Addrs).
type HubMove struct {
	URL string `cbor:"url"`
}

// Event is an immediate notification from the agent.
type Event struct {
	At       time.Time `cbor:"at"`
	Kind     string    `cbor:"kind"` // "guest.state_changed", "collector.error"
	Platform string    `cbor:"platform,omitempty"`
	GuestID  string    `cbor:"guest,omitempty"`
	State    string    `cbor:"state,omitempty"`
	Message  string    `cbor:"msg,omitempty"`
}

// Sample is one timestamped set of series values. Series names are produced by
// Report.Series(); the agent buffers Samples while the hub is unreachable.
type Sample struct {
	At     time.Time          `cbor:"at"`
	Values map[string]float64 `cbor:"v"`
}

// Backfill carries buffered samples, oldest first.
type Backfill struct {
	Samples []Sample `cbor:"s"`
}

// Report is the agent's full view of its host, sent every ReportInterval.
// Pointers and nil slices mean "unknown / not present", never zero.
type Report struct {
	At     time.Time `cbor:"at"`
	Seq    uint64    `cbor:"seq"`
	Host   HostInfo  `cbor:"host"`
	CPU    CPU       `cbor:"cpu"`
	Memory Memory    `cbor:"mem"`

	Sensors     []Sensor     `cbor:"sensors"`
	Disks       []Disk       `cbor:"disks"`
	Filesystems []Filesystem `cbor:"fs"`
	Pools       []Pool       `cbor:"pools"`

	KVM *KVM `cbor:"kvm,omitempty"` // nil when /dev/kvm is absent and no virt flags

	// Platforms: nil when the platform is not installed on the host.
	Docker  *Platform `cbor:"docker,omitempty"`
	Incus   *Platform `cbor:"incus,omitempty"`
	Libvirt *Platform `cbor:"libvirt,omitempty"`
	PVE     *PVE      `cbor:"pve,omitempty"`

	Collectors []CollectorStatus `cbor:"collectors"`
	Policy     Policy            `cbor:"policy"`
	Agent      AgentInfo         `cbor:"agent"`

	// Host health (health.go). nil / empty: not collected or not present.
	System   *SystemInfo `cbor:"sys,omitempty"`
	Pressure *Pressure   `cbor:"psi,omitempty"`
	Net      []NetIface  `cbor:"net,omitempty"`
	RAID     []RAIDArray `cbor:"raid,omitempty"`
	UPS      []UPS       `cbor:"ups,omitempty"`
	GPUs     []GPU       `cbor:"gpus,omitempty"`
	Fans     []Fan       `cbor:"fans,omitempty"`

	// Unraid: the unRAID server (unraid.go); nil on other hosts.
	Unraid *Unraid `cbor:"unraid,omitempty"`

	// MacOS: the Mac's own facts (macos.go); only macOS agents send it.
	MacOS *MacOS `cbor:"macos,omitempty"`

	// BackupPlace: what the server keeps and offers as a backup place
	// (backupplace.go); nil from agents that don't know backup places.
	BackupPlace *BackupPlace `cbor:"bplace,omitempty"`

	// Checks are the results of the checks the hub asked this agent to run
	// (rpc.go, MsgChecks), latest result per check.
	Checks []CheckResult `cbor:"checks,omitempty"`
}

// HostInfo is mostly static host information.
type HostInfo struct {
	MachineID string `cbor:"mid"`
	Hostname  string `cbor:"hostname"`
	OSName    string `cbor:"os_name"`    // "Debian GNU/Linux", "Proxmox VE", "Ubuntu"
	OSVersion string `cbor:"os_version"` // "13", "9.0.3", "24.04 LTS"
	OSPretty  string `cbor:"os_pretty"`  // "Debian GNU/Linux 13 (trixie)"
	Kernel    string `cbor:"kernel"`     // "6.12.107+deb13-amd64"

	CPUModel string `cbor:"cpu_model"` // short form, e.g. "EPYC 7443P", "Ryzen Threadripper 9970X"
	Cores    int    `cbor:"cores"`     // physical cores (from topology)
	Threads  int    `cbor:"threads"`   // logical CPUs

	MemoryTotalBytes uint64 `cbor:"mem_total"`
	MemoryType       string `cbor:"mem_type,omitempty"` // "DDR5 ECC" when known (dmidecode)

	BootTime  time.Time `cbor:"boot"`
	Addresses []string  `cbor:"addrs"`          // primary IPv4 first
	Virtual   string    `cbor:"virt,omitempty"` // "kvm" etc. when the host itself is a VM
}

// CPU holds percentages of total logical CPUs over the last interval.
type CPU struct {
	UsagePct  float64    `cbor:"usage"`
	UserPct   float64    `cbor:"user"`
	SystemPct float64    `cbor:"system"`
	IOWaitPct float64    `cbor:"iowait"`
	StealPct  float64    `cbor:"steal,omitempty"` // time stolen by the hypervisor (the host is a VM)
	Load      [3]float64 `cbor:"load"`
}

// Memory from /proc/meminfo. Used = Total - Available.
type Memory struct {
	TotalBytes     uint64  `cbor:"total"`
	UsedBytes      uint64  `cbor:"used"`
	AvailableBytes uint64  `cbor:"avail"`
	CachedBytes    uint64  `cbor:"cached"`
	FreeBytes      uint64  `cbor:"free"`
	SwapTotalBytes uint64  `cbor:"swap_total"`
	SwapUsedBytes  uint64  `cbor:"swap_used"`
	ZFSARCBytes    *uint64 `cbor:"arc,omitempty"` // nil when ZFS is not loaded
}

// Sensor groups. Each group reports its hottest member.
const (
	SensorCPU    = "cpu_package"
	SensorBoard  = "board_vrm"
	SensorNVMe   = "nvme_hottest"
	SensorDIMM   = "dimm"
	SensorHDD    = "hdd_hottest"
	SensorSATASS = "ssd_hottest"
)

// Sensor is one temperature group.
type Sensor struct {
	ID     string  `cbor:"id"`     // one of the Sensor* constants
	Label  string  `cbor:"label"`  // "CPU package", "Board / VRM", "NVMe, hottest", "Memory modules", "HDD, hottest", "SATA SSD, hottest"
	Group  string  `cbor:"group"`  // cpu | board | nvme | memory | hdd | ssd
	Source string  `cbor:"source"` // "k10temp · Tctl", "nvme1n1 · composite", "jc42 · 4 sensors", "sda · SMART"
	TempC  float64 `cbor:"temp"`
	LimitC float64 `cbor:"limit"` // hwmon max/crit or the per-class default
}

// Disk is one physical disk.
type Disk struct {
	Device        string   `cbor:"dev"`  // "nvme0n1", "sda"
	Type          string   `cbor:"type"` // nvme | ssd | hdd
	Model         string   `cbor:"model"`
	Serial        string   `cbor:"serial,omitempty"`
	CapacityBytes uint64   `cbor:"cap"`
	UsedBytes     *uint64  `cbor:"used,omitempty"` // mapped from filesystems / pools
	Role          string   `cbor:"role,omitempty"` // "System · /, /boot", "tank, mirror member · /srv/tank"
	Pool          string   `cbor:"pool,omitempty"` // ZFS pool / md / VG the disk belongs to
	WearPct       *float64 `cbor:"wear,omitempty"` // SSD endurance used; nil for HDDs or unknown
	WrittenBytes  *uint64  `cbor:"written,omitempty"`
	RatedTBW      *float64 `cbor:"tbw,omitempty"` // from the model lookup table
	TempC         *float64 `cbor:"temp,omitempty"`
	PowerOnHours  *uint64  `cbor:"poh,omitempty"`
	SmartPassed   *bool    `cbor:"smart_ok,omitempty"`
	Reallocated   *uint64  `cbor:"realloc,omitempty"`
	Pending       *uint64  `cbor:"pending,omitempty"`
	Uncorrectable *uint64  `cbor:"uncorr,omitempty"`

	IO *DiskIO `cbor:"io,omitempty"` // throughput over the last interval

	// More SMART detail (nil: not reported by the drive).
	SelfTest        *SelfTest `cbor:"selftest,omitempty"`
	ErrorLogCount   *uint64   `cbor:"errlog,omitempty"`    // ATA error log / NVMe error log entries
	CRCErrors       *uint64   `cbor:"crc,omitempty"`       // attribute 199: cable or connector trouble
	CriticalWarning *uint64   `cbor:"nvme_cw,omitempty"`   // NVMe critical_warning bit field (0 = none)
	SparePct        *float64  `cbor:"spare,omitempty"`     // NVMe available spare
	SpareThreshold  *float64  `cbor:"spare_thr,omitempty"` // NVMe available spare threshold
	MediaErrors     *uint64   `cbor:"media_err,omitempty"` // NVMe media and data integrity errors
	UnsafeShutdowns *uint64   `cbor:"unsafe,omitempty"`
	// Standby: an HDD was spun down at the last SMART run, which skipped it;
	// the SMART values are from an earlier run.
	Standby bool `cbor:"standby,omitempty"`
}

// Filesystem is one mounted, non-pseudo filesystem (or ZFS dataset root).
type Filesystem struct {
	Mount     string   `cbor:"mount"`
	Device    string   `cbor:"dev"` // source, e.g. "/dev/nvme0n1p2", "tank/data"
	FSType    string   `cbor:"type"`
	SizeBytes uint64   `cbor:"size"` // usable size: used + available to users (like df)
	UsedBytes uint64   `cbor:"used"`
	Disks     []string `cbor:"disks,omitempty"` // physical disks backing it

	InodesTotal uint64 `cbor:"inodes,omitempty"` // 0: the filesystem has no fixed inode count (ZFS, btrfs)
	InodesUsed  uint64 `cbor:"inodes_used,omitempty"`
	// ReadOnly: mounted read-only although its fstab entry (or, without
	// one, its first mount) was read-write: usually the kernel remounted it
	// after I/O errors.
	ReadOnly bool   `cbor:"ro,omitempty"`
	Remote   bool   `cbor:"remote,omitempty"` // nfs, cifs, ...
	Error    string `cbor:"err,omitempty"`    // statfs failed or hung
}

// Pool is a ZFS pool (or similar).
type Pool struct {
	Name       string   `cbor:"name"`
	Health     string   `cbor:"health"`
	Layout     string   `cbor:"layout,omitempty"` // "mirror", "raidz1", "stripe"
	SizeBytes  uint64   `cbor:"size"`
	AllocBytes uint64   `cbor:"alloc"`
	Disks      []string `cbor:"disks"`

	// zpool status: the last scrub, error counters summed over all vdevs,
	// the status text when the pool is not healthy, and faulted devices.
	ScrubState  string    `cbor:"scrub,omitempty"` // none | scanning | finished | canceled
	ScrubEnd    time.Time `cbor:"scrub_end,omitempty"`
	ScrubErrors uint64    `cbor:"scrub_err,omitempty"` // errors the last scrub found
	ReadErrors  uint64    `cbor:"rd_err,omitempty"`
	WriteErrors uint64    `cbor:"wr_err,omitempty"`
	CksumErrors uint64    `cbor:"ck_err,omitempty"`
	Status      string    `cbor:"status,omitempty"`
	Faulted     []string  `cbor:"faulted,omitempty"` // devices not ONLINE
	FragPct     *float64  `cbor:"frag,omitempty"`
}

// KVM capabilities of the host.
type KVM struct {
	Enabled        bool   `cbor:"enabled"` // /dev/kvm present
	Module         string `cbor:"module"`  // kvm_amd | kvm_intel
	Device         string `cbor:"device"`  // "/dev/kvm"
	CPUVirtType    string `cbor:"virt"`    // "AMD-V" | "Intel VT-x"
	CPUFlag        string `cbor:"flag"`    // svm | vmx
	NestedPaging   bool   `cbor:"npt"`     // npt | ept
	IOMMUEnabled   bool   `cbor:"iommu"`
	IOMMUGroups    int    `cbor:"iommu_groups"`
	VFIOPCIDevices int    `cbor:"vfio"`
	NestedEnabled  bool   `cbor:"nested"`
	NestedParam    string `cbor:"nested_param"` // "kvm_amd nested=1"
	HugepagesCount int    `cbor:"hp_count"`
	HugepageSize   uint64 `cbor:"hp_size"` // bytes
	KSMRunning     bool   `cbor:"ksm_run"`
	KSMSavedBytes  uint64 `cbor:"ksm_saved"`
}

// Guest platforms.
const (
	PlatformDocker  = "docker"
	PlatformIncus   = "incus"
	PlatformLibvirt = "libvirt"
	PlatformPVE     = "pve"
)

// Platform is a Docker, Incus or libvirt installation on the host.
type Platform struct {
	Version  string            `cbor:"version,omitempty"`
	Error    string            `cbor:"error,omitempty"` // set when the collector failed ("Not reporting")
	Guests   []Guest           `cbor:"guests"`
	Warnings []PlatformWarning `cbor:"warnings,omitempty"` // Incus warnings
	// Tasks: Incus operations that failed in the last 48 h (newest last),
	// in the shape of the Proxmox tasks.
	Tasks []PVETask `cbor:"tasks,omitempty"`
	// Incus: projects, pools, networks, profiles, images and custom
	// volumes (incus.go; nil before the first slow read).
	Incus *IncusDetail `cbor:"incus,omitempty"`
	// Libvirt: pools, networks, unRAID's folders, firmware, the backups
	// folder (libvirt.go; nil before the first read).
	Libvirt *LibvirtDetail `cbor:"libvirt,omitempty"`
}

// Guest states.
const (
	StateRunning   = "running"
	StateStopped   = "stopped"
	StateUnhealthy = "unhealthy" // Docker health check failing
)

// Guest is a VM or container.
type Guest struct {
	// ID is the platform-local id: Docker container name, Incus instance name
	// (prefixed "project/" outside the default project), libvirt domain name,
	// PVE vmid as a decimal string. The hub's guest id is "platform:ID".
	ID    string `cbor:"id"`
	Name  string `cbor:"name"`
	Kind  string `cbor:"kind"`  // vm | container
	Image string `cbor:"image"` // "prom/prometheus", "nixos/26.05", "q35 · OVMF", "ubuntu 24.04"
	State string `cbor:"state"` // running | stopped | unhealthy

	VCPU            int    `cbor:"vcpu,omitempty"`    // configured vCPUs (0 = unlimited/unknown)
	MemConfigBytes  uint64 `cbor:"mem_cfg,omitempty"` // configured / maximum memory (VMs: assigned RAM)
	BalloonActive   bool   `cbor:"balloon,omitempty"`
	SnapshotsCount  *int   `cbor:"snaps,omitempty"`
	OSType          string `cbor:"os,omitempty"` // "windows", "linux", "freebsd" when known
	Firmware        string `cbor:"fw,omitempty"` // "OVMF", "SeaBIOS"
	MachineType     string `cbor:"machine,omitempty"`
	HealthCheckText string `cbor:"health,omitempty"`

	// Live values; nil when stopped or unknown.
	// CPUPct: VMs/system containers = percent of configured vCPUs (0-100);
	// Docker = docker-stats convention (100 = one core).
	CPUPct        *float64 `cbor:"cpu,omitempty"`
	MemUsedBytes  *uint64  `cbor:"mem_used,omitempty"`
	MemLimitBytes *uint64  `cbor:"mem_limit,omitempty"`
	DiskReadBps   *float64 `cbor:"rd,omitempty"` // bytes per second
	DiskWriteBps  *float64 `cbor:"wr,omitempty"`
	NetRxBps      *float64 `cbor:"rx,omitempty"` // bytes per second
	NetTxBps      *float64 `cbor:"tx,omitempty"`

	StartedAt  *time.Time `cbor:"started,omitempty"`
	FinishedAt *time.Time `cbor:"finished,omitempty"` // Docker: last exit time when stopped

	Console ConsoleCaps `cbor:"console"`

	// Proxmox only.
	VMID       int         `cbor:"vmid,omitempty"`
	Node       string      `cbor:"node,omitempty"`
	LastBackup *BackupMark `cbor:"last_backup,omitempty"`
	Lock       string      `cbor:"lock,omitempty"` // backup | migrate | snapshot | ... (PVE lock)
	Tags       []string    `cbor:"tags,omitempty"` // PVE tags
	// PendingChanges: configuration changes that wait for a restart.
	PendingChanges int `cbor:"pending,omitempty"`
	// GuestAgent: VMs with the QEMU guest agent enabled: running |
	// not_running ("" = disabled or unknown).
	GuestAgent     string     `cbor:"qga,omitempty"`
	OldestSnapshot *time.Time `cbor:"snap_oldest,omitempty"`
	// BackupJob: whether an enabled backup job covers the guest (nil:
	// unknown).
	BackupJob *bool  `cbor:"backup_job,omitempty"`
	HAState   string `cbor:"ha,omitempty"` // HA manager state when the guest is an HA resource

	// Docker.
	RestartCount *int   `cbor:"restarts,omitempty"`
	ExitCode     *int   `cbor:"exit,omitempty"` // last exit code (stopped containers)
	OOMKilled    bool   `cbor:"oom,omitempty"`  // the last exit was an OOM kill
	Project      string `cbor:"project,omitempty"`
	// WhombatService: the container is one of Whombat's own services
	// (label whombat.service=1): Whombat leaves it out of what people see.
	WhombatService  bool  `cbor:"wb_svc,omitempty"`
	UpdateAvailable *bool `cbor:"update,omitempty"` // the registry has a newer image for the tag
	// App: the container is a Docker Compose app this agent can update
	// (apps.go); nil for other containers and from older agents.
	App *GuestApp `cbor:"app,omitempty"`
	// ImageID: the id of the image it runs ("sha256:…"), so Whombat tells a
	// new image pulled under the same tag from the one before.
	ImageID string `cbor:"image_id,omitempty"`

	// unRAID (unraid.go): Autostart for Docker on unRAID (dockerMan's
	// autostart list) and libvirt (everywhere); WebUI is a container's web
	// page from its dockerMan template, [IP] and [PORT:n] resolved;
	// UnraidTemplate: a dockerMan template exists (container.update works).
	Autostart      *bool  `cbor:"autostart,omitempty"`
	WebUI          string `cbor:"webui,omitempty"`
	UnraidTemplate bool   `cbor:"unraid_tmpl,omitempty"`

	// Any platform, when known.
	DiskUsedBytes *uint64  `cbor:"disk_used,omitempty"` // root disk usage (Incus, LXC, Docker writable layer)
	Processes     *int     `cbor:"procs,omitempty"`
	Addresses     []string `cbor:"addrs,omitempty"` // guest IP addresses (no CIDR)

	// MACs are the guest's network card addresses, lower case (Incus
	// volatile.<nic>.hwaddr, PVE netN, libvirt <mac address>). The hosts
	// service compares them with its own machine's to find the guest it
	// runs in (Self).
	MACs []string `cbor:"macs,omitempty"`
	// Incus: the snapshot schedule in effect (own or from a profile), when
	// the instance was created (LastBackup is its newest backup).
	SnapshotSchedule string     `cbor:"snap_sched,omitempty"`
	CreatedAt        *time.Time `cbor:"created,omitempty"`
	// Self is set by the hosts service, never sent: this guest is the
	// machine the hosts service (the Whombat) runs in.
	Self bool `cbor:"-"`
	// libvirt: when the newest snapshot was taken (LastBackup is its
	// newest Whombat backup).
	LastSnapshot *time.Time `cbor:"snap_newest,omitempty"`
}

// Console protocols.
const (
	ProtoVNC    = "vnc"
	ProtoSPICE  = "spice"
	ProtoSerial = "serial"
	ProtoShell  = "shell" // interactive exec / enter
	ProtoTTY    = "tty"   // container console
)

// ConsoleCaps says which console protocols the agent can broker for a guest.
// Unavailable lists protocols the platform has but the agent cannot serve,
// with the reason shown in the UI (protocol -> reason).
type ConsoleCaps struct {
	Protocols   []string          `cbor:"protos,omitempty"`
	Default     string            `cbor:"default,omitempty"`
	Resolution  string            `cbor:"res,omitempty"` // "1280x800" when known
	Unavailable map[string]string `cbor:"unavail,omitempty"`
}

// BackupMark is the result of a guest's most recent backup.
type BackupMark struct {
	Result string    `cbor:"result"` // ok | error | warning
	At     time.Time `cbor:"at"`
}

// PVE is the Proxmox VE view from this node.
type PVE struct {
	Version string `cbor:"version,omitempty"` // "9.0.3"
	Error   string `cbor:"error,omitempty"`
	Node    string `cbor:"node"`

	Cluster  *PVECluster  `cbor:"cluster,omitempty"` // nil for a standalone node
	Nodes    []PVENode    `cbor:"nodes"`             // all cluster nodes (just this one when standalone)
	Storages []PVEStorage `cbor:"storages"`
	Backups  *PVEBackups  `cbor:"backups,omitempty"`
	Guests   []Guest      `cbor:"guests"` // QEMU VMs and LXC containers on this node

	Tasks       []PVETask        `cbor:"tasks,omitempty"`
	Replication []PVEReplication `cbor:"repl,omitempty"`
	Ceph        *CephHealth      `cbor:"ceph,omitempty"`

	HAResourcesStarted int `cbor:"ha_started"`
	HAResourcesTotal   int `cbor:"ha_total"`

	// Templates: guest templates on this node (not in Guests).
	Templates []TemplateGuest `cbor:"templates,omitempty"`
}

// PVECluster is cluster-wide state.
type PVECluster struct {
	Name          string `cbor:"name"`
	Quorate       bool   `cbor:"quorate"`
	VotesHave     int    `cbor:"votes"`
	VotesExpected int    `cbor:"expected"`
}

// PVENode is one cluster node as seen through the cluster API.
type PVENode struct {
	Name       string  `cbor:"name"`
	ThisNode   bool    `cbor:"this"`
	Online     bool    `cbor:"online"`
	CPUPct     float64 `cbor:"cpu"`
	MemPct     float64 `cbor:"mem"`
	VMs        int     `cbor:"vms"`
	Containers int     `cbor:"cts"`
}

// PVEStorage is one Proxmox storage as seen from this node.
type PVEStorage struct {
	ID         string `cbor:"id"`
	Type       string `cbor:"type"`             // dir | zfspool | lvmthin | pbs | nfs | ...
	Content    string `cbor:"content"`          // raw content list: "iso,vztmpl,backup"
	Detail     string `cbor:"detail,omitempty"` // pool / path / server, e.g. "rpool/data"
	Shared     bool   `cbor:"shared"`
	Active     bool   `cbor:"active"`
	UsedBytes  uint64 `cbor:"used"`
	TotalBytes uint64 `cbor:"total"`
	// ProvisionedBytes: the configured size of this node's guest disks
	// (templates included) on this storage. Thin: volumes take space as
	// they are written (lvmthin, sparse zfspool, rbd, qcow2 on files), so
	// ProvisionedBytes may exceed TotalBytes.
	ProvisionedBytes uint64 `cbor:"prov,omitempty"`
	Thin             bool   `cbor:"thin,omitempty"`
}

// PVEBackups summarizes vzdump jobs.
type PVEBackups struct {
	LastJob *PVEBackupJob `cbor:"last,omitempty"`
	NextRun *time.Time    `cbor:"next,omitempty"`
	Target  string        `cbor:"target,omitempty"` // storage id
}

// PVEBackupJob is the most recent vzdump run on this node.
type PVEBackupJob struct {
	At              time.Time `cbor:"at"`
	Schedule        string    `cbor:"schedule"` // "daily", "sun 01:00", raw calendar event
	Mode            string    `cbor:"mode"`     // snapshot | suspend | stop
	Result          string    `cbor:"result"`   // ok | warning | error
	GuestsOK        int       `cbor:"ok"`
	GuestsTotal     int       `cbor:"total"`
	Warnings        int       `cbor:"warnings"`
	WrittenBytes    uint64    `cbor:"written"`
	DedupRatio      *float64  `cbor:"dedup,omitempty"`
	DurationS       int       `cbor:"duration"`
	AvgDurationWeek *int      `cbor:"avg_week,omitempty"` // seconds
}

// CollectorStatus reports the health of one collector.
type CollectorStatus struct {
	Name       string    `cbor:"name"` // host, sensors, disks, smart, kvm, docker, incus, libvirt, pve
	OK         bool      `cbor:"ok"`
	Error      string    `cbor:"error,omitempty"`
	LastRun    time.Time `cbor:"last"`
	DurationMs int       `cbor:"ms"`
}

// Policy is the agent's local remote-control configuration. The hub may only
// broker consoles / power actions when both the hub setting and this allow it.
type Policy struct {
	Console bool `cbor:"console"` // guest consoles, logs, the host's process / port / service lists and journal
	Power   bool `cbor:"power"`   // guest power actions and snapshots
	// Host access is separate and off unless set in agent.toml:
	// [remote_control] host_shell / host_power.
	HostShell bool `cbor:"host_shell,omitempty"` // root shell on the host
	HostPower bool `cbor:"host_power,omitempty"` // reboot / shut down the host
	// Update: the agent accepts signed updates from the hub ([update]
	// allow, default true when the binary carries an update key).
	Update bool `cbor:"update,omitempty"`
	// Manage: guest configuration and lifecycle (StreamManage), off
	// unless set in agent.toml ([remote_control] manage).
	Manage bool `cbor:"manage,omitempty"`
	// Diagnose: the assistant's read-only checks (StreamDiagnose), on
	// unless agent.toml says [remote_control] diagnose = false.
	Diagnose bool `cbor:"diagnose,omitempty"`
}

// AgentInfo describes the agent process itself.
type AgentInfo struct {
	Version    string    `cbor:"version"`
	StartedAt  time.Time `cbor:"started"`
	RSSBytes   uint64    `cbor:"rss"`
	CPUPct     float64   `cbor:"cpu"` // agent's own CPU use incl. helper processes, percent of one core
	BufferSize int       `cbor:"buffered"`

	ConsolesOpen  int    `cbor:"consoles,omitempty"`
	Reconnects    uint64 `cbor:"reconnects,omitempty"` // since the agent started
	DroppedEvents uint64 `cbor:"dropped,omitempty"`    // events lost while the hub was unreachable
	Install       string `cbor:"install,omitempty"`    // systemd | openrc | sysv | unraid | launchd | manual
	Arch          string `cbor:"arch,omitempty"`       // amd64 | arm64
	OS            string `cbor:"os,omitempty"`         // darwin from macOS agents; "" = linux
	// UpdateKey is the fingerprint of the public key the agent verifies
	// updates with ("" = built without one: no self-update).
	UpdateKey string `cbor:"update_key,omitempty"`
	// Caps lists what this agent can do beyond the base protocol
	// (CapHelperUpdate); absent from older agents.
	Caps []string `cbor:"caps,omitempty"`
}

// Agent capabilities (AgentInfo.Caps).
const (
	// CapHelperUpdate: the agent installs Whombat Helper sent on the update
	// stream (UpdateRequest.Component UpdateComponentHelper).
	CapHelperUpdate = "helper_update"
)

// ---- Hub-initiated RPCs -----------------------------------------------------

// Guest actions.
const (
	ActionStart      = "start"
	ActionShutdown   = "shutdown" // graceful (ACPI / guest agent)
	ActionReboot     = "reboot"
	ActionStop       = "stop"       // containers: stop
	ActionForceStop  = "force_stop" // VMs: hard power-off
	ActionRestart    = "restart"    // containers
	ActionCtrlAltDel = "ctrl_alt_del"
)

// ActionRequest asks the agent to run a power action on a guest (or, with
// Platform PlatformHost, on the host).
type ActionRequest struct {
	Platform string            `cbor:"platform"`
	GuestID  string            `cbor:"guest"`
	Action   string            `cbor:"action"`
	Args     map[string]string `cbor:"args,omitempty"` // snapshot actions (Arg*)
}

// ActionResponse reports the outcome. The agent waits (up to 60 s) for the
// guest to reach the expected state before answering.
type ActionResponse struct {
	OK      bool   `cbor:"ok"`
	Noop    bool   `cbor:"noop,omitempty"`  // already in the requested state
	State   string `cbor:"state,omitempty"` // observed state afterwards
	Code    string `cbor:"code,omitempty"`  // machine-readable error code
	Message string `cbor:"msg,omitempty"`
}

// ThumbnailRequest asks for a still image of a guest's screen.
type ThumbnailRequest struct {
	Platform string `cbor:"platform"`
	GuestID  string `cbor:"guest"`
	MaxWidth int    `cbor:"max_w"` // 0 = full size
	Format   string `cbor:"fmt"`   // "jpeg" (thumbnails) | "png" (Screenshot button)
}

// ThumbnailResponse carries the image or an error.
type ThumbnailResponse struct {
	Image   []byte `cbor:"img,omitempty"`
	Width   int    `cbor:"w,omitempty"`
	Height  int    `cbor:"h,omitempty"`
	Code    string `cbor:"code,omitempty"` // "unsupported", "guest_not_running", ...
	Message string `cbor:"msg,omitempty"`
}

// ConsoleRequest opens a console session. After the agent answers with a
// ConsoleResponse (OK), the stream carries console frames (see wire package).
type ConsoleRequest struct {
	SessionID string `cbor:"sid"`
	Platform  string `cbor:"platform"`
	GuestID   string `cbor:"guest"`
	Protocol  string `cbor:"proto"`
	Cols      int    `cbor:"cols,omitempty"`
	Rows      int    `cbor:"rows,omitempty"`
}

// ConsoleResponse answers a ConsoleRequest.
type ConsoleResponse struct {
	OK         bool   `cbor:"ok"`
	Code       string `cbor:"code,omitempty"`
	Message    string `cbor:"msg,omitempty"`
	Resolution string `cbor:"res,omitempty"`
}
