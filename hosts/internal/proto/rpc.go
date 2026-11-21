package proto

import "time"

// More hub-initiated stream kinds.
const (
	// StreamInspect: InspectRequest -> InspectResponse. Read-only, on-demand
	// views of the host and its guests that the hub never stores.
	StreamInspect = "inspect"
	// StreamUpdate: UpdateRequest, then the binary as UpdateChunk messages,
	// -> UpdateResponse. The agent verifies the signature, replaces its
	// executable and restarts itself.
	StreamUpdate = "update"
)

// More control-stream message types.
const (
	// MsgChecks (hub -> agent) replaces the set of checks the agent runs
	// (CheckSpecs). Sent after HelloAck and whenever the set changes.
	MsgChecks = "checks"
)

// PlatformHost addresses the host itself in console, inspect and action
// requests (GuestID "host").
const PlatformHost = "host"

// More actions. Snapshots need the power permission; host actions need the
// host power permission.
const (
	ActionPause           = "pause"  // VMs and containers (Docker pause, Incus freeze, libvirt suspend)
	ActionResume          = "resume" // undoes pause
	ActionSnapshotCreate  = "snapshot_create"
	ActionSnapshotRestore = "snapshot_restore"
	ActionSnapshotDelete  = "snapshot_delete"
	ActionHostReboot      = "host_reboot"
	ActionHostShutdown    = "host_shutdown"
)

// ActionArgs are the arguments of the snapshot actions (ActionRequest.Args).
const (
	ArgSnapshot    = "snapshot"    // snapshot name (create: optional, default "whombat-<UTC time>")
	ArgDescription = "description" // create
	ArgWithMemory  = "memory"      // create: "true" to include VM memory state (PVE / libvirt)
)

// Console protocols in addition to vnc / spice / serial / shell / tty.
const (
	// ProtoLogs is a read-only stream: Docker container logs (the last 500
	// lines, then followed) or, for the host, the systemd journal.
	ProtoLogs = "logs"
)

// Inspect kinds.
const (
	InspectProcesses = "processes" // host: top processes
	InspectPorts     = "ports"     // host: listening sockets
	InspectServices  = "services"  // host: systemd units (or OpenRC services)
	InspectUpdates   = "updates"   // host: pending package updates
	InspectSnapshots = "snapshots" // guest: snapshots
)

// InspectRequest asks for one view. Platform/GuestID name a guest for
// guest views (snapshots) and are PlatformHost/"host" for host views.
type InspectRequest struct {
	Kind     string `cbor:"kind"`
	Platform string `cbor:"platform"`
	GuestID  string `cbor:"guest"`
	// Limit bounds the rows (0 = the agent's default: 100 processes, 500
	// sockets, 1000 units, 2000 packages).
	Limit int `cbor:"limit,omitempty"`
}

// InspectResponse carries one of the lists, or an error code.
type InspectResponse struct {
	Code      string `cbor:"code,omitempty"`
	Message   string `cbor:"msg,omitempty"`
	Truncated bool   `cbor:"truncated,omitempty"`

	Processes []Process       `cbor:"procs,omitempty"`
	Ports     []ListenPort    `cbor:"ports,omitempty"`
	Services  []Service       `cbor:"services,omitempty"`
	Updates   []PackageUpdate `cbor:"updates,omitempty"`
	Snapshots []Snapshot      `cbor:"snapshots,omitempty"`
}

// Process is one row of the process list, sorted by CPU.
type Process struct {
	PID      int     `cbor:"pid" json:"pid"`
	PPID     int     `cbor:"ppid,omitempty" json:"ppid,omitempty"`
	User     string  `cbor:"user" json:"user"`
	Name     string  `cbor:"name" json:"name"`
	Command  string  `cbor:"cmd" json:"command"` // command line, at most 512 bytes
	CPUPct   float64 `cbor:"cpu" json:"cpu_pct"` // percent of one core over ~1 s
	RSSBytes uint64  `cbor:"rss" json:"rss_bytes"`
	State    string  `cbor:"state" json:"state"` // R S D Z T I
	Threads  int     `cbor:"threads,omitempty" json:"threads,omitempty"`
	// Container is the guest the process belongs to, from its cgroup
	// ("docker:web", "incus:dev-shell", "pve:101"), when known.
	Container string    `cbor:"container,omitempty" json:"container,omitempty"`
	Started   time.Time `cbor:"started,omitempty" json:"started,omitzero"`
}

// ListenPort is a listening TCP socket or a bound UDP socket.
type ListenPort struct {
	Proto   string `cbor:"proto" json:"proto"`  // tcp | tcp6 | udp | udp6
	Address string `cbor:"addr" json:"address"` // "0.0.0.0", "::", "127.0.0.1"
	Port    int    `cbor:"port" json:"port"`
	PID     int    `cbor:"pid,omitempty" json:"pid,omitempty"`
	Process string `cbor:"process,omitempty" json:"process,omitempty"`
}

// Service is one systemd unit (type service and timer) or init script.
type Service struct {
	Name        string    `cbor:"name" json:"name"`
	Description string    `cbor:"desc,omitempty" json:"description,omitempty"`
	Load        string    `cbor:"load,omitempty" json:"load,omitempty"`       // loaded | not-found | masked
	Active      string    `cbor:"active" json:"active"`                       // active | inactive | failed | activating
	Sub         string    `cbor:"sub,omitempty" json:"sub,omitempty"`         // running | exited | dead | failed
	Enabled     string    `cbor:"enabled,omitempty" json:"enabled,omitempty"` // enabled | disabled | static
	Since       time.Time `cbor:"since,omitempty" json:"since,omitzero"`
}

// PackageUpdate is one pending package update.
type PackageUpdate struct {
	Name     string `cbor:"name" json:"name"`
	Current  string `cbor:"cur,omitempty" json:"current,omitempty"`
	New      string `cbor:"new" json:"new"`
	Security bool   `cbor:"sec,omitempty" json:"security,omitempty"`
	Source   string `cbor:"src,omitempty" json:"source,omitempty"` // repository / origin
}

// Snapshot is a guest snapshot.
type Snapshot struct {
	Name        string    `cbor:"name" json:"name"`
	Created     time.Time `cbor:"created,omitempty" json:"created,omitzero"`
	Description string    `cbor:"desc,omitempty" json:"description,omitempty"`
	Parent      string    `cbor:"parent,omitempty" json:"parent,omitempty"`
	WithMemory  bool      `cbor:"memory,omitempty" json:"memory,omitempty"` // includes VM RAM state
	Current     bool      `cbor:"current,omitempty" json:"current,omitempty"`
	SizeBytes   *uint64   `cbor:"size,omitempty" json:"size_bytes,omitempty"`
}

// UpdateRequest starts a self-update. Size bytes of the new executable
// follow as UpdateChunk messages. Signature is the Ed25519 signature of
// the SHA-256 digest (raw 32 bytes) made with the build's update key; the
// agent refuses an update that does not verify with its embedded public
// key, whose Version equals its own, or whose Arch is not its own.
type UpdateRequest struct {
	Version   string `cbor:"version"`
	Arch      string `cbor:"arch"`
	Size      int64  `cbor:"size"`
	SHA256    []byte `cbor:"sha256"`
	Signature []byte `cbor:"sig"`
	// Component is what the update replaces: "" the agent itself,
	// UpdateComponentHelper Whombat Helper on a Mac (the zip of its app,
	// Arch HelperArch, Version the app's). The hub sends a helper only to
	// an agent that reports CapHelperUpdate.
	Component string `cbor:"component,omitempty"`
	// Team is the Apple team id the hub's build names for the helper's
	// Developer ID signature ("" = none named).
	Team string `cbor:"team,omitempty"`
}

// Update components and the helper's architecture.
const (
	UpdateComponentHelper = "helper"
	HelperArch            = "universal" // one app for Apple silicon and Intel
)

// UpdateChunk is one piece of the executable (at most 1 MiB).
type UpdateChunk struct {
	Data []byte `cbor:"d"`
}

// UpdateResponse is sent after the new executable was verified and
// installed, right before the agent restarts into it (or with an error).
type UpdateResponse struct {
	OK      bool   `cbor:"ok"`
	Code    string `cbor:"code,omitempty"` // update_disabled | bad_signature | same_version | older_version | wrong_arch | install_failed | no_answer (helper)
	Message string `cbor:"msg,omitempty"`
}

// Check kinds.
const (
	CheckHTTP = "http" // GET (or HEAD) a URL: status, optional keyword, TLS expiry
	CheckTCP  = "tcp"  // connect to host:port (TLS expiry with TLS set)
	CheckPing = "ping" // ICMP echo
	CheckDNS  = "dns"  // resolve a name (optionally at a given server)
)

// CheckSpec is a check the hub asks an agent to run (MsgChecks body:
// CheckSpecs). The agent runs each on its interval and reports the latest
// result in Report.Checks.
type CheckSpec struct {
	ID        string `cbor:"id"`
	Kind      string `cbor:"kind"`
	Target    string `cbor:"target"`   // URL, host:port, host, or DNS name
	IntervalS int    `cbor:"interval"` // 30..3600
	TimeoutS  int    `cbor:"timeout"`  // 1..60
	// HTTP: accepted status codes ("200-299,301"), default "200-399";
	// Keyword must appear in the first 1 MiB of the body when set.
	ExpectStatus string `cbor:"status,omitempty"`
	Keyword      string `cbor:"keyword,omitempty"`
	// TLS: for tcp, do a TLS handshake (and report the certificate expiry);
	// InsecureTLS skips certificate verification (expiry still reported).
	TLS         bool `cbor:"tls,omitempty"`
	InsecureTLS bool `cbor:"insecure,omitempty"`
	// DNS: record type (A, AAAA, CNAME, MX, TXT; default A), resolver
	// ("host:port", default the system resolver) and expected answer
	// (substring of one record, optional).
	DNSType   string `cbor:"dns_type,omitempty"`
	DNSServer string `cbor:"dns_server,omitempty"`
	Expect    string `cbor:"expect,omitempty"`
}

// CheckSpecs is the body of MsgChecks.
type CheckSpecs struct {
	Checks []CheckSpec `cbor:"checks"`
}

// CheckResult is the outcome of one check run.
type CheckResult struct {
	ID           string     `cbor:"id"`
	At           time.Time  `cbor:"at"`
	OK           bool       `cbor:"ok"`
	LatencyMs    *float64   `cbor:"ms,omitempty"`
	Error        string     `cbor:"err,omitempty"`
	StatusCode   int        `cbor:"status,omitempty"` // HTTP
	CertNotAfter *time.Time `cbor:"cert,omitempty"`   // TLS certificate expiry
	Answer       []string   `cbor:"answer,omitempty"` // DNS records, at most 8
}
