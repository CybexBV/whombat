package netguard

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/proto"
	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// The network state (MG-101; local networkState, contracts 0.102.0 and 3.13.0): the wired interfaces from sysfs and
// their addresses, the Wi-Fi card from the helper's wifi-status, whether the box is online (online.go), the Wi-Fi
// change, whether the box uses Wi-Fi only (the helper's cable-status) and the cable change.
// Every display string is cleaned (local.HostText); a network whose name isn't displayable is left out of the lists.

const (
	maxWired = 8
	maxSaved = 32
	maxScan  = 64
	// stateWait bounds the network state's parts (the runtime gives it 2 s in all).
	stateHelperWait = 1500 * time.Millisecond
	stateOnlineWait = time.Second
)

func (g *Guard) sys(p ...string) string {
	root := g.Sys
	if root == "" {
		root = "/sys"
	}
	return filepath.Join(append([]string{root}, p...)...)
}

func (g *Guard) addr(iface string) string {
	a, _ := g.addrPrefix(iface)
	return a
}

// addrPrefix is an interface's address and its prefix length (0: unknown).
func (g *Guard) addrPrefix(iface string) (string, int) {
	if g.Addr != nil {
		a, p := g.Addr(iface), 0
		if a != "" && g.Prefix != nil {
			p = g.Prefix(iface)
		}
		return a, p
	}
	return InterfaceAddressPrefix(iface)
}

// InterfaceAddress returns an interface's first usable address: IPv4 that isn't link-local, else global IPv6; "" none.
func InterfaceAddress(iface string) string {
	a, _ := InterfaceAddressPrefix(iface)
	return a
}

// InterfaceAddressPrefix is InterfaceAddress with the prefix length of its network (what a router reservation and the
// Network section need: is the Wi-Fi's network the cable's?).
func InterfaceAddressPrefix(iface string) (string, int) {
	ifc, err := net.InterfaceByName(iface)
	if err != nil {
		return "", 0
	}
	addrs, err := ifc.Addrs()
	if err != nil {
		return "", 0
	}
	var v6 *net.IPNet
	for _, a := range addrs {
		ipn, ok := a.(*net.IPNet)
		if !ok || ipn.IP.IsLinkLocalUnicast() || ipn.IP.IsLoopback() {
			continue
		}
		if ipn.IP.To4() != nil {
			ones, _ := ipn.Mask.Size()
			return ipn.IP.String(), ones
		}
		if v6 == nil && ipn.IP.IsGlobalUnicast() {
			v6 = ipn
		}
	}
	if v6 == nil {
		return "", 0
	}
	ones, _ := v6.Mask.Size()
	return v6.IP.String(), ones
}

// macRe is the contract's hardware address (lower case, six octets).
var macRe = regexp.MustCompile(`^[0-9a-f]{2}(:[0-9a-f]{2}){5}$`)

// mac is an interface's hardware address from sysfs, nil when it isn't an Ethernet-style one.
func (g *Guard) mac(iface string) *string {
	m := strings.ToLower(readTrim(g.sys("class", "net", iface, "address")))
	if !macRe.MatchString(m) || m == "00:00:00:00:00:00" {
		return nil
	}
	return &m
}

// prefixOf is a known prefix length for the contract (nil: unknown).
func prefixOf(p int) *int64 {
	if p <= 0 || p > 128 {
		return nil
	}
	v := int64(p)
	return &v
}

func readTrim(p string) string {
	b, err := os.ReadFile(p)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func exists(p string) bool { _, err := os.Lstat(p); return err == nil }

// Wired lists the wired interfaces: Ethernet (type 1) with a device behind it (not a bridge, veth or tunnel) and not
// Wi-Fi. Plugged: carrier (also while the cable is switched off, which keeps the link up without an address).
// Connected: carrier and an address.
func (g *Guard) Wired() []protocol.HostWired {
	ents, _ := os.ReadDir(g.sys("class", "net"))
	out := []protocol.HostWired{}
	for _, e := range ents {
		n := e.Name()
		if readTrim(g.sys("class", "net", n, "type")) != "1" || !exists(g.sys("class", "net", n, "device")) ||
			exists(g.sys("class", "net", n, "wireless")) || exists(g.sys("class", "net", n, "phy80211")) {
			continue
		}
		name := local.HostText(n, 15)
		if name == "" {
			continue
		}
		plugged := readTrim(g.sys("class", "net", n, "carrier")) == "1"
		w := protocol.HostWired{Interface: name, Plugged: &plugged, Mac: g.mac(n)}
		if plugged {
			if a, p := g.addrPrefix(n); a != "" && len(a) <= 45 {
				w.Connected, w.Address, w.PrefixLength = true, &a, prefixOf(p)
			}
		}
		out = append(out, w)
		if len(out) == maxWired {
			break
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Interface < out[j].Interface })
	return out
}

// security maps iwd's kind to the contract's.
func security(s string) protocol.WifiSecurity {
	switch s {
	case "open":
		return protocol.WifiSecurityOpen
	case "psk":
		return protocol.WifiSecurityPsk
	case "8021x":
		return protocol.WifiSecurityEnterprise
	}
	return protocol.WifiSecurityOther
}

// hostWifi is the helper's Wi-Fi status as the contract's HostWifi (nil without a station).
func (g *Guard) hostWifi(ws *proto.WifiStatus) *protocol.HostWifi {
	if ws == nil || ws.Interface == "" {
		return nil
	}
	iface := local.HostText(ws.Interface, 15)
	if iface == "" {
		return nil
	}
	w := &protocol.HostWifi{Interface: iface, State: protocol.WifiStateDisconnected, Saved: []protocol.WifiSaved{},
		Mac: g.mac(ws.Interface)}
	if c := ws.Connected; c != nil {
		switch ws.State {
		case "connected", "roaming":
			w.State = protocol.WifiStateConnected
		case "connecting":
			w.State = protocol.WifiStateConnecting
		}
		if w.State != protocol.WifiStateDisconnected {
			ssid := c.SSID
			if !local.SsidValid(ssid) {
				// The network it is on has a name that can't be shown: shown cleaned, never left out.
				if ssid = local.HostText(c.SSID, local.SsidMaxBytes); !local.SsidValid(ssid) {
					ssid = "?"
				}
			}
			w.Ssid = &ssid
		}
		if w.State == protocol.WifiStateConnected {
			sig := local.WifiSignalFromDBm(c.SignalDBm)
			w.Signal = &sig
			if a, p := g.addrPrefix(ws.Interface); a != "" && len(a) <= 45 {
				w.Address, w.PrefixLength = &a, prefixOf(p)
			}
		}
	}
	for _, s := range ws.Saved {
		if local.SsidValid(s.SSID) && len(w.Saved) < maxSaved {
			w.Saved = append(w.Saved, protocol.WifiSaved{Ssid: s.SSID, Security: security(s.Security)})
		}
	}
	return w
}

// wifiMissing says why there is no Wi-Fi to use (HD-11's words are made from it): a card switched off (rfkill, or iwd
// sees it unpowered), a Wi-Fi card on the PCI bus without a driver, or none at all. nil when a card is there but the
// helper or iwd can't be asked (nothing true to say).
func (g *Guard) wifiMissing(ws *proto.WifiStatus) *protocol.WifiMissing {
	m := func(v protocol.WifiMissing) *protocol.WifiMissing { return &v }
	ents, _ := os.ReadDir(g.sys("class", "rfkill"))
	for _, e := range ents {
		d := g.sys("class", "rfkill", e.Name())
		if readTrim(filepath.Join(d, "type")) == "wlan" && (readTrim(filepath.Join(d, "soft")) == "1" || readTrim(filepath.Join(d, "hard")) == "1") {
			return m(protocol.WifiMissingDisabled)
		}
	}
	if ws != nil && len(ws.Adapters) > 0 {
		for _, a := range ws.Adapters {
			if a.Powered {
				return nil // powered but no station (another mode): nothing to say
			}
		}
		return m(protocol.WifiMissingDisabled)
	}
	if ents, _ := os.ReadDir(g.sys("class", "ieee80211")); len(ents) > 0 {
		return nil // a card with a driver that iwd doesn't answer for
	}
	pci, _ := os.ReadDir(g.sys("bus", "pci", "devices"))
	for _, e := range pci {
		d := g.sys("bus", "pci", "devices", e.Name())
		if strings.HasPrefix(readTrim(filepath.Join(d, "class")), "0x0280") && !exists(filepath.Join(d, "driver")) {
			return m(protocol.WifiMissingNoDriver)
		}
	}
	return m(protocol.WifiMissingNoAdapter)
}

// wifiStatus asks the helper; nil (no error) when there is no Wi-Fi to ask about.
func (g *Guard) wifiStatus(ctx context.Context) (*proto.WifiStatus, error) {
	res, err := g.Helper.Do(ctx, proto.Request{V: proto.Version, Op: proto.OpWifiStatus})
	if err != nil {
		switch proto.CodeOf(err) {
		case proto.CodeNoWifi, proto.CodeBadRequest: // bad_request: a helper from before Wi-Fi
			return nil, nil
		}
		return nil, err
	}
	if res.Wifi == nil {
		return nil, nil
	}
	return res.Wifi.Status, nil
}

// NetworkState is the box's network now (local networkState).
func (g *Guard) NetworkState(ctx context.Context) (protocol.HostNetwork, error) {
	type wifiAnswer struct {
		ws  *proto.WifiStatus
		err error
	}
	ch := make(chan wifiAnswer, 1)
	go func() {
		hctx, cancel := context.WithTimeout(ctx, stateHelperWait)
		defer cancel()
		ws, err := g.wifiStatus(hctx)
		ch <- wifiAnswer{ws, err}
	}()
	type cableAnswer struct {
		off bool
		err error
	}
	cch := make(chan cableAnswer, 1)
	go func() {
		hctx, cancel := context.WithTimeout(ctx, stateHelperWait)
		defer cancel()
		off, err := g.WifiOnly(hctx)
		cch <- cableAnswer{off, err}
	}()
	online, at := g.Online(ctx, stateOnlineWait)
	n := protocol.HostNetwork{Online: online, Wired: g.Wired(), Change: g.WifiChange(), CableChange: g.CableChange()}
	if c := <-cch; c.err == nil {
		// Unknown (the helper didn't answer) is left out: older runtimes and the app read a missing field as off.
		n.WifiOnly = &c.off
	}
	if !at.IsZero() {
		s := at.UTC().Format(time.RFC3339)
		n.CheckedAt = &s
	}
	a := <-ch
	if a.err != nil {
		// The helper didn't answer: the rest is still true; Wi-Fi is unknown.
		return n, nil
	}
	if n.Wifi = g.hostWifi(a.ws); n.Wifi == nil {
		n.WifiMissing = g.wifiMissing(a.ws)
	}
	return n, nil
}

// WiredConnected reports whether a cable works (carrier and an address).
func (g *Guard) WiredConnected() bool {
	for _, w := range g.Wired() {
		if w.Connected {
			return true
		}
	}
	return false
}

func (g *Guard) scanned() []proto.WifiNetwork {
	g.scanMu.Lock()
	defer g.scanMu.Unlock()
	return g.scan
}

// Scan asks the helper for a fresh scan (it waits for one at most 10 s) and answers the contract's WifiScan:
// displayable names only, strongest first, at most 64.
func (g *Guard) Scan(ctx context.Context) (protocol.WifiScan, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	res, err := g.Helper.Do(ctx, proto.Request{V: proto.Version, Op: proto.OpWifiScan})
	if err != nil {
		if c := proto.CodeOf(err); c == proto.CodeNoWifi || c == proto.CodeBadRequest {
			return protocol.WifiScan{}, ErrNoWifi
		}
		return protocol.WifiScan{}, err
	}
	if res.Wifi == nil {
		return protocol.WifiScan{}, errors.New("the helper answered no scan")
	}
	g.scanMu.Lock()
	g.scan = res.Wifi.Networks
	g.scanMu.Unlock()
	out := protocol.WifiScan{Networks: []protocol.WifiNetwork{}, ScannedAt: g.now().UTC().Format(time.RFC3339)}
	for _, n := range res.Wifi.Networks {
		if !local.SsidValid(n.SSID) {
			continue
		}
		out.Networks = append(out.Networks, protocol.WifiNetwork{Ssid: n.SSID, Security: security(n.Security),
			Signal: local.WifiSignalFromDBm(n.SignalDBm), Saved: n.Known, Connected: n.Connected})
	}
	sort.SliceStable(out.Networks, func(i, j int) bool { return out.Networks[i].Signal > out.Networks[j].Signal })
	if len(out.Networks) > maxScan {
		out.Networks = out.Networks[:maxScan]
	}
	return out, nil
}
