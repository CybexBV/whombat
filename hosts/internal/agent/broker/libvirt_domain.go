package broker

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// The typed view of a libvirt domain document over the XML tree
// (libvirt_xml.go) and the Proxmox-like keys Whombat shows and changes
// (docs/MANAGE.md 2.7): name, title, description, vcpus, vcpus_max,
// memory_mb, memory_max_mb, autostart, boot, cpu_mode, on_poweroff,
// on_reboot, on_crash, disk<N>, cdrom<N>, net<N>; read-only machine,
// firmware, secure_boot, tpm, hostdev<N>, graphics<N>, video.

var (
	lvNameRE   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
	lvDiskKey  = regexp.MustCompile(`^disk([0-9]{1,2})$`)
	lvCDKey    = regexp.MustCompile(`^cdrom([0-9]{1,2})$`)
	lvNetKey   = regexp.MustCompile(`^net([0-9]{1,2})$`)
	lvMACRE    = regexp.MustCompile(`^[0-9a-f]{2}(:[0-9a-f]{2}){5}$`)
	lvModelRE  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.+-]{0,63}$`)
	lvTargetRE = regexp.MustCompile(`^(vd|sd|hd|xvd)[a-z]{1,2}$`)
)

// lvScalarKeys are the keys besides devices Whombat changes.
var lvScalarKeys = []string{"name", "title", "description", "vcpus", "vcpus_max", "memory_mb", "memory_max_mb",
	"autostart", "boot", "cpu_mode", "on_poweroff", "on_reboot", "on_crash"}

// lvReadOnlyKeys are shown, never changed.
var lvReadOnlyKeys = map[string]bool{"machine": true, "firmware": true, "secure_boot": true, "tpm": true, "video": true}

// lvDom is a domain document.
type lvDom struct{ x *xnode }

func parseLvDom(s string) (*lvDom, error) {
	x, err := parseXMLTree(s)
	if err != nil {
		return nil, err
	}
	if x.name != "domain" {
		return nil, fmt.Errorf("not a domain document (%s)", x.name)
	}
	return &lvDom{x: x}, nil
}

func (d *lvDom) String() string { return d.x.String() }

func (d *lvDom) clone() *lvDom { return &lvDom{x: d.x.clone()} }

// lvDigest is the SHA-256 of a domain document (the inactive XML).
func lvDigest(xml string) string {
	s := sha256.Sum256([]byte(xml))
	return hex.EncodeToString(s[:])
}

func (d *lvDom) name() string { return d.x.child("name").textContent() }
func (d *lvDom) uuid() string { return d.x.child("uuid").textContent() }

func (d *lvDom) devices() *xnode { return d.x.ensure("devices") }

// devs returns the devices of a kind in document order.
func (d *lvDom) diskNodes(device string) []*xnode {
	var out []*xnode
	for _, n := range d.x.child("devices").children("disk") {
		dev := n.attr("device")
		if dev == "" {
			dev = "disk"
		}
		if dev == device {
			out = append(out, n)
		}
	}
	return out
}

func (d *lvDom) nicNodes() []*xnode { return d.x.child("devices").children("interface") }

// windows: libosinfo says Windows, or the domain has Hyper-V
// enlightenments (unRAID's Windows template).
func (d *lvDom) windows() bool {
	meta := strings.ToLower(d.x.child("metadata").String())
	return strings.Contains(meta, "microsoft.com/win") || strings.Contains(meta, "os='windows") ||
		strings.Contains(meta, "os=\"windows") || d.x.path("features/hyperv") != nil
}

// ---- disks -------------------------------------------------------------------

// lvDisk is a disk or CD/DVD drive of the document.
type lvDisk struct {
	n        *xnode
	typ      string // file | block | volume | network | dir
	device   string // disk | cdrom | floppy | lun
	path     string // file / dev / dir source
	pool     string // type volume
	vol      string
	format   string // driver type
	bus      string
	target   string
	readonly bool
	cache    string
	discard  string
	bootOrd  int // <boot order='N'/> (0 = none)
}

func readLvDisk(n *xnode) lvDisk {
	d := lvDisk{n: n, typ: n.attr("type"), device: n.attr("device")}
	if d.device == "" {
		d.device = "disk"
	}
	if d.typ == "" {
		d.typ = "file"
	}
	if src := n.child("source"); src != nil {
		switch d.typ {
		case "file":
			d.path = src.attr("file")
		case "block":
			d.path = src.attr("dev")
		case "dir":
			d.path = src.attr("dir")
		case "volume":
			d.pool, d.vol = src.attr("pool"), src.attr("volume")
		case "network":
			d.path = src.attr("protocol") + ":" + src.attr("name")
		}
	}
	if drv := n.child("driver"); drv != nil {
		d.format, d.cache, d.discard = drv.attr("type"), drv.attr("cache"), drv.attr("discard")
	}
	if t := n.child("target"); t != nil {
		d.target, d.bus = t.attr("dev"), t.attr("bus")
	}
	d.readonly = n.child("readonly") != nil
	if b := n.child("boot"); b != nil {
		d.bootOrd, _ = strconv.Atoi(b.attr("order"))
	}
	return d
}

// source is the disk's source as Whombat shows it: a path, or pool/volume.
func (d lvDisk) source() string {
	if d.typ == "volume" {
		if d.pool == "" {
			return ""
		}
		return d.pool + "/" + d.vol
	}
	return d.path
}

// editable: a disk Whombat may change (a file or a pool volume).
func (d lvDisk) editable() bool {
	switch d.device {
	case "disk":
		return d.typ == "file" || d.typ == "volume"
	case "cdrom":
		return d.typ == "file" || d.typ == "volume" || d.typ == "block" && d.path == ""
	}
	return false
}

// value renders disk<N> / cdrom<N>.
func (d lvDisk) value(size uint64) string {
	var p []string
	if d.device == "cdrom" {
		src := d.source()
		if src == "" {
			src = "empty"
		}
		p = append(p, "source="+src, "bus="+d.bus)
		if d.target != "" {
			p = append(p, "target="+d.target)
		}
		return strings.Join(p, ",")
	}
	p = append(p, "source="+d.source(), "bus="+d.bus)
	if d.format != "" {
		p = append(p, "format="+d.format)
	}
	p = append(p, "target="+d.target)
	if size > 0 {
		p = append(p, "size="+strconv.FormatUint(size, 10))
	}
	if d.cache != "" {
		p = append(p, "cache="+d.cache)
	}
	if d.discard != "" {
		p = append(p, "discard="+d.discard)
	}
	if d.readonly {
		p = append(p, "readonly=1")
	}
	return strings.Join(p, ",")
}

// ---- network cards -----------------------------------------------------------

type lvNIC struct {
	n       *xnode
	typ     string // network | bridge | direct | user | hostdev | ...
	source  string // network name, bridge, direct device
	model   string
	mac     string
	link    string // up | down
	bootOrd int
}

func readLvNIC(n *xnode) lvNIC {
	c := lvNIC{n: n, typ: n.attr("type"), link: "up"}
	if src := n.child("source"); src != nil {
		switch c.typ {
		case "network":
			c.source = src.attr("network")
		case "bridge":
			c.source = src.attr("bridge")
		case "direct":
			c.source = src.attr("dev")
		}
	}
	c.model = n.child("model").attr("type")
	c.mac = strings.ToLower(n.child("mac").attr("address"))
	if l := n.child("link"); l != nil && l.attr("state") == "down" {
		c.link = "down"
	}
	if b := n.child("boot"); b != nil {
		c.bootOrd, _ = strconv.Atoi(b.attr("order"))
	}
	return c
}

func (c lvNIC) editable() bool { return c.typ == "network" || c.typ == "bridge" }

func (c lvNIC) value() string {
	var p []string
	if c.model != "" {
		p = append(p, "model="+c.model)
	}
	switch c.typ {
	case "network", "bridge", "direct":
		p = append(p, c.typ+"="+c.source)
	default:
		p = append(p, "type="+c.typ)
	}
	if c.mac != "" {
		p = append(p, "mac="+c.mac)
	}
	p = append(p, "link="+c.link)
	return strings.Join(p, ",")
}

// ---- values ------------------------------------------------------------------

// lvDevKey ties a key to its device node.
type lvDevKey struct {
	key  string
	node *xnode
}

// devKeys numbers the devices of a document: disk<N>, cdrom<N>, net<N>
// in document order.
func (d *lvDom) devKeys() []lvDevKey {
	var out []lvDevKey
	for i, n := range d.diskNodes("disk") {
		out = append(out, lvDevKey{fmt.Sprintf("disk%d", i), n})
	}
	for i, n := range d.diskNodes("cdrom") {
		out = append(out, lvDevKey{fmt.Sprintf("cdrom%d", i), n})
	}
	for i, n := range d.nicNodes() {
		out = append(out, lvDevKey{fmt.Sprintf("net%d", i), n})
	}
	return out
}

// devIdentity says which device of another document is the same one: a
// disk by its target, a network card by its MAC.
func devIdentity(n *xnode) string {
	switch n.name {
	case "disk":
		return "disk:" + n.child("target").attr("dev")
	case "interface":
		if m := strings.ToLower(n.child("mac").attr("address")); m != "" {
			return "nic:" + m
		}
	}
	return ""
}

func memMiB(n *xnode) uint64 {
	if n == nil {
		return 0
	}
	v, err := strconv.ParseUint(n.textContent(), 10, 64)
	if err != nil {
		return 0
	}
	return xmlMemBytes(v, n.attr("unit")) >> 20
}

// xmlMemBytes converts a libvirt memory value (default KiB).
func xmlMemBytes(v uint64, unit string) uint64 {
	switch strings.ToLower(unit) {
	case "b", "bytes":
		return v
	case "kb":
		return v * 1000
	case "", "k", "kib":
		return v << 10
	case "mb":
		return v * 1000 * 1000
	case "m", "mib":
		return v << 20
	case "gb":
		return v * 1000 * 1000 * 1000
	case "g", "gib":
		return v << 30
	case "tb":
		return v * 1000 * 1000 * 1000 * 1000
	case "t", "tib":
		return v << 40
	}
	return v << 10
}

// scalarValues are the document's values of the scalar and read-only
// keys (autostart comes from libvirt, not the document).
func (d *lvDom) scalarValues() map[string]string {
	v := map[string]string{"name": d.name()}
	if t := d.x.child("title"); t != nil {
		v["title"] = t.textContent()
	}
	if t := d.x.child("description"); t != nil {
		v["description"] = t.textContent()
	}
	if vc := d.x.child("vcpu"); vc != nil {
		max := vc.textContent()
		cur := vc.attr("current")
		if cur == "" {
			cur = max
		}
		v["vcpus"], v["vcpus_max"] = cur, max
	}
	if m := memMiB(d.x.child("memory")); m > 0 {
		v["memory_max_mb"] = strconv.FormatUint(m, 10)
		cur := memMiB(d.x.child("currentMemory"))
		if cur == 0 {
			cur = m
		}
		v["memory_mb"] = strconv.FormatUint(cur, 10)
	}
	if b := d.bootOrder(); b != "" {
		v["boot"] = b
	}
	if c := d.x.child("cpu"); c != nil {
		mode := c.attr("mode")
		if mode == "" || mode == "custom" {
			if m := c.child("model").textContent(); m != "" {
				mode = "custom:" + m
			} else if mode == "" {
				mode = ""
			}
		}
		if mode != "" {
			v["cpu_mode"] = mode
		}
	}
	for key, def := range map[string]string{"on_poweroff": "destroy", "on_reboot": "restart", "on_crash": "destroy"} {
		if t := d.x.child(key).textContent(); t != "" {
			v[key] = t
		} else {
			v[key] = def
		}
	}
	// Read-only facts.
	if m := d.x.path("os/type").attr("machine"); m != "" {
		v["machine"] = m
	}
	v["firmware"] = "bios"
	if d.uefi() {
		v["firmware"] = "uefi"
	}
	v["secure_boot"] = lvBoolStr(d.secureBoot())
	v["tpm"] = lvBoolStr(d.x.path("devices/tpm") != nil)
	if vid := d.x.path("devices/video/model"); vid != nil {
		v["video"] = vid.attr("type")
	}
	for i, h := range d.x.child("devices").children("hostdev") {
		v[fmt.Sprintf("hostdev%d", i)] = hostdevValue(h)
	}
	for i, g := range d.x.child("devices").children("graphics") {
		val := "type=" + g.attr("type")
		if l := g.attr("listen"); l != "" {
			val += ",listen=" + l
		}
		v[fmt.Sprintf("graphics%d", i)] = val
	}
	return v
}

func lvBoolStr(b bool) string {
	if b {
		return "1"
	}
	return "0"
}

func (d *lvDom) uefi() bool {
	os := d.x.child("os")
	if os.attr("firmware") == "efi" {
		return true
	}
	l := strings.ToLower(os.child("loader").textContent())
	return strings.Contains(l, "ovmf") || strings.Contains(l, "edk2") || strings.Contains(l, "aavmf") ||
		os.child("loader").attr("type") == "pflash"
}

func (d *lvDom) secureBoot() bool {
	os := d.x.child("os")
	if os.child("loader").attr("secure") == "yes" {
		return true
	}
	for _, f := range os.path("firmware").children("feature") {
		if f.attr("name") == "secure-boot" && f.attr("enabled") == "yes" {
			return true
		}
	}
	return false
}

func hostdevValue(h *xnode) string {
	typ := h.attr("type")
	src := h.child("source")
	switch typ {
	case "pci":
		a := src.child("address")
		return fmt.Sprintf("type=pci,address=%s:%s:%s.%s", strings.TrimPrefix(a.attr("domain"), "0x"),
			strings.TrimPrefix(a.attr("bus"), "0x"), strings.TrimPrefix(a.attr("slot"), "0x"), strings.TrimPrefix(a.attr("function"), "0x"))
	case "usb":
		return "type=usb,vendor=" + src.child("vendor").attr("id") + ",product=" + src.child("product").attr("id")
	}
	return "type=" + typ
}

// bootOrder is the boot order as hd,cdrom,network: <os><boot dev=…/>, else
// from the devices' own <boot order=…/>.
func (d *lvDom) bootOrder() string {
	var devs []string
	for _, b := range d.x.child("os").children("boot") {
		devs = append(devs, b.attr("dev"))
	}
	if len(devs) > 0 {
		return strings.Join(devs, ",")
	}
	type ord struct {
		n   int
		dev string
	}
	var ords []ord
	for _, n := range d.x.child("devices").children("") {
		b := n.child("boot")
		if b == nil {
			continue
		}
		o, err := strconv.Atoi(b.attr("order"))
		if err != nil {
			continue
		}
		dev := ""
		switch {
		case n.name == "interface":
			dev = "network"
		case n.name == "disk" && n.attr("device") == "cdrom":
			dev = "cdrom"
		case n.name == "disk" && n.attr("device") == "floppy":
			dev = "fd"
		case n.name == "disk":
			dev = "hd"
		default:
			continue
		}
		ords = append(ords, ord{o, dev})
	}
	sort.Slice(ords, func(i, j int) bool { return ords[i].n < ords[j].n })
	seen := map[string]bool{}
	for _, o := range ords {
		if !seen[o.dev] {
			seen[o.dev] = true
			devs = append(devs, o.dev)
		}
	}
	return strings.Join(devs, ",")
}

// setBootOrder writes the boot order: as <os><boot dev=…/> when the
// document uses those, else as the devices' own order (libvirt does not
// allow both): the first device of each kind in the order asked, the
// others lose theirs.
func (d *lvDom) setBootOrder(order []string) {
	osn := d.x.ensure("os")
	perDevice := false
	for _, n := range d.x.child("devices").children("") {
		if n.child("boot") != nil {
			perDevice = true
		}
	}
	if !perDevice {
		osn.removeAll("boot")
		for _, dev := range order {
			osn.insertAfter(newElem("boot", "dev", dev), "type", "loader", "nvram", "boot")
		}
		return
	}
	for _, n := range d.x.child("devices").children("") {
		n.removeAll("boot")
	}
	pick := func(dev string) *xnode {
		switch dev {
		case "network":
			if l := d.nicNodes(); len(l) > 0 {
				return l[0]
			}
		case "cdrom":
			if l := d.diskNodes("cdrom"); len(l) > 0 {
				return l[0]
			}
		case "hd":
			if l := d.diskNodes("disk"); len(l) > 0 {
				return l[0]
			}
		case "fd":
			if l := d.diskNodes("floppy"); len(l) > 0 {
				return l[0]
			}
		}
		return nil
	}
	for i, dev := range order {
		if n := pick(dev); n != nil {
			n.add(newElem("boot", "order", strconv.Itoa(i+1)))
		}
	}
}

// setText sets (or with "" removes) a top-level text element.
func (d *lvDom) setTopText(name, value string, after ...string) {
	n := d.x.child(name)
	if value == "" {
		if n != nil {
			d.x.remove(n)
		}
		return
	}
	if n == nil {
		n = newElem(name)
		d.x.insertAfter(n, after...)
	}
	n.setText(value)
}

// setMem writes a memory element in KiB.
func (d *lvDom) setMem(name string, mib uint64) {
	n := d.x.child(name)
	if n == nil {
		n = newElem(name)
		d.x.insertAfter(n, "memory", "maxMemory", "metadata", "description", "title", "uuid", "name")
	}
	n.attrs = nil
	n.setAttr("unit", "KiB")
	n.setText(strconv.FormatUint(mib<<10, 10))
}

// setCPUMode writes <cpu mode=…> keeping topology, features and caches;
// a custom model gets a <model>, the other modes lose it.
func (d *lvDom) setCPUMode(mode string) {
	c := d.x.child("cpu")
	if c == nil {
		c = newElem("cpu")
		d.x.insertAfter(c, "features", "os", "vcpu", "currentMemory", "memory")
	}
	if model, ok := strings.CutPrefix(mode, "custom:"); ok {
		c.setAttr("mode", "custom")
		c.setAttr("match", "exact")
		c.delAttr("migratable")
		m := c.child("model")
		if m == nil {
			m = newElem("model")
			c.kids = append([]*xnode{m}, c.kids...)
		}
		m.attrs = nil
		m.setAttr("fallback", "allow")
		m.setText(model)
		return
	}
	c.setAttr("mode", mode)
	c.delAttr("match")
	c.removeAll("model")
	if mode != "host-passthrough" && mode != "maximum" {
		c.delAttr("migratable")
	}
}

// nextTarget is the next free target device for a bus ("vdb").
func (d *lvDom) nextTarget(bus string) string {
	prefix := map[string]string{"virtio": "vd", "sata": "sd", "scsi": "sd", "usb": "sd", "ide": "hd", "xen": "xvd"}[bus]
	if prefix == "" {
		prefix = "sd"
	}
	used := map[string]bool{}
	for _, n := range d.x.child("devices").children("disk") {
		used[n.child("target").attr("dev")] = true
	}
	for i := 0; i < 26*27; i++ {
		var suffix string
		if i < 26 {
			suffix = string(rune('a' + i))
		} else {
			suffix = string(rune('a'+i/26-1)) + string(rune('a'+i%26))
		}
		if !used[prefix+suffix] {
			return prefix + suffix
		}
	}
	return ""
}

// lvParseKV reads "k=v,k=v" (an item without "=" is ignored).
func lvParseKV(s string) (map[string]string, []string) {
	m := map[string]string{}
	var order []string
	for _, item := range strings.Split(s, ",") {
		item = strings.TrimSpace(item)
		k, v, ok := strings.Cut(item, "=")
		if !ok || k == "" {
			continue
		}
		if _, dup := m[k]; !dup {
			order = append(order, k)
		}
		m[k] = v
	}
	return m, order
}
