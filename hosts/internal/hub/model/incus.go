package model

import (
	"rackoon/internal/proto"
)

// IncusDetail is the "incus" part of GET /servers/{id} (CONTRACT.md,
// "incus"): the host's Incus projects, storage pools, networks, profiles,
// images and custom volumes, from the agent's report.
type IncusDetail struct {
	Version   string          `json:"version"`
	Clustered bool            `json:"clustered"`
	Projects  []IncusProject  `json:"projects"`
	Pools     []IncusPool     `json:"pools"`
	Networks  []IncusNetwork  `json:"networks"`
	Profiles  []IncusProfile  `json:"profiles"`
	Images    []IncusImage    `json:"images"`
	Volumes   []StorageVolume `json:"volumes"`
}

// IncusProject is a project with its instance counts.
type IncusProject struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Instances   int    `json:"instances"`
	Running     int    `json:"running"`
}

// IncusPool is a storage pool (bytes null when Incus cannot tell).
type IncusPool struct {
	Name        string  `json:"name"`
	Driver      string  `json:"driver"`
	Status      string  `json:"status"`
	Description string  `json:"description"`
	UsedBytes   *uint64 `json:"used_bytes"`
	TotalBytes  *uint64 `json:"total_bytes"`
	Volumes     int     `json:"volumes"`
}

// IncusNetwork is a managed network or a host bridge.
type IncusNetwork struct {
	Name        string  `json:"name"`
	Type        string  `json:"type"`
	Managed     bool    `json:"managed"`
	Description string  `json:"description"`
	IPv4        *string `json:"ipv4"`
	IPv6        *string `json:"ipv6"`
	NAT         *bool   `json:"nat"`
	UsedBy      int     `json:"used_by"`
}

// IncusProfile is a profile in the list (profile.get has all of it).
type IncusProfile struct {
	Name        string `json:"name"`
	Project     string `json:"project"`
	Description string `json:"description"`
	UsedBy      int    `json:"used_by"`
}

// IncusImage is an image of the local store.
type IncusImage struct {
	Fingerprint  string   `json:"fingerprint"`
	Aliases      []string `json:"aliases"`
	Description  string   `json:"description"`
	Type         string   `json:"type"`
	Architecture string   `json:"architecture"`
	SizeBytes    uint64   `json:"size_bytes"`
	UploadedAt   *Time    `json:"uploaded_at"`
	LastUsedAt   *Time    `json:"last_used_at"`
	AutoUpdate   bool     `json:"auto_update"`
	Cached       bool     `json:"cached"`
	Project      string   `json:"project"`
}

// StorageVolume is a custom storage volume; UsedBy are hub guest ids.
type StorageVolume struct {
	Pool        string   `json:"pool"`
	Name        string   `json:"name"`
	Project     string   `json:"project"`
	Type        string   `json:"type"` // custom
	ContentType string   `json:"content_type"`
	SizeBytes   *uint64  `json:"size_bytes"`
	UsedBytes   *uint64  `json:"used_bytes"`
	UsedBy      []string `json:"used_by"`
	Description string   `json:"description"`
}

// BuildIncus maps the report's Incus host view (nil without one).
func BuildIncus(r *proto.Report) *IncusDetail {
	if r == nil || r.Incus == nil || r.Incus.Incus == nil {
		return nil
	}
	in := r.Incus.Incus
	d := &IncusDetail{Version: r.Incus.Version, Clustered: in.Clustered, Projects: []IncusProject{}, Pools: []IncusPool{},
		Networks: []IncusNetwork{}, Profiles: []IncusProfile{}, Images: []IncusImage{}, Volumes: []StorageVolume{}}
	for _, p := range in.Projects {
		d.Projects = append(d.Projects, IncusProject{Name: p.Name, Description: p.Description, Instances: p.Instances, Running: p.Running})
	}
	for _, p := range in.Pools {
		d.Pools = append(d.Pools, IncusPool{Name: p.Name, Driver: p.Driver, Status: p.Status, Description: p.Description,
			UsedBytes: p.UsedBytes, TotalBytes: p.TotalBytes, Volumes: p.Volumes})
	}
	for _, n := range in.Networks {
		d.Networks = append(d.Networks, IncusNetwork{Name: n.Name, Type: n.Type, Managed: n.Managed, Description: n.Description,
			IPv4: strp(n.IPv4), IPv6: strp(n.IPv6), NAT: n.NAT, UsedBy: n.UsedBy})
	}
	for _, p := range in.Profiles {
		d.Profiles = append(d.Profiles, IncusProfile{Name: p.Name, Project: p.Project, Description: p.Description, UsedBy: p.UsedBy})
	}
	for _, im := range in.Images {
		ii := IncusImage{Fingerprint: im.Fingerprint, Aliases: im.Aliases, Description: im.Description, Type: im.Type,
			Architecture: im.Architecture, SizeBytes: im.SizeBytes, AutoUpdate: im.AutoUpdate, Cached: im.Cached, Project: im.Project}
		if ii.Aliases == nil {
			ii.Aliases = []string{}
		}
		if im.UploadedAt != nil {
			ii.UploadedAt = T(*im.UploadedAt)
		}
		if im.LastUsedAt != nil {
			ii.LastUsedAt = T(*im.LastUsedAt)
		}
		d.Images = append(d.Images, ii)
	}
	for _, v := range in.Volumes {
		sv := StorageVolume{Pool: v.Pool, Name: v.Name, Project: v.Project, Type: "custom", ContentType: v.ContentType,
			SizeBytes: v.SizeBytes, UsedBytes: v.UsedBytes, UsedBy: []string{}, Description: v.Description}
		for _, id := range v.UsedBy {
			sv.UsedBy = append(sv.UsedBy, GuestID(proto.PlatformIncus, id))
		}
		d.Volumes = append(d.Volumes, sv)
	}
	return d
}

// HostsThisWhombat reports whether one of the report's guests is the
// machine the hosts service runs in (Guest.Self, set by the hub).
func HostsThisWhombat(r *proto.Report) bool {
	if r == nil {
		return false
	}
	for _, g := range r.AllGuests() {
		if g.Self {
			return true
		}
	}
	return false
}
