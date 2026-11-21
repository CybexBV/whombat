package broker

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"

	libvirt "github.com/digitalocean/go-libvirt"

	"rackoon/internal/proto"
)

// What libvirt has on this host (pools, networks, unRAID's folders,
// firmware, the backups folder) for the host view, the choices and the
// path checks of the manager.

const (
	lvDomainCfg   = "/boot/config/domain.cfg" // unRAID's VM Manager settings
	lvBackupsName = ".whombat-backups"
	lvTmpPool     = "whombat-tmp-" // transient pools the agent makes to write files through libvirt
	lvQEMULogDir  = "/var/log/libvirt/qemu"
)

// lvPool is a storage pool.
type lvPool struct {
	ref                    libvirt.StoragePool
	name, typ, path        string
	active, autostart      bool
	capacity, alloc, avail uint64
	volumes                int
}

// fileBased: the pool keeps its volumes as files in path (qcow2 works).
func (p lvPool) fileBased() bool {
	switch p.typ {
	case "dir", "fs", "netfs", "glusterfs", "vstorage":
		return p.path != ""
	}
	return false
}

// lvHost is a reading of libvirt's host objects.
type lvHost struct {
	pools      []lvPool
	folders    *proto.LibvirtFolders
	backupsDir string
	domcaps    string // domain capabilities for q35 ("" when unreadable)
}

// lvOSFS reads the real file system.
type lvOSFS struct{}

func (lvOSFS) ReadFile(p string) ([]byte, error) { return os.ReadFile(p) }

func (lvOSFS) ReadDir(p string) ([]LibvirtDirEntry, error) {
	ents, err := os.ReadDir(p)
	if err != nil {
		return nil, err
	}
	out := make([]LibvirtDirEntry, 0, len(ents))
	for _, e := range ents {
		out = append(out, LibvirtDirEntry{Name: e.Name(), Dir: e.IsDir()})
	}
	return out, nil
}

func (lvOSFS) Stat(p string) (LibvirtFileInfo, error) {
	st, err := os.Stat(p)
	if err != nil {
		return LibvirtFileInfo{}, err
	}
	fi := LibvirtFileInfo{Size: st.Size(), ModTime: st.ModTime().Unix(), Dir: st.IsDir(), UsedBytes: uint64(st.Size())}
	if s, ok := st.Sys().(*syscall.Stat_t); ok {
		fi.UsedBytes = uint64(s.Blocks) * 512
	}
	return fi, nil
}

func (lvOSFS) Statfs(p string) (uint64, uint64, error) {
	var s syscall.Statfs_t
	if err := syscall.Statfs(p, &s); err != nil {
		return 0, 0, err
	}
	return s.Blocks * uint64(s.Bsize), s.Bavail * uint64(s.Bsize), nil
}

func (lvOSFS) Exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// OSLibvirtFS is the real file system for ReadLibvirtDetail.
func OSLibvirtFS() LibvirtFS { return lvOSFS{} }

// lvReadHead reads the first n bytes of a file (qcow2 headers).
func lvReadHead(fsys LibvirtFS, p string, n int) []byte {
	if h, ok := fsys.(interface {
		Head(string, int) ([]byte, error)
	}); ok {
		b, _ := h.Head(p, n)
		return b
	}
	f, err := os.Open(p)
	if err != nil {
		return nil
	}
	defer f.Close()
	buf := make([]byte, n)
	m, _ := f.Read(buf)
	return buf[:m]
}

// qcow2Size is the virtual size from a qcow2 header (0: not qcow2).
func qcow2Size(head []byte) uint64 {
	if len(head) < 32 || !bytes.Equal(head[:4], []byte{'Q', 'F', 'I', 0xfb}) {
		return 0
	}
	var v uint64
	for _, b := range head[24:32] {
		v = v<<8 | uint64(b)
	}
	return v
}

// readFolders reads unRAID's VM folders from domain.cfg (nil elsewhere).
func readFolders(fsys LibvirtFS) *proto.LibvirtFolders {
	b, err := fsys.ReadFile(lvDomainCfg)
	if err != nil {
		return nil
	}
	f := &proto.LibvirtFolders{}
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		k, v, ok := strings.Cut(strings.TrimSpace(sc.Text()), "=")
		if !ok {
			continue
		}
		v = strings.Trim(strings.TrimSpace(v), `"'`)
		if v == "" || !filepath.IsAbs(v) {
			continue
		}
		v = filepath.Clean(v)
		switch strings.TrimSpace(k) {
		case "DOMAINDIR":
			f.Domains = v
		case "MEDIADIR":
			f.ISOs = v
		}
	}
	if f.Domains == "" && f.ISOs == "" {
		return nil
	}
	return f
}

// readPools lists the storage pools (transient pools of the agent left
// out).
func readPools(conn LibvirtConn) ([]lvPool, error) {
	refs, _, err := conn.ConnectListAllStoragePools(1, 0)
	if err != nil {
		return nil, err
	}
	var out []lvPool
	for _, r := range refs {
		if strings.HasPrefix(r.Name, lvTmpPool) {
			continue
		}
		p := lvPool{ref: r, name: r.Name}
		if x, err := conn.StoragePoolGetXMLDesc(r, 0); err == nil {
			if t, err := parseXMLTree(x); err == nil {
				p.typ = t.attr("type")
				p.path = t.path("target/path").textContent()
			}
		}
		if a, err := conn.StoragePoolIsActive(r); err == nil {
			p.active = a == 1
		}
		if a, err := conn.StoragePoolGetAutostart(r); err == nil {
			p.autostart = a == 1
		}
		if p.active {
			if _, c, al, av, err := conn.StoragePoolGetInfo(r); err == nil {
				p.capacity, p.alloc, p.avail = c, al, av
			}
			if vols, _, err := conn.StoragePoolListAllVolumes(r, 1, 0); err == nil {
				for _, v := range vols {
					if t, _, _, err := conn.StorageVolGetInfo(v); err == nil && t == 2 { // VIR_STORAGE_VOL_DIR
						continue
					}
					if strings.HasPrefix(v.Name, ".") {
						continue
					}
					p.volumes++
				}
			}
		}
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].name < out[j].name })
	return out, nil
}

// defaultBackupsDir: the configured folder, else
// <domains folder or first directory pool>/.whombat-backups ("default"
// first).
func defaultBackupsDir(configured string, pools []lvPool, folders *proto.LibvirtFolders) string {
	if configured != "" {
		return filepath.Clean(configured)
	}
	if folders != nil && folders.Domains != "" {
		return filepath.Join(folders.Domains, lvBackupsName)
	}
	var cands []lvPool
	for _, p := range pools {
		if p.active && p.typ == "dir" && p.path != "" {
			cands = append(cands, p)
		}
	}
	sort.SliceStable(cands, func(i, j int) bool { return cands[i].name == "default" && cands[j].name != "default" })
	if len(cands) > 0 {
		return filepath.Join(cands[0].path, lvBackupsName)
	}
	return ""
}

// readHost reads pools, folders, the backups folder and the domain
// capabilities.
func readHost(conn LibvirtConn, fsys LibvirtFS, configuredBackups string) (*lvHost, error) {
	pools, err := readPools(conn)
	if err != nil {
		return nil, fmt.Errorf("storage pools: %w", err)
	}
	h := &lvHost{pools: pools, folders: readFolders(fsys)}
	h.backupsDir = defaultBackupsDir(configuredBackups, pools, h.folders)
	if c, err := conn.ConnectGetDomainCapabilities(nil, libvirt.OptString{"x86_64"}, libvirt.OptString{"q35"}, libvirt.OptString{"kvm"}, 0); err == nil {
		h.domcaps = c
	} else if c, err := conn.ConnectGetDomainCapabilities(nil, nil, nil, nil, 0); err == nil {
		h.domcaps = c
	}
	return h, nil
}

func (h *lvHost) pool(name string) (lvPool, bool) {
	for _, p := range h.pools {
		if p.name == name {
			return p, true
		}
	}
	return lvPool{}, false
}

// firmware says what a new VM can get, from the domain capabilities (and
// the swtpm binary when libvirt does not say).
func (h *lvHost) firmware(fsys LibvirtFS) proto.LibvirtFirmware {
	var fw proto.LibvirtFirmware
	caps, err := parseXMLTree(h.domcaps)
	if err == nil {
		osn := caps.child("os")
		for _, e := range osn.children("enum") {
			if e.attr("name") == "firmware" {
				for _, v := range e.children("value") {
					if v.textContent() == "efi" {
						fw.UEFI = true
					}
				}
			}
		}
		loader := osn.child("loader")
		for _, e := range loader.children("enum") {
			if e.attr("name") == "secure" {
				for _, v := range e.children("value") {
					if v.textContent() == "yes" {
						fw.SecureBoot = fw.UEFI
					}
				}
			}
		}
		if tpm := caps.path("devices/tpm"); tpm != nil && tpm.attr("supported") == "yes" {
			for _, e := range tpm.children("enum") {
				if e.attr("name") == "backendModel" {
					for _, v := range e.children("value") {
						if v.textContent() == "emulator" {
							fw.TPM = true
						}
					}
				}
			}
		}
	}
	if !fw.TPM && caps.path("devices/tpm") == nil {
		for _, p := range []string{"/usr/bin/swtpm", "/usr/local/bin/swtpm"} {
			if fsys.Exists(p) {
				fw.TPM = true
			}
		}
	}
	return fw
}

// cpuModels are the usable custom CPU models.
func (h *lvHost) cpuModels() []string {
	caps, err := parseXMLTree(h.domcaps)
	if err != nil {
		return nil
	}
	var out []string
	for _, m := range caps.child("cpu").children("mode") {
		if m.attr("name") != "custom" {
			continue
		}
		for _, mod := range m.children("model") {
			if mod.attr("usable") != "no" {
				out = append(out, mod.textContent())
			}
		}
	}
	sort.Strings(out)
	return out
}

// maxVCPUs from the capabilities (512 when unknown).
func (h *lvHost) maxVCPUs() int {
	caps, err := parseXMLTree(h.domcaps)
	if err == nil {
		if n, err := strconv.Atoi(caps.child("vcpu").attr("max")); err == nil && n > 0 {
			return min(n, 512)
		}
	}
	return 512
}

// writeRoots are the folders Whombat writes into: file-based pools,
// unRAID's folders, the backups folder.
func (h *lvHost) writeRoots() []string {
	var out []string
	for _, p := range h.pools {
		if p.active && p.fileBased() {
			out = append(out, filepath.Clean(p.path))
		}
	}
	if h.folders != nil {
		for _, f := range []string{h.folders.Domains, h.folders.ISOs} {
			if f != "" {
				out = append(out, f)
			}
		}
	}
	if h.backupsDir != "" {
		out = append(out, h.backupsDir)
	}
	return out
}

// lvWithin reports whether p is inside (or is) one of roots; p must be
// clean and absolute, without "..".
func lvWithin(p string, roots []string) bool {
	if !filepath.IsAbs(p) || filepath.Clean(p) != p || strings.Contains(p, "/../") {
		return false
	}
	for _, r := range roots {
		if p == r || strings.HasPrefix(p, strings.TrimSuffix(r, "/")+"/") {
			return true
		}
	}
	return false
}

// storageOf names the pool or folder a path is in ("" = none).
func (h *lvHost) storageOf(p string) string {
	best, bestLen := "", 0
	for _, pl := range h.pools {
		if pl.path != "" && (p == pl.path || strings.HasPrefix(p, strings.TrimSuffix(pl.path, "/")+"/")) && len(pl.path) > bestLen {
			best, bestLen = pl.name, len(pl.path)
		}
	}
	if best != "" {
		return best
	}
	if f := h.folders; f != nil {
		if f.Domains != "" && strings.HasPrefix(p, f.Domains+"/") {
			return proto.LibvirtDomainsFolder
		}
		if f.ISOs != "" && strings.HasPrefix(p, f.ISOs+"/") {
			return proto.LibvirtISOsFolder
		}
	}
	return ""
}

// folderPath is the folder of a folder storage id.
func (h *lvHost) folderPath(storage string) string {
	if h.folders == nil {
		return ""
	}
	switch storage {
	case proto.LibvirtDomainsFolder:
		return h.folders.Domains
	case proto.LibvirtISOsFolder:
		return h.folders.ISOs
	}
	return ""
}

// readNetworks lists libvirt's networks; usedBy counts the network cards
// of the defined domains on each.
func readNetworks(conn LibvirtConn, domXML []string) []proto.LibvirtNetwork {
	refs, _, err := conn.ConnectListAllNetworks(1, 0)
	if err != nil {
		return nil
	}
	used := map[string]int{}
	for _, x := range domXML {
		d, err := parseLvDom(x)
		if err != nil {
			continue
		}
		for _, n := range d.nicNodes() {
			if c := readLvNIC(n); c.typ == "network" {
				used[c.source]++
			}
		}
	}
	var out []proto.LibvirtNetwork
	for _, r := range refs {
		n := proto.LibvirtNetwork{Name: r.Name, UsedBy: used[r.Name]}
		if a, err := conn.NetworkIsActive(r); err == nil {
			n.Active = a == 1
		}
		if a, err := conn.NetworkGetAutostart(r); err == nil {
			n.Autostart = a == 1
		}
		if x, err := conn.NetworkGetXMLDesc(r, 0); err == nil {
			if t, err := parseXMLTree(x); err == nil {
				n.Bridge = t.child("bridge").attr("name")
				if f := t.child("forward"); f != nil {
					n.Forward = f.attr("mode")
					if n.Forward == "" {
						n.Forward = "nat"
					}
				} else {
					n.Forward = "none"
				}
				for _, ip := range t.children("ip") {
					if fam := ip.attr("family"); fam != "" && fam != "ipv4" {
						continue
					}
					if a := ip.attr("address"); a != "" && n.IPv4 == "" {
						n.IPv4 = a + "/" + ipv4Prefix(ip)
					}
					if ip.child("dhcp") != nil {
						n.DHCP = true
					}
				}
			}
		}
		out = append(out, n)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func ipv4Prefix(ip *xnode) string {
	if p := ip.attr("prefix"); p != "" {
		return p
	}
	mask := ip.attr("netmask")
	if mask == "" {
		return "24"
	}
	bits := 0
	for _, part := range strings.Split(mask, ".") {
		v, _ := strconv.Atoi(part)
		for v > 0 {
			bits += v & 1
			v >>= 1
		}
	}
	return strconv.Itoa(bits)
}

// hostBridges lists the host's bridges that are not Docker's or a libvirt
// network's (/sys/class/net/<name>/bridge).
func hostBridges(fsys LibvirtFS, nets []proto.LibvirtNetwork) []string {
	ents, err := fsys.ReadDir("/sys/class/net")
	if err != nil {
		return nil
	}
	skip := map[string]bool{"docker0": true}
	for _, n := range nets {
		if n.Bridge != "" {
			skip[n.Bridge] = true
		}
	}
	var out []string
	for _, e := range ents {
		name := e.Name
		if skip[name] || strings.HasPrefix(name, "br-") && len(name) == 15 || strings.HasPrefix(name, "virbr") {
			continue
		}
		if fsys.Exists("/sys/class/net/" + name + "/bridge") {
			out = append(out, name)
		}
	}
	sort.Strings(out)
	return out
}

// domainXMLs reads every domain's inactive XML (not secure).
func domainXMLs(conn LibvirtConn) []string {
	doms, _, err := conn.ConnectListAllDomains(1, 0)
	if err != nil {
		return nil
	}
	var out []string
	for _, d := range doms {
		if x, err := conn.DomainGetXMLDesc(d, libvirt.DomainXMLInactive); err == nil {
			out = append(out, x)
		}
	}
	return out
}

// ReadLibvirtDetail reads the host view (proto.LibvirtDetail). backupsDir
// is agent.toml's [libvirt] backups_dir ("" = the default).
func ReadLibvirtDetail(conn LibvirtConn, fsys LibvirtFS, backupsDir string) (*proto.LibvirtDetail, error) {
	h, err := readHost(conn, fsys, backupsDir)
	if err != nil {
		return nil, err
	}
	d := &proto.LibvirtDetail{Folders: h.folders, Firmware: h.firmware(fsys), BackupsDir: h.backupsDir}
	if v, err := conn.ConnectGetVersion(); err == nil && v > 0 {
		d.QEMU = fmt.Sprintf("%d.%d.%d", v/1000000, (v/1000)%1000, v%1000)
	}
	for _, p := range h.pools {
		d.Pools = append(d.Pools, proto.LibvirtPool{Name: p.name, Type: p.typ, Active: p.active, Autostart: p.autostart,
			Path: p.path, UsedBytes: p.alloc, TotalBytes: p.capacity, AvailBytes: p.avail, Volumes: p.volumes})
	}
	d.Networks = readNetworks(conn, domainXMLs(conn))
	return d, nil
}

// LibvirtBackupTimes reads the newest backup of each VM in the backups
// folder: VM UUID (and name) -> unix time of its newest complete backup.
func LibvirtBackupTimes(fsys LibvirtFS, backupsDir string) map[string]int64 {
	out := map[string]int64{}
	if backupsDir == "" {
		return out
	}
	vms, err := fsys.ReadDir(backupsDir)
	if err != nil {
		return out
	}
	for _, vm := range vms {
		if !vm.Dir {
			continue
		}
		for _, b := range listBackupDirs(fsys, path.Join(backupsDir, vm.Name)) {
			for _, k := range []string{b.meta.UUID, "name:" + b.meta.Name} {
				if k != "" && k != "name:" && b.meta.Created > out[k] {
					out[k] = b.meta.Created
				}
			}
		}
	}
	return out
}

// ---- writing through libvirt ---------------------------------------------------

// lvTmpPools are the transient pools the agent has open, per folder
// (libvirt refuses two pools on one folder, so concurrent work on a folder
// shares one).
var lvTmpPools = struct {
	sync.Mutex
	m map[string]*lvTmpPoolRef
}{m: map[string]*lvTmpPoolRef{}}

type lvTmpPoolRef struct {
	pool libvirt.StoragePool
	refs int
}

func lvRandHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// withDir runs f with a pool on dir: an active pool of the host on exactly
// that folder, else a transient directory pool the agent makes (build:
// create the folder, with its parents, first) and removes again. Files are
// written by libvirt itself, so the agent's sandbox needs no write access.
func withDir(conn LibvirtConn, h *lvHost, dir string, build bool, f func(pool libvirt.StoragePool) error) error {
	dir = filepath.Clean(dir)
	for _, p := range h.pools {
		if p.active && p.path != "" && filepath.Clean(p.path) == dir {
			_ = conn.StoragePoolRefresh(p.ref, 0)
			return f(p.ref)
		}
	}
	lvTmpPools.Lock()
	ref := lvTmpPools.m[dir]
	if ref != nil {
		ref.refs++
		lvTmpPools.Unlock()
		_ = conn.StoragePoolRefresh(ref.pool, 0)
	} else {
		doc := newElem("pool", "type", "dir")
		doc.add(newElem("name")).setText(lvTmpPool + lvRandHex(4))
		doc.add(newElem("target")).add(newElem("path")).setText(dir)
		var flags libvirt.StoragePoolCreateFlags
		if build {
			flags = libvirt.StoragePoolCreateWithBuild
		}
		pool, err := conn.StoragePoolCreateXML(doc.String(), flags)
		if err != nil {
			lvTmpPools.Unlock()
			return fmt.Errorf("libvirt could not open %s: %w", dir, err)
		}
		ref = &lvTmpPoolRef{pool: pool, refs: 1}
		lvTmpPools.m[dir] = ref
		lvTmpPools.Unlock()
	}
	defer func() {
		lvTmpPools.Lock()
		defer lvTmpPools.Unlock()
		if ref.refs--; ref.refs == 0 {
			delete(lvTmpPools.m, dir)
			_ = conn.StoragePoolDestroy(ref.pool)
		}
	}()
	return f(ref.pool)
}

// CleanLibvirtTmpPools removes transient pools an earlier run of the agent
// left behind (it ended during a copy).
func CleanLibvirtTmpPools(conn LibvirtConn) {
	refs, _, err := conn.ConnectListAllStoragePools(1, 0)
	if err != nil {
		return
	}
	lvTmpPools.Lock()
	defer lvTmpPools.Unlock()
	open := map[string]bool{}
	for _, r := range lvTmpPools.m {
		open[r.pool.Name] = true
	}
	for _, r := range refs {
		if strings.HasPrefix(r.Name, lvTmpPool) && !open[r.Name] {
			_ = conn.StoragePoolDestroy(r)
		}
	}
}

// removeDir deletes an empty folder (as a directory volume of a pool on
// its parent).
func removeDir(conn LibvirtConn, h *lvHost, dir string) error {
	dir = filepath.Clean(dir)
	return withDir(conn, h, filepath.Dir(dir), false, func(pool libvirt.StoragePool) error {
		v, err := conn.StorageVolLookupByName(pool, filepath.Base(dir))
		if err != nil {
			return nil // gone already
		}
		return conn.StorageVolDelete(v, 0)
	})
}

// lookupVolPath finds the pool volume of a file, refreshing the pool that
// holds it first when needed.
func lookupVolPath(conn LibvirtConn, h *lvHost, p string) (libvirt.StorageVol, bool) {
	if v, err := conn.StorageVolLookupByPath(p); err == nil {
		return v, true
	}
	if name := h.storageOf(p); name != "" {
		if pl, ok := h.pool(name); ok && pl.active {
			_ = conn.StoragePoolRefresh(pl.ref, 0)
			if v, err := conn.StorageVolLookupByPath(p); err == nil {
				return v, true
			}
		}
	}
	return libvirt.StorageVol{}, false
}

// deleteFile deletes a file through libvirt (its pool's volume, or a
// transient pool on its folder).
func deleteFile(conn LibvirtConn, h *lvHost, p string) error {
	if v, ok := lookupVolPath(conn, h, p); ok {
		return conn.StorageVolDelete(v, 0)
	}
	return withDir(conn, h, filepath.Dir(p), false, func(pool libvirt.StoragePool) error {
		v, err := conn.StorageVolLookupByName(pool, filepath.Base(p))
		if err != nil {
			return nil
		}
		return conn.StorageVolDelete(v, 0)
	})
}

var errLvNotFound = errors.New("not found")

// lvNotExist: a missing file from LibvirtFS.
func lvNotExist(err error) bool {
	return errors.Is(err, fs.ErrNotExist) || errors.Is(err, errLvNotFound)
}
