package hub

import (
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"rackoon/internal/hub/model"
	"rackoon/internal/proto"
)

// ---- managing Incus (docs/MANAGE.md 2.5, REST-API.md "Manage") ------------------
//
// The Incus routes join the manage table (manage.go) at start, and the
// shared routes take the Incus fields: create in a project with a pool, a
// network and cloud-init user data, clone into a project, backups with a
// name and an expiry, restore as a new instance, choices of a project,
// devices and profiles in a configuration change. Roles, re-authentication,
// confirmations and the audit work as for Proxmox VE.

// incusRoutes are the Incus-only routes.
var incusRoutes = []manageRoute{
	{method: "GET", path: "/guests/{guestId}/log", op: proto.OpLogGet, query: []string{"lines"}},
	{method: "POST", path: "/guests/{guestId}/rename", op: proto.OpRename, admin: true, body: []string{"name"}},
	{method: "POST", path: "/guests/{guestId}/move", op: proto.OpMove, admin: true, body: []string{"pool", "project", "confirm"}},
	{method: "POST", path: "/guests/{guestId}/publish", op: proto.OpPublish, admin: true, body: []string{"alias", "description", "snapshot"}},
	{method: "GET", path: "/incus/networks/{network}/leases", op: proto.OpNetworkLeases, query: []string{"project"}},
	{method: "GET", path: "/incus/profiles/{profile}", op: proto.OpProfileGet, query: []string{"project"}},
	{method: "POST", path: "/incus/profiles", op: proto.OpProfileCreate, admin: true, body: []string{"name", "description", "copy_from", "project"}},
	{method: "PUT", path: "/incus/profiles/{profile}", op: proto.OpProfileUpdate, admin: true,
		body: []string{"project", "digest", "set", "delete", "devices", "description"}},
	{method: "DELETE", path: "/incus/profiles/{profile}", op: proto.OpProfileDelete, admin: true, query: []string{"project", "confirm"}},
	{method: "POST", path: "/incus/pools/{pool}/volumes", op: proto.OpVolumeCreate, admin: true,
		body: []string{"name", "size", "content_type", "project", "description"}},
	{method: "POST", path: "/incus/pools/{pool}/volumes/{volume}/resize", op: proto.OpVolumeResize, body: []string{"size", "project"}},
	{method: "DELETE", path: "/incus/pools/{pool}/volumes/{volume}", op: proto.OpVolumeDelete, admin: true, query: []string{"project", "confirm"}},
	{method: "POST", path: "/incus/images", op: proto.OpImageDownload, admin: true, body: []string{"alias", "type", "project", "auto_update"}},
	{method: "POST", path: "/incus/images/{fingerprint}/refresh", op: proto.OpImageRefresh, body: []string{"project"}},
	{method: "DELETE", path: "/incus/images/{fingerprint}", op: proto.OpImageDelete, admin: true, query: []string{"project", "confirm"}},
}

// incusFields are the Incus fields of shared routes (method and path ->
// body fields or query parameters).
var incusFields = []struct {
	method, path string
	body, query  []string
}{
	{"PUT", "/guests/{guestId}/config", []string{"devices", "profiles"}, nil},
	{"GET", "/manage/choices", nil, []string{"project"}},
	{"POST", "/guests", []string{"project", "pool", "network", "cloud_init"}, nil},
	{"POST", "/guests/{guestId}/clone", []string{"project", "instance_only"}, nil},
	{"POST", "/guests/{guestId}/backups", []string{"name", "expires_at", "instance_only", "optimized", "compression"}, nil},
	{"POST", "/backups/restore", []string{"name"}, nil},
	{"DELETE", "/backups", nil, []string{"guest"}},
}

func init() {
	for _, f := range incusFields {
		i := slices.IndexFunc(manageRoutes, func(rt manageRoute) bool { return rt.method == f.method && rt.path == f.path })
		if i < 0 {
			panic("manage_incus: no route " + f.method + " " + f.path)
		}
		manageRoutes[i].body = append(slices.Clone(manageRoutes[i].body), f.body...)
		manageRoutes[i].query = append(slices.Clone(manageRoutes[i].query), f.query...)
	}
	manageRoutes = append(manageRoutes, incusRoutes...)
}

// incusOnlyOps work on Incus only (501 elsewhere).
var incusOnlyOps = map[string]bool{proto.OpLogGet: true, proto.OpRename: true, proto.OpMove: true, proto.OpPublish: true,
	proto.OpNetworkLeases: true, proto.OpProfileGet: true, proto.OpProfileCreate: true, proto.OpProfileUpdate: true,
	proto.OpProfileDelete: true, proto.OpVolumeCreate: true, proto.OpVolumeResize: true, proto.OpVolumeDelete: true,
	proto.OpImageDownload: true, proto.OpImageRefresh: true, proto.OpImageDelete: true}

// incusImageOps make an image: their task's NewID is a fingerprint, not a
// guest.
var incusImageOps = map[string]bool{proto.OpPublish: true, proto.OpImageDownload: true}

var (
	incusNameRe   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`) // volumes, backups, snapshots, profiles
	incusFPRe     = regexp.MustCompile(`^[0-9a-fA-F]{12,64}$`)
	incusSizeRe   = regexp.MustCompile(`^\+?[0-9]{1,12}(\.[0-9]{1,3})?[kKMGTPE]?(i?B)?$`)
	incusAliasRe  = regexp.MustCompile(`^(images:)?[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$`)
	incusRenameRe = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9-]{0,62}$`)
)

// parseIncusManage reads the Incus query parameters and path values of a
// route (parseManage leaves them to this function).
func parseIncusManage(rt manageRoute, r *http.Request, req *proto.ManageRequest, fe map[string]string) {
	if strings.HasPrefix(rt.path, "/incus/") {
		req.Platform = proto.PlatformIncus
	}
	q := r.URL.Query()
	for _, name := range rt.query {
		v := q.Get(name)
		switch name {
		case "project":
			req.Project = v
		case "guest":
			req.GuestID = v
		case "lines":
			if v != "" {
				n, err := strconv.Atoi(v)
				if err != nil || n < 1 || n > 2000 {
					fe["lines"] = "lines is a number from 1 to 2000."
				}
				req.Lines = n
			}
		}
	}
	if v := r.PathValue("profile"); v != "" {
		req.Profile = v
	}
	if v := r.PathValue("network"); v != "" {
		req.Network = v
	}
	if v := r.PathValue("fingerprint"); v != "" {
		req.Fingerprint = v
	}
	if v := r.PathValue("pool"); v != "" {
		req.Pool = v
	}
	if v := r.PathValue("volume"); v != "" {
		req.Volume = v
	}
}

// incusNameOp: the request's name is not an instance name (profiles,
// volumes and Incus backups have their own rules, checked here).
func incusNameOp(req *proto.ManageRequest) bool {
	switch req.Op {
	case proto.OpProfileCreate, proto.OpVolumeCreate:
		return true
	case proto.OpBackupCreate:
		return req.Platform == proto.PlatformIncus
	}
	return false
}

// validateIncus adds the checks of the Incus fields to validateManage.
func validateIncus(req *proto.ManageRequest, bad func(ok bool, field, msg string)) {
	op := req.Op
	oneOf := func(v string, allowed ...string) bool { return slices.Contains(allowed, v) }
	bad(req.Project == "" || manageIDRe.MatchString(req.Project), "project", "Not a project.")
	bad(req.Pool == "" || manageIDRe.MatchString(req.Pool), "pool", "Not a storage pool.")
	bad(req.Network == "" || manageIDRe.MatchString(req.Network), "network", "Not a network.")
	bad(manageText(req.CloudInit, 65536, true), "cloud_init", "Cloud-init user data is text of up to 64 KiB.")
	bad(manageText(req.Description, 65536, true), "description", "The description has control characters or is too long.")
	bad(req.Snapshot == "" || incusNameRe.MatchString(req.Snapshot), "snapshot", "Not a snapshot.")
	bad(req.CopyFrom == "" || incusNameRe.MatchString(req.CopyFrom), "copy_from", "Not a profile.")
	bad(oneOf(req.ContentType, "", "filesystem", "block"), "content_type", "content_type is filesystem or block.")
	bad(oneOf(req.Compression, "", "zstd", "gzip", "none"), "compression", "compression is zstd, gzip or none.")
	bad(oneOf(req.ImageType, "", "container", "virtual-machine"), "type", "type is container or virtual-machine.")
	bad(req.Alias == "" || incusAliasRe.MatchString(req.Alias), "alias", "Not an image alias (\"debian/13\").")
	bad(len(req.Devices) <= 64, "devices", "At most 64 devices in one change.")
	for name, dev := range req.Devices {
		bad(manageIDRe.MatchString(name), "devices", "Not a device name: "+cleanText(name, 64)+".")
		bad(len(dev) <= 32, "devices", "A device has at most 32 options.")
		for k, v := range dev {
			bad(manageKeyRe.MatchString(k) && manageText(v, 1024, false), "devices", "Device options are key=value without control characters.")
		}
	}
	if incusNameOp(req) {
		bad(req.Name == "" && op == proto.OpBackupCreate || incusNameRe.MatchString(req.Name), "name",
			"Names are up to 128 letters, digits, '.', '_' and '-', starting with a letter or digit.")
	}
	switch op {
	case proto.OpRename:
		bad(incusRenameRe.MatchString(req.Name) && !strings.HasSuffix(req.Name, "-"), "name",
			"Instance names are up to 63 letters, digits and '-', starting with a letter.")
	case proto.OpMove:
		bad(req.Pool != "" || req.Project != "", "pool", "Choose a pool or a project to move the guest to.")
	case proto.OpProfileGet, proto.OpProfileUpdate, proto.OpProfileDelete:
		bad(incusNameRe.MatchString(req.Profile), "profile", "Not a profile.")
	case proto.OpVolumeCreate, proto.OpVolumeResize:
		bad(incusSizeRe.MatchString(req.Size), "size", "The size is a number with a unit, such as 10GiB.")
	case proto.OpImageDownload:
		bad(req.Alias != "", "alias", "Choose the image to download (\"debian/13\").")
		bad(req.ImageType != "", "type", "type is container or virtual-machine.")
	case proto.OpImageRefresh, proto.OpImageDelete:
		bad(incusFPRe.MatchString(req.Fingerprint), "fingerprint", "Not an image fingerprint.")
	case proto.OpNetworkLeases:
		bad(manageIDRe.MatchString(req.Network), "network", "Not a network.")
	}
	switch op {
	case proto.OpVolumeCreate, proto.OpVolumeResize, proto.OpVolumeDelete:
		bad(manageIDRe.MatchString(req.Pool), "pool", "Not a storage pool.")
	}
	switch op {
	case proto.OpVolumeResize, proto.OpVolumeDelete:
		bad(incusNameRe.MatchString(req.Volume), "volume", "Not a volume.")
	}
}

// incusRouteCheck refuses the Incus operations on a server or guest that
// is not Incus (501), and the restore and backup routes' guest of another
// platform.
func incusRouteCheck(req proto.ManageRequest, t remoteTarget) *apiError {
	if !incusOnlyOps[req.Op] {
		return nil
	}
	if req.Platform != proto.PlatformIncus || t.st.Report == nil || t.st.Report.Incus == nil {
		return apiErr(http.StatusNotImplemented, "unsupported", "This works on Incus only, and this server or guest is not Incus.")
	}
	return nil
}

// incusConfirm applies the Incus confirmations: moving a guest, deleting
// a profile or a volume.
func incusConfirm(req proto.ManageRequest, confirm bool) *apiError {
	need := func(detail string) *apiError { return apiErr(http.StatusBadRequest, "confirm_required", detail) }
	switch req.Op {
	case proto.OpMove:
		if !confirm {
			return need("Moving a guest copies it and deletes the original: send \"confirm\": true.")
		}
	case proto.OpProfileDelete:
		if !confirm {
			return need("Deleting a profile cannot be undone: send confirm=1.")
		}
	case proto.OpVolumeDelete:
		if !confirm {
			return need("Deleting a volume destroys its data: send confirm=1.")
		}
	}
	return nil
}

// incusAnswer is the JSON of an Incus read (nil: not an Incus read).
func incusAnswer(op string, resp proto.ManageResponse) (any, bool) {
	switch op {
	case proto.OpProfileGet:
		p := resp.Profile
		if p == nil {
			return nil, false
		}
		out := *p
		used := make([]string, 0, len(p.UsedBy))
		for _, id := range p.UsedBy {
			used = append(used, model.GuestID(proto.PlatformIncus, id))
		}
		out.UsedBy = used
		if out.Config == nil {
			out.Config = map[string]string{}
		}
		if out.Devices == nil {
			out.Devices = map[string]map[string]string{}
		}
		out.Restricted = nonNil(out.Restricted)
		return map[string]any{"op": op, "profile": out}, true
	case proto.OpNetworkLeases:
		items := make([]map[string]any, 0, len(resp.Leases))
		for _, l := range resp.Leases {
			var gid any
			if l.GuestID != "" {
				gid = model.GuestID(proto.PlatformIncus, cleanText(l.GuestID, 128))
			}
			items = append(items, map[string]any{"hostname": l.Hostname, "address": l.Address, "hwaddr": l.HWAddr, "type": l.Type, "guest_id": gid})
		}
		return map[string]any{"op": op, "items": items}, true
	case proto.OpLogGet:
		if resp.Log == nil {
			return nil, false
		}
		return map[string]any{"op": op, "file": resp.Log.File, "lines": nonNil(resp.Log.Lines)}, true
	}
	return nil, false
}

// incusDetails adds the Incus target fields to a request's audit details.
func incusDetails(req proto.ManageRequest, put func(k, v string)) {
	put("project", req.Project)
	put("pool", req.Pool)
	put("network", req.Network)
	put("profile", req.Profile)
	put("alias", req.Alias)
	put("snapshot", req.Snapshot)
	put("fingerprint", req.Fingerprint)
	put("copy_from", req.CopyFrom)
	if req.CloudInit != "" {
		put("cloud_init", "set") // user data may hold secrets: never its text
	}
	if len(req.Profiles) > 0 && req.Op == proto.OpConfigSet {
		put("profiles", strings.Join(req.Profiles, ", "))
	}
	if req.ExpiresAt != nil {
		put("expires_at", req.ExpiresAt.UTC().Format("2006-01-02T15:04:05Z"))
	}
}

// incusDeviceKeys are the devices of a change as "device.<name>" keys
// (for the audit's keys).
func incusDeviceKeys(req proto.ManageRequest) []string {
	var keys []string
	for name := range req.Devices {
		keys = append(keys, "device."+name)
	}
	return keys
}

// incusTaskNewID is what a finished task made, as the API names it: the
// fingerprint of an image, else the hub guest id.
func incusTaskNewID(platform, op, id string) string {
	if id == "" {
		return ""
	}
	id = cleanText(id, 128)
	if incusImageOps[op] {
		return id
	}
	return model.GuestID(platform, id)
}

// ---- report bounds ------------------------------------------------------------------

// sanitizeIncus bounds the Incus host view of an untrusted report.
func sanitizeIncus(d *proto.IncusDetail) {
	if d == nil {
		return
	}
	cut := func(n, max int) int { return min(n, max) }
	d.Projects = d.Projects[:cut(len(d.Projects), maxItems)]
	for i := range d.Projects {
		clampStr(&d.Projects[i].Name, maxLabel)
		clampStr(&d.Projects[i].Description, maxStrLen)
	}
	d.Pools = d.Pools[:cut(len(d.Pools), maxItems)]
	for i := range d.Pools {
		p := &d.Pools[i]
		for _, s := range []*string{&p.Name, &p.Driver, &p.Status} {
			clampStr(s, maxLabel)
		}
		clampStr(&p.Description, maxStrLen)
	}
	d.Networks = d.Networks[:cut(len(d.Networks), maxItems)]
	for i := range d.Networks {
		n := &d.Networks[i]
		for _, s := range []*string{&n.Name, &n.Type, &n.IPv4, &n.IPv6} {
			clampStr(s, maxLabel)
		}
		clampStr(&n.Description, maxStrLen)
	}
	d.Profiles = d.Profiles[:cut(len(d.Profiles), maxItems)]
	for i := range d.Profiles {
		p := &d.Profiles[i]
		clampStr(&p.Name, maxLabel)
		clampStr(&p.Project, maxLabel)
		clampStr(&p.Description, maxStrLen)
	}
	d.Images = d.Images[:cut(len(d.Images), maxItems)]
	for i := range d.Images {
		im := &d.Images[i]
		for _, s := range []*string{&im.Fingerprint, &im.Type, &im.Architecture, &im.Project} {
			clampStr(s, maxLabel)
		}
		clampStr(&im.Description, maxStrLen)
		im.Aliases = clampList(im.Aliases, 16, maxStrLen)
	}
	d.Volumes = d.Volumes[:cut(len(d.Volumes), 4*maxItems)]
	for i := range d.Volumes {
		v := &d.Volumes[i]
		for _, s := range []*string{&v.Pool, &v.Name, &v.Project, &v.ContentType} {
			clampStr(s, maxLabel)
		}
		clampStr(&v.Description, maxStrLen)
		v.UsedBy = clampList(v.UsedBy, 64, maxLabel)
	}
}
