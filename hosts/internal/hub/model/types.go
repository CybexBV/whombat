// Package model maps agent reports (proto.Report) and hub state to the JSON
// shapes of the read API (docs/handoff/docs/API.md, the fixtures in
// docs/handoff/sample-data and docs/CONTRACT.md). Everything here is pure.
package model

import (
	"bytes"
	"encoding/json"
	"math"
	"time"

	"rackoon/internal/rules"
)

// Time marshals as RFC 3339 UTC with second precision ("2026-10-11T14:00:00Z").
type Time time.Time

// MarshalJSON implements json.Marshaler.
func (t Time) MarshalJSON() ([]byte, error) {
	return []byte(`"` + time.Time(t).UTC().Truncate(time.Second).Format(time.RFC3339) + `"`), nil
}

// T converts a time; nil for the zero time.
func T(t time.Time) *Time {
	if t.IsZero() {
		return nil
	}
	x := Time(t)
	return &x
}

func ptr[V any](v V) *V { return &v }

func strp(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func r1(f float64) float64 {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return 0
	}
	return math.Round(f*10) / 10
}

func r2(f float64) float64 {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return 0
	}
	return math.Round(f*100) / 100
}

func r1p(f *float64) *float64 {
	if f == nil || math.IsNaN(*f) || math.IsInf(*f, 0) {
		return nil
	}
	return ptr(r1(*f))
}

// ---- Fleet (GET /fleet) ---------------------------------------------------

// Fleet is the body of GET /fleet.
type Fleet struct {
	AsOf               Time            `json:"as_of"`
	Groups             []GroupCount    `json:"groups"`
	KPIs               KPIs            `json:"kpis"`
	Servers            []FleetServer   `json:"servers"`
	Alerts             []Alert         `json:"alerts"`
	Hints              []Hint          `json:"hints"`
	TopGuestsByCPU     TopGuests       `json:"top_guests_by_cpu"`
	PlatformSummary    PlatformSummary `json:"platform_summary"`
	AgentsConnected    int             `json:"agents_connected"`
	PendingEnrollments int             `json:"pending_enrollments"`
}

// GroupCount is one entry of the group control.
type GroupCount struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}

// KPIs are the five tiles (online servers only, except the first two).
type KPIs struct {
	ServersOnline      int      `json:"servers_online"`
	ServersTotal       int      `json:"servers_total"`
	CPUAvgPct          *float64 `json:"cpu_avg_pct"`
	MemoryPct          *float64 `json:"memory_pct"`
	MemoryUsedGB       float64  `json:"memory_used_gb"`
	MemoryTotalGB      float64  `json:"memory_total_gb"`
	StorageUsedTB      float64  `json:"storage_used_tb"`
	StorageTotalTB     float64  `json:"storage_total_tb"`
	StoragePct         *float64 `json:"storage_pct"`
	DisksOver75Wear    int      `json:"disks_over_75_wear"`
	OpenAlerts         int      `json:"open_alerts"`
	OpenAlertsCritical int      `json:"open_alerts_critical"`
	OpenAlertsWarning  int      `json:"open_alerts_warning"`
	// OpenAlertsAttention: open alerts not acknowledged, muted or suppressed.
	OpenAlertsAttention int `json:"open_alerts_attention"`
}

// FleetServer is one server card.
type FleetServer struct {
	ID                string         `json:"id"`
	Hostname          string         `json:"hostname"`
	Group             string         `json:"group"`
	Status            string         `json:"status"`
	StatusNote        *string        `json:"status_note"`
	OS                *string        `json:"os"`
	CPU               *CPUInfo       `json:"cpu"`
	MemoryTotalGB     *float64       `json:"memory_total_gb"`
	StorageCapacityTB *float64       `json:"storage_capacity_tb"`
	LastSeen          *Time          `json:"last_seen"`
	Current           *Current       `json:"current"`
	LastKnown         *LastKnown     `json:"last_known"`
	Workloads         FleetWorkloads `json:"workloads"`
	Hypervisor        *Hypervisor    `json:"hypervisor"`
	DetailView        string         `json:"detail_view"`
	OSFamily          string         `json:"os_family,omitempty"` // linux | macos | windows; absent before the first report
	AgentConnected    bool           `json:"agent_connected"`
	// Via is the hub's address the agent's connection arrived at
	// ("10.100.1.97"); absent when not connected or not known.
	Via        string `json:"via,omitempty"`
	OpenAlerts int    `json:"open_alerts"`
	// ConsoleOn: consoles are switched on for the host in the hub and in
	// its agent.toml (the role is not considered; readable by viewers).
	ConsoleOn   bool       `json:"console_on"`
	Maintenance *MaintJSON `json:"maintenance"`
	Parent      *string    `json:"parent"` // the enrolled host this one runs on
	// HostsThisWhombat: one of the host's guests is this Whombat (IU-02).
	HostsThisWhombat bool `json:"hosts_this_whombat,omitempty"`

	StatusNoteCode   string         `json:"status_note_code,omitempty"`
	StatusNoteParams map[string]any `json:"status_note_params,omitempty"`
}

// MaintJSON is an active maintenance window of a host.
type MaintJSON struct {
	ID    string `json:"id"`
	Until Time   `json:"until"`
	Note  string `json:"note"`
}

// CPUInfo is the processor line.
type CPUInfo struct {
	Model   string `json:"model"`
	Cores   int    `json:"cores"`
	Threads int    `json:"threads"`
}

// Current are the live card values of an online server.
type Current struct {
	CPUPct         *float64 `json:"cpu_pct"`
	MemPct         *float64 `json:"mem_pct"`
	TempMaxC       *float64 `json:"temp_max_c"`
	TempLimitC     *float64 `json:"temp_limit_c"`
	DiskUsedPct    *float64 `json:"disk_used_pct"`
	DiskWearMaxPct *float64 `json:"disk_wear_max_pct"`
}

// LastKnown are the last values of an offline server.
type LastKnown struct {
	CPUPct         *float64 `json:"cpu_pct"`
	MemPct         *float64 `json:"mem_pct"`
	DiskUsedPct    *float64 `json:"disk_used_pct"`
	DiskWearMaxPct *float64 `json:"disk_wear_max_pct"`
}

// FleetWorkloads are the card's workload counts.
type FleetWorkloads struct {
	Docker DockerCounts `json:"docker"`
	Incus  IncusCounts  `json:"incus"`
	QEMU   QEMUCounts   `json:"qemu"`
}

// DockerCounts counts containers by state (unhealthy is its own state).
type DockerCounts struct {
	Running   int `json:"running"`
	Stopped   int `json:"stopped"`
	Unhealthy int `json:"unhealthy"`
}

// IncusCounts counts Incus instances.
type IncusCounts struct {
	ContainersRunning int `json:"containers_running"`
	VMsRunning        int `json:"vms_running"`
	Stopped           int `json:"stopped"`
}

// QEMUCounts counts libvirt and Proxmox VMs.
type QEMUCounts struct {
	Running int `json:"running"`
	Stopped int `json:"stopped"`
}

// Hypervisor is a row of the hypervisors table.
type Hypervisor struct {
	Stacks                 []string `json:"stacks"`
	KVMEnabled             bool     `json:"kvm_enabled"`
	HostThreads            int      `json:"host_threads"`
	VCPUAllocated          int      `json:"vcpu_allocated"`
	VCPUOvercommitRatio    float64  `json:"vcpu_overcommit_ratio"`
	GuestMemoryAssignedGB  float64  `json:"guest_memory_assigned_gb"`
	GuestMemoryAssignedPct float64  `json:"guest_memory_assigned_pct"`
	HostMemoryGB           float64  `json:"host_memory_gb"`
	VMs                    int      `json:"vms"`
	Containers             int      `json:"containers"`
}

// Alert is the alert object (API.md 6).
type Alert struct {
	ID       string `json:"id"`
	Server   string `json:"server"`
	Severity string `json:"severity"`
	Title    string `json:"title"`
	Detail   string `json:"detail"`
	OpenedAt Time   `json:"opened_at"`
	Rule     string `json:"rule"`
	// Entity is what the alert is about within its rule (a mount
	// "fs:/srv", a disk, a sensor, "host"); Key is rule + ":" + entity, one
	// open alert per server and key (HS-191).
	Entity     string  `json:"entity"`
	Key        string  `json:"key"`
	State      string  `json:"state"`
	ResolvedAt *Time   `json:"resolved_at"`
	Link       *string `json:"link"`

	Acknowledged *AckJSON `json:"acknowledged"`
	Muted        bool     `json:"muted"`         // the host is in maintenance
	SuppressedBy *string  `json:"suppressed_by"` // the host it runs on is offline
	Attention    bool     `json:"attention"`     // open and none of the above

	Code             string         `json:"code,omitempty"`
	Params           map[string]any `json:"params,omitempty"`
	StatusNoteCode   string         `json:"status_note_code,omitempty"`
	StatusNoteParams map[string]any `json:"status_note_params,omitempty"`
}

// AckJSON is an acknowledgement (Until: a snooze that lapses).
type AckJSON struct {
	At    Time   `json:"at"`
	By    string `json:"by"`
	Note  string `json:"note"`
	Until *Time  `json:"until"`
}

// Hint is a condition worth watching on a server that is not (yet) an
// alert (rules.Hint, CONTRACT.md 1 "hints").
type Hint struct {
	Server string `json:"server"`
	rules.Hint
}

// TopGuests are the busiest guests per workload card.
type TopGuests struct {
	Docker []TopGuest `json:"docker"`
	Incus  []TopGuest `json:"incus"`
	QEMU   []TopGuest `json:"qemu"`
}

// TopGuest is one "Top by CPU" row.
type TopGuest struct {
	Name   string  `json:"name"`
	Server string  `json:"server"`
	CPUPct float64 `json:"cpu_pct"`
}

// PlatformSummary feeds the three workload cards.
type PlatformSummary struct {
	Docker struct {
		Running   int `json:"running"`
		Stopped   int `json:"stopped"`
		Unhealthy int `json:"unhealthy"`
		Servers   int `json:"servers"`
	} `json:"docker"`
	Incus struct {
		ContainersRunning int `json:"containers_running"`
		VMsRunning        int `json:"vms_running"`
		Stopped           int `json:"stopped"`
		Servers           int `json:"servers"`
	} `json:"incus"`
	QEMU struct {
		Running           int `json:"running"`
		Stopped           int `json:"stopped"`
		ProxmoxVMsRunning int `json:"proxmox_vms_running"`
		LibvirtVMsRunning int `json:"libvirt_vms_running"`
		LibvirtServers    int `json:"libvirt_servers"`
		ProxmoxServers    int `json:"proxmox_servers"`
	} `json:"qemu"`
}

// ---- Server detail (GET /servers/{id}) -------------------------------------

// Detail is the body of GET /servers/{id} for both views; the view-specific
// fields are omitted from the other view.
type Detail struct {
	AsOf           Time            `json:"as_of"`
	Range          string          `json:"range"`
	Server         DetailServer    `json:"server"`
	Live           *Live           `json:"live"`
	Banner         *Banner         `json:"banner"`
	Hints          []Hint          `json:"hints"`
	Cluster        *Cluster        `json:"cluster,omitempty"`
	Sensors        []Sensor        `json:"sensors"`
	Virtualization *Virtualization `json:"virtualization"`
	// Standard view.
	Disks     any                       `json:"disks"` // []Disk (standard) or []PVEDisk (proxmox)
	Workloads map[string]*PlatformBlock `json:"workloads,omitempty"`
	// Proxmox view.
	Storages []Storage     `json:"storages,omitempty"`
	Backups  *Backups      `json:"backups,omitempty"`
	Guests   *ProxmoxGuest `json:"guests,omitempty"`
	// Incus: the host's projects, pools, networks, profiles, images and
	// custom volumes (incus.go), on any view when the host reports them.
	Incus *IncusDetail `json:"incus,omitempty"`
	// unRAID view (unraid.go): the standard view's keys plus this block.
	Unraid *UnraidDetail `json:"unraid,omitempty"`
	// BackupPlace (backupplace.go): null from agents that don't report it.
	BackupPlace *BackupPlace `json:"backup_place"`
	// libvirt (libvirt.go): on every host that runs it.
	Libvirt *LibvirtDetail `json:"libvirt,omitempty"`
	// MacOS (macos.go): a Mac's own facts, its screen and its helper.
	MacOS *MacOSDetail `json:"macos,omitempty"`
	// Windows (windows.go): a Windows PC's own facts and its protection.
	Windows *WindowsDetail `json:"windows,omitempty"`
	// DiskUsage (diskusage.go): recent on-request breakdowns of what fills a mount.
	DiskUsage []DiskUsage `json:"disk_usage,omitempty"`
	// Host health (health.go), both views.
	Health
	// proxmox marks the Proxmox view (keeps "storages" and "backups" keys
	// even when empty).
	proxmox bool
}

// MarshalJSON keeps the Proxmox-only keys present (null / []) in the
// Proxmox view and absent in the standard view.
func (d Detail) MarshalJSON() ([]byte, error) {
	type plain Detail
	b, err := json.Marshal(plain(d))
	if err != nil || !d.proxmox {
		return b, err
	}
	var extra bytes.Buffer
	if d.Cluster == nil {
		extra.WriteString(`,"cluster":null`)
	}
	if d.Storages == nil {
		extra.WriteString(`,"storages":[]`)
	}
	if d.Backups == nil {
		extra.WriteString(`,"backups":null`)
	}
	if extra.Len() == 0 {
		return b, nil
	}
	out := append(b[:len(b)-1:len(b)-1], extra.Bytes()...)
	return append(out, '}'), nil
}

// DetailServer is the header / meta strip data.
type DetailServer struct {
	FirstReportAt *Time         `json:"first_report_at,omitempty"`
	ID            string        `json:"id"`
	Hostname      string        `json:"hostname"`
	Group         string        `json:"group"`
	Status        string        `json:"status"`
	StatusNote    *string       `json:"status_note"`
	OpenAlerts    int           `json:"open_alerts"`
	Roles         []string      `json:"roles"`
	OS            *OSInfo       `json:"os"`
	CPU           *CPUInfo      `json:"cpu"`
	Memory        *MemInfo      `json:"memory"`
	UptimeS       *int64        `json:"uptime_s"`
	LastBoot      *Time         `json:"last_boot"`
	Address       *string       `json:"address"`
	Location      *string       `json:"location"`
	Agent         AgentInfo     `json:"agent"`
	DetailView    string        `json:"detail_view"`
	OSFamily      string        `json:"os_family,omitempty"` // linux | macos | windows; absent before the first report
	PVEVersion    *string       `json:"pve_version"`
	RemoteControl RemoteControl `json:"remote_control"`
	Collectors    []Collector   `json:"collectors"`
	Maintenance   *MaintJSON    `json:"maintenance"`
	Parent        *string       `json:"parent"`
	// HostsThisWhombat: one of the host's guests is this Whombat (IU-02).
	HostsThisWhombat bool `json:"hosts_this_whombat,omitempty"`

	StatusNoteCode   string         `json:"status_note_code,omitempty"`
	StatusNoteParams map[string]any `json:"status_note_params,omitempty"`
}

// OSInfo is the operating system field.
type OSInfo struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	Kernel  string `json:"kernel"`
}

// MemInfo is the memory field.
type MemInfo struct {
	TotalGB float64 `json:"total_gb"`
	Type    *string `json:"type"`
}

// AgentInfo is the agent field.
type AgentInfo struct {
	Version      *string  `json:"version"`
	LastSyncSAgo *int64   `json:"last_sync_s_ago"`
	Connected    bool     `json:"connected"`
	ClockSkewS   *float64 `json:"clock_skew_s"`
}

// RemoteControl are the effective console/power permissions of the current
// user on the server (CONTRACT.md 1).
type RemoteControl struct {
	Console       bool    `json:"console"`
	Power         bool    `json:"power"`
	AgentConsole  bool    `json:"agent_console"`
	AgentPower    bool    `json:"agent_power"`
	ConsoleReason *string `json:"console_reason"`
	PowerReason   *string `json:"power_reason"`
	// Host access (root shell, reboot / shut down the host): admins only.
	HostShell       bool    `json:"host_shell"`
	HostPower       bool    `json:"host_power"`
	AgentHostShell  bool    `json:"agent_host_shell"`
	AgentHostPower  bool    `json:"agent_host_power"`
	HostShellReason *string `json:"host_shell_reason"`
	HostPowerReason *string `json:"host_power_reason"`
	// Manage: guest configuration and lifecycle (docs/MANAGE.md); some of
	// its operations also need an admin, which the hub checks per call.
	Manage       bool    `json:"manage"`
	AgentManage  bool    `json:"agent_manage"`
	ManageReason *string `json:"manage_reason"`
	// Diagnose: the assistant's read-only checks (docs/ASSIST.md); on by
	// default in the hub and the agent.
	Diagnose       bool    `json:"diagnose"`
	AgentDiagnose  bool    `json:"agent_diagnose"`
	DiagnoseReason *string `json:"diagnose_reason"`
}

// Collector is one collector's health.
type Collector struct {
	Name  string  `json:"name"`
	OK    bool    `json:"ok"`
	Error *string `json:"error"`
}

// Live are the CPU and memory card values.
type Live struct {
	RefreshIntervalS int        `json:"refresh_interval_s"`
	CPUPct           float64    `json:"cpu_pct"`
	CPUUserPct       float64    `json:"cpu_user_pct"`
	CPUSystemPct     float64    `json:"cpu_system_pct"`
	CPUIOWaitPct     float64    `json:"cpu_iowait_pct"`
	LoadAvg          [3]float64 `json:"load_avg"`
	MemPct           float64    `json:"mem_pct"`
	MemUsedGB        float64    `json:"mem_used_gb"`
	MemCacheGB       *float64   `json:"mem_cache_gb"`
	ZFSARCGB         *float64   `json:"zfs_arc_gb"`
	MemFreeGB        float64    `json:"mem_free_gb"`
	SwapUsedGB       float64    `json:"swap_used_gb"`
	SwapTotalGB      float64    `json:"swap_total_gb"`
	AsOf             *Time      `json:"as_of"` // when the report was received
}

// Banner is the open-alert banner.
type Banner struct {
	Severity string  `json:"severity"`
	Title    string  `json:"title"`
	Detail   string  `json:"detail"`
	Link     *string `json:"link"`
	Rule     string  `json:"rule"`
	AlertID  string  `json:"alert_id"`

	Code             string         `json:"code,omitempty"`
	Params           map[string]any `json:"params,omitempty"`
	StatusNoteCode   string         `json:"status_note_code,omitempty"`
	StatusNoteParams map[string]any `json:"status_note_params,omitempty"`
}

// Sensor is a temperature table row.
type Sensor struct {
	ID      string   `json:"id"`
	Label   string   `json:"label"`
	Group   string   `json:"group"`
	Source  string   `json:"source"`
	NowC    *float64 `json:"now_c"`
	Max24hC *float64 `json:"max_24h_c"`
	LimitC  float64  `json:"limit_c"`
}

// Disk is a standard-host disk card.
type Disk struct {
	Device       string   `json:"device"`
	Type         string   `json:"type"`
	Model        string   `json:"model"`
	Role         *string  `json:"role"`
	Pool         *string  `json:"pool"`
	CapacityGB   float64  `json:"capacity_gb"`
	UsedGB       *float64 `json:"used_gb"`
	WearPct      *float64 `json:"wear_pct"`
	WrittenTB    *float64 `json:"written_tb"`
	RatedTBW     *float64 `json:"rated_tbw"`
	TempC        *float64 `json:"temp_c"`
	PowerOnHours *uint64  `json:"power_on_hours"`
	Health       string   `json:"health"`
	HealthReason *string  `json:"health_reason"` // why failing (SMART)
	Smart        Smart    `json:"smart"`
	IO           *DiskIO  `json:"io"`
}

// Smart are a disk's SMART counters.
type Smart struct {
	Passed        *bool   `json:"passed"`
	Reallocated   *uint64 `json:"reallocated"`
	Pending       *uint64 `json:"pending"`
	Uncorrectable *uint64 `json:"uncorrectable"`
	SmartMore
}

// PVEDisk is a row of the Proxmox "Disks and wear" table.
type PVEDisk struct {
	Device  string   `json:"device"`
	Type    string   `json:"type"`
	Model   string   `json:"model"`
	Pool    *string  `json:"pool"`
	WearPct *float64 `json:"wear_pct"`
	TempC   *float64 `json:"temp_c"`
	Health  string   `json:"health"`
	// Health reason, SMART detail and I/O, like Disk.
	HealthReason *string `json:"health_reason"`
	Smart        Smart   `json:"smart"`
	IO           *DiskIO `json:"io"`
}

// Virtualization is the KVM section.
type Virtualization struct {
	Stacks       []string     `json:"stacks"`
	Capabilities Capabilities `json:"capabilities"`
	Allocation   Allocation   `json:"allocation"`
}

// Capabilities is the capability grid.
type Capabilities struct {
	KVM struct {
		Enabled bool   `json:"enabled"`
		Module  string `json:"module"`
		Device  string `json:"device"`
	} `json:"kvm"`
	CPUVirtualization struct {
		Type         string `json:"type"`
		Flag         string `json:"flag"`
		NestedPaging bool   `json:"nested_paging"`
	} `json:"cpu_virtualization"`
	IOMMU struct {
		Enabled        bool `json:"enabled"`
		Groups         int  `json:"groups"`
		VFIOPCIDevices int  `json:"vfio_pci_devices"`
	} `json:"iommu"`
	Nested struct {
		Enabled     bool   `json:"enabled"`
		ModuleParam string `json:"module_param"`
	} `json:"nested"`
	Hugepages *Hugepages `json:"hugepages,omitempty"`
	KSM       struct {
		Running bool    `json:"running"`
		SavedGB float64 `json:"saved_gb"`
	} `json:"ksm"`
	Ballooning struct {
		State     string `json:"state"`
		VMsActive int    `json:"vms_active"`
		VMsTotal  int    `json:"vms_total"`
	} `json:"ballooning"`
}

// Hugepages is the hugepage reservation (standard hosts).
type Hugepages struct {
	ReservedGB float64 `json:"reserved_gb"`
	PageSize   string  `json:"page_size"`
	Count      int     `json:"count"`
}

// Allocation are the four allocation cards (derived from the guests).
type Allocation struct {
	VCPUAllocated          int      `json:"vcpu_allocated"`
	HostThreads            int      `json:"host_threads"`
	VCPUOvercommitRatio    float64  `json:"vcpu_overcommit_ratio"`
	GuestMemoryAssignedGB  float64  `json:"guest_memory_assigned_gb"`
	GuestMemoryAssignedPct float64  `json:"guest_memory_assigned_pct"`
	HostMemoryGB           float64  `json:"host_memory_gb"`
	GuestMemoryInUseGB     float64  `json:"guest_memory_in_use_gb"`
	DiskIOMBs              IOSplit  `json:"disk_io_mbs"`
	NetworkMbps            NetSplit `json:"network_mbps"`
}

// IOSplit is a total with its read/write split.
type IOSplit struct {
	Total float64 `json:"total"`
	Read  float64 `json:"read"`
	Write float64 `json:"write"`
}

// NetSplit is a total with its rx/tx split.
type NetSplit struct {
	Total float64 `json:"total"`
	RX    float64 `json:"rx"`
	TX    float64 `json:"tx"`
}

// PlatformBlock is a workload platform card plus the first page of guests.
type PlatformBlock struct {
	Running     int     `json:"running"`
	Total       int     `json:"total"`
	Stopped     int     `json:"stopped"`
	Unhealthy   int     `json:"unhealthy"`
	Containers  *int    `json:"containers,omitempty"`
	VMs         *int    `json:"vms,omitempty"`
	CPUPct      float64 `json:"cpu_pct"`
	MemoryGB    float64 `json:"memory_gb"`
	GuestsShown int     `json:"guests_shown"`
	Guests      []Guest `json:"guests"`
	Version     *string `json:"version"`
	Error       *string `json:"error"`
	Paused      int     `json:"paused,omitempty"`
	// Warnings of the platform (Incus warnings, Docker daemon warnings).
	Warnings []PlatformWarning `json:"warnings,omitempty"`
}

// ProxmoxGuest are the two Proxmox guest tabs.
type ProxmoxGuest struct {
	VM        *PlatformBlock `json:"vm"`
	Container *PlatformBlock `json:"container"`
}

// Cluster is the Proxmox cluster section.
type Cluster struct {
	Name    string `json:"name"`
	Quorate bool   `json:"quorate"`
	Votes   struct {
		Have     int `json:"have"`
		Expected int `json:"expected"`
	} `json:"votes"`
	HA struct {
		ResourcesStarted int `json:"resources_started"`
		ResourcesTotal   int `json:"resources_total"`
	} `json:"ha"`
	Nodes []ClusterNode `json:"nodes"`
	Note  *string       `json:"note"`
}

// ClusterNode is one node row.
type ClusterNode struct {
	Name       string  `json:"name"`
	ThisNode   bool    `json:"this_node"`
	Status     string  `json:"status"`
	CPUPct     float64 `json:"cpu_pct"`
	MemPct     float64 `json:"mem_pct"`
	VMs        int     `json:"vms"`
	Containers int     `json:"containers"`
	Agent      string  `json:"agent"` // connected | offline | not_enrolled
	ServerID   *string `json:"server_id"`
}

// Storage is a Proxmox storage row.
type Storage struct {
	ID           string   `json:"id"`
	Type         string   `json:"type"`
	Content      string   `json:"content"`
	ContentTypes []string `json:"content_types"`
	UsedGB       float64  `json:"used_gb"`
	CapacityGB   float64  `json:"capacity_gb"`
	UsedPct      float64  `json:"used_pct"`
	Shared       bool     `json:"shared"`
	Active       bool     `json:"active"`
}

// Backups is the Proxmox backups card.
type Backups struct {
	LastJob *BackupJob `json:"last_job"`
	NextRun *Time      `json:"next_run"`
	Target  *string    `json:"target"`
}

// BackupJob is the most recent vzdump job.
type BackupJob struct {
	At                 Time     `json:"at"`
	Schedule           string   `json:"schedule"`
	Mode               string   `json:"mode"`
	Result             string   `json:"result"`
	GuestsOK           int      `json:"guests_ok"`
	GuestsTotal        int      `json:"guests_total"`
	Warnings           int      `json:"warnings"`
	WrittenGB          float64  `json:"written_gb"`
	DedupRatio         *float64 `json:"dedup_ratio"`
	DurationMin        int      `json:"duration_min"`
	AvgDurationMinWeek *int     `json:"avg_duration_min_week"`
}
