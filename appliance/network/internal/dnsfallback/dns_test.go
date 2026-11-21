package dnsfallback

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/godbus/dbus/v5"
)

// The box's own routing domains (NX-488) leave a link general: it still gets the fallback. Any other domain scopes it.
func TestOwnDomainsKeepTheFallback(t *testing.T) {
	defer func(saved []string) { ownDomains = saved }(ownDomains)
	ownDomains = []string{"whombat.com"}
	current := []Server{{Family: 2, Address: []byte{10, 10, 0, 1}}}
	if got := Append(current, []Domain{{Name: "whombat.com", RouteOnly: true}}, true, false); len(got) != 3 {
		t.Fatalf("own domain dropped the fallback: %+v", got)
	}
	for _, scoped := range [][]Domain{
		{{Name: "whombat.com", RouteOnly: true}, {Name: "corp.example", RouteOnly: true}},
		{{Name: "whombat.com"}}, // a search domain is the network's own, not ours
		{{Name: "example.com", RouteOnly: true}},
	} {
		if got := Append(current, scoped, true, false); len(got) != 1 {
			t.Fatalf("%+v: scoped DNS got a fallback: %+v", scoped, got)
		}
	}
}

func TestFallbackKeepsNetworkDNSFirstAndIsIdempotent(t *testing.T) {
	primary := Server{Family: 2, Address: []byte{10, 10, 0, 1}, Port: 853, Name: "dns.example.org"}
	current := []Server{primary}
	got := Append(current, nil, true, true)
	if len(got) != 5 || !reflect.DeepEqual(got[0], primary) || len(current) != 1 {
		t.Fatalf("network settings changed: %+v", got)
	}
	if !reflect.DeepEqual(got, Append(got, nil, true, true)) {
		t.Fatal("fallback duplicated")
	}
	for i, address := range []string{"8.8.8.8", "8.8.4.4", "2001:4860:4860::8888", "2001:4860:4860::8844"} {
		if !net.IP(got[i+1].Address).Equal(net.ParseIP(address)) {
			t.Fatalf("fallback %d: %+v", i, got[i+1])
		}
	}
	// The DNSEx wire shape must retain systemd's port and TLS server name.
	if sig := dbus.SignatureOf(got).String(); sig != "a(iayqs)" {
		t.Fatal(sig)
	}
}

type resolved struct {
	mu               sync.Mutex
	servers          []Server
	base             []Server
	override         bool
	stamp            int
	private, foreign bool
	calls            int
	reverts          int
}

func (r *resolved) GetLink(index int32) (dbus.ObjectPath, *dbus.Error) {
	if index != 2 {
		return "", dbus.MakeFailedError(context.Canceled)
	}
	return "/org/freedesktop/resolve1/link/_32", nil
}

func (r *resolved) SetLinkDNSEx(_ int32, _ []Server) *dbus.Error {
	return dbus.NewError("org.freedesktop.resolve1.LinkBusy", []any{"Link eth0 is managed."})
}

type networkd struct{ r *resolved }

func (n *networkd) SetLinkDNSEx(index int32, servers []Server) *dbus.Error {
	r := n.r
	r.mu.Lock()
	defer r.mu.Unlock()
	if index != 2 {
		return dbus.MakeFailedError(context.Canceled)
	}
	r.servers = servers
	r.override = true
	r.stamp++
	r.calls++
	return nil
}

func (n *networkd) RevertLinkDNS(index int32) *dbus.Error {
	r := n.r
	r.mu.Lock()
	defer r.mu.Unlock()
	if index != 2 {
		return dbus.MakeFailedError(context.Canceled)
	}
	r.servers = r.base
	r.override = false
	r.stamp++
	r.reverts++
	return nil
}

func (n *networkd) DescribeLink(index int32) (string, *dbus.Error) {
	r := n.r
	r.mu.Lock()
	defer r.mu.Unlock()
	if index != 2 {
		return "", dbus.MakeFailedError(context.Canceled)
	}
	source := "DHCPv4"
	if r.override {
		source = "runtime"
	}
	var servers []any
	for _, s := range r.servers {
		// networkd's JSON uses an integer array, not Go's base64 []byte.
		address := make([]int, len(s.Address))
		for i, b := range s.Address {
			address[i] = int(b)
		}
		servers = append(servers, map[string]any{"Family": s.Family, "Address": address, "Port": s.Port, "ServerName": s.Name, "ConfigSource": source})
	}
	d := map[string]any{"NetworkFile": "/etc/systemd/network/90-whombat-default.network", "DNS": servers}
	if r.private {
		d["SearchDomains"] = []any{map[string]any{"Domain": "corp.example", "ConfigSource": "DHCPv4"}}
	}
	if r.foreign {
		d["DNSSettings"] = []any{map[string]any{"DNSOverTLS": "yes", "ConfigSource": "runtime"}}
	}
	b, err := json.Marshal(d)
	if err != nil {
		return "", dbus.MakeFailedError(err)
	}
	return string(b), nil
}

func (r *resolved) GetAll(_ string) (map[string]dbus.Variant, *dbus.Error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return map[string]dbus.Variant{
		"DefaultRoute": dbus.MakeVariant(true),
		"DNSEx":        dbus.MakeVariant(r.servers),
		"Domains":      dbus.MakeVariant([]Domain{}),
	}, nil
}

func (r *resolved) snapshot() ([]Server, int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.servers, r.calls
}

// Exercise the real D-Bus serialization and properties against a private bus:
// no host DNS is touched, including when go test runs as root in a Nix build.
func TestResolvedProtocolAndDHCPRenewal(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	dir := t.TempDir()
	config := filepath.Join(dir, "bus.conf")
	// Supply the whole configuration; a Nix build has no host /etc/dbus-1.
	xml := fmt.Sprintf(`<busconfig><type>session</type><listen>unix:path=%s</listen><auth>EXTERNAL</auth><policy context="default"><allow own="*"/><allow send_destination="*"/><allow receive_sender="*"/></policy></busconfig>`, filepath.Join(dir, "bus"))
	if err := os.WriteFile(config, []byte(xml), 0600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.CommandContext(ctx, "dbus-daemon", "--config-file="+config, "--nofork", "--print-address=1")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	scanner := bufio.NewScanner(out)
	if !scanner.Scan() {
		_ = cmd.Wait()
		t.Fatal("private bus did not start:", stderr.String())
	}
	address := scanner.Text()
	server, err := dbus.Connect(address)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })
	if _, err := server.RequestName("org.freedesktop.resolve1", dbus.NameFlagDoNotQueue); err != nil {
		t.Fatal(err)
	}
	primary := []Server{{Family: 2, Address: []byte{10, 10, 0, 1}, Port: 853, Name: "dns.example.org"}}
	r := &resolved{servers: primary, base: primary}
	if err := server.Export(r, "/org/freedesktop/resolve1/link/_32", "org.freedesktop.DBus.Properties"); err != nil {
		t.Fatal(err)
	}
	if err := server.Export(r, "/org/freedesktop/resolve1", "org.freedesktop.resolve1.Manager"); err != nil {
		t.Fatal(err)
	}
	if _, err := server.RequestName("org.freedesktop.network1", dbus.NameFlagDoNotQueue); err != nil {
		t.Fatal(err)
	}
	if err := server.Export(&networkd{r}, "/org/freedesktop/network1", networkManager); err != nil {
		t.Fatal(err)
	}
	client, err := dbus.Connect(address)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	links := []net.Interface{{Index: 2, Name: "eth0"}}
	physical := func(string) (bool, bool) { return true, false }
	state := map[int]record{}
	stamp := func(int) (string, error) { r.mu.Lock(); defer r.mu.Unlock(); return fmt.Sprint(r.stamp), nil }
	if err := apply(ctx, client, links, physical, state, stamp); err != nil {
		t.Fatal(err)
	}
	if servers, _ := r.snapshot(); len(servers) != 3 || !reflect.DeepEqual(servers[0], primary[0]) {
		t.Fatal(servers)
	}
	if err := apply(ctx, client, links, physical, state, stamp); err != nil {
		t.Fatal(err)
	}
	if _, calls := r.snapshot(); calls != 1 {
		t.Fatal(calls)
	}
	// A networkd override masks DHCP updates until explicitly reverted. The
	// next timer must use the NEW lease, not keep an old router ahead of Google.
	newPrimary := []Server{{Family: 2, Address: []byte{10, 10, 2, 1}}}
	r.mu.Lock()
	r.base = newPrimary
	r.stamp++
	r.mu.Unlock()
	// Ownership survives the oneshot's state-file serialization.
	saved, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(saved, &state); err != nil {
		t.Fatal(err)
	}
	if err := apply(ctx, client, links, physical, state, stamp); err != nil {
		t.Fatal(err)
	}
	if servers, calls := r.snapshot(); calls != 2 || !reflect.DeepEqual(servers[0], newPrimary[0]) {
		t.Fatal(servers, calls)
	}
	// A newly advertised private domain removes the public fallback again.
	r.mu.Lock()
	r.private = true
	r.stamp++
	r.mu.Unlock()
	if err := apply(ctx, client, links, physical, state, stamp); err != nil {
		t.Fatal(err)
	}
	if servers, _ := r.snapshot(); !reflect.DeepEqual(servers, newPrimary) {
		t.Fatal(servers)
	}
	// An operator's runtime DNS/security policy must never be reverted.
	r.mu.Lock()
	r.private = false
	r.foreign = true
	r.mu.Unlock()
	if err := apply(ctx, client, links, physical, state, stamp); err != nil {
		t.Fatal(err)
	}
	if _, calls := r.snapshot(); calls != 2 {
		t.Fatal(calls)
	}
	// Handing an owned link to another runtime policy removes our additions
	// without calling RevertLinkDNS (which would also clear that policy).
	r.mu.Lock()
	r.foreign = false
	r.mu.Unlock()
	if err := apply(ctx, client, links, physical, state, stamp); err != nil {
		t.Fatal(err)
	}
	r.mu.Lock()
	r.foreign = true
	reverts := r.reverts
	r.mu.Unlock()
	if err := apply(ctx, client, links, physical, state, stamp); err != nil {
		t.Fatal(err)
	}
	if servers, calls := r.snapshot(); calls != 4 || !reflect.DeepEqual(servers, newPrimary) {
		t.Fatal(servers, calls)
	}
	r.mu.Lock()
	if r.reverts != reverts {
		t.Error("foreign runtime policy was reverted")
	}
	r.mu.Unlock()
	// A skipped interface need not even be known to resolved.
	links = append(links, net.Interface{Index: 1, Name: "lo"})
	if err := apply(ctx, client, links, func(string) (bool, bool) { return false, false }, state, stamp); err != nil {
		t.Fatal(err)
	}
	if _, calls := r.snapshot(); calls != 4 {
		t.Fatal(calls)
	}
}

func TestFallbackRespectsSplitDNSAndAddressFamilies(t *testing.T) {
	for _, routeOnly := range []bool{false, true} {
		got := Append(nil, []Domain{{Name: "corp.example", RouteOnly: routeOnly}}, true, false)
		if len(got) != 0 {
			t.Fatal("public DNS added to a private DNS route")
		}
	}
	for _, tc := range []struct {
		v4, v6 bool
		count  int
		family int32
	}{
		{true, false, 2, 2}, {false, true, 2, 10}, {false, false, 0, 0},
	} {
		got := Append(nil, []Domain{{Name: ".", RouteOnly: true}}, tc.v4, tc.v6)
		if len(got) != tc.count {
			t.Fatal(got)
		}
		for _, s := range got {
			if s.Family != tc.family {
				t.Fatal(s)
			}
		}
	}
}
