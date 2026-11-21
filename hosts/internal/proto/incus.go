package proto

import "time"

// Incus host view (docs/MANAGE.md 2.5, CONTRACT.md "incus"): the projects,
// storage pools, networks, profiles, images and custom volumes of the
// host's Incus. The agent reads it on its slow path (every 5 minutes) and
// again after an Incus lifecycle event that changes one of them; it rides
// on Report.Incus (Platform.Detail).
type IncusDetail struct {
	Clustered bool               `cbor:"clustered,omitempty"`
	Projects  []IncusProject     `cbor:"projects,omitempty"`
	Pools     []IncusPool        `cbor:"pools,omitempty"`
	Networks  []IncusNetwork     `cbor:"networks,omitempty"`
	Profiles  []IncusProfileInfo `cbor:"profiles,omitempty"`
	Images    []IncusImageInfo   `cbor:"images,omitempty"`
	Volumes   []IncusVolume      `cbor:"volumes,omitempty"`
}

// IncusProject is an Incus project with its instance counts.
type IncusProject struct {
	Name        string `cbor:"name"`
	Description string `cbor:"desc,omitempty"`
	Instances   int    `cbor:"instances"`
	Running     int    `cbor:"running"`
}

// IncusPool is a storage pool with its usage (GET …/resources).
type IncusPool struct {
	Name        string  `cbor:"name"`
	Driver      string  `cbor:"driver"`
	Status      string  `cbor:"status,omitempty"` // Created | Pending | Unavailable | Errored
	Description string  `cbor:"desc,omitempty"`
	UsedBytes   *uint64 `cbor:"used,omitempty"`
	TotalBytes  *uint64 `cbor:"total,omitempty"`
	Volumes     int     `cbor:"volumes"` // custom volumes (every project)
}

// IncusNetwork is a managed network or a host bridge Incus can use
// (Docker's own bridges are left out).
type IncusNetwork struct {
	Name        string `cbor:"name"`
	Type        string `cbor:"type"` // bridge | macvlan | ovn | physical | ...
	Managed     bool   `cbor:"managed"`
	Description string `cbor:"desc,omitempty"`
	IPv4        string `cbor:"ipv4,omitempty"` // "10.62.52.1/24"
	IPv6        string `cbor:"ipv6,omitempty"`
	NAT         *bool  `cbor:"nat,omitempty"` // managed bridges: ipv4.nat
	UsedBy      int    `cbor:"used_by"`
}

// IncusProfileInfo is a profile in the host view; profile.get has the
// whole profile (IncusProfile).
type IncusProfileInfo struct {
	Name        string `cbor:"name"`
	Project     string `cbor:"project"`
	Description string `cbor:"desc,omitempty"`
	UsedBy      int    `cbor:"used_by"`
}

// IncusImageInfo is an image of the local image store.
type IncusImageInfo struct {
	Fingerprint  string     `cbor:"fp"`
	Aliases      []string   `cbor:"aliases,omitempty"`
	Description  string     `cbor:"desc,omitempty"`
	Type         string     `cbor:"type"` // container | virtual-machine
	Architecture string     `cbor:"arch,omitempty"`
	SizeBytes    uint64     `cbor:"size,omitempty"`
	UploadedAt   *time.Time `cbor:"uploaded,omitempty"`
	LastUsedAt   *time.Time `cbor:"last_used,omitempty"`
	AutoUpdate   bool       `cbor:"auto_update,omitempty"`
	Cached       bool       `cbor:"cached,omitempty"`
	Project      string     `cbor:"project"`
}

// IncusVolume is a custom storage volume. UsedBy are the platform ids of
// the instances that attach it ("web", "lab/db").
type IncusVolume struct {
	Pool        string   `cbor:"pool"`
	Name        string   `cbor:"name"`
	Project     string   `cbor:"project"`
	ContentType string   `cbor:"content"` // filesystem | block | iso
	SizeBytes   *uint64  `cbor:"size,omitempty"`
	UsedBytes   *uint64  `cbor:"used,omitempty"`
	UsedBy      []string `cbor:"used_by,omitempty"`
	Description string   `cbor:"desc,omitempty"`
}

// ---- manage answers (Incus) ----------------------------------------------------

// IncusProfile is profile.get's answer. Config and Devices are the
// profile's own; Restricted names the config keys and "device.<name>"
// entries outside Whombat's allowlist (shown, never changed); UsedBy are
// instance platform ids; Digest is the ETag (profile.update's If-Match).
type IncusProfile struct {
	Name        string                       `cbor:"name" json:"name"`
	Project     string                       `cbor:"project" json:"project"`
	Description string                       `cbor:"desc,omitempty" json:"description"`
	Config      map[string]string            `cbor:"config,omitempty" json:"config"`
	Devices     map[string]map[string]string `cbor:"devices,omitempty" json:"devices"`
	UsedBy      []string                     `cbor:"used_by,omitempty" json:"used_by"`
	Restricted  []string                     `cbor:"restricted,omitempty" json:"restricted"`
	Digest      string                       `cbor:"digest" json:"digest"`
}

// IncusLease is an address lease of a managed network. GuestID is the
// instance's platform id when the lease belongs to one.
type IncusLease struct {
	Hostname string `cbor:"hostname,omitempty" json:"hostname"`
	Address  string `cbor:"address" json:"address"`
	HWAddr   string `cbor:"hwaddr,omitempty" json:"hwaddr"`
	Type     string `cbor:"type,omitempty" json:"type"` // static | dynamic | gateway | uplink
	GuestID  string `cbor:"guest,omitempty" json:"-"`
}

// GuestLog is the end of a guest's platform log (Incus lxc.log / qemu.log).
type GuestLog struct {
	File  string   `cbor:"file" json:"file"`
	Lines []string `cbor:"lines" json:"lines"`
}

// RemoteImage is an image of the public image server offered when
// creating an instance (Choices.RemoteImages).
type RemoteImage struct {
	Alias       string `cbor:"alias" json:"alias"`                // "debian/13", "debian/13/cloud"
	Description string `cbor:"desc,omitempty" json:"description"` // "Debian 13 (trixie)"
	Type        string `cbor:"type" json:"type"`                  // container | virtual-machine
}
