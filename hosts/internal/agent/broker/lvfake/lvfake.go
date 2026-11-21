// Package lvfake is an in-memory libvirt for the libvirt manager's tests
// and the simulator: domains with their inactive and live XML, directory
// storage pools whose volumes are files of an in-memory file system,
// networks with DHCP leases, backup jobs that progress with the clock. It
// implements broker.LibvirtConn and broker.LibvirtFS (structurally; it
// does not import the broker).
package lvfake

import (
	"bytes"
	"encoding/binary"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"path"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	libvirt "github.com/digitalocean/go-libvirt"

	"rackoon/internal/agent/broker"
)

// Fake is the in-memory libvirt. Its zero value is not usable: use New.
type Fake struct {
	mu    sync.Mutex
	doms  map[string]*dom
	pools map[string]*pool
	nets  map[string]*network
	files map[string]*file // path -> file
	dirs  map[string]bool  // directories

	// LibVersion, QEMUVersion: what ConnectGetLibVersion / GetVersion say.
	LibVersion, QEMUVersion uint64
	// DomCaps: the domain capabilities document.
	DomCaps string
	// BackupTime: how long a backup job runs.
	BackupTime time.Duration
	// Calls records the changing calls ("DomainUpdateDeviceFlags live <disk …>").
	Calls []string
	// Total, Avail: every file system's size.
	Total, Avail uint64
}

type dom struct {
	name, uuid string
	inactive   string
	live       string // running: the live XML
	state      libvirt.DomainState
	autostart  bool
	snapshots  int
	job        *job
	completed  *job
}

type job struct {
	started   time.Time
	dur       time.Duration
	total     uint64
	files     map[string]uint64 // target file -> used bytes when done
	cancelled bool
	failed    string
}

type pool struct {
	name, uuid, typ, path        string
	active, autostart, transient bool
}

type network struct {
	name, xml         string
	active, autostart bool
	leases            []libvirt.NetworkDhcpLease
}

type file struct {
	data     []byte // small files (XML, JSON, logs, uploads)
	capacity uint64 // disk images: virtual size
	used     uint64 // space it takes
	format   string // raw | qcow2
	mod      time.Time
	blob     bool // a disk image: data is not kept
}

func (f *file) size() int64 {
	if !f.blob {
		return int64(len(f.data))
	}
	if f.format == "qcow2" {
		return int64(f.used) + 196608
	}
	return int64(f.capacity)
}

var _ broker.LibvirtConn = (*Fake)(nil)
var _ broker.LibvirtFS = (*Fake)(nil)

// DefaultDomCaps is a q35 host with UEFI (Secure Boot), a TPM emulator
// and a few CPU models.
const DefaultDomCaps = `<domainCapabilities><path>/usr/bin/qemu-system-x86_64</path><domain>kvm</domain>
<machine>pc-q35-10.0</machine><arch>x86_64</arch><vcpu max='255'/>
<os supported='yes'><enum name='firmware'><value>efi</value></enum><loader supported='yes'>
<value>/usr/share/OVMF/OVMF_CODE_4M.secboot.fd</value><value>/usr/share/OVMF/OVMF_CODE_4M.fd</value>
<enum name='type'><value>rom</value><value>pflash</value></enum><enum name='secure'><value>yes</value><value>no</value></enum></loader></os>
<cpu><mode name='host-passthrough' supported='yes'/><mode name='maximum' supported='yes'/><mode name='host-model' supported='yes'/>
<mode name='custom' supported='yes'><model usable='yes'>EPYC-v4</model><model usable='yes'>Skylake-Server</model><model usable='no'>Icelake-Server</model><model usable='yes'>qemu64</model></mode></cpu>
<devices><tpm supported='yes'><enum name='model'><value>tpm-crb</value></enum><enum name='backendModel'><value>emulator</value></enum></tpm></devices>
</domainCapabilities>`

// New returns a host with the pool "default" (/var/lib/libvirt/images),
// the network "default" (virbr0, NAT, DHCP) and a host bridge br0.
func New() *Fake {
	f := &Fake{doms: map[string]*dom{}, pools: map[string]*pool{}, nets: map[string]*network{}, files: map[string]*file{},
		dirs: map[string]bool{"/": true}, LibVersion: 11003000, QEMUVersion: 10000013, DomCaps: DefaultDomCaps,
		BackupTime: 50 * time.Millisecond, Total: 2 << 40, Avail: 1 << 40}
	f.AddPool("default", "/var/lib/libvirt/images")
	f.AddNetwork("default", "virbr0", "192.168.122.1", true)
	f.AddBridge("br0")
	f.mkdirAll("/sys/class/net/eth0")
	return f
}

// ---- setup ---------------------------------------------------------------------

func (f *Fake) mkdirAll(p string) {
	for p != "/" && p != "." && p != "" {
		f.dirs[p] = true
		p = path.Dir(p)
	}
}

// AddPool adds an active directory pool (its folder too).
func (f *Fake) AddPool(name, dir string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.mkdirAll(dir)
	f.pools[name] = &pool{name: name, uuid: fakeUUID(name), typ: "dir", path: dir, active: true, autostart: true}
}

// AddNetwork adds a network with its bridge.
func (f *Fake) AddNetwork(name, bridge, ip string, dhcp bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	d := ""
	if dhcp {
		d = "<dhcp><range start='" + strings.TrimSuffix(ip, ".1") + ".2' end='" + strings.TrimSuffix(ip, ".1") + ".254'/></dhcp>"
	}
	f.nets[name] = &network{name: name, active: true, autostart: true, xml: fmt.Sprintf(`<network><name>%s</name><forward mode='nat'/><bridge name='%s' stp='on' delay='0'/><ip address='%s' netmask='255.255.255.0'>%s</ip></network>`,
		name, bridge, ip, d)}
	f.mkdirAll("/sys/class/net/" + bridge + "/bridge")
}

// AddBridge adds a host bridge.
func (f *Fake) AddBridge(name string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.mkdirAll("/sys/class/net/" + name + "/bridge")
}

// AddLease adds a DHCP lease to a network.
func (f *Fake) AddLease(netName, mac, ip, host string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := f.nets[netName]
	n.leases = append(n.leases, libvirt.NetworkDhcpLease{Iface: "virbr0", Expirytime: time.Now().Add(time.Hour).Unix(),
		Mac: libvirt.OptString{mac}, Ipaddr: ip, Prefix: 24, Hostname: libvirt.OptString{host}})
}

// AddFile adds a small file.
func (f *Fake) AddFile(p string, data []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.mkdirAll(path.Dir(p))
	f.files[p] = &file{data: append([]byte(nil), data...), used: uint64(len(data)), mod: time.Now()}
}

// AddDisk adds a disk image.
func (f *Fake) AddDisk(p, format string, capacity, used uint64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.mkdirAll(path.Dir(p))
	f.files[p] = &file{blob: true, capacity: capacity, used: used, format: format, mod: time.Now()}
}

// AddDomain defines a domain (running: started too).
func (f *Fake) AddDomain(x string, running bool) error {
	d, err := f.DomainDefineXMLFlags(x, 0)
	if err != nil {
		return err
	}
	if running {
		return f.DomainCreate(d)
	}
	return nil
}

// SetSnapshots sets a domain's snapshot count.
func (f *Fake) SetSnapshots(name string, n int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if d := f.doms[name]; d != nil {
		d.snapshots = n
	}
}

// File reports a file: its virtual size and format (disk images) or its
// content.
func (f *Fake) File(p string) (data []byte, capacity uint64, format string, ok bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	fl, ok := f.files[p]
	if !ok {
		return nil, 0, "", false
	}
	return append([]byte(nil), fl.data...), fl.capacity, fl.format, true
}

// Paths lists every file under a folder.
func (f *Fake) Paths(prefix string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for p := range f.files {
		if strings.HasPrefix(p, prefix) {
			out = append(out, p)
		}
	}
	sort.Strings(out)
	return out
}

// DomainInfo is what the simulator reports of a domain.
type DomainInfo struct {
	Name      string
	Running   bool
	Autostart bool
	XML       string // the XML in effect
	Snapshots int
}

// Domains lists the domains.
func (f *Fake) Domains() []DomainInfo {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []DomainInfo
	for _, d := range f.doms {
		x := d.inactive
		if d.live != "" {
			x = d.live
		}
		out = append(out, DomainInfo{Name: d.name, Running: d.state == libvirt.DomainRunning, Autostart: d.autostart, XML: x, Snapshots: d.snapshots})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func (f *Fake) record(format string, a ...any) { f.Calls = append(f.Calls, fmt.Sprintf(format, a...)) }

func fakeUUID(s string) string {
	h := fmt.Sprintf("%032x", []byte(s+"0123456789abcdef"))[:32]
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

// ---- errors ----------------------------------------------------------------------

func errNoDomain(name string) error {
	return fmt.Errorf("Domain not found: no domain with matching name '%s'", name)
}

// ---- connect ---------------------------------------------------------------------

func (f *Fake) Disconnect() error                     { return nil }
func (f *Fake) ConnectGetLibVersion() (uint64, error) { return f.LibVersion, nil }
func (f *Fake) ConnectGetVersion() (uint64, error)    { return f.QEMUVersion, nil }
func (f *Fake) ConnectGetDomainCapabilities(libvirt.OptString, libvirt.OptString, libvirt.OptString, libvirt.OptString, libvirt.ConnectGetDomainCapabilitiesFlags) (string, error) {
	return f.DomCaps, nil
}

// ---- domains ---------------------------------------------------------------------

type domHead struct {
	XMLName xml.Name `xml:"domain"`
	Name    string   `xml:"name"`
	UUID    string   `xml:"uuid"`
}

func (f *Fake) ref(d *dom) libvirt.Domain {
	r := libvirt.Domain{Name: d.name, ID: -1}
	copy(r.UUID[:], strings.ReplaceAll(d.uuid, "-", ""))
	if d.state == libvirt.DomainRunning {
		r.ID = 1
	}
	return r
}

func (f *Fake) ConnectListAllDomains(int32, libvirt.ConnectListAllDomainsFlags) ([]libvirt.Domain, uint32, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []libvirt.Domain
	for _, d := range f.doms {
		out = append(out, f.ref(d))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, uint32(len(out)), nil
}

func (f *Fake) DomainLookupByName(name string) (libvirt.Domain, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	d := f.doms[name]
	if d == nil {
		return libvirt.Domain{}, errNoDomain(name)
	}
	return f.ref(d), nil
}

func (f *Fake) get(r libvirt.Domain) (*dom, error) {
	d := f.doms[r.Name]
	if d == nil {
		return nil, errNoDomain(r.Name)
	}
	return d, nil
}

func (f *Fake) DomainGetXMLDesc(r libvirt.Domain, flags libvirt.DomainXMLFlags) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	d, err := f.get(r)
	if err != nil {
		return "", err
	}
	if d.live != "" && flags&libvirt.DomainXMLInactive == 0 {
		return d.live, nil
	}
	return d.inactive, nil
}

func (f *Fake) DomainGetState(r libvirt.Domain, _ uint32) (int32, int32, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	d, err := f.get(r)
	if err != nil {
		return 0, 0, err
	}
	return int32(d.state), 1, nil
}

func (f *Fake) DomainDefineXMLFlags(x string, _ libvirt.DomainDefineFlags) (libvirt.Domain, error) {
	var h domHead
	if err := xml.Unmarshal([]byte(x), &h); err != nil {
		return libvirt.Domain{}, fmt.Errorf("XML error: %w", err)
	}
	if h.Name == "" {
		return libvirt.Domain{}, errors.New("XML error: missing domain name")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if h.UUID == "" {
		h.UUID = fakeUUID(h.Name + time.Now().String())
		x = strings.Replace(x, "</name>", "</name><uuid>"+h.UUID+"</uuid>", 1)
	}
	for _, d := range f.doms {
		if d.uuid == h.UUID && d.name != h.Name {
			return libvirt.Domain{}, fmt.Errorf("operation failed: domain '%s' already exists with uuid %s", d.name, d.uuid)
		}
		if d.name == h.Name && d.uuid != h.UUID {
			return libvirt.Domain{}, fmt.Errorf("operation failed: domain '%s' already exists with uuid %s", d.name, d.uuid)
		}
	}
	// libvirt gives new network cards a MAC address.
	x = addMACs(x, h.UUID)
	d := f.doms[h.Name]
	if d == nil {
		d = &dom{name: h.Name, uuid: h.UUID, state: libvirt.DomainShutoff}
		f.doms[h.Name] = d
	}
	d.inactive = x
	f.record("DomainDefineXMLFlags %s", h.Name)
	return f.ref(d), nil
}

// addMACs gives every <interface> without a <mac> one.
func addMACs(x, seed string) string {
	var b strings.Builder
	n := 0
	for {
		i := strings.Index(x, "<interface")
		if i < 0 {
			b.WriteString(x)
			break
		}
		end := strings.Index(x[i:], "</interface>")
		if end < 0 {
			b.WriteString(x)
			break
		}
		block := x[i : i+end]
		b.WriteString(x[:i])
		if !strings.Contains(block, "<mac ") {
			gt := strings.Index(block, ">")
			mac := fmt.Sprintf("52:54:00:%02x:%02x:%02x", len(seed)%256, int(seed[0])%256, (n*37+int(seed[len(seed)-1]))%256)
			block = block[:gt+1] + "<mac address='" + mac + "'/>" + block[gt+1:]
		}
		b.WriteString(block)
		x = x[i+end:]
		n++
	}
	return b.String()
}

func (f *Fake) DomainUndefineFlags(r libvirt.Domain, flags libvirt.DomainUndefineFlagsValues) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	d, err := f.get(r)
	if err != nil {
		return err
	}
	if d.state == libvirt.DomainRunning {
		return errors.New("Requested operation is not valid: cannot undefine a running domain in this fake")
	}
	if nv := between(d.inactive, "<nvram", "</nvram>"); nv != "" && !strings.HasSuffix(between(nv, "<nvram", ">"), "/") {
		p := strings.TrimSpace(nv[strings.Index(nv, ">")+1:])
		switch {
		case flags&libvirt.DomainUndefineNvram != 0:
			delete(f.files, p)
		case flags&libvirt.DomainUndefineKeepNvram == 0:
			return errors.New("Requested operation is not valid: cannot undefine domain with nvram")
		}
	}
	delete(f.doms, d.name)
	f.record("DomainUndefineFlags %s %d", d.name, flags)
	return nil
}

func between(s, a, b string) string {
	i := strings.Index(s, a)
	if i < 0 {
		return ""
	}
	j := strings.Index(s[i:], b)
	if j < 0 {
		return ""
	}
	return s[i : i+j]
}

func (f *Fake) DomainCreate(r libvirt.Domain) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	d, err := f.get(r)
	if err != nil {
		return err
	}
	if d.state == libvirt.DomainRunning {
		return errors.New("Requested operation is not valid: domain is already running")
	}
	d.state, d.live = libvirt.DomainRunning, d.inactive
	f.record("DomainCreate %s", d.name)
	return nil
}

// SetRunning starts or stops a domain (the simulator's power actions).
func (f *Fake) SetRunning(name string, on bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	d := f.doms[name]
	if d == nil {
		return errNoDomain(name)
	}
	if on {
		d.state, d.live = libvirt.DomainRunning, d.inactive
	} else {
		d.state, d.live = libvirt.DomainShutoff, ""
	}
	return nil
}

func (f *Fake) DomainRename(r libvirt.Domain, name libvirt.OptString, _ uint32) (int32, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	d, err := f.get(r)
	if err != nil {
		return 0, err
	}
	if d.state == libvirt.DomainRunning {
		return 0, errors.New("Requested operation is not valid: cannot rename active domain")
	}
	if d.snapshots > 0 {
		return 0, errors.New("Requested operation is not valid: cannot rename domain with snapshots")
	}
	nn := name[0]
	if f.doms[nn] != nil {
		return 0, fmt.Errorf("operation failed: domain with name '%s' already exists", nn)
	}
	delete(f.doms, d.name)
	d.inactive = strings.Replace(d.inactive, "<name>"+d.name+"</name>", "<name>"+nn+"</name>", 1)
	d.name = nn
	f.doms[nn] = d
	f.record("DomainRename %s", nn)
	return 0, nil
}

// attrIn reads attribute name='v' out of a fragment.
func attrIn(s, name string) string {
	for _, q := range []string{"'", `"`} {
		if i := strings.Index(s, " "+name+"="+q); i >= 0 {
			r := s[i+len(name)+3:]
			if j := strings.Index(r, q); j >= 0 {
				return r[:j]
			}
		}
	}
	return ""
}

// elemBlocks splits out every <tag …>…</tag> (or <tag …/>) of x with its
// offsets.
func elemBlocks(x, tag string) [][2]int {
	var out [][2]int
	for off := 0; ; {
		i := strings.Index(x[off:], "<"+tag+" ")
		if i < 0 {
			return out
		}
		i += off
		gt := strings.Index(x[i:], ">")
		if gt < 0 {
			return out
		}
		end := i + gt + 1
		if x[i+gt-1] != '/' {
			j := strings.Index(x[i:], "</"+tag+">")
			if j < 0 {
				return out
			}
			end = i + j + len(tag) + 3
		}
		out = append(out, [2]int{i, end})
		off = end
	}
}

// replaceDevice swaps the live device with the same target (disk) or MAC
// (interface).
func replaceDevice(x, dev string) (string, bool) {
	tag, key := "disk", attrIn(between(dev, "<target", ">"), "dev")
	if strings.HasPrefix(dev, "<interface") {
		tag, key = "interface", attrIn(between(dev, "<mac", ">"), "address")
	}
	if key == "" {
		return x, false
	}
	for _, b := range elemBlocks(x, tag) {
		block := x[b[0]:b[1]]
		k := attrIn(between(block, "<target", ">"), "dev")
		if tag == "interface" {
			k = attrIn(between(block, "<mac", ">"), "address")
		}
		if k == key {
			return x[:b[0]] + dev + x[b[1]:], true
		}
	}
	return x, false
}

func (f *Fake) DomainUpdateDeviceFlags(r libvirt.Domain, dev string, flags libvirt.DomainDeviceModifyFlags) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	d, err := f.get(r)
	if err != nil {
		return err
	}
	f.record("DomainUpdateDeviceFlags %d %s", flags, dev)
	if flags&libvirt.DomainDeviceModifyLive != 0 {
		if d.live == "" {
			return errors.New("Requested operation is not valid: domain is not running")
		}
		nx, ok := replaceDevice(d.live, dev)
		if !ok {
			return errors.New("device not found in the live configuration")
		}
		d.live = nx
	}
	return nil
}

func setElem(x, name, value string) string {
	i := strings.Index(x, "<"+name)
	if i < 0 {
		return x
	}
	j := strings.Index(x[i:], "</"+name+">")
	if j < 0 {
		return x
	}
	gt := strings.Index(x[i:], ">")
	return x[:i+gt+1] + value + x[i+j:]
}

func (f *Fake) DomainSetMemoryFlags(r libvirt.Domain, kib uint64, flags uint32) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	d, err := f.get(r)
	if err != nil {
		return err
	}
	f.record("DomainSetMemoryFlags %d %d", kib, flags)
	if d.live == "" {
		return errors.New("Requested operation is not valid: domain is not running")
	}
	d.live = setElem(d.live, "currentMemory", strconv.FormatUint(kib, 10))
	return nil
}

func (f *Fake) DomainSetVcpusFlags(r libvirt.Domain, n uint32, flags uint32) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	d, err := f.get(r)
	if err != nil {
		return err
	}
	f.record("DomainSetVcpusFlags %d %d", n, flags)
	if d.live == "" {
		return errors.New("Requested operation is not valid: domain is not running")
	}
	i := strings.Index(d.live, "<vcpu")
	if i < 0 {
		return errors.New("no vcpu element")
	}
	j := strings.Index(d.live[i:], "</vcpu>")
	block := d.live[i : i+j]
	maxv := block[strings.Index(block, ">")+1:]
	d.live = d.live[:i] + fmt.Sprintf("<vcpu placement='static' current='%d'>%s", n, maxv) + d.live[i+j:]
	return nil
}

func (f *Fake) DomainGetAutostart(r libvirt.Domain) (int32, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	d, err := f.get(r)
	if err != nil {
		return 0, err
	}
	if d.autostart {
		return 1, nil
	}
	return 0, nil
}

func (f *Fake) DomainSetAutostart(r libvirt.Domain, on int32) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	d, err := f.get(r)
	if err != nil {
		return err
	}
	d.autostart = on == 1
	f.record("DomainSetAutostart %s %d", d.name, on)
	return nil
}

func (f *Fake) DomainSetMetadata(r libvirt.Domain, typ int32, md libvirt.OptString, _ libvirt.OptString, _ libvirt.OptString, flags libvirt.DomainModificationImpact) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	d, err := f.get(r)
	if err != nil {
		return err
	}
	v := ""
	if len(md) > 0 {
		v = md[0]
	}
	f.record("DomainSetMetadata %d %q %d", typ, v, flags)
	if d.live == "" {
		return errors.New("Requested operation is not valid: domain is not running")
	}
	name := map[int32]string{0: "description", 1: "title"}[typ]
	if strings.Contains(d.live, "<"+name+">") {
		d.live = setElem(d.live, name, v)
	} else {
		d.live = strings.Replace(d.live, "</uuid>", "</uuid><"+name+">"+v+"</"+name+">", 1)
	}
	return nil
}

func (f *Fake) DomainBlockResize(r libvirt.Domain, disk string, size uint64, _ libvirt.DomainBlockResizeFlags) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	d, err := f.get(r)
	if err != nil {
		return err
	}
	if d.live == "" {
		return errors.New("Requested operation is not valid: domain is not running")
	}
	p := diskPath(d.live, disk)
	fl := f.files[p]
	if fl == nil {
		return fmt.Errorf("invalid argument: disk '%s' was not found in the domain config", disk)
	}
	fl.capacity = size
	f.record("DomainBlockResize %s %d", disk, size)
	return nil
}

// diskPath finds the source file of a disk target in a domain XML.
func diskPath(x, target string) string {
	for _, b := range elemBlocks(x, "disk") {
		block := x[b[0]:b[1]]
		if attrIn(between(block, "<target", ">"), "dev") == target {
			return attrIn(between(block, "<source", ">"), "file")
		}
	}
	return ""
}

func (f *Fake) DomainSnapshotNum(r libvirt.Domain, _ uint32) (int32, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	d, err := f.get(r)
	if err != nil {
		return 0, err
	}
	return int32(d.snapshots), nil
}

// ---- backup jobs -----------------------------------------------------------------

type backupDoc struct {
	Disks []struct {
		Name   string `xml:"name,attr"`
		Backup string `xml:"backup,attr"`
		Target struct {
			File string `xml:"file,attr"`
		} `xml:"target"`
	} `xml:"disks>disk"`
}

func (f *Fake) DomainBackupBegin(r libvirt.Domain, bx string, _ libvirt.OptString, _ libvirt.DomainBackupBeginFlags) error {
	var b backupDoc
	if err := xml.Unmarshal([]byte(bx), &b); err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	d, err := f.get(r)
	if err != nil {
		return err
	}
	if d.state != libvirt.DomainRunning {
		return errors.New("Requested operation is not valid: domain is not running")
	}
	if d.job != nil {
		return errors.New("Timed out during operation: cannot acquire state change lock (held by another job)")
	}
	j := &job{started: time.Now(), dur: f.BackupTime, files: map[string]uint64{}}
	for _, dk := range b.Disks {
		if dk.Backup != "yes" {
			continue
		}
		if !f.dirs[path.Dir(dk.Target.File)] {
			return fmt.Errorf("cannot create %s: No such file or directory", dk.Target.File)
		}
		if _, ok := f.files[dk.Target.File]; ok {
			return fmt.Errorf("target file %s exists", dk.Target.File)
		}
		src := f.files[diskPath(d.live, dk.Name)]
		if src == nil {
			return fmt.Errorf("disk %s has no source", dk.Name)
		}
		j.files[dk.Target.File] = src.used
		j.total += src.used
		f.files[dk.Target.File] = &file{blob: true, capacity: src.capacity, format: "qcow2", mod: time.Now()}
	}
	d.job, d.completed = j, nil
	f.record("DomainBackupBegin %s", d.name)
	return nil
}

func u64(field string, v uint64) libvirt.TypedParam {
	return libvirt.TypedParam{Field: field, Value: libvirt.TypedParamValue{D: 4, I: v}}
}

// settle ends a job whose time is up.
func (f *Fake) settle(d *dom) {
	j := d.job
	if j == nil || !j.cancelled && time.Since(j.started) < j.dur {
		return
	}
	for p, used := range j.files {
		if j.cancelled {
			delete(f.files, p)
		} else if fl := f.files[p]; fl != nil {
			fl.used = used
		}
	}
	d.job, d.completed = nil, j
}

func (f *Fake) DomainGetJobStats(r libvirt.Domain, flags libvirt.DomainGetJobStatsFlags) (int32, []libvirt.TypedParam, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	d, err := f.get(r)
	if err != nil {
		return 0, nil, err
	}
	f.settle(d)
	if flags&libvirt.DomainJobStatsCompleted != 0 {
		j := d.completed
		if j == nil {
			return 0, nil, nil
		}
		typ := int32(3)
		switch {
		case j.cancelled:
			typ = 5
		case j.failed != "":
			return 4, []libvirt.TypedParam{{Field: "errmsg", Value: libvirt.TypedParamValue{D: 7, I: j.failed}}}, nil
		}
		return typ, []libvirt.TypedParam{u64("data_total", j.total), u64("data_processed", j.total)}, nil
	}
	if d.job == nil {
		return 0, nil, nil
	}
	frac := float64(time.Since(d.job.started)) / float64(d.job.dur)
	return 1, []libvirt.TypedParam{u64("operation", 9), u64("data_total", d.job.total), u64("data_processed", uint64(frac*float64(d.job.total)))}, nil
}

func (f *Fake) DomainAbortJob(r libvirt.Domain) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	d, err := f.get(r)
	if err != nil {
		return err
	}
	if d.job == nil {
		return errors.New("Requested operation is not valid: no job is active on the domain")
	}
	d.job.cancelled = true
	f.record("DomainAbortJob %s", d.name)
	return nil
}

// ---- pools and volumes -----------------------------------------------------------

func (f *Fake) poolRef(p *pool) libvirt.StoragePool {
	r := libvirt.StoragePool{Name: p.name}
	copy(r.UUID[:], p.uuid)
	return r
}

func (f *Fake) ConnectListAllStoragePools(int32, libvirt.ConnectListAllStoragePoolsFlags) ([]libvirt.StoragePool, uint32, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []libvirt.StoragePool
	for _, p := range f.pools {
		out = append(out, f.poolRef(p))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, uint32(len(out)), nil
}

func (f *Fake) StoragePoolLookupByName(name string) (libvirt.StoragePool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	p := f.pools[name]
	if p == nil {
		return libvirt.StoragePool{}, fmt.Errorf("Storage pool not found: no storage pool with matching name '%s'", name)
	}
	return f.poolRef(p), nil
}

func (f *Fake) getPool(r libvirt.StoragePool) (*pool, error) {
	p := f.pools[r.Name]
	if p == nil {
		return nil, fmt.Errorf("Storage pool not found: no storage pool with matching name '%s'", r.Name)
	}
	return p, nil
}

func (f *Fake) StoragePoolGetXMLDesc(r libvirt.StoragePool, _ libvirt.StorageXMLFlags) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	p, err := f.getPool(r)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("<pool type='%s'><name>%s</name><uuid>%s</uuid><target><path>%s</path></target></pool>", p.typ, p.name, p.uuid, p.path), nil
}

func (f *Fake) StoragePoolGetInfo(r libvirt.StoragePool) (uint8, uint64, uint64, uint64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	p, err := f.getPool(r)
	if err != nil {
		return 0, 0, 0, 0, err
	}
	var used uint64
	for fp, fl := range f.files {
		if strings.HasPrefix(fp, p.path+"/") {
			used += fl.used
		}
	}
	return 2, f.Total, f.Total - f.Avail + used, f.Avail - min(used, f.Avail), nil
}

func (f *Fake) StoragePoolGetAutostart(r libvirt.StoragePool) (int32, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	p, err := f.getPool(r)
	if err != nil || !p.autostart {
		return 0, err
	}
	return 1, nil
}

func (f *Fake) StoragePoolIsActive(r libvirt.StoragePool) (int32, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	p, err := f.getPool(r)
	if err != nil || !p.active {
		return 0, err
	}
	return 1, nil
}

func (f *Fake) StoragePoolRefresh(libvirt.StoragePool, uint32) error { return nil }

func (f *Fake) volRef(p *pool, name string) libvirt.StorageVol {
	return libvirt.StorageVol{Pool: p.name, Name: name, Key: path.Join(p.path, name)}
}

func (f *Fake) StoragePoolListAllVolumes(r libvirt.StoragePool, _ int32, _ uint32) ([]libvirt.StorageVol, uint32, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	p, err := f.getPool(r)
	if err != nil {
		return nil, 0, err
	}
	var out []libvirt.StorageVol
	for _, name := range f.children(p.path) {
		out = append(out, f.volRef(p, name))
	}
	return out, uint32(len(out)), nil
}

// children lists a folder's entries (files and folders).
func (f *Fake) children(dir string) []string {
	seen := map[string]bool{}
	for fp := range f.files {
		if path.Dir(fp) == dir {
			seen[path.Base(fp)] = true
		}
	}
	for d := range f.dirs {
		if d != dir && path.Dir(d) == dir {
			seen[path.Base(d)] = true
		}
	}
	out := make([]string, 0, len(seen))
	for n := range seen {
		out = append(out, n)
	}
	sort.Strings(out)
	return out
}

type poolDoc struct {
	Type string `xml:"type,attr"`
	Name string `xml:"name"`
	Path string `xml:"target>path"`
}

func (f *Fake) StoragePoolCreateXML(x string, flags libvirt.StoragePoolCreateFlags) (libvirt.StoragePool, error) {
	var d poolDoc
	if err := xml.Unmarshal([]byte(x), &d); err != nil {
		return libvirt.StoragePool{}, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, p := range f.pools {
		if p.active && p.path == d.Path {
			return libvirt.StoragePool{}, fmt.Errorf("operation failed: Storage source conflict with pool: '%s'", p.name)
		}
	}
	if f.pools[d.Name] != nil {
		return libvirt.StoragePool{}, fmt.Errorf("operation failed: pool '%s' already exists", d.Name)
	}
	if flags&libvirt.StoragePoolCreateWithBuild != 0 {
		f.mkdirAll(d.Path)
	} else if !f.dirs[d.Path] {
		return libvirt.StoragePool{}, fmt.Errorf("cannot open directory '%s': No such file or directory", d.Path)
	}
	p := &pool{name: d.Name, uuid: fakeUUID(d.Name), typ: d.Type, path: d.Path, active: true, transient: true}
	f.pools[d.Name] = p
	f.record("StoragePoolCreateXML %s", d.Path)
	return f.poolRef(p), nil
}

func (f *Fake) StoragePoolDestroy(r libvirt.StoragePool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	p, err := f.getPool(r)
	if err != nil {
		return err
	}
	if p.transient {
		delete(f.pools, p.name)
	} else {
		p.active = false
	}
	return nil
}

// TransientPools counts the transient pools (the manager must remove its
// own).
func (f *Fake) TransientPools() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, p := range f.pools {
		if p.transient {
			n++
		}
	}
	return n
}

func (f *Fake) StorageVolLookupByName(r libvirt.StoragePool, name string) (libvirt.StorageVol, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	p, err := f.getPool(r)
	if err != nil {
		return libvirt.StorageVol{}, err
	}
	fp := path.Join(p.path, name)
	if f.files[fp] == nil && !f.dirs[fp] {
		return libvirt.StorageVol{}, fmt.Errorf("Storage volume not found: no storage vol with matching name '%s'", name)
	}
	return f.volRef(p, name), nil
}

func (f *Fake) StorageVolLookupByPath(p string) (libvirt.StorageVol, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.files[p] != nil {
		for _, pl := range f.pools {
			if pl.active && pl.path == path.Dir(p) {
				return f.volRef(pl, path.Base(p)), nil
			}
		}
	}
	return libvirt.StorageVol{}, fmt.Errorf("Storage volume not found: no storage vol with matching path '%s'", p)
}

func (f *Fake) StorageVolGetInfo(v libvirt.StorageVol) (int8, uint64, uint64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.dirs[v.Key] {
		return 2, 0, 0, nil
	}
	fl := f.files[v.Key]
	if fl == nil {
		return 0, 0, 0, fmt.Errorf("Storage volume not found: %s", v.Key)
	}
	c := fl.capacity
	if !fl.blob {
		c = uint64(len(fl.data))
	}
	return 0, c, fl.used, nil
}

func (f *Fake) StorageVolGetPath(v libvirt.StorageVol) (string, error) { return v.Key, nil }

func (f *Fake) StorageVolGetXMLDesc(v libvirt.StorageVol, _ uint32) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	fl := f.files[v.Key]
	if fl == nil {
		return "", fmt.Errorf("Storage volume not found: %s", v.Key)
	}
	format := fl.format
	if format == "" {
		format = "raw"
	}
	return fmt.Sprintf("<volume type='file'><name>%s</name><capacity unit='bytes'>%d</capacity><target><path>%s</path><format type='%s'/></target></volume>",
		v.Name, fl.capacity, v.Key, format), nil
}

type volDoc struct {
	Name     string `xml:"name"`
	Capacity uint64 `xml:"capacity"`
	Format   struct {
		Type string `xml:"type,attr"`
	} `xml:"target>format"`
}

func (f *Fake) StorageVolCreateXML(r libvirt.StoragePool, x string, _ libvirt.StorageVolCreateFlags) (libvirt.StorageVol, error) {
	var d volDoc
	if err := xml.Unmarshal([]byte(x), &d); err != nil {
		return libvirt.StorageVol{}, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	p, err := f.getPool(r)
	if err != nil {
		return libvirt.StorageVol{}, err
	}
	fp := path.Join(p.path, d.Name)
	if f.files[fp] != nil {
		return libvirt.StorageVol{}, fmt.Errorf("storage volume '%s' already exists", d.Name)
	}
	used := uint64(0)
	if d.Format.Type == "qcow2" {
		used = 196608
	}
	f.files[fp] = &file{blob: true, capacity: d.Capacity, used: used, format: d.Format.Type, mod: time.Now()}
	f.record("StorageVolCreateXML %s", fp)
	return f.volRef(p, d.Name), nil
}

func (f *Fake) StorageVolCreateXMLFrom(r libvirt.StoragePool, x string, src libvirt.StorageVol, _ libvirt.StorageVolCreateFlags) (libvirt.StorageVol, error) {
	var d volDoc
	if err := xml.Unmarshal([]byte(x), &d); err != nil {
		return libvirt.StorageVol{}, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	p, err := f.getPool(r)
	if err != nil {
		return libvirt.StorageVol{}, err
	}
	s := f.files[src.Key]
	if s == nil {
		return libvirt.StorageVol{}, fmt.Errorf("Storage volume not found: %s", src.Key)
	}
	fp := path.Join(p.path, d.Name)
	if f.files[fp] != nil {
		return libvirt.StorageVol{}, fmt.Errorf("storage volume '%s' already exists", d.Name)
	}
	nf := *s
	nf.data = append([]byte(nil), s.data...)
	nf.format, nf.mod = d.Format.Type, time.Now()
	if d.Capacity > nf.capacity {
		nf.capacity = d.Capacity
	}
	f.files[fp] = &nf
	f.record("StorageVolCreateXMLFrom %s %s", src.Key, fp)
	return f.volRef(p, d.Name), nil
}

func (f *Fake) StorageVolDelete(v libvirt.StorageVol, _ libvirt.StorageVolDeleteFlags) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.dirs[v.Key] {
		if len(f.children(v.Key)) > 0 {
			return fmt.Errorf("cannot remove directory '%s': Directory not empty", v.Key)
		}
		delete(f.dirs, v.Key)
		f.record("StorageVolDelete %s", v.Key)
		return nil
	}
	if f.files[v.Key] == nil {
		return fmt.Errorf("Storage volume not found: %s", v.Key)
	}
	delete(f.files, v.Key)
	f.record("StorageVolDelete %s", v.Key)
	return nil
}

func (f *Fake) StorageVolResize(v libvirt.StorageVol, capacity uint64, _ libvirt.StorageVolResizeFlags) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	fl := f.files[v.Key]
	if fl == nil {
		return fmt.Errorf("Storage volume not found: %s", v.Key)
	}
	if capacity < fl.capacity {
		return errors.New("invalid argument: can't shrink capacity below existing capacity unless shrink flag explicitly specified")
	}
	fl.capacity = capacity
	f.record("StorageVolResize %s %d", v.Key, capacity)
	return nil
}

func (f *Fake) StorageVolUpload(v libvirt.StorageVol, r io.Reader, _ uint64, length uint64, _ libvirt.StorageVolUploadFlags) error {
	var b []byte
	var err error
	if length > 0 {
		b, err = io.ReadAll(io.LimitReader(r, int64(length)))
	} else {
		b, err = io.ReadAll(r)
	}
	if err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	fl := f.files[v.Key]
	if fl == nil {
		return fmt.Errorf("Storage volume not found: %s", v.Key)
	}
	fl.blob, fl.data, fl.used, fl.capacity, fl.mod = false, b, uint64(len(b)), uint64(len(b)), time.Now()
	f.record("StorageVolUpload %s %d", v.Key, len(b))
	return nil
}

// ---- networks ------------------------------------------------------------------

func (f *Fake) netRef(n *network) libvirt.Network {
	r := libvirt.Network{Name: n.name}
	copy(r.UUID[:], fakeUUID(n.name))
	return r
}

func (f *Fake) ConnectListAllNetworks(int32, libvirt.ConnectListAllNetworksFlags) ([]libvirt.Network, uint32, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []libvirt.Network
	for _, n := range f.nets {
		out = append(out, f.netRef(n))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, uint32(len(out)), nil
}

func (f *Fake) NetworkLookupByName(name string) (libvirt.Network, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := f.nets[name]
	if n == nil {
		return libvirt.Network{}, fmt.Errorf("Network not found: no network with matching name '%s'", name)
	}
	return f.netRef(n), nil
}

func (f *Fake) NetworkGetXMLDesc(r libvirt.Network, _ uint32) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if n := f.nets[r.Name]; n != nil {
		return n.xml, nil
	}
	return "", errors.New("Network not found")
}

func (f *Fake) NetworkGetAutostart(r libvirt.Network) (int32, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if n := f.nets[r.Name]; n != nil && n.autostart {
		return 1, nil
	}
	return 0, nil
}

func (f *Fake) NetworkIsActive(r libvirt.Network) (int32, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if n := f.nets[r.Name]; n != nil && n.active {
		return 1, nil
	}
	return 0, nil
}

func (f *Fake) NetworkGetDhcpLeases(r libvirt.Network, _ libvirt.OptString, _ int32, _ uint32) ([]libvirt.NetworkDhcpLease, uint32, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := f.nets[r.Name]
	if n == nil {
		return nil, 0, errors.New("Network not found")
	}
	return append([]libvirt.NetworkDhcpLease(nil), n.leases...), uint32(len(n.leases)), nil
}

// ---- the file system -----------------------------------------------------------

func (f *Fake) ReadFile(p string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	fl := f.files[p]
	if fl == nil {
		return nil, &fs.PathError{Op: "open", Path: p, Err: fs.ErrNotExist}
	}
	if fl.blob {
		return nil, fmt.Errorf("%s is a disk image", p)
	}
	return append([]byte(nil), fl.data...), nil
}

func (f *Fake) ReadDir(p string) ([]broker.LibvirtDirEntry, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.dirs[p] {
		return nil, &fs.PathError{Op: "open", Path: p, Err: fs.ErrNotExist}
	}
	var out []broker.LibvirtDirEntry
	for _, n := range f.children(p) {
		out = append(out, broker.LibvirtDirEntry{Name: n, Dir: f.dirs[path.Join(p, n)]})
	}
	return out, nil
}

func (f *Fake) Stat(p string) (broker.LibvirtFileInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.dirs[p] {
		return broker.LibvirtFileInfo{Dir: true}, nil
	}
	fl := f.files[p]
	if fl == nil {
		return broker.LibvirtFileInfo{}, &fs.PathError{Op: "stat", Path: p, Err: fs.ErrNotExist}
	}
	return broker.LibvirtFileInfo{Size: fl.size(), UsedBytes: fl.used, ModTime: fl.mod.Unix()}, nil
}

func (f *Fake) Statfs(string) (uint64, uint64, error) { return f.Total, f.Avail, nil }

func (f *Fake) Exists(p string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.dirs[p] || f.files[p] != nil
}

// Head returns a file's first bytes; a qcow2 image a qcow2 header with its
// virtual size.
func (f *Fake) Head(p string, n int) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	fl := f.files[p]
	if fl == nil {
		return nil, fs.ErrNotExist
	}
	if !fl.blob {
		return fl.data[:min(n, len(fl.data))], nil
	}
	h := make([]byte, 32)
	if fl.format == "qcow2" {
		copy(h, []byte{'Q', 'F', 'I', 0xfb, 0, 0, 0, 3})
		binary.BigEndian.PutUint64(h[24:], fl.capacity)
	}
	return h[:min(n, 32)], nil
}

// Tail is ReadFile's last max bytes.
func (f *Fake) Tail(p string, max int64) ([]byte, error) {
	b, err := f.ReadFile(p)
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > max {
		b = b[int64(len(b))-max:]
		if i := bytes.IndexByte(b, '\n'); i >= 0 {
			b = b[i+1:]
		}
	}
	return b, nil
}
