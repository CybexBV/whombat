package broker

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"rackoon/internal/agent"
	"rackoon/internal/proto"
)

// pveDriver brokers Proxmox VE guests on the local node. It runs as root
// and uses local interfaces only:
//
//	QEMU VNC:     QMP set_password/expire_password (random one-time password,
//	              30 s) on /var/run/qemu-server/<vmid>.qmp, then RFB with VNC
//	              auth on /var/run/qemu-server/<vmid>.vnc (what `qm vncproxy`
//	              does); the browser sees security type None
//	QEMU SPICE:   QMP query-spice + set_password; TLS to 127.0.0.1:<tls-port>
//	              (verified against /etc/pve/pve-root-ca.pem); the ticket is
//	              injected by the agent in each channel's link phase
//	QEMU serial:  /var/run/qemu-server/<vmid>.serialN (QEMU socket chardev)
//	LXC shell:    `pct enter <vmid>` on a PTY
//	LXC tty:      `pct console <vmid>` on a PTY
//	screenshot:   QMP screendump (PNG) into the agent's state dir
//	actions:      qm / pct start, shutdown, reboot, stop, sendkey; qm suspend /
//	              resume (pause); qm / pct snapshot, rollback, delsnapshot
//	snapshots:    API /nodes/<node>/{qemu,lxc}/<vmid>/snapshot with the
//	              collector's read-only token (pvesh as a fallback)
//
// When the agent runs as a hardened systemd service, commands that start
// guests or open shells (qm/pct) run in a transient unit via systemd-run,
// so guests and shells do not inherit the agent's sandbox.
type pveDriver struct {
	cfg       *agent.Config
	runDir    string // /var/run/qemu-server
	confDir   string // /etc/pve/local
	caPath    string // /etc/pve/pve-root-ca.pem
	tmpDir    string
	inSystemd bool

	spiceMu sync.Mutex

	mg *pveManage // proto.StreamManage (pve_manage.go)
}

func newPVEDriver(cfg *agent.Config) *pveDriver {
	stateDir := agent.DefaultStateDir
	if cfg != nil && cfg.StateDir != "" {
		stateDir = cfg.StateDir
	}
	_, hasRun := os.LookupEnv("INVOCATION_ID")
	d := &pveDriver{
		cfg:       cfg,
		runDir:    "/var/run/qemu-server",
		confDir:   "/etc/pve/local",
		caPath:    "/etc/pve/pve-root-ca.pem",
		tmpDir:    filepath.Join(stateDir, "tmp"),
		inSystemd: hasRun && fileExists("/usr/bin/systemd-run"),
		mg:        newPVEManage(cfg),
	}
	d.mg.run = d.hostCommand
	return d
}

// hostCommand runs the manage stream's root commands. pvesm, ha-manager
// and pvesh run outside the agent's sandbox, like qm and pct: deleting an
// ISO image removes a file in the storage's directory and a new backup
// job gets a state file in /var/lib/pve-manager/jobs, which
// ProtectSystem=strict keeps read-only for the agent. pveum only writes
// /etc/pve (writable in the unit) and runs directly.
func (d *pveDriver) hostCommand(ctx context.Context, argv ...string) ([]byte, error) {
	wrapped := d.hostArgv(argv)
	out, err := runCommand(ctx, wrapped...)
	if err != nil && wrapped[0] != argv[0] {
		var ce *cmdError
		if errors.As(err, &ce) {
			ce.name = argv[0]
		} else {
			err = errors.New(argv[0] + strings.TrimPrefix(err.Error(), wrapped[0]))
		}
	}
	return out, err
}

// hostArgv is argv as hostCommand runs it.
func (d *pveDriver) hostArgv(argv []string) []string {
	if !d.inSystemd || (argv[0] != "pvesm" && argv[0] != "ha-manager" && argv[0] != "pvesh") {
		return argv
	}
	name := argv[0]
	if fileExists("/usr/sbin/" + name) {
		name = "/usr/sbin/" + name
	}
	return d.tool(false, append([]string{name}, argv[1:]...)...)
}

func fileExists(p string) bool { _, err := os.Stat(p); return err == nil }

var vmidRe = regexp.MustCompile(`^[1-9][0-9]{2,8}$`)

func pveVMID(g *proto.Guest) (string, error) {
	if !vmidRe.MatchString(g.ID) {
		return "", codeErr(CodeInvalid, "invalid Proxmox VE guest id")
	}
	if g.Node != "" && g.Node != localNodeName() {
		return "", codeErr(CodeUnsupported, "the guest runs on node "+g.Node+"; open it through that node's agent")
	}
	return g.ID, nil
}

func localNodeName() string {
	h, _ := os.Hostname()
	if i := strings.IndexByte(h, '.'); i > 0 {
		h = h[:i]
	}
	return h
}

// tool returns the command line for a PVE tool, wrapped in systemd-run
// when the agent runs sandboxed. pty selects --pty (interactive) instead
// of --pipe.
func (d *pveDriver) tool(pty bool, args ...string) []string {
	if !d.inSystemd {
		return args
	}
	w := []string{"/usr/bin/systemd-run", "--quiet", "--wait", "--collect",
		"--service-type=exec", "--property=KillMode=mixed",
		"--description=Whombat console/action helper"}
	if pty {
		w = append(w, "--pty", "--setenv=TERM=xterm-256color")
	} else {
		w = append(w, "--pipe")
	}
	return append(append(w, "--"), args...)
}

// runTool runs a qm/pct command and returns its combined output.
func (d *pveDriver) runTool(ctx context.Context, args ...string) (string, error) {
	argv := d.tool(false, args...)
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Env = baseEnv()
	cmd.Stdin = nil
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	err := cmd.Run()
	s := strings.TrimSpace(out.String())
	if err != nil {
		if s == "" {
			s = err.Error()
		}
		return s, errors.New(lastLine(s))
	}
	return s, nil
}

func lastLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.LastIndexByte(s, '\n'); i >= 0 {
		s = s[i+1:]
	}
	if len(s) > 300 {
		s = s[:300]
	}
	return s
}

func pveTool(g *proto.Guest) string {
	if g.Kind == "container" {
		return "pct"
	}
	return "qm"
}

func (d *pveDriver) state(ctx context.Context, g *proto.Guest) (string, error) {
	vmid, err := pveVMID(g)
	if err != nil {
		return "", err
	}
	if st, ok := d.fastState(g, vmid); ok {
		return st, nil
	}
	// `qm status` / `pct status` print "status: running|stopped".
	cmd := exec.CommandContext(ctx, pveTool(g), "status", vmid)
	cmd.Env = baseEnv()
	out, err := cmd.CombinedOutput()
	if err != nil {
		msg := lastLine(string(out))
		if strings.Contains(msg, "does not exist") {
			return "", codeErr(CodeUnknownGuest, "guest not found on this node")
		}
		return "", codeErr(CodePlatformError, "status: "+msg)
	}
	s := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(string(out)), "status:"))
	switch s {
	case "running":
		return proto.StateRunning, nil
	case "stopped":
		return proto.StateStopped, nil
	}
	return s, nil
}

// fastState checks the state the way PVE does internally, without
// starting a Perl tool: QEMU = the pid file's process has that pid file on
// its command line (PVE::QemuServer::Helpers::vm_running_locally); LXC =
// the container's monitor socket exists (PVE::LXC::list_active_containers).
// ok is false when the config cannot be read (pmxcfs down): the caller
// falls back to qm/pct status.
func (d *pveDriver) fastState(g *proto.Guest, vmid string) (string, bool) {
	sub := "qemu-server"
	if g.Kind == "container" {
		sub = "lxc"
	}
	if _, err := os.Stat(filepath.Join(d.confDir, sub, vmid+".conf")); err != nil {
		return "", false
	}
	if g.Kind == "container" {
		n, err := unixPeersListening("@/var/lib/lxc/" + vmid + "/command")
		if err != nil {
			return "", false
		}
		if n {
			return proto.StateRunning, true
		}
		return proto.StateStopped, true
	}
	pidFile := filepath.Join(d.runDir, vmid+".pid")
	b, err := os.ReadFile(pidFile)
	if err != nil {
		return proto.StateStopped, true
	}
	pid := strings.TrimSpace(string(b))
	if _, err := strconv.Atoi(pid); err != nil {
		return proto.StateStopped, true
	}
	cmdline, err := os.ReadFile("/proc/" + pid + "/cmdline")
	if err != nil || !strings.Contains(string(cmdline), "\x00-pidfile\x00"+pidFile+"\x00") {
		return proto.StateStopped, true
	}
	if stat, err := os.ReadFile("/proc/" + pid + "/stat"); err == nil {
		if i := strings.LastIndexByte(string(stat), ')'); i > 0 && i+2 < len(stat) && stat[i+2] == 'Z' {
			return proto.StateStopped, true
		}
	}
	return proto.StateRunning, true
}

// unixPeersListening reports whether a Unix socket with this path (or
// abstract name, "@...") is listed in /proc/net/unix.
func unixPeersListening(path string) (bool, error) {
	f, err := os.Open("/proc/net/unix")
	if err != nil {
		return false, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) >= 8 && fields[7] == path {
			return true, nil
		}
	}
	return false, sc.Err()
}

func (d *pveDriver) power(ctx context.Context, g *proto.Guest, action string) error {
	vmid, err := pveVMID(g)
	if err != nil {
		return err
	}
	t := pveTool(g)
	var args []string
	switch action {
	case proto.ActionStart:
		args = []string{t, "start", vmid}
	case proto.ActionShutdown:
		args = []string{t, "shutdown", vmid, "--timeout", "55"}
	case proto.ActionStop:
		if _, err := d.runTool(ctx, t, "shutdown", vmid, "--timeout", "30"); err == nil {
			return nil
		}
		args = []string{t, "stop", vmid}
	case proto.ActionForceStop:
		args = []string{t, "stop", vmid}
	case proto.ActionReboot, proto.ActionRestart:
		args = []string{t, "reboot", vmid, "--timeout", "55"}
	case proto.ActionCtrlAltDel:
		if t != "qm" {
			return codeErr(CodeUnsupportedAction, "containers have no keyboard")
		}
		args = []string{"qm", "sendkey", vmid, "ctrl-alt-delete"}
	case proto.ActionPause, proto.ActionResume:
		if t != "qm" {
			return codeErr(CodeUnsupportedAction, "Proxmox VE containers cannot be paused")
		}
		verb := "suspend" // without --todisk: pause the vCPUs
		if action == proto.ActionResume {
			verb = "resume"
		}
		args = []string{"qm", verb, vmid}
	default:
		return codeErr(CodeUnsupportedAction, "unsupported action")
	}
	if _, err := d.runTool(ctx, args...); err != nil {
		return codeErr(CodePlatformError, strings.Join(args[:2], " ")+": "+err.Error())
	}
	return nil
}

// qmp connects to the VM's QMP socket.
func (d *pveDriver) qmp(ctx context.Context, vmid string) (*qmpClient, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	q, err := dialQMP(ctx, filepath.Join(d.runDir, vmid+".qmp"))
	if err != nil {
		return nil, codeErr(CodePlatformError, "QMP: "+err.Error())
	}
	return q, nil
}

func (d *pveDriver) screenshot(ctx context.Context, g *proto.Guest) ([]byte, error) {
	vmid, err := pveVMID(g)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(d.tmpDir, 0o700); err != nil {
		return nil, codeErr(CodeCaptureFailed, err.Error())
	}
	name := filepath.Join(d.tmpDir, "screen-"+vmid+"-"+randToken(6)+".png")
	defer os.Remove(name)
	q, err := d.qmp(ctx, vmid)
	if err != nil {
		return nil, err
	}
	_, err = q.run("screendump", map[string]any{"filename": name, "format": "png"})
	q.Close()
	if err != nil {
		return nil, codeErr(CodeCaptureFailed, err.Error())
	}
	b, err := os.ReadFile(name)
	if err != nil {
		return nil, codeErr(CodeCaptureFailed, err.Error())
	}
	return b, nil
}

// setOneTimePassword sets a random display password valid for new
// connections during 30 s (existing connections stay).
func (d *pveDriver) setOneTimePassword(ctx context.Context, vmid, protocol string, length int) (string, error) {
	pw := randToken(length)
	q, err := d.qmp(ctx, vmid)
	if err != nil {
		return "", err
	}
	defer q.Close()
	args := map[string]any{"protocol": protocol, "password": pw}
	if protocol == "spice" {
		args["connected"] = "keep"
	}
	if _, err := q.run("set_password", args); err != nil {
		return "", codeErr(CodeOpenFailed, err.Error())
	}
	if _, err := q.run("expire_password", map[string]any{"protocol": protocol, "time": "+30"}); err != nil {
		return "", codeErr(CodeOpenFailed, err.Error())
	}
	return pw, nil
}

// randToken returns n random characters from [A-Za-z0-9].
func randToken(n int) string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, n)
	rnd := make([]byte, n)
	_, _ = rand.Read(rnd)
	for i := range b {
		b[i] = alphabet[int(rnd[i])%len(alphabet)]
	}
	return string(b)
}

// readPVEConf reads a guest config from /etc/pve/local (main section).
func (d *pveDriver) readConf(g *proto.Guest) (map[string]string, error) {
	sub := "qemu-server"
	if g.Kind == "container" {
		sub = "lxc"
	}
	f, err := os.Open(filepath.Join(d.confDir, sub, g.ID+".conf"))
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return parsePVEConf(f), nil
}

func parsePVEConf(r io.Reader) map[string]string {
	conf := map[string]string{}
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if strings.HasPrefix(line, "[") {
			break // snapshots / pending sections
		}
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if k, v, ok := strings.Cut(line, ":"); ok {
			conf[strings.TrimSpace(k)] = strings.TrimSpace(v)
		}
	}
	return conf
}

// PVEDisplay describes a Proxmox VE guest's console devices from its
// configuration (qm config / pct config, or the API's .../config). kind is
// "vm" or "container". Collectors pass the result to Caps.
func PVEDisplay(kind string, conf map[string]string, running bool) GuestDisplay {
	d := GuestDisplay{Kind: kind, Running: running}
	if kind == "container" {
		return d
	}
	vga := conf["vga"]
	typ, _, _ := strings.Cut(vga, ",")
	typ = strings.TrimPrefix(typ, "type=")
	d.Graphics = []string{}
	switch {
	case strings.HasPrefix(typ, "serial"):
		d.Unavailable = map[string]string{proto.ProtoVNC: "the VM's display is its serial console (vga: " + typ + ")"}
	case typ == "none":
		d.Unavailable = map[string]string{proto.ProtoVNC: "the VM has no display (vga: none)"}
	default:
		d.Graphics = append(d.Graphics, proto.ProtoVNC)
		if strings.HasPrefix(typ, "qxl") {
			d.Graphics = append(d.Graphics, proto.ProtoSPICE)
		}
	}
	for i := 0; i < 4; i++ {
		if conf["serial"+strconv.Itoa(i)] == "socket" {
			d.Serial = true
			break
		}
	}
	return d
}

func (d *pveDriver) serialSocket(g *proto.Guest) (string, error) {
	conf, err := d.readConf(g)
	if err != nil {
		return "", codeErr(CodePlatformError, "cannot read the VM config: "+err.Error())
	}
	for i := 0; i < 4; i++ {
		if conf["serial"+strconv.Itoa(i)] == "socket" {
			return filepath.Join(d.runDir, g.ID+".serial"+strconv.Itoa(i)), nil
		}
	}
	return "", codeErr(CodeProtocolUnavailable, "the VM has no serial socket (set serial0: socket)")
}

func (d *pveDriver) console(ctx context.Context, g *proto.Guest, req proto.ConsoleRequest) (agent.ConsoleSession, string, error) {
	vmid, err := pveVMID(g)
	if err != nil {
		return nil, "", err
	}
	octx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	switch {
	case g.Kind == "container" && (req.Protocol == proto.ProtoShell || req.Protocol == proto.ProtoTTY):
		args := lxcShellCommand(vmid)
		if req.Protocol == proto.ProtoTTY {
			conf, err := d.readConf(g)
			if err != nil {
				return nil, "", codeErr(CodePlatformError, "cannot read the container config: "+err.Error())
			}
			args = lxcConsoleCommand(vmid, conf["cmode"])
		}
		p, err := startPTY(d.tool(true, args...), baseEnv(), req.Cols, req.Rows)
		if err != nil {
			return nil, "", codeErr(CodeOpenFailed, err.Error())
		}
		return p.session(req.Protocol), "", nil

	case g.Kind == "vm" && req.Protocol == proto.ProtoSerial:
		path, err := d.serialSocket(g)
		if err != nil {
			return nil, "", err
		}
		var dl net.Dialer
		c, err := dl.DialContext(octx, "unix", path)
		if err != nil {
			return nil, "", codeErr(CodeOpenFailed, "serial socket: "+err.Error())
		}
		return &termSession{protocol: proto.ProtoSerial, rw: c}, "", nil

	case g.Kind == "vm" && req.Protocol == proto.ProtoVNC:
		// VNC auth uses at most 8 password characters.
		pw, err := d.setOneTimePassword(octx, vmid, "vnc", 8)
		if err != nil {
			return nil, "", err
		}
		var dl net.Dialer
		c, err := dl.DialContext(octx, "unix", filepath.Join(d.runDir, vmid+".vnc"))
		if err != nil {
			return nil, "", codeErr(CodeOpenFailed, "VNC socket: "+err.Error())
		}
		c.SetDeadline(time.Now().Add(15 * time.Second))
		rw, info, err := RFBClientHandshake(c, pw)
		if err != nil {
			c.Close()
			return nil, "", codeErr(CodeOpenFailed, err.Error())
		}
		c.SetDeadline(time.Time{})
		return newRFBSession(rw, info), info.Resolution(), nil

	case g.Kind == "vm" && req.Protocol == proto.ProtoSPICE:
		dial, err := d.spiceDialer(octx, vmid)
		if err != nil {
			return nil, "", err
		}
		first, pw, inject, err := dial(octx)
		if err != nil {
			return nil, "", codeErr(CodeOpenFailed, "SPICE: "+err.Error())
		}
		return &spiceSession{dial: dial, first: first, firstPW: pw, firstIn: inject}, "", nil
	}
	return nil, "", codeErr(CodeUnsupportedProtocol, "protocol not supported for this guest")
}

// lxcShellCommand is `pct enter` with a clean login environment: bash when
// present, else sh, as a login shell (like the Incus shell).
func lxcShellCommand(vmid string) []string {
	return []string{"lxc-attach", "-n", vmid, "--clear-env",
		"--set-var", "TERM=xterm-256color", "--set-var", "HOME=/root",
		"--set-var", "USER=root", "--set-var", "LOGNAME=root",
		"--set-var", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"--", "/bin/sh", "-c", "cd /root 2>/dev/null || cd /; if [ -x /bin/bash ]; then exec /bin/bash -l; fi; exec /bin/sh -l"}
}

// lxcConsoleCommand is `pct console` (PVE::LXC::get_console_command) with
// the keyboard escape disabled (-e -1), so every key reaches the guest.
func lxcConsoleCommand(vmid, cmode string) []string {
	switch cmode {
	case "console":
		return []string{"lxc-console", "-n", vmid, "-t", "0", "-e", "-1"}
	case "shell":
		return lxcShellCommand(vmid)
	}
	return []string{"lxc-console", "-n", vmid, "-e", "-1"} // "tty" (default)
}

// spiceDialer returns a dialer that opens TLS connections to the VM's SPICE
// port with a fresh one-time ticket when the previous one is about to
// expire.
func (d *pveDriver) spiceDialer(ctx context.Context, vmid string) (spiceDialer, error) {
	q, err := d.qmp(ctx, vmid)
	if err != nil {
		return nil, err
	}
	raw, err := q.run("query-spice", nil)
	q.Close()
	if err != nil {
		return nil, codeErr(CodeProtocolUnavailable, "SPICE is not enabled for this VM")
	}
	var info struct {
		Enabled bool   `json:"enabled"`
		Host    string `json:"host"`
		Port    int    `json:"port"`
		TLSPort int    `json:"tls-port"`
	}
	if err := json.Unmarshal(raw, &info); err != nil || !info.Enabled {
		return nil, codeErr(CodeProtocolUnavailable, "SPICE is not enabled for this VM")
	}
	host, ok := isLoopbackOrAny(info.Host)
	if !ok {
		return nil, codeErr(CodeProtocolUnavailable, "SPICE does not listen on loopback")
	}
	tlsCfg := &tls.Config{MinVersion: tls.VersionTLS12}
	if pem, err := os.ReadFile(d.caPath); err == nil {
		pool := x509.NewCertPool()
		pool.AppendCertsFromPEM(pem)
		tlsCfg.InsecureSkipVerify = true // no host name check; chain verified below
		tlsCfg.VerifyConnection = func(cs tls.ConnectionState) error {
			if len(cs.PeerCertificates) == 0 {
				return errors.New("no certificate")
			}
			inter := x509.NewCertPool()
			for _, c := range cs.PeerCertificates[1:] {
				inter.AddCert(c)
			}
			_, err := cs.PeerCertificates[0].Verify(x509.VerifyOptions{Roots: pool, Intermediates: inter})
			return err
		}
	} else {
		tlsCfg.InsecureSkipVerify = true // loopback only
	}
	var mu sync.Mutex
	var pw string
	var pwAt time.Time
	return func(ctx context.Context) (io.ReadWriteCloser, string, bool, error) {
		mu.Lock()
		defer mu.Unlock()
		if pw == "" || time.Since(pwAt) > 20*time.Second {
			p, err := d.setOneTimePassword(ctx, vmid, "spice", 20)
			if err != nil {
				return nil, "", false, err
			}
			pw, pwAt = p, time.Now()
		}
		var dl net.Dialer
		var c net.Conn
		var err error
		switch {
		case info.TLSPort > 0:
			raw, derr := dl.DialContext(ctx, "tcp", net.JoinHostPort(host, strconv.Itoa(info.TLSPort)))
			if derr != nil {
				return nil, "", false, derr
			}
			tc := tls.Client(raw, tlsCfg)
			tc.SetDeadline(time.Now().Add(15 * time.Second))
			if err := tc.HandshakeContext(ctx); err != nil {
				raw.Close()
				return nil, "", false, fmt.Errorf("TLS: %w", err)
			}
			tc.SetDeadline(time.Time{})
			c = tc
		case info.Port > 0:
			c, err = dl.DialContext(ctx, "tcp", net.JoinHostPort(host, strconv.Itoa(info.Port)))
			if err != nil {
				return nil, "", false, err
			}
		default:
			return nil, "", false, errors.New("no SPICE port")
		}
		return c, pw, true, nil
	}, nil
}

func (d *pveDriver) list(ctx context.Context) ([]proto.Guest, error) {
	var out []proto.Guest
	node := localNodeName()
	for _, kind := range []string{"vm", "container"} {
		sub := "qemu-server"
		if kind == "container" {
			sub = "lxc"
		}
		files, _ := filepath.Glob(filepath.Join(d.confDir, sub, "*.conf"))
		for _, f := range files {
			id := strings.TrimSuffix(filepath.Base(f), ".conf")
			g := proto.Guest{ID: id, Kind: kind, Node: node}
			if n, err := strconv.Atoi(id); err == nil {
				g.VMID = n
			}
			fh, err := os.Open(f)
			if err != nil {
				continue
			}
			conf := parsePVEConf(fh)
			fh.Close()
			g.Name = conf["name"]
			if g.Name == "" {
				g.Name = conf["hostname"]
			}
			st, err := d.state(ctx, &g)
			if err != nil {
				continue
			}
			g.State = st
			g.Console = Caps(proto.PlatformPVE, PVEDisplay(kind, conf, st == proto.StateRunning))
			out = append(out, g)
		}
	}
	return out, nil
}

// actionState is state() with the QMP run state of a running VM, so that
// paused VMs are told apart (qm status says "running" for them). It is
// used by actions only: thumbnails and consoles keep the cheaper state().
func (d *pveDriver) actionState(ctx context.Context, g *proto.Guest) (string, error) {
	st, err := d.state(ctx, g)
	if err != nil || st != proto.StateRunning || g.Kind != "vm" {
		return st, err
	}
	q, err := d.qmp(ctx, g.ID)
	if err != nil {
		return st, nil
	}
	defer q.Close()
	raw, err := q.run("query-status", nil)
	if err != nil {
		return st, nil
	}
	var qs struct {
		Status string `json:"status"`
	}
	if json.Unmarshal(raw, &qs) == nil && (qs.Status == "paused" || qs.Status == "suspended") {
		return proto.StatePaused, nil
	}
	return st, nil
}

// ---- snapshots ---------------------------------------------------------------

// pveSnapshotEntry is one element of GET .../snapshot. The entry named
// "current" is the live state; its parent is the current snapshot.
type pveSnapshotEntry struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Parent      string `json:"parent"`
	SnapTime    int64  `json:"snaptime"`
	VMState     any    `json:"vmstate"` // 0/1 (number or string)
}

func parsePVESnapshots(entries []pveSnapshotEntry) []proto.Snapshot {
	current := ""
	for _, e := range entries {
		if e.Name == "current" {
			current = e.Parent
		}
	}
	out := make([]proto.Snapshot, 0, len(entries))
	for _, e := range entries {
		if e.Name == "current" {
			continue
		}
		s := proto.Snapshot{Name: e.Name, Description: strings.TrimSpace(e.Description), Parent: e.Parent, Current: e.Name == current}
		if e.SnapTime > 0 {
			s.Created = time.Unix(e.SnapTime, 0).UTC()
		}
		switch v := e.VMState.(type) {
		case float64:
			s.WithMemory = v != 0
		case string:
			s.WithMemory = v != "" && v != "0"
		case bool:
			s.WithMemory = v
		}
		out = append(out, s)
	}
	return out
}

func (d *pveDriver) snapshotPath(g *proto.Guest, vmid string) string {
	sub := "qemu"
	if g.Kind == "container" {
		sub = "lxc"
	}
	node := g.Node
	if node == "" {
		node = localNodeName()
	}
	return "/nodes/" + url.PathEscape(node) + "/" + sub + "/" + vmid + "/snapshot"
}

func (d *pveDriver) snapshots(ctx context.Context, g *proto.Guest) ([]proto.Snapshot, error) {
	vmid, err := pveVMID(g)
	if err != nil {
		return nil, err
	}
	path := d.snapshotPath(g, vmid)
	var entries []pveSnapshotEntry
	if err := d.apiGet(ctx, path, &entries); err != nil {
		// No token yet (or the API is down): ask pvesh, which runs as root.
		out, perr := d.runTool(ctx, "pvesh", "get", path, "--output-format", "json")
		if perr != nil {
			return nil, codeErr(CodePlatformError, "snapshot list: "+err.Error()+"; pvesh: "+perr.Error())
		}
		if jerr := json.Unmarshal([]byte(out), &entries); jerr != nil {
			return nil, codeErr(CodePlatformError, "snapshot list: "+jerr.Error())
		}
	}
	return parsePVESnapshots(entries), nil
}

// apiGet reads the local PVE API with the collector's API token.
func (d *pveDriver) apiGet(ctx context.Context, path string, v any) error {
	base, tokenFile := "https://127.0.0.1:8006/api2/json", filepath.Join(agent.DefaultConfigDir, "pve-token")
	if d.cfg != nil {
		if d.cfg.PVE.URL != "" {
			base = strings.TrimRight(d.cfg.PVE.URL, "/")
		}
		if d.cfg.PVE.TokenFile != "" {
			tokenFile = d.cfg.PVE.TokenFile
		}
	}
	b, err := os.ReadFile(tokenFile)
	if err != nil {
		return err
	}
	token := strings.TrimSpace(string(b))
	if token == "" || strings.ContainsAny(token, "\r\n") {
		return errors.New("empty or invalid API token file")
	}
	u, err := url.Parse(base)
	if err != nil {
		return err
	}
	tlsCfg := &tls.Config{MinVersion: tls.VersionTLS12, InsecureSkipVerify: true} // loopback; chain checked below when possible
	if pem, err := os.ReadFile(d.caPath); err == nil && u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost" && u.Hostname() != "::1" {
		pool := x509.NewCertPool()
		pool.AppendCertsFromPEM(pem)
		tlsCfg = &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: pool, ServerName: u.Hostname()}
	}
	hc := &http.Client{Timeout: 20 * time.Second, Transport: &http.Transport{TLSClientConfig: tlsCfg, Proxy: nil}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "PVEAPIToken="+token)
	resp, err := hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("PVE API %s: %s", path, resp.Status)
	}
	var env struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&env); err != nil {
		return err
	}
	return json.Unmarshal(env.Data, v)
}

func (d *pveDriver) snapshotCreate(ctx context.Context, g *proto.Guest, name, description string, memory bool) error {
	vmid, err := pveVMID(g)
	if err != nil {
		return err
	}
	t := pveTool(g)
	args := []string{t, "snapshot", vmid, name}
	if description != "" {
		args = append(args, "--description", description)
	}
	if memory && t == "qm" {
		if st, _ := d.state(ctx, g); st == proto.StateRunning {
			args = append(args, "--vmstate", "1")
		}
	}
	if _, err := d.runTool(ctx, args...); err != nil {
		return codeErr(CodePlatformError, t+" snapshot: "+err.Error())
	}
	return nil
}

func (d *pveDriver) snapshotRestore(ctx context.Context, g *proto.Guest, name string) error {
	vmid, err := pveVMID(g)
	if err != nil {
		return err
	}
	t := pveTool(g)
	// PVE stops a running guest first; a snapshot with RAM state resumes
	// it running.
	if _, err := d.runTool(ctx, t, "rollback", vmid, name); err != nil {
		return codeErr(CodePlatformError, t+" rollback: "+err.Error())
	}
	return nil
}

func (d *pveDriver) snapshotDelete(ctx context.Context, g *proto.Guest, name string) error {
	vmid, err := pveVMID(g)
	if err != nil {
		return err
	}
	t := pveTool(g)
	if _, err := d.runTool(ctx, t, "delsnapshot", vmid, name); err != nil {
		return codeErr(CodePlatformError, t+" delsnapshot: "+err.Error())
	}
	return nil
}
