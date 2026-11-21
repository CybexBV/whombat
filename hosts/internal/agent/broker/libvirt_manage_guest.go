package broker

import (
	"fmt"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	libvirt "github.com/digitalocean/go-libvirt"

	"rackoon/internal/proto"
)

// Creating, cloning, renaming and deleting libvirt VMs (docs/MANAGE.md
// 2.7). A new VM is the only document Whombat writes from scratch; clones
// and restores start from the source's own XML.

// lvOSVariant is a preset for a new VM.
type lvOSVariant struct {
	id, label, osinfo string
	uefi, tpm         bool
	windows           bool
	memMB, vcpus      int
	diskGB            int
	bus, nic, video   string
	unraidIcon        string
}

// lvOSVariants is the fixed list of OS types (Choices.OSVariants).
var lvOSVariants = []lvOSVariant{
	{id: "debian13", label: "Debian 13", osinfo: "http://debian.org/debian/13", memMB: 2048, vcpus: 2, diskGB: 32, unraidIcon: "debian.png"},
	{id: "ubuntu2404", label: "Ubuntu 24.04", osinfo: "http://ubuntu.com/ubuntu/24.04", memMB: 4096, vcpus: 2, diskGB: 32, unraidIcon: "ubuntu.png"},
	{id: "fedora", label: "Fedora", osinfo: "http://fedoraproject.org/fedora/42", memMB: 4096, vcpus: 2, diskGB: 32, unraidIcon: "fedora.png"},
	{id: "arch", label: "Arch Linux", osinfo: "http://archlinux.org/archlinux/rolling", memMB: 2048, vcpus: 2, diskGB: 32, unraidIcon: "arch.png"},
	{id: "alpine", label: "Alpine Linux", osinfo: "http://alpinelinux.org/alpinelinux/3.22", memMB: 1024, vcpus: 1, diskGB: 8, unraidIcon: "linux.png"},
	{id: "linux", label: "Other Linux", osinfo: "http://libosinfo.org/linux/2022", memMB: 2048, vcpus: 2, diskGB: 32, unraidIcon: "linux.png"},
	{id: "win11", label: "Windows 11", osinfo: "http://microsoft.com/win/11", uefi: true, tpm: true, windows: true, memMB: 4096, vcpus: 2, diskGB: 64, unraidIcon: "windows11.png"},
	{id: "win10", label: "Windows 10", osinfo: "http://microsoft.com/win/10", windows: true, memMB: 4096, vcpus: 2, diskGB: 64, unraidIcon: "windows.png"},
	{id: "win2025", label: "Windows Server 2025", osinfo: "http://microsoft.com/win/2k25", uefi: true, windows: true, memMB: 4096, vcpus: 2, diskGB: 64, unraidIcon: "windows.png"},
	{id: "freebsd", label: "FreeBSD", osinfo: "http://freebsd.org/freebsd/14.3", memMB: 2048, vcpus: 2, diskGB: 32, video: "vga", unraidIcon: "freebsd.png"},
	{id: "other", label: "Other", memMB: 2048, vcpus: 2, diskGB: 32, bus: "sata", nic: "e1000e", video: "vga", unraidIcon: "default.png"},
}

func lvOSVariantList() []proto.OSVariant {
	out := make([]proto.OSVariant, 0, len(lvOSVariants))
	for _, v := range lvOSVariants {
		fw := "bios"
		if v.uefi {
			fw = "uefi"
		}
		out = append(out, proto.OSVariant{ID: v.id, Label: v.label, Firmware: fw, TPM: v.tpm})
	}
	return out
}

func lvVariant(id string) (lvOSVariant, bool) {
	for _, v := range lvOSVariants {
		if v.id == id {
			return v, true
		}
	}
	return lvOSVariant{}, false
}

// lvNewUUID is a random (version 4) UUID.
func lvNewUUID() string {
	b := lvRandHex(16)
	v := []byte(b)
	v[12] = '4'
	v[16] = "89ab"[int(v[16])%4]
	s := string(v)
	return s[0:8] + "-" + s[8:12] + "-" + s[12:16] + "-" + s[16:20] + "-" + s[20:32]
}

// baseDomain is a new VM's document for a variant.
func baseDomain(v lvOSVariant, name string, fw proto.LibvirtFirmware, unraid bool) *lvDom {
	d := newElem("domain", "type", "kvm")
	d.add(newElem("name")).setText(name)
	d.add(newElem("uuid")).setText(lvNewUUID())
	meta := newElem("metadata")
	if v.osinfo != "" {
		lo := meta.add(newElem("libosinfo:libosinfo", "xmlns:libosinfo", "http://libosinfo.org/xmlns/libvirt/domain/1.0"))
		lo.add(newElem("libosinfo:os", "id", v.osinfo))
	}
	if unraid {
		os := "linux"
		if v.windows {
			os = "windows"
			if v.id == "win11" {
				os = "windows11"
			}
		}
		meta.add(newElem("vmtemplate", "xmlns", "http://unraid", "name", v.label, "icon", v.unraidIcon, "os", os))
	}
	if len(meta.kids) > 0 {
		d.add(meta)
	}
	d.add(newElem("memory", "unit", "KiB")).setText(strconv.Itoa(v.memMB << 10))
	d.add(newElem("currentMemory", "unit", "KiB")).setText(strconv.Itoa(v.memMB << 10))
	d.add(newElem("vcpu", "placement", "static")).setText(strconv.Itoa(v.vcpus))
	osn := d.add(newElem("os"))
	osn.add(newElem("type", "arch", "x86_64", "machine", "q35")).setText("hvm")
	secure := v.uefi && fw.SecureBoot && (v.windows || v.tpm)
	if v.uefi {
		osn.setAttr("firmware", "efi")
		if secure {
			f := osn.add(newElem("firmware"))
			f.add(newElem("feature", "enabled", "yes", "name", "enrolled-keys"))
			f.add(newElem("feature", "enabled", "yes", "name", "secure-boot"))
		}
	}
	feat := d.add(newElem("features"))
	feat.add(newElem("acpi"))
	feat.add(newElem("apic"))
	if v.windows {
		hv := feat.add(newElem("hyperv", "mode", "custom"))
		for _, f := range []string{"relaxed", "vapic", "vpindex", "synic", "stimer", "reset", "frequencies"} {
			hv.add(newElem(f, "state", "on"))
		}
		hv.add(newElem("spinlocks", "state", "on", "retries", "8191"))
	}
	if secure {
		feat.add(newElem("smm", "state", "on"))
	}
	d.add(newElem("cpu", "mode", "host-passthrough", "check", "none", "migratable", "on"))
	clock := d.add(newElem("clock", "offset", map[bool]string{true: "localtime", false: "utc"}[v.windows]))
	clock.add(newElem("timer", "name", "rtc", "tickpolicy", "catchup"))
	clock.add(newElem("timer", "name", "pit", "tickpolicy", "delay"))
	clock.add(newElem("timer", "name", "hpet", "present", "no"))
	if v.windows {
		clock.add(newElem("timer", "name", "hypervclock", "present", "yes"))
	}
	d.add(newElem("on_poweroff")).setText("destroy")
	d.add(newElem("on_reboot")).setText("restart")
	d.add(newElem("on_crash")).setText("destroy")
	pm := d.add(newElem("pm"))
	pm.add(newElem("suspend-to-mem", "enabled", "no"))
	pm.add(newElem("suspend-to-disk", "enabled", "no"))
	devs := d.add(newElem("devices"))
	devs.add(newElem("controller", "type", "usb", "model", "qemu-xhci", "ports", "15"))
	devs.add(newElem("controller", "type", "virtio-serial", "index", "0"))
	if !v.windows {
		ser := devs.add(newElem("serial", "type", "pty"))
		ser.add(newElem("target", "type", "isa-serial", "port", "0")).add(newElem("model", "name", "isa-serial"))
		devs.add(newElem("console", "type", "pty")).add(newElem("target", "type", "serial", "port", "0"))
	}
	devs.add(newElem("channel", "type", "unix")).add(newElem("target", "type", "virtio", "name", "org.qemu.guest_agent.0"))
	devs.add(newElem("input", "type", "tablet", "bus", "usb"))
	g := devs.add(newElem("graphics", "type", "vnc", "port", "-1", "autoport", "yes", "listen", "127.0.0.1"))
	g.add(newElem("listen", "type", "address", "address", "127.0.0.1"))
	video := v.video
	if video == "" {
		video = "virtio"
		if v.windows {
			video = "vga"
		}
	}
	devs.add(newElem("video")).add(newElem("model", "type", video))
	if v.tpm {
		devs.add(newElem("tpm", "model", "tpm-crb")).add(newElem("backend", "type", "emulator", "version", "2.0"))
	}
	devs.add(newElem("memballoon", "model", "virtio"))
	if !v.windows && v.id != "other" {
		devs.add(newElem("rng", "model", "virtio")).add(newElem("backend", "model", "random")).setText("/dev/urandom")
	}
	return &lvDom{x: d}
}

// ---- guest.create --------------------------------------------------------------

func (m *lvManager) create(conn LibvirtConn, req proto.ManageRequest) proto.ManageResponse {
	fe := map[string]string{}
	if req.Kind != "" && req.Kind != "vm" {
		fe["kind"] = "libvirt runs VMs only"
	}
	if !lvNameRE.MatchString(req.Name) {
		fe["name"] = "names are up to 64 letters, digits, dots, dashes and underscores, starting with a letter or digit"
	} else if _, err := conn.DomainLookupByName(req.Name); err == nil {
		return proto.ManageResponse{Code: proto.CodeExists, Message: "another VM is called " + req.Name,
			FieldErrors: map[string]string{"name": "another VM is called " + req.Name}}
	}
	vid := req.OSVariant
	if vid == "" {
		vid = "linux"
	}
	v, ok := lvVariant(vid)
	if !ok {
		fe["os_variant"] = "not an OS type of this list"
	}
	if req.Network != "" && req.Bridge != "" {
		fe["network"] = "give a network or a bridge, not both"
	}
	if req.DiskGB < 0 || req.DiskGB > 65536 {
		fe["disk_gb"] = "the disk is 1 to 65536 GB"
	}
	if len(fe) > 0 {
		return lvFields(fe)
	}
	h, err := readHost(conn, m.fs, m.backupsDir)
	if err != nil {
		return lvResp(err)
	}
	fw := h.firmware(m.fs)
	switch {
	case v.uefi && v.tpm && (!fw.UEFI || !fw.TPM):
		return lvFields(map[string]string{"os_variant": v.label + " needs UEFI firmware (OVMF) and a TPM emulator (swtpm) on this server. Install them (packages ovmf and swtpm), or choose another OS type."})
	case v.uefi && !fw.UEFI:
		return lvFields(map[string]string{"os_variant": v.label + " needs UEFI firmware (OVMF) on this server. Install it (package ovmf), or choose another OS type."})
	}
	doc := baseDomain(v, req.Name, fw, h.folders != nil)
	e := &lvEdit{m: m, conn: conn, h: h, st: &lvDomState{inactive: doc}, doc: doc, name: req.Name, fe: map[string]string{},
		liveKey: map[string]bool{}, creating: true}
	// The first disk, the installer and the network card.
	if req.DiskGB > 0 || req.Storage != "" {
		gb := req.DiskGB
		if gb == 0 {
			gb = v.diskGB
		}
		bus := v.bus
		if bus == "" {
			bus = map[bool]string{true: "sata", false: "virtio"}[v.windows]
		}
		storage := req.Storage
		if storage == "" {
			storage = defaultImageStorage(h)
		}
		e.set("disk0", fmt.Sprintf("new=%dG,storage=%s,bus=%s", gb, storage, bus))
		if msg := e.fe["disk0"]; msg != "" {
			delete(e.fe, "disk0")
			e.fe["storage"] = msg
		}
	}
	if req.ISO != "" {
		e.set("cdrom0", "source="+req.ISO+",bus=sata")
		if msg := e.fe["cdrom0"]; msg != "" {
			delete(e.fe, "cdrom0")
			e.fe["iso"] = msg
		}
	}
	nic := v.nic
	if nic == "" {
		nic = map[bool]string{true: "e1000e", false: "virtio"}[v.windows]
	}
	switch {
	case req.Network != "":
		e.set("net0", "model="+nic+",network="+req.Network)
	case req.Bridge != "":
		e.set("net0", "model="+nic+",bridge="+req.Bridge)
	default:
		// The default network when there is one, else the first bridge.
		nets := readNetworks(conn, nil)
		for _, n := range nets {
			if n.Active && n.Name == "default" {
				e.set("net0", "model="+nic+",network=default")
			}
		}
		if e.devNode("net0") == nil {
			if br := hostBridges(m.fs, nets); len(br) > 0 {
				e.set("net0", "model="+nic+",bridge="+br[0])
			} else {
				for _, n := range nets {
					if n.Active && e.devNode("net0") == nil {
						e.set("net0", "model="+nic+",network="+n.Name)
					}
				}
			}
		}
	}
	if msg := e.fe["net0"]; msg != "" {
		delete(e.fe, "net0")
		e.fe[map[bool]string{true: "bridge", false: "network"}[req.Bridge != ""]] = msg
	}
	if req.ISO != "" {
		doc.setBootOrder([]string{"cdrom", "hd"})
	} else {
		doc.setBootOrder([]string{"hd"})
	}
	// Then the settings asked for (scalars and further devices).
	keys := make([]string, 0, len(req.Set))
	for k := range req.Set {
		keys = append(keys, k)
	}
	slices.SortFunc(keys, func(a, b string) int {
		am, bm := strings.HasSuffix(a, "_max") || strings.HasSuffix(a, "_max_mb"), strings.HasSuffix(b, "_max") || strings.HasSuffix(b, "_max_mb")
		switch {
		case am && !bm:
			return -1
		case bm && !am:
			return 1
		case lvKeyLess(a, b):
			return -1
		case lvKeyLess(b, a):
			return 1
		}
		return 0
	})
	for _, k := range keys {
		if k == "name" {
			if req.Set[k] != req.Name {
				e.bad(k, "the name is given as name")
			}
			continue
		}
		e.set(k, req.Set[k])
	}
	if len(e.fe) > 0 {
		e.cleanup()
		return lvFields(e.fe)
	}
	dom, err := conn.DomainDefineXMLFlags(doc.String(), libvirt.DomainDefineValidate)
	if err != nil {
		e.cleanup()
		r := lvPlatformError(err)
		if r.Code == CodePlatformError {
			r.Code = proto.CodeInvalidValue
		}
		return r
	}
	if e.auto != nil && *e.auto {
		_ = conn.DomainSetAutostart(dom, 1)
	}
	if req.Start {
		if err := conn.DomainCreate(dom); err != nil {
			r := lvPlatformError(err)
			r.Message = "The VM was created but did not start: " + r.Message
			r.NewID = req.Name
			return r
		}
	}
	return proto.ManageResponse{OK: true, NewID: req.Name}
}

// ---- copying disks -------------------------------------------------------------

// lvDiskCopy copies one disk file into a target folder or pool.
type lvDiskCopy struct {
	src      string // source path
	dstDir   string // target folder ("" when dstPool is a pool of the host)
	dstPool  string // a pool of the host
	dstName  string // volume (file) name
	format   string // qcow2 | raw
	readOnly bool
}

// copyFile copies src as a new volume through libvirt (qemu-img convert:
// sparse, any format), reporting progress from the target's size.
func (m *lvManager) copyFile(conn LibvirtConn, h *lvHost, t *lvTaskHandle, c lvDiskCopy, label string) (string, error) {
	var result string
	withSrc := func(f func(src libvirt.StorageVol) error) error {
		if v, ok := lookupVolPath(conn, h, c.src); ok {
			return f(v)
		}
		return withDir(conn, h, filepath.Dir(c.src), false, func(pool libvirt.StoragePool) error {
			v, err := conn.StorageVolLookupByName(pool, filepath.Base(c.src))
			if err != nil {
				return fmt.Errorf("libvirt cannot read %s: %w", c.src, err)
			}
			return f(v)
		})
	}
	withDst := func(f func(pool libvirt.StoragePool, dir string) error) error {
		if c.dstPool != "" {
			pl, ok := h.pool(c.dstPool)
			if !ok || !pl.active {
				return lvFieldError("storage", "there is no active storage pool %s", c.dstPool)
			}
			return f(pl.ref, pl.path)
		}
		return withDir(conn, h, c.dstDir, true, func(pool libvirt.StoragePool) error { return f(pool, c.dstDir) })
	}
	err := withSrc(func(src libvirt.StorageVol) error {
		_, capacity, alloc, err := conn.StorageVolGetInfo(src)
		if err != nil {
			return err
		}
		return withDst(func(pool libvirt.StoragePool, dir string) error {
			if _, err := conn.StorageVolLookupByName(pool, c.dstName); err == nil {
				return fmt.Errorf("%s exists already", filepath.Join(dir, c.dstName))
			}
			doc := newElem("volume")
			doc.add(newElem("name")).setText(c.dstName)
			doc.add(newElem("capacity", "unit", "bytes")).setText(strconv.FormatUint(capacity, 10))
			doc.add(newElem("target")).add(newElem("format", "type", c.format))
			t.logf("Copying %s (%s)…", label, lvFmtBytes(capacity))
			done := make(chan struct{})
			if dir != "" && alloc > 0 {
				go func() {
					tick := time.NewTicker(2 * time.Second)
					defer tick.Stop()
					for {
						select {
						case <-done:
							return
						case <-tick.C:
							if st, err := m.fs.Stat(filepath.Join(dir, c.dstName)); err == nil {
								pct := min(99, int(float64(st.UsedBytes)/float64(alloc)*100))
								t.progress("Copying %s: %d %%", label, pct)
							}
						}
					}
				}()
			}
			v, err := conn.StorageVolCreateXMLFrom(pool, doc.String(), src, 0)
			close(done)
			if err != nil {
				return fmt.Errorf("copying %s: %w", label, err)
			}
			result, err = conn.StorageVolGetPath(v)
			if err != nil {
				result = filepath.Join(dir, c.dstName)
			}
			if t.stopped() {
				_ = conn.StorageVolDelete(v, 0)
				return errLvStopped
			}
			return nil
		})
	})
	return result, err
}

// targetFor says where a VM's copied disks go: a pool (<vm>-<target>.qcow2)
// or unRAID's domains folder (<domains>/<vm>/vdiskN.qcow2).
func targetFor(h *lvHost, storage, vm, target string, n int) (lvDiskCopy, error) {
	if storage == proto.LibvirtDomainsFolder {
		dir := h.folderPath(storage)
		if dir == "" {
			return lvDiskCopy{}, lvFieldError("storage", "Unraid’s domains folder is not set")
		}
		return lvDiskCopy{dstDir: filepath.Join(dir, vm), dstName: fmt.Sprintf("vdisk%d.qcow2", n+1), format: "qcow2"}, nil
	}
	pl, ok := h.pool(storage)
	if !ok || !pl.active {
		return lvDiskCopy{}, lvFieldError("storage", "there is no active storage pool %s", storage)
	}
	c := lvDiskCopy{dstPool: storage, dstName: vm + "-" + target + ".qcow2", format: "qcow2"}
	if !pl.fileBased() {
		c.dstName, c.format = vm+"-"+target, "raw"
	}
	return c, nil
}

// copiedDisk points a disk element at its copy.
func copiedDisk(n *xnode, p, format string, block bool) {
	n.removeAll("source")
	n.removeAll("backingStore")
	n.removeAll("alias")
	if block {
		n.setAttr("type", "block")
	} else {
		n.setAttr("type", "file")
	}
	n.ensure("driver").setAttr("type", format)
	if n.child("driver").attr("name") == "" {
		n.child("driver").setAttr("name", "qemu")
	}
	src := newElem("source", map[bool]string{true: "dev", false: "file"}[block], p)
	n.insertAfter(src, "driver")
}

// newIdentity gives a document a name, a new UUID and new MAC addresses.
func newIdentity(d *lvDom, name string) string {
	d.x.ensure("name").setText(name)
	id := lvNewUUID()
	if u := d.x.child("uuid"); u != nil {
		u.setText(id)
	} else {
		d.x.insertAfter(newElem("uuid"), "name")
		d.x.child("uuid").setText(id)
	}
	d.x.removeAll("title")
	for _, nic := range d.nicNodes() {
		nic.removeAll("mac")
		nic.removeAll("target")
		nic.removeAll("alias")
	}
	// Fixed display ports would clash with the source's.
	for _, g := range d.x.child("devices").children("graphics") {
		if g.attr("autoport") == "no" {
			g.setAttr("autoport", "yes")
			g.setAttr("port", "-1")
			g.delAttr("websocket")
		}
	}
	return id
}

// copyNVRAM copies a UEFI VM's variables next to the original as
// <uuid>_VARS.fd (unRAID: <uuid>_VARS-pure-efi.fd keeps its suffix) and
// points the document at it; without one the document keeps its template
// and libvirt makes fresh variables at the first start.
func (m *lvManager) copyNVRAM(conn LibvirtConn, h *lvHost, t *lvTaskHandle, d *lvDom, src, uuid string) {
	nv := d.x.path("os/nvram")
	if nv == nil {
		return
	}
	if src == "" || !m.fs.Exists(src) {
		nv.kids = nil
		return
	}
	dir := filepath.Dir(src)
	base := filepath.Base(src)
	name := uuid + "_VARS.fd"
	if i := strings.Index(base, "_VARS"); i > 0 {
		name = uuid + base[i:]
	}
	p, err := m.copyFile(conn, h, t, lvDiskCopy{src: src, dstDir: dir, dstName: name, format: "raw"}, "the UEFI variables")
	if err != nil {
		t.logf("The UEFI variables could not be copied (%v); the VM starts with fresh ones.", err)
		nv.kids = nil
		return
	}
	nv.setText(p)
}

// ---- guest.clone ---------------------------------------------------------------

func (m *lvManager) clone(conn LibvirtConn, g *proto.Guest, req proto.ManageRequest) proto.ManageResponse {
	if !lvNameRE.MatchString(req.Name) {
		return lvFields(map[string]string{"name": "names are up to 64 letters, digits, dots, dashes and underscores, starting with a letter or digit"})
	}
	if _, err := conn.DomainLookupByName(req.Name); err == nil {
		return proto.ManageResponse{Code: proto.CodeExists, Message: "another VM is called " + req.Name,
			FieldErrors: map[string]string{"name": "another VM is called " + req.Name}}
	}
	st, err := m.loadDomain(conn, g.ID)
	if err != nil {
		return lvResp(err)
	}
	if st.running {
		return proto.ManageResponse{Code: proto.CodeGuestRunning, Message: "Shut the VM down to clone it."}
	}
	h, err := readHost(conn, m.fs, m.backupsDir)
	if err != nil {
		return lvResp(err)
	}
	plan, resp := m.planCopies(conn, h, st.inactive, req.Name, req.Storage)
	if resp != nil {
		return *resp
	}
	doc := st.inactive.clone()
	nvSrc := doc.x.path("os/nvram").textContent()
	id := m.tasks.start("qmclone", g.ID, func(t *lvTaskHandle) error {
		c, err := m.dial()
		if err != nil {
			return err
		}
		defer c.Disconnect()
		t.logf("Cloning %s as %s.", g.ID, req.Name)
		uuid := newIdentity(doc, req.Name)
		var made []string
		fail := func(err error) error {
			for _, p := range made {
				_ = deleteFile(c, h, p)
			}
			return err
		}
		for _, cp := range plan {
			if t.stopped() {
				return fail(errLvStopped)
			}
			p, err := m.copyFile(c, h, t, cp.copy, "disk "+cp.target)
			if err != nil {
				return fail(err)
			}
			made = append(made, p)
			copiedDisk(cp.node(doc), p, cp.copy.format, cp.block)
		}
		m.copyNVRAM(c, h, t, doc, nvSrc, uuid)
		if _, err := c.DomainDefineXMLFlags(doc.String(), libvirt.DomainDefineValidate); err != nil {
			return fail(fmt.Errorf("defining the clone: %w", err))
		}
		t.setGuest(req.Name)
		t.logf("%s is ready (new UUID and MAC addresses).", req.Name)
		return nil
	})
	return proto.ManageResponse{OK: true, Task: &proto.TaskRef{ID: id}, NewID: req.Name}
}

// lvPlannedCopy is a disk of a document and where its copy goes.
type lvPlannedCopy struct {
	index  int // position among the document's disks
	target string
	copy   lvDiskCopy
	block  bool
}

func (c lvPlannedCopy) node(d *lvDom) *xnode { return d.diskNodes("disk")[c.index] }

// planCopies says where each disk of a VM goes for a copy (clone):
// storage, else the pool or folder the disk is in, else the default.
// Disks Whombat cannot copy (whole disks, network disks) refuse.
func (m *lvManager) planCopies(conn LibvirtConn, h *lvHost, d *lvDom, name, storage string) ([]lvPlannedCopy, *proto.ManageResponse) {
	var out []lvPlannedCopy
	for i, n := range d.diskNodes("disk") {
		disk := readLvDisk(n)
		path := disk.path
		if disk.typ == "volume" {
			if p, err := conn.StoragePoolLookupByName(disk.pool); err == nil {
				if v, err := conn.StorageVolLookupByName(p, disk.vol); err == nil {
					path, _ = conn.StorageVolGetPath(v)
				}
			}
		}
		if disk.typ != "file" && disk.typ != "volume" || path == "" {
			return nil, &proto.ManageResponse{Code: proto.CodeNotAllowed,
				Message: fmt.Sprintf("Disk %s is a whole disk or device; Whombat copies only disk files. Clone it in virt-manager or Unraid’s VM page.", disk.target)}
		}
		dst := storage
		if dst == "" {
			dst = h.storageOf(path)
			if dst == "" || dst == proto.LibvirtISOsFolder {
				dst = defaultImageStorage(h)
			}
		}
		c, err := targetFor(h, dst, name, disk.target, i)
		if err != nil {
			r := lvResp(err)
			return nil, &r
		}
		c.src = path
		pl, _ := h.pool(dst)
		out = append(out, lvPlannedCopy{index: i, target: disk.target, copy: c, block: c.dstPool != "" && !pl.fileBased()})
	}
	return out, nil
}

// ---- guest.rename --------------------------------------------------------------

func (m *lvManager) rename(conn LibvirtConn, g *proto.Guest, req proto.ManageRequest) proto.ManageResponse {
	if !lvNameRE.MatchString(req.Name) {
		return lvFields(map[string]string{"name": "names are up to 64 letters, digits, dots, dashes and underscores, starting with a letter or digit"})
	}
	if req.Name == g.ID {
		return proto.ManageResponse{OK: true, NewID: g.ID}
	}
	if _, err := conn.DomainLookupByName(req.Name); err == nil {
		return proto.ManageResponse{Code: proto.CodeExists, Message: "another VM is called " + req.Name,
			FieldErrors: map[string]string{"name": "another VM is called " + req.Name}}
	}
	st, err := m.loadDomain(conn, g.ID)
	if err != nil {
		return lvResp(err)
	}
	if st.running {
		return proto.ManageResponse{Code: proto.CodeGuestRunning, Message: "Shut the VM down to rename it."}
	}
	if _, err := conn.DomainRename(st.ref, libvirt.OptString{req.Name}, 0); err != nil {
		r := lvPlatformError(err)
		if strings.Contains(strings.ToLower(err.Error()), "snapshot") {
			r.Code, r.Message = proto.CodeNotAllowed, "libvirt cannot rename a VM that has snapshots. Delete its snapshots first."
		}
		return r
	}
	return proto.ManageResponse{OK: true, NewID: req.Name, Changes: []proto.ConfigChange{{Key: "name", Old: g.ID, New: req.Name}}}
}

// ---- guest.delete --------------------------------------------------------------

// deleteGuest removes a stopped VM; purge deletes its disk files (those in
// pools and unRAID's domains folder that no other VM uses), its UEFI
// variables and its TPM state too.
func (m *lvManager) deleteGuest(conn LibvirtConn, g *proto.Guest, req proto.ManageRequest) proto.ManageResponse {
	st, err := m.loadDomain(conn, g.ID)
	if err != nil {
		return lvResp(err)
	}
	if st.running {
		return proto.ManageResponse{Code: proto.CodeGuestRunning, Message: "Shut the VM down to delete it."}
	}
	h, err := readHost(conn, m.fs, m.backupsDir)
	if err != nil {
		return lvResp(err)
	}
	var files []string
	if req.Purge {
		roots := h.writeRoots()
		for _, n := range st.inactive.diskNodes("disk") {
			d := readLvDisk(n)
			p := d.path
			if d.typ == "volume" {
				if pl, err := conn.StoragePoolLookupByName(d.pool); err == nil {
					if v, err := conn.StorageVolLookupByName(pl, d.vol); err == nil {
						p, _ = conn.StorageVolGetPath(v)
					}
				}
			}
			if d.typ != "file" && d.typ != "volume" || p == "" || d.readonly {
				continue
			}
			if !lvWithin(p, roots) || h.backupsDir != "" && lvWithin(p, []string{h.backupsDir}) {
				m.log.Info("libvirt delete keeps a disk outside the pools", "vm", g.ID, "path", p)
				continue
			}
			if other := domainUsing(conn, p, g.ID); other != "" {
				continue
			}
			files = append(files, p)
		}
	}
	flags := libvirt.DomainUndefineManagedSave | libvirt.DomainUndefineSnapshotsMetadata | libvirt.DomainUndefineCheckpointsMetadata
	if req.Purge {
		flags |= libvirt.DomainUndefineNvram | libvirt.DomainUndefineTpm
	} else {
		flags |= libvirt.DomainUndefineKeepNvram | libvirt.DomainUndefineKeepTpm
	}
	err = conn.DomainUndefineFlags(st.ref, flags)
	if err != nil && strings.Contains(strings.ToLower(err.Error()), "unsupported flag") {
		// libvirt before 8.9 knows no TPM flags.
		err = conn.DomainUndefineFlags(st.ref, flags&^(libvirt.DomainUndefineTpm|libvirt.DomainUndefineKeepTpm))
	}
	if err != nil {
		return lvPlatformError(err)
	}
	var kept []string
	dirs := map[string]bool{}
	for _, p := range files {
		if err := deleteFile(conn, h, p); err != nil {
			kept = append(kept, p)
			m.log.Warn("libvirt delete could not remove a disk", "vm", g.ID, "path", p, "err", err)
			continue
		}
		if h.folders != nil && h.folders.Domains != "" && filepath.Dir(filepath.Dir(p)) == h.folders.Domains {
			dirs[filepath.Dir(p)] = true
		}
	}
	// unRAID: the VM's own folder in the domains folder, when empty now.
	for dir := range dirs {
		if ents, err := m.fs.ReadDir(dir); err == nil && len(ents) == 0 {
			_ = removeDir(conn, h, dir)
		}
	}
	resp := proto.ManageResponse{OK: true}
	if len(kept) > 0 {
		resp.Message = "The VM is deleted; some disk files could not be removed: " + strings.Join(kept, ", ")
	}
	return resp
}
