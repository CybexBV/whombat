package wifi

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/godbus/dbus/v5"
)

// DefaultBus is the system bus's socket on NixOS.
const DefaultBus = "unix:path=/run/dbus/system_bus_socket"

const (
	iwdService       = "net.connman.iwd"
	ifAdapter        = "net.connman.iwd.Adapter"
	ifDevice         = "net.connman.iwd.Device"
	ifStation        = "net.connman.iwd.Station"
	ifNetwork        = "net.connman.iwd.Network"
	ifKnown          = "net.connman.iwd.KnownNetwork"
	ifAgentManager   = "net.connman.iwd.AgentManager"
	ifAgent          = "net.connman.iwd.Agent"
	agentManagerPath = dbus.ObjectPath("/net/connman/iwd")
	agentPath        = dbus.ObjectPath("/com/whombat/wifi/agent")
	errCanceled      = "net.connman.iwd.Agent.Error.Canceled"
)

// IWD is the Client over D-Bus (net.connman.iwd). Each call opens its own connection to the bus and closes it.
type IWD struct {
	// Bus is the system bus address; "" is DefaultBus.
	Bus string
	// Dir is iwd's profile directory; "" is StateDir.
	Dir string
	// Poll is how often a scan or a profile iwd is loading is looked at; 0 is 200 ms.
	Poll time.Duration
}

var _ Client = (*IWD)(nil)

func (c *IWD) dir() string {
	if c.Dir != "" {
		return c.Dir
	}
	return StateDir
}

func (c *IWD) poll() time.Duration {
	if c.Poll > 0 {
		return c.Poll
	}
	return 200 * time.Millisecond
}

func (c *IWD) dial(ctx context.Context) (*dbus.Conn, error) {
	bus := c.Bus
	if bus == "" {
		bus = DefaultBus
	}
	conn, err := dbus.Connect(bus, dbus.WithContext(ctx))
	if err != nil {
		return nil, fmt.Errorf("%w: the system bus: %v", ErrNoIwd, err)
	}
	return conn, nil
}

// objects reads iwd's object tree.
func objects(ctx context.Context, conn *dbus.Conn) (*snapshot, error) {
	var objs map[dbus.ObjectPath]map[string]map[string]dbus.Variant
	err := conn.Object(iwdService, "/").CallWithContext(ctx, "org.freedesktop.DBus.ObjectManager.GetManagedObjects", 0).Store(&objs)
	if err != nil {
		return nil, busErr(err)
	}
	return parseObjects(objs), nil
}

// busErr maps a call's error that isn't about the operation itself.
func busErr(err error) error {
	var de dbus.Error
	if errors.As(err, &de) {
		switch de.Name {
		case "org.freedesktop.DBus.Error.ServiceUnknown", "org.freedesktop.DBus.Error.NameHasNoOwner",
			"org.freedesktop.DBus.Error.NoReply", "org.freedesktop.DBus.Error.Disconnected":
			return fmt.Errorf("%w (%s)", ErrNoIwd, de.Name)
		case "net.connman.iwd.Busy", "net.connman.iwd.InProgress":
			return ErrBusy
		case "net.connman.iwd.NotFound":
			return ErrNotFound
		case "net.connman.iwd.NotSupported":
			return ErrNotSupported
		}
		return fmt.Errorf("wifi: iwd answered %s", de.Name)
	}
	return fmt.Errorf("wifi: %w", err)
}

// Status implements Client.
func (c *IWD) Status(ctx context.Context) (*Status, error) {
	conn, err := c.dial(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	snap, err := objects(ctx, conn)
	if err != nil {
		return nil, err
	}
	st := snap.status()
	// The connected network's signal: iwd ranks it in the station's ordered networks.
	for i := range st.Devices {
		d := &st.Devices[i]
		if d.Station == nil || d.Station.Connected == nil {
			continue
		}
		if ns, err := c.ordered(ctx, conn, snap, snap.deviceByName[d.Interface]); err == nil {
			for _, n := range ns {
				if n.SSID == d.Station.Connected.SSID && n.Security == d.Station.Connected.Security {
					d.Station.Connected.SignalDBm = n.SignalDBm
				}
			}
		}
	}
	return st, nil
}

// ordered returns a station's networks of the last scan, strongest first.
func (c *IWD) ordered(ctx context.Context, conn *dbus.Conn, snap *snapshot, station dbus.ObjectPath) ([]Network, error) {
	var ranked []struct {
		Path   dbus.ObjectPath
		Signal int16
	}
	err := conn.Object(iwdService, station).CallWithContext(ctx, ifStation+".GetOrderedNetworks", 0).Store(&ranked)
	if err != nil {
		return nil, busErr(err)
	}
	var out []Network
	for _, r := range ranked {
		n, ok := snap.networks[r.Path]
		if !ok {
			continue
		}
		v := n.public()
		v.SignalDBm = int(r.Signal) / 100
		out = append(out, v)
	}
	SortNetworks(out)
	return out, nil
}

func (c *IWD) station(ctx context.Context, conn *dbus.Conn, iface string) (*snapshot, dbus.ObjectPath, error) {
	snap, err := objects(ctx, conn)
	if err != nil {
		return nil, "", err
	}
	p, ok := snap.deviceByName[iface]
	if !ok || !snap.devices[p].station {
		return nil, "", fmt.Errorf("%w: %q", ErrNoStation, iface)
	}
	return snap, p, nil
}

// Networks implements Client.
func (c *IWD) Networks(ctx context.Context, iface string) ([]Network, error) {
	conn, err := c.dial(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	snap, p, err := c.station(ctx, conn, iface)
	if err != nil {
		return nil, err
	}
	return c.ordered(ctx, conn, snap, p)
}

// Scan implements Client.
func (c *IWD) Scan(ctx context.Context, iface string) ([]Network, error) {
	conn, err := c.dial(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	_, p, err := c.station(ctx, conn, iface)
	if err != nil {
		return nil, err
	}
	if err := c.scan(ctx, conn, p); err != nil {
		return nil, err
	}
	snap, err := objects(ctx, conn)
	if err != nil {
		return nil, err
	}
	return c.ordered(ctx, conn, snap, p)
}

// scan starts a scan (a Busy station is already scanning or connecting) and waits until Scanning is false.
func (c *IWD) scan(ctx context.Context, conn *dbus.Conn, station dbus.ObjectPath) error {
	obj := conn.Object(iwdService, station)
	if err := obj.CallWithContext(ctx, ifStation+".Scan", 0).Err; err != nil && !errors.Is(busErr(err), ErrBusy) {
		return busErr(err)
	}
	for {
		var v dbus.Variant
		if err := obj.CallWithContext(ctx, "org.freedesktop.DBus.Properties.Get", 0, ifStation, "Scanning").Store(&v); err != nil {
			return busErr(err)
		}
		if b, ok := v.Value().(bool); ok && !b {
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("wifi: the scan didn't end: %w", ctx.Err())
		case <-time.After(c.poll()):
		}
	}
}

// Connect implements Client.
func (c *IWD) Connect(ctx context.Context, iface string, j Join) error {
	if err := j.check(); err != nil {
		return err
	}
	conn, err := c.dial(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	snap, station, err := c.station(ctx, conn, iface)
	if err != nil {
		return err
	}
	net := snap.find(station, j)
	if net == nil && !j.Hidden {
		if err := c.scan(ctx, conn, station); err != nil {
			return err
		}
		if snap, err = objects(ctx, conn); err != nil {
			return err
		}
		if net = snap.find(station, j); net == nil {
			return ErrNotFound
		}
	}
	sec := j.securityOf()
	if net != nil {
		sec = net.security
	}
	if !sec.Joinable() {
		return ErrNotSupported
	}
	if sec == SecurityOpen {
		j.Passphrase = ""
	}
	saved := snap.knownOf(j.SSID, sec)
	if sec == SecurityPSK && j.Passphrase == "" && saved == nil {
		return ErrInvalidPassphrase // a secured network that isn't saved needs its password
	}

	// A profile first for a raw key (an agent can only hand over a passphrase) or a saved network's new passphrase;
	// put back as it was when the join fails.
	var undo func()
	if sec == SecurityPSK && j.Passphrase != "" && (IsHexKey(j.Passphrase) || saved != nil) {
		old, rerr := ReadProfile(c.dir(), j.SSID, sec)
		hidden := j.Hidden || saved != nil && saved.Hidden
		if err := WriteProfile(c.dir(), j.SSID, sec, Profile{Passphrase: j.Passphrase, Hidden: hidden}); err != nil {
			return fmt.Errorf("wifi: write the profile: %w", err)
		}
		undo = func() {
			if rerr == nil {
				_ = WriteProfileData(c.dir(), j.SSID, sec, old)
			} else {
				_ = RemoveProfile(c.dir(), j.SSID, sec)
			}
		}
		if saved == nil {
			if snap, err = c.waitKnown(ctx, conn, j.SSID, sec); err != nil {
				undo()
				return err
			}
			saved = snap.knownOf(j.SSID, sec)
			if net != nil {
				net = snap.find(station, Join{SSID: j.SSID, Security: sec})
			}
		}
	}
	done := false
	defer func() {
		if !done && undo != nil {
			undo()
		}
	}()

	// The agent answers iwd's passphrase request: a network that isn't saved yet, and a saved one iwd asks again
	// about after an earlier wrong password (iwd then asks even with a profile).
	ag := &agent{passphrase: j.Passphrase}
	if IsHexKey(j.Passphrase) {
		ag.passphrase = ""
	}
	var owner string
	if err := conn.BusObject().CallWithContext(ctx, "org.freedesktop.DBus.GetNameOwner", 0, iwdService).Store(&owner); err != nil {
		return busErr(err)
	}
	ag.iwd = owner
	if err := conn.Export(ag, agentPath, ifAgent); err != nil {
		return fmt.Errorf("wifi: agent: %w", err)
	}
	am := conn.Object(iwdService, agentManagerPath)
	if err := am.CallWithContext(ctx, ifAgentManager+".RegisterAgent", 0, agentPath).Err; err != nil {
		return busErr(err)
	}
	defer func() {
		// Closing the connection drops the agent too; this only says so first.
		uctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
		defer cancel()
		am.CallWithContext(uctx, ifAgentManager+".UnregisterAgent", 0, agentPath)
	}()

	switch {
	case net != nil:
		err = conn.Object(iwdService, net.path).CallWithContext(ctx, ifNetwork+".Connect", 0).Err
	case saved != nil:
		// A saved hidden network: iwd asks for it by name in its scans.
		if err = c.scan(ctx, conn, station); err != nil {
			return err
		}
		if snap, err = objects(ctx, conn); err != nil {
			return err
		}
		if net = snap.find(station, Join{SSID: j.SSID, Security: sec}); net == nil {
			return ErrNotFound
		}
		err = conn.Object(iwdService, net.path).CallWithContext(ctx, ifNetwork+".Connect", 0).Err
	default:
		err = conn.Object(iwdService, station).CallWithContext(ctx, ifStation+".ConnectHiddenNetwork", 0, j.SSID).Err
		if isErr(err, "net.connman.iwd.NotHidden") {
			// Not hidden after all: it shows in the scan now.
			if snap, err = objects(ctx, conn); err != nil {
				return err
			}
			if net = snap.find(station, Join{SSID: j.SSID, Security: sec}); net == nil {
				return ErrNotFound
			}
			err = conn.Object(iwdService, net.path).CallWithContext(ctx, ifNetwork+".Connect", 0).Err
		}
	}
	if err != nil {
		return connectErr(ctx, err, sec, ag)
	}
	done = true
	return nil
}

// waitKnown waits until iwd loaded a profile written into its directory (it watches the directory).
func (c *IWD) waitKnown(ctx context.Context, conn *dbus.Conn, ssid string, sec Security) (*snapshot, error) {
	wctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	for {
		snap, err := objects(wctx, conn)
		if err == nil && snap.knownOf(ssid, sec) != nil {
			return snap, nil
		}
		select {
		case <-wctx.Done():
			return nil, errors.New("wifi: iwd didn't load the profile")
		case <-time.After(c.poll()):
		}
	}
}

func isErr(err error, name string) bool {
	var de dbus.Error
	return errors.As(err, &de) && de.Name == name
}

// connectErr maps a failed Connect (iwd's station_connect_cb: a failed handshake, a refused association or
// authentication all answer net.connman.iwd.Failed).
func connectErr(ctx context.Context, err error, sec Security, ag *agent) error {
	var de dbus.Error
	if !errors.As(err, &de) {
		if ctx.Err() != nil {
			return fmt.Errorf("wifi: the join didn't finish: %w", ctx.Err())
		}
		return fmt.Errorf("wifi: %w", err)
	}
	switch de.Name {
	case "net.connman.iwd.Failed":
		if sec == SecurityPSK {
			return ErrWrongPassword
		}
		return errors.New("wifi: iwd couldn't connect")
	case "net.connman.iwd.InvalidFormat", "net.connman.iwd.NoAgent":
		return ErrInvalidPassphrase
	case "net.connman.iwd.Aborted":
		if ag.refused() {
			return ErrWrongPassword // iwd asked again for a saved network's password, and there was none
		}
		return errors.New("wifi: the join was cut short")
	case "net.connman.iwd.Timeout":
		return errors.New("wifi: the join timed out")
	}
	return busErr(err)
}

// agent is the passphrase agent (net.connman.iwd.Agent) of one join. It answers iwd only.
type agent struct {
	passphrase string
	iwd        string // iwd's unique bus name
	mu         sync.Mutex
	declined   bool
}

func (a *agent) refused() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.declined
}

func canceled() *dbus.Error { return dbus.NewError(errCanceled, []any{"canceled"}) }

// Release is called when iwd drops the agent.
func (a *agent) Release() *dbus.Error { return nil }

// Cancel is called when iwd gives up a request.
func (a *agent) Cancel(string) *dbus.Error { return nil }

// RequestPassphrase hands iwd the join's passphrase.
func (a *agent) RequestPassphrase(from dbus.Sender, _ dbus.ObjectPath) (string, *dbus.Error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if string(from) != a.iwd || a.passphrase == "" {
		a.declined = true
		return "", canceled()
	}
	return a.passphrase, nil
}

// RequestPrivateKeyPassphrase: company networks are not joined here.
func (a *agent) RequestPrivateKeyPassphrase(dbus.ObjectPath) (string, *dbus.Error) {
	return "", canceled()
}

// RequestUserNameAndPassword: company networks are not joined here.
func (a *agent) RequestUserNameAndPassword(dbus.ObjectPath) (string, string, *dbus.Error) {
	return "", "", canceled()
}

// RequestUserPassword: company networks are not joined here.
func (a *agent) RequestUserPassword(dbus.ObjectPath, string) (string, *dbus.Error) {
	return "", canceled()
}

// Forget implements Client.
func (c *IWD) Forget(ctx context.Context, ssid string, sec Security) error {
	if !ValidSSID(ssid) {
		return ErrBadSSID
	}
	conn, err := c.dial(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	snap, err := objects(ctx, conn)
	if err != nil {
		return err
	}
	for p, k := range snap.known {
		if k.SSID == ssid && k.Security == sec {
			if err := conn.Object(iwdService, p).CallWithContext(ctx, ifKnown+".Forget", 0).Err; err != nil {
				return busErr(err)
			}
			return nil
		}
	}
	return ErrNotFound
}

// ---- iwd's object tree ----

type deviceObj struct {
	name, mode, adapter string
	powered, station    bool
	state               StationState
	scanning            bool
	connected           dbus.ObjectPath
}

type networkObj struct {
	path      dbus.ObjectPath
	name      string
	security  Security
	device    dbus.ObjectPath
	known     dbus.ObjectPath
	connected bool
}

func (n networkObj) public() Network {
	return Network{SSID: n.name, Security: n.security, Known: n.known != "", Connected: n.connected}
}

type snapshot struct {
	adapters     map[dbus.ObjectPath]Adapter
	devices      map[dbus.ObjectPath]*deviceObj
	deviceByName map[string]dbus.ObjectPath
	networks     map[dbus.ObjectPath]networkObj
	known        map[dbus.ObjectPath]KnownNetwork
}

func str(props map[string]dbus.Variant, k string) string {
	s, _ := props[k].Value().(string)
	return s
}

func boolean(props map[string]dbus.Variant, k string) bool {
	b, _ := props[k].Value().(bool)
	return b
}

func objPath(props map[string]dbus.Variant, k string) dbus.ObjectPath {
	p, _ := props[k].Value().(dbus.ObjectPath)
	return p
}

// parseObjects reads GetManagedObjects' answer; anything of another shape is left out.
func parseObjects(objs map[dbus.ObjectPath]map[string]map[string]dbus.Variant) *snapshot {
	s := &snapshot{adapters: map[dbus.ObjectPath]Adapter{}, devices: map[dbus.ObjectPath]*deviceObj{},
		deviceByName: map[string]dbus.ObjectPath{}, networks: map[dbus.ObjectPath]networkObj{}, known: map[dbus.ObjectPath]KnownNetwork{}}
	for p, ifs := range objs {
		if a, ok := ifs[ifAdapter]; ok {
			s.adapters[p] = Adapter{Name: str(a, "Name"), Model: str(a, "Model"), Vendor: str(a, "Vendor"), Powered: boolean(a, "Powered")}
		}
		if d, ok := ifs[ifDevice]; ok {
			dev := &deviceObj{name: str(d, "Name"), mode: str(d, "Mode"), powered: boolean(d, "Powered"), adapter: string(objPath(d, "Adapter"))}
			if st, ok := ifs[ifStation]; ok {
				dev.station = true
				dev.state = StationState(str(st, "State"))
				dev.scanning = boolean(st, "Scanning")
				dev.connected = objPath(st, "ConnectedNetwork")
			}
			if dev.name != "" {
				s.devices[p] = dev
				s.deviceByName[dev.name] = p
			}
		}
		if n, ok := ifs[ifNetwork]; ok {
			s.networks[p] = networkObj{path: p, name: str(n, "Name"), security: Security(str(n, "Type")), device: objPath(n, "Device"),
				known: objPath(n, "KnownNetwork"), connected: boolean(n, "Connected")}
		}
		if k, ok := ifs[ifKnown]; ok {
			kn := KnownNetwork{SSID: str(k, "Name"), Security: Security(str(k, "Type")), Hidden: boolean(k, "Hidden"), AutoConnect: boolean(k, "AutoConnect")}
			if t, err := time.Parse(time.RFC3339, str(k, "LastConnectedTime")); err == nil {
				kn.LastConnected = t.UTC()
			}
			s.known[p] = kn
		}
	}
	return s
}

func (s *snapshot) status() *Status {
	st := &Status{}
	for _, a := range s.adapters {
		st.Adapters = append(st.Adapters, a)
	}
	slices.SortFunc(st.Adapters, func(a, b Adapter) int { return strings.Compare(a.Name, b.Name) })
	for _, d := range s.devices {
		dev := Device{Interface: d.name, Adapter: s.adapters[dbus.ObjectPath(d.adapter)].Name, Powered: d.powered, Mode: d.mode}
		if d.station {
			dev.Station = &Station{State: d.state, Scanning: d.scanning}
			if n, ok := s.networks[d.connected]; ok {
				v := n.public()
				dev.Station.Connected = &v
			}
		}
		st.Devices = append(st.Devices, dev)
	}
	slices.SortFunc(st.Devices, func(a, b Device) int { return strings.Compare(a.Interface, b.Interface) })
	for _, k := range s.known {
		st.Known = append(st.Known, k)
	}
	slices.SortFunc(st.Known, func(a, b KnownNetwork) int {
		if c := strings.Compare(a.SSID, b.SSID); c != 0 {
			return c
		}
		return strings.Compare(string(a.Security), string(b.Security))
	})
	return st
}

func (s *snapshot) knownOf(ssid string, sec Security) *KnownNetwork {
	for _, k := range s.known {
		if k.SSID == ssid && k.Security == sec {
			return &k
		}
	}
	return nil
}

// find returns the station's network j names: of j's kind when it has one, else the psk one when a passphrase was
// given and the open one when not (a name may be both).
func (s *snapshot) find(station dbus.ObjectPath, j Join) *networkObj {
	var match []networkObj
	for _, n := range s.networks {
		if n.device == station && n.name == j.SSID {
			match = append(match, n)
		}
	}
	if len(match) == 0 {
		return nil
	}
	want := j.Security
	if want == "" && len(match) > 1 {
		want = j.securityOf()
	}
	for _, n := range match {
		if want == "" || n.security == want {
			return &n
		}
	}
	return nil
}
