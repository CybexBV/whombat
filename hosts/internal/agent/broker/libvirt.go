package broker

import (
	"bufio"
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	libvirt "github.com/digitalocean/go-libvirt"
	"github.com/digitalocean/go-libvirt/socket/dialers"

	"rackoon/internal/agent"
	"rackoon/internal/proto"
)

// libvirtDriver talks to libvirtd (qemu:///system) over its Unix socket
// with the pure-Go RPC client:
//
//	VNC:     graphics endpoint from the live domain XML (Unix socket, or a
//	         loopback port whose listener is verified to belong to the
//	         domain's QEMU process); the agent completes the RFB auth with the
//	         password from the secure XML and the browser sees None
//	SPICE:   same endpoint rules, plain (no TLS); the ticket is injected by
//	         the agent in each channel's link phase
//	serial:  the PTY of the domain's serial/console device (or its Unix
//	         socket); the go-libvirt console stream is receive-only
//	actions: create, shutdown (ACPI), reboot, destroy, send-key, suspend /
//	         resume (pause), snapshot create / revert / delete (internal
//	         snapshots: a running domain's snapshot includes its RAM)
//	screen:  virDomainScreenshot (PPM)
type libvirtDriver struct {
	socket string        // "" = auto
	cfg    *agent.Config // [libvirt] backups_dir (manage)
}

var libvirtSockets = []string{"/var/run/libvirt/libvirt-sock", "/run/libvirt/libvirt-sock", "/var/run/libvirt/virtqemud-sock", "/run/libvirt/virtqemud-sock"}

func (d *libvirtDriver) connect() (*libvirt.Libvirt, error) {
	paths := libvirtSockets
	if d.socket != "" {
		paths = []string{d.socket}
	}
	var lastErr error
	for _, p := range paths {
		if _, err := os.Stat(p); err != nil {
			lastErr = err
			continue
		}
		l := libvirt.NewWithDialer(dialers.NewLocal(dialers.WithSocket(p), dialers.WithLocalTimeout(5*time.Second)))
		if err := l.ConnectToURI(libvirt.QEMUSystem); err != nil {
			lastErr = err
			continue
		}
		return l, nil
	}
	if lastErr == nil {
		lastErr = errors.New("no libvirt socket")
	}
	return nil, codeErr(CodePlatformError, "cannot reach libvirt: "+lastErr.Error())
}

func (d *libvirtDriver) domain(l *libvirt.Libvirt, name string) (libvirt.Domain, error) {
	dom, err := l.DomainLookupByName(name)
	if err != nil {
		return dom, codeErr(CodeUnknownGuest, "libvirt domain not found")
	}
	return dom, nil
}

func normLibvirtState(s int32) string {
	switch libvirt.DomainState(s) {
	case libvirt.DomainRunning, libvirt.DomainBlocked:
		return proto.StateRunning
	case libvirt.DomainShutoff, libvirt.DomainCrashed:
		return proto.StateStopped
	case libvirt.DomainPaused, libvirt.DomainPmsuspended:
		return proto.StatePaused
	case libvirt.DomainShutdown:
		return "shutting_down"
	}
	return "unknown"
}

func (d *libvirtDriver) state(ctx context.Context, g *proto.Guest) (string, error) {
	l, err := d.connect()
	if err != nil {
		return "", err
	}
	defer l.Disconnect()
	// go-libvirt calls take no context: closing the connection when ctx
	// ends makes a call blocked on a hung libvirtd return.
	defer context.AfterFunc(ctx, func() { _ = l.Disconnect() })()
	dom, err := d.domain(l, g.ID)
	if err != nil {
		return "", err
	}
	st, _, err := l.DomainGetState(dom, 0)
	if err != nil {
		return "", codeErr(CodePlatformError, err.Error())
	}
	return normLibvirtState(st), nil
}

// Linux input key codes for Ctrl+Alt+Del.
const (
	keyLeftCtrl = 29
	keyLeftAlt  = 56
	keyDelete   = 111
)

func (d *libvirtDriver) power(ctx context.Context, g *proto.Guest, action string) error {
	l, err := d.connect()
	if err != nil {
		return err
	}
	defer l.Disconnect()
	// go-libvirt calls take no context: closing the connection when ctx
	// ends makes a call blocked on a hung libvirtd return.
	defer context.AfterFunc(ctx, func() { _ = l.Disconnect() })()
	dom, err := d.domain(l, g.ID)
	if err != nil {
		return err
	}
	switch action {
	case proto.ActionStart:
		err = l.DomainCreate(dom)
	case proto.ActionShutdown:
		err = l.DomainShutdown(dom)
	case proto.ActionReboot:
		err = l.DomainReboot(dom, 0)
	case proto.ActionForceStop:
		err = l.DomainDestroy(dom)
	case proto.ActionCtrlAltDel:
		err = l.DomainSendKey(dom, uint32(libvirt.KeycodeSetLinux), 0, []uint32{keyLeftCtrl, keyLeftAlt, keyDelete}, 0)
	case proto.ActionPause:
		err = l.DomainSuspend(dom)
	case proto.ActionResume:
		// A guest suspended to RAM by its own power management wakes up
		// through a wakeup event, not by resuming the vCPUs.
		var st int32
		if st, _, err = l.DomainGetState(dom, 0); err == nil {
			if libvirt.DomainState(st) == libvirt.DomainPmsuspended {
				err = l.DomainPmWakeup(dom, 0)
			} else {
				err = l.DomainResume(dom)
			}
		}
	default:
		return codeErr(CodeUnsupportedAction, "unsupported action for a libvirt domain")
	}
	if err != nil {
		return codeErr(CodePlatformError, err.Error())
	}
	return nil
}

func (d *libvirtDriver) screenshot(ctx context.Context, g *proto.Guest) ([]byte, error) {
	l, err := d.connect()
	if err != nil {
		return nil, err
	}
	defer l.Disconnect()
	// go-libvirt calls take no context: closing the connection when ctx
	// ends makes a call blocked on a hung libvirtd return.
	defer context.AfterFunc(ctx, func() { _ = l.Disconnect() })()
	dom, err := d.domain(l, g.ID)
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	if _, err := l.DomainScreenshot(dom, &limitedWriter{w: &buf, n: 64 << 20}, 0, 0); err != nil {
		// go-libvirt decodes the MIME type from the stream's final packet
		// instead of the RPC reply, so a complete download ends with an XDR
		// decode error. The image format is detected from its magic bytes.
		if !(buf.Len() > 0 && strings.Contains(err.Error(), "xdr")) {
			return nil, codeErr(CodeCaptureFailed, "libvirt screenshot: "+err.Error())
		}
	}
	return buf.Bytes(), nil
}

type limitedWriter struct {
	w io.Writer
	n int
}

func (lw *limitedWriter) Write(p []byte) (int, error) {
	if len(p) > lw.n {
		return 0, errors.New("screenshot too large")
	}
	lw.n -= len(p)
	return lw.w.Write(p)
}

// ---- domain XML ----------------------------------------------------------------

type domainXML struct {
	Name    string `xml:"name"`
	Devices struct {
		Graphics []domGraphics `xml:"graphics"`
		Serials  []domChardev  `xml:"serial"`
		Consoles []domChardev  `xml:"console"`
	} `xml:"devices"`
}

type domGraphics struct {
	Type        string `xml:"type,attr"`
	Port        int    `xml:"port,attr"`
	TLSPort     int    `xml:"tlsPort,attr"`
	AutoPort    string `xml:"autoport,attr"`
	Listen      string `xml:"listen,attr"`
	Passwd      string `xml:"passwd,attr"`
	Socket      string `xml:"socket,attr"`
	DefaultMode string `xml:"defaultMode,attr"`
	Listens     []struct {
		Type    string `xml:"type,attr"`
		Address string `xml:"address,attr"`
		Socket  string `xml:"socket,attr"`
	} `xml:"listen"`
	Channels []struct {
		Name string `xml:"name,attr"`
		Mode string `xml:"mode,attr"`
	} `xml:"channel"`
}

type domChardev struct {
	Type   string `xml:"type,attr"`
	TTY    string `xml:"tty,attr"`
	Source []struct {
		Path string `xml:"path,attr"`
		Mode string `xml:"mode,attr"`
	} `xml:"source"`
	Target struct {
		Type string `xml:"type,attr"`
		Port *int   `xml:"port,attr"`
	} `xml:"target"`
}

// graphicsEndpoint is where the agent connects for a graphics device.
type graphicsEndpoint struct {
	unix     string // Unix socket path, or
	port     int    // loopback TCP port
	host     string // "127.0.0.1" or "::1"
	password string
}

func isLoopbackOrAny(addr string) (host string, ok bool) {
	switch addr {
	case "", "0.0.0.0", "127.0.0.1", "localhost":
		return "127.0.0.1", true
	case "::", "::1":
		return "::1", true
	}
	if ip := net.ParseIP(addr); ip != nil && ip.IsLoopback() {
		return ip.String(), true
	}
	return "", false
}

// endpoint resolves where a graphics device can be reached, or why not.
func (g *domGraphics) endpoint() (*graphicsEndpoint, string) {
	ep := &graphicsEndpoint{password: g.Passwd}
	sock := g.Socket
	addr := g.Listen
	for _, l := range g.Listens {
		switch l.Type {
		case "socket":
			if l.Socket != "" {
				sock = l.Socket
			}
		case "address":
			if l.Address != "" {
				addr = l.Address
			}
		case "none":
			return nil, "the display has no listener (listen type none)"
		}
	}
	if sock != "" {
		if !filepath.IsAbs(sock) {
			return nil, "invalid socket path in the domain XML"
		}
		ep.unix = sock
		return ep, ""
	}
	if g.Type == "spice" {
		if g.DefaultMode == "secure" || (g.Port <= 0 && g.TLSPort > 0) {
			return nil, "SPICE only listens with TLS for this VM; Whombat needs a plain loopback or Unix-socket listener"
		}
		for _, c := range g.Channels {
			if c.Mode == "secure" && (c.Name == "main" || c.Name == "display" || c.Name == "inputs") {
				return nil, "SPICE requires TLS for the " + c.Name + " channel on this VM"
			}
		}
	}
	host, ok := isLoopbackOrAny(addr)
	if !ok {
		return nil, fmt.Sprintf("%s listens on %s; Whombat connects only over loopback or a Unix socket", strings.ToUpper(g.Type), addr)
	}
	if g.Port <= 0 {
		return nil, "the display has no port (VM not running?)"
	}
	ep.host, ep.port = host, g.Port
	return ep, ""
}

func (s *domChardev) ptyPath() string {
	if s.Type == "pty" {
		for _, src := range s.Source {
			if src.Path != "" {
				return src.Path
			}
		}
		return s.TTY
	}
	return ""
}

func (s *domChardev) unixPath() string {
	if s.Type == "unix" {
		for _, src := range s.Source {
			if src.Mode == "bind" && filepath.IsAbs(src.Path) {
				return src.Path
			}
		}
	}
	return ""
}

func (x *domainXML) serialDevice() *domChardev {
	for i := range x.Devices.Serials {
		s := &x.Devices.Serials[i]
		if s.ptyPath() != "" || s.unixPath() != "" {
			return s
		}
	}
	for i := range x.Devices.Consoles {
		s := &x.Devices.Consoles[i]
		if s.Target.Type == "serial" && (s.ptyPath() != "" || s.unixPath() != "") {
			return s
		}
	}
	return nil
}

func parseDomainXML(s string) (*domainXML, error) {
	var x domainXML
	if err := xml.Unmarshal([]byte(s), &x); err != nil {
		return nil, err
	}
	return &x, nil
}

// LibvirtDisplay describes a libvirt domain's console devices from its
// domain XML (virsh dumpxml; the secure flag is not needed). Collectors pass
// the result to Caps.
func LibvirtDisplay(domainXMLText string, running bool) GuestDisplay {
	d := GuestDisplay{Kind: "vm", Running: running}
	x, err := parseDomainXML(domainXMLText)
	if err != nil {
		return d
	}
	seen := map[string]bool{}
	for i := range x.Devices.Graphics {
		g := &x.Devices.Graphics[i]
		var p string
		switch g.Type {
		case "vnc":
			p = proto.ProtoVNC
		case "spice":
			p = proto.ProtoSPICE
		default:
			continue
		}
		if seen[p] {
			continue
		}
		seen[p] = true
		d.Graphics = append(d.Graphics, p)
		// Only judge listeners of running domains: an inactive domain has no
		// port yet.
		if _, reason := g.endpoint(); reason != "" && (running || !strings.Contains(reason, "no port")) {
			if d.Unavailable == nil {
				d.Unavailable = map[string]string{}
			}
			d.Unavailable[p] = reason
		}
	}
	d.Serial = x.serialDevice() != nil
	if !d.Serial && !running {
		// An inactive domain's PTY has no path yet.
		for _, s := range append(append([]domChardev{}, x.Devices.Serials...), x.Devices.Consoles...) {
			if s.Type == "pty" {
				d.Serial = true
			}
		}
	}
	if !d.Serial && (len(x.Devices.Serials) > 0 || len(x.Devices.Consoles) > 0) {
		if d.Unavailable == nil {
			d.Unavailable = map[string]string{}
		}
		d.Unavailable[proto.ProtoSerial] = "the serial device is not a PTY or Unix socket"
	}
	return d
}

func (d *libvirtDriver) liveXML(l *libvirt.Libvirt, name string, secure bool) (*domainXML, error) {
	dom, err := d.domain(l, name)
	if err != nil {
		return nil, err
	}
	var flags libvirt.DomainXMLFlags
	if secure {
		flags = libvirt.DomainXMLSecure
	}
	s, err := l.DomainGetXMLDesc(dom, flags)
	if err != nil {
		return nil, codeErr(CodePlatformError, err.Error())
	}
	return parseDomainXML(s)
}

func (d *libvirtDriver) console(ctx context.Context, g *proto.Guest, req proto.ConsoleRequest) (agent.ConsoleSession, string, error) {
	l, err := d.connect()
	if err != nil {
		return nil, "", err
	}
	x, err := d.liveXML(l, g.ID, true)
	l.Disconnect()
	if err != nil {
		return nil, "", err
	}
	switch req.Protocol {
	case proto.ProtoVNC, proto.ProtoSPICE:
		typ := map[string]string{proto.ProtoVNC: "vnc", proto.ProtoSPICE: "spice"}[req.Protocol]
		var gr *domGraphics
		for i := range x.Devices.Graphics {
			if x.Devices.Graphics[i].Type == typ {
				gr = &x.Devices.Graphics[i]
				break
			}
		}
		if gr == nil {
			return nil, "", codeErr(CodeUnsupportedProtocol, "the VM has no "+strings.ToUpper(typ)+" display")
		}
		ep, reason := gr.endpoint()
		if ep == nil {
			return nil, "", codeErr(CodeProtocolUnavailable, reason)
		}
		dial := func(ctx context.Context) (net.Conn, error) {
			var dl net.Dialer
			if ep.unix != "" {
				return dl.DialContext(ctx, "unix", ep.unix)
			}
			if err := verifyListenerOwner(g.ID, ep.port); err != nil {
				return nil, err
			}
			return dl.DialContext(ctx, "tcp", net.JoinHostPort(ep.host, strconv.Itoa(ep.port)))
		}
		dctx, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		conn, err := dial(dctx)
		if err != nil {
			return nil, "", codeErr(CodeOpenFailed, "cannot connect to the display: "+err.Error())
		}
		if req.Protocol == proto.ProtoVNC {
			conn.SetDeadline(time.Now().Add(15 * time.Second))
			rw, info, err := RFBClientHandshake(conn, ep.password)
			if err != nil {
				conn.Close()
				return nil, "", codeErr(CodeOpenFailed, err.Error())
			}
			conn.SetDeadline(time.Time{})
			return newRFBSession(rw, info), info.Resolution(), nil
		}
		inject := ep.password != ""
		return &spiceSession{
			dial: func(ctx context.Context) (io.ReadWriteCloser, string, bool, error) {
				c, err := dial(ctx)
				return c, ep.password, inject, err
			},
			first: conn, firstPW: ep.password, firstIn: inject,
		}, "", nil

	case proto.ProtoSerial:
		dev := x.serialDevice()
		if dev == nil {
			return nil, "", codeErr(CodeProtocolUnavailable, "the VM has no serial console (add a PTY serial device)")
		}
		if p := dev.unixPath(); p != "" {
			var dl net.Dialer
			c, err := dl.DialContext(ctx, "unix", p)
			if err != nil {
				return nil, "", codeErr(CodeOpenFailed, "serial socket: "+err.Error())
			}
			return &termSession{protocol: proto.ProtoSerial, rw: c}, "", nil
		}
		p := dev.ptyPath()
		if !strings.HasPrefix(p, "/dev/pts/") {
			return nil, "", codeErr(CodeProtocolUnavailable, "the serial PTY path is not available")
		}
		f, err := openPTYSlave(p)
		if err != nil {
			return nil, "", codeErr(CodeOpenFailed, "serial PTY: "+err.Error())
		}
		return &termSession{protocol: proto.ProtoSerial, rw: f}, "", nil
	}
	return nil, "", codeErr(CodeUnsupportedProtocol, "protocol not supported for libvirt")
}

// verifyListenerOwner checks that the process listening on the loopback
// port is the domain's QEMU (pid from /run/libvirt/qemu/<name>.pid), so a
// port taken over by another process is never connected to.
func verifyListenerOwner(domain string, port int) error {
	pidB, err := os.ReadFile(filepath.Join("/run/libvirt/qemu", filepath.Base(domain)+".pid"))
	if err != nil {
		return fmt.Errorf("cannot verify the display port owner: %w", err)
	}
	pid := strings.TrimSpace(string(pidB))
	if _, err := strconv.Atoi(pid); err != nil {
		return errors.New("cannot verify the display port owner: bad pid file")
	}
	inodes := listeningInodes(port)
	if len(inodes) == 0 {
		return fmt.Errorf("nothing listens on port %d", port)
	}
	fdDir := filepath.Join("/proc", pid, "fd")
	ents, err := os.ReadDir(fdDir)
	if err != nil {
		return fmt.Errorf("cannot verify the display port owner: %w", err)
	}
	for _, e := range ents {
		link, err := os.Readlink(filepath.Join(fdDir, e.Name()))
		if err != nil {
			continue
		}
		if ino, ok := strings.CutPrefix(link, "socket:["); ok {
			if inodes[strings.TrimSuffix(ino, "]")] {
				return nil
			}
		}
	}
	return fmt.Errorf("port %d is not owned by the VM's QEMU process", port)
}

// listeningInodes returns the socket inodes listening on port (TCP, v4/v6).
func listeningInodes(port int) map[string]bool {
	out := map[string]bool{}
	hexPort := fmt.Sprintf(":%04X", port)
	for _, f := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		fh, err := os.Open(f)
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(fh)
		for sc.Scan() {
			fields := strings.Fields(sc.Text())
			// sl local rem st tx:rx tr:when retr uid timeout inode
			if len(fields) < 10 || fields[3] != "0A" { // 0A = LISTEN
				continue
			}
			if strings.HasSuffix(fields[1], hexPort) {
				out[fields[9]] = true
			}
		}
		fh.Close()
	}
	return out
}

func (d *libvirtDriver) list(ctx context.Context) ([]proto.Guest, error) {
	l, err := d.connect()
	if err != nil {
		return nil, err
	}
	defer l.Disconnect()
	doms, _, err := l.ConnectListAllDomains(1, 0)
	if err != nil {
		return nil, err
	}
	var out []proto.Guest
	for _, dom := range doms {
		st, _, err := l.DomainGetState(dom, 0)
		if err != nil {
			continue
		}
		state := normLibvirtState(st)
		x, err := l.DomainGetXMLDesc(dom, 0)
		if err != nil {
			continue
		}
		out = append(out, proto.Guest{
			ID: dom.Name, Name: dom.Name, Kind: "vm", State: state,
			Console: Caps(proto.PlatformLibvirt, LibvirtDisplay(x, state == proto.StateRunning)),
		})
	}
	return out, nil
}

// ---- snapshots ---------------------------------------------------------------

type snapshotXML struct {
	XMLName      xml.Name `xml:"domainsnapshot"`
	Name         string   `xml:"name"`
	Description  string   `xml:"description,omitempty"`
	State        string   `xml:"state,omitempty"`
	CreationTime int64    `xml:"creationTime,omitempty"`
	Memory       *struct {
		Snapshot string `xml:"snapshot,attr"`
	} `xml:"memory"`
	Parent *struct {
		Name string `xml:"name"`
	} `xml:"parent"`
}

// parseSnapshotXML reads a virDomainSnapshotGetXMLDesc document.
func parseSnapshotXML(s string, current bool) (proto.Snapshot, error) {
	var x snapshotXML
	if err := xml.Unmarshal([]byte(s), &x); err != nil {
		return proto.Snapshot{}, err
	}
	ps := proto.Snapshot{Name: x.Name, Description: x.Description, Current: current}
	if x.CreationTime > 0 {
		ps.Created = time.Unix(x.CreationTime, 0).UTC()
	}
	if x.Parent != nil {
		ps.Parent = x.Parent.Name
	}
	switch {
	case x.Memory != nil:
		ps.WithMemory = x.Memory.Snapshot == "internal" || x.Memory.Snapshot == "external"
	default: // older libvirt: a snapshot of a running domain has its RAM
		ps.WithMemory = x.State == "running" || x.State == "paused"
	}
	return ps, nil
}

// withDomain connects, looks up the domain and runs f; a hung libvirtd is
// released when ctx ends.
func (d *libvirtDriver) withDomain(ctx context.Context, g *proto.Guest, f func(l *libvirt.Libvirt, dom libvirt.Domain) error) error {
	l, err := d.connect()
	if err != nil {
		return err
	}
	defer l.Disconnect()
	defer context.AfterFunc(ctx, func() { _ = l.Disconnect() })()
	dom, err := d.domain(l, g.ID)
	if err != nil {
		return err
	}
	if err := f(l, dom); err != nil {
		var ce *codeError
		if errors.As(err, &ce) {
			return err
		}
		return codeErr(CodePlatformError, err.Error())
	}
	return nil
}

func (d *libvirtDriver) snapshots(ctx context.Context, g *proto.Guest) ([]proto.Snapshot, error) {
	var out []proto.Snapshot
	err := d.withDomain(ctx, g, func(l *libvirt.Libvirt, dom libvirt.Domain) error {
		snaps, _, err := l.DomainListAllSnapshots(dom, 1, 0)
		if err != nil {
			return err
		}
		out = make([]proto.Snapshot, 0, len(snaps))
		for _, sn := range snaps {
			x, err := l.DomainSnapshotGetXMLDesc(sn, 0)
			if err != nil {
				continue // deleted meanwhile
			}
			cur, _ := l.DomainSnapshotIsCurrent(sn, 0)
			ps, err := parseSnapshotXML(x, cur == 1)
			if err != nil {
				continue
			}
			out = append(out, ps)
		}
		return nil
	})
	return out, err
}

func (d *libvirtDriver) snapshotCreate(ctx context.Context, g *proto.Guest, name, description string, memory bool) error {
	// Internal snapshots: libvirt saves the RAM of a running domain (it
	// refuses internal disk-only snapshots of running domains), none for a
	// stopped one; memory cannot change that.
	doc, err := xml.Marshal(snapshotXML{Name: name, Description: description})
	if err != nil {
		return err
	}
	return d.withDomain(ctx, g, func(l *libvirt.Libvirt, dom libvirt.Domain) error {
		if x, err := l.DomainGetXMLDesc(dom, libvirt.DomainXMLInactive); err == nil {
			if msg := lvSnapshotProblem(x); msg != "" {
				return codeErr(CodeUnsupportedAction, msg)
			}
		}
		_, err := l.DomainSnapshotCreateXML(dom, string(doc), 0)
		if err != nil {
			if msg := lvSnapshotError(err); msg != "" {
				return codeErr(CodeUnsupportedAction, msg)
			}
		}
		return err
	})
}

// lvSnapshotProblem says in plain words why a domain's disks cannot take
// an internal snapshot ("" = they can): every writable disk must be a
// qcow2 file.
func lvSnapshotProblem(domXML string) string {
	d, err := parseLvDom(domXML)
	if err != nil {
		return ""
	}
	for _, n := range d.diskNodes("disk") {
		disk := readLvDisk(n)
		if disk.readonly || disk.source() == "" {
			continue
		}
		if disk.format != "qcow2" {
			return fmt.Sprintf("Snapshots need every disk in qcow2 format, and disk %s is %s. Back the VM up instead.", disk.target, orRaw(disk.format))
		}
	}
	return ""
}

func orRaw(f string) string {
	if f == "" {
		return "raw"
	}
	return f
}

// lvSnapshotError turns libvirt's refusals of internal snapshots into
// plain words ("" = another error).
func lvSnapshotError(err error) string {
	low := strings.ToLower(err.Error())
	switch {
	case strings.Contains(low, "pflash") || strings.Contains(low, "nvram"):
		return "libvirt cannot snapshot this VM because of its UEFI firmware. Back the VM up instead."
	case strings.Contains(low, "internal snapshot") && (strings.Contains(low, "not supported") || strings.Contains(low, "unsupported")):
		return "libvirt cannot take a snapshot of this VM's disks. Back the VM up instead."
	}
	return ""
}

func (d *libvirtDriver) snapshotRestore(ctx context.Context, g *proto.Guest, name string) error {
	return d.withDomain(ctx, g, func(l *libvirt.Libvirt, dom libvirt.Domain) error {
		sn, err := l.DomainSnapshotLookupByName(dom, name, 0)
		if err != nil {
			return codeErr(CodeUnknownSnapshot, "snapshot not found")
		}
		// The domain ends in the snapshot's state (running with RAM, or
		// shut off for a disk-only snapshot).
		return l.DomainRevertToSnapshot(sn, 0)
	})
}

func (d *libvirtDriver) snapshotDelete(ctx context.Context, g *proto.Guest, name string) error {
	return d.withDomain(ctx, g, func(l *libvirt.Libvirt, dom libvirt.Domain) error {
		sn, err := l.DomainSnapshotLookupByName(dom, name, 0)
		if err != nil {
			return codeErr(CodeUnknownSnapshot, "snapshot not found")
		}
		return l.DomainSnapshotDelete(sn, 0)
	})
}
