package broker

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"rackoon/internal/proto"
)

// Guest lifecycle, backups and storage content on Proxmox VE
// (docs/MANAGE.md 2.3).

// newID returns the vmid for a new guest: NewID, else the cluster's next
// free id.
func (r *pveReq) newID(ctx context.Context) (string, error) {
	if r.req.NewID != 0 {
		id := strconv.Itoa(r.req.NewID)
		if !vmidRe.MatchString(id) || r.req.NewID < 100 {
			return "", fieldErr(proto.CodeInvalidValue, "new_id", "must be 100-999999999")
		}
		return id, nil
	}
	var next pveValue
	if err := r.api.get(ctx, "/cluster/nextid", nil, &next); err != nil {
		return "", err
	}
	if !vmidRe.MatchString(string(next)) {
		return "", codeErr(CodePlatformError, "Proxmox VE returned no free guest id")
	}
	return string(next), nil
}

func checkGuestName(name string) error {
	if name == "" {
		return nil
	}
	if len(name) > 128 || checkText("name", name, false) != nil || strings.ContainsAny(name, " ,=/:") {
		return fieldErr(proto.CodeInvalidValue, "name", "must be a DNS name")
	}
	return nil
}

func (r *pveReq) create(ctx context.Context) (proto.ManageResponse, error) {
	req := r.req
	if req.Kind != "vm" && req.Kind != "container" {
		return proto.ManageResponse{}, fieldErr(proto.CodeInvalidValue, "kind", "must be vm or container")
	}
	if err := checkGuestName(req.Name); err != nil {
		return proto.ManageResponse{}, err
	}
	info, err := r.nodeInfo(ctx)
	if err != nil {
		return proto.ManageResponse{}, err
	}
	c := r.check(info, req.Kind, true, nil, nil)
	params := url.Values{}
	for _, k := range sortedKeys(req.Set) {
		if err := c.key("set", k); err != nil {
			return proto.ManageResponse{}, err
		}
		if err := c.value(ctx, k, req.Set[k]); err != nil {
			return proto.ManageResponse{}, err
		}
		params.Set(k, req.Set[k])
	}
	nameKey, path := "name", r.nodePath()+"/qemu"
	if req.Kind == "container" {
		nameKey, path = "hostname", r.nodePath()+"/lxc"
		if params.Get("ostemplate") == "" {
			return proto.ManageResponse{}, fieldErr(proto.CodeInvalidValue, "ostemplate", "a container needs a template")
		}
		params.Set("unprivileged", "1") // never a privileged container
	}
	if req.Name != "" {
		params.Set(nameKey, req.Name)
	}
	if req.Start {
		params.Set("start", "1")
	}
	id, err := r.newID(ctx)
	if err != nil {
		return proto.ManageResponse{}, err
	}
	params.Set("vmid", id)
	var upid string
	if err := r.api.post(ctx, path, params, &upid); err != nil {
		return proto.ManageResponse{}, err
	}
	resp := taskAnswer(upid)
	resp.NewID = id
	return resp, nil
}

// guestConfig reads the guest's current configuration (GET .../config).
func (r *pveReq) guestConfig(ctx context.Context) (map[string]pveValue, error) {
	var conf map[string]pveValue
	err := r.api.get(ctx, r.guestPath()+"/config", nil, &conf)
	return conf, err
}

func (r *pveReq) clone(ctx context.Context) (proto.ManageResponse, error) {
	req := r.req
	if err := checkGuestName(req.Name); err != nil {
		return proto.ManageResponse{}, err
	}
	conf, err := r.guestConfig(ctx)
	if err != nil {
		return proto.ManageResponse{}, err
	}
	// Linked clones exist for templates only; PVE copies other guests fully.
	full := req.Full || !conf["template"].bool()
	params := url.Values{}
	if full {
		params.Set("full", "1")
	}
	if req.Storage != "" {
		if !full {
			return proto.ManageResponse{}, fieldErr(proto.CodeInvalidValue, "storage", "a target storage needs a full clone")
		}
		info, err := r.nodeInfo(ctx)
		if err != nil {
			return proto.ManageResponse{}, err
		}
		content := "images"
		if !r.vm() {
			content = "rootdir"
		}
		if err := info.storageFor(req.Storage, content); err != nil {
			_, msg := errCode(err, "")
			return proto.ManageResponse{}, fieldErr(proto.CodeNotAllowed, "storage", msg)
		}
		params.Set("storage", req.Storage)
	}
	if req.Name != "" {
		if r.vm() {
			params.Set("name", req.Name)
		} else {
			params.Set("hostname", req.Name)
		}
	}
	id, err := r.newID(ctx)
	if err != nil {
		return proto.ManageResponse{}, err
	}
	params.Set("newid", id)
	var upid string
	if err := r.api.post(ctx, r.guestPath()+"/clone", params, &upid); err != nil {
		return proto.ManageResponse{}, err
	}
	resp := taskAnswer(upid)
	resp.NewID = id
	return resp, nil
}

func (r *pveReq) template(ctx context.Context) (proto.ManageResponse, error) {
	if err := r.stopped(ctx); err != nil {
		return proto.ManageResponse{}, err
	}
	var upid string
	if err := r.api.post(ctx, r.guestPath()+"/template", nil, &upid); err != nil {
		return proto.ManageResponse{}, err
	}
	return taskAnswer(upid), nil
}

func (r *pveReq) destroy(ctx context.Context) (proto.ManageResponse, error) {
	if err := r.stopped(ctx); err != nil {
		return proto.ManageResponse{}, err
	}
	conf, err := r.guestConfig(ctx)
	if err != nil {
		return proto.ManageResponse{}, err
	}
	if conf["protection"].bool() {
		return proto.ManageResponse{}, codeErr(proto.CodeProtected, "the guest is protected; turn protection off first")
	}
	params := url.Values{"destroy-unreferenced-disks": {"1"}}
	if r.req.Purge {
		params.Set("purge", "1")
	}
	var upid string
	if err := r.api.delete(ctx, r.guestPath(), params, &upid); err != nil {
		return proto.ManageResponse{}, err
	}
	return taskAnswer(upid), nil
}

// migrate moves the guest to another node of the cluster
// (POST .../migrate): a running VM live with its local disks, a running
// container with a restart (PVE has no live migration for containers),
// stopped guests offline. The digest, when given, must still match.
func (r *pveReq) migrate(ctx context.Context) (proto.ManageResponse, error) {
	req := r.req
	nodes, err := r.requireCluster(ctx)
	if err != nil {
		return proto.ManageResponse{}, err
	}
	if !slices.Contains(nodes, req.Target) {
		return proto.ManageResponse{}, fieldErr(proto.CodeInvalidValue, "target", "must be another node of the cluster")
	}
	if req.Storage != "" && !storageIDRe.MatchString(req.Storage) {
		return proto.ManageResponse{}, fieldErr(proto.CodeInvalidValue, "storage", "not a storage")
	}
	conf, err := r.guestConfig(ctx)
	if err != nil {
		return proto.ManageResponse{}, err
	}
	if req.Digest != "" && string(conf["digest"]) != req.Digest {
		return proto.ManageResponse{}, codeErr(proto.CodeDigestMismatch, "the configuration changed since it was read")
	}
	if conf["template"].bool() {
		return proto.ManageResponse{}, codeErr(CodeUnsupported, "templates are not migrated; clone them on the other node")
	}
	st, err := r.status(ctx)
	if err != nil {
		return proto.ManageResponse{}, err
	}
	params := url.Values{"target": {req.Target}}
	if r.vm() {
		if st == "running" {
			params.Set("online", "1")
		}
		params.Set("with-local-disks", "1")
		if req.Storage != "" {
			params.Set("targetstorage", req.Storage)
		}
	} else {
		if st == "running" {
			params.Set("restart", "1")
			params.Set("timeout", "180") // seconds to shut it down before the move
		}
		if req.Storage != "" {
			params.Set("target-storage", req.Storage)
		}
	}
	var upid string
	if err := r.api.post(ctx, r.guestPath()+"/migrate", params, &upid); err != nil {
		return proto.ManageResponse{}, err
	}
	return taskAnswer(upid), nil
}

// ---- backups ----------------------------------------------------------------------

// pveContent is an entry of .../storage/{storage}/content.
type pveContent struct {
	VolID        string   `json:"volid"`
	Content      string   `json:"content"`
	Format       string   `json:"format"`
	Size         pveValue `json:"size"`
	CTime        int64    `json:"ctime"`
	VMID         pveValue `json:"vmid"`
	Notes        string   `json:"notes"`
	Protected    pveValue `json:"protected"`
	Encrypted    pveValue `json:"encrypted"`
	Subtype      string   `json:"subtype"` // qemu | lxc (backups)
	Verification *struct {
		State string `json:"state"`
	} `json:"verification"`
}

func (c pveContent) created() time.Time {
	if c.CTime > 0 {
		return time.Unix(c.CTime, 0).UTC()
	}
	return time.Time{}
}

// backupKind is the guest kind of a backup volume (from the listing's
// subtype or the volume name).
func backupKind(subtype, volid string) string {
	switch {
	case subtype == "qemu", strings.Contains(volid, "vzdump-qemu-"), strings.Contains(volid, ":backup/vm/"):
		return "vm"
	case subtype == "lxc", strings.Contains(volid, "vzdump-lxc-"), strings.Contains(volid, ":backup/ct/"):
		return "container"
	}
	return ""
}

func (r *pveReq) content(ctx context.Context, storage string, q url.Values) ([]pveContent, error) {
	var items []pveContent
	err := r.api.get(ctx, r.nodePath()+"/storage/"+url.PathEscape(storage)+"/content", q, &items)
	return items, err
}

func (r *pveReq) backupList(ctx context.Context) (proto.ManageResponse, error) {
	info, err := r.nodeInfo(ctx)
	if err != nil {
		return proto.ManageResponse{}, err
	}
	out := []proto.BackupVolume{}
	var lastErr error
	stores := info.withContent("backup")
	failed := 0
	for _, s := range stores {
		items, err := r.content(ctx, s.ID, url.Values{"content": {"backup"}, "vmid": {r.g.ID}})
		if err != nil {
			// One unreachable backup server does not hide the other storages.
			failed, lastErr = failed+1, err
			continue
		}
		for _, it := range items {
			b := proto.BackupVolume{Volume: it.VolID, Storage: s.ID, GuestID: string(it.VMID), Kind: backupKind(it.Subtype, it.VolID),
				SizeBytes: it.Size.uint(), Created: it.created(), Format: it.Format, Notes: it.Notes,
				Protected: it.Protected.bool(), Encrypted: it.Encrypted.bool()}
			if it.Verification != nil {
				b.Verified = it.Verification.State
			}
			out = append(out, b)
		}
	}
	if failed > 0 && failed == len(stores) {
		return proto.ManageResponse{}, lastErr
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Created.After(out[j].Created) })
	return proto.ManageResponse{OK: true, Backups: out}, nil
}

func (r *pveReq) backupCreate(ctx context.Context) (proto.ManageResponse, error) {
	req := r.req
	info, err := r.nodeInfo(ctx)
	if err != nil {
		return proto.ManageResponse{}, err
	}
	if err := info.storageFor(req.Storage, "backup"); err != nil {
		_, msg := errCode(err, "")
		return proto.ManageResponse{}, fieldErr(proto.CodeNotAllowed, "storage", msg)
	}
	mode := req.Mode
	if mode == "" {
		mode = "snapshot"
	}
	if !slices.Contains(backupModes, mode) {
		return proto.ManageResponse{}, fieldErr(proto.CodeInvalidValue, "mode", "must be snapshot, suspend or stop")
	}
	params := url.Values{"vmid": {r.g.ID}, "storage": {req.Storage}, "mode": {mode}}
	if info.storages[req.Storage].Type != "pbs" { // PBS compresses itself
		compress := req.Compress
		if compress == "" {
			compress = "zstd"
		}
		v, ok := backupCompress[compress]
		if !ok {
			return proto.ManageResponse{}, fieldErr(proto.CodeInvalidValue, "compress", "must be zstd, lzo, gzip or none")
		}
		params.Set("compress", v)
	}
	if req.Notes != "" {
		if err := checkText("notes", req.Notes, false); err != nil || len(req.Notes) > 1024 {
			return proto.ManageResponse{}, fieldErr(proto.CodeInvalidValue, "notes", "must be one line of text")
		}
		params.Set("notes-template", req.Notes)
	}
	if req.Protected != nil && *req.Protected {
		params.Set("protected", "1")
	}
	var upid string
	if err := r.api.post(ctx, r.nodePath()+"/vzdump", params, &upid); err != nil {
		return proto.ManageResponse{}, err
	}
	return taskAnswer(upid), nil
}

// backupVolume checks that volume is a backup volume of a storage of this
// node and returns its storage.
func (r *pveReq) backupVolume(ctx context.Context) (string, error) {
	st, rest, ok := splitVolume(r.req.Volume)
	if !ok || !strings.HasPrefix(rest, "backup/") {
		return "", fieldErr(proto.CodeInvalidValue, "volume", "not a backup volume")
	}
	info, err := r.nodeInfo(ctx)
	if err != nil {
		return "", err
	}
	if err := info.storageFor(st, "backup"); err != nil {
		_, msg := errCode(err, "")
		return "", fieldErr(proto.CodeNotAllowed, "volume", msg)
	}
	return st, nil
}

// listedBackup checks the request's volume, a backup on a backup storage of
// this node that its content list shows, and tells its kind (vm | container).
func (r *pveReq) listedBackup(ctx context.Context) (string, error) {
	st, err := r.backupVolume(ctx)
	if err != nil {
		return "", err
	}
	// The volume must be listed (and tells the guest kind).
	items, err := r.content(ctx, st, url.Values{"content": {"backup"}})
	if err != nil {
		return "", err
	}
	for _, it := range items {
		if it.VolID != r.req.Volume {
			continue
		}
		kind := backupKind(it.Subtype, it.VolID)
		if kind == "" {
			return "", codeErr(CodePlatformError, "cannot tell whether "+r.req.Volume+" is a VM or a container backup")
		}
		return kind, nil
	}
	return "", codeErr(proto.CodeNotFound, "backup "+r.req.Volume+" does not exist on this node")
}

// backupConfig is a backup's own configuration as vzdump stored it, read
// without restoring it: what a restore brings back (its disks and their
// sizes, its memory, its guest agent), which can differ from the guest's
// today. Its notes, snapshots and pending changes are left out.
func (r *pveReq) backupConfig(ctx context.Context) (proto.ManageResponse, error) {
	kind, err := r.listedBackup(ctx)
	if err != nil {
		return proto.ManageResponse{}, err
	}
	var raw string
	if err := r.api.get(ctx, r.nodePath()+"/vzdump/extractconfig", url.Values{"volume": {r.req.Volume}}, &raw); err != nil {
		return proto.ManageResponse{}, err
	}
	values := backupConfigValues(raw)
	if _, ok := values["cipassword"]; ok {
		values["cipassword"] = maskedSecret
	}
	c := &proto.GuestConfig{Platform: proto.PlatformPVE, Kind: kind, Values: values, Disks: pveDisks(kind, values, nil)}
	for k, v := range values {
		if pveRestricted(kind, k, v) && k != "rootfs" {
			c.Restricted = append(c.Restricted, k)
		}
	}
	sort.Strings(c.Restricted)
	return proto.ManageResponse{OK: true, Config: c}, nil
}

func (r *pveReq) backupRestore(ctx context.Context) (proto.ManageResponse, error) {
	req := r.req
	kind, err := r.listedBackup(ctx)
	if err != nil {
		return proto.ManageResponse{}, err
	}
	params := url.Values{}
	if req.Isolate != nil && (r.g != nil || req.Start) {
		return proto.ManageResponse{}, fieldErr(proto.CodeInvalidValue, "isolate", "only for a new guest that doesn't start")
	}
	var id string
	if r.g != nil {
		// Over the existing guest: same kind, stopped, same id.
		if r.g.Kind != kind {
			return proto.ManageResponse{}, fieldErr(proto.CodeInvalidValue, "volume", "a "+kind+" backup cannot replace a "+r.g.Kind)
		}
		if err := r.stopped(ctx); err != nil {
			return proto.ManageResponse{}, err
		}
		id = r.g.ID
		params.Set("force", "1")
	} else if id, err = r.newID(ctx); err != nil {
		return proto.ManageResponse{}, err
	}
	if req.Storage != "" {
		info, err := r.nodeInfo(ctx)
		if err != nil {
			return proto.ManageResponse{}, err
		}
		content := "images"
		if kind == "container" {
			content = "rootdir"
		}
		if err := info.storageFor(req.Storage, content); err != nil {
			_, msg := errCode(err, "")
			return proto.ManageResponse{}, fieldErr(proto.CodeNotAllowed, "storage", msg)
		}
		params.Set("storage", req.Storage)
	}
	params.Set("vmid", id)
	path := r.nodePath() + "/qemu"
	if kind == "container" {
		path = r.nodePath() + "/lxc"
		params.Set("ostemplate", req.Volume)
		params.Set("restore", "1")
	} else {
		params.Set("archive", req.Volume)
	}
	unique := req.Unique
	var isolation url.Values
	if req.Isolate != nil {
		if isolation, err = r.restoreIsolation(ctx, kind, *req.Isolate); err != nil {
			return proto.ManageResponse{}, err
		}
		// A container restored with unique gets the backup's network cards
		// back with only a new MAC address, dropping the isolated ones; the
		// isolated cards carry new MAC addresses of their own.
		if kind == "container" {
			unique = false
		}
		for k, v := range isolation {
			params[k] = v
		}
	}
	if unique {
		params.Set("unique", "1")
	}
	if req.Start {
		params.Set("start", "1")
	}
	var upid string
	err = r.api.post(ctx, path, params, &upid)
	if err != nil && isolation.Has("tags") && tagsRefused(err) {
		// A cluster that keeps tags to a list, or this token not allowed a
		// new one: the tag only helps a person spot the copy, so the copy
		// is restored without it. Proxmox checks the parameters before it
		// starts the restore, so nothing was made by the refused call.
		params.Del("tags")
		err = r.api.post(ctx, path, params, &upid)
	}
	if err != nil {
		return proto.ManageResponse{}, err
	}
	resp := taskAnswer(upid)
	resp.NewID = id
	return resp, nil
}

var (
	restoreMarkerRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)
	pveTagRe        = regexp.MustCompile(`^[a-z0-9_][a-z0-9_.+-]{0,63}$`)
	pveNetKeyRe     = regexp.MustCompile(`^net\d+$`)
	macAddrRe       = regexp.MustCompile(`^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$`)
	confKeyRe       = regexp.MustCompile(`^[a-z][a-z0-9_.-]*$`)
)

// restoreIsolation is what a restore is given so that the copy is cut off
// from the moment Proxmox VE writes its configuration: the backup's own
// network cards with their link down and a new MAC address, no start at
// boot, no protection, the copy's name and the marker as its notes, and the
// tag added to the backup's tags. Proxmox VE (7.2 and later for VMs) puts
// settings given with a restore over the backup's, apart from disks; an
// older one refuses a VM restore with them, which makes no copy at all.
func (r *pveReq) restoreIsolation(ctx context.Context, kind string, iso proto.RestoreIsolation) (url.Values, error) {
	if iso.Name == "" || len(iso.Name) > 63 || checkGuestName(iso.Name) != nil || strings.Contains(iso.Name, ".") {
		return nil, fieldErr(proto.CodeInvalidValue, "isolate.name", "must be a host name")
	}
	if !restoreMarkerRe.MatchString(iso.Marker) {
		return nil, fieldErr(proto.CodeInvalidValue, "isolate.marker", "must be one word of letters, digits, '-' and '_'")
	}
	if iso.Tag != "" && !pveTagRe.MatchString(iso.Tag) {
		return nil, fieldErr(proto.CodeInvalidValue, "isolate.tag", "not a Proxmox VE tag")
	}
	// The backup's own configuration: which network cards it has.
	var raw string
	if err := r.api.get(ctx, r.nodePath()+"/vzdump/extractconfig", url.Values{"volume": {r.req.Volume}}, &raw); err != nil {
		return nil, err
	}
	conf := backupConfigValues(raw)
	out := url.Values{}
	if kind == "container" {
		out.Set("hostname", iso.Name)
	} else {
		out.Set("name", iso.Name)
	}
	out.Set("onboot", "0")
	out.Set("description", iso.Marker)
	if v := conf["protection"]; v != "" && v != "0" {
		out.Set("protection", "0")
	}
	for k, v := range conf {
		if pveNetKeyRe.MatchString(k) {
			mac, err := randomMAC()
			if err != nil {
				return nil, err
			}
			out.Set(k, isolatedNet(kind, v, mac))
		}
	}
	if iso.Tag != "" {
		tags := slices.DeleteFunc(strings.FieldsFunc(conf["tags"], func(c rune) bool { return c == ';' || c == ',' || c == ' ' }),
			func(t string) bool { return !pveTagRe.MatchString(t) })
		if !slices.Contains(tags, iso.Tag) {
			tags = append(tags, iso.Tag)
		}
		out.Set("tags", strings.Join(tags, ";"))
	}
	return out, nil
}

// backupConfigValues reads a guest configuration as vzdump stored it
// ("key: value" lines; notes as '#' lines; snapshots and pending changes in
// [sections] after the current configuration, which are left out).
func backupConfigValues(raw string) map[string]string {
	out := map[string]string{}
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "[") {
			break
		}
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, ":")
		if k = strings.TrimSpace(k); ok && confKeyRe.MatchString(k) {
			out[k] = strings.TrimSpace(v)
		}
	}
	return out
}

// isolatedNet is a network card's value with its link down and mac as its
// MAC address (a VM's "virtio=…" or "macaddr=…", a container's "hwaddr=…"),
// the rest as it was.
func isolatedNet(kind, value, mac string) string {
	var parts []string
	replaced := false
	for _, p := range strings.Split(value, ",") {
		k, v, _ := strings.Cut(p, "=")
		switch {
		case p == "" || k == "link_down":
		case macAddrRe.MatchString(v):
			parts = append(parts, k+"="+mac)
			replaced = true
		default:
			parts = append(parts, p)
		}
	}
	if !replaced {
		key := "macaddr"
		if kind == "container" {
			key = "hwaddr"
		}
		parts = append(parts, key+"="+mac)
	}
	return strings.Join(append(parts, "link_down=1"), ",")
}

// randomMAC is a random locally administered unicast MAC address.
func randomMAC() (string, error) {
	b := make([]byte, 6)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	b[0] = b[0]&0xfc | 0x02
	return fmt.Sprintf("%02X:%02X:%02X:%02X:%02X:%02X", b[0], b[1], b[2], b[3], b[4], b[5]), nil
}

// tagsRefused: Proxmox VE refused a request over its tags (a tag outside
// the cluster's list, or one this token may not make).
func tagsRefused(err error) bool {
	var ae *pveAPIError
	if !errors.As(err, &ae) {
		return false
	}
	if _, ok := ae.Fields["tags"]; ok {
		return true
	}
	return ae.Status == http.StatusForbidden && strings.Contains(strings.ToLower(ae.Msg), "tag")
}

func (r *pveReq) volumePath(storage string) string {
	return r.nodePath() + "/storage/" + url.PathEscape(storage) + "/content/" + url.PathEscape(r.req.Volume)
}

func (r *pveReq) backupUpdate(ctx context.Context) (proto.ManageResponse, error) {
	st, err := r.backupVolume(ctx)
	if err != nil {
		return proto.ManageResponse{}, err
	}
	if err := checkText("notes", r.req.Notes, true); err != nil || len(r.req.Notes) > 4096 {
		return proto.ManageResponse{}, fieldErr(proto.CodeInvalidValue, "notes", "must be text of at most 4096 bytes")
	}
	// A request without Protected edits the notes ("" clears them); one
	// with Protected changes the notes only when it has some, so that
	// toggling protection keeps them.
	params := url.Values{}
	if r.req.Protected == nil || r.req.Notes != "" {
		params.Set("notes", r.req.Notes)
	}
	if r.req.Protected != nil {
		params.Set("protected", boolParam(*r.req.Protected))
	}
	if err := r.api.put(ctx, r.volumePath(st), params, nil); err != nil {
		return proto.ManageResponse{}, err
	}
	return proto.ManageResponse{OK: true}, nil
}

func boolParam(b bool) string {
	if b {
		return "1"
	}
	return "0"
}

func (r *pveReq) backupDelete(ctx context.Context) (proto.ManageResponse, error) {
	st, err := r.backupVolume(ctx)
	if err != nil {
		return proto.ManageResponse{}, err
	}
	var attrs struct {
		Protected pveValue `json:"protected"`
	}
	if err := r.api.get(ctx, r.volumePath(st), nil, &attrs); err != nil {
		return proto.ManageResponse{}, err
	}
	if attrs.Protected.bool() {
		return proto.ManageResponse{}, codeErr(proto.CodeProtected, "the backup is protected; remove the protection first")
	}
	var upid string
	if err := r.api.delete(ctx, r.volumePath(st), nil, &upid); err != nil {
		return proto.ManageResponse{}, err
	}
	return taskAnswer(upid), nil
}

// ---- storage content --------------------------------------------------------------

// contentStorage checks Storage and Content (iso, vztmpl, import) of a
// content request.
func (r *pveReq) contentStorage(ctx context.Context) error {
	if _, ok := downloadExts[r.req.Content]; !ok {
		return fieldErr(proto.CodeInvalidValue, "content", "must be iso, vztmpl or import")
	}
	info, err := r.nodeInfo(ctx)
	if err != nil {
		return err
	}
	if err := info.storageFor(r.req.Storage, r.req.Content); err != nil {
		_, msg := errCode(err, "")
		return fieldErr(proto.CodeNotAllowed, "storage", msg)
	}
	return nil
}

func storageVolumes(storage, content string, items []pveContent) []proto.StorageVolume {
	out := []proto.StorageVolume{}
	for _, it := range items {
		name := it.VolID
		if _, rest, ok := strings.Cut(it.VolID, ":"); ok {
			name = strings.TrimPrefix(rest, content+"/")
		}
		out = append(out, proto.StorageVolume{Volume: it.VolID, Storage: storage, Content: content, Name: name,
			SizeBytes: it.Size.uint(), Created: it.created()})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func (r *pveReq) contentList(ctx context.Context) (proto.ManageResponse, error) {
	if err := r.contentStorage(ctx); err != nil {
		return proto.ManageResponse{}, err
	}
	items, err := r.content(ctx, r.req.Storage, url.Values{"content": {r.req.Content}})
	if err != nil {
		return proto.ManageResponse{}, err
	}
	return proto.ManageResponse{OK: true, Content: storageVolumes(r.req.Storage, r.req.Content, items)}, nil
}

func (r *pveReq) contentDownload(ctx context.Context) (proto.ManageResponse, error) {
	req := r.req
	if err := r.contentStorage(ctx); err != nil {
		return proto.ManageResponse{}, err
	}
	if err := checkDownloadURL(req.URL); err != nil {
		return proto.ManageResponse{}, err
	}
	if err := checkDownloadName(req.Content, req.Filename); err != nil {
		return proto.ManageResponse{}, err
	}
	params := url.Values{"url": {req.URL}, "content": {req.Content}, "filename": {req.Filename}, "verify-certificates": {"1"}}
	switch {
	case req.Checksum == "" && req.ChecksumAlgorithm == "":
	case !checksumRe.MatchString(req.Checksum):
		return proto.ManageResponse{}, fieldErr(proto.CodeInvalidValue, "checksum", "must be a hexadecimal checksum")
	case !slices.Contains(checksumAlgs, req.ChecksumAlgorithm):
		return proto.ManageResponse{}, fieldErr(proto.CodeInvalidValue, "checksum_algorithm", "must be one of "+strings.Join(checksumAlgs, ", "))
	default:
		params.Set("checksum", req.Checksum)
		params.Set("checksum-algorithm", req.ChecksumAlgorithm)
	}
	var upid string
	if err := r.api.post(ctx, r.nodePath()+"/storage/"+url.PathEscape(req.Storage)+"/download-url", params, &upid); err != nil {
		return proto.ManageResponse{}, err
	}
	return taskAnswer(upid), nil
}

// contentDelete removes an ISO image, container template or import file
// with `pvesm free` as root: deleting volumes other than backups needs
// Datastore.Allocate, which would also let the manage token change
// storage definitions. The volume must be listed, exactly, by a storage of
// this node offering its content type.
func (r *pveReq) contentDelete(ctx context.Context) (proto.ManageResponse, error) {
	volid := r.req.Volume
	st, rest, ok := splitVolume(volid)
	content, name, _ := strings.Cut(rest, "/")
	if _, known := downloadExts[content]; !ok || !known || name == "" {
		return proto.ManageResponse{}, fieldErr(proto.CodeNotAllowed, "volume", "only ISO images, container templates and import files can be deleted here")
	}
	info, err := r.nodeInfo(ctx)
	if err != nil {
		return proto.ManageResponse{}, err
	}
	if err := info.storageFor(st, content); err != nil {
		_, msg := errCode(err, "")
		return proto.ManageResponse{}, fieldErr(proto.CodeNotAllowed, "volume", msg)
	}
	found, err := r.listed(ctx, st, content, volid)
	if err != nil {
		return proto.ManageResponse{}, err
	}
	if !found {
		return proto.ManageResponse{}, codeErr(proto.CodeNotFound, volid+" does not exist on this node")
	}
	if _, err := r.run(ctx, "pvesm", "free", volid); err != nil {
		return proto.ManageResponse{}, codeErr(CodePlatformError, err.Error())
	}
	return proto.ManageResponse{OK: true}, nil
}

func (r *pveReq) applianceList(ctx context.Context) (proto.ManageResponse, error) {
	var items []struct {
		Template    string `json:"template"`
		Package     string `json:"package"`
		Headline    string `json:"headline"`
		Description string `json:"description"`
		OS          string `json:"os"`
		Version     string `json:"version"`
		Section     string `json:"section"`
	}
	if err := r.api.get(ctx, r.nodePath()+"/aplinfo", nil, &items); err != nil {
		return proto.ManageResponse{}, err
	}
	out := make([]proto.Appliance, 0, len(items))
	for _, it := range items {
		out = append(out, proto.Appliance{Template: it.Template, Package: it.Package, Headline: it.Headline,
			Description: it.Description, OS: it.OS, Version: it.Version, Section: it.Section})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Template < out[j].Template })
	return proto.ManageResponse{OK: true, Appliances: out}, nil
}

func (r *pveReq) applianceDownload(ctx context.Context) (proto.ManageResponse, error) {
	req := r.req
	if !applianceRe.MatchString(req.Template) {
		return proto.ManageResponse{}, fieldErr(proto.CodeInvalidValue, "template", "invalid template name")
	}
	info, err := r.nodeInfo(ctx)
	if err != nil {
		return proto.ManageResponse{}, err
	}
	if err := info.storageFor(req.Storage, "vztmpl"); err != nil {
		_, msg := errCode(err, "")
		return proto.ManageResponse{}, fieldErr(proto.CodeNotAllowed, "storage", msg)
	}
	var upid string
	if err := r.api.post(ctx, r.nodePath()+"/aplinfo", url.Values{"storage": {req.Storage}, "template": {req.Template}}, &upid); err != nil {
		return proto.ManageResponse{}, err
	}
	return taskAnswer(upid), nil
}
