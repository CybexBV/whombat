package collect

import (
	"context"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"rackoon/internal/proto"
)

// The Incus host view (proto.IncusDetail): projects, storage pools with
// their usage, networks, profiles, images and custom volumes. Read on the
// slow path (incusSlowEvery) and after a lifecycle event that changes one
// of them; the projects' instance counts follow every run.

// incusDockerBridge matches the bridges Docker makes (docker0, br-<12 hex>):
// Incus lists them as unmanaged bridges, but no instance belongs on them.
var incusDockerBridge = regexp.MustCompile(`^(docker0|br-[0-9a-f]{12})$`)

type incusProjectRaw struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

type incusPoolRaw struct {
	Name        string            `json:"name"`
	Driver      string            `json:"driver"`
	Status      string            `json:"status"`
	Description string            `json:"description"`
	Config      map[string]string `json:"config"`
}

type incusPoolResources struct {
	Space struct {
		Used  uint64 `json:"used"`
		Total uint64 `json:"total"`
	} `json:"space"`
}

type incusVolumeRaw struct {
	Name        string            `json:"name"`
	Type        string            `json:"type"`
	Project     string            `json:"project"`
	ContentType string            `json:"content_type"`
	Description string            `json:"description"`
	Config      map[string]string `json:"config"`
	UsedBy      []string          `json:"used_by"`
}

type incusNetworkRaw struct {
	Name        string            `json:"name"`
	Type        string            `json:"type"`
	Managed     bool              `json:"managed"`
	Description string            `json:"description"`
	Config      map[string]string `json:"config"`
	UsedBy      []string          `json:"used_by"`
}

type incusProfileRaw struct {
	Name        string   `json:"name"`
	Project     string   `json:"project"`
	Description string   `json:"description"`
	UsedBy      []string `json:"used_by"`
}

type incusImageRaw struct {
	Fingerprint string `json:"fingerprint"`
	Aliases     []struct {
		Name string `json:"name"`
	} `json:"aliases"`
	Properties   map[string]string `json:"properties"`
	Type         string            `json:"type"`
	Architecture string            `json:"architecture"`
	Size         int64             `json:"size"`
	UploadedAt   time.Time         `json:"uploaded_at"`
	LastUsedAt   time.Time         `json:"last_used_at"`
	AutoUpdate   bool              `json:"auto_update"`
	Cached       bool              `json:"cached"`
	Project      string            `json:"project"`
}

// incusTime is a time Incus reported, nil for its zero values ("0001-…",
// 1970).
func incusTime(t time.Time) *time.Time {
	if t.IsZero() || t.Year() <= 1970 {
		return nil
	}
	u := t.UTC()
	return &u
}

// incusInstanceRef turns an instance URL ("/1.0/instances/web?project=lab")
// into its platform id ("lab/web"); "" for other URLs.
func incusInstanceRef(raw, project string) string {
	ev := incusEvent{Project: project}
	ev.Metadata.Source = raw
	return incusEventGuest(&ev)
}

// readDetail reads the host view. A part that cannot be read is left out
// (an older Incus without all-projects listings, a pool without
// resources); an error is returned only when nothing could be read.
func (x *incusCollector) readDetail(ctx context.Context, clustered bool) (*proto.IncusDetail, error) {
	d := &proto.IncusDetail{Clustered: clustered}
	var firstErr error
	keep := func(err error) bool {
		if err != nil && firstErr == nil {
			firstErr = err
		}
		return err == nil
	}
	read := 0

	var projects []incusProjectRaw
	if keep(x.get(ctx, "/1.0/projects?recursion=1", &projects)) {
		read++
		for _, p := range projects {
			d.Projects = append(d.Projects, proto.IncusProject{Name: p.Name, Description: p.Description})
		}
		sort.Slice(d.Projects, func(i, j int) bool { return d.Projects[i].Name < d.Projects[j].Name })
	}

	var pools []incusPoolRaw
	if keep(x.get(ctx, "/1.0/storage-pools?recursion=1", &pools)) {
		read++
		for _, p := range pools {
			pp := proto.IncusPool{Name: p.Name, Driver: p.Driver, Status: p.Status, Description: p.Description}
			var res incusPoolResources
			if p.Driver != "cephobject" && x.get(ctx, "/1.0/storage-pools/"+url.PathEscape(p.Name)+"/resources", &res) == nil && res.Space.Total > 0 {
				pp.UsedBytes, pp.TotalBytes = ptr(res.Space.Used), ptr(res.Space.Total)
			}
			var vols []incusVolumeRaw
			if x.get(ctx, "/1.0/storage-pools/"+url.PathEscape(p.Name)+"/volumes?recursion=1&all-projects=true", &vols) == nil {
				for _, v := range vols {
					if v.Type != "custom" {
						continue
					}
					pp.Volumes++
					d.Volumes = append(d.Volumes, x.volume(ctx, p.Name, v))
				}
			}
			d.Pools = append(d.Pools, pp)
		}
		sort.Slice(d.Pools, func(i, j int) bool { return d.Pools[i].Name < d.Pools[j].Name })
		sort.Slice(d.Volumes, func(i, j int) bool {
			a, b := d.Volumes[i], d.Volumes[j]
			if a.Pool != b.Pool {
				return a.Pool < b.Pool
			}
			if a.Project != b.Project {
				return a.Project < b.Project
			}
			return a.Name < b.Name
		})
	}

	var nets []incusNetworkRaw
	if keep(x.get(ctx, "/1.0/networks?recursion=1", &nets)) {
		read++
		for _, n := range nets {
			if !n.Managed && (n.Type != "bridge" || incusDockerBridge.MatchString(n.Name)) {
				continue // physical cards, loopback, veths, Docker's bridges
			}
			nn := proto.IncusNetwork{Name: n.Name, Type: n.Type, Managed: n.Managed, Description: n.Description, UsedBy: len(n.UsedBy)}
			if a := n.Config["ipv4.address"]; a != "" && a != "none" {
				nn.IPv4 = a
			}
			if a := n.Config["ipv6.address"]; a != "" && a != "none" {
				nn.IPv6 = a
			}
			if n.Managed && n.Type == "bridge" {
				on := false
				if v, err := strconv.ParseBool(n.Config["ipv4.nat"]); err == nil {
					on = v
				}
				nn.NAT = &on
			}
			d.Networks = append(d.Networks, nn)
		}
		sort.Slice(d.Networks, func(i, j int) bool { return d.Networks[i].Name < d.Networks[j].Name })
	}

	var profiles []incusProfileRaw
	if keep(x.get(ctx, "/1.0/profiles?recursion=1&all-projects=true", &profiles)) {
		read++
		for _, p := range profiles {
			project := p.Project
			if project == "" {
				project = "default"
			}
			d.Profiles = append(d.Profiles, proto.IncusProfileInfo{Name: p.Name, Project: project, Description: p.Description, UsedBy: len(p.UsedBy)})
		}
		sort.Slice(d.Profiles, func(i, j int) bool {
			if d.Profiles[i].Project != d.Profiles[j].Project {
				return d.Profiles[i].Project < d.Profiles[j].Project
			}
			return d.Profiles[i].Name < d.Profiles[j].Name
		})
	}

	var images []incusImageRaw
	if keep(x.get(ctx, "/1.0/images?recursion=1&all-projects=true", &images)) {
		read++
		for _, im := range images {
			ii := proto.IncusImageInfo{Fingerprint: im.Fingerprint, Description: im.Properties["description"], Type: im.Type,
				Architecture: im.Architecture, UploadedAt: incusTime(im.UploadedAt), LastUsedAt: incusTime(im.LastUsedAt),
				AutoUpdate: im.AutoUpdate, Cached: im.Cached, Project: im.Project}
			if ii.Project == "" {
				ii.Project = "default"
			}
			if im.Size > 0 {
				ii.SizeBytes = uint64(im.Size)
			}
			for _, a := range im.Aliases {
				ii.Aliases = append(ii.Aliases, a.Name)
			}
			d.Images = append(d.Images, ii)
		}
		sort.Slice(d.Images, func(i, j int) bool {
			a, b := d.Images[i], d.Images[j]
			if (len(a.Aliases) > 0) != (len(b.Aliases) > 0) {
				return len(a.Aliases) > 0
			}
			if len(a.Aliases) > 0 && a.Aliases[0] != b.Aliases[0] {
				return a.Aliases[0] < b.Aliases[0]
			}
			if !timeEq(a.UploadedAt, b.UploadedAt) {
				return a.UploadedAt != nil && (b.UploadedAt == nil || a.UploadedAt.After(*b.UploadedAt))
			}
			return a.Fingerprint < b.Fingerprint
		})
	}
	if read == 0 {
		return nil, firstErr
	}
	return d, nil
}

func timeEq(a, b *time.Time) bool {
	if a == nil || b == nil {
		return a == b
	}
	return a.Equal(*b)
}

// volume converts a custom volume and reads its usage.
func (x *incusCollector) volume(ctx context.Context, pool string, v incusVolumeRaw) proto.IncusVolume {
	project := v.Project
	if project == "" {
		project = "default"
	}
	out := proto.IncusVolume{Pool: pool, Name: v.Name, Project: project, ContentType: v.ContentType, Description: v.Description}
	if out.ContentType == "" {
		out.ContentType = "filesystem"
	}
	if n, err := parseByteSize(v.Config["size"]); err == nil && n > 0 {
		out.SizeBytes = ptr(n)
	}
	for _, u := range v.UsedBy {
		if id := incusInstanceRef(u, project); id != "" {
			out.UsedBy = append(out.UsedBy, id)
		}
	}
	sort.Strings(out.UsedBy)
	var st struct {
		Usage *struct {
			Used uint64 `json:"used"`
		} `json:"usage"`
	}
	path := "/1.0/storage-pools/" + url.PathEscape(pool) + "/volumes/custom/" + url.PathEscape(v.Name) + "/state?project=" + url.QueryEscape(project)
	if x.get(ctx, path, &st) == nil && st.Usage != nil && st.Usage.Used > 0 {
		out.UsedBytes = ptr(st.Usage.Used)
	}
	return out
}

// withCounts copies the host view with each project's instance counts
// from the current instance list.
func incusWithCounts(d *proto.IncusDetail, insts []incusInstance) *proto.IncusDetail {
	if d == nil {
		return nil
	}
	cp := *d
	cp.Projects = make([]proto.IncusProject, len(d.Projects))
	copy(cp.Projects, d.Projects)
	idx := map[string]int{}
	for i, p := range cp.Projects {
		idx[p.Name] = i
		cp.Projects[i].Instances, cp.Projects[i].Running = 0, 0
	}
	for i := range insts {
		p := insts[i].Project
		if p == "" {
			p = "default"
		}
		j, ok := idx[p]
		if !ok {
			continue
		}
		cp.Projects[j].Instances++
		if insts[i].Status == "Running" {
			cp.Projects[j].Running++
		}
	}
	return &cp
}

// incusMACs are an instance's network card addresses: volatile.<nic>.hwaddr
// and hwaddr set on a NIC device, lower case, each once, sorted.
func incusMACs(in *incusInstance) []string {
	seen := map[string]bool{}
	add := func(s string) {
		s = strings.ToLower(strings.TrimSpace(s))
		if validMAC(s) {
			seen[s] = true
		}
	}
	for k, v := range in.ExpandedConfig {
		if strings.HasPrefix(k, "volatile.") && strings.HasSuffix(k, ".hwaddr") {
			add(v)
		}
	}
	for _, dev := range in.ExpandedDevices {
		if dev["type"] == "nic" {
			add(dev["hwaddr"])
		}
	}
	return sortedKeys(seen)
}

var macRE = regexp.MustCompile(`^[0-9a-f]{2}(:[0-9a-f]{2}){5}$`)

// validMAC: six lower-case hex pairs, not all zero.
func validMAC(s string) bool { return macRE.MatchString(s) && s != "00:00:00:00:00:00" }

func sortedKeys(m map[string]bool) []string {
	if len(m) == 0 {
		return nil
	}
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// incusDetailEvent reports whether a lifecycle action changes the host
// view or the instances' backups (read again with the next run).
func incusDetailEvent(action string) bool {
	for _, p := range []string{"instance-backup-", "storage-pool-", "storage-volume-", "image-", "profile-", "network-", "project-"} {
		if strings.HasPrefix(action, p) {
			return true
		}
	}
	switch action {
	case "instance-created", "instance-deleted", "instance-renamed", "instance-updated":
		return true
	}
	return false
}
