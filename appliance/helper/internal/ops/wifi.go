package ops

import (
	"context"
	"errors"
	"net"
	"os"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/proto"
	"github.com/CybexBV/whombat/appliance/helper/pkg/wifi"
)

// The Wi-Fi operations (NX-244, NX-245): iwd through helper/pkg/wifi, profiles in Config.WifiDir. A join or forget
// records what it changes (the network's profile as it was, the network the station was on) in the helper's state
// before it changes anything, so wifi-revert, a restarted helper and the dead-man can put it back.

// WifiChange is a Wi-Fi change the helper made and may still undo.
type WifiChange struct {
	ID        string        `json:"id"`
	Kind      string        `json:"kind"` // join | forget
	SSID      string        `json:"ssid"`
	Security  wifi.Security `json:"security"`
	Interface string        `json:"interface"`
	// HadProfile and Profile: the network's profile file before the change (it holds the saved passphrase; the
	// state file is root's, 0600, in a 0700 directory, and the copy goes when the change is kept or undone).
	HadProfile bool   `json:"hadProfile,omitempty"`
	Profile    []byte `json:"profile,omitempty"`
	// Previous and PreviousSecurity: the network the station was on before ("" none).
	Previous         string        `json:"previous,omitempty"`
	PreviousSecurity wifi.Security `json:"previousSecurity,omitempty"`
	// Armed: the dead-man is armed for it (a guarded change).
	Armed bool `json:"armed,omitempty"`
}

const (
	defaultWifiJoinTimeout = 45 * time.Second
	defaultWifiAddrWait    = 30 * time.Second
	wifiScanTimeout        = 10 * time.Second
	wifiStatusTimeout      = 5 * time.Second
	// The dead-man fires this long after a guarded change's deadline: the manager reverts first when it is alive.
	wifiDeadmanSlack = 30
)

// deadmanAfter is when the dead-man of a guarded change fires: the join's own time (connecting and the address) and
// the manager's deadline, which starts once the join is done, then the slack (NX-245).
func (h *Helper) deadmanAfter(deadlineSec int) int {
	return int((h.wifiJoinTimeout() + h.wifiAddrWait()).Seconds()) + deadlineSec + wifiDeadmanSlack
}

func (h *Helper) wifiJoinTimeout() time.Duration {
	if h.cfg.WifiJoinTimeout > 0 {
		return h.cfg.WifiJoinTimeout
	}
	return defaultWifiJoinTimeout
}

func (h *Helper) wifiAddrWait() time.Duration {
	if h.cfg.WifiAddrWait > 0 {
		return h.cfg.WifiAddrWait
	}
	return defaultWifiAddrWait
}

// InterfaceAddress returns an interface's first usable address (IPv4 that isn't link-local, else global IPv6), "" when
// none: what networkd gives a joined network.
func InterfaceAddress(iface string) string {
	ifc, err := net.InterfaceByName(iface)
	if err != nil {
		return ""
	}
	addrs, err := ifc.Addrs()
	if err != nil {
		return ""
	}
	var v6 string
	for _, a := range addrs {
		ipn, ok := a.(*net.IPNet)
		if !ok || ipn.IP.IsLinkLocalUnicast() || ipn.IP.IsLoopback() {
			continue
		}
		if ipn.IP.To4() != nil {
			return ipn.IP.String()
		}
		if v6 == "" && ipn.IP.IsGlobalUnicast() {
			v6 = ipn.IP.String()
		}
	}
	return v6
}

func (h *Helper) address(iface string) string {
	if h.cfg.WifiAddr != nil {
		return h.cfg.WifiAddr(iface)
	}
	return InterfaceAddress(iface)
}

// wifiErr maps a Client error to the operation's failure code.
func wifiErr(err error) *proto.Error {
	switch {
	case errors.Is(err, wifi.ErrNoIwd), errors.Is(err, wifi.ErrNoStation):
		return fail(proto.CodeNoWifi, "%v", err)
	case errors.Is(err, wifi.ErrWrongPassword):
		return fail(proto.CodeWrongPassword, "%v", err)
	case errors.Is(err, wifi.ErrNotFound):
		return fail(proto.CodeNetworkNotFound, "%v", err)
	case errors.Is(err, wifi.ErrNotSupported):
		return fail(proto.CodeNotSupported, "%v", err)
	case errors.Is(err, wifi.ErrInvalidPassphrase):
		return fail(proto.CodeInvalidPassphrase, "%v", err)
	case errors.Is(err, wifi.ErrBadSSID):
		return fail(proto.CodeBadRequest, "%v", err)
	}
	return fail(proto.CodeWifiFailed, "%v", err)
}

// wifiStatus answers wifi-status (read-only; runs beside other operations).
func (h *Helper) wifiStatus(ctx context.Context) (*proto.Result, *proto.Error) {
	if h.cfg.Wifi == nil {
		return nil, fail(proto.CodeNoWifi, "this helper has no Wi-Fi")
	}
	ctx, cancel := context.WithTimeout(ctx, wifiStatusTimeout)
	defer cancel()
	st, err := h.cfg.Wifi.Status(ctx)
	if err != nil {
		return nil, wifiErr(err)
	}
	out := statusOf(st)
	// The pending change, read without the operation lock (a join may be running): the state file is replaced
	// atomically, so this is the state before or after it.
	if s, err := loadState(h.cfg.StateDir); err == nil && s.Wifi.Pending != nil {
		out.Pending = s.Wifi.Pending.ID
	}
	return &proto.Result{Wifi: &proto.WifiResult{Status: out}}, nil
}

func statusOf(st *wifi.Status) *proto.WifiStatus {
	out := &proto.WifiStatus{Adapters: []proto.WifiAdapter{}, Saved: []proto.WifiSaved{}}
	for _, a := range st.Adapters {
		out.Adapters = append(out.Adapters, proto.WifiAdapter{Name: a.Name, Powered: a.Powered})
	}
	if d := st.Station(); d != nil {
		out.Interface, out.State = d.Interface, string(d.Station.State)
		if c := d.Station.Connected; c != nil {
			n := networkOf(*c)
			out.Connected = &n
		}
	}
	for _, k := range st.Known {
		out.Saved = append(out.Saved, proto.WifiSaved{SSID: k.SSID, Security: string(k.Security), Hidden: k.Hidden})
	}
	return out
}

func networkOf(n wifi.Network) proto.WifiNetwork {
	return proto.WifiNetwork{SSID: n.SSID, Security: string(n.Security), SignalDBm: n.SignalDBm, Known: n.Known, Connected: n.Connected}
}

// station returns the station's interface and what it is connected to.
func (h *Helper) station(ctx context.Context) (*wifi.Status, *wifi.Device, *proto.Error) {
	st, err := h.cfg.Wifi.Status(ctx)
	if err != nil {
		return nil, nil, wifiErr(err)
	}
	d := st.Station()
	if d == nil {
		return nil, nil, fail(proto.CodeNoWifi, "no Wi-Fi station")
	}
	return st, d, nil
}

// wifiScan answers wifi-scan (read-only; runs beside other operations): a fresh scan, at most 10 s.
func (h *Helper) wifiScan(ctx context.Context) (*proto.Result, *proto.Error) {
	if h.cfg.Wifi == nil {
		return nil, fail(proto.CodeNoWifi, "this helper has no Wi-Fi")
	}
	ctx, cancel := context.WithTimeout(ctx, wifiScanTimeout+wifiStatusTimeout)
	defer cancel()
	_, d, perr := h.station(ctx)
	if perr != nil {
		return nil, perr
	}
	sctx, scancel := context.WithTimeout(ctx, wifiScanTimeout)
	ns, err := h.cfg.Wifi.Scan(sctx, d.Interface)
	scancel()
	if err != nil {
		// No fresh scan in time (or iwd refused one): the last scan's networks.
		if ns, err = h.cfg.Wifi.Networks(ctx, d.Interface); err != nil {
			return nil, wifiErr(err)
		}
	}
	out := []proto.WifiNetwork{}
	for _, n := range ns {
		out = append(out, networkOf(n))
	}
	return &proto.Result{Wifi: &proto.WifiResult{Networks: out}}, nil
}

// pendingFor checks that no other change is pending; it returns the pending change when it is this one.
func pendingFor(st *State, id string) (*WifiChange, *proto.Error) {
	p := st.Wifi.Pending
	if p == nil {
		return nil, nil
	}
	if p.ID == id {
		return p, nil
	}
	return nil, fail(proto.CodeWifiPending, "Wi-Fi change %s is still pending; confirm or revert it first", p.ID)
}

// joinSecurity finds the kind of network a join names: the scan's (a fresh scan when the last one doesn't have it),
// or for a hidden network psk with a passphrase and open without.
func (h *Helper) joinSecurity(ctx context.Context, iface string, req proto.Request) (wifi.Security, *proto.Error) {
	want := wifi.Join{SSID: req.SSID, Passphrase: req.Passphrase, Hidden: req.Hidden}
	pick := func(ns []wifi.Network) wifi.Security {
		var found []wifi.Security
		for _, n := range ns {
			if n.SSID == req.SSID {
				found = append(found, n.Security)
			}
		}
		if len(found) == 1 {
			return found[0]
		}
		for _, s := range found { // the name is both: psk with a passphrase, open without
			if (s == wifi.SecurityPSK) == (req.Passphrase != "") {
				return s
			}
		}
		if len(found) > 0 {
			return found[0]
		}
		return ""
	}
	ns, _ := h.cfg.Wifi.Networks(ctx, iface)
	if sec := pick(ns); sec != "" {
		return sec, nil
	}
	sctx, cancel := context.WithTimeout(ctx, wifiScanTimeout)
	ns, err := h.cfg.Wifi.Scan(sctx, iface)
	cancel()
	if sec := pick(ns); err == nil && sec != "" {
		return sec, nil
	}
	if req.Hidden {
		if want.Passphrase != "" {
			return wifi.SecurityPSK, nil
		}
		return wifi.SecurityOpen, nil
	}
	return "", fail(proto.CodeNetworkNotFound, "no network %q in range", req.SSID)
}

// wifiJoin joins a network; a guarded join (deadlineSec > 0) stays pending until wifi-confirm or wifi-revert.
func (h *Helper) wifiJoin(ctx context.Context, st *State, req proto.Request) (*proto.Result, *proto.Error) {
	if h.cfg.Wifi == nil {
		return nil, fail(proto.CodeNoWifi, "this helper has no Wi-Fi")
	}
	if p, perr := pendingFor(st, req.ChangeID); perr != nil {
		return nil, perr
	} else if p != nil {
		return &proto.Result{AlreadyDone: true, Wifi: &proto.WifiResult{Pending: p.ID, Previous: p.Previous}}, nil
	}
	_, d, perr := h.station(ctx)
	if perr != nil {
		return nil, perr
	}
	sec, perr := h.joinSecurity(ctx, d.Interface, req)
	if perr != nil {
		return nil, perr
	}
	if !sec.Joinable() {
		return nil, fail(proto.CodeNotSupported, "%q is a %s network", req.SSID, sec)
	}
	c := &WifiChange{ID: req.ChangeID, Kind: "join", SSID: req.SSID, Security: sec, Interface: d.Interface}
	if perr := h.recordBefore(c, d); perr != nil {
		return nil, perr
	}
	if perr := h.begin(ctx, st, c, req.DeadlineSec); perr != nil {
		return nil, perr
	}
	jctx, cancel := context.WithTimeout(ctx, h.wifiJoinTimeout())
	err := h.cfg.Wifi.Connect(jctx, d.Interface, wifi.Join{SSID: req.SSID, Passphrase: req.Passphrase, Hidden: req.Hidden, Security: sec})
	cancel()
	var perrJoin *proto.Error
	if err != nil {
		perrJoin = wifiErr(err)
	} else if !h.waitAddress(ctx, d.Interface) {
		perrJoin = fail(proto.CodeNoAddress, "joined %q but got no address", req.SSID)
	}
	if perrJoin != nil {
		h.undoWifi(ctx, st, c)
		return nil, perrJoin
	}
	return h.settle(ctx, st, c)
}

// wifiForget forgets a saved network; a guarded forget (deadlineSec > 0) stays pending like a join.
func (h *Helper) wifiForget(ctx context.Context, st *State, req proto.Request) (*proto.Result, *proto.Error) {
	if h.cfg.Wifi == nil {
		return nil, fail(proto.CodeNoWifi, "this helper has no Wi-Fi")
	}
	if p, perr := pendingFor(st, req.ChangeID); perr != nil {
		return nil, perr
	} else if p != nil {
		return &proto.Result{AlreadyDone: true, Wifi: &proto.WifiResult{Pending: p.ID, Previous: p.Previous}}, nil
	}
	ws, d, perr := h.station(ctx)
	if perr != nil {
		return nil, perr
	}
	// The saved network of that name: the connected one's kind first, then psk, open, 8021x.
	var sec wifi.Security
	order := []wifi.Security{wifi.SecurityPSK, wifi.SecurityOpen, wifi.SecurityEAP}
	if cn := d.Station.Connected; cn != nil && cn.SSID == req.SSID {
		order = append([]wifi.Security{cn.Security}, order...)
	}
	for _, s := range order {
		if ws.KnownOf(req.SSID, s) != nil {
			sec = s
			break
		}
	}
	if sec == "" {
		return nil, fail(proto.CodeNotSaved, "%q is not saved", req.SSID)
	}
	c := &WifiChange{ID: req.ChangeID, Kind: "forget", SSID: req.SSID, Security: sec, Interface: d.Interface}
	if perr := h.recordBefore(c, d); perr != nil {
		return nil, perr
	}
	if !c.HadProfile {
		return nil, fail(proto.CodeWifiFailed, "the profile of %q can't be read", req.SSID)
	}
	if perr := h.begin(ctx, st, c, req.DeadlineSec); perr != nil {
		return nil, perr
	}
	if err := h.cfg.Wifi.Forget(ctx, req.SSID, sec); err != nil {
		h.undoWifi(ctx, st, c)
		if errors.Is(err, wifi.ErrNotFound) {
			return nil, fail(proto.CodeNotSaved, "%q is not saved", req.SSID)
		}
		return nil, wifiErr(err)
	}
	return h.settle(ctx, st, c)
}

// recordBefore notes the network's profile and the station's network before a change.
func (h *Helper) recordBefore(c *WifiChange, d *wifi.Device) *proto.Error {
	b, err := wifi.ReadProfile(h.cfg.WifiDir, c.SSID, c.Security)
	switch {
	case err == nil:
		c.HadProfile, c.Profile = true, b
	case !errors.Is(err, os.ErrNotExist):
		return fail(proto.CodeWifiFailed, "read the profile of %q: %v", c.SSID, err)
	}
	if cn := d.Station.Connected; cn != nil {
		c.Previous, c.PreviousSecurity = cn.SSID, cn.Security
	}
	return nil
}

// begin arms the dead-man for a guarded change (before anything changes) and records the change.
func (h *Helper) begin(ctx context.Context, st *State, c *WifiChange, deadlineSec int) *proto.Error {
	if deadlineSec > 0 {
		if err := h.act.ArmWifiRevert(ctx, h.deadmanAfter(deadlineSec)); err != nil {
			return fail(proto.CodeActivationFailed, "arm the Wi-Fi dead-man: %v", err)
		}
		c.Armed = true
	}
	st.Wifi.Pending = c
	if err := saveState(h.cfg.StateDir, st); err != nil {
		if c.Armed {
			_ = h.act.DisarmWifiRevert(ctx)
		}
		st.Wifi.Pending = nil
		return fail(proto.CodeInternal, "%v", err)
	}
	return nil
}

// settle answers a change that worked: a guarded one stays pending, an unguarded one is kept now.
func (h *Helper) settle(ctx context.Context, st *State, c *WifiChange) (*proto.Result, *proto.Error) {
	res := &proto.WifiResult{Previous: c.Previous}
	if c.Armed {
		res.Pending = c.ID
	} else {
		st.Wifi.Pending = nil
		if err := saveState(h.cfg.StateDir, st); err != nil {
			return nil, fail(proto.CodeInternal, "%v", err)
		}
	}
	if ws, err := h.cfg.Wifi.Status(ctx); err == nil {
		res.Status = statusOf(ws)
		res.Status.Pending = res.Pending
	}
	return &proto.Result{Wifi: res}, nil
}

// waitAddress waits until the interface has an address (networkd's DHCP or router advertisement). Elapsed time, not
// Config.Now: that clock may stand still (tests) or jump.
func (h *Helper) waitAddress(ctx context.Context, iface string) bool {
	wait := h.wifiAddrWait()
	ctx, cancel := context.WithTimeout(ctx, wait)
	defer cancel()
	for {
		if h.address(iface) != "" {
			return true
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(min(250*time.Millisecond, wait/10)):
		}
	}
}

// wifiConfirm keeps a guarded change (the manager reached control on it).
func (h *Helper) wifiConfirm(ctx context.Context, st *State, id string) (*proto.Result, *proto.Error) {
	p := st.Wifi.Pending
	if p == nil {
		return &proto.Result{AlreadyDone: true, Wifi: &proto.WifiResult{}}, nil
	}
	if p.ID != id {
		return nil, fail(proto.CodeWifiPending, "Wi-Fi change %s is pending, not %s", p.ID, id)
	}
	_ = h.act.DisarmWifiRevert(ctx)
	st.Wifi.Pending = nil
	if err := saveState(h.cfg.StateDir, st); err != nil {
		return nil, fail(proto.CodeInternal, "%v", err)
	}
	return &proto.Result{Wifi: &proto.WifiResult{Previous: p.Previous}}, nil
}

// wifiRevert undoes a pending change (the manager couldn't reach control before the deadline).
func (h *Helper) wifiRevert(ctx context.Context, st *State, id string) (*proto.Result, *proto.Error) {
	p := st.Wifi.Pending
	if p == nil {
		return &proto.Result{AlreadyDone: true, Wifi: &proto.WifiResult{}}, nil
	}
	if p.ID != id {
		return nil, fail(proto.CodeWifiPending, "Wi-Fi change %s is pending, not %s", p.ID, id)
	}
	h.undoWifi(ctx, st, p)
	res := &proto.WifiResult{Previous: p.Previous}
	if ws, err := h.cfg.Wifi.Status(ctx); err == nil {
		res.Status = statusOf(ws)
	}
	return &proto.Result{Wifi: res}, nil
}

// undoWifi puts a change back: the network's profile as it was (a joined network that wasn't saved is forgotten), the
// station back on the network it was on, the dead-man disarmed and the change dropped. Each step is best effort: iwd's
// autoconnect also goes back to a saved network in range.
func (h *Helper) undoWifi(ctx context.Context, st *State, c *WifiChange) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), h.wifiJoinTimeout()+wifiStatusTimeout)
	defer cancel()
	if h.cfg.Wifi != nil {
		switch {
		case c.HadProfile:
			_ = wifi.WriteProfileData(h.cfg.WifiDir, c.SSID, c.Security, c.Profile)
		default:
			if err := h.cfg.Wifi.Forget(ctx, c.SSID, c.Security); err != nil {
				_ = wifi.RemoveProfile(h.cfg.WifiDir, c.SSID, c.Security)
			}
		}
		if c.Previous != "" && (c.Previous != c.SSID || c.PreviousSecurity != c.Security || c.Kind == "forget") {
			if ws, err := h.cfg.Wifi.Status(ctx); err == nil {
				if d := ws.Station(); d != nil && !on(d, c.Previous, c.PreviousSecurity) {
					_ = h.cfg.Wifi.Connect(ctx, d.Interface, wifi.Join{SSID: c.Previous, Security: c.PreviousSecurity})
				}
			}
		}
	}
	if c.Armed {
		_ = h.act.DisarmWifiRevert(ctx)
	}
	st.Wifi.Pending = nil
	_ = saveState(h.cfg.StateDir, st)
}

func on(d *wifi.Device, ssid string, sec wifi.Security) bool {
	cn := d.Station.Connected
	return cn != nil && cn.SSID == ssid && cn.Security == sec && d.Station.State != wifi.StateDisconnecting
}

// RevertWifiDeadman is run by the Wi-Fi dead-man timer (root, no socket): it undoes the pending change.
func (h *Helper) RevertWifiDeadman(ctx context.Context) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	st, err := loadState(h.cfg.StateDir)
	if err != nil {
		return err
	}
	if st.Wifi.Pending == nil {
		return nil
	}
	h.undoWifi(ctx, st, st.Wifi.Pending)
	return nil
}
