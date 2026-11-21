package proto

import "time"

// StreamDiskUsage is the hub-opened RPC stream for an on-request disk usage
// breakdown of one mounted filesystem:
//
//	StreamHeader{Kind: StreamDiskUsage} -> DiskUsageRequest -> DiskUsageResponse
//
// Additive within proto.Version = 1; older agents close unknown streams without
// answering. Controlled by Policy.Diagnose on the agent and the hub's diagnose
// switch (both on by default, operator role).
const StreamDiskUsage = "disk_usage"

// DiskUsageRequest asks the agent what fills one mounted filesystem.
type DiskUsageRequest struct {
	// Mount is the target mount point (for example "/" or "/var/lib/docker").
	Mount string `cbor:"mount"`
	// MaxDepth limits directory recursion below Mount (0 = agent default).
	MaxDepth int `cbor:"max_depth,omitempty"`
	// TimeoutS limits total runtime in seconds (0 = agent default).
	TimeoutS int `cbor:"timeout_s,omitempty"`
}

// Well-known category keys in DiskUsageCategory.Key.
const (
	DiskCatContainerImages     = "container_images"
	DiskCatContainerBuildCache = "container_build_cache"
	DiskCatContainerVolumes    = "container_volumes"
	DiskCatContainerLogs       = "container_logs"
	DiskCatJournal             = "journal"
	DiskCatPackageCache        = "package_cache"
	DiskCatVMDisks             = "vm_disks"
	DiskCatVMSnapshots         = "vm_snapshots"
)

// DiskUsageCategory is one recognised bucket of space on the requested mount.
type DiskUsageCategory struct {
	Key              string `cbor:"key" json:"key"`
	Label            string `cbor:"label" json:"label"`
	Bytes            uint64 `cbor:"bytes" json:"bytes"`
	ReclaimableBytes uint64 `cbor:"reclaimable,omitempty" json:"reclaimable_bytes,omitempty"`
	Detail           string `cbor:"detail,omitempty" json:"detail,omitempty"`
}

// DiskUsageFolder is one large directory on the requested mount.
type DiskUsageFolder struct {
	Path    string `cbor:"path" json:"path"`
	Bytes   uint64 `cbor:"bytes" json:"bytes"`
	Partial bool   `cbor:"partial,omitempty" json:"partial,omitempty"`
}

// DiskUsageResponse is the agent's on-request breakdown for one mount point.
type DiskUsageResponse struct {
	// Code is empty when the measurement ran (even if Partial is true).
	// Non-empty values: remote_control_disabled, unsupported, invalid_request,
	// spun_down, busy, failed.
	Code    string `cbor:"code,omitempty" json:"code,omitempty"`
	Message string `cbor:"msg,omitempty" json:"message,omitempty"`

	Mount      string    `cbor:"mount,omitempty" json:"mount,omitempty"`
	FSType     string    `cbor:"fstype,omitempty" json:"fs_type,omitempty"`
	Device     string    `cbor:"dev,omitempty" json:"device,omitempty"`
	MeasuredAt time.Time `cbor:"at,omitempty" json:"measured_at,omitempty"`
	DurationMs int64     `cbor:"dur_ms,omitempty" json:"duration_ms,omitempty"`

	TotalBytes uint64 `cbor:"total,omitempty" json:"total_bytes,omitempty"`
	UsedBytes  uint64 `cbor:"used,omitempty" json:"used_bytes,omitempty"`
	// Partial is true when the time limit, depth limit or entry cap cut the walk short.
	Partial bool `cbor:"partial,omitempty" json:"partial,omitempty"`
	// SkippedSpunDown lists disks that were asleep and therefore not touched.
	SkippedSpunDown []string `cbor:"spun_down,omitempty" json:"skipped_spun_down,omitempty"`

	Categories []DiskUsageCategory `cbor:"cats,omitempty" json:"categories,omitempty"`
	Folders    []DiskUsageFolder   `cbor:"folders,omitempty" json:"folders,omitempty"`
}
