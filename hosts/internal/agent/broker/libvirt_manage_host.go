package broker

import (
	"context"
	"crypto/md5"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/hex"
	"fmt"
	"hash"
	"io"
	"net/http"
	"os"
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

// Host operations of the libvirt manager (docs/MANAGE.md 2.7): pool
// volumes, ISO images (list, download from a URL, delete), a network's
// DHCP leases and a VM's QEMU log.

var lvVolNameRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

const (
	lvLogDefault = 500
	lvLogMax     = 2000
)

// pool returns an active pool of the host by name.
func (h *lvHost) activePool(name string) (lvPool, *proto.ManageResponse) {
	p, ok := h.pool(name)
	if !ok {
		return p, &proto.ManageResponse{Code: proto.CodeNotFound, Message: "there is no storage pool " + name}
	}
	if !p.active {
		return p, &proto.ManageResponse{Code: proto.CodeNotAllowed, Message: "storage pool " + name + " is not active"}
	}
	return p, nil
}

// volumeUsers names the VMs whose disks use a path (platform ids) and
// whether one of them runs.
func volumeUsers(conn LibvirtConn, p string) (users []string, running bool) {
	doms, _, err := conn.ConnectListAllDomains(1, 0)
	if err != nil {
		return nil, false
	}
	for _, ref := range doms {
		x, err := conn.DomainGetXMLDesc(ref, libvirt.DomainXMLInactive)
		if err != nil {
			continue
		}
		d, err := parseLvDom(x)
		if err != nil {
			continue
		}
		for _, n := range d.x.child("devices").children("disk") {
			dk := readLvDisk(n)
			if dk.path == p && p != "" {
				users = append(users, ref.Name)
				if s, _, err := conn.DomainGetState(ref, 0); err == nil && libvirt.DomainState(s) != libvirt.DomainShutoff &&
					libvirt.DomainState(s) != libvirt.DomainCrashed && libvirt.DomainState(s) != libvirt.DomainNostate {
					running = true
				}
				break
			}
		}
	}
	sort.Strings(users)
	return users, running
}

// ---- volumes -------------------------------------------------------------------

func (m *lvManager) volumeCreate(conn LibvirtConn, req proto.ManageRequest) proto.ManageResponse {
	h, err := readHost(conn, m.fs, m.backupsDir)
	if err != nil {
		return lvResp(err)
	}
	pl, bad := h.activePool(req.Pool)
	if bad != nil {
		return *bad
	}
	fe := map[string]string{}
	if !lvVolNameRE.MatchString(req.Name) {
		fe["name"] = "volume names are up to 128 letters, digits, dots, dashes and underscores"
	}
	size, grow, ok := lvParseSize(req.Size)
	if !ok || grow {
		fe["size"] = "the size of the new volume (\"10G\")"
	}
	format := req.Format
	switch {
	case format == "":
		format = "qcow2"
		if !pl.fileBased() {
			format = "raw"
		}
	case format != "qcow2" && format != "raw":
		fe["format"] = "format is qcow2 or raw"
	case format == "qcow2" && !pl.fileBased():
		fe["format"] = "pool " + pl.name + " keeps raw volumes only"
	}
	if len(fe) > 0 {
		return lvFields(fe)
	}
	if _, err := conn.StorageVolLookupByName(pl.ref, req.Name); err == nil {
		return proto.ManageResponse{Code: proto.CodeExists, Message: "pool " + pl.name + " has a volume " + req.Name}
	}
	doc := newElem("volume")
	doc.add(newElem("name")).setText(req.Name)
	doc.add(newElem("capacity", "unit", "bytes")).setText(strconv.FormatUint(size, 10))
	if format == "qcow2" || pl.fileBased() {
		doc.add(newElem("allocation", "unit", "bytes")).setText("0")
	}
	doc.add(newElem("target")).add(newElem("format", "type", format))
	if _, err := conn.StorageVolCreateXML(pl.ref, doc.String(), 0); err != nil {
		return lvPlatformError(err)
	}
	return proto.ManageResponse{OK: true}
}

// poolVolume finds a volume by name (the pool is refreshed once when it
// is missing).
func poolVolume(conn LibvirtConn, pl lvPool, name string) (libvirt.StorageVol, *proto.ManageResponse) {
	if !lvVolNameRE.MatchString(name) {
		return libvirt.StorageVol{}, &proto.ManageResponse{Code: proto.CodeInvalidValue, Message: "volume: not a volume name",
			FieldErrors: map[string]string{"volume": "not a volume name"}}
	}
	v, err := conn.StorageVolLookupByName(pl.ref, name)
	if err != nil {
		_ = conn.StoragePoolRefresh(pl.ref, 0)
		if v, err = conn.StorageVolLookupByName(pl.ref, name); err != nil {
			return v, &proto.ManageResponse{Code: proto.CodeNotFound, Message: "pool " + pl.name + " has no volume " + name}
		}
	}
	return v, nil
}

func (m *lvManager) volumeResize(conn LibvirtConn, req proto.ManageRequest) proto.ManageResponse {
	h, err := readHost(conn, m.fs, m.backupsDir)
	if err != nil {
		return lvResp(err)
	}
	pl, bad := h.activePool(req.Pool)
	if bad != nil {
		return *bad
	}
	v, bad := poolVolume(conn, pl, req.Volume)
	if bad != nil {
		return *bad
	}
	_, capacity, _, err := conn.StorageVolGetInfo(v)
	if err != nil {
		return lvPlatformError(err)
	}
	n, grow, ok := lvParseSize(req.Size)
	if !ok {
		return lvFields(map[string]string{"size": "the size is \"+8G\" (grow by) or the new total (\"40G\")"})
	}
	if grow {
		n += capacity
	}
	if n <= capacity {
		return lvFields(map[string]string{"size": fmt.Sprintf("volumes only grow: %s is %s now", req.Volume, lvFmtBytes(capacity))})
	}
	p, _ := conn.StorageVolGetPath(v)
	if users, running := volumeUsers(conn, p); running {
		return proto.ManageResponse{Code: proto.CodeInUse, Message: "A running VM uses this volume (" + strings.Join(users, ", ") +
			"): grow it from the VM’s disk instead."}
	}
	if err := conn.StorageVolResize(v, n, 0); err != nil {
		return lvPlatformError(err)
	}
	return proto.ManageResponse{OK: true, Changes: []proto.ConfigChange{{Key: "size", Old: strconv.FormatUint(capacity, 10), New: strconv.FormatUint(n, 10)}}}
}

func (m *lvManager) volumeDelete(conn LibvirtConn, req proto.ManageRequest) proto.ManageResponse {
	h, err := readHost(conn, m.fs, m.backupsDir)
	if err != nil {
		return lvResp(err)
	}
	pl, bad := h.activePool(req.Pool)
	if bad != nil {
		return *bad
	}
	v, bad := poolVolume(conn, pl, req.Volume)
	if bad != nil {
		return *bad
	}
	if t, _, _, err := conn.StorageVolGetInfo(v); err == nil && t == 2 {
		return proto.ManageResponse{Code: proto.CodeNotAllowed, Message: req.Volume + " is a folder, not a volume"}
	}
	p, _ := conn.StorageVolGetPath(v)
	if users, _ := volumeUsers(conn, p); len(users) > 0 {
		return proto.ManageResponse{Code: proto.CodeInUse, Message: "In use by " + strings.Join(users, ", ") + "."}
	}
	if err := conn.StorageVolDelete(v, 0); err != nil {
		return lvPlatformError(err)
	}
	return proto.ManageResponse{OK: true}
}

// ---- content (ISO images and pool volumes) -------------------------------------

func isISO(name string) bool { return strings.HasSuffix(strings.ToLower(name), ".iso") }

// isoList lists the ISO files of every file-based pool and unRAID's ISO
// folder (or of one storage). A pool volume is "pool/name", a folder's
// file its path: both are what cdrom<N> source= takes.
func (m *lvManager) isoList(conn LibvirtConn, h *lvHost, storage string) []proto.StorageVolume {
	out := []proto.StorageVolume{}
	for _, p := range h.pools {
		if !p.active || !p.fileBased() || storage != "" && storage != p.name {
			continue
		}
		vols, _, err := conn.StoragePoolListAllVolumes(p.ref, 1, 0)
		if err != nil {
			continue
		}
		for _, v := range vols {
			if !isISO(v.Name) {
				continue
			}
			sv := proto.StorageVolume{Volume: p.name + "/" + v.Name, Storage: p.name, Content: "iso", Name: v.Name}
			if _, c, _, err := conn.StorageVolGetInfo(v); err == nil {
				sv.SizeBytes = c
			}
			if st, err := m.fs.Stat(filepath.Join(p.path, v.Name)); err == nil {
				sv.Created = time.Unix(st.ModTime, 0).UTC()
			}
			out = append(out, sv)
		}
	}
	if dir := h.folderPath(proto.LibvirtISOsFolder); dir != "" && (storage == "" || storage == proto.LibvirtISOsFolder) {
		if ents, err := m.fs.ReadDir(dir); err == nil {
			for _, e := range ents {
				if e.Dir || !isISO(e.Name) {
					continue
				}
				p := path.Join(dir, e.Name)
				sv := proto.StorageVolume{Volume: p, Storage: proto.LibvirtISOsFolder, Content: "iso", Name: e.Name}
				if st, err := m.fs.Stat(p); err == nil {
					sv.SizeBytes, sv.Created = uint64(st.Size), time.Unix(st.ModTime, 0).UTC()
				}
				out = append(out, sv)
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Volume < out[j].Volume })
	return out
}

// contentList: ISO images ("iso"), or a pool's disk volumes and unRAID's
// VM disk files ("images") with the VMs that use them.
func (m *lvManager) contentList(conn LibvirtConn, req proto.ManageRequest) proto.ManageResponse {
	h, err := readHost(conn, m.fs, m.backupsDir)
	if err != nil {
		return lvResp(err)
	}
	if req.Storage != proto.LibvirtISOsFolder && req.Storage != proto.LibvirtDomainsFolder {
		if _, bad := h.activePool(req.Storage); bad != nil {
			return *bad
		}
	} else if h.folderPath(req.Storage) == "" {
		return proto.ManageResponse{Code: proto.CodeNotFound, Message: "this server has no " + req.Storage}
	}
	if req.Content == "iso" {
		return proto.ManageResponse{OK: true, Content: m.isoList(conn, h, req.Storage)}
	}
	if req.Content != "images" && req.Content != "" {
		return lvFields(map[string]string{"content": "content is iso or images"})
	}
	users := diskUsers(conn)
	out := []proto.StorageVolume{}
	if dir := h.folderPath(req.Storage); dir != "" {
		vms, _ := m.fs.ReadDir(dir)
		for _, vm := range vms {
			if !vm.Dir || strings.HasPrefix(vm.Name, ".") {
				continue
			}
			files, _ := m.fs.ReadDir(path.Join(dir, vm.Name))
			for _, f := range files {
				if f.Dir {
					continue
				}
				p := path.Join(dir, vm.Name, f.Name)
				sv := proto.StorageVolume{Volume: p, Storage: req.Storage, Content: "images", Name: vm.Name + "/" + f.Name, UsedBy: users[p]}
				if st, err := m.fs.Stat(p); err == nil {
					sv.SizeBytes, sv.UsedBytes, sv.Created = uint64(st.Size), st.UsedBytes, time.Unix(st.ModTime, 0).UTC()
				}
				sv.Format = "raw"
				if n := qcow2Size(lvReadHead(m.fs, p, 32)); n > 0 {
					sv.Format, sv.SizeBytes = "qcow2", n
				}
				out = append(out, sv)
			}
		}
		return proto.ManageResponse{OK: true, Content: out}
	}
	pl, _ := h.pool(req.Storage)
	_ = conn.StoragePoolRefresh(pl.ref, 0)
	vols, _, err := conn.StoragePoolListAllVolumes(pl.ref, 1, 0)
	if err != nil {
		return lvPlatformError(err)
	}
	for _, v := range vols {
		if strings.HasPrefix(v.Name, ".") || isISO(v.Name) {
			continue
		}
		t, c, a, err := conn.StorageVolGetInfo(v)
		if err != nil || t == 2 {
			continue
		}
		p, _ := conn.StorageVolGetPath(v)
		sv := proto.StorageVolume{Volume: pl.name + "/" + v.Name, Storage: pl.name, Content: "images", Name: v.Name,
			SizeBytes: c, UsedBytes: a, UsedBy: users[p], Format: "raw"}
		if x, err := conn.StorageVolGetXMLDesc(v, 0); err == nil {
			if vx, err := parseXMLTree(x); err == nil {
				if f := vx.path("target/format").attr("type"); f != "" {
					sv.Format = f
				}
			}
		}
		if st, err := m.fs.Stat(p); err == nil {
			sv.Created = time.Unix(st.ModTime, 0).UTC()
		}
		out = append(out, sv)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return proto.ManageResponse{OK: true, Content: out}
}

// diskUsers maps disk paths to the VMs that use them.
func diskUsers(conn LibvirtConn) map[string][]string {
	out := map[string][]string{}
	doms, _, err := conn.ConnectListAllDomains(1, 0)
	if err != nil {
		return out
	}
	for _, ref := range doms {
		x, err := conn.DomainGetXMLDesc(ref, libvirt.DomainXMLInactive)
		if err != nil {
			continue
		}
		d, err := parseLvDom(x)
		if err != nil {
			continue
		}
		for _, n := range d.x.child("devices").children("disk") {
			if p := readLvDisk(n).path; p != "" {
				out[p] = append(out[p], ref.Name)
			}
		}
	}
	return out
}

// isoPath resolves an ISO volume (pool/name or a path in the ISO folder).
func (m *lvManager) isoPath(conn LibvirtConn, h *lvHost, volume string) (string, libvirt.StorageVol, bool, *proto.ManageResponse) {
	badVol := &proto.ManageResponse{Code: proto.CodeInvalidValue, Message: "volume: not an ISO image of this server",
		FieldErrors: map[string]string{"volume": "not an ISO image of this server"}}
	if !isISO(volume) {
		return "", libvirt.StorageVol{}, false, badVol
	}
	if strings.HasPrefix(volume, "/") {
		dir := h.folderPath(proto.LibvirtISOsFolder)
		if dir == "" || filepath.Clean(volume) != volume || filepath.Dir(volume) != dir {
			return "", libvirt.StorageVol{}, false, badVol
		}
		if !m.fs.Exists(volume) {
			return "", libvirt.StorageVol{}, false, &proto.ManageResponse{Code: proto.CodeNotFound, Message: "there is no " + volume}
		}
		return volume, libvirt.StorageVol{}, false, nil
	}
	pool, name, ok := strings.Cut(volume, "/")
	if !ok || strings.Contains(name, "/") {
		return "", libvirt.StorageVol{}, false, badVol
	}
	pl, bad := h.activePool(pool)
	if bad != nil {
		return "", libvirt.StorageVol{}, false, bad
	}
	v, bad := poolVolume(conn, pl, name)
	if bad != nil {
		return "", libvirt.StorageVol{}, false, bad
	}
	p, _ := conn.StorageVolGetPath(v)
	return p, v, true, nil
}

func (m *lvManager) contentDelete(conn LibvirtConn, req proto.ManageRequest) proto.ManageResponse {
	h, err := readHost(conn, m.fs, m.backupsDir)
	if err != nil {
		return lvResp(err)
	}
	p, v, inPool, bad := m.isoPath(conn, h, req.Volume)
	if bad != nil {
		return *bad
	}
	if users, _ := volumeUsers(conn, p); len(users) > 0 {
		return proto.ManageResponse{Code: proto.CodeInUse, Message: "In use by " + strings.Join(users, ", ") + ": eject it there first."}
	}
	if inPool {
		err = conn.StorageVolDelete(v, 0)
	} else {
		err = deleteFile(conn, h, p)
	}
	if err != nil {
		return lvPlatformError(err)
	}
	return proto.ManageResponse{OK: true}
}

// lvHTTPGetter fetches a URL: its body and length (-1 = unknown).
type lvHTTPGetter func(ctx context.Context, url string) (io.ReadCloser, int64, error)

func lvDefaultHTTPGet(ctx context.Context, url string) (io.ReadCloser, int64, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("User-Agent", "whombat-agent")
	c := &http.Client{Transport: &http.Transport{Proxy: http.ProxyFromEnvironment, ResponseHeaderTimeout: 60 * time.Second,
		TLSHandshakeTimeout: 30 * time.Second}}
	resp, err := c.Do(req)
	if err != nil {
		return nil, 0, err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, 0, fmt.Errorf("the server answered %s", resp.Status)
	}
	return resp.Body, resp.ContentLength, nil
}

func lvChecksumHash(alg string) hash.Hash {
	switch alg {
	case "md5":
		return md5.New()
	case "sha1":
		return sha1.New()
	case "sha224":
		return sha256.New224()
	case "sha256":
		return sha256.New()
	case "sha384":
		return sha512.New384()
	case "sha512":
		return sha512.New()
	}
	return nil
}

// lvCountingReader counts what passed and stops when asked.
type lvCountingReader struct {
	r    io.Reader
	n    int64
	h    hash.Hash
	stop func() bool
}

func (c *lvCountingReader) Read(p []byte) (int, error) {
	if c.stop() {
		return 0, errLvStopped
	}
	n, err := c.r.Read(p)
	c.n += int64(n)
	if c.h != nil && n > 0 {
		c.h.Write(p[:n])
	}
	return n, err
}

// contentDownload downloads an ISO image from a URL into a pool or
// unRAID's ISO folder (libvirt writes the file: StorageVolUpload).
func (m *lvManager) contentDownload(conn LibvirtConn, req proto.ManageRequest) proto.ManageResponse {
	h, err := readHost(conn, m.fs, m.backupsDir)
	if err != nil {
		return lvResp(err)
	}
	if req.Content != "" && req.Content != "iso" {
		return lvFields(map[string]string{"content": "libvirt keeps ISO images only"})
	}
	if !isISO(req.Filename) || !lvVolNameRE.MatchString(req.Filename) {
		return lvFields(map[string]string{"filename": "file names are letters, digits, '.', '_' and '-' and end in .iso"})
	}
	if req.Checksum != "" && lvChecksumHash(req.ChecksumAlgorithm) == nil {
		return lvFields(map[string]string{"checksum_algorithm": "md5, sha1, sha224, sha256, sha384 or sha512"})
	}
	dir := ""
	var pl lvPool
	if req.Storage == proto.LibvirtISOsFolder {
		if dir = h.folderPath(req.Storage); dir == "" {
			return proto.ManageResponse{Code: proto.CodeNotFound, Message: "this server has no ISO folder"}
		}
		if m.fs.Exists(path.Join(dir, req.Filename)) {
			return proto.ManageResponse{Code: proto.CodeExists, Message: req.Filename + " is there already"}
		}
	} else {
		var bad *proto.ManageResponse
		if pl, bad = h.activePool(req.Storage); bad != nil {
			return *bad
		}
		if !pl.fileBased() {
			return proto.ManageResponse{Code: proto.CodeNotAllowed, Message: "pool " + pl.name + " keeps disk volumes, not files: choose another pool"}
		}
		if _, err := conn.StorageVolLookupByName(pl.ref, req.Filename); err == nil {
			return proto.ManageResponse{Code: proto.CodeExists, Message: req.Filename + " is there already"}
		}
		dir = pl.path
	}
	id := m.tasks.start("download", "", func(t *lvTaskHandle) error {
		c, err := m.dial()
		if err != nil {
			return err
		}
		defer c.Disconnect()
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		t.onStop(cancel)
		t.logf("Downloading %s to %s.", req.Filename, dir)
		body, length, err := m.httpGet(ctx, req.URL)
		if err != nil {
			return fmt.Errorf("downloading: %w", err)
		}
		defer body.Close()
		cr := &lvCountingReader{r: body, h: lvChecksumHash(req.ChecksumAlgorithm), stop: t.stopped}
		done := make(chan struct{})
		go func() {
			tick := time.NewTicker(2 * time.Second)
			defer tick.Stop()
			for {
				select {
				case <-done:
					return
				case <-tick.C:
					if length > 0 {
						t.progress("Downloading: %d %% (%s of %s)", min(99, int(float64(cr.n)/float64(length)*100)), lvFmtBytes(uint64(cr.n)), lvFmtBytes(uint64(length)))
					} else {
						t.progress("Downloading: %s", lvFmtBytes(uint64(cr.n)))
					}
				}
			}
		}()
		defer close(done)
		write := func(pool libvirt.StoragePool) error {
			doc := newElem("volume")
			doc.add(newElem("name")).setText(req.Filename)
			doc.add(newElem("capacity", "unit", "bytes")).setText(strconv.FormatInt(max(length, 0), 10))
			doc.add(newElem("target")).add(newElem("format", "type", "raw"))
			v, err := c.StorageVolCreateXML(pool, doc.String(), 0)
			if err != nil {
				return err
			}
			if err := c.StorageVolUpload(v, cr, 0, uint64(max(length, 0)), 0); err != nil {
				_ = c.StorageVolDelete(v, 0)
				if t.stopped() {
					return errLvStopped
				}
				return fmt.Errorf("writing %s: %w", req.Filename, err)
			}
			if cr.h != nil {
				if got := hex.EncodeToString(cr.h.Sum(nil)); !strings.EqualFold(got, req.Checksum) {
					_ = c.StorageVolDelete(v, 0)
					return fmt.Errorf("the %s checksum does not match (got %s); the file was deleted", req.ChecksumAlgorithm, got)
				}
				t.logf("The %s checksum matches.", req.ChecksumAlgorithm)
			}
			_ = c.StoragePoolRefresh(pool, 0)
			return nil
		}
		if req.Storage == proto.LibvirtISOsFolder {
			err = withDir(c, h, dir, true, write)
		} else {
			err = write(pl.ref)
		}
		if err != nil {
			return err
		}
		t.logf("%s is ready (%s).", req.Filename, lvFmtBytes(uint64(cr.n)))
		return nil
	})
	return proto.ManageResponse{OK: true, Task: &proto.TaskRef{ID: id}}
}

// ---- network.leases and log.get ------------------------------------------------

func (m *lvManager) networkLeases(conn LibvirtConn, req proto.ManageRequest) proto.ManageResponse {
	n, err := conn.NetworkLookupByName(req.Network)
	if err != nil {
		return proto.ManageResponse{Code: proto.CodeNotFound, Message: "libvirt has no network " + req.Network}
	}
	leases, _, err := conn.NetworkGetDhcpLeases(n, nil, 1, 0)
	if err != nil {
		return lvPlatformError(err)
	}
	byMAC := map[string]string{}
	for _, x := range domainXMLs(conn) {
		d, err := parseLvDom(x)
		if err != nil {
			continue
		}
		for _, nic := range d.nicNodes() {
			if mac := readLvNIC(nic).mac; mac != "" {
				byMAC[mac] = d.name()
			}
		}
	}
	out := []proto.IncusLease{}
	for _, l := range leases {
		mac := ""
		if len(l.Mac) > 0 {
			mac = strings.ToLower(l.Mac[0])
		}
		host := ""
		if len(l.Hostname) > 0 {
			host = l.Hostname[0]
		}
		out = append(out, proto.IncusLease{Hostname: host, Address: l.Ipaddr, HWAddr: mac, Type: "dynamic", GuestID: byMAC[mac]})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Address < out[j].Address })
	return proto.ManageResponse{OK: true, Leases: out}
}

// logGet is the end of the VM's QEMU log (/var/log/libvirt/qemu/<name>.log).
func (m *lvManager) logGet(g *proto.Guest, req proto.ManageRequest) proto.ManageResponse {
	if strings.ContainsAny(g.ID, "/\x00") || g.ID == "." || g.ID == ".." {
		return proto.ManageResponse{Code: proto.CodeInvalidValue, Message: "not a VM name"}
	}
	n := req.Lines
	if n <= 0 {
		n = lvLogDefault
	}
	n = min(n, lvLogMax)
	file := path.Join(lvQEMULogDir, g.ID+".log")
	b, err := lvReadTail(m.fs, file, 1<<20)
	if err != nil {
		if os.IsNotExist(err) || lvNotExist(err) {
			return proto.ManageResponse{OK: true, Log: &proto.GuestLog{File: file, Lines: []string{}}}
		}
		return proto.ManageResponse{Code: CodePlatformError, Message: "reading the QEMU log: " + err.Error()}
	}
	lines := strings.Split(strings.TrimRight(string(b), "\n"), "\n")
	if len(lines) == 1 && lines[0] == "" {
		lines = []string{}
	}
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return proto.ManageResponse{OK: true, Log: &proto.GuestLog{File: file, Lines: lines}}
}

// lvReadTail reads at most the last max bytes of a file (from a line start).
func lvReadTail(fsys LibvirtFS, p string, max int64) ([]byte, error) {
	if t, ok := fsys.(interface {
		Tail(string, int64) ([]byte, error)
	}); ok {
		return t.Tail(p, max)
	}
	if _, ok := fsys.(lvOSFS); !ok {
		return fsys.ReadFile(p)
	}
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	off := st.Size() - max
	if off < 0 {
		off = 0
	}
	if _, err := f.Seek(off, io.SeekStart); err != nil {
		return nil, err
	}
	b, err := io.ReadAll(io.LimitReader(f, max))
	if err != nil {
		return nil, err
	}
	if off > 0 {
		if i := strings.IndexByte(string(b), '\n'); i >= 0 {
			b = b[i+1:]
		}
	}
	return b, nil
}
