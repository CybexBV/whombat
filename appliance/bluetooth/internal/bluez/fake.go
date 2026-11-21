package bluez

import (
	"context"
	"slices"
	"sync"
)

// Fake is an in-process BlueZ for tests: its adapters and devices, what the service called, and a script per device
// for Pair (it plays the remote side: calls the registered agent and returns what BlueZ would).
type Fake struct {
	mu       sync.Mutex
	adapters []Adapter
	devices  []Device
	agent    Agent
	// Scripts: Pair of the device at that path. Without one, Pair pairs at once (Just Works).
	scripts map[string]func(ctx context.Context, a Agent) error
	// Errors: the next call of that method (e.g. "Connect") on any object fails with this.
	errs  map[string]error
	calls []string
	// Down: every call answers ErrNoBlueZ.
	Down bool
}

var _ BlueZ = (*Fake)(nil)

// NewFake is a fake with these adapters and devices.
func NewFake(adapters []Adapter, devices []Device) *Fake {
	return &Fake{
		adapters: slices.Clone(adapters),
		devices:  slices.Clone(devices),
		scripts:  map[string]func(context.Context, Agent) error{},
		errs:     map[string]error{},
	}
}

// Script sets what pairing the device at path does.
func (f *Fake) Script(path string, s func(ctx context.Context, a Agent) error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.scripts[path] = s
}

// Fail makes the next call of method fail with err.
func (f *Fake) Fail(method string, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.errs[method] = err
}

// Calls is what the service called, in order ("Pair /org/bluez/hci0/dev_…").
func (f *Fake) Calls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.calls)
}

// Agent is the registered agent (nil when none).
func (f *Fake) Agent() Agent {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.agent
}

// Update changes the device at path (or the adapter, when path is an adapter's).
func (f *Fake) Update(path string, dev func(*Device), ad func(*Adapter)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := range f.devices {
		if f.devices[i].Path == path && dev != nil {
			dev(&f.devices[i])
		}
	}
	for i := range f.adapters {
		if f.adapters[i].Path == path && ad != nil {
			ad(&f.adapters[i])
		}
	}
}

// Add adds a device (one the adapter has just seen).
func (f *Fake) Add(d Device) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.devices = append(f.devices, d)
}

func (f *Fake) begin(call, path string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, call+" "+path)
	if f.Down {
		return ErrNoBlueZ
	}
	if err, ok := f.errs[call]; ok {
		delete(f.errs, call)
		return err
	}
	return nil
}

func (f *Fake) device(path string) *Device {
	for i := range f.devices {
		if f.devices[i].Path == path {
			return &f.devices[i]
		}
	}
	return nil
}

func (f *Fake) adapter(path string) *Adapter {
	for i := range f.adapters {
		if f.adapters[i].Path == path {
			return &f.adapters[i]
		}
	}
	return nil
}

// Objects implements BlueZ.
func (f *Fake) Objects(context.Context) (Objects, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.Down {
		return Objects{}, ErrNoBlueZ
	}
	return Objects{Adapters: slices.Clone(f.adapters), Devices: slices.Clone(f.devices)}, nil
}

// StartDiscovery implements BlueZ.
func (f *Fake) StartDiscovery(_ context.Context, adapter string) error {
	if err := f.begin("StartDiscovery", adapter); err != nil {
		return err
	}
	f.Update(adapter, nil, func(a *Adapter) { a.Discovering = true })
	return nil
}

// StopDiscovery implements BlueZ: like BlueZ, it forgets every device's RSSI.
func (f *Fake) StopDiscovery(_ context.Context, adapter string) error {
	if err := f.begin("StopDiscovery", adapter); err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if a := f.adapter(adapter); a != nil {
		a.Discovering = false
	}
	for i := range f.devices {
		f.devices[i].RSSI = nil
	}
	return nil
}

// Pair implements BlueZ: the device's script, then the device is paired and bonded.
func (f *Fake) Pair(ctx context.Context, device string) error {
	if err := f.begin("Pair", device); err != nil {
		return err
	}
	f.mu.Lock()
	d := f.device(device)
	script, agent := f.scripts[device], f.agent
	f.mu.Unlock()
	if d == nil {
		return ErrNoObject
	}
	if script != nil {
		if err := script(ctx, agent); err != nil {
			return err
		}
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	f.Update(device, func(d *Device) { d.Paired, d.Bonded = true, true }, nil)
	return nil
}

// CancelPairing implements BlueZ.
func (f *Fake) CancelPairing(_ context.Context, device string) error {
	return f.begin("CancelPairing", device)
}

// SetTrusted implements BlueZ.
func (f *Fake) SetTrusted(_ context.Context, device string, trusted bool) error {
	if err := f.begin("SetTrusted", device); err != nil {
		return err
	}
	f.Update(device, func(d *Device) { d.Trusted = trusted }, nil)
	return nil
}

// Connect implements BlueZ.
func (f *Fake) Connect(_ context.Context, device string) error {
	if err := f.begin("Connect", device); err != nil {
		return err
	}
	f.Update(device, func(d *Device) { d.Connected = true }, nil)
	return nil
}

// Disconnect implements BlueZ.
func (f *Fake) Disconnect(_ context.Context, device string) error {
	if err := f.begin("Disconnect", device); err != nil {
		return err
	}
	f.Update(device, func(d *Device) { d.Connected = false }, nil)
	return nil
}

// RemoveDevice implements BlueZ.
func (f *Fake) RemoveDevice(_ context.Context, adapter, device string) error {
	if err := f.begin("RemoveDevice", device); err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.adapter(adapter) == nil || f.device(device) == nil {
		return ErrNoObject
	}
	f.devices = slices.DeleteFunc(f.devices, func(d Device) bool { return d.Path == device })
	return nil
}

// RegisterAgent implements BlueZ.
func (f *Fake) RegisterAgent(_ context.Context, a Agent) error {
	if err := f.begin("RegisterAgent", capability); err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.agent = a
	return nil
}

// UnregisterAgent implements BlueZ.
func (f *Fake) UnregisterAgent(context.Context) error {
	if err := f.begin("UnregisterAgent", ""); err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.agent = nil
	return nil
}
