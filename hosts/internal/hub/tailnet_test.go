package hub

import (
	"context"
	"fmt"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"os/exec"
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
	for via, hub := range map[string]string{"100.64.0.3": "wss://100.64.0.3:4744", "fd7a:115c:a1e0::3": "wss://[fd7a:115c:a1e0::3]:4744"} {
		code, b, hdr := svc.req(http.MethodGet, "/api/v1/agent-install.sh?via="+url.QueryEscape(via), nil, nil)
		if code != 200 {
			t.Fatalf("%s: %d %s", via, code, b)
		}
		if got := hdr.Get("X-Whombat-Agent-URL"); got != hub {
			t.Errorf("%s: X-Whombat-Agent-URL %q, want %q", via, got, hub)
		}
		script := string(b)
		for _, s := range []string{"HUB_URL='" + hub + "'", "DOWNLOAD_BASE='https://" + strings.TrimPrefix(hub, "wss://") + "/download'",
			"TLS_PIN='" + e.h.listenerPin() + "'"} {
			if !strings.Contains(script, s) {
				t.Errorf("%s: script lacks %q", via, s)
			}
		}
		if strings.Contains(script, "10.100.1.5") {
			t.Errorf("%s: the script names the LAN address", via)
		}
	}
	// Only an address of the Tailscale interface, as an address alone.
	for _, bad := range []string{"100.64.0.9", "10.100.1.5", "10.9.0.1", "fe80::3", "wss://100.64.0.3:4744", "100.64.0.3:4744", "x"} {
		if p := svc.problem(http.MethodGet, "/api/v1/agent-install.sh?via="+url.QueryEscape(bad), nil, 400); p.Code != "bad_request" {
			t.Errorf("%s: %+v", bad, p)
		}
	}
	// The agents' address as usual: named in the header too.
	if code, _, hdr := svc.req(http.MethodGet, "/api/v1/agent-install.sh", nil, nil); code != 200 || hdr.Get("X-Whombat-Agent-URL") != "wss://10.100.1.5:4744" {
		t.Errorf("default: %d %q", code, hdr.Get("X-Whombat-Agent-URL"))
	}
}

// The tailnet installer is on the hub listener's own port, whatever port the
// agents' URL names (a forwarded port, or wss's own 443), and only for the
// Tailscale interface: an address of another VPN in Tailscale's ranges is
// turned away, so Whombat keeps the agents' URL as before, and doesn't take
// a tailnet place in the list.
func TestTailnetInstallerOnlyOnTheTailscaleListener(t *testing.T) {
	pfx := netip.MustParsePrefix
	ifs := []netaddrs.Interface{
		{Name: "enp1s0", Up: true, Prefixes: []netip.Prefix{pfx("10.100.1.5/24")}},
		{Name: "vpn0", Up: true, Prefixes: []netip.Prefix{pfx("100.70.0.9/24"), pfx("fd7a:115c:a1e0::9/64")}},
		{Name: "tailscale0", Up: true, Prefixes: []netip.Prefix{pfx("100.64.0.3/32")}},
	}
	for _, c := range []struct{ agentURL, listen, want string }{
		{"wss://hosts.example:443", ":8443", "wss://100.64.0.3:8443"},
		{"wss://hosts.example", "0.0.0.0:443", "wss://100.64.0.3:443"},
	} {
		t.Run(c.listen, func(t *testing.T) {
			e := headlessEnv(t, func(cfg *Config) {
				cfg.AgentURL, cfg.AgentListen = c.agentURL, c.listen
				cfg.Interfaces = func() ([]netaddrs.Interface, error) { return ifs, nil }
			})
			svc := e.service("pe_1|John")
			code, b, hdr := svc.req(http.MethodGet, "/api/v1/agent-install.sh?via=100.64.0.3", nil, nil)
			if code != 200 || hdr.Get("X-Whombat-Agent-URL") != c.want || !strings.Contains(string(b), "HUB_URL='"+c.want+"'") ||
				!strings.Contains(string(b), "DOWNLOAD_BASE='https://"+strings.TrimPrefix(c.want, "wss://")+"/download'") {
				t.Fatalf("installer: %d %q\n%s", code, hdr.Get("X-Whombat-Agent-URL"), b)
			}
			for _, other := range []string{"100.70.0.9", "fd7a:115c:a1e0::9"} {
				if p := svc.problem(http.MethodGet, "/api/v1/agent-install.sh?via="+url.QueryEscape(other), nil, 400); p.Code != "bad_request" {
					t.Errorf("%s: %+v", other, p)
				}
			}
			got := e.h.computeHubAddrs(e.h.currentAgentURL(context.Background()))
			if got[len(got)-1] != c.want {
				t.Fatalf("addrs = %v: the Tailscale interface's address last", got)
			}
		})
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

// A machine with many addresses still lists its tailnet one: the hub
// serves installers only for addresses it lists, so dropping it at the
// limit would refuse the install it was meant for.
func TestTailnetAddressSurvivesTheLimit(t *testing.T) {
	pfx := netip.MustParsePrefix
	ifs := []netaddrs.Interface{{Name: "tailscale0", Up: true, Prefixes: []netip.Prefix{pfx("100.64.0.3/32"), pfx("fd7a:115c:a1e0::3/128")}}}
	for i := range 20 {
		ifs = append(ifs, netaddrs.Interface{Name: fmt.Sprintf("enp%ds0", i), Up: true,
			Prefixes: []netip.Prefix{pfx(fmt.Sprintf("10.100.%d.5/24", i))}})
	}
	e := headlessEnv(t, func(c *Config) {
		c.AgentURL, c.AgentListen = "wss://hosts.example:8443", ":8443"
		c.Interfaces = func() ([]netaddrs.Interface, error) { return ifs, nil }
	})
	got := e.h.computeHubAddrs(e.h.currentAgentURL(context.Background()))
	if len(got) != maxHubAddrs || got[0] != "wss://hosts.example:8443" ||
		!slices.Equal(got[len(got)-2:], []string{"wss://100.64.0.3:8443", "wss://[fd7a:115c:a1e0::3]:8443"}) {
		t.Fatalf("addrs = %v", got)
	}
	if code, b, _ := e.service("pe_1|John").req(http.MethodGet, "/api/v1/agent-install.sh?via=100.64.0.3", nil, nil); code != 200 {
		t.Fatalf("installer for the tailnet address: %d %s", code, b)
	}

	// The agents' URL already the tailnet address: it takes no second place.
	ifs = ifs[:16] // tailscale0 and 15 LAN addresses
	e2 := headlessEnv(t, func(c *Config) {
		c.AgentURL, c.AgentListen = "wss://100.64.0.3:8443", ":8443"
		c.Interfaces = func() ([]netaddrs.Interface, error) { return ifs, nil }
	})
	got = e2.h.computeHubAddrs(e2.h.currentAgentURL(context.Background()))
	if len(got) != maxHubAddrs || got[0] != "wss://100.64.0.3:8443" || got[15] != "wss://[fd7a:115c:a1e0::3]:8443" ||
		!slices.Contains(got, "wss://10.100.13.5:8443") {
		t.Fatalf("addrs with the tailnet agents' URL = %v", got)
	}
}

// wget gets a timeout too, where it has one: BusyBox can be built
// without -T, and then it is left out rather than failing the install.
func TestInstallerWgetGivesUpQuickly(t *testing.T) {
	for _, c := range []struct {
		name, help string
		want       bool
	}{
		{"GNU", "  -t,  --tries=NUMBER            set number of retries to NUMBER\\n  -T,  --timeout=SECONDS          set all timeout values to SECONDS", true},
		{"BusyBox", "\t-T SEC\t\tNetwork read timeout is SEC seconds", true},
		{"BusyBox without timeouts", "\t-q\t\tQuiet", false},
	} {
		t.Run(c.name, func(t *testing.T) {
			sb := newInstallSandbox(t, "systemd")
			os.Remove(sb.root + "/mock/curl")
			bin := sb.root + "/bin"
			os.MkdirAll(bin, 0o755)
			for _, tool := range []string{"sh", "cat", "cp", "mv", "rm", "mkdir", "mktemp", "chmod", "install", "sed", "awk", "grep",
				"cut", "tr", "head", "sha256sum", "base64", "basename", "printf", "sleep"} {
				if p, err := exec.LookPath(tool); err == nil {
					os.Symlink(p, bin+"/"+tool)
				}
			}
			sb.write("/bin/wget", "#!/bin/sh\nif [ \"$1\" = --help ]; then printf '"+c.help+"\\n'; exit 0; fi\nprintf '%s\\n' \"$@\" > \"$WGET_ARGS\"\nexit 4\n", 0o755)
			_, errOut, err := sb.install([]string{"PATH=" + sb.root + "/mock:" + bin, "WGET_ARGS=" + sb.root + "/wget-args"},
				"--token", "installer-test-token")
			if err == nil || !strings.Contains(errOut, "install.sh: cannot reach ") {
				t.Fatalf("%v\n%s", err, errOut)
			}
			b, _ := os.ReadFile(sb.root + "/wget-args")
			args := strings.Split(strings.TrimSpace(string(b)), "\n")
			i := slices.Index(args, "-T")
			if !c.want {
				if i >= 0 {
					t.Fatalf("wget %q: -T without support for it", args)
				}
				return
			}
			if i < 0 || i+1 >= len(args) {
				t.Fatalf("wget %q has no -T", args)
			}
			if n, err := strconv.Atoi(args[i+1]); err != nil || n < 1 || n > 60 {
				t.Fatalf("-T %q", args[i+1])
			}
			// GNU wget tries 20 times by default; one try, as curl. BusyBox has no such option.
			if gnu := strings.Contains(c.help, "--tries"); slices.Contains(args, "--tries=1") != gnu {
				t.Fatalf("wget %q: --tries=1 should be there only for GNU wget", args)
			}
		})
	}
}
