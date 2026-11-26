package hub

import (
	"context"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"testing"

	"rackoon/internal/netaddrs"
)

// A box on a Tailscale tailnet: servers reached only over the tailnet must
// be able to call home on the box's tailnet address, so the hub lists it
// (after the LAN's) and serves an installer whose agent dials it.
func TestTailnetAddressForAgents(t *testing.T) {
	lanAddress = func() (string, error) { return "10.100.1.5", nil }
	t.Cleanup(func() { lanAddress = defaultRouteAddr })
	pfx := netip.MustParsePrefix
	e := headlessEnv(t, func(c *Config) {
		c.AgentURLAuto, c.AgentListen = true, "0.0.0.0:4744"
		c.Interfaces = func() ([]netaddrs.Interface, error) {
			return []netaddrs.Interface{
				{Name: "enp1s0", Up: true, Prefixes: []netip.Prefix{pfx("10.100.1.5/24")}},
				{Name: "tailscale0", Up: true, Prefixes: []netip.Prefix{pfx("100.64.0.3/32"), pfx("fd7a:115c:a1e0::3/128"), pfx("fe80::3/64")}},
				{Name: "wg0", Up: true, Prefixes: []netip.Prefix{pfx("10.9.0.1/24")}},
			}, nil
		}
	})
	want := []string{"wss://10.100.1.5:4744", "wss://100.64.0.3:4744", "wss://[fd7a:115c:a1e0::3]:4744"}
	if got := e.h.computeHubAddrs(e.h.currentAgentURL(context.Background())); !slices.Equal(got, want) {
		t.Fatalf("addrs = %v, want %v", got, want)
	}

	svc := e.service("pe_1|John")
	for _, hub := range []string{"wss://100.64.0.3:4744", "wss://[fd7a:115c:a1e0::3]:4744"} {
		code, b, _ := svc.req(http.MethodGet, "/api/v1/agent-install.sh?hub="+url.QueryEscape(hub), nil, nil)
		if code != 200 {
			t.Fatalf("%s: %d %s", hub, code, b)
		}
		script := string(b)
		for _, s := range []string{"HUB_URL='" + hub + "'", "DOWNLOAD_BASE='https://" + strings.TrimPrefix(hub, "wss://") + "/download'",
			"TLS_PIN='" + e.h.listenerPin() + "'"} {
			if !strings.Contains(script, s) {
				t.Errorf("%s: script lacks %q", hub, s)
			}
		}
		if strings.Contains(script, "10.100.1.5") {
			t.Errorf("%s: the script names the LAN address", hub)
		}
	}
	// Only the hub's own addresses, as wss://host:port.
	for _, bad := range []string{"wss://100.64.0.9:4744", "wss://10.9.0.1:4744", "https://100.64.0.3:4744",
		"wss://100.64.0.3", "wss://100.64.0.3:4744/x", "wss://u@100.64.0.3:4744"} {
		if p := svc.problem(http.MethodGet, "/api/v1/agent-install.sh?hub="+url.QueryEscape(bad), nil, 400); p.Code != "bad_request" {
			t.Errorf("%s: %+v", bad, p)
		}
	}
}

// A download from an address the server can't reach gives up within
// seconds, so Whombat says it can't reach the box instead of running into
// its own time limit for the whole install.
func TestInstallerDownloadGivesUpQuickly(t *testing.T) {
	sb := newInstallSandbox(t, "systemd")
	sb.write("/mock/curl", "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$CURL_ARGS\"\nexit 28\n", 0o755)
	_, errOut, err := sb.install([]string{"CURL_ARGS=" + sb.root + "/curl-args"}, "--token", "installer-test-token")
	if err == nil || !strings.Contains(errOut, "install.sh: cannot reach ") {
		t.Fatalf("%v\n%s", err, errOut)
	}
	b, _ := os.ReadFile(sb.root + "/curl-args")
	args := strings.Split(strings.TrimSpace(string(b)), "\n")
	i := slices.Index(args, "--connect-timeout")
	if i < 0 || i+1 >= len(args) {
		t.Fatalf("curl %q has no --connect-timeout", args)
	}
	if n, err := strconv.Atoi(args[i+1]); err != nil || n < 1 || n > 30 {
		t.Fatalf("--connect-timeout %q", args[i+1])
	}
}
