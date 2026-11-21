package broker

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"rackoon/internal/agent"
	"rackoon/internal/proto"
	"rackoon/internal/wire"
)

func TestDecodePPMAndThumbnail(t *testing.T) {
	var buf bytes.Buffer
	w, h := 1280, 800
	fmt.Fprintf(&buf, "P6\n# QEMU screendump\n%d %d\n255\n", w, h)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			buf.Write([]byte{byte(x), byte(y), 200})
		}
	}
	img, err := DecodeImage(buf.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if b := img.Bounds(); b.Dx() != w || b.Dy() != h {
		t.Fatalf("bounds %v", b)
	}
	r, g, bl, _ := img.At(10, 20).RGBA()
	if r>>8 != 10 || g>>8 != 20 || bl>>8 != 200 {
		t.Fatalf("pixel %d %d %d", r>>8, g>>8, bl>>8)
	}
	data, tw, th, err := Thumbnail(buf.Bytes(), 320, "jpeg")
	if err != nil || tw != 320 || th != 200 || !bytes.HasPrefix(data, []byte{0xff, 0xd8}) {
		t.Fatalf("jpeg thumbnail %dx%d %v", tw, th, err)
	}
	data, tw, th, err = Thumbnail(buf.Bytes(), 0, "png")
	if err != nil || tw != w || th != h || !bytes.HasPrefix(data, []byte("\x89PNG")) {
		t.Fatalf("png %dx%d %v", tw, th, err)
	}
	// PNG input (libvirt / QEMU screendump format=png).
	src := image.NewRGBA(image.Rect(0, 0, 100, 50))
	src.Set(1, 1, color.RGBA{255, 0, 0, 255})
	var pb bytes.Buffer
	png.Encode(&pb, src)
	if _, tw, th, err = Thumbnail(pb.Bytes(), 320, "jpeg"); err != nil || tw != 100 || th != 50 {
		t.Fatalf("small png not upscaled: %dx%d %v", tw, th, err)
	}
	if _, err := DecodeImage([]byte("P5 1 1 255\n\x00")); err == nil {
		t.Fatal("P5 accepted")
	}
	if _, err := DecodePPM(strings.NewReader("P6\n99999 1\n255\n")); err == nil {
		t.Fatal("huge PPM accepted")
	}
	if _, err := DecodePPM(strings.NewReader("P6\n2 2\n255\nabc")); err == nil {
		t.Fatal("short PPM accepted")
	}
}

const libvirtXML = `<domain type='kvm' id='3'>
  <name>vm-a</name>
  <devices>
    <serial type='pty'><source path='/dev/pts/4'/><target type='isa-serial' port='0'/></serial>
    <console type='pty' tty='/dev/pts/4'><source path='/dev/pts/4'/><target type='serial' port='0'/></console>
    <graphics type='vnc' port='5901' autoport='yes' listen='127.0.0.1' passwd='abc'>
      <listen type='address' address='127.0.0.1'/>
    </graphics>
    <graphics type='spice' tlsPort='5902' autoport='yes' listen='127.0.0.1' defaultMode='secure'>
      <listen type='address' address='127.0.0.1'/>
    </graphics>
  </devices>
</domain>`

func TestLibvirtDisplay(t *testing.T) {
	d := LibvirtDisplay(libvirtXML, true)
	c := Caps(proto.PlatformLibvirt, d)
	if strings.Join(c.Protocols, ",") != "vnc,serial" || c.Default != "vnc" {
		t.Fatalf("caps %+v", c)
	}
	if !strings.Contains(c.Unavailable["spice"], "TLS") {
		t.Fatalf("spice should be unavailable with a TLS reason: %+v", c.Unavailable)
	}
	x, _ := parseDomainXML(libvirtXML)
	ep, reason := x.Devices.Graphics[0].endpoint()
	if ep == nil || ep.port != 5901 || ep.host != "127.0.0.1" || ep.password != "abc" {
		t.Fatalf("vnc endpoint %+v %s", ep, reason)
	}
	if x.serialDevice().ptyPath() != "/dev/pts/4" {
		t.Fatal("serial pty path")
	}

	sock := `<domain><devices><graphics type='spice'><listen type='socket' socket='/run/libvirt/qemu/x/spice.sock'/></graphics></devices></domain>`
	if c := Caps(proto.PlatformLibvirt, LibvirtDisplay(sock, true)); strings.Join(c.Protocols, ",") != "spice" {
		t.Fatalf("socket spice: %+v", c)
	}
	public := `<domain><devices><graphics type='vnc' port='5900' listen='192.0.2.10'/></devices></domain>`
	if c := Caps(proto.PlatformLibvirt, LibvirtDisplay(public, true)); len(c.Protocols) != 0 || c.Unavailable["vnc"] == "" {
		t.Fatalf("non-loopback vnc: %+v", c)
	}
	anyAddr := `<domain><devices><graphics type='vnc' port='5900' listen='0.0.0.0'/></devices></domain>`
	if c := Caps(proto.PlatformLibvirt, LibvirtDisplay(anyAddr, true)); strings.Join(c.Protocols, ",") != "vnc" {
		t.Fatalf("0.0.0.0 vnc reachable over loopback: %+v", c)
	}
	stopped := `<domain><devices><graphics type='vnc' port='-1' autoport='yes' listen='127.0.0.1'/><serial type='pty'><target port='0'/></serial></devices></domain>`
	if c := Caps(proto.PlatformLibvirt, LibvirtDisplay(stopped, false)); strings.Join(c.Protocols, ",") != "vnc,serial" {
		t.Fatalf("stopped domain: %+v", c)
	}
}

func TestPVEDisplay(t *testing.T) {
	conf := parsePVEConf(strings.NewReader("name: deb\nvga: qxl,memory=32\nserial0: socket\n\n[snap1]\nvga: std\n"))
	c := Caps(proto.PlatformPVE, PVEDisplay("vm", conf, true))
	if strings.Join(c.Protocols, ",") != "vnc,spice,serial" || c.Default != "vnc" {
		t.Fatalf("qxl: %+v", c)
	}
	c = Caps(proto.PlatformPVE, PVEDisplay("vm", map[string]string{"vga": "serial0", "serial0": "socket"}, true))
	if strings.Join(c.Protocols, ",") != "serial" || c.Unavailable["vnc"] == "" {
		t.Fatalf("serial display: %+v", c)
	}
	c = Caps(proto.PlatformPVE, PVEDisplay("vm", map[string]string{}, true))
	if strings.Join(c.Protocols, ",") != "vnc" {
		t.Fatalf("default std vga: %+v", c)
	}
	// Collectors that do not use PVEDisplay keep the old behavior.
	c = Caps(proto.PlatformPVE, GuestDisplay{Kind: "vm"})
	if strings.Join(c.Protocols, ",") != "vnc" {
		t.Fatalf("legacy: %+v", c)
	}
	c = Caps(proto.PlatformPVE, PVEDisplay("container", nil, true))
	if strings.Join(c.Protocols, ",") != "shell,tty" {
		t.Fatalf("lxc: %+v", c)
	}
	if c := Caps(proto.PlatformDocker, GuestDisplay{Kind: "container"}); strings.Join(c.Protocols, ",") != "shell,logs" || c.Default != "shell" {
		t.Fatalf("docker: %+v", c)
	}
	if c := Caps(proto.PlatformIncus, GuestDisplay{Kind: "vm"}); c.Default != "spice" {
		t.Fatalf("incus vm %+v", c)
	}
}

func TestLXCCommands(t *testing.T) {
	if got := strings.Join(lxcConsoleCommand("200", ""), " "); got != "lxc-console -n 200 -e -1" {
		t.Fatal(got)
	}
	if got := strings.Join(lxcConsoleCommand("200", "console"), " "); got != "lxc-console -n 200 -t 0 -e -1" {
		t.Fatal(got)
	}
	if got := lxcShellCommand("200"); got[0] != "lxc-attach" || got[2] != "200" {
		t.Fatal(got)
	}
	g := &proto.Guest{ID: "100; rm -rf /", Kind: "vm"}
	if _, err := pveVMID(g); err == nil {
		t.Fatal("bad vmid accepted")
	}
}

// fakeDriver records calls.
type fakeDriver struct {
	st     string
	calls  []string
	states []string // successive states returned after power()
}

func (d *fakeDriver) state(ctx context.Context, g *proto.Guest) (string, error) {
	if len(d.states) > 0 {
		s := d.states[0]
		d.states = d.states[1:]
		d.st = s
	}
	return d.st, nil
}
func (d *fakeDriver) power(ctx context.Context, g *proto.Guest, action string) error {
	d.calls = append(d.calls, action)
	return nil
}
func (d *fakeDriver) screenshot(ctx context.Context, g *proto.Guest) ([]byte, error) {
	img := image.NewRGBA(image.Rect(0, 0, 640, 400))
	var b bytes.Buffer
	png.Encode(&b, img)
	return b.Bytes(), nil
}
func (d *fakeDriver) console(ctx context.Context, g *proto.Guest, req proto.ConsoleRequest) (agent.ConsoleSession, string, error) {
	d.calls = append(d.calls, "console:"+req.Protocol)
	return &termSession{protocol: req.Protocol, rw: nopRWC{}}, "", nil
}
func (d *fakeDriver) list(ctx context.Context) ([]proto.Guest, error) { return nil, nil }

type nopRWC struct{}

func (nopRWC) Read([]byte) (int, error)    { select {} }
func (nopRWC) Write(p []byte) (int, error) { return len(p), nil }
func (nopRWC) Close() error                { return nil }

func testBroker(inv *proto.Report, d driver) *Broker {
	b := NewBroker(&agent.Config{}, func() *proto.Report { return inv }, nil)
	b.drivers[proto.PlatformIncus] = d
	return b
}

func TestBrokerValidation(t *testing.T) {
	inv := &proto.Report{Incus: &proto.Platform{Guests: []proto.Guest{
		{ID: "web", Kind: "container", State: "running", Console: proto.ConsoleCaps{Protocols: []string{"shell", "tty"}}},
		{ID: "vm1", Kind: "vm", State: "running", Console: proto.ConsoleCaps{Protocols: []string{"serial"}, Unavailable: map[string]string{"spice": "nope"}}},
	}}}
	d := &fakeDriver{st: "running"}
	b := testBroker(inv, d)
	ctx := context.Background()

	if _, r := NewBroker(nil, func() *proto.Report { return nil }, nil).Console(ctx, proto.ConsoleRequest{Platform: "incus", GuestID: "web", Protocol: "shell"}); r.Code != CodeInventory {
		t.Fatalf("no inventory: %+v", r)
	}
	for _, tc := range []struct {
		req  proto.ConsoleRequest
		code string
	}{
		{proto.ConsoleRequest{Platform: "incus", GuestID: "other", Protocol: "shell"}, CodeUnknownGuest},
		{proto.ConsoleRequest{Platform: "docker", GuestID: "web", Protocol: "shell"}, CodeUnknownGuest},
		{proto.ConsoleRequest{Platform: "host", GuestID: "host", Protocol: "vnc"}, CodeUnsupportedProtocol},
		{proto.ConsoleRequest{Platform: "host", GuestID: "web", Protocol: "shell"}, CodeInvalid},
		{proto.ConsoleRequest{Platform: "incus", GuestID: "web", Protocol: "vnc"}, CodeUnsupportedProtocol},
		{proto.ConsoleRequest{Platform: "incus", GuestID: "vm1", Protocol: "spice"}, CodeProtocolUnavailable},
		{proto.ConsoleRequest{Platform: "incus", GuestID: "/var/run/x.sock", Protocol: "shell"}, CodeUnknownGuest},
	} {
		if _, r := b.Console(ctx, tc.req); r.OK || r.Code != tc.code {
			t.Errorf("%+v: got %+v, want %s", tc.req, r, tc.code)
		}
	}
	if len(d.calls) != 0 {
		t.Fatalf("driver called for invalid requests: %v", d.calls)
	}
	s, r := b.Console(ctx, proto.ConsoleRequest{Platform: "incus", GuestID: "web", Protocol: "shell"})
	if !r.OK || s == nil {
		t.Fatalf("valid console: %+v", r)
	}
	d.st = "stopped"
	if _, r := b.Console(ctx, proto.ConsoleRequest{Platform: "incus", GuestID: "web", Protocol: "tty"}); r.Code != CodeGuestNotRunning {
		t.Fatalf("stopped guest: %+v", r)
	}
	th := b.Thumbnail(ctx, proto.ThumbnailRequest{Platform: "incus", GuestID: "web"})
	if th.Code != CodeNoScreen {
		t.Fatalf("container thumbnail: %+v", th)
	}
	d.st = "running"
	th = b.Thumbnail(ctx, proto.ThumbnailRequest{Platform: "incus", GuestID: "vm1", MaxWidth: 320, Format: "jpeg"})
	if th.Code != "" || th.Width != 320 || th.Height != 200 {
		t.Fatalf("vm thumbnail: %+v", th)
	}
	_ = wire.Frame{}
}

func TestBrokerActions(t *testing.T) {
	inv := &proto.Report{Incus: &proto.Platform{Guests: []proto.Guest{
		{ID: "web", Kind: "container"}, {ID: "vm1", Kind: "vm"},
	}}}
	ctx := context.Background()

	d := &fakeDriver{st: "running"}
	b := testBroker(inv, d)
	if r := b.Action(ctx, proto.ActionRequest{Platform: "incus", GuestID: "vm1", Action: "start"}); !r.OK || !r.Noop {
		t.Fatalf("start running vm: %+v", r)
	}
	d.states = []string{"running", "running", "stopped"}
	if r := b.Action(ctx, proto.ActionRequest{Platform: "incus", GuestID: "vm1", Action: "shutdown"}); !r.OK || r.State != "stopped" {
		t.Fatalf("shutdown: %+v", r)
	}
	if strings.Join(d.calls, ",") != "shutdown" {
		t.Fatalf("calls %v", d.calls)
	}
	// Container "shutdown" maps to stop, VM "restart" to reboot.
	d.calls, d.st, d.states = nil, "running", []string{"running", "stopped"}
	b.Action(ctx, proto.ActionRequest{Platform: "incus", GuestID: "web", Action: "shutdown"})
	d.states = []string{"running", "running"}
	b.Action(ctx, proto.ActionRequest{Platform: "incus", GuestID: "vm1", Action: "restart"})
	if strings.Join(d.calls, ",") != "stop,reboot" {
		t.Fatalf("mapped calls %v", d.calls)
	}
	d.st, d.states = "stopped", nil
	if r := b.Action(ctx, proto.ActionRequest{Platform: "incus", GuestID: "vm1", Action: "reboot"}); r.Code != CodeGuestNotRunning {
		t.Fatalf("reboot stopped vm: %+v", r)
	}
	if r := b.Action(ctx, proto.ActionRequest{Platform: "incus", GuestID: "web", Action: "ctrl_alt_del"}); r.Code != CodeUnsupportedAction {
		t.Fatalf("ctrl_alt_del on container: %+v", r)
	}
	if r := b.Action(ctx, proto.ActionRequest{Platform: "incus", GuestID: "vm1", Action: "rm -rf"}); r.Code != CodeUnsupportedAction {
		t.Fatalf("bogus action: %+v", r)
	}
}

func TestPVEFastState(t *testing.T) {
	dir := t.TempDir()
	d := &pveDriver{confDir: dir + "/conf", runDir: dir + "/run"}
	for _, sub := range []string{"conf/qemu-server", "conf/lxc", "run"} {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	os.WriteFile(filepath.Join(dir, "conf/qemu-server/90001.conf"), []byte("vga: std\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "conf/lxc/90002.conf"), []byte("hostname: c\n"), 0o644)
	vm := &proto.Guest{ID: "90001", Kind: "vm"}
	ct := &proto.Guest{ID: "90002", Kind: "container"}
	if st, ok := d.fastState(vm, "90001"); !ok || st != proto.StateStopped {
		t.Fatalf("vm without pid file: %s %v", st, ok)
	}
	pidFile := filepath.Join(d.runDir, "90001.pid")
	cmd := exec.Command("/bin/sh", "-c", "sleep 30", "-pidfile", pidFile)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer cmd.Process.Kill()
	// Until the child has exec'd, its cmdline is still this test binary's.
	for i := 0; i < 200; i++ {
		if b, _ := os.ReadFile("/proc/" + strconv.Itoa(cmd.Process.Pid) + "/cmdline"); strings.Contains(string(b), "-pidfile") {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	os.WriteFile(pidFile, []byte(strconv.Itoa(cmd.Process.Pid)+"\n"), 0o644)
	if st, ok := d.fastState(vm, "90001"); !ok || st != proto.StateRunning {
		t.Fatalf("vm with live pid: %s %v", st, ok)
	}
	os.WriteFile(pidFile, []byte(strconv.Itoa(os.Getpid())+"\n"), 0o644) // a process without -pidfile
	if st, _ := d.fastState(vm, "90001"); st != proto.StateStopped {
		t.Fatalf("pid reused by another process: %s", st)
	}
	if st, ok := d.fastState(ct, "90002"); !ok || st != proto.StateStopped {
		t.Fatalf("stopped container: %s %v", st, ok)
	}
	ln, err := net.Listen("unix", "@/var/lib/lxc/90002/command")
	if err != nil {
		t.Skip("abstract sockets unavailable:", err)
	}
	defer ln.Close()
	if st, ok := d.fastState(ct, "90002"); !ok || st != proto.StateRunning {
		t.Fatalf("running container: %s %v", st, ok)
	}
	if _, ok := d.fastState(&proto.Guest{ID: "90003", Kind: "vm"}, "90003"); ok {
		t.Fatal("guest without config must fall back")
	}
}
