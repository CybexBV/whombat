package broker

import (
	"context"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"rackoon/internal/agent"
	"rackoon/internal/proto"
)

// pveManage is the Proxmox VE side of proto.StreamManage (docs/MANAGE.md
// 2.2-2.4): the manage token, the API client that uses it, and a short
// cache of the node's storages and bridges for validation. Every change
// goes through the local API with the manage token, except HA (ha-manager),
// deleting storage content (pvesm free) and changing backup jobs (pvesh),
// which run as root with validated arguments only.
type pveManage struct {
	node      string
	baseURL   string
	tokenFile string
	run       cmdRunner   // pveum, ha-manager, pvesm, pvesh
	isNode    func() bool // root on a Proxmox VE node (pveum present)
	newAPI    func(base, token string) (*pveAPI, error)
	now       func() time.Time

	mu         sync.Mutex // token state; held while provisioning
	api        *pveAPI
	provErr    error
	provAt     time.Time
	rejectedAt time.Time

	infoMu sync.Mutex
	info   *pveNodeInfo
	infoAt time.Time
}

// pveInfoTTL is how long the node's storages and bridges are cached.
const pveInfoTTL = 30 * time.Second

func newPVEManage(cfg *agent.Config) *pveManage {
	base, tokenFile := "https://127.0.0.1:8006/api2/json", filepath.Join(agent.DefaultConfigDir, "pve-manage-token")
	if cfg != nil {
		if cfg.PVE.URL != "" {
			base = strings.TrimRight(cfg.PVE.URL, "/")
		}
		switch {
		case cfg.PVE.ManageTokenFile != "":
			tokenFile = cfg.PVE.ManageTokenFile
		case cfg.Dir != "":
			tokenFile = filepath.Join(cfg.Dir, "pve-manage-token")
		}
	}
	return &pveManage{node: localNodeName(), baseURL: base, tokenFile: tokenFile,
		run: runCommand, isNode: isPVENode, newAPI: newPVEAPI, now: time.Now}
}

func isPVENode() bool {
	if os.Geteuid() != 0 {
		return false
	}
	_, err := exec.LookPath("pveum")
	return err == nil || fileExists("/usr/sbin/pveum")
}

func (d *pveDriver) manage(ctx context.Context, g *proto.Guest, req proto.ManageRequest) proto.ManageResponse {
	return d.mg.manage(ctx, g, req)
}

// pveReq is one manage request: the client, the validated guest (nil for
// host operations) and the request.
type pveReq struct {
	*pveManage
	api *pveAPI
	g   *proto.Guest
	req proto.ManageRequest
}

// pveOps are the operations by name.
var pveOps = map[string]func(*pveReq, context.Context) (proto.ManageResponse, error){
	proto.OpConfigGet:          (*pveReq).configGet,
	proto.OpConfigSet:          (*pveReq).configSet,
	proto.OpDiskResize:         (*pveReq).diskResize,
	proto.OpDiskMove:           (*pveReq).diskMove,
	proto.OpChoices:            (*pveReq).choices,
	proto.OpCreate:             (*pveReq).create,
	proto.OpClone:              (*pveReq).clone,
	proto.OpTemplate:           (*pveReq).template,
	proto.OpDelete:             (*pveReq).destroy,
	proto.OpMigrate:            (*pveReq).migrate,
	proto.OpBackupList:         (*pveReq).backupList,
	proto.OpBackupCreate:       (*pveReq).backupCreate,
	proto.OpBackupRestore:      (*pveReq).backupRestore,
	proto.OpBackupConfig:       (*pveReq).backupConfig,
	proto.OpBackupUpdate:       (*pveReq).backupUpdate,
	proto.OpBackupDelete:       (*pveReq).backupDelete,
	proto.OpContentList:        (*pveReq).contentList,
	proto.OpContentDownload:    (*pveReq).contentDownload,
	proto.OpContentDelete:      (*pveReq).contentDelete,
	proto.OpApplianceList:      (*pveReq).applianceList,
	proto.OpApplianceDownload:  (*pveReq).applianceDownload,
	proto.OpTaskList:           (*pveReq).taskList,
	proto.OpTaskStatus:         (*pveReq).taskStatus,
	proto.OpTaskStop:           (*pveReq).taskStop,
	proto.OpFirewallGet:        (*pveReq).firewallGet,
	proto.OpFirewallOptions:    (*pveReq).firewallOptions,
	proto.OpFirewallRuleAdd:    (*pveReq).firewallRuleAdd,
	proto.OpFirewallRuleUpdate: (*pveReq).firewallRuleUpdate,
	proto.OpFirewallRuleDelete: (*pveReq).firewallRuleDelete,
	proto.OpHASet:              (*pveReq).haSet,
	proto.OpHARemove:           (*pveReq).haRemove,
	proto.OpReplicationAdd:     (*pveReq).replicationAdd,
	proto.OpReplicationDelete:  (*pveReq).replicationDelete,
	proto.OpBackupJobList:      (*pveReq).backupJobList,
	proto.OpBackupJobCreate:    (*pveReq).backupJobCreate,
	proto.OpBackupJobUpdate:    (*pveReq).backupJobUpdate,
	proto.OpBackupJobDelete:    (*pveReq).backupJobDelete,
	proto.OpBackupJobRun:       (*pveReq).backupJobRun,
	proto.OpStorageAdd:         (*pveReq).storageAdd,
}

func (m *pveManage) manage(ctx context.Context, g *proto.Guest, req proto.ManageRequest) proto.ManageResponse {
	op := pveOps[req.Op]
	switch {
	case op == nil:
		return proto.ManageResponse{Code: CodeUnsupported, Message: "unknown operation"}
	case g == nil && manageGuestOps[req.Op]:
		return proto.ManageResponse{Code: CodeInvalid, Message: "guest is required"}
	case g != nil && (!vmidRe.MatchString(g.ID) || (g.Kind != "vm" && g.Kind != "container")):
		return proto.ManageResponse{Code: CodeInvalid, Message: "invalid Proxmox VE guest"}
	case g != nil && g.Node != "" && g.Node != m.node:
		return proto.ManageResponse{Code: CodeUnsupported, Message: "the guest runs on node " + g.Node + "; manage it through that node's agent"}
	}
	api, err := m.client(ctx)
	if err != nil {
		return apiFail(err)
	}
	resp, err := op(&pveReq{pveManage: m, api: api, g: g, req: req}, ctx)
	if err != nil {
		if apiStatus(err) == http.StatusUnauthorized {
			m.rejected(api)
		}
		return apiFail(err, req.Set["password"], req.Set["cipassword"])
	}
	m.accepted()
	return resp
}

// ---- paths and node state ---------------------------------------------------------

func (m *pveManage) nodePath() string { return "/nodes/" + url.PathEscape(m.node) }

// guestSub is the API collection of the guest's kind.
func guestSub(kind string) string {
	if kind == "container" {
		return "lxc"
	}
	return "qemu"
}

func (r *pveReq) guestPath() string { return r.nodePath() + "/" + guestSub(r.g.Kind) + "/" + r.g.ID }

func (r *pveReq) vm() bool { return r.g != nil && r.g.Kind == "vm" }

// status is the guest's run state (running, stopped).
func (r *pveReq) status(ctx context.Context) (string, error) {
	var st struct {
		Status string `json:"status"`
	}
	err := r.api.get(ctx, r.guestPath()+"/status/current", nil, &st)
	return st.Status, err
}

// stopped refuses an operation on a running guest.
func (r *pveReq) stopped(ctx context.Context) error {
	st, err := r.status(ctx)
	if err != nil {
		return err
	}
	if st != "stopped" {
		return codeErr(proto.CodeGuestRunning, "the guest must be stopped first")
	}
	return nil
}

// pveStorage is an entry of /nodes/{node}/storage.
type pveStorage struct {
	ID      string   `json:"storage"`
	Type    string   `json:"type"`
	Content string   `json:"content"`
	Active  pveValue `json:"active"`
	Enabled pveValue `json:"enabled"`
	Shared  pveValue `json:"shared"`
	Avail   pveValue `json:"avail"`
	Total   pveValue `json:"total"`
}

func (s pveStorage) contents() []string {
	var out []string
	for _, c := range strings.Split(s.Content, ",") {
		if c = strings.TrimSpace(c); c != "" {
			out = append(out, c)
		}
	}
	return out
}

func (s pveStorage) usable() bool { return s.Active.bool() && (s.Enabled == "" || s.Enabled.bool()) }

// pveNodeInfo is what validation checks values against.
type pveNodeInfo struct {
	storages map[string]pveStorage
	bridges  []string // Linux / OVS bridges and SDN vnets
}

// storageFor refuses a storage that is not an active storage of this node
// offering content.
func (i *pveNodeInfo) storageFor(id, content string) error {
	s, ok := i.storages[id]
	switch {
	case !ok:
		return codeErr(proto.CodeNotAllowed, "storage "+id+" is not a storage of this node")
	case !s.usable():
		return codeErr(proto.CodeNotAllowed, "storage "+id+" is not active")
	case !slices.Contains(s.contents(), content):
		return codeErr(proto.CodeNotAllowed, "storage "+id+" does not hold "+content+" content")
	}
	return nil
}

// withContent returns the usable storages offering content, by id.
func (i *pveNodeInfo) withContent(content string) []pveStorage {
	var out []pveStorage
	for _, s := range i.storages {
		if s.usable() && slices.Contains(s.contents(), content) {
			out = append(out, s)
		}
	}
	sort.Slice(out, func(a, b int) bool { return out[a].ID < out[b].ID })
	return out
}

// nodeInfo returns the node's storages and bridges (cached pveInfoTTL).
func (r *pveReq) nodeInfo(ctx context.Context) (*pveNodeInfo, error) {
	r.infoMu.Lock()
	defer r.infoMu.Unlock()
	if r.info != nil && r.now().Sub(r.infoAt) < pveInfoTTL {
		return r.info, nil
	}
	var sts []pveStorage
	if err := r.api.get(ctx, r.nodePath()+"/storage", nil, &sts); err != nil {
		return nil, err
	}
	var nets []struct {
		Iface string `json:"iface"`
	}
	if err := r.api.get(ctx, r.nodePath()+"/network", url.Values{"type": {"any_bridge"}}, &nets); err != nil {
		return nil, err
	}
	info := &pveNodeInfo{storages: map[string]pveStorage{}}
	for _, s := range sts {
		info.storages[s.ID] = s
	}
	for _, n := range nets {
		info.bridges = append(info.bridges, n.Iface)
	}
	// SDN vnets, when SDN is set up (403 / 501 otherwise).
	var vnets []struct {
		VNet string `json:"vnet"`
	}
	if err := r.api.get(ctx, "/cluster/sdn/vnets", nil, &vnets); err == nil {
		for _, v := range vnets {
			info.bridges = append(info.bridges, v.VNet)
		}
	} else if s := apiStatus(err); s == http.StatusUnauthorized || s == 0 {
		return nil, err
	}
	sort.Strings(info.bridges)
	info.bridges = slices.Compact(info.bridges)
	r.info, r.infoAt = info, r.now()
	return info, nil
}

// listed reports whether a storage of this node lists volid as content.
func (r *pveReq) listed(ctx context.Context, storage, content, volid string) (bool, error) {
	var vols []struct {
		VolID string `json:"volid"`
	}
	if err := r.api.get(ctx, r.nodePath()+"/storage/"+url.PathEscape(storage)+"/content", url.Values{"content": {content}}, &vols); err != nil {
		return false, err
	}
	for _, v := range vols {
		if v.VolID == volid {
			return true, nil
		}
	}
	return false, nil
}

func (r *pveReq) check(info *pveNodeInfo, kind string, create bool, cur, pend map[string]string) *pveCheck {
	return &pveCheck{kind: kind, create: create, cur: cur, pend: pend, info: info, listed: r.listed}
}

// cluster reports whether the node is part of a cluster, and the other
// nodes.
func (r *pveReq) cluster(ctx context.Context) (bool, []string, error) {
	var st []struct {
		Type  string   `json:"type"`
		Name  string   `json:"name"`
		Local pveValue `json:"local"`
	}
	if err := r.api.get(ctx, "/cluster/status", nil, &st); err != nil {
		return false, nil, err
	}
	cluster := false
	var nodes []string
	for _, e := range st {
		switch {
		case e.Type == "cluster":
			cluster = true
		case e.Type == "node" && !e.Local.bool() && e.Name != r.node:
			nodes = append(nodes, e.Name)
		}
	}
	sort.Strings(nodes)
	return cluster, nodes, nil
}

func (r *pveReq) requireCluster(ctx context.Context) ([]string, error) {
	cluster, nodes, err := r.cluster(ctx)
	if err != nil {
		return nil, err
	}
	if !cluster {
		return nil, codeErr(CodeUnsupported, "this Proxmox VE node is not part of a cluster")
	}
	return nodes, nil
}

// ---- configuration ----------------------------------------------------------------

type pvePendingItem struct {
	Key     string    `json:"key"`
	Value   *pveValue `json:"value"`
	Pending *pveValue `json:"pending"`
	Delete  pveValue  `json:"delete"`
}

// readPending returns the guest's current values, pending values and
// pending deletions (GET .../pending), cipassword masked.
func (r *pveReq) readPending(ctx context.Context) (cur, pend map[string]string, del []string, err error) {
	var items []pvePendingItem
	if err = r.api.get(ctx, r.guestPath()+"/pending", nil, &items); err != nil {
		return nil, nil, nil, err
	}
	cur, pend = map[string]string{}, map[string]string{}
	for _, it := range items {
		if it.Key == "" || it.Key == "digest" {
			continue
		}
		if it.Value != nil {
			cur[it.Key] = string(*it.Value)
		}
		if it.Pending != nil {
			pend[it.Key] = string(*it.Pending)
		}
		if it.Delete.int() > 0 {
			del = append(del, it.Key)
		}
	}
	for _, m := range []map[string]string{cur, pend} {
		if _, ok := m["cipassword"]; ok {
			m["cipassword"] = maskedSecret
		}
	}
	sort.Strings(del)
	return cur, pend, del, nil
}

func (r *pveReq) configGet(ctx context.Context) (proto.ManageResponse, error) {
	cur, pend, del, err := r.readPending(ctx)
	if err != nil {
		return proto.ManageResponse{}, err
	}
	var conf struct {
		Digest string `json:"digest"`
	}
	if err := r.api.get(ctx, r.guestPath()+"/config", nil, &conf); err != nil {
		return proto.ManageResponse{}, err
	}
	st, err := r.status(ctx)
	if err != nil {
		return proto.ManageResponse{}, err
	}
	c := &proto.GuestConfig{Platform: proto.PlatformPVE, Kind: r.g.Kind, Digest: conf.Digest, Lock: cur["lock"],
		Running: st == "running", Values: cur, PendingDelete: del}
	delete(cur, "lock")
	delete(pend, "lock")
	if len(pend) > 0 {
		c.Pending = pend
	}
	restricted := map[string]bool{}
	for _, m := range []map[string]string{cur, pend} {
		for k, v := range m {
			if pveRestricted(r.g.Kind, k, v) && k != "rootfs" {
				restricted[k] = true
			}
		}
	}
	for k := range restricted {
		c.Restricted = append(c.Restricted, k)
	}
	sort.Strings(c.Restricted)
	c.Disks = pveDisks(r.g.Kind, cur, pend)

	if cluster, _, err := r.cluster(ctx); err == nil && cluster {
		c.HA = r.haState(ctx)
		c.Replication = r.replicationJobs(ctx)
	}
	return proto.ManageResponse{OK: true, Config: c}, nil
}

// diskOrder sorts disk keys: root disk, buses, mount points, then unused.
var diskOrder = map[string]int{"rootfs": 0, "ide": 1, "sata": 2, "scsi": 3, "virtio": 4, "efidisk": 5, "tpmstate": 6, "mp": 7, "unused": 8}

var diskKeyRe = regexp.MustCompile(`^([a-z]+?)(\d*)$`)

func diskLess(a, b string) bool {
	ma, mb := diskKeyRe.FindStringSubmatch(a), diskKeyRe.FindStringSubmatch(b)
	if ma == nil || mb == nil {
		return a < b
	}
	if oa, ob := diskOrder[ma[1]], diskOrder[mb[1]]; oa != ob {
		return oa < ob
	}
	na, _ := strconv.Atoi(ma[2])
	nb, _ := strconv.Atoi(mb[2])
	return na < nb
}

// pveDisks parses the disk-like keys for display (pending-only disks
// included).
func pveDisks(kind string, cur, pend map[string]string) []proto.GuestDisk {
	boot := pveBootOrder(cur["boot"], cur["bootdisk"])
	var keys []string
	for k := range cur {
		if isPVEDiskKey(k) {
			keys = append(keys, k)
		}
	}
	for k := range pend {
		if _, ok := cur[k]; !ok && isPVEDiskKey(k) {
			keys = append(keys, k)
		}
	}
	sort.Slice(keys, func(i, j int) bool { return diskLess(keys[i], keys[j]) })
	out := make([]proto.GuestDisk, 0, len(keys))
	for _, k := range keys {
		v, ok := cur[k]
		if !ok {
			v = pend[k]
		}
		p := parsePropString(v)
		file, _ := p.Default(diskFileKeys(kind)...)
		d := proto.GuestDisk{Key: k, Media: "disk", Unused: strings.HasPrefix(k, "unused"), Boot: boot[k]}
		if file != "none" {
			d.Volume = file
		}
		if st, _, ok := strings.Cut(file, ":"); ok && !strings.HasPrefix(file, "/") {
			d.Storage = st
		}
		if s, ok := p.Get("size"); ok {
			d.SizeBytes, _ = parsePVESize(s)
		}
		if media, _ := p.Get("media"); media == "cdrom" {
			d.Media = "cdrom"
		}
		if kind == "container" {
			if k == "rootfs" {
				d.Path = "/"
			} else {
				d.Path, _ = p.Get("mp")
			}
		}
		out = append(out, d)
	}
	return out
}

// pveBootOrder returns the keys in the boot order ("order=scsi0;ide2;net0";
// the legacy form boots bootdisk).
func pveBootOrder(boot, bootdisk string) map[string]bool {
	out := map[string]bool{}
	p := parsePropString(boot)
	if order, ok := p.Get("order"); ok {
		for _, k := range strings.Split(order, ";") {
			if k = strings.TrimSpace(k); k != "" {
				out[k] = true
			}
		}
		return out
	}
	if bootdisk != "" {
		out[bootdisk] = true
	}
	return out
}

var pveSizeRe = regexp.MustCompile(`^([0-9]+(?:\.[0-9]+)?)([KMGT]?)$`)

// parsePVESize parses a PVE disk size ("32G", "709474K"; no unit: bytes).
func parsePVESize(s string) (uint64, bool) {
	m := pveSizeRe.FindStringSubmatch(s)
	if m == nil {
		return 0, false
	}
	f, err := strconv.ParseFloat(m[1], 64)
	if err != nil {
		return 0, false
	}
	mult := map[string]float64{"": 1, "K": 1 << 10, "M": 1 << 20, "G": 1 << 30, "T": 1 << 40}[m[2]]
	return uint64(f * mult), true
}

// configChange is one entry of ConfigChange with secrets masked.
func configChange(key, old, new string) proto.ConfigChange {
	if key == "cipassword" || key == "password" {
		if old != "" {
			old = maskedSecret
		}
		if new != "" {
			new = maskedSecret
		}
	}
	return proto.ConfigChange{Key: key, Old: old, New: new}
}

func (r *pveReq) configSet(ctx context.Context) (proto.ManageResponse, error) {
	req := r.req
	if len(req.Set)+len(req.Delete)+len(req.Revert) == 0 {
		return proto.ManageResponse{}, codeErr(CodeInvalid, "nothing to change")
	}
	seen := map[string]bool{}
	for _, list := range [][]string{sortedKeys(req.Set), req.Delete, req.Revert} {
		for _, k := range list {
			if seen[k] {
				return proto.ManageResponse{}, fieldErr(CodeInvalid, k, "the key is named more than once")
			}
			seen[k] = true
		}
	}
	cur, pend, pendDel, err := r.readPending(ctx)
	if err != nil {
		return proto.ManageResponse{}, err
	}
	info, err := r.nodeInfo(ctx)
	if err != nil {
		return proto.ManageResponse{}, err
	}
	c := r.check(info, r.g.Kind, false, cur, pend)
	latest := func(k string) (string, bool) {
		if v, ok := pend[k]; ok {
			return v, true
		}
		v, ok := cur[k]
		return v, ok && !slices.Contains(pendDel, k)
	}

	params := url.Values{}
	var changes []proto.ConfigChange
	for _, k := range sortedKeys(req.Set) {
		if err := c.key("set", k); err != nil {
			return proto.ManageResponse{}, err
		}
		v := req.Set[k]
		old, _ := latest(k)
		if v == old || (k == "cipassword" && v == maskedSecret) {
			continue // unchanged (the masked password stands for the current one)
		}
		if err := c.value(ctx, k, v); err != nil {
			return proto.ManageResponse{}, err
		}
		params.Set(k, v)
		changes = append(changes, configChange(k, old, v))
	}
	var dels, reverts []string
	for _, k := range slices.Sorted(slices.Values(req.Delete)) {
		if err := c.key("delete", k); err != nil {
			return proto.ManageResponse{}, err
		}
		old, ok := latest(k)
		if !ok {
			continue // not set (or already deleted at the next restart)
		}
		dels = append(dels, k)
		changes = append(changes, configChange(k, old, ""))
	}
	for _, k := range slices.Sorted(slices.Values(req.Revert)) {
		if err := c.key("revert", k); err != nil {
			return proto.ManageResponse{}, err
		}
		pv, pending := pend[k]
		if !pending && !slices.Contains(pendDel, k) {
			continue // nothing pending
		}
		reverts = append(reverts, k)
		changes = append(changes, configChange(k, pv, cur[k]))
	}
	if len(changes) == 0 {
		return proto.ManageResponse{OK: true}, nil
	}
	if len(dels) > 0 {
		params.Set("delete", strings.Join(dels, ","))
	}
	if len(reverts) > 0 {
		params.Set("revert", strings.Join(reverts, ","))
	}
	if req.Digest != "" {
		params.Set("digest", req.Digest)
	}
	var upid string
	if r.vm() {
		// background_delay: wait up to 5 s for the change (hotplug); a
		// change that takes longer answers with its task.
		params.Set("background_delay", "5")
		err = r.api.post(ctx, r.guestPath()+"/config", params, &upid)
	} else {
		err = r.api.put(ctx, r.guestPath()+"/config", params, nil)
	}
	if err != nil {
		return proto.ManageResponse{}, err
	}
	if _, pend2, del2, err := r.readPending(ctx); err == nil {
		for i, ch := range changes {
			_, p := pend2[ch.Key]
			changes[i].Pending = p || slices.Contains(del2, ch.Key)
		}
	}
	resp := taskAnswer(upid)
	resp.Changes = changes
	return resp, nil
}

// ---- disks ------------------------------------------------------------------------

// diskOf returns a disk's current value for disk.resize / disk.move:
// VM disks (not CD-ROMs), EFI and TPM disks and, for move, unused
// volumes; container root disks and mount points (not bind mounts).
func (r *pveReq) diskOf(ctx context.Context, unused bool) (string, error) {
	disk := r.req.Disk
	kt := pveKeyType(r.g.Kind, disk)
	ok := kt == keyDisk || kt == keyEFI || kt == keyRootFS || (unused && kt == keyUnused)
	if !ok {
		return "", fieldErr(proto.CodeInvalidValue, "disk", "not a disk of this guest")
	}
	cur, _, _, err := r.readPending(ctx)
	if err != nil {
		return "", err
	}
	v, ok := cur[disk]
	if !ok {
		return "", codeErr(proto.CodeNotFound, "the guest has no disk "+disk)
	}
	if pveRestricted(r.g.Kind, disk, v) {
		return "", fieldErr(proto.CodeNotAllowed, "disk", "host paths and bind mounts are managed in Proxmox VE")
	}
	if media, _ := parsePropString(v).Get("media"); media == "cdrom" {
		return "", fieldErr(proto.CodeInvalidValue, "disk", "CD/DVD drives have no size")
	}
	return v, nil
}

var resizeRe = regexp.MustCompile(`^(\+?)([0-9]+(?:\.[0-9]+)?)([KMGT]?)$`)

func (r *pveReq) diskResize(ctx context.Context) (proto.ManageResponse, error) {
	m := resizeRe.FindStringSubmatch(r.req.Size)
	if m == nil {
		return proto.ManageResponse{}, fieldErr(proto.CodeInvalidValue, "size", `must be "+NG" or the new size "NG"`)
	}
	add, _ := parsePVESize(m[2] + m[3])
	if add == 0 {
		return proto.ManageResponse{}, fieldErr(proto.CodeInvalidValue, "size", "must be more than 0")
	}
	v, err := r.diskOf(ctx, false)
	if err != nil {
		return proto.ManageResponse{}, err
	}
	if m[1] == "" {
		cs, _ := parsePropString(v).Get("size")
		curSize, ok := parsePVESize(cs)
		switch {
		case !ok:
			return proto.ManageResponse{}, fieldErr(proto.CodeInvalidValue, "size", "the current size is unknown; give the growth as +NG")
		case add <= curSize:
			return proto.ManageResponse{}, fieldErr(proto.CodeInvalidValue, "size", "disks can only grow (now "+cs+")")
		}
	}
	params := url.Values{"disk": {r.req.Disk}, "size": {r.req.Size}}
	if r.req.Digest != "" {
		params.Set("digest", r.req.Digest)
	}
	var upid string
	if err := r.api.put(ctx, r.guestPath()+"/resize", params, &upid); err != nil {
		return proto.ManageResponse{}, err
	}
	return taskAnswer(upid), nil
}

func (r *pveReq) diskMove(ctx context.Context) (proto.ManageResponse, error) {
	v, err := r.diskOf(ctx, r.vm())
	if err != nil {
		return proto.ManageResponse{}, err
	}
	info, err := r.nodeInfo(ctx)
	if err != nil {
		return proto.ManageResponse{}, err
	}
	content, name := "images", "disk"
	if !r.vm() {
		content, name = "rootdir", "volume"
	}
	if err := info.storageFor(r.req.Storage, content); err != nil {
		_, msg := errCode(err, "")
		return proto.ManageResponse{}, fieldErr(proto.CodeNotAllowed, "storage", msg)
	}
	if file, _ := parsePropString(v).Default(diskFileKeys(r.g.Kind)...); strings.HasPrefix(file, r.req.Storage+":") {
		return proto.ManageResponse{}, fieldErr(proto.CodeInvalidValue, "storage", "the disk is already on "+r.req.Storage)
	}
	params := url.Values{name: {r.req.Disk}, "storage": {r.req.Storage}}
	if r.req.DeleteSource {
		params.Set("delete", "1")
	}
	if r.req.Digest != "" {
		params.Set("digest", r.req.Digest)
	}
	path := r.guestPath() + "/move_disk"
	if !r.vm() {
		path = r.guestPath() + "/move_volume"
	}
	var upid string
	if err := r.api.post(ctx, path, params, &upid); err != nil {
		return proto.ManageResponse{}, err
	}
	return taskAnswer(upid), nil
}
