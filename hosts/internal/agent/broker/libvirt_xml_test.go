package broker

import (
	"encoding/xml"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"
)

func readBrokerTestdata(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// TestXMLTreeRoundTrip: BlackBox's real domain (unRAID 7.3.1) reads and
// writes back unchanged, unknown elements, namespaces and comments too.
func TestXMLTreeRoundTrip(t *testing.T) {
	for _, name := range []string{"libvirt_pbs_unraid_inactive.xml", "libvirt_pbs_unraid_live.xml", "libvirt_domcaps_q35.xml"} {
		src := strings.TrimSpace(readBrokerTestdata(t, name))
		x, err := parseXMLTree(src)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		out := x.String()
		// Same document for an XML reader (quotes and self-closing tags may
		// be written differently).
		if !sameXML(t, src, out) {
			t.Errorf("%s: round trip changed the document:\n%s", name, out)
		}
		y, _ := parseXMLTree(out)
		if y.String() != out {
			t.Errorf("%s: second round trip differs", name)
		}
	}
	doc := `<domain type='kvm'><!-- keep me --><metadata><libosinfo:libosinfo xmlns:libosinfo="http://libosinfo.org/xmlns/libvirt/domain/1.0"><libosinfo:os id="http://microsoft.com/win/11"/></libosinfo:libosinfo></metadata><description>a &amp; b &lt;c&gt;</description><qemu:commandline xmlns:qemu='http://libvirt.org/schemas/domain/qemu/1.0'><qemu:arg value='-x'/></qemu:commandline></domain>`
	x, err := parseXMLTree(doc)
	if err != nil {
		t.Fatal(err)
	}
	out := x.String()
	for _, want := range []string{"<!-- keep me -->", "<libosinfo:os id='http://microsoft.com/win/11'/>", "xmlns:libosinfo='http://libosinfo.org/xmlns/libvirt/domain/1.0'",
		"<description>a &amp; b &lt;c&gt;</description>", "<qemu:arg value='-x'/>", "xmlns:qemu="} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in %s", want, out)
		}
	}
	if _, err := parseXMLTree("<a><b></a>"); err == nil {
		t.Error("broken XML read")
	}
}

// sameXML compares two documents token by token (attribute order kept).
func sameXML(t *testing.T, a, b string) bool {
	t.Helper()
	toks := func(s string) []string {
		d := xml.NewDecoder(strings.NewReader(s))
		var out []string
		for {
			tok, err := d.RawToken()
			if err != nil {
				return out
			}
			switch v := tok.(type) {
			case xml.StartElement:
				e := "<" + rawName(v.Name)
				for _, at := range v.Attr {
					e += " " + rawName(at.Name) + "=" + at.Value
				}
				out = append(out, e)
			case xml.EndElement:
				out = append(out, "</"+rawName(v.Name))
			case xml.CharData:
				if strings.TrimSpace(string(v)) != "" {
					out = append(out, "#"+string(v))
				}
			case xml.Comment:
				out = append(out, "!"+string(v))
			}
		}
	}
	return reflect.DeepEqual(toks(a), toks(b))
}

func TestLvDomValues(t *testing.T) {
	d, err := parseLvDom(readBrokerTestdata(t, "libvirt_pbs_unraid_inactive.xml"))
	if err != nil {
		t.Fatal(err)
	}
	v := d.scalarValues()
	want := map[string]string{"name": "pbs", "vcpus": "4", "vcpus_max": "4", "memory_mb": "8192", "memory_max_mb": "8192",
		"boot": "hd", "cpu_mode": "host-passthrough", "on_poweroff": "destroy", "on_reboot": "restart", "on_crash": "restart",
		"machine": "pc-q35-9.2", "firmware": "bios", "secure_boot": "0", "tpm": "0", "video": "qxl", "graphics0": "type=vnc,listen=0.0.0.0"}
	for k, w := range want {
		if v[k] != w {
			t.Errorf("%s = %q, want %q", k, v[k], w)
		}
	}
	disks := d.diskNodes("disk")
	if len(disks) != 3 {
		t.Fatalf("disks = %d", len(disks))
	}
	vda := readLvDisk(disks[0])
	if vda.source() != "/mnt/data/PBS-Backup/pbs/pbs-os.qcow2" || vda.format != "qcow2" || vda.bus != "virtio" || vda.cache != "writeback" ||
		vda.discard != "unmap" || !vda.editable() {
		t.Errorf("vda = %+v", vda)
	}
	if got := vda.value(32 << 30); got != "source=/mnt/data/PBS-Backup/pbs/pbs-os.qcow2,bus=virtio,format=qcow2,target=vda,size=34359738368,cache=writeback,discard=unmap" {
		t.Errorf("vda value = %s", got)
	}
	if vdc := readLvDisk(disks[2]); !vdc.readonly || vdc.format != "raw" {
		t.Errorf("vdc = %+v", vdc)
	}
	nic := readLvNIC(d.nicNodes()[0])
	if nic.editable() || nic.value() != "model=virtio-net,direct=vhost0,mac=52:54:00:12:34:56,link=up" {
		t.Errorf("nic = %+v %s", nic, nic.value())
	}
	if d.windows() || d.nextTarget("virtio") != "vdd" || d.nextTarget("sata") != "sda" {
		t.Errorf("windows %v, next %s %s", d.windows(), d.nextTarget("virtio"), d.nextTarget("sata"))
	}
	// Edits keep what Whombat does not know.
	c := d.clone()
	c.setCPUMode("custom:EPYC-v4")
	c.setMem("memory", 16384)
	c.setBootOrder([]string{"cdrom", "hd"})
	c.setTopText("title", "Backup server", "uuid", "name")
	out := c.String()
	for _, want := range []string{"<cpu mode='custom' check='none' match='exact'><model fallback='allow'>EPYC-v4</model></cpu>",
		"<memory unit='KiB'>16777216</memory>", "<boot dev='cdrom'/><boot dev='hd'/>", "<title>Backup server</title>",
		"<vmtemplate xmlns='http://unraid'", "<memballoon model='virtio'>", "<watchdog model='itco' action='reset'/>"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q", want)
		}
	}
	if strings.Contains(out, "migratable") {
		t.Error("a custom CPU keeps migratable")
	}
	if d.String() == out {
		t.Error("the clone changed the original")
	}
}

func TestLvBootOrderPerDevice(t *testing.T) {
	d, err := parseLvDom(`<domain><name>x</name><os><type>hvm</type></os><devices>
<disk type='file' device='disk'><target dev='vda' bus='virtio'/><boot order='2'/></disk>
<disk type='file' device='cdrom'><target dev='sda' bus='sata'/><boot order='1'/></disk>
<interface type='network'><source network='default'/><boot order='3'/></interface></devices></domain>`)
	if err != nil {
		t.Fatal(err)
	}
	if b := d.bootOrder(); b != "cdrom,hd,network" {
		t.Fatalf("boot = %s", b)
	}
	d.setBootOrder([]string{"hd", "network"})
	if b := d.bootOrder(); b != "hd,network" || d.x.child("os").child("boot") != nil {
		t.Errorf("boot = %s, os boot %v", b, d.x.child("os").child("boot"))
	}
}

func TestLvParseSize(t *testing.T) {
	for in, want := range map[string]uint64{"32G": 32 << 30, "32GiB": 32 << 30, "500M": 500 << 20, "1T": 1 << 40, "+8G": 8 << 30,
		"1.5G": 3 << 29, "1073741824": 1 << 30, "10GB": 10 << 30} {
		n, _, ok := lvParseSize(in)
		if !ok || n != want {
			t.Errorf("parseSize(%q) = %d %v, want %d", in, n, ok, want)
		}
	}
	for _, bad := range []string{"", "x", "-1G", "0", "100P"} {
		if _, _, ok := lvParseSize(bad); ok {
			t.Errorf("parseSize(%q) accepted", bad)
		}
	}
	if _, grow, _ := lvParseSize("+1G"); !grow {
		t.Error("+ not seen")
	}
}

func TestLvVMDirAndNames(t *testing.T) {
	for in, want := range map[string]string{"pbs": "pbs", "Windows 11": "Windows_11", "../etc": "vm_._etc", "a/b": "a_b", "": "vm", "_x": "vm_x"} {
		if got := lvVMDir(in); got != want {
			t.Errorf("lvVMDir(%q) = %q, want %q", in, got, want)
		}
	}
	for _, ok := range []string{"pbs", "win11-test", "a.b_c", strings.Repeat("a", 64)} {
		if !lvNameRE.MatchString(ok) {
			t.Errorf("%q refused", ok)
		}
	}
	for _, bad := range []string{"", "-x", "a b", "a/b", strings.Repeat("a", 65), "Windows 11"} {
		if lvNameRE.MatchString(bad) {
			t.Errorf("%q accepted", bad)
		}
	}
	u := lvNewUUID()
	if len(u) != 36 || u[14] != '4' || !strings.ContainsRune("89ab", rune(u[19])) {
		t.Errorf("uuid %s", u)
	}
}

func TestLvHostFirmwareAndFolders(t *testing.T) {
	h := &lvHost{domcaps: readBrokerTestdata(t, "libvirt_domcaps_q35.xml")}
	fw := h.firmware(lvOSFS{})
	if !fw.UEFI || !fw.SecureBoot || !fw.TPM {
		t.Errorf("firmware = %+v", fw)
	}
	if m := h.cpuModels(); strings.Join(m, ",") != "qemu64,qemu64-v1" {
		t.Errorf("cpu models = %v", m)
	}
	if h.maxVCPUs() != 512 {
		t.Errorf("max vcpus = %d", h.maxVCPUs())
	}
	bios := &lvHost{domcaps: `<domainCapabilities><os supported='yes'><loader supported='yes'/></os></domainCapabilities>`}
	if fw := bios.firmware(fakeFS{}); fw.UEFI || fw.TPM {
		t.Errorf("bios host firmware = %+v", fw)
	}
	f := readFolders(fakeFS{files: map[string]string{lvDomainCfg: readBrokerTestdata(t, "unraid_domain.cfg")}})
	if f == nil || f.Domains != "/mnt/user/domains" || f.ISOs != "/mnt/user/isos" {
		t.Errorf("folders = %+v", f)
	}
	if readFolders(fakeFS{}) != nil {
		t.Error("folders without domain.cfg")
	}
	if got := defaultBackupsDir("", nil, f); got != "/mnt/user/domains/.whombat-backups" {
		t.Errorf("unRAID backups dir = %s", got)
	}
	pools := []lvPool{{name: "big", typ: "dir", path: "/srv/vm", active: true}, {name: "default", typ: "dir", path: "/var/lib/libvirt/images", active: true}}
	if got := defaultBackupsDir("", pools, nil); got != "/var/lib/libvirt/images/.whombat-backups" {
		t.Errorf("backups dir = %s", got)
	}
	if got := defaultBackupsDir("/backup/vms/", pools, nil); got != "/backup/vms" {
		t.Errorf("configured backups dir = %s", got)
	}
	if !lvWithin("/srv/vm/a.qcow2", []string{"/srv/vm"}) || lvWithin("/srv/vm/../etc/x", []string{"/srv/vm"}) || lvWithin("/srv/vmx/a", []string{"/srv/vm"}) {
		t.Error("lvWithin")
	}
}

// fakeFS is a tiny LibvirtFS for internal tests.
type fakeFS struct{ files map[string]string }

func (f fakeFS) ReadFile(p string) ([]byte, error) {
	if s, ok := f.files[p]; ok {
		return []byte(s), nil
	}
	return nil, os.ErrNotExist
}
func (f fakeFS) ReadDir(string) ([]LibvirtDirEntry, error) { return nil, os.ErrNotExist }
func (f fakeFS) Stat(string) (LibvirtFileInfo, error)      { return LibvirtFileInfo{}, os.ErrNotExist }
func (f fakeFS) Statfs(string) (uint64, uint64, error)     { return 0, 0, os.ErrNotExist }
func (f fakeFS) Exists(p string) bool                      { _, ok := f.files[p]; return ok }

func TestLvSnapshotProblem(t *testing.T) {
	if msg := lvSnapshotProblem(readBrokerTestdata(t, "libvirt_pbs_unraid_inactive.xml")); msg != "Snapshots need every disk in qcow2 format, and disk vdb is raw. Back the VM up instead." {
		t.Errorf("pbs: %q", msg)
	}
	ok := `<domain><name>x</name><devices><disk type='file' device='disk'><driver type='qcow2'/><source file='/a.qcow2'/><target dev='vda'/></disk>
<disk type='file' device='cdrom'><driver type='raw'/><source file='/x.iso'/><target dev='sda'/><readonly/></disk></devices></domain>`
	if msg := lvSnapshotProblem(ok); msg != "" {
		t.Errorf("qcow2: %q", msg)
	}
	if msg := lvSnapshotError(errors.New("Operation not supported: internal snapshots of a VM with pflash based firmware are not supported")); !strings.Contains(msg, "UEFI") {
		t.Errorf("pflash: %q", msg)
	}
}
