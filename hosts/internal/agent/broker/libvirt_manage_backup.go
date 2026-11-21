package broker

import (
	"bytes"
	"encoding/json"
	"fmt"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	libvirt "github.com/digitalocean/go-libvirt"

	"rackoon/internal/proto"
)

// Whombat's VM backups (docs/MANAGE.md 2.7): one folder per backup,
// <backups>/<vm>/<yyyymmdd-hhmmss>/, with a qcow2 file per disk, the UEFI
// variables (nvram.fd), the VM's XML (domain.xml) and backup.json, written
// last (a folder without it is an unfinished backup). A running VM is
// backed up by libvirt's own backup job (push mode, consistent at its
// start); a stopped one's disk files are copied. A restore is always a new
// VM with a new UUID and new MAC addresses.

const (
	lvBackupMeta = "backup.json"
	lvBackupXML  = "domain.xml"
	lvBackupNV   = "nvram.fd"
	lvJobPoll    = 2 * time.Second
)

var lvStampRE = regexp.MustCompile(`^[0-9]{8}-[0-9]{6}(-[0-9]{1,2})?$`)

// lvBackupMetaDoc is backup.json.
type lvBackupMetaDoc struct {
	Name    string             `json:"name"`
	UUID    string             `json:"uuid"`
	Created int64              `json:"created"` // unix seconds
	Running bool               `json:"running"` // backed up while running (libvirt's backup job)
	Notes   string             `json:"notes,omitempty"`
	Disks   []lvBackupMetaDisk `json:"disks"`
	NVRAM   string             `json:"nvram,omitempty"` // file name of the UEFI variables
	Left    []string           `json:"left_out,omitempty"`
}

type lvBackupMetaDisk struct {
	Target string `json:"target"` // vda
	File   string `json:"file"`   // vda.qcow2
	Format string `json:"format"` // of the backup file
	Size   uint64 `json:"size"`   // virtual size
	Source string `json:"source"` // the VM's file at backup time
}

// lvVMDir is a VM's folder name under the backups folder: its name with
// anything but letters, digits, dot, dash and underscore as "_".
func lvVMDir(name string) string {
	var b strings.Builder
	for i, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case (r == '.' || r == '-' || r == '_') && i > 0:
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	s := b.String()
	if s == "" || s[0] == '_' || s[0] == '.' {
		s = "vm" + s
	}
	if len(s) > 100 {
		s = s[:100]
	}
	return s
}

// lvBackupEntry is a backup found on disk.
type lvBackupEntry struct {
	stamp, dir string
	meta       lvBackupMetaDoc
	size       uint64
}

// listBackupDirs reads a VM folder's finished backups, newest first.
func listBackupDirs(fsys LibvirtFS, vmDir string) []lvBackupEntry {
	ents, err := fsys.ReadDir(vmDir)
	if err != nil {
		return nil
	}
	var out []lvBackupEntry
	for _, e := range ents {
		if !e.Dir || !lvStampRE.MatchString(e.Name) {
			continue
		}
		dir := path.Join(vmDir, e.Name)
		b, err := fsys.ReadFile(path.Join(dir, lvBackupMeta))
		if err != nil {
			continue
		}
		be := lvBackupEntry{stamp: e.Name, dir: dir}
		if json.Unmarshal(b, &be.meta) != nil {
			continue
		}
		if files, err := fsys.ReadDir(dir); err == nil {
			for _, f := range files {
				if st, err := fsys.Stat(path.Join(dir, f.Name)); err == nil && !st.Dir {
					be.size += st.UsedBytes
				}
			}
		}
		out = append(out, be)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].stamp > out[j].stamp })
	return out
}

func (be lvBackupEntry) volume() proto.BackupVolume {
	return proto.BackupVolume{Volume: be.stamp, Storage: proto.PlatformLibvirt, GuestID: be.meta.Name, Kind: "vm",
		SizeBytes: be.size, Created: time.Unix(be.meta.Created, 0).UTC(), Format: "qcow2", Notes: be.meta.Notes}
}

// ---- backup.list ---------------------------------------------------------------

// backupList: a VM's backups (by its UUID, or its name when it is gone),
// or with no VM every VM's.
func (m *lvManager) backupList(conn LibvirtConn, g *proto.Guest, req proto.ManageRequest) proto.ManageResponse {
	h, err := readHost(conn, m.fs, m.backupsDir)
	if err != nil {
		return lvResp(err)
	}
	out := []proto.BackupVolume{}
	if h.backupsDir == "" {
		return proto.ManageResponse{OK: true, Backups: out}
	}
	name := req.GuestID
	if g != nil {
		name = g.ID
	}
	if name == "" {
		vms, _ := m.fs.ReadDir(h.backupsDir)
		for _, vm := range vms {
			if vm.Dir {
				for _, be := range listBackupDirs(m.fs, path.Join(h.backupsDir, vm.Name)) {
					out = append(out, be.volume())
				}
			}
		}
		sort.SliceStable(out, func(i, j int) bool { return out[i].Created.After(out[j].Created) })
		return proto.ManageResponse{OK: true, Backups: out}
	}
	uuid := ""
	if ref, err := conn.DomainLookupByName(name); err == nil {
		if x, err := conn.DomainGetXMLDesc(ref, libvirt.DomainXMLInactive); err == nil {
			if d, err := parseLvDom(x); err == nil {
				uuid = d.uuid()
			}
		}
	}
	for _, be := range listBackupDirs(m.fs, path.Join(h.backupsDir, lvVMDir(name))) {
		if uuid != "" && be.meta.UUID != uuid && be.meta.Name != name {
			continue
		}
		out = append(out, be.volume())
	}
	return proto.ManageResponse{OK: true, Backups: out}
}

// ---- backup.create -------------------------------------------------------------

func (m *lvManager) backupCreate(conn LibvirtConn, g *proto.Guest, req proto.ManageRequest) proto.ManageResponse {
	st, err := m.loadDomain(conn, g.ID)
	if err != nil {
		return lvResp(err)
	}
	h, err := readHost(conn, m.fs, m.backupsDir)
	if err != nil {
		return lvResp(err)
	}
	if h.backupsDir == "" {
		return proto.ManageResponse{Code: proto.CodeNotAllowed,
			Message: "There is no folder for VM backups on this server: set backups_dir under [libvirt] in the agent’s agent.toml."}
	}
	if msg := lvText(req.Notes, 1024, true); msg != "" {
		return lvFields(map[string]string{"notes": msg})
	}
	vmDir := path.Join(h.backupsDir, lvVMDir(g.ID))
	stamp := m.now().UTC().Format("20060102-150405")
	for i := 2; m.fs.Exists(path.Join(vmDir, stamp)) && i < 100; i++ {
		stamp = m.now().UTC().Format("20060102-150405") + "-" + strconv.Itoa(i)
	}
	dir := path.Join(vmDir, stamp)
	meta := lvBackupMetaDoc{Name: g.ID, UUID: st.inactive.uuid(), Created: m.now().Unix(), Running: st.running, Notes: req.Notes}
	type part struct {
		target, src, format string
		size                uint64
	}
	var parts []part
	// A running VM is backed up with the disks it runs with (a disk added
	// for the next start is not in it yet).
	for _, n := range st.current().diskNodes("disk") {
		d := readLvDisk(n)
		src := d.path
		if d.typ == "volume" {
			if pl, err := conn.StoragePoolLookupByName(d.pool); err == nil {
				if v, err := conn.StorageVolLookupByName(pl, d.vol); err == nil {
					src, _ = conn.StorageVolGetPath(v)
				}
			}
		}
		if d.readonly || d.typ != "file" && d.typ != "volume" || src == "" {
			meta.Left = append(meta.Left, d.target)
			continue
		}
		parts = append(parts, part{target: d.target, src: src, format: d.format, size: m.diskSize(conn, h, d)})
	}
	if len(parts) == 0 {
		return proto.ManageResponse{Code: proto.CodeNotAllowed, Message: "This VM has no disk file Whombat can back up."}
	}
	xmlPlain, err := conn.DomainGetXMLDesc(st.ref, libvirt.DomainXMLInactive)
	if err != nil {
		return lvPlatformError(err)
	}
	nvSrc := st.inactive.x.path("os/nvram").textContent()
	running := st.running
	ref := st.ref
	id := m.tasks.start("vzdump", g.ID, func(t *lvTaskHandle) error {
		c, err := m.dial()
		if err != nil {
			return err
		}
		defer c.Disconnect()
		fail := func(err error) error {
			m.removeBackupDir(c, h, dir)
			return err
		}
		if req.Compress != "" && req.Compress != "none" && req.Compress != "0" {
			t.logf("Backups are qcow2 files that take only the used space; they are not compressed further.")
		}
		t.logf("Backing up %s into %s.", g.ID, dir)
		for _, l := range meta.Left {
			t.logf("Disk %s is read-only or a whole device; it is left out.", l)
		}
		if running {
			if err := m.backupJob(c, h, t, ref, dir, st.current(), lvTargets(parts, func(p part) (string, string) { return p.target, p.src })); err != nil {
				return fail(err)
			}
		} else {
			for _, p := range parts {
				if t.stopped() {
					return fail(errLvStopped)
				}
				if _, err := m.copyFile(c, h, t, lvDiskCopy{src: p.src, dstDir: dir, dstName: p.target + ".qcow2", format: "qcow2"}, "disk "+p.target); err != nil {
					return fail(err)
				}
			}
		}
		for _, p := range parts {
			meta.Disks = append(meta.Disks, lvBackupMetaDisk{Target: p.target, File: p.target + ".qcow2", Format: "qcow2", Size: p.size, Source: p.src})
		}
		if nvSrc != "" && m.fs.Exists(nvSrc) {
			if _, err := m.copyFile(c, h, t, lvDiskCopy{src: nvSrc, dstDir: dir, dstName: lvBackupNV, format: "raw"}, "the UEFI variables"); err == nil {
				meta.NVRAM = lvBackupNV
			} else {
				t.logf("The UEFI variables were not copied (%v).", err)
			}
		}
		mb, _ := json.MarshalIndent(meta, "", "  ")
		err = withDir(c, h, dir, true, func(pool libvirt.StoragePool) error {
			if err := writeSmallFile(c, pool, lvBackupXML, []byte(xmlPlain)); err != nil {
				return err
			}
			return writeSmallFile(c, pool, lvBackupMeta, mb)
		})
		if err != nil {
			return fail(fmt.Errorf("writing the backup's description: %w", err))
		}
		var total uint64
		for _, be := range listBackupDirs(m.fs, vmDir) {
			if be.stamp == stamp {
				total = be.size
			}
		}
		if total > 0 {
			t.logf("Backup %s is done (%s).", stamp, lvFmtBytes(total))
		} else {
			t.logf("Backup %s is done.", stamp)
		}
		return nil
	})
	return proto.ManageResponse{OK: true, Task: &proto.TaskRef{ID: id}}
}

func lvTargets[T any](parts []T, f func(T) (string, string)) map[string]string {
	out := map[string]string{}
	for _, p := range parts {
		k, v := f(p)
		out[k] = v
	}
	return out
}

// backupJob runs libvirt's backup job (push mode) of a running VM into dir:
// one qcow2 per disk in targets (target -> source), progress from the
// job's statistics, stop aborts it.
func (m *lvManager) backupJob(conn LibvirtConn, h *lvHost, t *lvTaskHandle, ref libvirt.Domain, dir string, d *lvDom, targets map[string]string) error {
	// libvirt writes the files; the folder must exist.
	if err := withDir(conn, h, dir, true, func(libvirt.StoragePool) error { return nil }); err != nil {
		return err
	}
	doc := newElem("domainbackup", "mode", "push")
	disks := doc.add(newElem("disks"))
	for _, n := range d.diskNodes("disk") {
		tgt := n.child("target").attr("dev")
		if _, ok := targets[tgt]; !ok {
			disks.add(newElem("disk", "name", tgt, "backup", "no"))
			continue
		}
		dk := disks.add(newElem("disk", "name", tgt, "backup", "yes", "type", "file"))
		dk.add(newElem("driver", "type", "qcow2"))
		dk.add(newElem("target", "file", path.Join(dir, tgt+".qcow2")))
	}
	t.logf("Starting libvirt’s backup job (the VM keeps running).")
	if err := conn.DomainBackupBegin(ref, doc.String(), nil, 0); err != nil {
		low := strings.ToLower(err.Error())
		if strings.Contains(low, "backup") && (strings.Contains(low, "unsupported") || strings.Contains(low, "not supported")) {
			t.logf("libvirt said: %s", firstLine(err.Error(), 300))
			return fmt.Errorf("this server’s libvirt or QEMU cannot back up a running VM; shut it down and back it up then")
		}
		return fmt.Errorf("starting the backup: %s", firstLine(err.Error(), 300))
	}
	t.onStop(func() { _ = conn.DomainAbortJob(ref) })
	defer t.onStop(nil)
	wait := 100 * time.Millisecond
	for {
		typ, params, err := conn.DomainGetJobStats(ref, 0)
		if err != nil {
			return fmt.Errorf("following the backup: %w", err)
		}
		if typ == 0 { // VIR_DOMAIN_JOB_NONE: done
			break
		}
		total, done := lvJobProgress(params)
		if total > 0 {
			t.progress("Backing up: %d %% (%s of %s)", min(99, int(float64(done)/float64(total)*100)), lvFmtBytes(done), lvFmtBytes(total))
		}
		time.Sleep(wait)
		wait = min(2*wait, lvJobPoll)
	}
	typ, params, err := conn.DomainGetJobStats(ref, libvirt.DomainJobStatsCompleted)
	if err != nil {
		return nil // the job ended; libvirt kept no statistics
	}
	switch typ {
	case 3: // completed
		_, read := lvJobProgress(params)
		t.logf("libvirt’s backup job finished (%s read).", lvFmtBytes(read))
		return nil
	case 5: // cancelled
		return errLvStopped
	}
	if msg := lvJobText(params, "errmsg"); msg != "" {
		return fmt.Errorf("the backup failed: %s", msg)
	}
	return fmt.Errorf("the backup failed")
}

// lvJobProgress: a backup job's total and done bytes (disk_* for backups,
// data_* for older reports).
func lvJobProgress(params []libvirt.TypedParam) (total, done uint64) {
	for _, k := range []string{"disk", "data"} {
		if t := lvJobParam(params, k+"_total"); t > 0 {
			return t, lvJobParam(params, k+"_processed")
		}
	}
	return 0, 0
}

func lvJobParam(params []libvirt.TypedParam, field string) uint64 {
	for _, p := range params {
		if p.Field == field {
			if v, ok := lvTypedUint(p.Value); ok {
				return v
			}
		}
	}
	return 0
}

func lvTypedUint(v libvirt.TypedParamValue) (uint64, bool) {
	switch x := v.I.(type) {
	case uint64:
		return x, true
	case int64:
		return uint64(max(x, 0)), true
	case uint32:
		return uint64(x), true
	case int32:
		return uint64(max(x, 0)), true
	}
	return 0, false
}

func lvJobText(params []libvirt.TypedParam, field string) string {
	for _, p := range params {
		if s, ok := p.Value.I.(string); ok && p.Field == field {
			return s
		}
	}
	return ""
}

// writeSmallFile writes a file into a pool's folder through libvirt.
func writeSmallFile(conn LibvirtConn, pool libvirt.StoragePool, name string, data []byte) error {
	if v, err := conn.StorageVolLookupByName(pool, name); err == nil {
		_ = conn.StorageVolDelete(v, 0)
	}
	doc := newElem("volume")
	doc.add(newElem("name")).setText(name)
	doc.add(newElem("capacity", "unit", "bytes")).setText(strconv.Itoa(len(data)))
	doc.add(newElem("target")).add(newElem("format", "type", "raw"))
	v, err := conn.StorageVolCreateXML(pool, doc.String(), 0)
	if err != nil {
		return err
	}
	if err := conn.StorageVolUpload(v, bytes.NewReader(data), 0, uint64(len(data)), 0); err != nil {
		_ = conn.StorageVolDelete(v, 0)
		return err
	}
	return nil
}

// removeBackupDir deletes a backup folder with its files, and the VM's
// folder when that is empty then.
func (m *lvManager) removeBackupDir(conn LibvirtConn, h *lvHost, dir string) {
	_ = withDir(conn, h, dir, false, func(pool libvirt.StoragePool) error {
		vols, _, err := conn.StoragePoolListAllVolumes(pool, 1, 0)
		if err != nil {
			return err
		}
		for _, v := range vols {
			_ = conn.StorageVolDelete(v, 0)
		}
		return nil
	})
	_ = removeDir(conn, h, dir)
	vmDir := filepath.Dir(dir)
	if ents, err := m.fs.ReadDir(vmDir); err == nil && len(ents) == 0 {
		_ = removeDir(conn, h, vmDir)
	}
}

// findBackup locates a VM's backup by its folder name.
func (m *lvManager) findBackup(h *lvHost, vm, stamp string) (lvBackupEntry, *proto.ManageResponse) {
	if h.backupsDir == "" {
		return lvBackupEntry{}, &proto.ManageResponse{Code: proto.CodeNotFound, Message: "this server keeps no VM backups"}
	}
	if !lvStampRE.MatchString(stamp) {
		return lvBackupEntry{}, &proto.ManageResponse{Code: proto.CodeInvalidValue, Message: "volume: not a backup (yyyymmdd-hhmmss)",
			FieldErrors: map[string]string{"volume": "not a backup (yyyymmdd-hhmmss)"}}
	}
	if vm == "" {
		return lvBackupEntry{}, &proto.ManageResponse{Code: proto.CodeInvalidValue, Message: "guest: say whose backup it is",
			FieldErrors: map[string]string{"guest": "say whose backup it is"}}
	}
	for _, be := range listBackupDirs(m.fs, path.Join(h.backupsDir, lvVMDir(vm))) {
		if be.stamp == stamp {
			return be, nil
		}
	}
	return lvBackupEntry{}, &proto.ManageResponse{Code: proto.CodeNotFound, Message: "there is no backup " + stamp + " of " + vm}
}

// ---- backup.restore ------------------------------------------------------------

func (m *lvManager) backupRestore(conn LibvirtConn, req proto.ManageRequest) proto.ManageResponse {
	h, err := readHost(conn, m.fs, m.backupsDir)
	if err != nil {
		return lvResp(err)
	}
	be, bad := m.findBackup(h, req.GuestID, req.Volume)
	if bad != nil {
		return *bad
	}
	name := req.Name
	if name == "" {
		name = be.meta.Name + "-restored"
	}
	if !lvNameRE.MatchString(name) {
		return lvFields(map[string]string{"name": "names are up to 64 letters, digits, dots, dashes and underscores, starting with a letter or digit"})
	}
	if _, err := conn.DomainLookupByName(name); err == nil {
		return proto.ManageResponse{Code: proto.CodeExists, Message: "another VM is called " + name,
			FieldErrors: map[string]string{"name": "another VM is called " + name}}
	}
	xb, err := m.fs.ReadFile(path.Join(be.dir, lvBackupXML))
	if err != nil {
		return proto.ManageResponse{Code: CodePlatformError, Message: "the backup has no domain.xml"}
	}
	doc, err := parseLvDom(string(xb))
	if err != nil {
		return proto.ManageResponse{Code: CodePlatformError, Message: "the backup's domain.xml is not readable: " + err.Error()}
	}
	if req.Storage != "" {
		if _, err := targetFor(h, req.Storage, name, "vda", 0); err != nil {
			return lvResp(err)
		}
	}
	id := m.tasks.start("qmrestore", name, func(t *lvTaskHandle) error {
		c, err := m.dial()
		if err != nil {
			return err
		}
		defer c.Disconnect()
		t.logf("Restoring %s’s backup %s as %s.", be.meta.Name, be.stamp, name)
		uuid := newIdentity(doc, name)
		var made []string
		fail := func(err error) error {
			for _, p := range made {
				_ = deleteFile(c, h, p)
			}
			return err
		}
		backed := map[string]lvBackupMetaDisk{}
		for _, d := range be.meta.Disks {
			backed[d.Target] = d
		}
		for i, n := range doc.diskNodes("disk") {
			disk := readLvDisk(n)
			bd, ok := backed[disk.target]
			if !ok {
				if !disk.readonly {
					// A writable disk that is not in the backup (a whole
					// device) would be shared with the original: left out.
					t.logf("Disk %s is not in the backup; the restored VM goes without it.", disk.target)
					doc.devices().remove(n)
				}
				continue
			}
			if t.stopped() {
				return fail(errLvStopped)
			}
			dst := req.Storage
			if dst == "" {
				dst = h.storageOf(bd.Source)
				if _, ok := h.pool(dst); !ok && (dst != proto.LibvirtDomainsFolder || h.folderPath(dst) == "") {
					dst = defaultImageStorage(h)
				}
			}
			cp, err := targetFor(h, dst, name, disk.target, i)
			if err != nil {
				return fail(err)
			}
			cp.src = path.Join(be.dir, bd.File)
			pl, _ := h.pool(dst)
			p, err := m.copyFile(c, h, t, cp, "disk "+disk.target)
			if err != nil {
				return fail(err)
			}
			made = append(made, p)
			copiedDisk(n, p, cp.format, cp.dstPool != "" && !pl.fileBased())
		}
		nvSrc := ""
		if be.meta.NVRAM != "" {
			nvSrc = path.Join(be.dir, be.meta.NVRAM)
			// The variables go where the original's were.
			if nv := doc.x.path("os/nvram"); nv != nil && nv.textContent() != "" {
				m.copyNVRAMTo(c, h, t, doc, nvSrc, filepath.Dir(nv.textContent()), filepath.Base(nv.textContent()), uuid)
			} else if nv != nil {
				m.copyNVRAMTo(c, h, t, doc, nvSrc, "/var/lib/libvirt/qemu/nvram", "_VARS.fd", uuid)
			}
		} else if nv := doc.x.path("os/nvram"); nv != nil {
			nv.kids = nil
		}
		if doc.x.path("devices/tpm") != nil {
			t.logf("The restored VM gets a new, empty TPM.")
		}
		dom, err := c.DomainDefineXMLFlags(doc.String(), libvirt.DomainDefineValidate)
		if err != nil {
			return fail(fmt.Errorf("defining the restored VM: %w", err))
		}
		t.logf("%s is ready (new UUID and MAC addresses).", name)
		if req.Start {
			if err := c.DomainCreate(dom); err != nil {
				return fmt.Errorf("%s was restored but did not start: %w", name, err)
			}
			t.logf("%s is running.", name)
		}
		return nil
	})
	return proto.ManageResponse{OK: true, Task: &proto.TaskRef{ID: id}, NewID: name}
}

// copyNVRAMTo copies backed-up UEFI variables into dir as <uuid><suffix>
// (the original's file name after its UUID or name, e.g. "_VARS.fd").
func (m *lvManager) copyNVRAMTo(conn LibvirtConn, h *lvHost, t *lvTaskHandle, d *lvDom, src, dir, origBase, uuid string) {
	nv := d.x.path("os/nvram")
	suffix := "_VARS.fd"
	if i := strings.Index(origBase, "_VARS"); i >= 0 {
		suffix = origBase[i:]
	}
	p, err := m.copyFile(conn, h, t, lvDiskCopy{src: src, dstDir: dir, dstName: uuid + suffix, format: "raw"}, "the UEFI variables")
	if err != nil {
		t.logf("The UEFI variables could not be restored (%v); the VM starts with fresh ones.", err)
		nv.kids = nil
		return
	}
	nv.setText(p)
}

// ---- backup.delete -------------------------------------------------------------

func (m *lvManager) backupDelete(conn LibvirtConn, req proto.ManageRequest) proto.ManageResponse {
	h, err := readHost(conn, m.fs, m.backupsDir)
	if err != nil {
		return lvResp(err)
	}
	be, bad := m.findBackup(h, req.GuestID, req.Volume)
	if bad != nil {
		return *bad
	}
	m.removeBackupDir(conn, h, be.dir)
	if m.fs.Exists(path.Join(be.dir, lvBackupMeta)) {
		return proto.ManageResponse{Code: CodePlatformError, Message: "libvirt could not delete the backup's files in " + be.dir}
	}
	return proto.ManageResponse{OK: true}
}
