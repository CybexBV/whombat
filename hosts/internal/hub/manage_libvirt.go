package hub

import (
	"net/http"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"rackoon/internal/hub/model"
	"rackoon/internal/hub/store"
	"rackoon/internal/proto"
)

// ---- libvirt (docs/MANAGE.md 2.8, docs/REST-API.md "Manage", libvirt) ----------

// libvirtManageRoutes are the libvirt-only routes (host routes under
// /libvirt/, always platform libvirt) and the guest routes libvirt shares
// with Incus. Everything else of libvirt goes through the shared routes
// with platform libvirt: the guest's own for guest routes, ?platform= or
// the body's platform for host routes. They join manageRoutes; a route
// another platform registered already is kept and given the fields
// libvirt reads.
var libvirtManageRoutes = []manageRoute{
	{method: "GET", path: "/libvirt/backups", op: proto.OpBackupList},
	{method: "POST", path: "/libvirt/pools/{pool}/volumes", op: proto.OpVolumeCreate, admin: true, body: []string{"name", "size", "format", "platform"}},
	{method: "POST", path: "/libvirt/pools/{pool}/volumes/{volume}/resize", op: proto.OpVolumeResize, body: []string{"size", "platform"}},
	{method: "DELETE", path: "/libvirt/pools/{pool}/volumes/{volume}", op: proto.OpVolumeDelete, admin: true, query: []string{"confirm"}},
	{method: "GET", path: "/libvirt/networks/{network}/leases", op: proto.OpNetworkLeases},
	{method: "POST", path: "/guests/{guestId}/rename", op: proto.OpRename, admin: true, body: []string{"name"}},
	{method: "GET", path: "/guests/{guestId}/log", op: proto.OpLogGet, query: []string{"lines"}},
}

// libvirtRouteFields are the fields libvirt adds to shared routes.
var libvirtRouteFields = []struct {
	method, path string
	body, query  []string
}{
	{"POST", "/guests", []string{"os_variant", "iso", "disk_gb", "network", "bridge", "storage"}, nil},
	{"POST", "/backups/restore", []string{"name"}, nil},
	{"DELETE", "/backups", nil, []string{"guest"}},
}

func init() {
	find := func(method, path string) *manageRoute {
		for i := range manageRoutes {
			if manageRoutes[i].method == method && manageRoutes[i].path == path {
				return &manageRoutes[i]
			}
		}
		return nil
	}
	union := func(a, b []string) []string {
		for _, x := range b {
			if !slices.Contains(a, x) {
				a = append(a, x)
			}
		}
		return a
	}
	for _, f := range libvirtRouteFields {
		if rt := find(f.method, f.path); rt != nil {
			if f.body != nil {
				rt.body = union(slices.Clone(rt.body), f.body)
			}
			rt.query = union(slices.Clone(rt.query), f.query)
		}
	}
	for _, lr := range libvirtManageRoutes {
		if rt := find(lr.method, lr.path); rt != nil {
			if lr.body != nil {
				rt.body = union(slices.Clone(rt.body), lr.body)
			}
			rt.query = union(slices.Clone(rt.query), lr.query)
			continue
		}
		manageRoutes = append(manageRoutes, lr)
	}
}

var (
	libvirtNameRe   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
	libvirtStampRe  = regexp.MustCompile(`^[0-9]{8}-[0-9]{6}(-[0-9]{1,2})?$`)
	libvirtTaskRe   = regexp.MustCompile(`^libvirt:[0-9a-f]{16}$`)
	libvirtVolRe    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
	libvirtDiskRe   = regexp.MustCompile(`^(disk[0-9]{1,2}|(vd|sd|hd|xvd)[a-z]{1,2})$`)
	libvirtSizeRe   = regexp.MustCompile(`^\+?[0-9]{1,15}(\.[0-9]{1,3})?\s*([KMGTkmgt](i?B)?)?$`)
	libvirtVariant  = regexp.MustCompile(`^[a-z0-9]{1,64}$`)
	libvirtISONameR = regexp.MustCompile(`(?i)^[A-Za-z0-9_][A-Za-z0-9._-]{0,199}\.iso$`)
)

// libvirtStorageOK: a pool name or one of unRAID's VM folders.
func libvirtStorageOK(s string) bool {
	return s == proto.LibvirtDomainsFolder || s == proto.LibvirtISOsFolder || manageIDRe.MatchString(s)
}

// libvirtSourceOK: a volume as libvirt's choices name it: pool/name, or a
// clean absolute path.
func libvirtSourceOK(s string) bool {
	if !manageText(s, 1024, false) || s == "" {
		return false
	}
	if strings.HasPrefix(s, "/") {
		return filepath.Clean(s) == s && !strings.Contains(s, "/../")
	}
	pool, name, ok := strings.Cut(s, "/")
	return ok && manageIDRe.MatchString(pool) && libvirtVolRe.MatchString(name)
}

// libvirtRequest decides whether a manage request is libvirt's: a libvirt
// guest, a /libvirt/ route, platform libvirt, a libvirt task, or a host
// route without a platform on a server whose only platform is libvirt.
func (h *Hub) libvirtRequest(rt manageRoute, serverID string, req *proto.ManageRequest, guestOp bool) bool {
	switch {
	case req.Platform == proto.PlatformLibvirt:
		return true
	case guestOp:
		return false
	case strings.HasPrefix(rt.path, "/libvirt/"):
		req.Platform = proto.PlatformLibvirt
		return true
	case req.Platform != "":
		return false
	case strings.HasPrefix(req.Task, "libvirt:"):
		req.Platform = proto.PlatformLibvirt
		return true
	}
	st, ok := h.snapshotOne(serverID)
	if ok && model.DetailView(st.Report) == "libvirt" {
		req.Platform = proto.PlatformLibvirt
		return true
	}
	return false
}

// libvirtManage serves a libvirt request: the checks of manageHandler
// (role, re-authentication for admin routes, the manage switches, refusals
// audited), libvirt's own value checks, then the read or the change.
func (h *Hub) libvirtManage(w http.ResponseWriter, r *http.Request, p *principal, rt manageRoute, req proto.ManageRequest,
	confirm bool, confirmName, gid string) error {
	serverID := r.PathValue("id")
	read := rt.method == http.MethodGet
	q := r.URL.Query()
	for _, k := range []string{"pool", "volume", "network"} {
		if v := r.PathValue(k); v != "" {
			switch k {
			case "pool":
				req.Pool = v
			case "volume":
				req.Volume = v
			case "network":
				req.Network = v
			}
		}
	}
	if slices.Contains(rt.query, "guest") && q.Get("guest") != "" {
		req.GuestID = q.Get("guest")
	}
	if slices.Contains(rt.query, "lines") && q.Get("lines") != "" {
		n, err := strconv.Atoi(q.Get("lines"))
		if err != nil || n < 1 || n > 2000 {
			return invalidFields(map[string]string{"lines": "lines is a number from 1 to 2000."})
		}
		req.Lines = n
	}
	// Deleting a QEMU/KVM VM takes its disks and NVRAM along unless purge=0.
	if req.Op == proto.OpDelete && !q.Has("purge") {
		req.Purge = true
	}
	// Backups name their VM as a hub guest id or a plain name.
	if req.Op == proto.OpBackupRestore || req.Op == proto.OpBackupDelete || req.Op == proto.OpBackupList && gid == model.HostGuestID {
		if pl, id, ok := model.SplitGuestID(req.GuestID); ok && pl == proto.PlatformLibvirt {
			req.GuestID = id
		}
	}
	if fe := validateLibvirt(&req, gid != model.HostGuestID); len(fe) > 0 {
		return invalidFields(fe)
	}
	event := "manage.requested"
	if read {
		event = "manage.denied"
	}
	details := manageDetails(req)
	for k, v := range map[string]string{"os_variant": req.OSVariant, "iso": req.ISO, "network": req.Network, "bridge": req.Bridge,
		"pool": req.Pool} {
		if v != "" {
			details[k] = cleanText(v, 300)
		}
	}
	if req.DiskGB > 0 {
		details["disk_gb"] = strconv.Itoa(req.DiskGB)
	}
	if req.Op == proto.OpBackupRestore || req.Op == proto.OpBackupDelete {
		details["guest"] = model.GuestID(proto.PlatformLibvirt, req.GuestID)
	}
	deny := func(e *apiError) error { return h.deny(r, p, event, serverID, gid, "", e, details) }
	if rt.admin {
		// Creating, cloning, renaming, deleting and restoring VMs, deleting
		// backups and volumes, downloads: admins with a recent sign-in.
		if p.rank() < store.RoleRank(admin) {
			return deny(apiErr(http.StatusForbidden, "insufficient_role", model.ReasonAdmin+"."))
		}
		if err := h.requireReauth(p); err != nil {
			return err
		}
	}
	if h.throttled(p) {
		return rateLimited(10 * time.Minute)
	}
	t, e := h.remotePrecheck(p, serverID, gid, needManage)
	if e != nil {
		return deny(e)
	}
	if t.st.Report == nil || t.st.Report.Libvirt == nil {
		return apiErr(http.StatusNotImplemented, "unsupported", "This server does not run libvirt.")
	}
	if e := libvirtConfirm(req, confirm, confirmName, t.g); e != nil {
		return deny(e)
	}
	if read {
		return h.libvirtRead(w, r, p, t, gid, req)
	}
	// The guest this Whombat runs in (selfguest.go); a libvirt restore is
	// always a new VM.
	if e := selfManageRefusal(t.st, req.Op, gid, ""); e != nil {
		return deny(e)
	}
	return h.manageChange(w, r, p, t, gid, req, details)
}

// libvirtConfirm: deleting a VM needs its name, deleting a volume confirm.
func libvirtConfirm(req proto.ManageRequest, confirm bool, confirmName string, g proto.PlatformGuest) *apiError {
	switch req.Op {
	case proto.OpVolumeDelete:
		if !confirm {
			return apiErr(http.StatusBadRequest, "confirm_required", "Deleting a volume destroys what is on it: send confirm=1.")
		}
	case proto.OpDelete:
		return manageConfirm(req, confirm, confirmName, g)
	}
	return nil
}

// validateLibvirt checks a libvirt request's values before it goes to the
// agent (which checks them again against libvirt's state).
func validateLibvirt(req *proto.ManageRequest, guestOp bool) map[string]string {
	fe := map[string]string{}
	bad := func(ok bool, field, msg string) {
		if !ok && fe[field] == "" {
			fe[field] = msg
		}
	}
	op := req.Op
	nameMsg := "Names are up to 64 letters, digits, dots, dashes and underscores, starting with a letter or digit."
	bad(manageText(req.Digest, 128, false) && !strings.ContainsRune(req.Digest, ' '), "digest", "Not a digest.")
	if n := len(req.Set) + len(req.Delete) + len(req.Revert); n > 300 {
		fe["set"] = "Too many keys in one change."
	}
	for k, v := range req.Set {
		bad(manageKeyRe.MatchString(k), k, "Not a configuration key.")
		bad(manageText(v, 65536, true), k, "The value has control characters or is too long.")
	}
	for _, list := range [][]string{req.Delete, req.Revert} {
		for _, k := range list {
			bad(manageKeyRe.MatchString(k), k, "Not a configuration key.")
			if _, set := req.Set[k]; set {
				bad(false, k, "A key cannot be set and removed at once.")
			}
		}
	}
	if req.Storage != "" {
		bad(libvirtStorageOK(req.Storage), "storage", "Choose a storage pool or one of Unraid’s VM folders.")
	}
	bad(req.NewID == 0, "new_id", "libvirt VMs have no numeric id: give a name.")
	switch op {
	case proto.OpDiskResize:
		bad(libvirtDiskRe.MatchString(req.Disk), "disk", "Not a disk (\"disk0\" or \"vda\").")
		bad(libvirtSizeRe.MatchString(req.Size), "size", "The size is \"+8G\" (grow by) or the new total (\"40G\").")
	case proto.OpCreate:
		bad(req.Kind == "" || req.Kind == "vm", "kind", "libvirt runs VMs only.")
		bad(libvirtNameRe.MatchString(req.Name), "name", nameMsg)
		bad(req.OSVariant == "" || libvirtVariant.MatchString(req.OSVariant), "os_variant", "Choose an OS type.")
		bad(req.ISO == "" || libvirtSourceOK(req.ISO), "iso", "Choose an ISO image of this server.")
		bad(req.DiskGB >= 0 && req.DiskGB <= 65536, "disk_gb", "The disk is 1 to 65536 GB.")
		bad(req.Network == "" || manageIDRe.MatchString(req.Network), "network", "Not a network.")
		bad(req.Bridge == "" || manageIDRe.MatchString(req.Bridge), "bridge", "Not a bridge.")
		bad(req.Network == "" || req.Bridge == "", "network", "Choose a network or a bridge, not both.")
		bad(req.Storage != proto.LibvirtISOsFolder, "storage", "Disks go into a pool or Unraid’s domains folder.")
	case proto.OpClone, proto.OpRename:
		bad(libvirtNameRe.MatchString(req.Name), "name", nameMsg)
	case proto.OpBackupCreate:
		bad(manageText(req.Notes, 1024, true), "notes", "Notes are up to 1024 characters.")
		bad(slices.Contains([]string{"", "zstd", "lzo", "gzip", "none", "0"}, req.Compress), "compress", "compress is zstd, lzo, gzip or none.")
	case proto.OpBackupRestore, proto.OpBackupDelete:
		bad(req.GuestID != "" && manageText(req.GuestID, 255, false) && !strings.ContainsAny(req.GuestID, "/\\"), "guest", "Say whose backup it is (the VM).")
		bad(libvirtStampRe.MatchString(req.Volume), "volume", "Not a backup (\"20261017-120000\").")
		bad(req.Name == "" || libvirtNameRe.MatchString(req.Name), "name", nameMsg)
	case proto.OpVolumeCreate:
		bad(manageIDRe.MatchString(req.Pool), "pool", "Not a storage pool.")
		bad(libvirtVolRe.MatchString(req.Name), "name", "Volume names are up to 128 letters, digits, dots, dashes and underscores.")
		bad(libvirtSizeRe.MatchString(req.Size) && !strings.HasPrefix(req.Size, "+"), "size", "The size of the new volume (\"10G\").")
		bad(req.Format == "" || req.Format == "qcow2" || req.Format == "raw", "format", "format is qcow2 or raw.")
	case proto.OpVolumeResize:
		bad(manageIDRe.MatchString(req.Pool), "pool", "Not a storage pool.")
		bad(libvirtVolRe.MatchString(req.Volume), "volume", "Not a volume.")
		bad(libvirtSizeRe.MatchString(req.Size), "size", "The size is \"+8G\" (grow by) or the new total (\"40G\").")
	case proto.OpVolumeDelete:
		bad(manageIDRe.MatchString(req.Pool), "pool", "Not a storage pool.")
		bad(libvirtVolRe.MatchString(req.Volume), "volume", "Not a volume.")
	case proto.OpContentList:
		bad(libvirtStorageOK(req.Storage), "storage", "Choose a storage pool or one of Unraid’s VM folders.")
		bad(req.Content == "" || req.Content == "iso" || req.Content == "images", "content", "content is iso or images.")
	case proto.OpContentDownload:
		bad(req.Storage != proto.LibvirtDomainsFolder, "storage", "ISO images go into a pool or Unraid’s ISO folder.")
		bad(req.Content == "" || req.Content == "iso", "content", "libvirt keeps ISO images only.")
		bad(validDownloadURL(req.URL), "url", "Give an http:// or https:// address without a user name or password.")
		bad(libvirtISONameR.MatchString(req.Filename), "filename", "File names are letters, digits, '.', '_' and '-' and end in .iso.")
		bad(slices.Contains([]string{"", "md5", "sha1", "sha224", "sha256", "sha384", "sha512"}, req.ChecksumAlgorithm), "checksum_algorithm",
			"checksum_algorithm is md5, sha1, sha224, sha256, sha384 or sha512.")
		bad((req.Checksum == "") == (req.ChecksumAlgorithm == ""), "checksum", "Give the checksum together with its algorithm.")
		bad(req.Checksum == "" || manageHexRe.MatchString(req.Checksum), "checksum", "The checksum is hexadecimal.")
	case proto.OpContentDelete:
		bad(libvirtSourceOK(req.Volume) && strings.HasSuffix(strings.ToLower(req.Volume), ".iso"), "volume", "Choose an ISO image of this server.")
	case proto.OpNetworkLeases:
		bad(manageIDRe.MatchString(req.Network), "network", "Not a network.")
	case proto.OpTaskStatus, proto.OpTaskStop:
		bad(libvirtTaskRe.MatchString(req.Task), "task", "Not a libvirt task id.")
	case proto.OpConfigGet, proto.OpConfigSet, proto.OpChoices, proto.OpDelete, proto.OpBackupList, proto.OpTaskList, proto.OpLogGet:
	default:
		fe["op"] = "QEMU/KVM VMs cannot do this through Whombat."
	}
	return fe
}

// libvirtRead asks the agent and answers with the operation's part.
func (h *Hub) libvirtRead(w http.ResponseWriter, r *http.Request, p *principal, t remoteTarget, gid string, req proto.ManageRequest) error {
	serverID := t.st.ID
	if h.limits.screens.take(p.key() + "|" + serverID + "|" + req.Op + "|" + gid) {
		h.auditReq(r, p, store.AuditRecord{Event: "manage.viewed", Outcome: "ok", Server: serverID, Guest: guestOrEmpty(gid),
			Platform: req.Platform, Details: map[string]string{"view": req.Op}})
	}
	resp, err := t.conn.Manage(r.Context(), req)
	if err != nil {
		return manageAgentError(err)
	}
	if !resp.OK {
		return manageProblem(resp)
	}
	var body any
	switch req.Op {
	case proto.OpNetworkLeases:
		items := make([]map[string]any, 0, len(resp.Leases))
		for _, l := range resp.Leases {
			var guest any
			if l.GuestID != "" {
				guest = model.GuestID(proto.PlatformLibvirt, cleanText(l.GuestID, 128))
			}
			items = append(items, map[string]any{"hostname": l.Hostname, "address": l.Address, "hwaddr": l.HWAddr, "type": l.Type,
				"guest_id": guest})
		}
		body = map[string]any{"op": req.Op, "items": items}
	case proto.OpLogGet:
		if resp.Log == nil {
			return apiErr(http.StatusBadGateway, "agent_error", "The agent sent an empty answer.")
		}
		body = map[string]any{"op": req.Op, "file": resp.Log.File, "lines": nonNil(resp.Log.Lines)}
	case proto.OpBackupList:
		// A backup names its VM as a hub guest id (what restore and
		// delete take back).
		for i := range resp.Backups {
			if g := resp.Backups[i].GuestID; g != "" {
				resp.Backups[i].GuestID = model.GuestID(proto.PlatformLibvirt, cleanText(g, 128))
			}
		}
		body = map[string]any{"items": nonNil(resp.Backups)}
	case proto.OpContentList:
		for i := range resp.Content {
			for j, g := range resp.Content[i].UsedBy {
				resp.Content[i].UsedBy[j] = model.GuestID(proto.PlatformLibvirt, cleanText(g, 128))
			}
		}
		body = map[string]any{"items": nonNil(resp.Content)}
	default:
		b, e := manageAnswer(req.Op, resp)
		if e != nil {
			return e
		}
		body = b
	}
	writeJSON(w, r, http.StatusOK, body)
	return nil
}
