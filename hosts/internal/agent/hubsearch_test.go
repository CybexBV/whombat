package agent

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"rackoon/internal/netaddrs"
)

func TestReplaceHubLine(t *testing.T) {
	const url = "wss://10.100.1.158:8443"
	for _, c := range []struct{ name, in, want string }{
		{"installer", "hub = \"wss://10.100.1.160:8443\"\nca_sha256 = \"ab\"\n\n[remote_control]\nconsole = true\n",
			"hub = \"wss://10.100.1.158:8443\"\nca_sha256 = \"ab\"\n\n[remote_control]\nconsole = true\n"},
		{"literal, comment, indent", "# Whombat agent\n  hub = 'wss://old:8443'   # the box\nstate_dir = '/var/lib/x'\n",
			"# Whombat agent\n  hub = \"wss://10.100.1.158:8443\"   # the box\nstate_dir = '/var/lib/x'\n"},
		{"crlf", "ca_sha256 = \"ab\"\r\nhub=\"wss://old:1\"\r\n", "ca_sha256 = \"ab\"\r\nhub=\"wss://10.100.1.158:8443\"\r\n"},
		{"none at the top", "ca_sha256 = \"ab\"\n[pve]\nhub = \"not this\"\n",
			"hub = \"wss://10.100.1.158:8443\"\nca_sha256 = \"ab\"\n[pve]\nhub = \"not this\"\n"},
		{"hub_x is another key", "hub_x = \"a\"\nhub = \"wss://old:1\"\n", "hub_x = \"a\"\nhub = \"wss://10.100.1.158:8443\"\n"},
		{"escaped quote", "hub = \"wss://o\\\"ld:1\" # c\n", "hub = \"wss://10.100.1.158:8443\" # c\n"},
	} {
		got, err := replaceHubLine([]byte(c.in), url)
		if err != nil || string(got) != c.want {
			t.Errorf("%s: %q %v", c.name, got, err)
			continue
		}
		if err := checkHubRewrite([]byte(c.in), got, url); err != nil {
			t.Errorf("%s: %v", c.name, err)
		}
	}
	if _, err := replaceHubLine([]byte("hub = \"\"\"\nwss://x\n\"\"\"\n"), url); err == nil {
		t.Error("a multi-line string was rewritten")
	}
	if _, err := replaceHubLine([]byte("hub = \"x\"\n"), "wss://a\"b"); err == nil {
		t.Error("a quote in the address was accepted")
	}
	// A rewrite that would change another setting is refused.
	if err := checkHubRewrite([]byte("hub = \"a\"\nx = 1\n"), []byte("hub = \"wss://b\"\nx = 2\n"), "wss://b"); err == nil {
		t.Error("another setting changed unnoticed")
	}
}

func TestRewriteHubKeepsTheRest(t *testing.T) {
	h := newFakeHub(t)
	cfg := enrollAgent(t, h)
	path := filepath.Join(cfg.Dir, ConfigFileName)
	// The owner's own lines and comments, as an installer and an edit leave them.
	orig := "# Set up by Whombat\nhub = \"" + cfg.Hub + "\"  # the box\nca_sha256 = \"" + cfg.CASHA256 + "\"\nstate_dir = \"" +
		cfg.StateDir + "\"\n\n[remote_control]\n# allowed on 2026-10-01\nconsole = true\nmanage = true\n"
	if err := os.WriteFile(path, []byte(orig), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o640); err != nil {
		t.Fatal(err)
	}
	if err := RewriteHub(path, "wss://10.100.1.158:8443"); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(path)
	if want := strings.Replace(orig, cfg.Hub, "wss://10.100.1.158:8443", 1); string(b) != want {
		t.Fatalf("agent.toml =\n%s", b)
	}
	fi, _ := os.Stat(path)
	if fi.Mode().Perm() != 0o640 || fi.Sys().(*syscall.Stat_t).Uid != uint32(os.Getuid()) {
		t.Fatalf("mode %v", fi.Mode())
	}
	c, err := LoadConfig(cfg.Dir)
	if err != nil || c.Hub != "wss://10.100.1.158:8443" || !c.RemoteControl.Console || !c.RemoteControl.Manage {
		t.Fatalf("config %+v %v", c, err)
	}
	if m, _ := filepath.Glob(filepath.Join(cfg.Dir, ".agent.toml.tmp*")); len(m) != 0 {
		t.Fatalf("left %v", m)
	}
}

func TestSearchTargets(t *testing.T) {
	pfx := netip.MustParsePrefix
	ifs := []netaddrs.Interface{
		{Name: "lo", Up: true, Loopback: true, Prefixes: []netip.Prefix{pfx("127.0.0.1/8")}},
		{Name: "vmbr0", Up: true, Prefixes: []netip.Prefix{pfx("10.100.1.20/24"), pfx("fd00::20/64")}},
		{Name: "eno2", Up: true, Prefixes: []netip.Prefix{pfx("172.16.5.9/16"), pfx("203.0.113.4/24")}},
		{Name: "docker0", Up: true, Prefixes: []netip.Prefix{pfx("172.17.0.1/16")}},
		{Name: "tailscale0", Up: true, Prefixes: []netip.Prefix{pfx("100.64.0.9/32")}},
		{Name: "eno3", Up: false, Prefixes: []netip.Prefix{pfx("192.168.9.2/24")}},
	}
	first, scan := searchTargets("wss://10.100.1.160:8443", []string{"wss://10.100.1.160:8443", "wss://10.100.1.158:8443",
		"wss://[fd00::158]:9443"}, ifs)
	if !slices.Equal(first, []string{"10.100.1.158:8443", "[fd00::158]:9443"}) {
		t.Fatalf("first = %v", first)
	}
	// vmbr0's /24 (254 hosts but itself) and the /22 around eno2's address
	// (1022 hosts but itself), on both ports; not the saved or a remembered one.
	if len(scan) != (253+1021)*2-2 {
		t.Fatalf("%d to scan", len(scan))
	}
	for _, want := range []string{"10.100.1.1:8443", "10.100.1.254:9443", "172.16.4.1:8443", "172.16.7.254:9443"} {
		if !slices.Contains(scan, want) {
			t.Errorf("%s not scanned", want)
		}
	}
	for _, not := range []string{"10.100.1.20:8443", "10.100.1.160:8443", "10.100.1.158:8443", "10.100.1.0:8443",
		"10.100.1.255:8443", "172.16.8.1:8443", "172.17.0.2:8443", "192.168.9.1:8443", "203.0.113.1:8443", "100.64.0.1:8443"} {
		if slices.Contains(scan, not) {
			t.Errorf("%s scanned", not)
		}
	}
	// Nothing remembered: the saved port, 8443 without one.
	_, scan = searchTargets("wss://10.100.1.160:7443", nil, ifs[:2])
	if len(scan) != 252 || scan[0] != "10.100.1.1:7443" {
		t.Fatalf("scan %d %v", len(scan), scan[:1])
	}
	_, scan = searchTargets("", nil, []netaddrs.Interface{{Name: "eth0", Up: true, Prefixes: []netip.Prefix{pfx("192.168.1.2/30")}}})
	if !slices.Equal(scan, []string{"192.168.1.1:8443"}) {
		t.Fatalf("/30: %v", scan)
	}
}

func TestSearchSchedule(t *testing.T) {
	rt := NewRuntime(&Config{StateDir: t.TempDir()}, "test", nil)
	s := newSearchSchedule(rt)
	t0 := time.Date(2026, 10, 21, 10, 0, 0, 0, time.UTC)
	at := func(d time.Duration) time.Time { return t0.Add(d) }
	s.unreachable(at(0))
	s.unreachable(at(10 * time.Second))
	s.unreachable(at(30 * time.Second))
	if s.due(at(30 * time.Second)) {
		t.Fatal("searched before a minute")
	}
	s.unreachable(at(60 * time.Second))
	if !s.due(at(60 * time.Second)) {
		t.Fatal("not searched after three failures over a minute")
	}
	// Again after 2, 4 and 8 minutes, then every 15.
	last := at(60 * time.Second)
	for _, d := range []time.Duration{2 * time.Minute, 4 * time.Minute, 8 * time.Minute, 15 * time.Minute, 15 * time.Minute} {
		s.searched(last)
		if s.due(last.Add(d - time.Second)) {
			t.Fatalf("searched before %v", d)
		}
		if !s.due(last.Add(d)) {
			t.Fatalf("not searched after %v", d)
		}
		last = last.Add(d)
	}
	// The hub answered: a new streak.
	s.reached()
	s.unreachable(at(time.Hour))
	if s.due(at(time.Hour + 2*time.Minute)) {
		t.Fatal("one failure after the hub answered started a search")
	}
}

func TestHubAddrMemory(t *testing.T) {
	dir := t.TempDir()
	got := cleanHubAddrs([]string{"wss://10.100.1.158:8443", "ws://10.100.1.1:80", "wss://host", "wss://[fd00::1]:8443/x",
		"wss://10.100.1.158:8443", "https://a:1", "wss://a:99999"})
	if !slices.Equal(got, []string{"wss://10.100.1.158:8443", "wss://[fd00::1]:8443"}) {
		t.Fatalf("clean = %v", got)
	}
	if err := saveHubAddrs(dir, got, time.Now()); err != nil {
		t.Fatal(err)
	}
	if fi, _ := os.Stat(filepath.Join(dir, HubAddressesFile)); fi.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", fi.Mode())
	}
	if l := loadHubAddrs(dir); !slices.Equal(l, got) {
		t.Fatalf("load = %v", l)
	}
	os.WriteFile(filepath.Join(dir, HubAddressesFile), []byte("{"), 0o600)
	if l := loadHubAddrs(dir); l != nil {
		t.Fatalf("unreadable file = %v", l)
	}
}

// searchSetup makes the hub search quick for a test.
func searchSetup(rt *Runtime) {
	rt.SearchAfter = 100 * time.Millisecond
	rt.BackoffMin, rt.BackoffMax = 10*time.Millisecond, 40*time.Millisecond
	rt.SearchConnectTimeout = 300 * time.Millisecond
	rt.SearchHandshakeTimeout = 2 * time.Second
}

// The hub moved to its other address: the agent remembered it.
func TestAgentFindsHubAtRememberedAddress(t *testing.T) {
	h := newFakeHub(t)
	cfg := enrollAgent(t, h)
	second := h.listenAlso(t, "127.0.0.2:0")
	h.ackAddrs = []string{h.wsURL(), second}
	tr := startRuntime(t, cfg, searchSetup)
	recv(t, h.hellos, "hello")
	path := filepath.Join(cfg.StateDir, HubAddressesFile)
	waitUntil(t, "the addresses saved", func() bool { return slices.Equal(loadHubAddrs(cfg.StateDir), h.ackAddrs) })
	if fi, err := os.Stat(path); err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("%s: %v %v", HubAddressesFile, fi, err)
	}
	// The first address goes away.
	h.srv.Close()
	h.waitSide(t).sess.Close()
	recv(t, h.hellos, "hello at the second address")
	if got := tr.rt.Config().Hub; got != second {
		t.Fatalf("hub = %s", got)
	}
	c, err := LoadConfig(cfg.Dir)
	if err != nil || c.Hub != second {
		t.Fatalf("agent.toml hub = %q %v", c.Hub, err)
	}
}

// Nothing remembered: the agent finds the hub on its own network.
func TestAgentFindsHubOnItsNetwork(t *testing.T) {
	h := newFakeHub(t)
	cfg := enrollAgent(t, h)
	u, _ := url.Parse(h.wsURL())
	port := u.Port()
	// The saved address no longer answers; the hub is at 10.0.0.7 now.
	if err := RewriteHub(filepath.Join(cfg.Dir, ConfigFileName), "wss://10.0.0.9:"+port); err != nil {
		t.Fatal(err)
	}
	cfg, _ = LoadConfig(cfg.Dir)
	var probes atomic.Int32
	tr := startRuntime(t, cfg, func(rt *Runtime) {
		searchSetup(rt)
		rt.Interfaces = func() ([]netaddrs.Interface, error) {
			return []netaddrs.Interface{
				{Name: "lo", Up: true, Loopback: true, Prefixes: []netip.Prefix{netip.MustParsePrefix("127.0.0.1/8")}},
				{Name: "eth0", Up: true, Prefixes: []netip.Prefix{netip.MustParsePrefix("10.0.0.5/24")}},
			}, nil
		}
		// A network in the test: 10.0.0.7 is the hub, nothing else answers.
		rt.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
			if !strings.HasPrefix(addr, "10.0.0.") {
				return nil, errors.New("not in this test: " + addr)
			}
			probes.Add(1)
			if addr == "10.0.0.7:"+port {
				var d net.Dialer
				return d.DialContext(ctx, network, u.Host)
			}
			return nil, syscall.ECONNREFUSED
		}
	})
	recv(t, h.hellos, "hello after the search")
	if got := tr.rt.Config().Hub; got != "wss://10.0.0.7:"+port {
		t.Fatalf("hub = %s", got)
	}
	if c, _ := LoadConfig(cfg.Dir); c.Hub != "wss://10.0.0.7:"+port {
		t.Fatalf("agent.toml hub = %q", c.Hub)
	}
	if probes.Load() < 3 {
		t.Fatalf("%d dials", probes.Load())
	}
}

// A hub that rejects the agent was there: no search.
func TestRejectedAgentDoesNotSearch(t *testing.T) {
	h := newFakeHub(t)
	cfg := enrollAgent(t, h)
	h.revoked.Store(true)
	var looked atomic.Int32
	startRuntime(t, cfg, func(rt *Runtime) {
		searchSetup(rt)
		rt.SearchAfter = 0
		rt.BackoffMax = 10 * time.Millisecond
		rt.Interfaces = func() ([]netaddrs.Interface, error) { looked.Add(1); return nil, nil }
	})
	waitUntil(t, "five refused connections", func() bool { return h.connects.Load() >= 5 })
	if looked.Load() != 0 {
		t.Fatal("the agent searched after the hub rejected it")
	}
}

func waitUntil(t *testing.T, what string, f func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !f() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
