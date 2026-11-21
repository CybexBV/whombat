package agent

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"net"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"sync"
	"time"

	"rackoon/internal/netaddrs"
)

// Finding the hub (HS-173…HS-176): the hub tells its agents every address
// it has (HelloAck.Addrs, hub_addrs); the agent keeps them in its state
// directory. When the saved hub can't be reached (network or TLS errors,
// never a rejection) three times in a row over at least a minute, the
// agent tries the remembered addresses, then looks on its own networks for
// a listener whose certificate its stored CA issued, saves the address it
// found in agent.toml and connects. While it stays unconnected it looks
// again after 2, 4 and 8 minutes, then every 15.

// HubAddressesFile in the state directory holds the hub's addresses.
const HubAddressesFile = "hub-addresses.json"

// maxRememberedAddrs bounds the remembered list.
const maxRememberedAddrs = 32

type hubAddrsFile struct {
	Addrs     []string  `json:"addrs"`
	UpdatedAt time.Time `json:"updated_at"`
}

// cleanHubAddrs keeps the usable wss URLs (wss://host:port), once each.
func cleanHubAddrs(in []string) []string {
	var out []string
	for _, s := range in {
		u, err := url.Parse(s)
		if err != nil || u.Scheme != "wss" || u.Hostname() == "" || u.Port() == "" || len(s) > 300 {
			continue
		}
		if p, err := strconv.Atoi(u.Port()); err != nil || p < 1 || p > 65535 {
			continue
		}
		v := "wss://" + u.Host
		if !slices.Contains(out, v) {
			out = append(out, v)
		}
		if len(out) == maxRememberedAddrs {
			break
		}
	}
	return out
}

// loadHubAddrs reads the remembered addresses (none when the file is
// missing or unreadable).
func loadHubAddrs(stateDir string) []string {
	b, err := os.ReadFile(filepath.Join(stateDir, HubAddressesFile))
	if err != nil {
		return nil
	}
	var f hubAddrsFile
	if json.Unmarshal(b, &f) != nil {
		return nil
	}
	return cleanHubAddrs(f.Addrs)
}

// saveHubAddrs writes the addresses (atomically, 0600).
func saveHubAddrs(stateDir string, addrs []string, now time.Time) error {
	b, err := json.MarshalIndent(hubAddrsFile{Addrs: addrs, UpdatedAt: now.UTC()}, "", "  ")
	if err != nil {
		return err
	}
	return WriteFileAtomic(filepath.Join(stateDir, HubAddressesFile), append(b, '\n'), 0o600)
}

// rememberHubAddrs keeps the hub's list when it changed.
func (rt *Runtime) rememberHubAddrs(addrs []string) {
	addrs = cleanHubAddrs(addrs)
	if len(addrs) == 0 {
		return
	}
	rt.hubAddrMu.Lock()
	defer rt.hubAddrMu.Unlock()
	if slices.Equal(addrs, rt.hubAddrs) {
		return
	}
	rt.hubAddrs = addrs
	if err := saveHubAddrs(rt.Config().StateDir, addrs, rt.now()); err != nil {
		rt.Log.Warn("cannot save the hub's addresses", "err", err)
		return
	}
	rt.Log.Info("the hub's addresses", "addrs", addrs)
}

func (rt *Runtime) rememberedHubAddrs() []string {
	rt.hubAddrMu.Lock()
	defer rt.hubAddrMu.Unlock()
	return slices.Clone(rt.hubAddrs)
}

// ---- when to search -----------------------------------------------------------

// searchSchedule decides when the agent looks for its hub.
type searchSchedule struct {
	failures int           // network or TLS failures in a row
	since    time.Time     // the first of them
	searches int           // searches since the streak started
	last     time.Time     // the last search
	after    time.Duration // the streak's minimum length (60 s)
	minFails int           // its minimum count (3)
	delays   []time.Duration
	every    time.Duration
}

func newSearchSchedule(rt *Runtime) *searchSchedule {
	return &searchSchedule{after: rt.SearchAfter, minFails: rt.SearchFailures, delays: rt.SearchDelays, every: rt.SearchEvery}
}

// unreachable counts a network or TLS failure.
func (s *searchSchedule) unreachable(now time.Time) {
	if s.failures == 0 {
		s.since = now
	}
	s.failures++
}

// reached ends the streak: the agent connected, or the hub answered (also
// a rejection).
func (s *searchSchedule) reached() {
	*s = searchSchedule{after: s.after, minFails: s.minFails, delays: s.delays, every: s.every}
}

// due reports whether to search now.
func (s *searchSchedule) due(now time.Time) bool {
	if s.failures < s.minFails || now.Sub(s.since) < s.after {
		return false
	}
	if s.searches == 0 {
		return true
	}
	wait := s.every
	if s.searches-1 < len(s.delays) {
		wait = s.delays[s.searches-1]
	}
	return now.Sub(s.last) >= wait
}

func (s *searchSchedule) searched(now time.Time) {
	s.searches++
	s.last = now
}

// unreachableError is a dial that never reached a hub: a network or TLS
// error (no HTTP answer over a verified connection).
type unreachableError struct{ err error }

func (e *unreachableError) Error() string { return e.err.Error() }
func (e *unreachableError) Unwrap() error { return e.err }

// ---- where to search ---------------------------------------------------------

// maxScan bounds the addresses one search probes on the networks.
const maxScan = 8192

// searchTargets returns the host:port pairs to probe: first the remembered
// addresses, then every address of the agent's networks (up, not loopback,
// not a container, VM or VPN interface, a private IPv4 address; its subnet
// when the prefix is /22 or longer, else the /22 around it) on the ports of
// the saved and remembered URLs (8443 when there are none). The saved
// address and the agent's own are left out.
func searchTargets(saved string, remembered []string, ifs []netaddrs.Interface) (first, scan []string) {
	skip := map[string]bool{}
	if u, err := url.Parse(saved); err == nil && u.Host != "" {
		skip[hostPort(u)] = true
	}
	var ports []string
	addPort := func(u *url.URL) {
		p := u.Port()
		if p == "" {
			p = "443"
		}
		if !slices.Contains(ports, p) {
			ports = append(ports, p)
		}
	}
	if u, err := url.Parse(saved); err == nil && u.Host != "" {
		addPort(u)
	}
	for _, r := range remembered {
		u, err := url.Parse(r)
		if err != nil || u.Host == "" {
			continue
		}
		addPort(u)
		hp := hostPort(u)
		if !skip[hp] {
			skip[hp] = true
			first = append(first, hp)
		}
	}
	if len(ports) == 0 {
		ports = []string{"8443"}
	}
	own := map[netip.Addr]bool{}
	for _, ifc := range ifs {
		for _, p := range ifc.Prefixes {
			own[p.Addr()] = true
		}
	}
	for _, ifc := range ifs {
		if !ifc.Physical() {
			continue
		}
		for _, p := range ifc.Prefixes {
			a := p.Addr()
			if !a.Is4() || !a.IsPrivate() {
				continue
			}
			bits := max(p.Bits(), 22)
			n := netip.PrefixFrom(a, bits).Masked()
			for h := range subnetHosts(n) {
				if own[h] {
					continue
				}
				for _, port := range ports {
					hp := net.JoinHostPort(h.String(), port)
					if skip[hp] {
						continue
					}
					skip[hp] = true
					scan = append(scan, hp)
					if len(scan) >= maxScan {
						return first, scan
					}
				}
			}
		}
	}
	return first, scan
}

func hostPort(u *url.URL) string {
	p := u.Port()
	if p == "" {
		p = "443"
	}
	return net.JoinHostPort(u.Hostname(), p)
}

// subnetHosts yields the host addresses of an IPv4 network (without the
// network and broadcast addresses, except in a /31 or /32).
func subnetHosts(n netip.Prefix) func(yield func(netip.Addr) bool) {
	return func(yield func(netip.Addr) bool) {
		a := n.Addr()
		if n.Bits() >= 31 {
			for ; n.Contains(a); a = a.Next() {
				if !yield(a) {
					return
				}
			}
			return
		}
		for a = a.Next(); n.Contains(a.Next()); a = a.Next() {
			if !yield(a) {
				return
			}
		}
	}
}

// ---- probing -------------------------------------------------------------------

// hubProber connects to candidate addresses and checks their certificate.
type hubProber struct {
	dial             func(ctx context.Context, network, addr string) (net.Conn, error)
	ca               *x509.Certificate
	connectTimeout   time.Duration // 300 ms
	handshakeTimeout time.Duration
	parallel         int // 64
}

// probe reports whether addr is a hub listener whose certificate the CA
// issued (the same check as a connection).
func (p *hubProber) probe(ctx context.Context, addr string) bool {
	cctx, cancel := context.WithTimeout(ctx, p.connectTimeout)
	c, err := p.dial(cctx, "tcp", addr)
	cancel()
	if err != nil {
		return false
	}
	defer c.Close()
	hctx, cancel := context.WithTimeout(ctx, p.handshakeTimeout)
	defer cancel()
	tc := tls.Client(c, CATLSConfig(p.ca, nil))
	return tc.HandshakeContext(hctx) == nil
}

// first probes addrs, parallel at a time, and returns the first that
// passes ("" when none does).
func (p *hubProber) first(ctx context.Context, addrs []string) string {
	if len(addrs) == 0 {
		return ""
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	work := make(chan string)
	var once sync.Once
	found := ""
	var wg sync.WaitGroup
	for range min(p.parallel, len(addrs)) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for a := range work {
				if p.probe(ctx, a) {
					once.Do(func() { found = a; cancel() })
				}
			}
		}()
	}
feed:
	for _, a := range addrs {
		select {
		case work <- a:
		case <-ctx.Done():
			break feed
		}
	}
	close(work)
	wg.Wait()
	return found
}

// searchHub looks for the hub: the remembered addresses, then the networks.
// It returns the wss URL it found ("" when none).
func (rt *Runtime) searchHub(ctx context.Context) string {
	id := rt.identity()
	if id == nil {
		return ""
	}
	cfg := rt.Config()
	ifs, err := rt.interfaces()
	if err != nil {
		rt.Log.Warn("finding the hub: cannot list the network interfaces", "err", err)
	}
	first, scan := searchTargets(cfg.Hub, rt.rememberedHubAddrs(), ifs)
	p := &hubProber{dial: rt.dialContext, ca: id.CA, connectTimeout: rt.SearchConnectTimeout,
		handshakeTimeout: rt.SearchHandshakeTimeout, parallel: rt.SearchParallel}
	rt.Log.Info("looking for the hub", "saved", cfg.Hub, "remembered", len(first), "on_networks", len(scan))
	addr := p.first(ctx, first)
	if addr == "" {
		addr = p.first(ctx, scan)
	}
	if addr == "" {
		if ctx.Err() == nil {
			rt.Log.Warn("the hub was not found; trying its saved address again", "hub", cfg.Hub)
		}
		return ""
	}
	return "wss://" + addr
}

// useFoundHub saves a found hub address in agent.toml and in the running
// configuration.
func (rt *Runtime) useFoundHub(found string) {
	rt.cfgMu.Lock()
	old := rt.cfg
	n := *old
	n.Hub = found
	rt.cfg = &n
	rt.cfgMu.Unlock()
	rt.Log.Warn("found the hub at "+found, "hub", found, "was", old.Hub)
	if err := RewriteHub(filepath.Join(old.Dir, ConfigFileName), found); err != nil {
		rt.Log.Error("the hub's new address could not be saved in "+ConfigFileName+"; it is used until the agent restarts",
			"err", err)
	}
}

// interfaces lists the machine's network interfaces (Runtime.Interfaces in
// tests).
func (rt *Runtime) interfaces() ([]netaddrs.Interface, error) {
	if rt.Interfaces != nil {
		return rt.Interfaces()
	}
	return netaddrs.System()
}

// dialContext dials for the hub connection and the search
// (Runtime.DialContext in tests).
func (rt *Runtime) dialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	if rt.DialContext != nil {
		return rt.DialContext(ctx, network, addr)
	}
	var d net.Dialer
	return d.DialContext(ctx, network, addr)
}

func (rt *Runtime) now() time.Time {
	if rt.Now != nil {
		return rt.Now()
	}
	return time.Now()
}
