package bluez

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"

	"github.com/godbus/dbus/v5"
)

// DefaultBus is the system bus's socket on NixOS.
const DefaultBus = "unix:path=/run/dbus/system_bus_socket"

const (
	service        = "org.bluez"
	ifAdapter      = "org.bluez.Adapter1"
	ifDevice       = "org.bluez.Device1"
	ifBattery      = "org.bluez.Battery1"
	ifAgent        = "org.bluez.Agent1"
	ifAgentManager = "org.bluez.AgentManager1"
	ifProperties   = "org.freedesktop.DBus.Properties"
	agentManager   = dbus.ObjectPath("/org/bluez")
	agentPath      = dbus.ObjectPath("/com/whombat/bluetooth/agent")
	// BT-04: codes shown, a number confirmed, nothing typed into the box.
	capability = "DisplayYesNo"
)

// DBus is BlueZ over the system bus. It keeps one connection: BlueZ ties a client's discovery and its agent to it, so
// both end when the connection does (and when this process does).
type DBus struct {
	// Bus is the system bus address; "" is DefaultBus.
	Bus string

	mu    sync.Mutex
	conn  *dbus.Conn
	agent *agentObject
}

var _ BlueZ = (*DBus)(nil)

// Close drops the connection (BlueZ stops this client's discovery and forgets its agent).
func (b *DBus) Close() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.conn == nil {
		return nil
	}
	err := b.conn.Close()
	b.conn = nil
	return err
}

func (b *DBus) connection(ctx context.Context) (*dbus.Conn, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.conn != nil && b.conn.Connected() {
		return b.conn, nil
	}
	bus := b.Bus
	if bus == "" {
		bus = DefaultBus
	}
	conn, err := dbus.Connect(bus, dbus.WithContext(context.WithoutCancel(ctx)))
	if err != nil {
		return nil, fmt.Errorf("%w: the system bus: %v", ErrNoBlueZ, err)
	}
	b.conn, b.agent = conn, nil
	return conn, nil
}

func (b *DBus) call(ctx context.Context, path, method string, args ...any) *dbus.Call {
	conn, err := b.connection(ctx)
	if err != nil {
		return &dbus.Call{Err: err}
	}
	return conn.Object(service, dbus.ObjectPath(path)).CallWithContext(ctx, method, 0, args...)
}

// Objects implements BlueZ.
func (b *DBus) Objects(ctx context.Context) (Objects, error) {
	var objs map[dbus.ObjectPath]map[string]map[string]dbus.Variant
	if err := b.call(ctx, "/", "org.freedesktop.DBus.ObjectManager.GetManagedObjects").Store(&objs); err != nil {
		return Objects{}, mapErr(err)
	}
	return parseObjects(objs), nil
}

// StartDiscovery implements BlueZ.
func (b *DBus) StartDiscovery(ctx context.Context, adapter string) error {
	filter := map[string]dbus.Variant{
		"Transport":     dbus.MakeVariant("auto"),
		"DuplicateData": dbus.MakeVariant(false),
	}
	if err := b.call(ctx, adapter, ifAdapter+".SetDiscoveryFilter", filter).Err; err != nil {
		return mapErr(err)
	}
	err := mapErr(b.call(ctx, adapter, ifAdapter+".StartDiscovery").Err)
	if ErrorName(err) == ErrorInProgress {
		return nil // this client is looking already
	}
	return err
}

// StopDiscovery implements BlueZ.
func (b *DBus) StopDiscovery(ctx context.Context, adapter string) error {
	err := mapErr(b.call(ctx, adapter, ifAdapter+".StopDiscovery").Err)
	if n := ErrorName(err); n == ErrorFailed || n == ErrorNotReady {
		return nil // “No discovery started”: this client wasn't looking
	}
	return err
}

// Pair implements BlueZ.
func (b *DBus) Pair(ctx context.Context, device string) error {
	return mapErr(b.call(ctx, device, ifDevice+".Pair").Err)
}

// CancelPairing implements BlueZ.
func (b *DBus) CancelPairing(ctx context.Context, device string) error {
	return mapErr(b.call(ctx, device, ifDevice+".CancelPairing").Err)
}

// SetTrusted implements BlueZ.
func (b *DBus) SetTrusted(ctx context.Context, device string, trusted bool) error {
	return mapErr(b.call(ctx, device, ifProperties+".Set", ifDevice, "Trusted", dbus.MakeVariant(trusted)).Err)
}

// Connect implements BlueZ.
func (b *DBus) Connect(ctx context.Context, device string) error {
	err := mapErr(b.call(ctx, device, ifDevice+".Connect").Err)
	if ErrorName(err) == ErrorAlreadyConnected {
		return nil
	}
	return err
}

// Disconnect implements BlueZ.
func (b *DBus) Disconnect(ctx context.Context, device string) error {
	return mapErr(b.call(ctx, device, ifDevice+".Disconnect").Err)
}

// RemoveDevice implements BlueZ.
func (b *DBus) RemoveDevice(ctx context.Context, adapter, device string) error {
	return mapErr(b.call(ctx, adapter, ifAdapter+".RemoveDevice", dbus.ObjectPath(device)).Err)
}

// RegisterAgent implements BlueZ: the agent answers bluetoothd only (its unique name, read now).
func (b *DBus) RegisterAgent(ctx context.Context, a Agent) error {
	conn, err := b.connection(ctx)
	if err != nil {
		return err
	}
	var owner string
	if err := conn.BusObject().CallWithContext(ctx, "org.freedesktop.DBus.GetNameOwner", 0, service).Store(&owner); err != nil {
		return mapErr(err)
	}
	b.mu.Lock()
	if b.agent == nil {
		b.agent = &agentObject{}
		if err := conn.Export(b.agent, agentPath, ifAgent); err != nil {
			b.mu.Unlock()
			return fmt.Errorf("bluez: agent: %w", err)
		}
	}
	b.agent.set(a, owner)
	b.mu.Unlock()
	am := conn.Object(service, agentManager)
	if err := am.CallWithContext(ctx, ifAgentManager+".RegisterAgent", 0, agentPath, capability).Err; err != nil {
		if mapped := mapErr(err); ErrorName(mapped) != ErrorAlreadyExists {
			return mapped
		}
	}
	return mapErr(am.CallWithContext(ctx, ifAgentManager+".RequestDefaultAgent", 0, agentPath).Err)
}

// UnregisterAgent implements BlueZ: BlueZ forgets the agent, and the object answers nobody any more.
func (b *DBus) UnregisterAgent(ctx context.Context) error {
	b.mu.Lock()
	ag, conn := b.agent, b.conn
	b.mu.Unlock()
	if ag != nil {
		ag.set(nil, "")
	}
	if conn == nil || !conn.Connected() {
		return nil
	}
	err := mapErr(conn.Object(service, agentManager).CallWithContext(ctx, ifAgentManager+".UnregisterAgent", 0, agentPath).Err)
	if ErrorName(err) == ErrorDoesNotExist {
		return nil
	}
	return err
}

// mapErr turns a call's error into ErrNoBlueZ, ErrNoObject or an *Error.
func mapErr(err error) error {
	if err == nil {
		return nil
	}
	var de dbus.Error
	if !errors.As(err, &de) {
		if errors.Is(err, ErrNoBlueZ) || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return err
		}
		return fmt.Errorf("bluez: %w", err)
	}
	switch de.Name {
	case "org.freedesktop.DBus.Error.ServiceUnknown", "org.freedesktop.DBus.Error.NameHasNoOwner",
		"org.freedesktop.DBus.Error.Disconnected", "org.freedesktop.DBus.Error.AccessDenied":
		return fmt.Errorf("%w (%s)", ErrNoBlueZ, de.Name)
	case "org.freedesktop.DBus.Error.UnknownObject", "org.freedesktop.DBus.Error.UnknownMethod":
		return ErrNoObject
	}
	msg := ""
	if len(de.Body) > 0 {
		if s, ok := de.Body[0].(string); ok {
			msg = s
		}
	}
	if de.Name == ErrorDoesNotExist {
		return fmt.Errorf("%w: %s", ErrNoObject, &Error{Name: de.Name, Message: msg})
	}
	return &Error{Name: de.Name, Message: msg}
}

// parseObjects reads GetManagedObjects' answer; adapters and devices sorted by path (hci0 first).
func parseObjects(objs map[dbus.ObjectPath]map[string]map[string]dbus.Variant) Objects {
	var out Objects
	for path, ifs := range objs {
		if p, ok := ifs[ifAdapter]; ok {
			out.Adapters = append(out.Adapters, Adapter{
				Path:        string(path),
				Address:     strings.ToUpper(str(p, "Address")),
				Alias:       str(p, "Alias"),
				Powered:     boolean(p, "Powered"),
				Discovering: boolean(p, "Discovering"),
				PowerState:  str(p, "PowerState"),
			})
		}
		if p, ok := ifs[ifDevice]; ok {
			d := Device{
				Path:      string(path),
				Adapter:   string(objPath(p, "Adapter")),
				Address:   strings.ToUpper(str(p, "Address")),
				Name:      str(p, "Name"),
				Alias:     str(p, "Alias"),
				Icon:      str(p, "Icon"),
				Paired:    boolean(p, "Paired"),
				Bonded:    boolean(p, "Bonded"),
				Trusted:   boolean(p, "Trusted"),
				Blocked:   boolean(p, "Blocked"),
				Connected: boolean(p, "Connected"),
			}
			if v, ok := p["Class"].Value().(uint32); ok {
				d.Class = &v
			}
			if v, ok := p["Appearance"].Value().(uint16); ok {
				d.Appearance = &v
			}
			if v, ok := p["RSSI"].Value().(int16); ok {
				d.RSSI = &v
			}
			if b, ok := ifs[ifBattery]; ok {
				if v, ok := b["Percentage"].Value().(byte); ok {
					d.Battery = &v
				}
			}
			out.Devices = append(out.Devices, d)
		}
	}
	sort.Slice(out.Adapters, func(i, j int) bool { return out.Adapters[i].Path < out.Adapters[j].Path })
	sort.Slice(out.Devices, func(i, j int) bool { return out.Devices[i].Path < out.Devices[j].Path })
	return out
}

func str(p map[string]dbus.Variant, k string) string {
	s, _ := p[k].Value().(string)
	return s
}

func boolean(p map[string]dbus.Variant, k string) bool {
	b, _ := p[k].Value().(bool)
	return b
}

func objPath(p map[string]dbus.Variant, k string) dbus.ObjectPath {
	o, _ := p[k].Value().(dbus.ObjectPath)
	return o
}

// agentObject is the exported org.bluez.Agent1: it hands bluetoothd's requests to the service's Agent while one is
// set, and refuses everything from anyone but bluetoothd's unique name, and everything while none is set.
type agentObject struct {
	mu    sync.Mutex
	agent Agent
	owner string
}

func (o *agentObject) set(a Agent, owner string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.agent, o.owner = a, owner
}

func (o *agentObject) get(from dbus.Sender) Agent {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.agent == nil || string(from) != o.owner {
		return nil
	}
	return o.agent
}

func rejected() *dbus.Error {
	return dbus.NewError("org.bluez.Error.Rejected", []any{"rejected"})
}

func answer(err error) *dbus.Error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, ErrCanceled):
		return dbus.NewError("org.bluez.Error.Canceled", []any{"canceled"})
	}
	return rejected()
}

func (o *agentObject) Release(from dbus.Sender) *dbus.Error {
	if a := o.get(from); a != nil {
		a.Release()
	}
	return nil
}

func (o *agentObject) RequestPinCode(from dbus.Sender, device dbus.ObjectPath) (string, *dbus.Error) {
	a := o.get(from)
	if a == nil {
		return "", rejected()
	}
	pin, err := a.RequestPinCode(string(device))
	return pin, answer(err)
}

func (o *agentObject) DisplayPinCode(from dbus.Sender, device dbus.ObjectPath, pin string) *dbus.Error {
	a := o.get(from)
	if a == nil {
		return rejected()
	}
	return answer(a.DisplayPinCode(string(device), pin))
}

func (o *agentObject) RequestPasskey(from dbus.Sender, device dbus.ObjectPath) (uint32, *dbus.Error) {
	a := o.get(from)
	if a == nil {
		return 0, rejected()
	}
	k, err := a.RequestPasskey(string(device))
	return k, answer(err)
}

func (o *agentObject) DisplayPasskey(from dbus.Sender, device dbus.ObjectPath, passkey uint32, entered uint16) *dbus.Error {
	if a := o.get(from); a != nil {
		a.DisplayPasskey(string(device), passkey, entered)
	}
	return nil
}

func (o *agentObject) RequestConfirmation(from dbus.Sender, device dbus.ObjectPath, passkey uint32) *dbus.Error {
	a := o.get(from)
	if a == nil {
		return rejected()
	}
	return answer(a.RequestConfirmation(string(device), passkey))
}

func (o *agentObject) RequestAuthorization(from dbus.Sender, device dbus.ObjectPath) *dbus.Error {
	a := o.get(from)
	if a == nil {
		return rejected()
	}
	return answer(a.RequestAuthorization(string(device)))
}

func (o *agentObject) AuthorizeService(from dbus.Sender, device dbus.ObjectPath, uuid string) *dbus.Error {
	a := o.get(from)
	if a == nil {
		return rejected()
	}
	return answer(a.AuthorizeService(string(device), uuid))
}

func (o *agentObject) Cancel(from dbus.Sender) *dbus.Error {
	if a := o.get(from); a != nil {
		a.Cancel()
	}
	return nil
}
