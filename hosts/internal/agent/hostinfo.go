package agent

import (
	"bufio"
	"context"
	"net"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
)

// MachineID returns /etc/machine-id (or the D-Bus fallback), trimmed; on
// a Mac the hardware UUID (IOPlatformUUID); on Windows its MachineGuid.
func MachineID() string {
	if id, ok := platformMachineID(); ok {
		return id
	}
	if runtime.GOOS == "darwin" {
		return darwinMachineID()
	}
	for _, p := range []string{"/etc/machine-id", "/var/lib/dbus/machine-id"} {
		if b, err := os.ReadFile(p); err == nil {
			if s := strings.TrimSpace(string(b)); s != "" {
				return s
			}
		}
	}
	return ""
}

var (
	darwinIDOnce sync.Once
	darwinID     string
	ioregUUIDRe  = regexp.MustCompile(`"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{36})"`)
)

// darwinMachineID reads the Mac's hardware UUID once (it never changes);
// it is lower case like /etc/machine-id's hex.
func darwinMachineID() string {
	darwinIDOnce.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, "/usr/sbin/ioreg", "-rd1", "-c", "IOPlatformExpertDevice")
		cmd.Env = []string{"PATH=/usr/bin:/bin:/usr/sbin:/sbin", "LC_ALL=C"}
		out, err := cmd.Output()
		if err != nil {
			return
		}
		if m := ioregUUIDRe.FindSubmatch(out); m != nil {
			darwinID = strings.ToLower(string(m[1]))
		}
	})
	return darwinID
}

// Hostname returns the short host name.
func Hostname() string {
	h, _ := os.Hostname()
	if i := strings.IndexByte(h, '.'); i > 0 {
		h = h[:i]
	}
	return h
}

// OSPrettyName returns PRETTY_NAME from os-release (on Windows the name
// Windows shows: "Windows 11 Pro 24H2 (26100.2605)").
func OSPrettyName() string {
	if name, ok := platformOSName(); ok {
		return name
	}
	for _, p := range []string{"/etc/os-release", "/usr/lib/os-release"} {
		f, err := os.Open(p)
		if err != nil {
			continue
		}
		defer f.Close()
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			line := sc.Text()
			if v, ok := strings.CutPrefix(line, "PRETTY_NAME="); ok {
				return strings.Trim(v, `"'`)
			}
		}
	}
	return "Linux"
}

// SourceAddress returns the local IP address used to reach hubURL (no
// packets are sent: UDP "connect" only selects the route). When the hub is
// reached over loopback (a tunnel), the default-route address is used.
func SourceAddress(hubURL string) string {
	host := "1.1.1.1"
	port := "443"
	if u, err := url.Parse(hubURL); err == nil && u.Hostname() != "" {
		host = u.Hostname()
		if u.Port() != "" {
			port = u.Port()
		}
	}
	ip := routeSource(host, port)
	if ip == nil || ip.IsLoopback() {
		if def := routeSource("1.1.1.1", "443"); def != nil {
			ip = def
		}
	}
	if ip == nil {
		return ""
	}
	return ip.String()
}

func routeSource(host, port string) net.IP {
	d := net.Dialer{Timeout: 2 * time.Second}
	c, err := d.Dial("udp", net.JoinHostPort(host, port))
	if err != nil {
		return nil
	}
	defer c.Close()
	if a, ok := c.LocalAddr().(*net.UDPAddr); ok {
		return a.IP
	}
	return nil
}

// HubHTTPBase converts the configured hub URL (wss://host:port[/path]) into
// the https base URL used for enrollment.
func HubHTTPBase(hub string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(hub))
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "wss", "https":
		u.Scheme = "https"
	case "ws", "http":
		// Plain connections are refused: the agent always uses TLS.
		return "", &url.Error{Op: "parse", URL: hub, Err: errInsecureHub}
	default:
		return "", &url.Error{Op: "parse", URL: hub, Err: errBadHubScheme}
	}
	if u.Host == "" {
		return "", &url.Error{Op: "parse", URL: hub, Err: errBadHubScheme}
	}
	u.RawQuery, u.Fragment = "", ""
	return strings.TrimRight(u.String(), "/"), nil
}

// HubWSBase converts the configured hub URL into the wss base URL.
func HubWSBase(hub string) (string, error) {
	b, err := HubHTTPBase(hub)
	if err != nil {
		return "", err
	}
	return "wss" + strings.TrimPrefix(b, "https"), nil
}

type hubURLError string

func (e hubURLError) Error() string { return string(e) }

const (
	errInsecureHub  = hubURLError("the hub URL must use wss:// (TLS)")
	errBadHubScheme = hubURLError("the hub URL must look like wss://host:port")
)
