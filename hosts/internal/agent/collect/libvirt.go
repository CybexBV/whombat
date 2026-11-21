package collect

import (
	"context"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	golibvirt "github.com/digitalocean/go-libvirt"
	"github.com/digitalocean/go-libvirt/socket/dialers"

	"rackoon/internal/agent/broker"
	"rackoon/internal/proto"
)

// libvirtSockets: the monolithic daemon's socket, then the modular
// virtqemud's.
var libvirtSockets = []string{"/var/run/libvirt/libvirt-sock", "/run/libvirt/libvirt-sock", "/var/run/libvirt/virtqemud-sock", "/run/libvirt/virtqemud-sock"}

// libvirtCollector reads domains over the libvirt RPC socket.
type libvirtCollector struct {
	lastGood time.Time // last successful run (failedPlatform)
	toggle   toggleFn
	c        *collector
	root     fsRoot

	connMu sync.Mutex
	conn   *golibvirt.Libvirt
	socket string

	mu       sync.Mutex
	platform *proto.Platform
	version  string
	prev     map[string]libvirtSample
	xmlCache map[string]libvirtXMLCache // by UUID
	snaps    map[string]libvirtSnapCache
	addrs    map[string]libvirtAddrCache
	det      libvirtDetailState // host view (libvirt_detail.go)
}

// libvirtAddrCache holds a domain's DHCP-lease addresses (refreshed every
// minute; leases change rarely).
type libvirtAddrCache struct {
	at    time.Time
	addrs []string
}

type libvirtSample struct {
	at             time.Time
	cpuNs          uint64
	rd, wr, rx, tx uint64
	cpuPct         *float64
	rdBps, wrBps   *float64
	rxBps, txBps   *float64
}

type libvirtXMLCache struct {
	at      time.Time
	running bool // domain state when the XML was read
	dom     *libvirtDomainInfo
	display broker.GuestDisplay
}

type libvirtSnapCache struct {
	at        time.Time
	n         int
	autostart *bool // read with the snapshot count
	newest    *time.Time
}

func newLibvirtCollector(toggle toggleFn, c *collector) *libvirtCollector {
	return &libvirtCollector{toggle: toggle, c: c, prev: map[string]libvirtSample{}, xmlCache: map[string]libvirtXMLCache{},
		snaps: map[string]libvirtSnapCache{}, addrs: map[string]libvirtAddrCache{}}
}

func findLibvirtSocket() string {
	for _, s := range libvirtSockets {
		if socketExists(s) {
			return s
		}
	}
	return ""
}

// connect returns a live connection, dialing when needed.
func (l *libvirtCollector) connect(sock string) (*golibvirt.Libvirt, error) {
	l.connMu.Lock()
	defer l.connMu.Unlock()
	if l.conn != nil && l.conn.IsConnected() && l.socket == sock {
		return l.conn, nil
	}
	if l.conn != nil {
		_ = l.conn.Disconnect()
	}
	conn := golibvirt.NewWithDialer(dialers.NewLocal(dialers.WithSocket(sock), dialers.WithLocalTimeout(5*time.Second)))
	if err := conn.ConnectToURI(golibvirt.QEMUSystem); err != nil {
		return nil, fmt.Errorf("libvirt connect %s: %w", sock, err)
	}
	l.conn, l.socket = conn, sock
	return conn, nil
}

// dropConn closes conn if it is still the collector's connection.
func (l *libvirtCollector) dropConn(conn *golibvirt.Libvirt) {
	l.connMu.Lock()
	defer l.connMu.Unlock()
	if l.conn == conn && conn != nil {
		_ = conn.Disconnect()
		l.conn = nil
	}
}

// ---- domain XML --------------------------------------------------------------

type xmlMem struct {
	Value uint64 `xml:",chardata"`
	Unit  string `xml:"unit,attr"`
}

func (m xmlMem) bytes() uint64 {
	mult := uint64(1024)
	switch strings.ToLower(m.Unit) {
	case "b", "bytes":
		mult = 1
	case "kb":
		mult = 1000
	case "", "k", "kib":
		mult = 1024
	case "mb":
		mult = 1000 * 1000
	case "m", "mib":
		mult = 1 << 20
	case "gb":
		mult = 1000 * 1000 * 1000
	case "g", "gib":
		mult = 1 << 30
	case "tb":
		mult = 1000 * 1000 * 1000 * 1000
	case "t", "tib":
		mult = 1 << 40
	}
	return m.Value * mult
}

type domainXML struct {
	Name          string `xml:"name"`
	UUID          string `xml:"uuid"`
	Memory        xmlMem `xml:"memory"`
	CurrentMemory xmlMem `xml:"currentMemory"`
	VCPU          struct {
		Value   int `xml:",chardata"`
		Current int `xml:"current,attr"`
	} `xml:"vcpu"`
	OS struct {
		Firmware string `xml:"firmware,attr"`
		Type     struct {
			Machine string `xml:"machine,attr"`
			Arch    string `xml:"arch,attr"`
		} `xml:"type"`
		Loader string `xml:"loader"`
	} `xml:"os"`
	Features struct {
		HyperV *struct{} `xml:"hyperv"`
	} `xml:"features"`
	Metadata struct {
		Inner string `xml:",innerxml"`
	} `xml:"metadata"`
	Devices struct {
		TPMs       []struct{} `xml:"tpm"`
		MemBalloon *struct {
			Model string `xml:"model,attr"`
		} `xml:"memballoon"`
		Interfaces []struct {
			MAC struct {
				Address string `xml:"address,attr"`
			} `xml:"mac"`
		} `xml:"interface"`
	} `xml:"devices"`
}

// libvirtDomainInfo is what the collector keeps from the domain XML.
type libvirtDomainInfo struct {
	Machine  string // "q35"
	Firmware string // "OVMF" | "SeaBIOS"
	TPM      bool
	OSType   string
	MemMax   uint64
	VCPU     int
	Balloon  bool
	MACs     []string // <interface><mac address=…>, lower case
}

func (d *libvirtDomainInfo) image() string {
	parts := []string{}
	if d.Machine != "" {
		parts = append(parts, d.Machine)
	}
	if d.Firmware != "" {
		parts = append(parts, d.Firmware)
	}
	if d.TPM {
		parts = append(parts, "TPM")
	}
	return strings.Join(parts, " · ")
}

func parseDomainXML(s string) (*libvirtDomainInfo, error) {
	var x domainXML
	if err := xml.Unmarshal([]byte(s), &x); err != nil {
		return nil, err
	}
	d := &libvirtDomainInfo{MemMax: x.Memory.bytes(), VCPU: x.VCPU.Value}
	if x.VCPU.Current > 0 {
		d.VCPU = x.VCPU.Current
	}
	d.Machine = machineShort(x.OS.Type.Machine)
	loader := strings.ToLower(x.OS.Loader)
	switch {
	case x.OS.Firmware == "efi" || strings.Contains(loader, "ovmf") || strings.Contains(loader, "edk2") || strings.Contains(loader, "aavmf"):
		d.Firmware = "OVMF"
	case x.OS.Type.Arch == "" || x.OS.Type.Arch == "x86_64" || x.OS.Type.Arch == "i686":
		d.Firmware = "SeaBIOS"
	}
	d.TPM = len(x.Devices.TPMs) > 0
	macs := map[string]bool{}
	for _, nic := range x.Devices.Interfaces {
		if m := strings.ToLower(strings.TrimSpace(nic.MAC.Address)); validMAC(m) {
			macs[m] = true
		}
	}
	d.MACs = sortedKeys(macs)
	d.Balloon = x.Devices.MemBalloon != nil && x.Devices.MemBalloon.Model != "" && x.Devices.MemBalloon.Model != "none"
	meta := strings.ToLower(x.Metadata.Inner)
	switch {
	case strings.Contains(meta, "microsoft.com/win") || x.Features.HyperV != nil:
		d.OSType = "windows"
	case strings.Contains(meta, "freebsd.org") || strings.Contains(meta, "opnsense") || strings.Contains(meta, "pfsense"):
		d.OSType = "freebsd"
	case strings.Contains(meta, "libosinfo:os id="):
		d.OSType = "linux"
	}
	return d, nil
}

// machineShort: "pc-q35-10.0" -> "q35", "pc-i440fx-9.2" / "pc" -> "i440fx".
func machineShort(m string) string {
	switch {
	case m == "":
		return ""
	case strings.Contains(m, "q35"):
		return "q35"
	case strings.Contains(m, "i440fx") || m == "pc" || strings.HasPrefix(m, "pc-") && !strings.Contains(m, "q35"):
		return "i440fx"
	case strings.HasPrefix(m, "virt"):
		return "virt"
	}
	return m
}

// ---- stats ---------------------------------------------------------------------

// domStats holds the parsed typed parameters of one domain.
type domStats struct {
	state                       int
	cpuNs                       uint64
	balloonCur, balloonMax      uint64 // KiB
	balloonAvail, balloonUsable uint64
	balloonUnused, balloonRSS   uint64
	haveAvail, haveUsable       bool
	haveUnused, haveRSS         bool
	vcpuCur                     int
	balloonUpdated              int64 // unix time of the guest's last memory stats

	rd, wr, rx, tx uint64
}

func paramUint(v golibvirt.TypedParamValue) (uint64, bool) {
	switch x := v.I.(type) {
	case uint64:
		return x, true
	case int64:
		if x < 0 {
			return 0, false
		}
		return uint64(x), true
	case uint32:
		return uint64(x), true
	case int32:
		if x < 0 {
			return 0, false
		}
		return uint64(x), true
	case float64:
		return uint64(x), true
	}
	return 0, false
}

func parseDomStats(params []golibvirt.TypedParam) domStats {
	var s domStats
	for _, p := range params {
		v, ok := paramUint(p.Value)
		if !ok {
			continue
		}
		f := p.Field
		switch {
		case f == "state.state":
			s.state = int(v)
		case f == "cpu.time":
			s.cpuNs = v
		case f == "balloon.current":
			s.balloonCur = v
		case f == "balloon.maximum":
			s.balloonMax = v
		case f == "balloon.available":
			s.balloonAvail, s.haveAvail = v, true
		case f == "balloon.usable":
			s.balloonUsable, s.haveUsable = v, true
		case f == "balloon.unused":
			s.balloonUnused, s.haveUnused = v, true
		case f == "balloon.rss":
			s.balloonRSS, s.haveRSS = v, true
		case f == "balloon.last-update":
			s.balloonUpdated = int64(v)
		case f == "vcpu.current":
			s.vcpuCur = int(v)
		case strings.HasPrefix(f, "net.") && strings.HasSuffix(f, ".rx.bytes"):
			s.rx += v
		case strings.HasPrefix(f, "net.") && strings.HasSuffix(f, ".tx.bytes"):
			s.tx += v
		case strings.HasPrefix(f, "block.") && strings.HasSuffix(f, ".rd.bytes"):
			s.rd += v
		case strings.HasPrefix(f, "block.") && strings.HasSuffix(f, ".wr.bytes"):
			s.wr += v
		}
	}
	return s
}

// libvirt domain states (virDomainState).
func libvirtState(st int) string {
	switch st {
	case 1, 2, 4: // running, blocked, shutting down
		return proto.StateRunning
	case 3, 7: // paused, pmsuspended (guest suspended to RAM)
		return proto.StatePaused
	}
	return proto.StateStopped // nostate, shutoff, crashed
}

// libvirtLeaseAddrs converts DomainInterfaceAddresses (lease source) into
// addresses without prefix, IPv4 first.
func libvirtLeaseAddrs(ifs []golibvirt.DomainInterface) []string {
	var v4, v6 []string
	for _, ifc := range ifs {
		for _, a := range ifc.Addrs {
			switch a.Type {
			case 0: // VIR_IP_ADDR_TYPE_IPV4
				v4 = append(v4, a.Addr)
			case 1:
				v6 = append(v6, a.Addr)
			}
		}
	}
	return append(v4, v6...)
}

func (l *libvirtCollector) run(ctx context.Context) error {
	sock := findLibvirtSocket()
	enabled := l.toggle.enabled(sock != "")
	l.c.libvirtSub.setAbsent(!enabled)
	if !enabled {
		l.mu.Lock()
		l.platform = nil
		l.mu.Unlock()
		return nil
	}
	fail := func(err error) error {
		l.mu.Lock()
		l.platform = failedPlatform(l.platform, l.lastGood, l.version, err)
		l.mu.Unlock()
		return err
	}
	if sock == "" {
		return fail(fmt.Errorf("libvirt socket not found (%s)", strings.Join(libvirtSockets[:3:3], ", ")))
	}
	conn, err := l.connect(sock)
	if err != nil {
		return fail(err)
	}
	// go-libvirt calls take no context: when the run times out (a hung
	// libvirtd), drop the connection so the blocked call returns; the next
	// run dials again.
	stop := context.AfterFunc(ctx, func() { l.dropConn(conn) })
	defer stop()
	if l.version == "" {
		if v, err := conn.ConnectGetLibVersion(); err == nil {
			l.mu.Lock()
			l.version = fmt.Sprintf("%d.%d.%d", v/1000000, (v/1000)%1000, v%1000)
			l.mu.Unlock()
		}
	}
	stats := golibvirt.DomainStatsState | golibvirt.DomainStatsCPUTotal | golibvirt.DomainStatsBalloon |
		golibvirt.DomainStatsVCPU | golibvirt.DomainStatsInterface | golibvirt.DomainStatsBlock
	recs, err := conn.ConnectGetAllDomainStats(nil, uint32(stats), 0)
	if err != nil {
		return fail(fmt.Errorf("libvirt domain stats: %w", err))
	}
	now := time.Now()
	bootTime := l.c.host.snapshot().BootTime

	guests := make([]proto.Guest, 0, len(recs))
	seen := map[string]bool{}
	for _, rec := range recs {
		dom := rec.Dom
		uuid := hex.EncodeToString(dom.UUID[:])
		seen[uuid] = true
		st := parseDomStats(rec.Params)
		running := libvirtState(st.state) == proto.StateRunning

		// Domain XML: cached for 5 minutes, until a lifecycle event or
		// until the domain's state changes (the live XML has the console
		// listeners). The console devices are judged by the broker.
		l.mu.Lock()
		xc, ok := l.xmlCache[uuid]
		l.mu.Unlock()
		if !ok || time.Since(xc.at) > 5*time.Minute || xc.running != running {
			if s, err := conn.DomainGetXMLDesc(dom, 0); err == nil {
				if info, err := parseDomainXML(s); err == nil {
					xc = libvirtXMLCache{at: now, running: running, dom: info, display: broker.LibvirtDisplay(s, running)}
					l.mu.Lock()
					l.xmlCache[uuid] = xc
					l.mu.Unlock()
				}
			}
		}
		info := xc.dom
		if info == nil {
			info = &libvirtDomainInfo{}
		}
		// Snapshot count: every 5 minutes.
		l.mu.Lock()
		sc, ok := l.snaps[uuid]
		l.mu.Unlock()
		if !ok || time.Since(sc.at) > 5*time.Minute {
			if n, err := conn.DomainSnapshotNum(dom, 0); err == nil {
				sc = libvirtSnapCache{at: now, n: int(n)}
				if a, err := conn.DomainGetAutostart(dom); err == nil {
					sc.autostart = ptr(a != 0)
				}
				sc.newest = libvirtNewestSnapshot(conn, dom, int(n))
				l.mu.Lock()
				l.snaps[uuid] = sc
				l.mu.Unlock()
			}
		}

		g := proto.Guest{
			ID:          dom.Name,
			Name:        dom.Name,
			Kind:        "vm",
			Image:       info.image(),
			State:       libvirtState(st.state),
			VCPU:        info.VCPU,
			OSType:      info.OSType,
			Firmware:    info.Firmware,
			MachineType: info.Machine,
			MACs:        info.MACs,
		}
		if running && st.vcpuCur > 0 {
			g.VCPU = st.vcpuCur
		}
		g.MemConfigBytes = info.MemMax
		if st.balloonMax > 0 {
			g.MemConfigBytes = st.balloonMax * 1024
		}
		g.BalloonActive = info.Balloon && running && (st.haveAvail || st.haveUsable || st.haveUnused)
		if ok := sc.at.IsZero(); !ok {
			n := sc.n
			g.SnapshotsCount = &n
			g.Autostart = copyPtr(sc.autostart)
			g.LastSnapshot = copyPtr(sc.newest)
		}
		disp := xc.display
		disp.Kind, disp.Running = "vm", running
		g.Console = broker.Caps(proto.PlatformLibvirt, disp)

		if running {
			if st.balloonCur > 0 {
				g.MemLimitBytes = ptr(st.balloonCur * 1024)
			}
			// Guest memory stats are only refreshed when the balloon's stats
			// period is set; stale stats fall back to the host RSS.
			fresh := st.balloonUpdated == 0 || now.Unix()-st.balloonUpdated < 300
			switch {
			case fresh && st.haveAvail && st.haveUsable && st.balloonAvail >= st.balloonUsable:
				g.MemUsedBytes = ptr((st.balloonAvail - st.balloonUsable) * 1024)
			case fresh && st.haveAvail && st.haveUnused && st.balloonAvail >= st.balloonUnused:
				g.MemUsedBytes = ptr((st.balloonAvail - st.balloonUnused) * 1024)
			case st.haveRSS:
				g.MemUsedBytes = ptr(st.balloonRSS * 1024)
			}
			if t := l.domainStart(dom.Name, bootTime); t != nil {
				g.StartedAt = t
			}
			// Addresses from libvirt's DHCP leases (cheap; domains on
			// bridges without libvirt's dnsmasq have none).
			l.mu.Lock()
			ac, ok := l.addrs[uuid]
			l.mu.Unlock()
			if !ok || now.Sub(ac.at) > time.Minute {
				ac = libvirtAddrCache{at: now}
				if ifs, err := conn.DomainInterfaceAddresses(dom, uint32(golibvirt.DomainInterfaceAddressesSrcLease), 0); err == nil {
					ac.addrs = libvirtLeaseAddrs(ifs)
				}
				l.mu.Lock()
				l.addrs[uuid] = ac
				l.mu.Unlock()
			}
			g.Addresses = append([]string(nil), ac.addrs...)
			cur := libvirtSample{at: now, cpuNs: st.cpuNs, rd: st.rd, wr: st.wr, rx: st.rx, tx: st.tx}
			l.mu.Lock()
			p, havePrev := l.prev[uuid]
			l.mu.Unlock()
			if havePrev {
				dt := now.Sub(p.at).Seconds()
				if dt >= 1 {
					if n := g.VCPU; n > 0 && cur.cpuNs >= p.cpuNs {
						cur.cpuPct = ptr(round1(clamp(float64(cur.cpuNs-p.cpuNs)/(dt*1e9*float64(n))*100, 0, 100)))
					}
					cur.rdBps, cur.wrBps = rate(cur.rd, p.rd, dt), rate(cur.wr, p.wr, dt)
					cur.rxBps, cur.txBps = rate(cur.rx, p.rx, dt), rate(cur.tx, p.tx, dt)
				} else {
					cur = p
				}
			}
			l.mu.Lock()
			l.prev[uuid] = cur
			l.mu.Unlock()
			g.CPUPct = copyPtr(cur.cpuPct)
			g.DiskReadBps, g.DiskWriteBps = copyPtr(cur.rdBps), copyPtr(cur.wrBps)
			g.NetRxBps, g.NetTxBps = copyPtr(cur.rxBps), copyPtr(cur.txBps)
		} else {
			l.mu.Lock()
			delete(l.prev, uuid)
			l.mu.Unlock()
		}
		guests = append(guests, g)
	}
	det := l.refreshDetail(conn, recs, guests)
	l.mu.Lock()
	for _, m := range []map[string]libvirtSample{l.prev} {
		for k := range m {
			if !seen[k] {
				delete(m, k)
			}
		}
	}
	for k := range l.xmlCache {
		if !seen[k] {
			delete(l.xmlCache, k)
		}
	}
	for k := range l.snaps {
		if !seen[k] {
			delete(l.snaps, k)
		}
	}
	for k := range l.addrs {
		if !seen[k] {
			delete(l.addrs, k)
		}
	}
	l.platform = &proto.Platform{Version: l.version, Guests: guests, Libvirt: det}
	l.lastGood = time.Now()
	l.mu.Unlock()
	return nil
}

// domainStart derives the start time of a running domain from its QEMU
// process (pid file of the system daemon).
func (l *libvirtCollector) domainStart(name string, boot time.Time) *time.Time {
	if boot.IsZero() {
		return nil
	}
	pid := strings.TrimSpace(l.root.readString("/run/libvirt/qemu/" + name + ".pid"))
	if pid == "" {
		return nil
	}
	if _, err := strconv.Atoi(pid); err != nil {
		return nil
	}
	stat := l.root.readString("/proc/" + pid + "/stat")
	ticks, ok := procStartTicks(stat)
	if !ok {
		return nil
	}
	t := boot.Add(time.Duration(ticks) * time.Second / clockTicks).UTC()
	return &t
}

func (l *libvirtCollector) snapshot() *proto.Platform {
	l.mu.Lock()
	defer l.mu.Unlock()
	return copyPlatform(l.platform)
}

// invalidate drops the cached XML and snapshot count of a domain (after a
// lifecycle event, e.g. redefined).
func (l *libvirtCollector) invalidate(uuid string) {
	l.mu.Lock()
	delete(l.xmlCache, uuid)
	delete(l.snaps, uuid)
	l.mu.Unlock()
}

// dropAutostart forgets the cached snapshot counts and autostart flags
// (an autostart change through the agent sends no libvirt event).
func (l *libvirtCollector) dropAutostart() {
	l.mu.Lock()
	clear(l.snaps)
	l.mu.Unlock()
}

// ---- events ---------------------------------------------------------------------

func libvirtEventState(ev golibvirt.DomainEventType) (state, msg string) {
	switch ev {
	case golibvirt.DomainEventStarted, golibvirt.DomainEventResumed:
		return proto.StateRunning, map[golibvirt.DomainEventType]string{golibvirt.DomainEventStarted: "started", golibvirt.DomainEventResumed: "resumed"}[ev]
	case golibvirt.DomainEventSuspended:
		return proto.StatePaused, "paused"
	case golibvirt.DomainEventPmsuspended:
		return proto.StatePaused, "pm-suspended"
	case golibvirt.DomainEventStopped, golibvirt.DomainEventShutdown, golibvirt.DomainEventCrashed:
		return proto.StateStopped, map[golibvirt.DomainEventType]string{
			golibvirt.DomainEventStopped: "stopped", golibvirt.DomainEventShutdown: "shutdown", golibvirt.DomainEventCrashed: "crashed",
		}[ev]
	case golibvirt.DomainEventUndefined:
		return proto.StateStopped, "removed"
	case golibvirt.DomainEventDefined:
		return proto.StateStopped, "defined"
	}
	return "", ""
}

func (l *libvirtCollector) startEvents(ctx context.Context) {
	go func() {
		backoff := time.Second
		for ctx.Err() == nil {
			sock := findLibvirtSocket()
			if sock == "" || !l.toggle.enabled(true) {
				sleepCtx(ctx, 30*time.Second)
				continue
			}
			start := time.Now()
			_ = l.streamEvents(ctx, sock)
			if ctx.Err() != nil {
				return
			}
			if time.Since(start) > time.Minute {
				backoff = time.Second
			}
			sleepCtx(ctx, backoff)
			if backoff < 30*time.Second {
				backoff *= 2
			}
		}
	}()
}

func (l *libvirtCollector) streamEvents(ctx context.Context, sock string) error {
	// A dedicated connection, so a stuck event stream cannot block stats.
	conn := golibvirt.NewWithDialer(dialers.NewLocal(dialers.WithSocket(sock), dialers.WithLocalTimeout(5*time.Second)))
	if err := conn.ConnectToURI(golibvirt.QEMUSystem); err != nil {
		return err
	}
	defer conn.Disconnect()
	ectx, cancel := context.WithCancel(ctx)
	defer cancel()
	ch, err := conn.LifecycleEvents(ectx)
	if err != nil {
		return err
	}
	for {
		select {
		case ev, ok := <-ch:
			if !ok {
				return fmt.Errorf("libvirt event stream closed")
			}
			state, msg := libvirtEventState(golibvirt.DomainEventType(ev.Event))
			if state == "" {
				continue
			}
			l.invalidate(hex.EncodeToString(ev.Dom.UUID[:]))
			l.c.guestEvent(proto.PlatformLibvirt, ev.Dom.Name, state, msg)
		case <-conn.Disconnected():
			return fmt.Errorf("libvirt disconnected")
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}
