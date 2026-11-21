package broker

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	libvirt "github.com/digitalocean/go-libvirt"

	"rackoon/internal/proto"
)

// Guest management on libvirt (proto.StreamManage, docs/MANAGE.md 2.7):
// QEMU/KVM VMs that libvirt runs, on every host with libvirt (an unRAID
// server's VM Manager too). Configuration uses Proxmox-like keys over the
// domain XML (libvirt_domain.go); every change edits the inactive XML in
// place and defines it again, so whatever Whombat does not know stays as
// it was. Long work (clone, backups, restores, downloads) runs as agent
// tasks "libvirt:<16 hex>" (libvirt_tasks.go). Files are written by
// libvirt itself (pool volumes, transient pools on folders): the agent's
// sandbox keeps the file system read-only.

// lvManager runs the libvirt manage operations.
type lvManager struct {
	dial       func() (LibvirtConn, error)
	fs         LibvirtFS
	backupsDir string // agent.toml [libvirt] backups_dir
	tasks      *lvTasks
	log        *slog.Logger
	now        func() time.Time
	httpGet    lvHTTPGetter // content.download (tests replace it)
}

func newLvManager(dial func() (LibvirtConn, error), fsys LibvirtFS, backupsDir string, log *slog.Logger) *lvManager {
	if log == nil {
		log = slog.Default()
	}
	return &lvManager{dial: dial, fs: fsys, backupsDir: backupsDir, tasks: newLvTasks(), log: log, now: time.Now,
		httpGet: lvDefaultHTTPGet}
}

// NewLibvirtManager returns a manager over the given connection (the
// simulator's in-memory libvirt).
func NewLibvirtManager(dial func() (LibvirtConn, error), fsys LibvirtFS, backupsDir string) interface {
	Manage(ctx context.Context, g *proto.Guest, req proto.ManageRequest) proto.ManageResponse
} {
	return lvManageFunc{newLvManager(dial, fsys, backupsDir, nil)}
}

type lvManageFunc struct{ m *lvManager }

func (f lvManageFunc) Manage(ctx context.Context, g *proto.Guest, req proto.ManageRequest) proto.ManageResponse {
	return f.m.manage(ctx, g, req)
}

// lvGuestOptional: libvirt ops that name a VM that may be gone (the backups
// of a deleted VM can still be restored or deleted).
var lvGuestOptional = map[string]bool{proto.OpBackupRestore: true, proto.OpBackupDelete: true, proto.OpBackupList: true}

func (m *lvManager) manage(ctx context.Context, g *proto.Guest, req proto.ManageRequest) proto.ManageResponse {
	if g == nil && manageGuestOps[req.Op] && !lvGuestOptional[req.Op] {
		return proto.ManageResponse{Code: CodeInvalid, Message: "this operation needs a VM"}
	}
	switch req.Op {
	case proto.OpTaskStatus:
		return m.tasks.status(req)
	case proto.OpTaskList:
		return m.tasks.list(g)
	case proto.OpTaskStop:
		return m.tasks.stop(req)
	}
	conn, err := m.dial()
	if err != nil {
		return lvResp(err)
	}
	defer conn.Disconnect()
	// go-libvirt calls take no context: closing the connection when the
	// request ends releases a call blocked on a hung libvirtd. Tasks dial
	// their own connection.
	defer context.AfterFunc(ctx, func() { _ = conn.Disconnect() })()
	switch req.Op {
	case proto.OpConfigGet:
		return m.configGet(conn, g)
	case proto.OpConfigSet:
		return m.configSet(conn, g, req)
	case proto.OpDiskResize:
		return m.diskResize(conn, g, req)
	case proto.OpChoices:
		return m.choices(conn)
	case proto.OpCreate:
		return m.create(conn, req)
	case proto.OpClone:
		return m.clone(conn, g, req)
	case proto.OpRename:
		return m.rename(conn, g, req)
	case proto.OpDelete:
		return m.deleteGuest(conn, g, req)
	case proto.OpBackupList:
		return m.backupList(conn, g, req)
	case proto.OpBackupCreate:
		return m.backupCreate(conn, g, req)
	case proto.OpBackupRestore:
		return m.backupRestore(conn, req)
	case proto.OpBackupDelete:
		return m.backupDelete(conn, req)
	case proto.OpVolumeCreate:
		return m.volumeCreate(conn, req)
	case proto.OpVolumeResize:
		return m.volumeResize(conn, req)
	case proto.OpVolumeDelete:
		return m.volumeDelete(conn, req)
	case proto.OpContentList:
		return m.contentList(conn, req)
	case proto.OpContentDownload:
		return m.contentDownload(conn, req)
	case proto.OpContentDelete:
		return m.contentDelete(conn, req)
	case proto.OpNetworkLeases:
		return m.networkLeases(conn, req)
	case proto.OpLogGet:
		return m.logGet(g, req)
	}
	return proto.ManageResponse{Code: CodeUnsupported, Message: "libvirt VMs cannot do this through Whombat"}
}

// ---- answers -------------------------------------------------------------------

// lvResp turns an error into an answer (codeError keeps its code).
func lvResp(err error) proto.ManageResponse {
	var ce *codeError
	if errors.As(err, &ce) {
		return proto.ManageResponse{Code: ce.code, Message: ce.msg}
	}
	var fe *lvFieldErr
	if errors.As(err, &fe) {
		return proto.ManageResponse{Code: proto.CodeInvalidValue, Message: fe.field + ": " + fe.msg, FieldErrors: map[string]string{fe.field: fe.msg}}
	}
	return lvPlatformError(err)
}

// lvPlatformError maps libvirt's errors: a missing object is not_found,
// a name in use exists, a busy domain locked, the rest platform_error with
// libvirt's first line.
func lvPlatformError(err error) proto.ManageResponse {
	msg := err.Error()
	if i := strings.IndexByte(msg, '\n'); i >= 0 {
		msg = msg[:i]
	}
	if len(msg) > 500 {
		msg = msg[:500]
	}
	low := strings.ToLower(msg)
	switch {
	case strings.Contains(low, "already exists"):
		return proto.ManageResponse{Code: proto.CodeExists, Message: msg}
	case strings.Contains(low, "not found") || strings.Contains(low, "no storage vol") || strings.Contains(low, "no domain with"):
		return proto.ManageResponse{Code: proto.CodeNotFound, Message: msg}
	case strings.Contains(low, "is still running") || strings.Contains(low, "domain is active") || strings.Contains(low, "domain is already active"):
		return proto.ManageResponse{Code: proto.CodeGuestRunning, Message: msg}
	case strings.Contains(low, "another job") || strings.Contains(low, "timeout") && strings.Contains(low, "lock"):
		return proto.ManageResponse{Code: proto.CodeLocked, Message: msg}
	}
	return proto.ManageResponse{Code: CodePlatformError, Message: msg}
}

// lvFieldErr is a value that failed a check.
type lvFieldErr struct{ field, msg string }

func (e *lvFieldErr) Error() string { return e.field + ": " + e.msg }

func lvFieldError(field, format string, a ...any) error {
	return &lvFieldErr{field: field, msg: fmt.Sprintf(format, a...)}
}

func lvFields(fe map[string]string) proto.ManageResponse {
	r := proto.ManageResponse{Code: proto.CodeInvalidValue, FieldErrors: fe, Message: "Check the marked values."}
	if len(fe) == 1 {
		for k, v := range fe {
			r.Message = k + ": " + v
		}
	}
	return r
}

// ---- domain access -------------------------------------------------------------

// lvDomState is a domain with its documents.
type lvDomState struct {
	ref       libvirt.Domain
	running   bool // running or paused: a live configuration exists
	inactive  *lvDom
	inactiveX string // secure inactive XML (the digest is over it)
	live      *lvDom // nil when stopped
	autostart bool
}

func (m *lvManager) loadDomain(conn LibvirtConn, name string) (*lvDomState, error) {
	ref, err := conn.DomainLookupByName(name)
	if err != nil {
		return nil, codeErr(CodeUnknownGuest, "libvirt has no VM called "+name)
	}
	st := &lvDomState{ref: ref}
	s, _, err := conn.DomainGetState(ref, 0)
	if err != nil {
		return nil, err
	}
	switch libvirt.DomainState(s) {
	case libvirt.DomainRunning, libvirt.DomainBlocked, libvirt.DomainPaused, libvirt.DomainShutdown, libvirt.DomainPmsuspended:
		st.running = true
	}
	x, err := conn.DomainGetXMLDesc(ref, libvirt.DomainXMLInactive|libvirt.DomainXMLSecure)
	if err != nil {
		return nil, err
	}
	if st.inactive, err = parseLvDom(x); err != nil {
		return nil, fmt.Errorf("reading the domain XML: %w", err)
	}
	st.inactiveX = x
	if st.running {
		lx, err := conn.DomainGetXMLDesc(ref, libvirt.DomainXMLSecure)
		if err != nil {
			return nil, err
		}
		if st.live, err = parseLvDom(lx); err != nil {
			return nil, fmt.Errorf("reading the domain XML: %w", err)
		}
	}
	if a, err := conn.DomainGetAutostart(ref); err == nil {
		st.autostart = a == 1
	}
	return st, nil
}

// current is the configuration in effect: live when running.
func (st *lvDomState) current() *lvDom {
	if st.live != nil {
		return st.live
	}
	return st.inactive
}

// ---- config.get ----------------------------------------------------------------

// diskSize is a disk's virtual size: its pool volume's capacity, a qcow2
// header, or the file's size.
func (m *lvManager) diskSize(conn LibvirtConn, h *lvHost, d lvDisk) uint64 {
	switch d.typ {
	case "volume":
		if p, err := conn.StoragePoolLookupByName(d.pool); err == nil {
			if v, err := conn.StorageVolLookupByName(p, d.vol); err == nil {
				if _, c, _, err := conn.StorageVolGetInfo(v); err == nil {
					return c
				}
			}
		}
	case "file":
		if d.path == "" {
			return 0
		}
		if v, err := conn.StorageVolLookupByPath(d.path); err == nil {
			if _, c, _, err := conn.StorageVolGetInfo(v); err == nil {
				return c
			}
		}
		if n := qcow2Size(lvReadHead(m.fs, d.path, 32)); n > 0 {
			return n
		}
		if st, err := m.fs.Stat(d.path); err == nil {
			return uint64(st.Size)
		}
	case "block":
		if v, err := conn.StorageVolLookupByPath(d.path); err == nil {
			if _, c, _, err := conn.StorageVolGetInfo(v); err == nil {
				return c
			}
		}
	}
	return 0
}

// docValues are a document's values: scalars, read-only facts and
// devices (keys from the document's own order).
func (m *lvManager) docValues(conn LibvirtConn, h *lvHost, d *lvDom, autostart bool) (map[string]string, map[string]*xnode) {
	v := d.scalarValues()
	v["autostart"] = lvBoolStr(autostart)
	nodes := map[string]*xnode{}
	for _, dk := range d.devKeys() {
		nodes[dk.key] = dk.node
		if dk.node.name == "interface" {
			v[dk.key] = readLvNIC(dk.node).value()
			continue
		}
		disk := readLvDisk(dk.node)
		var size uint64
		if disk.device == "disk" {
			size = m.diskSize(conn, h, disk)
		}
		v[dk.key] = disk.value(size)
	}
	return v, nodes
}

func (m *lvManager) configGet(conn LibvirtConn, g *proto.Guest) proto.ManageResponse {
	st, err := m.loadDomain(conn, g.ID)
	if err != nil {
		return lvResp(err)
	}
	h, err := readHost(conn, m.fs, m.backupsDir)
	if err != nil {
		return lvResp(err)
	}
	return proto.ManageResponse{OK: true, Config: m.buildConfig(conn, h, st)}
}

// buildConfig: Values are the configuration in effect (live while
// running), Pending what differs in the inactive XML (the next start).
// Device keys number the inactive XML's devices; a device only the
// running VM has (removed for the next start) gets the next free number
// and is in PendingDelete.
func (m *lvManager) buildConfig(conn LibvirtConn, h *lvHost, st *lvDomState) *proto.GuestConfig {
	inVals, inNodes := m.docValues(conn, h, st.inactive, st.autostart)
	c := &proto.GuestConfig{Platform: proto.PlatformLibvirt, Kind: "vm", Digest: lvDigest(st.inactiveX), Running: st.running,
		Values: map[string]string{}}
	if st.live == nil {
		c.Values = inVals
	} else {
		liveVals, liveNodes := m.docValues(conn, h, st.live, st.autostart)
		// A running VM's currentMemory is what its balloon has reached (all
		// of it without a balloon driver in the guest), not the target:
		// memory_mb shows the target Whombat set.
		if v, ok := inVals["memory_mb"]; ok {
			liveVals["memory_mb"] = v
		}
		// Scalars and facts: live; pending when the inactive differs.
		for k, v := range liveVals {
			if lvDiskKey.MatchString(k) || lvCDKey.MatchString(k) || lvNetKey.MatchString(k) {
				continue
			}
			c.Values[k] = v
		}
		for k, v := range inVals {
			if lvDiskKey.MatchString(k) || lvCDKey.MatchString(k) || lvNetKey.MatchString(k) {
				continue
			}
			if lv, ok := c.Values[k]; !ok || lv != v {
				if c.Pending == nil {
					c.Pending = map[string]string{}
				}
				if !ok {
					c.Values[k] = ""
				}
				c.Pending[k] = v
			}
		}
		for k := range c.Values {
			if _, ok := inVals[k]; !ok && !lvReadOnlyKeys[k] && k != "autostart" {
				c.PendingDelete = append(c.PendingDelete, k)
			}
		}
		// Devices: matched by identity.
		liveByID := map[string]string{} // identity -> live key
		for k, n := range liveNodes {
			if id := devIdentity(n); id != "" {
				liveByID[id] = k
			}
		}
		matched := map[string]bool{}
		for k, n := range inNodes {
			lk, ok := liveByID[devIdentity(n)]
			if !ok || devIdentity(n) == "" {
				if c.Pending == nil {
					c.Pending = map[string]string{}
				}
				c.Pending[k] = inVals[k]
				continue
			}
			matched[lk] = true
			c.Values[k] = liveVals[lk]
			if liveVals[lk] != inVals[k] {
				if c.Pending == nil {
					c.Pending = map[string]string{}
				}
				c.Pending[k] = inVals[k]
			}
		}
		next := map[string]int{"disk": len(st.inactive.diskNodes("disk")), "cdrom": len(st.inactive.diskNodes("cdrom")),
			"net": len(st.inactive.nicNodes())}
		var liveOnly []string
		for k := range liveNodes {
			if !matched[k] {
				liveOnly = append(liveOnly, k)
			}
		}
		sort.Strings(liveOnly)
		for _, lk := range liveOnly {
			prefix := strings.TrimRight(lk, "0123456789")
			key := fmt.Sprintf("%s%d", prefix, next[prefix])
			next[prefix]++
			c.Values[key] = liveVals[lk]
			c.PendingDelete = append(c.PendingDelete, key)
		}
		sort.Strings(c.PendingDelete)
	}
	// Restricted: what Whombat shows but does not change.
	for k := range c.Values {
		if lvReadOnlyKeys[k] || strings.HasPrefix(k, "hostdev") || strings.HasPrefix(k, "graphics") {
			c.Restricted = append(c.Restricted, k)
		}
	}
	for k, n := range inNodes {
		if n.name == "interface" && !readLvNIC(n).editable() || n.name == "disk" && !readLvDisk(n).editable() {
			c.Restricted = append(c.Restricted, k)
		}
	}
	sort.Strings(c.Restricted)
	c.Restricted = slices.Compact(c.Restricted)
	// Disks for display (inactive numbering).
	boot := strings.Split(st.current().bootOrder(), ",")
	firstOf := map[string]bool{}
	keys := make([]string, 0, len(inNodes))
	for k := range inNodes {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return lvKeyLess(keys[i], keys[j]) })
	for _, k := range keys {
		n := inNodes[k]
		if n.name != "disk" {
			continue
		}
		d := readLvDisk(n)
		gd := proto.GuestDisk{Key: k, Volume: d.source(), Media: d.device}
		if d.device == "disk" {
			gd.SizeBytes = m.diskSize(conn, h, d)
		}
		if d.typ == "volume" {
			gd.Storage = d.pool
		} else if d.path != "" {
			gd.Storage = h.storageOf(d.path)
		}
		kind := map[string]string{"disk": "hd", "cdrom": "cdrom"}[d.device]
		if slices.Contains(boot, kind) && !firstOf[kind] || d.bootOrd > 0 {
			gd.Boot = true
			firstOf[kind] = true
		}
		c.Disks = append(c.Disks, gd)
	}
	return c
}

// lvKeyLess orders disk0 < disk1 < … < cdrom0 < net0 numerically.
func lvKeyLess(a, b string) bool {
	pa, pb := strings.TrimRight(a, "0123456789"), strings.TrimRight(b, "0123456789")
	if pa != pb {
		return pa > pb // "disk" > "cdrom": disks first
	}
	na, _ := strconv.Atoi(a[len(pa):])
	nb, _ := strconv.Atoi(b[len(pb):])
	return na < nb
}

// ---- config.set ----------------------------------------------------------------

// lvText checks a value: valid UTF-8, at most max bytes, no control
// characters (line breaks and tabs in multi-line texts).
func lvText(s string, max int, multiline bool) string {
	if !utf8.ValidString(s) {
		return "not valid UTF-8"
	}
	if len(s) > max {
		return fmt.Sprintf("too long (at most %d bytes)", max)
	}
	for _, r := range s {
		if multiline && (r == '\n' || r == '\r' || r == '\t') {
			continue
		}
		if unicode.IsControl(r) {
			return "control characters are not allowed"
		}
	}
	return ""
}

var (
	lvSizeRE   = regexp.MustCompile(`^\+?([0-9]{1,15})(\.[0-9]{1,3})?\s*([KMGT]?)(i?B)?$`)
	lvActionOK = map[string]bool{"destroy": true, "restart": true, "preserve": true, "rename-restart": true}
	lvBootDevs = map[string]bool{"hd": true, "cdrom": true, "network": true, "fd": true}
	lvBuses    = map[string]bool{"virtio": true, "sata": true, "scsi": true, "ide": true, "usb": true}
	lvNICModel = map[string]bool{"virtio": true, "e1000e": true, "e1000": true, "rtl8139": true, "vmxnet3": true}
)

// lvParseSize reads "32G", "32GiB", "500M", "1T" or bytes; grow reports a
// leading "+".
func lvParseSize(s string) (n uint64, grow bool, ok bool) {
	s = strings.TrimSpace(s)
	m := lvSizeRE.FindStringSubmatch(strings.ToUpper(strings.ReplaceAll(s, "iB", "IB")))
	if m == nil {
		m = lvSizeRE.FindStringSubmatch(s)
		if m == nil {
			return 0, false, false
		}
	}
	whole, err := strconv.ParseUint(m[1], 10, 64)
	if err != nil {
		return 0, false, false
	}
	frac := 0.0
	if m[2] != "" {
		frac, _ = strconv.ParseFloat("0"+m[2], 64)
	}
	mult := map[string]uint64{"": 1, "K": 1 << 10, "M": 1 << 20, "G": 1 << 30, "T": 1 << 40}[strings.ToUpper(m[3])]
	if m[3] == "" && m[4] == "" && m[2] == "" {
		mult = 1
	}
	n = whole*mult + uint64(frac*float64(mult))
	return n, strings.HasPrefix(s, "+"), n > 0 && n <= 64<<40
}

// lvEdit is one config change on the inactive document.
type lvEdit struct {
	m        *lvManager
	conn     LibvirtConn
	h        *lvHost
	st       *lvDomState
	doc      *lvDom // the inactive document being changed
	name     string // the VM's name (for new disks)
	newVols  []libvirt.StorageVol
	live     []func() error    // applied after the define, while running
	liveKey  map[string]bool   // keys that took effect at once
	fe       map[string]string // field errors
	na       map[string]string // keys outside what Whombat changes
	auto     *bool             // autostart change
	rename   string            // new name
	creating bool              // guest.create: devices may be added freely
}

// notAllowed: a key Whombat shows but never changes.
func (e *lvEdit) notAllowed(key string) {
	if e.na == nil {
		e.na = map[string]string{}
	}
	e.na[key] = "Whombat does not change this: change it in virt-manager or Unraid’s VM page"
}

func (e *lvEdit) bad(key, format string, a ...any) {
	if e.fe[key] == "" {
		e.fe[key] = fmt.Sprintf(format, a...)
	}
}

func (m *lvManager) configSet(conn LibvirtConn, g *proto.Guest, req proto.ManageRequest) proto.ManageResponse {
	st, err := m.loadDomain(conn, g.ID)
	if err != nil {
		return lvResp(err)
	}
	if req.Digest != "" && req.Digest != lvDigest(st.inactiveX) {
		return proto.ManageResponse{Code: proto.CodeDigestMismatch, Message: "the VM's configuration changed since it was read"}
	}
	h, err := readHost(conn, m.fs, m.backupsDir)
	if err != nil {
		return lvResp(err)
	}
	before := m.buildConfig(conn, h, st)
	e := &lvEdit{m: m, conn: conn, h: h, st: st, doc: st.inactive.clone(), name: st.inactive.name(), fe: map[string]string{},
		liveKey: map[string]bool{}}
	e.revert(req.Revert)
	keys := make([]string, 0, len(req.Set))
	for k := range req.Set {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return lvKeyLess(keys[i], keys[j]) })
	// vcpus_max and memory_max_mb first: the current values are checked
	// against them.
	sort.SliceStable(keys, func(i, j int) bool {
		return strings.HasSuffix(keys[i], "_max") || strings.HasSuffix(keys[i], "_max_mb")
	})
	for _, k := range keys {
		e.set(k, req.Set[k])
	}
	for _, k := range req.Delete {
		e.del(k)
	}
	if len(e.na) > 0 {
		e.cleanup()
		return proto.ManageResponse{Code: proto.CodeNotAllowed, FieldErrors: e.na,
			Message: "Whombat does not change this: change it in virt-manager or Unraid’s VM page"}
	}
	if len(e.fe) > 0 {
		e.cleanup()
		return lvFields(e.fe)
	}
	if e.rename != "" {
		if st.running {
			e.cleanup()
			return proto.ManageResponse{Code: proto.CodeGuestRunning, Message: "Stop the VM to rename it."}
		}
		if _, err := conn.DomainRename(st.ref, libvirt.OptString{e.rename}, 0); err != nil {
			e.cleanup()
			return lvPlatformError(err)
		}
		e.doc.x.child("name").setText(e.rename)
	}
	if e.doc.String() != st.inactive.String() {
		if _, err := conn.DomainDefineXMLFlags(e.doc.String(), libvirt.DomainDefineValidate); err != nil {
			e.cleanup()
			r := lvPlatformError(err)
			if r.Code == CodePlatformError {
				r.Code = proto.CodeInvalidValue
			}
			return r
		}
	}
	if e.auto != nil && *e.auto != st.autostart {
		if err := conn.DomainSetAutostart(st.ref, map[bool]int32{true: 1, false: 0}[*e.auto]); err != nil {
			return lvPlatformError(err)
		}
	}
	// Live: what a running VM takes at once.
	for _, f := range e.live {
		_ = f()
	}
	name := g.ID
	if e.rename != "" {
		name = e.rename
	}
	after, err := m.loadDomain(conn, name)
	if err != nil {
		return lvResp(err)
	}
	cfg := m.buildConfig(conn, h, after)
	resp := proto.ManageResponse{OK: true, Changes: lvChanges(before, cfg)}
	if e.rename != "" {
		resp.NewID = e.rename
	}
	return resp
}

// lvChanges lists what changed between two readings (value or pending).
func lvChanges(before, after *proto.GuestConfig) []proto.ConfigChange {
	eff := func(c *proto.GuestConfig, k string) (string, bool) {
		if v, ok := c.Pending[k]; ok {
			return v, true
		}
		if slices.Contains(c.PendingDelete, k) {
			return "", true
		}
		return c.Values[k], false
	}
	keys := map[string]bool{}
	for _, c := range []*proto.GuestConfig{before, after} {
		for k := range c.Values {
			keys[k] = true
		}
		for k := range c.Pending {
			keys[k] = true
		}
	}
	var out []proto.ConfigChange
	for k := range keys {
		ov, _ := eff(before, k)
		nv, pending := eff(after, k)
		if ov == nv {
			continue
		}
		out = append(out, proto.ConfigChange{Key: k, Old: ov, New: nv, Pending: pending})
	}
	sort.Slice(out, func(i, j int) bool { return lvKeyLess(out[i].Key, out[j].Key) })
	return out
}

// cleanup deletes the volumes made for new disks after a failed change.
func (e *lvEdit) cleanup() {
	for _, v := range e.newVols {
		_ = e.conn.StorageVolDelete(v, 0)
	}
	e.newVols = nil
}

// revert gives keys their running value back (drops what waits for the
// next start).
func (e *lvEdit) revert(keys []string) {
	if len(keys) == 0 {
		return
	}
	if e.st.live == nil {
		for _, k := range keys {
			e.bad(k, "the VM is stopped: nothing waits for a restart")
		}
		return
	}
	liveVals := e.st.live.scalarValues()
	inKeys := map[string]*xnode{}
	for _, dk := range e.doc.devKeys() {
		inKeys[dk.key] = dk.node
	}
	liveByID := map[string]*xnode{}
	for _, dk := range e.st.live.devKeys() {
		liveByID[devIdentity(dk.node)] = dk.node
	}
	for _, k := range keys {
		switch {
		case slices.Contains(lvScalarKeys, k) && k != "autostart" && k != "name":
			if v, ok := liveVals[k]; ok {
				e.setScalar(k, v)
			} else {
				e.setScalar(k, "")
			}
		case lvDiskKey.MatchString(k) || lvCDKey.MatchString(k) || lvNetKey.MatchString(k):
			n, ok := inKeys[k]
			if ok {
				if ln := liveByID[devIdentity(n)]; ln != nil {
					e.doc.devices().replace(n, ln.clone())
				} else {
					e.doc.devices().remove(n)
				}
				continue
			}
			// A device only the running VM has: keep it for the next start.
			cfg := e.m.buildConfig(e.conn, e.h, e.st)
			if !slices.Contains(cfg.PendingDelete, k) {
				e.bad(k, "nothing waits for a restart here")
				continue
			}
			val := cfg.Values[k]
			for _, dk := range e.st.live.devKeys() {
				var lv string
				if dk.node.name == "interface" {
					lv = readLvNIC(dk.node).value()
				} else {
					lv = readLvDisk(dk.node).value(e.m.diskSize(e.conn, e.h, readLvDisk(dk.node)))
				}
				if lv == val {
					c := dk.node.clone()
					stripLive(c)
					e.doc.devices().add(c)
					break
				}
			}
		default:
			e.bad(k, "this cannot be reverted")
		}
	}
}

// stripLive drops what only a running domain's device has (alias, the
// live target of a NIC).
func stripLive(n *xnode) {
	n.removeAll("alias")
	if n.name == "interface" {
		n.removeAll("target")
	}
	if src := n.child("source"); src != nil {
		src.delAttr("index")
	}
}

func (e *lvEdit) set(k, v string) {
	if msg := lvText(v, 64<<10, k == "description"); msg != "" {
		e.bad(k, "%s", msg)
		return
	}
	switch {
	case k == "name":
		if v == e.st.inactive.name() {
			return
		}
		if !lvNameRE.MatchString(v) {
			e.bad(k, "names are up to 64 letters, digits, dots, dashes and underscores, starting with a letter or digit")
			return
		}
		if _, err := e.conn.DomainLookupByName(v); err == nil {
			e.bad(k, "another VM is called %s", v)
			return
		}
		e.rename = v
	case k == "autostart":
		b, ok := lvBool(v)
		if !ok {
			e.bad(k, "autostart is 1 or 0")
			return
		}
		e.auto = &b
		e.liveKey[k] = true
	case slices.Contains(lvScalarKeys, k):
		e.setScalar(k, v)
	case lvReadOnlyKeys[k] || strings.HasPrefix(k, "hostdev") || strings.HasPrefix(k, "graphics"):
		e.notAllowed(k)
	case lvDiskKey.MatchString(k):
		e.setDisk(k, v)
	case lvCDKey.MatchString(k):
		e.setCDROM(k, v)
	case lvNetKey.MatchString(k):
		e.setNIC(k, v)
	default:
		e.bad(k, "not a setting Whombat changes")
	}
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func lvBool(v string) (bool, bool) {
	switch strings.ToLower(v) {
	case "1", "true", "yes", "on":
		return true, true
	case "0", "false", "no", "off":
		return false, true
	}
	return false, false
}

// setScalar changes a scalar key in the inactive document and, for a
// running VM, queues what it takes at once.
func (e *lvEdit) setScalar(k, v string) {
	d := e.doc
	running := e.st.live != nil && !e.creating
	switch k {
	case "title":
		if strings.ContainsAny(v, "\r\n") || len(v) > 1024 {
			e.bad(k, "the title is one line of up to 1024 characters")
			return
		}
		d.setTopText("title", v, "uuid", "name")
		if running {
			e.queueMeta(k, libvirt.DomainMetadataTitle, v)
		}
	case "description":
		d.setTopText("description", v, "title", "uuid", "name")
		if running {
			e.queueMeta(k, libvirt.DomainMetadataDescription, v)
		}
	case "vcpus", "vcpus_max":
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > e.h.maxVCPUs() {
			e.bad(k, "a number of vCPUs from 1 to %d", e.h.maxVCPUs())
			return
		}
		vc := d.x.child("vcpu")
		if vc == nil {
			vc = newElem("vcpu", "placement", "static")
			d.x.insertAfter(vc, "currentMemory", "memory")
			vc.setText(v)
		}
		max, _ := strconv.Atoi(vc.textContent())
		cur, err := strconv.Atoi(vc.attr("current"))
		if err != nil {
			cur = max
		}
		if k == "vcpus_max" {
			if n < cur {
				cur = n
			}
			max = n
		} else {
			// More than the maximum raises it (for the next start).
			max = maxInt(max, n)
			cur = n
		}
		vc.setText(strconv.Itoa(max))
		if cur == max {
			vc.delAttr("current")
		} else {
			vc.setAttr("current", strconv.Itoa(cur))
		}
		if topo := d.x.path("cpu/topology"); topo != nil {
			s, _ := strconv.Atoi(topo.attr("sockets"))
			c, _ := strconv.Atoi(topo.attr("cores"))
			t, _ := strconv.Atoi(topo.attr("threads"))
			if s*c*t != max {
				// Keep the topology consistent: one socket, the threads it
				// had when they divide the count.
				if t < 1 || max%t != 0 {
					t = 1
				}
				topo.setAttr("sockets", "1")
				topo.setAttr("cores", strconv.Itoa(max/t))
				topo.setAttr("threads", strconv.Itoa(t))
				for _, a := range []string{"dies", "clusters"} {
					if topo.hasAttr(a) {
						topo.setAttr(a, "1")
					}
				}
			}
		}
		if running && k == "vcpus" {
			liveMax, _ := strconv.Atoi(e.st.live.x.child("vcpu").textContent())
			if n <= liveMax {
				e.queueLive(k, func() error { return e.conn.DomainSetVcpusFlags(e.st.ref, uint32(n), uint32(libvirt.DomainAffectLive)) })
			}
		}
	case "memory_mb", "memory_max_mb":
		n, err := strconv.ParseUint(v, 10, 64)
		if err != nil || n < 64 || n > 16<<20 {
			e.bad(k, "memory in MiB, from 64")
			return
		}
		max := memMiB(d.x.child("memory"))
		cur := memMiB(d.x.child("currentMemory"))
		if cur == 0 {
			cur = max
		}
		if k == "memory_max_mb" {
			max = n
			if cur > max {
				cur = max
			}
		} else {
			// More than the maximum raises it (for the next start).
			cur = n
			if n > max {
				max = n
			}
		}
		d.setMem("memory", max)
		d.setMem("currentMemory", cur)
		if running && k == "memory_mb" {
			liveMax := memMiB(e.st.live.x.child("memory"))
			if n <= liveMax {
				e.queueLive(k, func() error {
					return e.conn.DomainSetMemoryFlags(e.st.ref, n<<10, uint32(libvirt.DomainAffectLive))
				})
			}
		}
	case "boot":
		var order []string
		seen := map[string]bool{}
		for _, dev := range strings.Split(v, ",") {
			dev = strings.TrimSpace(dev)
			if !lvBootDevs[dev] || seen[dev] {
				e.bad(k, "the boot order lists hd, cdrom and network, each once (\"hd,cdrom\")")
				return
			}
			seen[dev] = true
			order = append(order, dev)
		}
		if len(order) == 0 {
			e.bad(k, "give at least one boot device")
			return
		}
		d.setBootOrder(order)
	case "cpu_mode":
		switch {
		case v == "host-passthrough" || v == "host-model" || v == "maximum":
		case strings.HasPrefix(v, "custom:"):
			model := strings.TrimPrefix(v, "custom:")
			models := e.h.cpuModels()
			if !lvModelRE.MatchString(model) || len(models) > 0 && !slices.Contains(models, model) {
				e.bad(k, "%s is not a CPU model this host's QEMU offers", model)
				return
			}
		default:
			e.bad(k, "cpu_mode is host-passthrough, host-model, maximum or custom:<model>")
			return
		}
		d.setCPUMode(v)
	case "on_poweroff", "on_reboot", "on_crash":
		if !lvActionOK[v] {
			e.bad(k, "%s is destroy, restart, preserve or rename-restart", k)
			return
		}
		d.setTopText(k, v, "clock", "cpu", "features", "os")
	}
}

func (e *lvEdit) queueMeta(k string, typ libvirt.DomainMetadataType, v string) {
	e.queueLive(k, func() error {
		var val libvirt.OptString
		if v != "" {
			val = libvirt.OptString{v}
		}
		return e.conn.DomainSetMetadata(e.st.ref, int32(typ), val, nil, nil, libvirt.DomainAffectLive)
	})
}

// queueLive queues a live change; the key counts as live when it worked.
func (e *lvEdit) queueLive(k string, f func() error) {
	e.live = append(e.live, func() error {
		err := f()
		if err == nil {
			e.liveKey[k] = true
		} else {
			e.m.log.Debug("libvirt live change failed; it applies at the next start", "key", k, "err", err)
		}
		return err
	})
}

// devNode finds the inactive document's device of a key.
func (e *lvEdit) devNode(k string) *xnode {
	for _, dk := range e.doc.devKeys() {
		if dk.key == k {
			return dk.node
		}
	}
	return nil
}

// liveTwin is the running VM's device matching an inactive one.
func (e *lvEdit) liveTwin(n *xnode) *xnode {
	if e.st.live == nil || e.creating {
		return nil
	}
	id := devIdentity(n)
	for _, dk := range e.st.live.devKeys() {
		if id != "" && devIdentity(dk.node) == id {
			return dk.node
		}
	}
	return nil
}

// resolveSource turns a source value (pool/volume or a path) into a path,
// its format and whether it is a block device. writable: the file must be
// in a pool or one of unRAID's folders.
func (e *lvEdit) resolveSource(key, src string) (p, format string, block bool, ok bool) {
	if strings.HasPrefix(src, "/") {
		p = filepath.Clean(src)
		if p != src || strings.Contains(src, "..") || !lvWithin(p, e.h.writeRoots()) {
			e.bad(key, "the file must be in a storage pool or one of Unraid’s VM folders")
			return "", "", false, false
		}
		if v, okv := lookupVolPath(e.conn, e.h, p); okv {
			return e.volFacts(key, v)
		}
		if !e.m.fs.Exists(p) {
			e.bad(key, "%s does not exist", p)
			return "", "", false, false
		}
		format = "raw"
		if qcow2Size(lvReadHead(e.m.fs, p, 32)) > 0 {
			format = "qcow2"
		}
		return p, format, false, true
	}
	pool, vol, cut := strings.Cut(src, "/")
	if !cut || pool == "" || vol == "" || strings.Contains(vol, "/") {
		e.bad(key, "the source is pool/volume or a file path")
		return "", "", false, false
	}
	pl, okp := e.h.pool(pool)
	if !okp || !pl.active {
		e.bad(key, "there is no active storage pool %s", pool)
		return "", "", false, false
	}
	v, err := e.conn.StorageVolLookupByName(pl.ref, vol)
	if err != nil {
		_ = e.conn.StoragePoolRefresh(pl.ref, 0)
		if v, err = e.conn.StorageVolLookupByName(pl.ref, vol); err != nil {
			e.bad(key, "pool %s has no volume %s", pool, vol)
			return "", "", false, false
		}
	}
	return e.volFacts(key, v)
}

func (e *lvEdit) volFacts(key string, v libvirt.StorageVol) (string, string, bool, bool) {
	p, err := e.conn.StorageVolGetPath(v)
	if err != nil {
		e.bad(key, "libvirt does not say where %s is", v.Name)
		return "", "", false, false
	}
	t, _, _, _ := e.conn.StorageVolGetInfo(v)
	format := "raw"
	if x, err := e.conn.StorageVolGetXMLDesc(v, 0); err == nil {
		if vx, err := parseXMLTree(x); err == nil {
			if f := vx.path("target/format").attr("type"); f == "qcow2" {
				format = "qcow2"
			}
		}
	}
	return p, format, t == 1, true // VIR_STORAGE_VOL_BLOCK
}

// inUseElsewhere names another domain that uses the path ("" = none).
func (e *lvEdit) inUseElsewhere(p string) string {
	return domainUsing(e.conn, p, e.st.inactive.name())
}

// domainUsing names a domain (other than except) whose disks use path p.
func domainUsing(conn LibvirtConn, p, except string) string {
	doms, _, err := conn.ConnectListAllDomains(1, 0)
	if err != nil {
		return ""
	}
	for _, ref := range doms {
		if ref.Name == except {
			continue
		}
		x, err := conn.DomainGetXMLDesc(ref, libvirt.DomainXMLInactive)
		if err != nil {
			continue
		}
		d, err := parseLvDom(x)
		if err != nil {
			continue
		}
		for _, n := range d.x.child("devices").children("disk") {
			if readLvDisk(n).path == p {
				return ref.Name
			}
		}
	}
	return ""
}

func (e *lvEdit) setDisk(k, v string) {
	kv, _ := lvParseKV(v)
	n := e.devNode(k)
	if n == nil {
		e.addDisk(k, kv)
		return
	}
	d := readLvDisk(n)
	if !d.editable() {
		e.notAllowed(k)
		return
	}
	for key := range kv {
		switch key {
		case "source":
			if kv[key] != d.source() {
				e.bad(k, "detach this disk and add the other one instead")
			}
		case "format":
			if kv[key] != d.format {
				e.bad(k, "the format belongs to the file; it cannot change")
			}
		case "size":
			if kv[key] != strconv.FormatUint(e.m.diskSize(e.conn, e.h, d), 10) {
				e.bad(k, "grow a disk with Resize")
			}
		case "target", "readonly":
		case "bus":
			if !lvBuses[kv[key]] {
				e.bad(k, "bus is virtio, sata, scsi, ide or usb")
			}
		case "cache":
			if !slices.Contains([]string{"none", "writeback", "writethrough", "directsync", "unsafe", "default"}, kv[key]) {
				e.bad(k, "cache is none, writeback, writethrough, directsync, unsafe or default")
			}
		case "discard":
			if kv[key] != "unmap" && kv[key] != "ignore" {
				e.bad(k, "discard is unmap or ignore")
			}
		default:
			e.bad(k, "%s is not a disk option Whombat changes", key)
		}
	}
	if len(e.fe) > 0 {
		return
	}
	if bus := kv["bus"]; bus != "" && bus != d.bus {
		t := n.child("target")
		t.setAttr("bus", bus)
		t.setAttr("dev", e.doc.nextTarget(bus))
		n.removeAll("address")
	}
	drv := n.ensure("driver")
	if drv.attr("name") == "" {
		drv.setAttr("name", "qemu")
	}
	for _, opt := range []string{"cache", "discard"} {
		if val, ok := kv[opt]; ok {
			if val == "default" || val == "" {
				drv.delAttr(opt)
			} else {
				drv.setAttr(opt, val)
			}
		}
	}
}

// addDisk adds disk<N>: a new volume (new=<size>,storage=…) or an existing
// file or volume (source=…).
func (e *lvEdit) addDisk(k string, kv map[string]string) {
	want, _ := strconv.Atoi(strings.TrimPrefix(k, "disk"))
	if want != len(e.doc.diskNodes("disk")) {
		e.bad(k, "the next new disk is disk%d", len(e.doc.diskNodes("disk")))
		return
	}
	bus := kv["bus"]
	if bus == "" {
		bus = "virtio"
		if e.doc.windows() {
			bus = "sata"
		}
		if l := e.doc.diskNodes("disk"); len(l) > 0 {
			bus = readLvDisk(l[0]).bus
		}
	}
	if !lvBuses[bus] {
		e.bad(k, "bus is virtio, sata, scsi, ide or usb")
		return
	}
	for key := range kv {
		if !slices.Contains([]string{"new", "storage", "format", "bus", "source", "cache", "discard", "target"}, key) {
			e.bad(k, "%s is not a disk option Whombat sets", key)
			return
		}
	}
	target := e.doc.nextTarget(bus)
	var p, format string
	var block bool
	switch {
	case kv["new"] != "":
		size, _, ok := lvParseSize(kv["new"])
		if !ok {
			e.bad(k, "new is the size of the new disk (\"32G\")")
			return
		}
		var err error
		p, format, block, err = e.m.newDisk(e.conn, e.h, e.name, target, kv["storage"], kv["format"], size, &e.newVols)
		if err != nil {
			var fe *lvFieldErr
			if errors.As(err, &fe) {
				e.bad(k, "%s", fe.msg)
			} else {
				e.bad(k, "%s", err.Error())
			}
			return
		}
	case kv["source"] != "":
		var ok bool
		if p, format, block, ok = e.resolveSource(k, kv["source"]); !ok {
			return
		}
		if other := e.inUseElsewhere(p); other != "" {
			e.bad(k, "%s already uses this file", other)
			return
		}
	default:
		e.bad(k, "give new=<size>,storage=<pool> for a new disk, or source=<pool/volume> for an existing one")
		return
	}
	disk := newElem("disk", "type", map[bool]string{true: "block", false: "file"}[block], "device", "disk")
	drv := disk.add(newElem("driver", "name", "qemu", "type", format))
	for _, opt := range []string{"cache", "discard"} {
		if kv[opt] != "" {
			drv.setAttr(opt, kv[opt])
		}
	}
	srcAttr := "file"
	if block {
		srcAttr = "dev"
	}
	disk.add(newElem("source", srcAttr, p))
	disk.add(newElem("target", "dev", target, "bus", bus))
	e.insertDevice(disk)
}

// insertDevice puts a new disk after the last disk, a NIC after the last
// NIC (else after the disks).
func (e *lvEdit) insertDevice(n *xnode) {
	devs := e.doc.devices()
	if n.name == "interface" {
		devs.insertAfter(n, "disk", "controller", "filesystem", "interface")
		return
	}
	devs.insertAfter(n, "emulator", "disk")
}

// newDisk makes a new volume for a VM: in a pool (<vm>-<target>.qcow2), or
// in unRAID's domains folder (<domains>/<vm>/vdiskN.img / .qcow2).
func (m *lvManager) newDisk(conn LibvirtConn, h *lvHost, vm, target, storage, format string, size uint64, made *[]libvirt.StorageVol) (string, string, bool, error) {
	if storage == "" {
		storage = defaultImageStorage(h)
	}
	if format != "" && format != "qcow2" && format != "raw" {
		return "", "", false, lvFieldError("format", "format is qcow2 or raw")
	}
	var pool libvirt.StoragePool
	var name string
	var block bool
	create := func(pool libvirt.StoragePool, name, format string) (string, error) {
		doc := newElem("volume")
		doc.add(newElem("name")).setText(name)
		doc.add(newElem("capacity", "unit", "bytes")).setText(strconv.FormatUint(size, 10))
		if format == "qcow2" {
			doc.add(newElem("allocation", "unit", "bytes")).setText("0")
		}
		doc.add(newElem("target")).add(newElem("format", "type", format))
		v, err := conn.StorageVolCreateXML(pool, doc.String(), 0)
		if err != nil {
			return "", err
		}
		*made = append(*made, v)
		return conn.StorageVolGetPath(v)
	}
	if dir := h.folderPath(storage); storage == proto.LibvirtDomainsFolder {
		if dir == "" {
			return "", "", false, lvFieldError("storage", "Unraid’s domains folder is not set")
		}
		if format == "" {
			format = "qcow2"
		}
		var p string
		err := withDir(conn, h, filepath.Join(dir, vm), true, func(pool libvirt.StoragePool) error {
			ext := map[string]string{"qcow2": ".qcow2", "raw": ".img"}[format]
			for i := 1; i < 100; i++ {
				name = fmt.Sprintf("vdisk%d%s", i, ext)
				if _, err := conn.StorageVolLookupByName(pool, name); err != nil && !m.fs.Exists(filepath.Join(dir, vm, name)) {
					break
				}
			}
			var err error
			p, err = create(pool, name, format)
			return err
		})
		return p, format, false, err
	}
	pl, ok := h.pool(storage)
	if !ok || !pl.active {
		return "", "", false, lvFieldError("storage", "there is no active storage pool %s", storage)
	}
	pool = pl.ref
	if !pl.fileBased() {
		format, block = "raw", true
	}
	if format == "" {
		format = "qcow2"
	}
	base := vm + "-" + target
	ext := map[string]string{"qcow2": ".qcow2", "raw": ".img"}[format]
	if block {
		ext = ""
	}
	for i := 0; i < 100; i++ {
		name = base + ext
		if i > 0 {
			name = fmt.Sprintf("%s-%d%s", base, i, ext)
		}
		if _, err := conn.StorageVolLookupByName(pool, name); err != nil {
			break
		}
	}
	p, err := create(pool, name, format)
	return p, format, block, err
}

// defaultImageStorage: the "default" pool, else the first active
// file-based pool, else unRAID's domains folder.
func defaultImageStorage(h *lvHost) string {
	for _, p := range h.pools {
		if p.name == "default" && p.active {
			return p.name
		}
	}
	for _, p := range h.pools {
		if p.active && p.fileBased() {
			return p.name
		}
	}
	if h.folders != nil && h.folders.Domains != "" {
		return proto.LibvirtDomainsFolder
	}
	for _, p := range h.pools {
		if p.active {
			return p.name
		}
	}
	return ""
}

func (e *lvEdit) setCDROM(k, v string) {
	kv, _ := lvParseKV(v)
	for key := range kv {
		if key != "source" && key != "bus" && key != "target" {
			e.bad(k, "%s is not a CD/DVD option Whombat sets", key)
			return
		}
	}
	n := e.devNode(k)
	src := kv["source"]
	var p string
	if src != "" && src != "empty" {
		var ok bool
		if p, _, _, ok = e.resolveSource(k, src); !ok {
			return
		}
	}
	if n == nil {
		want, _ := strconv.Atoi(strings.TrimPrefix(k, "cdrom"))
		if want != len(e.doc.diskNodes("cdrom")) {
			e.bad(k, "the next new CD/DVD drive is cdrom%d", len(e.doc.diskNodes("cdrom")))
			return
		}
		bus := kv["bus"]
		if bus == "" {
			bus = "sata"
			if !strings.Contains(e.doc.x.path("os/type").attr("machine"), "q35") && e.doc.x.path("os/type").attr("machine") != "" {
				bus = "ide"
			}
		}
		if bus != "sata" && bus != "ide" && bus != "scsi" {
			e.bad(k, "bus is sata or ide")
			return
		}
		cd := newElem("disk", "type", "file", "device", "cdrom")
		cd.add(newElem("driver", "name", "qemu", "type", "raw"))
		if p != "" {
			cd.add(newElem("source", "file", p))
		}
		cd.add(newElem("target", "dev", e.doc.nextTarget(bus), "bus", bus))
		cd.add(newElem("readonly"))
		e.insertDevice(cd)
		return
	}
	d := readLvDisk(n)
	if !d.editable() {
		e.bad(k, "Whombat does not change this drive: change it in virt-manager or Unraid’s VM page")
		return
	}
	if bus := kv["bus"]; bus != "" && bus != d.bus {
		if bus != "sata" && bus != "ide" && bus != "scsi" {
			e.bad(k, "bus is sata or ide")
			return
		}
		t := n.child("target")
		t.setAttr("bus", bus)
		t.setAttr("dev", e.doc.nextTarget(bus))
		n.removeAll("address")
	}
	if _, has := kv["source"]; !has {
		return
	}
	if src == "empty" || src == "" {
		n.removeAll("source")
	} else {
		n.setAttr("type", "file")
		n.removeAll("source")
		s := newElem("source", "file", p)
		n.insertAfter(s, "driver")
	}
	// A running VM changes the medium at once.
	if twin := e.liveTwin(n); twin != nil {
		dev := twin.clone()
		stripLive(dev)
		dev.removeAll("source")
		if p != "" {
			dev.setAttr("type", "file")
			dev.insertAfter(newElem("source", "file", p), "driver")
		}
		e.queueLive(k, func() error {
			return e.conn.DomainUpdateDeviceFlags(e.st.ref, dev.String(), libvirt.DomainDeviceModifyLive)
		})
	}
}

func (e *lvEdit) setNIC(k, v string) {
	kv, _ := lvParseKV(v)
	for key := range kv {
		if !slices.Contains([]string{"model", "network", "bridge", "mac", "link"}, key) {
			e.bad(k, "%s is not a network card option Whombat sets", key)
			return
		}
	}
	if kv["network"] != "" && kv["bridge"] != "" {
		e.bad(k, "give network or bridge, not both")
		return
	}
	if m := kv["model"]; m != "" && !lvNICModel[m] {
		e.bad(k, "model is virtio, e1000e, e1000, rtl8139 or vmxnet3")
		return
	}
	if l := kv["link"]; l != "" && l != "up" && l != "down" {
		e.bad(k, "link is up or down")
		return
	}
	mac := strings.ToLower(kv["mac"])
	if mac != "" && (!lvMACRE.MatchString(mac) || strings.ContainsRune("13579bdf", rune(mac[1]))) {
		e.bad(k, "not a unicast MAC address")
		return
	}
	if nw := kv["network"]; nw != "" {
		if _, err := e.conn.NetworkLookupByName(nw); err != nil {
			e.bad(k, "libvirt has no network %s", nw)
			return
		}
	}
	if br := kv["bridge"]; br != "" && !slices.Contains(hostBridges(e.m.fs, nil), br) {
		e.bad(k, "%s is not a bridge on this host", br)
		return
	}
	n := e.devNode(k)
	if n == nil {
		want, _ := strconv.Atoi(strings.TrimPrefix(k, "net"))
		if want != len(e.doc.nicNodes()) {
			e.bad(k, "the next new network card is net%d", len(e.doc.nicNodes()))
			return
		}
		if kv["network"] == "" && kv["bridge"] == "" {
			e.bad(k, "give network=<name> or bridge=<name>")
			return
		}
		model := kv["model"]
		if model == "" {
			model = "virtio"
			if e.doc.windows() {
				model = "e1000e"
			}
		}
		nic := newElem("interface")
		if mac != "" {
			nic.add(newElem("mac", "address", mac))
		}
		if nw := kv["network"]; nw != "" {
			nic.setAttr("type", "network")
			nic.add(newElem("source", "network", nw))
		} else {
			nic.setAttr("type", "bridge")
			nic.add(newElem("source", "bridge", kv["bridge"]))
		}
		nic.add(newElem("model", "type", model))
		if kv["link"] == "down" {
			nic.add(newElem("link", "state", "down"))
		}
		e.insertDevice(nic)
		return
	}
	c := readLvNIC(n)
	if !c.editable() {
		e.notAllowed(k)
		return
	}
	if mac != "" && mac != c.mac {
		if e.st.live != nil && !e.creating {
			e.bad(k, "stop the VM to change the MAC address")
			return
		}
		n.ensure("mac").setAttr("address", mac)
	}
	if nw := kv["network"]; nw != "" && (c.typ != "network" || c.source != nw) {
		n.setAttr("type", "network")
		n.removeAll("source")
		n.insertAfter(newElem("source", "network", nw), "mac")
	}
	if br := kv["bridge"]; br != "" && (c.typ != "bridge" || c.source != br) {
		n.setAttr("type", "bridge")
		n.removeAll("source")
		n.insertAfter(newElem("source", "bridge", br), "mac")
	}
	if m := kv["model"]; m != "" && m != c.model {
		n.ensure("model").setAttr("type", m)
		n.removeAll("address")
	}
	if l := kv["link"]; l != "" && l != c.link {
		if l == "down" {
			n.ensure("link").setAttr("state", "down")
		} else {
			n.removeAll("link")
		}
		if twin := e.liveTwin(n); twin != nil {
			dev := twin.clone()
			stripLive(dev)
			dev.ensure("link").setAttr("state", l)
			e.queueLive(k, func() error {
				return e.conn.DomainUpdateDeviceFlags(e.st.ref, dev.String(), libvirt.DomainDeviceModifyLive)
			})
		}
	}
}

func (e *lvEdit) del(k string) {
	switch {
	case k == "title" || k == "description":
		e.setScalar(k, "")
	case lvDiskKey.MatchString(k) || lvCDKey.MatchString(k) || lvNetKey.MatchString(k):
		n := e.devNode(k)
		if n == nil {
			e.bad(k, "the VM has no %s", k)
			return
		}
		if n.name == "disk" && !readLvDisk(n).editable() || n.name == "interface" && !readLvNIC(n).editable() {
			e.notAllowed(k)
			return
		}
		// Detaching keeps the file.
		e.doc.devices().remove(n)
	default:
		e.bad(k, "this cannot be removed")
	}
}

// ---- disk.resize ---------------------------------------------------------------

func (m *lvManager) diskResize(conn LibvirtConn, g *proto.Guest, req proto.ManageRequest) proto.ManageResponse {
	st, err := m.loadDomain(conn, g.ID)
	if err != nil {
		return lvResp(err)
	}
	h, err := readHost(conn, m.fs, m.backupsDir)
	if err != nil {
		return lvResp(err)
	}
	var disk *lvDisk
	for _, dk := range st.inactive.devKeys() {
		d := readLvDisk(dk.node)
		if dk.key == req.Disk || dk.node.name == "disk" && d.target == req.Disk {
			disk = &d
		}
	}
	if disk == nil || disk.device != "disk" {
		return lvFields(map[string]string{"disk": "the VM has no disk " + req.Disk})
	}
	if !disk.editable() {
		return proto.ManageResponse{Code: proto.CodeNotAllowed, Message: "Whombat does not resize this disk: change it in virt-manager or Unraid’s VM page"}
	}
	cur := m.diskSize(conn, h, *disk)
	n, grow, ok := lvParseSize(req.Size)
	if !ok {
		return lvFields(map[string]string{"size": "the size is \"+8G\" (grow by) or the new total (\"40G\")"})
	}
	if grow {
		n += cur
	}
	if n <= cur {
		return lvFields(map[string]string{"size": fmt.Sprintf("disks only grow: %s is %s now", disk.target, lvFmtBytes(cur))})
	}
	change := proto.ConfigChange{Key: req.Disk, Old: strconv.FormatUint(cur, 10), New: strconv.FormatUint(n, 10)}
	// Running: QEMU grows the image (and tells the guest).
	if st.running {
		if err := conn.DomainBlockResize(st.ref, disk.target, n, libvirt.DomainBlockResizeBytes); err != nil {
			return lvPlatformError(err)
		}
		return proto.ManageResponse{OK: true, Changes: []proto.ConfigChange{change}}
	}
	var vol libvirt.StorageVol
	switch {
	case disk.typ == "volume":
		p, err := conn.StoragePoolLookupByName(disk.pool)
		if err == nil {
			vol, err = conn.StorageVolLookupByName(p, disk.vol)
		}
		if err != nil {
			return lvPlatformError(err)
		}
	default:
		v, ok := lookupVolPath(conn, h, disk.path)
		if !ok {
			// A file outside the pools: a transient pool on its folder.
			err := withDir(conn, h, filepath.Dir(disk.path), false, func(pool libvirt.StoragePool) error {
				v, err := conn.StorageVolLookupByName(pool, filepath.Base(disk.path))
				if err != nil {
					return err
				}
				return conn.StorageVolResize(v, n, 0)
			})
			if err != nil {
				return lvPlatformError(err)
			}
			return proto.ManageResponse{OK: true, Changes: []proto.ConfigChange{change}}
		}
		vol = v
	}
	if err := conn.StorageVolResize(vol, n, 0); err != nil {
		return lvPlatformError(err)
	}
	return proto.ManageResponse{OK: true, Changes: []proto.ConfigChange{change}}
}

func lvFmtBytes(n uint64) string {
	switch {
	case n >= 1<<40:
		return strconv.FormatFloat(float64(n)/(1<<40), 'f', -1, 64) + " TiB"
	case n >= 1<<30:
		return strconv.FormatFloat(float64(n)/(1<<30), 'f', 1, 64) + " GiB"
	case n >= 1<<20:
		return strconv.FormatFloat(float64(n)/(1<<20), 'f', 0, 64) + " MiB"
	}
	return strconv.FormatUint(n, 10) + " bytes"
}

// ---- choices -------------------------------------------------------------------

func (m *lvManager) choices(conn LibvirtConn) proto.ManageResponse {
	h, err := readHost(conn, m.fs, m.backupsDir)
	if err != nil {
		return lvResp(err)
	}
	c := &proto.Choices{Platform: proto.PlatformLibvirt, Storages: []proto.ChoiceStorage{}, Bridges: []string{}, Download: true}
	for _, p := range h.pools {
		if !p.active {
			continue
		}
		content := []string{"images"}
		if p.fileBased() {
			content = append(content, "iso")
		}
		c.Storages = append(c.Storages, proto.ChoiceStorage{ID: p.name, Type: p.typ, Content: content, AvailBytes: p.avail,
			TotalBytes: p.capacity, Thin: p.fileBased()})
	}
	if f := h.folders; f != nil {
		for _, fo := range []struct{ id, dir, content string }{{proto.LibvirtDomainsFolder, f.Domains, "images"}, {proto.LibvirtISOsFolder, f.ISOs, "iso"}} {
			if fo.dir == "" {
				continue
			}
			cs := proto.ChoiceStorage{ID: fo.id, Type: "folder", Content: []string{fo.content}, Thin: true}
			if t, a, err := m.fs.Statfs(fo.dir); err == nil {
				cs.TotalBytes, cs.AvailBytes = t, a
			}
			c.Storages = append(c.Storages, cs)
		}
	}
	nets := readNetworks(conn, nil)
	for _, n := range nets {
		if n.Active {
			c.Networks = append(c.Networks, n.Name)
		}
	}
	c.Bridges = append(c.Bridges, hostBridges(m.fs, nets)...)
	c.ISOs = m.isoList(conn, h, "")
	c.CPUTypes = h.cpuModels()
	fw := h.firmware(m.fs)
	c.Firmware = &fw
	c.OSVariants = lvOSVariantList()
	return proto.ManageResponse{OK: true, Choices: c}
}
