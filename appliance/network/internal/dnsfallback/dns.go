// Package dnsfallback adds last-resort resolvers to physical default-route links.
// resolved's FallbackDNS alone is used only when no DNS servers are configured.
package dnsfallback

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"syscall"

	"github.com/godbus/dbus/v5"
)

const linkInterface = "org.freedesktop.resolve1.Link"

const networkManager = "org.freedesktop.network1.Manager"

// Only our own runtime override may be reverted. The stamp detects networkd
// rewriting its link state for DHCP, router advertisements or reconnection.
// Keeping this in /run also survives oneshot invocations without surviving boot.
type record struct {
	Name, MAC, NetworkFile, Stamp string
	Base, Applied                 []Server
	IPv4, IPv6                    bool
}

type source struct {
	ConfigSource string
}

type description struct {
	NetworkFile string
	DNS         []struct {
		Server
		ServerName   string
		ConfigSource string
	}
	SearchDomains, RouteDomains []struct {
		Domain       string
		ConfigSource string
	}
	DNSSettings, DNSSECNegativeTrustAnchors []source
}

func (d description) servers() (servers []Server, runtime bool) {
	for _, s := range d.DNS {
		s.Server.Name = s.ServerName
		servers = append(servers, s.Server)
		runtime = runtime || s.ConfigSource == "runtime"
	}
	return
}

func (d description) domains() (domains []Domain, foreign bool) {
	for _, s := range d.SearchDomains {
		domains = append(domains, Domain{Name: s.Domain})
		foreign = foreign || s.ConfigSource == "runtime"
	}
	for _, s := range d.RouteDomains {
		domains = append(domains, Domain{Name: s.Domain, RouteOnly: true})
		foreign = foreign || s.ConfigSource == "runtime"
	}
	for _, s := range append(slices.Clone(d.DNSSettings), d.DNSSECNegativeTrustAnchors...) {
		foreign = foreign || s.ConfigSource == "runtime"
	}
	return
}

// Server is systemd-resolved's DNSEx tuple. Keep ports and TLS names when adding
// fallback servers, including on a network with an explicitly configured resolver.
type Server struct {
	Family  int32
	Address []byte
	Port    uint16
	Name    string
}

type Domain struct {
	Name      string
	RouteOnly bool
}

// OwnDomainsEnv names the box's own domains (space-separated): the routing-only
// domains the image puts on the cable's and Wi-Fi's networks, so the services
// the box lives by are asked of the local network's resolvers even when
// Tailscale takes every other lookup (NX-488). They don't make a link's DNS
// scoped: it still answers every other name, so it still gets the fallback.
const OwnDomainsEnv = "WHOMBAT_OWN_DNS_DOMAINS"

var ownDomains = strings.Fields(os.Getenv(OwnDomainsEnv))

// Append preserves the network's DNS servers first. Scoped DNS (for example a
// VPN's private domain) must never acquire a public fallback resolver.
func Append(current []Server, domains []Domain, ipv4, ipv6 bool) []Server {
	for _, d := range domains {
		if d.Name != "." && !(d.RouteOnly && slices.Contains(ownDomains, d.Name)) {
			return current
		}
	}
	out := slices.Clone(current)
	for _, address := range []string{"8.8.8.8", "8.8.4.4", "2001:4860:4860::8888", "2001:4860:4860::8844"} {
		ip := net.ParseIP(address)
		family := int32(syscall.AF_INET6)
		if v4 := ip.To4(); v4 != nil {
			if !ipv4 {
				continue
			}
			ip, family = v4, syscall.AF_INET
		} else if !ipv6 {
			continue
		}
		if !slices.ContainsFunc(out, func(s Server) bool { return net.IP(s.Address).Equal(ip) }) {
			out = append(out, Server{Family: family, Address: []byte(ip)})
		}
	}
	return out
}

// Apply runs once. networkd owns managed links' DNS; resolved rejects direct
// writes. An override masks subsequent DHCP DNS, so refresh our own override
// whenever networkd writes new link state, rather than retaining stale servers.
func Apply(ctx context.Context) error {
	const statePath = "/run/whombat-dns-fallback/state.json"
	state := map[int]record{}
	data, err := os.ReadFile(statePath)
	if err == nil {
		if err := json.Unmarshal(data, &state); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if state == nil {
		state = map[int]record{}
	}
	links, err := net.Interfaces()
	if err != nil {
		return err
	}
	conn, err := dbus.ConnectSystemBus(dbus.WithContext(ctx))
	if err != nil {
		return err
	}
	defer conn.Close()
	err = apply(ctx, conn, links, families, state, linkStamp)
	data, saveErr := json.Marshal(state)
	if saveErr == nil {
		saveErr = os.WriteFile(statePath+".tmp", data, 0600)
	}
	if saveErr == nil {
		saveErr = os.Rename(statePath+".tmp", statePath)
	}
	return errors.Join(err, saveErr)
}

func linkStamp(index int) (string, error) {
	info, err := os.Stat(fmt.Sprintf("/run/systemd/netif/links/%d", index))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%d:%d", info.Sys().(*syscall.Stat_t).Ino, info.ModTime().UnixNano()), nil
}

func describe(ctx context.Context, mgr dbus.BusObject, index int) (d description, err error) {
	var raw string
	if err = mgr.CallWithContext(ctx, networkManager+".DescribeLink", 0, int32(index)).Store(&raw); err == nil {
		err = json.Unmarshal([]byte(raw), &d)
	}
	return
}

func apply(ctx context.Context, conn *dbus.Conn, links []net.Interface, addressFamilies func(string) (bool, bool), state map[int]record, stamp func(int) (string, error)) error {
	mgr := conn.Object("org.freedesktop.resolve1", "/org/freedesktop/resolve1")
	networkd := conn.Object("org.freedesktop.network1", "/org/freedesktop/network1")
	var failures []error
	for _, link := range links {
		if err := applyLink(ctx, conn, mgr, networkd, link, addressFamilies, state, stamp); err != nil {
			failures = append(failures, fmt.Errorf("%s: %w", link.Name, err))
		}
	}
	return errors.Join(failures...)
}

func applyLink(ctx context.Context, conn *dbus.Conn, mgr, networkd dbus.BusObject, link net.Interface, addressFamilies func(string) (bool, bool), state map[int]record, stamp func(int) (string, error)) error {
	v4, v6 := addressFamilies(link.Name)
	if !v4 && !v6 {
		return nil
	}
	// resolved exposes GetLink, not ListLinks. Use its returned path: D-Bus
	// escapes numeric link names (index 2 is _32, not _2).
	var path dbus.ObjectPath
	if err := mgr.CallWithContext(ctx, "org.freedesktop.resolve1.Manager.GetLink", 0, int32(link.Index)).Store(&path); err != nil {
		return err
	}
	obj := conn.Object("org.freedesktop.resolve1", path)
	var props map[string]dbus.Variant
	if err := obj.CallWithContext(ctx, "org.freedesktop.DBus.Properties.GetAll", 0, linkInterface).Store(&props); err != nil {
		return err
	}
	d, err := describe(ctx, networkd, link.Index)
	if err != nil {
		return err
	}
	servers, runtime := d.servers()
	domains, foreign := d.domains()
	previous, owned := state[link.Index]
	owned = owned && previous.Name == link.Name && previous.MAC == link.HardwareAddr.String() && reflect.DeepEqual(previous.Applied, servers)
	if !owned {
		delete(state, link.Index)
		// Respect an operator's override; this service never owns it.
		if runtime || foreign {
			return nil
		}
	} else if foreign {
		// Another DNS policy has taken over. Remove only our secondary
		// servers, preserving its domains/security settings.
		if err := networkd.CallWithContext(ctx, networkManager+".SetLinkDNSEx", 0, int32(link.Index), previous.Base).Err; err != nil {
			return err
		}
		delete(state, link.Index)
		return nil
	}
	currentStamp, err := stamp(link.Index)
	if err != nil {
		return err
	}
	if owned {
		if previous.Stamp == currentStamp && previous.NetworkFile == d.NetworkFile && previous.IPv4 == v4 && previous.IPv6 == v6 {
			return nil
		}
		// The previous DNS-only override belongs to us. Reverting it
		// exposes networkd's current DHCP/RA/static DNS atomically in its
		// own state; no interface reconfiguration or resolver restart.
		if err := networkd.CallWithContext(ctx, networkManager+".RevertLinkDNS", 0, int32(link.Index)).Err; err != nil {
			return err
		}
		delete(state, link.Index)
		d, err = describe(ctx, networkd, link.Index)
		if err != nil {
			return err
		}
		servers, _ = d.servers()
		domains, _ = d.domains()
	}
	if props["DefaultRoute"].Value() != true {
		return nil
	}
	next := Append(servers, domains, v4, v6)
	if len(next) == len(servers) {
		return nil
	}
	// Record intent before writing: even a partial D-Bus failure must not
	// turn our override into an unowned, permanently stale one.
	state[link.Index] = record{Name: link.Name, MAC: link.HardwareAddr.String(), NetworkFile: d.NetworkFile, Base: servers, Applied: next, IPv4: v4, IPv6: v6}
	if err := networkd.CallWithContext(ctx, networkManager+".SetLinkDNSEx", 0, int32(link.Index), next).Err; err != nil {
		return err
	}
	currentStamp, err = stamp(link.Index)
	if err != nil {
		return err
	}
	entry := state[link.Index]
	entry.Stamp = currentStamp
	state[link.Index] = entry
	fmt.Printf("%s: public fallback DNS follows the network's resolvers\n", link.Name)
	return nil
}

func families(name string) (v4, v6 bool) {
	// Physical NICs (including virtio and USB Ethernet) have a device; bridges,
	// containers and Tailscale do not. Never change those links' DNS policy.
	if _, err := os.Stat(filepath.Join("/sys/class/net", name, "device")); err != nil {
		return
	}
	iface, err := net.InterfaceByName(name)
	if err != nil || iface.Flags&net.FlagUp == 0 {
		return
	}
	addrs, err := iface.Addrs()
	if err != nil {
		return
	}
	for _, a := range addrs {
		ip, _, err := net.ParseCIDR(a.String())
		if err != nil || !ip.IsGlobalUnicast() {
			continue
		}
		if ip.To4() != nil {
			v4 = true
		} else {
			v6 = true
		}
	}
	return
}
