package collect

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"rackoon/internal/agent"
	"rackoon/internal/agent/broker"
	"rackoon/internal/proto"
)

const (
	pveDefaultURL       = "https://127.0.0.1:8006/api2/json"
	pveDefaultTokenFile = "/etc/whombat-agent/pve-token"
	pveUser             = "whombat@pve"
)

// pveCollector reads the local Proxmox VE API with a read-only token.
type pveCollector struct {
	lastGood time.Time // last successful fast run (guests kept for keepOnError)
	cfg      *agent.Config
	c        *collector

	apiMu         sync.Mutex // serializes client / token setup
	client        *http.Client
	baseURL       string
	token         string // "USER@REALM!TOKENID=SECRET", never logged
	provisionedAt time.Time
	authFailSince time.Time

	mu         sync.Mutex
	enabled    bool
	err        string
	node       string
	version    string
	versionAt  time.Time
	cluster    *proto.PVECluster
	clusterAt  time.Time
	haStarted  int
	haTotal    int
	nodes      []proto.PVENode
	guests     []proto.Guest
	storages   []proto.PVEStorage
	backups    *proto.PVEBackups
	lastBackup map[int]*proto.BackupMark
	prev       map[int]pveSample
	cfgCache   map[int]*pveGuestCfg
	taskLogs   map[string]*vzdumpLog

	// Run state of QEMU VMs (qmpstatus: running, paused, suspended,
	// prelaunch), every pveQMPEvery.
	qmp   map[int]string
	qmpAt time.Time
	// Snapshot counts and the oldest snapshot's time (slow path).
	snaps      map[int]int
	oldestSnap map[int]time.Time
	// Backup jobs of the cluster (slow path; nil until read once) and the
	// pool of each guest (fast path), for Guest.BackupJob.
	backupJobs []pveBackupJob
	pools      map[int]string
	templates  []proto.TemplateGuest
	// Tasks and replication (every pveTasksEvery), Ceph (slow path).
	tasks   []proto.PVETask
	repl    []proto.PVEReplication
	tasksAt time.Time
	ceph    *proto.CephHealth
}

const (
	pveQMPEvery   = 30 * time.Second
	pveTasksEvery = time.Minute
	// pveTaskWindow: failed tasks younger than this are reported.
	pveTaskWindow = 48 * time.Hour
	pveMaxTasks   = 50
)

func newPVECollector(cfg *agent.Config, c *collector) *pveCollector {
	return &pveCollector{
		cfg: cfg, c: c,
		lastBackup: map[int]*proto.BackupMark{},
		prev:       map[int]pveSample{},
		cfgCache:   map[int]*pveGuestCfg{},
		taskLogs:   map[string]*vzdumpLog{},
		qmp:        map[int]string{},
		snaps:      map[int]int{},
		oldestSnap: map[int]time.Time{},
		pools:      map[int]string{},
	}
}

func (p *pveCollector) tokenFile() string {
	if p.cfg.PVE.TokenFile != "" {
		return p.cfg.PVE.TokenFile
	}
	if p.cfg.Dir != "" {
		return filepath.Join(p.cfg.Dir, "pve-token")
	}
	return pveDefaultTokenFile
}

func (p *pveCollector) apiURL() string {
	if p.cfg.PVE.URL != "" {
		return strings.TrimRight(p.cfg.PVE.URL, "/")
	}
	return pveDefaultURL
}

// ---- HTTP / TLS ------------------------------------------------------------------

// pveTLSConfig verifies the PVE certificate against the cluster CA; for a
// loopback URL it also accepts the node's own certificate files (custom /
// ACME certificates usually lack 127.0.0.1) and, when those are unreadable,
// any certificate (the connection never leaves the host).
func pveTLSConfig(host string) *tls.Config {
	loopback := false
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() || host == "localhost" {
		loopback = true
	}
	pool, _ := x509.SystemCertPool()
	if pool == nil {
		pool = x509.NewCertPool()
	}
	if b, err := os.ReadFile("/etc/pve/pve-root-ca.pem"); err == nil {
		pool.AppendCertsFromPEM(b)
	}
	return &tls.Config{
		MinVersion:         tls.VersionTLS12,
		InsecureSkipVerify: true, // verified in VerifyConnection
		VerifyConnection: func(cs tls.ConnectionState) error {
			if len(cs.PeerCertificates) == 0 {
				return errors.New("pve: no server certificate")
			}
			leaf := cs.PeerCertificates[0]
			inter := x509.NewCertPool()
			for _, c := range cs.PeerCertificates[1:] {
				inter.AddCert(c)
			}
			_, verr := leaf.Verify(x509.VerifyOptions{Roots: pool, Intermediates: inter, DNSName: host})
			if verr == nil || !loopback {
				return verr
			}
			readable := false
			for _, f := range []string{"/etc/pve/local/pveproxy-ssl.pem", "/etc/pve/local/pve-ssl.pem"} {
				b, err := os.ReadFile(f)
				if err != nil {
					continue
				}
				readable = true
				if blk, _ := pem.Decode(b); blk != nil && bytes.Equal(blk.Bytes, leaf.Raw) {
					return nil
				}
			}
			if !readable {
				return nil
			}
			return verr
		},
	}
}

// errPVEAuth marks a 401 (token missing / revoked).
var errPVEAuth = errors.New("pve: authentication failed")

// pveStatusError is a non-200 answer of the API.
type pveStatusError struct {
	Code int
	Msg  string
}

func (e *pveStatusError) Error() string { return e.Msg }

// pveStatus returns the HTTP status of a failed API call (0 when it was
// not an HTTP error).
func pveStatus(err error) int {
	var se *pveStatusError
	if errors.As(err, &se) {
		return se.Code
	}
	return 0
}

func (p *pveCollector) get(ctx context.Context, path string, v any) error {
	p.apiMu.Lock()
	client, base, token := p.client, p.baseURL, p.token
	p.apiMu.Unlock()
	if client == nil {
		return errors.New("pve: not connected")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "PVEAPIToken="+token)
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("pve %s: %w", path, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return errPVEAuth
	}
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		msg := strings.TrimSpace(resp.Status)
		var e struct {
			Message string `json:"message"`
		}
		if json.Unmarshal(b, &e) == nil && e.Message != "" {
			msg += ": " + strings.TrimSpace(e.Message)
		}
		return fmt.Errorf("pve %s: %w", path, &pveStatusError{Code: resp.StatusCode, Msg: msg})
	}
	var env struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 32<<20)).Decode(&env); err != nil {
		return fmt.Errorf("pve %s: %w", path, err)
	}
	if v == nil {
		return nil
	}
	return json.Unmarshal(env.Data, v)
}

// ensureClient loads (or provisions) the token and builds the HTTP client.
func (p *pveCollector) ensureClient(ctx context.Context, node string) error {
	p.apiMu.Lock()
	defer p.apiMu.Unlock()
	if p.client != nil && p.token != "" {
		return nil
	}
	u, err := url.Parse(p.apiURL())
	if err != nil {
		return fmt.Errorf("pve url: %w", err)
	}
	tok, err := readPVEToken(p.tokenFile())
	if errors.Is(err, os.ErrNotExist) && isRoot() {
		if _, lerr := lookPath("pveum"); lerr == nil {
			tok, err = provisionPVEToken(ctx, p.tokenFile(), node)
			if err == nil {
				p.provisionedAt = time.Now()
			}
		}
	}
	if err != nil {
		return err
	}
	tr := &http.Transport{
		TLSClientConfig:     pveTLSConfig(u.Hostname()),
		MaxIdleConns:        4,
		MaxIdleConnsPerHost: 4,
		IdleConnTimeout:     90 * time.Second,
		DialContext:         (&net.Dialer{Timeout: 5 * time.Second}).DialContext,
	}
	p.client = &http.Client{Transport: tr, Timeout: 20 * time.Second}
	p.baseURL = strings.TrimRight(u.String(), "/")
	p.token = tok
	return nil
}

// authFailed handles a 401: the token file is re-read on the next run (an
// admin may have replaced it). When a token the agent provisioned itself
// keeps failing for a minute (revoked or deleted in PVE), it is removed so
// the next run provisions a new one. PVE answers a bad token after a 3 s
// delay, so this costs one slow request per run meanwhile.
func (p *pveCollector) authFailed(node string) {
	p.apiMu.Lock()
	defer p.apiMu.Unlock()
	now := time.Now()
	if p.authFailSince.IsZero() {
		p.authFailSince = now
	}
	ours := strings.HasPrefix(p.token, pveUser+"!"+pveTokenID(node)+"=")
	if ours && isRoot() && now.Sub(p.authFailSince) > time.Minute && now.Sub(p.provisionedAt) > time.Minute {
		_ = os.Remove(p.tokenFile())
		p.authFailSince = time.Time{}
	}
	p.client, p.token = nil, ""
}

func (p *pveCollector) authOK() {
	p.apiMu.Lock()
	p.authFailSince = time.Time{}
	p.apiMu.Unlock()
}

func readPVEToken(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	tok := strings.TrimSpace(string(b))
	if !strings.Contains(tok, "!") || !strings.Contains(tok, "=") {
		return "", fmt.Errorf("pve token file %s: expected USER@REALM!TOKENID=SECRET", path)
	}
	return tok, nil
}

var tokenIDSanitize = regexp.MustCompile(`[^A-Za-z0-9._-]`)

// pveTokenID is the token name the agent provisions. Users and tokens are
// cluster-wide, so each node's agent gets its own token ("agent-<node>");
// a shared name would make the agents revoke each other's token.
func pveTokenID(node string) string {
	n := tokenIDSanitize.ReplaceAllString(node, "-")
	if n == "" {
		return "agent"
	}
	return "agent-" + n
}

// provisionPVEToken creates whombat@pve (PVEAuditor on /) and a token
// without privilege separation, and stores it in path (0600). The secret is
// never logged.
func provisionPVEToken(ctx context.Context, path, node string) (string, error) {
	if node == "" {
		node, _ = os.Hostname()
		node, _, _ = strings.Cut(node, ".")
	}
	tid := pveTokenID(node)
	if _, err := runCmd(ctx, 30*time.Second, "pveum", "user", "add", pveUser, "--comment", "Whombat agent (read-only)"); err != nil && !strings.Contains(err.Error(), "already exists") {
		return "", fmt.Errorf("pve token provisioning: %w", err)
	}
	if _, err := runCmd(ctx, 30*time.Second, "pveum", "acl", "modify", "/", "--users", pveUser, "--roles", "PVEAuditor"); err != nil {
		return "", fmt.Errorf("pve token provisioning: %w", err)
	}
	_, _ = runCmd(ctx, 30*time.Second, "pveum", "user", "token", "remove", pveUser, tid)
	out, err := runCmd(ctx, 30*time.Second, "pveum", "user", "token", "add", pveUser, tid, "--privsep", "0",
		"--comment", "Whombat agent on "+node, "--output-format", "json")
	if err != nil {
		return "", fmt.Errorf("pve token provisioning: %w", err)
	}
	var res struct {
		FullID string `json:"full-tokenid"`
		Value  string `json:"value"`
	}
	if err := json.Unmarshal(out, &res); err != nil || res.Value == "" {
		return "", errors.New("pve token provisioning: unexpected pveum output")
	}
	if res.FullID == "" {
		res.FullID = pveUser + "!" + tid
	}
	tok := res.FullID + "=" + res.Value
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(tok+"\n"), 0o600); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, path); err != nil {
		return "", err
	}
	return tok, nil
}

// ---- API types ----------------------------------------------------------------------

type pveClusterStatus struct {
	Type    string `json:"type"`
	Name    string `json:"name"`
	Quorate int    `json:"quorate"`
	Nodes   int    `json:"nodes"`
	Local   int    `json:"local"`
	Online  int    `json:"online"`
	NodeID  int    `json:"nodeid"`
}

type pveResource struct {
	ID        string   `json:"id"`
	Type      string   `json:"type"` // node | qemu | lxc | storage | ...
	Node      string   `json:"node"`
	Name      string   `json:"name"`
	Status    string   `json:"status"`
	VMID      int      `json:"vmid"`
	Template  int      `json:"template"`
	CPU       float64  `json:"cpu"`
	MaxCPU    float64  `json:"maxcpu"`
	Mem       uint64   `json:"mem"`
	MaxMem    uint64   `json:"maxmem"`
	DiskRead  *uint64  `json:"diskread"`
	DiskWrite *uint64  `json:"diskwrite"`
	NetIn     *uint64  `json:"netin"`
	NetOut    *uint64  `json:"netout"`
	Uptime    int64    `json:"uptime"`
	HAState   string   `json:"hastate"`
	Lock      string   `json:"lock"`
	Tags      string   `json:"tags"`
	Pool      string   `json:"pool"`
	Disk      *float64 `json:"disk"`
	MaxDisk   uint64   `json:"maxdisk"`
}

type pveSample struct {
	at             time.Time
	started        time.Time // kept stable across reports (uptime has 10 s granularity)
	rd, wr, rx, tx uint64
	rdBps, wrBps   *float64
	rxBps, txBps   *float64
}

// pveGuestCfg is what the agent keeps from a guest's config.
type pveGuestCfg struct {
	at       time.Time
	kind     string
	vcpu     int
	memBytes uint64
	balloon  bool
	osType   string
	firmware string
	machine  string
	tpm      bool
	agent    bool
	osRaw    string            // PVE ostype
	conf     map[string]string // raw config (for the broker's console rules)
	pending  int               // changes that wait for a restart
	disks    map[string]uint64 // storage id -> configured disk bytes
	uptime   int64             // the guest's uptime when the config was read (0: stopped)
	osInfo   string            // "debian 13" from the guest agent / container os-release
	osNext   time.Time         // when to read the OS info (and the agent state) again
	osPID    int
	// agentState: the QEMU guest agent of a running VM: running |
	// not_running | "" (unknown).
	agentState string
	res        pveResKey // the resource's values when the config was read
	macs       []string  // network card addresses (netN), lower case
}

// pveResKey are the cluster resource values that change with a guest's
// configuration or lock.
type pveResKey struct {
	lock, name      string
	maxCPU          float64
	maxMem, maxDisk uint64
}

// diskBytes is the configured size of all the guest's disks.
func (g *pveGuestCfg) diskBytes() uint64 {
	var n uint64
	for _, b := range g.disks {
		n += b
	}
	return n
}

// flexString decodes JSON strings and numbers into a string (PVE returns
// "1024" or 1024 for the same key depending on version).
type flexString string

func (f *flexString) UnmarshalJSON(b []byte) error {
	if len(b) > 0 && b[0] == '"' {
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return err
		}
		*f = flexString(s)
		return nil
	}
	*f = flexString(strings.TrimSpace(string(b)))
	return nil
}

// pvePendingItem is an entry of GET .../pending: a key's current value,
// the value it gets at the next restart, and whether it is removed then.
type pvePendingItem struct {
	Key     string      `json:"key"`
	Value   *flexString `json:"value"`
	Pending *flexString `json:"pending"`
	Delete  flexString  `json:"delete"`
}

// pvePendingConfig splits a /pending answer into the configuration in
// effect (current values; keys that only exist as pending changes are
// left out) and the number of changes that wait for a restart.
func pvePendingConfig(items []pvePendingItem) (map[string]flexString, int) {
	raw := make(map[string]flexString, len(items))
	pending := 0
	for _, it := range items {
		if it.Value != nil {
			raw[it.Key] = *it.Value
		}
		if it.Pending != nil || (it.Delete != "" && it.Delete != "0") {
			pending++
		}
	}
	return raw, pending
}

func parsePVEGuestConfig(kind string, raw map[string]flexString, maxCPU float64) *pveGuestCfg {
	g := &pveGuestCfg{kind: kind, conf: make(map[string]string, len(raw))}
	for k, v := range raw {
		g.conf[k] = string(v)
	}
	g.disks = pveDiskSizes(g.conf)
	g.macs = pveMACs(g.conf)
	num := func(k string) int {
		v := string(raw[k])
		// "memory: current=2048" (PVE 8+ property string)
		if strings.Contains(v, "=") {
			for _, kv := range strings.Split(v, ",") {
				if a, b, ok := strings.Cut(kv, "="); ok && a == "current" {
					v = b
				}
			}
		}
		n, _ := strconv.Atoi(strings.TrimSpace(v))
		return n
	}
	g.osRaw = string(raw["ostype"])
	if kind == "vm" {
		cores, sockets := num("cores"), num("sockets")
		if cores == 0 {
			cores = 1
		}
		if sockets == 0 {
			sockets = 1
		}
		g.vcpu = cores * sockets
		if v := num("vcpus"); v > 0 {
			g.vcpu = v
		}
		mem := num("memory")
		if mem == 0 {
			mem = 512
		}
		g.memBytes = uint64(mem) << 20
		if b, ok := raw["balloon"]; ok {
			bv, _ := strconv.Atoi(string(b))
			g.balloon = bv > 0 && bv < mem
		}
		g.firmware = "SeaBIOS"
		if raw["bios"] == "ovmf" {
			g.firmware = "OVMF"
		}
		g.machine = machineShort(string(raw["machine"]))
		if g.machine == "" {
			g.machine = "i440fx"
		}
		_, g.tpm = raw["tpmstate0"]
		// agent: "[enabled=]<1|0>[,fstrim_cloned_disks=<1|0>][,type=...]"
		for i, kv := range strings.Split(string(raw["agent"]), ",") {
			k, v, ok := strings.Cut(kv, "=")
			if !ok && i == 0 {
				k, v = "enabled", kv
			}
			if k == "enabled" {
				g.agent = v == "1"
			}
		}
		switch {
		case strings.HasPrefix(g.osRaw, "w"):
			g.osType = "windows"
		case strings.HasPrefix(g.osRaw, "l"):
			g.osType = "linux"
		case g.osRaw == "solaris":
			g.osType = "solaris"
		}
	} else {
		g.vcpu = num("cores")
		if g.vcpu == 0 {
			g.vcpu = int(maxCPU)
		}
		mem := num("memory")
		if mem == 0 {
			mem = 512
		}
		g.memBytes = uint64(mem) << 20
		g.osType = "linux"
	}
	return g
}

// pveDiskKey matches the config keys of disks and mount points.
var pveDiskKey = regexp.MustCompile(`^(ide|sata|scsi|virtio|efidisk|tpmstate|mp)\d+$|^rootfs$`)

// pveDiskSizes sums the configured sizes of a guest's disks per storage
// ("local-zfs:vm-100-disk-0,iothread=1,size=32G"). CD-ROMs, bind mounts
// and unused disks (they carry no size) are left out.
func pveDiskSizes(conf map[string]string) map[string]uint64 {
	out := map[string]uint64{}
	for k, v := range conf {
		if !pveDiskKey.MatchString(k) {
			continue
		}
		var vol string
		var size uint64
		cdrom := false
		for i, item := range strings.Split(v, ",") {
			a, b, ok := strings.Cut(item, "=")
			switch {
			case !ok && i == 0:
				vol = item
			case a == "file" || a == "volume":
				vol = b
			case a == "size":
				size = pveSize(b)
			case a == "media":
				cdrom = b == "cdrom"
			}
		}
		storage, _, ok := strings.Cut(vol, ":")
		if !ok || storage == "" || strings.HasPrefix(vol, "/") || cdrom || size == 0 {
			continue
		}
		out[storage] += size
	}
	return out
}

var pveSizeRE = regexp.MustCompile(`^(\d+(?:\.\d+)?)([KMGT]?)$`)

// pveSize parses a PVE disk size ("32G", "4M", "709474K"; binary units,
// bytes without a unit).
func pveSize(s string) uint64 {
	m := pveSizeRE.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return 0
	}
	f, err := strconv.ParseFloat(m[1], 64)
	if err != nil {
		return 0
	}
	shift := map[string]uint{"": 0, "K": 10, "M": 20, "G": 30, "T": 40}[m[2]]
	return uint64(f * float64(uint64(1)<<shift))
}

// pveSplitList splits a PVE list ("prod;web", "100,101 102") like
// PVE::Tools::split_list, dropping empty and repeated items.
func pveSplitList(s string) []string {
	var out []string
	for _, f := range strings.FieldsFunc(s, func(r rune) bool { return r == ';' || r == ',' || r == ' ' || r == '\t' || r == '\n' }) {
		if !containsStr(out, f) {
			out = append(out, f)
		}
	}
	return out
}

var pveWinNames = map[string]string{
	"win11": "Windows 11", "win10": "Windows 10", "win8": "Windows 8", "win7": "Windows 7",
	"wvista": "Windows Vista", "wxp": "Windows XP", "w2k": "Windows 2000", "w2k3": "Windows Server 2003",
	"w2k8": "Windows Server 2008", "l26": "Linux", "l24": "Linux 2.4", "solaris": "Solaris",
}

// image builds "Windows 11 · OVMF · TPM", "debian 13", "ubuntu 24.04".
func (g *pveGuestCfg) image() string {
	var base string
	switch {
	case g.osInfo != "" && g.osType != "windows":
		base = g.osInfo
	case g.kind == "container":
		base = g.osRaw
	default:
		base = pveWinNames[g.osRaw]
	}
	parts := []string{}
	if base != "" {
		parts = append(parts, base)
	}
	if g.kind == "vm" {
		if g.firmware == "OVMF" {
			parts = append(parts, "OVMF")
		}
		if g.tpm {
			parts = append(parts, "TPM")
		}
	}
	return strings.Join(parts, " · ")
}

// ---- fast path ------------------------------------------------------------------------

func (p *pveCollector) isEnabled() bool {
	return agent.Enabled(p.c.toggles().PVE, isProxmoxHost(p.c.host.root))
}

// isProxmoxHost detects a Proxmox VE node (os-release says Debian).
func isProxmoxHost(r fsRoot) bool {
	return r.exists("/usr/bin/pveversion") || r.exists("/etc/pve/.version")
}

func (p *pveCollector) fail(err error) error {
	p.mu.Lock()
	p.err = err.Error()
	p.mu.Unlock()
	return err
}

func (p *pveCollector) run(ctx context.Context) error {
	enabled := p.isEnabled()
	p.c.pveSub.setAbsent(!enabled)
	p.c.pveSlowSub.setAbsent(!enabled)
	p.mu.Lock()
	p.enabled = enabled
	node := p.node
	p.mu.Unlock()
	if !enabled {
		return nil
	}
	if node == "" {
		h, _ := os.Hostname()
		node, _, _ = strings.Cut(h, ".")
	}
	if err := p.ensureClient(ctx, node); err != nil {
		return p.fail(err)
	}
	err := p.collectFast(ctx)
	if errors.Is(err, errPVEAuth) {
		p.authFailed(node)
		return p.fail(fmt.Errorf("pve API token %s rejected (401)", p.tokenFile()))
	}
	if err != nil {
		return p.fail(err)
	}
	p.authOK()
	p.mu.Lock()
	p.err = ""
	p.lastGood = time.Now()
	p.mu.Unlock()
	// Storages and backups wait for a working API; after an outage, refresh
	// them now instead of at their next 5-minute run.
	if s := p.c.pveSlowSub; s != nil {
		s.mu.Lock()
		failed := s.hasRun && s.lastErr != nil
		s.mu.Unlock()
		if failed {
			s.markDirty()
		}
	}
	return nil
}

func (p *pveCollector) collectFast(ctx context.Context) error {
	now := time.Now()
	p.mu.Lock()
	needStatus := p.clusterAt.IsZero() || now.Sub(p.clusterAt) > time.Minute
	needVersion := p.version == "" || now.Sub(p.versionAt) > 10*time.Minute
	p.mu.Unlock()

	if needVersion {
		var v struct {
			Version string `json:"version"`
		}
		if err := p.get(ctx, "/version", &v); err != nil {
			return err
		}
		p.mu.Lock()
		p.version, p.versionAt = v.Version, now
		p.mu.Unlock()
	}
	if needStatus {
		if err := p.collectClusterStatus(ctx); err != nil {
			return err
		}
	}
	var res []pveResource
	if err := p.get(ctx, "/cluster/resources", &res); err != nil {
		return err
	}
	p.mu.Lock()
	node := p.node
	needQMP := now.Sub(p.qmpAt) >= pveQMPEvery
	needTasks := now.Sub(p.tasksAt) >= pveTasksEvery
	p.mu.Unlock()
	if needQMP {
		p.refreshQMP(ctx, node, now)
	}
	if needTasks {
		p.refreshTasks(ctx, node, now)
	}

	// Nodes and per-node guest counts.
	type counts struct{ vms, cts int }
	per := map[string]*counts{}
	for _, r := range res {
		if (r.Type == "qemu" || r.Type == "lxc") && r.Template == 0 {
			c := per[r.Node]
			if c == nil {
				c = &counts{}
				per[r.Node] = c
			}
			if r.Type == "qemu" {
				c.vms++
			} else {
				c.cts++
			}
		}
	}
	var nodes []proto.PVENode
	for _, r := range res {
		if r.Type != "node" {
			continue
		}
		n := proto.PVENode{Name: r.Node, ThisNode: r.Node == node, Online: r.Status == "online"}
		if n.Online {
			n.CPUPct = round1(r.CPU * 100)
			if r.MaxMem > 0 {
				n.MemPct = round1(float64(r.Mem) / float64(r.MaxMem) * 100)
			}
		}
		if c := per[r.Node]; c != nil {
			n.VMs, n.Containers = c.vms, c.cts
		}
		nodes = append(nodes, n)
	}
	sort.Slice(nodes, func(i, j int) bool { return nodes[i].Name < nodes[j].Name })

	// This node's guests.
	var mine []pveResource
	for _, r := range res {
		if (r.Type == "qemu" || r.Type == "lxc") && r.Node == node && r.Template == 0 {
			mine = append(mine, r)
		}
	}
	sort.Slice(mine, func(i, j int) bool { return mine[i].VMID < mine[j].VMID })
	guests := make([]proto.Guest, 0, len(mine))
	seen := map[int]bool{}
	pools := map[int]string{}
	for _, r := range mine {
		seen[r.VMID] = true
		if r.Pool != "" {
			pools[r.VMID] = r.Pool
		}
		kind := "vm"
		if r.Type == "lxc" {
			kind = "container"
		}
		running := r.Status == "running"
		gc := p.guestConfig(ctx, node, r, kind, now)
		g := proto.Guest{
			ID:      strconv.Itoa(r.VMID),
			Name:    r.Name,
			Kind:    kind,
			State:   proto.StateStopped,
			VMID:    r.VMID,
			Node:    node,
			Lock:    r.Lock,
			Tags:    pveSplitList(r.Tags),
			HAState: r.HAState,
		}
		p.mu.Lock()
		qmp := p.qmp[r.VMID]
		if n, ok := p.snaps[r.VMID]; ok {
			g.SnapshotsCount = ptr(n)
		}
		if t, ok := p.oldestSnap[r.VMID]; ok {
			g.OldestSnapshot = ptr(t)
		}
		if p.backupJobs != nil {
			g.BackupJob = ptr(backupCovered(p.backupJobs, node, r.VMID, r.Pool))
		}
		p.mu.Unlock()
		if running {
			g.State = proto.StateRunning
			// A paused (or suspended-to-RAM) VM is "running" to the
			// cluster resource list; QMP knows better.
			if kind == "vm" && (qmp == "paused" || qmp == "suspended") {
				g.State = proto.StatePaused
			}
		}
		if kind == "container" && r.Disk != nil && *r.Disk > 0 {
			g.DiskUsedBytes = ptr(uint64(*r.Disk))
		}
		if gc != nil {
			g.Image = gc.image()
			g.VCPU = gc.vcpu
			g.MemConfigBytes = gc.memBytes
			g.BalloonActive = gc.balloon
			g.OSType = gc.osType
			g.PendingChanges = gc.pending
			g.MACs = gc.macs
			if kind == "vm" {
				g.Firmware = gc.firmware
				g.MachineType = gc.machine
				if running && gc.agent {
					g.GuestAgent = gc.agentState
				}
			}
		} else {
			g.VCPU = int(r.MaxCPU)
			g.MemConfigBytes = r.MaxMem
		}
		var conf map[string]string
		if gc != nil {
			conf = gc.conf
		}
		g.Console = broker.Caps(proto.PlatformPVE, broker.PVEDisplay(kind, conf, running))
		if running {
			g.CPUPct = ptr(round1(clamp(r.CPU*100, 0, 100)))
			if r.Mem > 0 {
				g.MemUsedBytes = ptr(r.Mem)
			}
			if r.MaxMem > 0 {
				g.MemLimitBytes = ptr(r.MaxMem)
			}
			cur := pveSample{at: now}
			if r.Uptime > 0 {
				cur.started = now.Add(-time.Duration(r.Uptime) * time.Second).UTC().Truncate(time.Second)
			}
			if r.DiskRead != nil {
				cur.rd = *r.DiskRead
			}
			if r.DiskWrite != nil {
				cur.wr = *r.DiskWrite
			}
			if r.NetIn != nil {
				cur.rx = *r.NetIn
			}
			if r.NetOut != nil {
				cur.tx = *r.NetOut
			}
			p.mu.Lock()
			prev, ok := p.prev[r.VMID]
			// pvestatd refreshes the counters every 10 s, like our cadence;
			// unchanged counters shortly after the previous sample mean
			// "not refreshed yet", not "idle": keep the previous rates.
			unchanged := ok && cur.rd == prev.rd && cur.wr == prev.wr && cur.rx == prev.rx && cur.tx == prev.tx
			if unchanged && now.Sub(prev.at) < 15*time.Second {
				started := cur.started
				cur = prev
				cur.started = started
			} else if ok {
				dt := now.Sub(prev.at).Seconds()
				if dt >= 1 {
					if r.DiskRead != nil {
						cur.rdBps = rate(cur.rd, prev.rd, dt)
					}
					if r.DiskWrite != nil {
						cur.wrBps = rate(cur.wr, prev.wr, dt)
					}
					if r.NetIn != nil {
						cur.rxBps = rate(cur.rx, prev.rx, dt)
					}
					if r.NetOut != nil {
						cur.txBps = rate(cur.tx, prev.tx, dt)
					}
				} else {
					cur = prev
				}
			}
			if ok && !prev.started.IsZero() && !cur.started.IsZero() {
				if d := cur.started.Sub(prev.started); d > -30*time.Second && d < 30*time.Second {
					cur.started = prev.started
				}
			}
			p.prev[r.VMID] = cur
			p.mu.Unlock()
			if !cur.started.IsZero() {
				t := cur.started
				g.StartedAt = &t
			}
			g.DiskReadBps, g.DiskWriteBps = copyPtr(cur.rdBps), copyPtr(cur.wrBps)
			g.NetRxBps, g.NetTxBps = copyPtr(cur.rxBps), copyPtr(cur.txBps)
		} else {
			p.mu.Lock()
			delete(p.prev, r.VMID)
			p.mu.Unlock()
		}
		guests = append(guests, g)
	}

	// This node's templates: clone sources, not guests. Their configs are
	// cached like the guests' (disk sizes for the storages' provisioned
	// space).
	var templates []proto.TemplateGuest
	for _, r := range res {
		if (r.Type != "qemu" && r.Type != "lxc") || r.Node != node || r.Template == 0 {
			continue
		}
		seen[r.VMID] = true
		kind := "vm"
		if r.Type == "lxc" {
			kind = "container"
		}
		t := proto.TemplateGuest{ID: strconv.Itoa(r.VMID), Name: r.Name, Kind: kind, Node: node, DiskBytes: r.MaxDisk}
		if gc := p.guestConfig(ctx, node, r, kind, now); gc != nil && gc.diskBytes() > 0 {
			t.DiskBytes = gc.diskBytes()
		}
		templates = append(templates, t)
	}
	sort.Slice(templates, func(i, j int) bool {
		a, _ := strconv.Atoi(templates[i].ID)
		b, _ := strconv.Atoi(templates[j].ID)
		return a < b
	})

	p.mu.Lock()
	for id := range p.prev {
		if !seen[id] {
			delete(p.prev, id)
		}
	}
	for id := range p.cfgCache {
		if !seen[id] {
			delete(p.cfgCache, id)
		}
	}
	for i := range guests {
		if m := p.lastBackup[guests[i].VMID]; m != nil {
			mm := *m
			guests[i].LastBackup = &mm
		}
	}
	p.nodes = nodes
	p.guests = guests
	p.templates = templates
	p.pools = pools
	p.mu.Unlock()
	return nil
}

// refreshQMP reads the QMP run state of this node's VMs in one call
// (/nodes/{node}/qemu?full=1 asks QEMU for its status, like pvestatd).
func (p *pveCollector) refreshQMP(ctx context.Context, node string, now time.Time) {
	var vms []struct {
		VMID      flexString `json:"vmid"`
		QMPStatus string     `json:"qmpstatus"`
	}
	if err := p.get(ctx, "/nodes/"+url.PathEscape(node)+"/qemu?full=1", &vms); err != nil {
		return
	}
	m := map[int]string{}
	for _, v := range vms {
		if id, err := strconv.Atoi(string(v.VMID)); err == nil {
			m[id] = v.QMPStatus
		}
	}
	p.mu.Lock()
	p.qmp, p.qmpAt = m, now
	p.mu.Unlock()
}

// refreshTasks reads the cluster task list and this node's replication
// jobs. Errors keep the previous values (both are informational).
func (p *pveCollector) refreshTasks(ctx context.Context, node string, now time.Time) {
	var raw []pveClusterTask
	terr := p.get(ctx, "/cluster/tasks", &raw)
	var repl []pveReplicationJob
	rerr := p.get(ctx, "/nodes/"+url.PathEscape(node)+"/replication", &repl)
	p.mu.Lock()
	defer p.mu.Unlock()
	if terr == nil {
		p.tasks = pveTasks(raw, now)
	}
	if rerr == nil {
		p.repl = pveReplication(repl)
	}
	p.tasksAt = now
}

// pveClusterTask is an entry of /cluster/tasks.
type pveClusterTask struct {
	UPID      string `json:"upid"`
	Node      string `json:"node"`
	Type      string `json:"type"`
	ID        string `json:"id"`
	User      string `json:"user"`
	StartTime int64  `json:"starttime"`
	EndTime   int64  `json:"endtime"`
	Status    string `json:"status"`
}

// pveTasks keeps running tasks and tasks that failed within
// pveTaskWindow (warnings are not failures), newest first, at most
// pveMaxTasks.
func pveTasks(raw []pveClusterTask, now time.Time) []proto.PVETask {
	var out []proto.PVETask
	for _, t := range raw {
		running := t.EndTime == 0 || t.Status == "" || t.Status == "running"
		start := time.Unix(t.StartTime, 0).UTC()
		if !running {
			res, _ := taskResult(t.Status)
			if res != "error" || now.Sub(time.Unix(t.EndTime, 0)) > pveTaskWindow {
				continue
			}
		}
		pt := proto.PVETask{UPID: t.UPID, Type: t.Type, ID: t.ID, Node: t.Node, User: t.User, Start: start, Status: t.Status}
		if running {
			pt.Status = "running"
		} else {
			end := time.Unix(t.EndTime, 0).UTC()
			pt.End = &end
		}
		pt.OK = pt.Status == "OK"
		out = append(out, pt)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Start.After(out[j].Start) })
	if len(out) > pveMaxTasks {
		out = out[:pveMaxTasks]
	}
	return out
}

// pveReplicationJob is an entry of /nodes/{node}/replication.
type pveReplicationJob struct {
	ID        string     `json:"id"`
	Guest     flexString `json:"guest"`
	Target    string     `json:"target"`
	LastSync  int64      `json:"last_sync"`
	FailCount int        `json:"fail_count"`
	Error     string     `json:"error"`
}

func pveReplication(jobs []pveReplicationJob) []proto.PVEReplication {
	var out []proto.PVEReplication
	for _, j := range jobs {
		r := proto.PVEReplication{ID: j.ID, Guest: string(j.Guest), Target: j.Target, Error: truncate(strings.TrimSpace(j.Error), 300), FailCount: j.FailCount}
		if j.LastSync > 0 {
			r.LastSync = time.Unix(j.LastSync, 0).UTC()
		}
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// pveCephStatus is the part of /cluster/ceph/status the agent uses.
type pveCephStatus struct {
	Health struct {
		Status string `json:"status"`
		Checks map[string]struct {
			Severity string `json:"severity"`
			Summary  struct {
				Message string `json:"message"`
			} `json:"summary"`
		} `json:"checks"`
	} `json:"health"`
}

// cephHealth summarizes Ceph health: errors first, then warnings, by
// check name; at most 16 summaries.
func cephHealth(st pveCephStatus) *proto.CephHealth {
	if st.Health.Status == "" {
		return nil
	}
	h := &proto.CephHealth{Status: st.Health.Status}
	names := make([]string, 0, len(st.Health.Checks))
	for n := range st.Health.Checks {
		names = append(names, n)
	}
	rank := func(sev string) int {
		if sev == "HEALTH_ERR" {
			return 0
		}
		return 1
	}
	sort.Slice(names, func(i, j int) bool {
		ri, rj := rank(st.Health.Checks[names[i]].Severity), rank(st.Health.Checks[names[j]].Severity)
		if ri != rj {
			return ri < rj
		}
		return names[i] < names[j]
	})
	for _, n := range names {
		if len(h.Summary) >= 16 {
			break
		}
		msg := st.Health.Checks[n].Summary.Message
		if msg == "" {
			msg = n
		}
		h.Summary = append(h.Summary, msg)
	}
	return h
}

func (p *pveCollector) collectClusterStatus(ctx context.Context) error {
	var st []pveClusterStatus
	if err := p.get(ctx, "/cluster/status", &st); err != nil {
		return err
	}
	var cl *proto.PVECluster
	node := ""
	online := map[string]bool{}
	for _, s := range st {
		switch s.Type {
		case "cluster":
			cl = &proto.PVECluster{Name: s.Name, Quorate: s.Quorate == 1}
		case "node":
			if s.Local == 1 {
				node = s.Name
			}
			online[s.Name] = s.Online == 1
		}
	}
	if cl != nil {
		// Votes: configured quorum votes per node (default 1).
		var cfgNodes []struct {
			Name  string     `json:"name"`
			Votes flexString `json:"quorum_votes"`
		}
		if err := p.get(ctx, "/cluster/config/nodes", &cfgNodes); err == nil && len(cfgNodes) > 0 {
			for _, n := range cfgNodes {
				v, err := strconv.Atoi(string(n.Votes))
				if err != nil || v == 0 {
					v = 1
				}
				cl.VotesExpected += v
				if online[n.Name] {
					cl.VotesHave += v
				}
			}
		} else {
			for _, on := range online {
				cl.VotesExpected++
				if on {
					cl.VotesHave++
				}
			}
		}
	}
	// HA resources: started vs total.
	var ha []struct {
		Type  string `json:"type"`
		State string `json:"state"`
	}
	haStarted, haTotal := 0, 0
	if err := p.get(ctx, "/cluster/ha/status/current", &ha); err == nil {
		for _, h := range ha {
			if h.Type == "service" {
				haTotal++
				if h.State == "started" {
					haStarted++
				}
			}
		}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if node != "" {
		p.node = node
	} else if p.node == "" {
		h, _ := os.Hostname()
		p.node, _, _ = strings.Cut(h, ".")
	}
	p.cluster = cl
	p.clusterAt = time.Now()
	p.haStarted, p.haTotal = haStarted, haTotal
	return nil
}

// Guest agent checks: get-osinfo runs every pveOSInfoEvery while the agent
// answers. An agent that does not answer is asked again after
// pveAgentRetry, or after pveAgentBootRetry while the VM is younger than
// pveAgentBootGrace (the agent starts some time after the VM).
const (
	pveOSInfoEvery    = 30 * time.Minute
	pveAgentRetry     = 5 * time.Minute
	pveAgentBootRetry = time.Minute
	pveAgentBootGrace = 3 * time.Minute
)

// pveNICModels are the VM network card models: "virtio=BC:24:11:…" names
// the card's address.
var pveNICModels = map[string]bool{"virtio": true, "e1000": true, "e1000e": true, "rtl8139": true, "vmxnet3": true,
	"ne2k_pci": true, "ne2k_isa": true, "pcnet": true, "i82551": true, "i82557b": true, "i82559er": true,
	"e1000-82540em": true, "e1000-82544gc": true, "e1000-82545em": true}

// pveMACs are the addresses of a guest's network cards: VM netN
// "virtio=BC:24:11:…" or macaddr=, container netN hwaddr=.
func pveMACs(conf map[string]string) []string {
	seen := map[string]bool{}
	for k, v := range conf {
		if !strings.HasPrefix(k, "net") {
			continue
		}
		if _, err := strconv.Atoi(k[3:]); err != nil {
			continue
		}
		for _, item := range strings.Split(v, ",") {
			ik, iv, ok := strings.Cut(item, "=")
			if !ok || !(pveNICModels[ik] || ik == "macaddr" || ik == "hwaddr") {
				continue
			}
			if m := strings.ToLower(strings.TrimSpace(iv)); validMAC(m) {
				seen[m] = true
			}
		}
	}
	return sortedKeys(seen)
}

// guestConfig returns the cached config of a guest, refreshing it every 5
// minutes and after the guest (re)started (pending changes apply then),
// and the OS info every 30 minutes. The config comes from /pending: the
// current values plus the changes that wait for a restart.
func (p *pveCollector) guestConfig(ctx context.Context, node string, r pveResource, kind string, now time.Time) *pveGuestCfg {
	p.mu.Lock()
	gc := p.cfgCache[r.VMID]
	p.mu.Unlock()
	running := r.Status == "running"
	// Started since the config was read: stopped then, or a lower uptime.
	restarted := gc != nil && running && (gc.uptime == 0 || r.Uptime < gc.uptime)
	// The cluster resource list shows a change at once (a lock taken or
	// released by a create, restore or backup; cores, memory or a disk
	// changed in the editor or in Proxmox): read the config again then too.
	key := pveResKey{lock: r.Lock, name: r.Name, maxCPU: r.MaxCPU, maxMem: r.MaxMem, maxDisk: r.MaxDisk}
	changed := gc != nil && gc.res != key
	if gc == nil || now.Sub(gc.at) > 5*time.Minute || gc.kind != kind || restarted || changed {
		typ := "qemu"
		if kind == "container" {
			typ = "lxc"
		}
		var items []pvePendingItem
		if err := p.get(ctx, fmt.Sprintf("/nodes/%s/%s/%d/pending", url.PathEscape(node), typ, r.VMID), &items); err == nil {
			raw, pending := pvePendingConfig(items)
			ngc := parsePVEGuestConfig(kind, raw, r.MaxCPU)
			ngc.pending = pending
			ngc.res = key
			if running {
				ngc.uptime = max(r.Uptime, 1)
			}
			if gc != nil {
				ngc.osInfo, ngc.osNext, ngc.osPID, ngc.agentState = gc.osInfo, gc.osNext, gc.osPID, gc.agentState
				if restarted {
					ngc.osNext = time.Time{}
				}
			}
			ngc.at = now
			gc = ngc
		} else if gc == nil {
			return nil
		}
	}
	if !running {
		// Ask again as soon as the guest runs.
		gc.osNext, gc.agentState = time.Time{}, ""
	}
	// OS release: guest agent (VMs) or the container's os-release.
	if running && !now.Before(gc.osNext) {
		gc.osNext = now.Add(pveOSInfoEvery)
		if kind == "vm" && gc.agent {
			var res struct {
				Result struct {
					ID        string `json:"id"`
					VersionID string `json:"version-id"`
				} `json:"result"`
			}
			err := p.get(ctx, fmt.Sprintf("/nodes/%s/qemu/%d/agent/get-osinfo", url.PathEscape(node), r.VMID), &res)
			switch {
			case err == nil:
				gc.agentState = "running"
				if res.Result.ID != "" {
					gc.osInfo = strings.TrimSpace(res.Result.ID + " " + res.Result.VersionID)
				}
			case pveAgentNotRunning(err) && time.Duration(r.Uptime)*time.Second >= pveAgentBootGrace:
				gc.agentState = "not_running"
				gc.osNext = now.Add(pveAgentRetry)
			case pveAgentNotRunning(err):
				gc.agentState = ""
				gc.osNext = now.Add(pveAgentBootRetry)
			default:
				// No permission (403), the VM just stopped, a timeout: unknown.
				gc.agentState = ""
			}
		}
		if kind == "container" {
			var st struct {
				PID int `json:"pid"`
			}
			if err := p.get(ctx, fmt.Sprintf("/nodes/%s/lxc/%d/status/current", url.PathEscape(node), r.VMID), &st); err == nil && st.PID > 0 {
				if id, ver := containerOSRelease(st.PID); id != "" {
					gc.osInfo = strings.TrimSpace(id + " " + ver)
					gc.osPID = st.PID
				}
			}
		}
	}
	p.mu.Lock()
	p.cfgCache[r.VMID] = gc
	p.mu.Unlock()
	return gc
}

// pveAgentNotRunning reports PVE's answer for a VM whose QEMU guest agent
// does not respond (HTTP 500 "QEMU guest agent is not running"), as
// opposed to "VM 100 is not running" or a missing permission.
func pveAgentNotRunning(err error) bool {
	var se *pveStatusError
	return errors.As(err, &se) && se.Code == http.StatusInternalServerError &&
		strings.Contains(strings.ToLower(se.Msg), "agent is not running")
}

// containerOSRelease reads ID and VERSION_ID of /etc/os-release inside a
// running container. Paths are resolved inside the container's root
// (/proc/<pid>/root as the root, openInRoot): /etc/os-release is usually
// a symlink, and an absolute or ".." symlink must not lead to a file of
// the host. Only small regular files are read, without blocking.
func containerOSRelease(pid int) (id, version string) {
	root := fmt.Sprintf("/proc/%d/root", pid)
	for _, rel := range []string{"etc/os-release", "usr/lib/os-release"} {
		f, err := openInRoot(root, rel)
		if err != nil {
			continue
		}
		st, err := f.Stat()
		if err != nil || !st.Mode().IsRegular() || st.Size() > 64<<10 {
			f.Close()
			continue
		}
		b, _ := io.ReadAll(io.LimitReader(f, 64<<10))
		f.Close()
		kv := map[string]string{}
		scanLines(b, func(line string) {
			k, v, ok := strings.Cut(line, "=")
			if ok {
				kv[k] = strings.Trim(strings.TrimSpace(v), `"'`)
			}
		})
		return strings.ToLower(kv["ID"]), kv["VERSION_ID"]
	}
	return "", ""
}

// ---- slow path: storages and backups ----------------------------------------------

type pveStorageEntry struct {
	Storage string  `json:"storage"`
	Type    string  `json:"type"`
	Content string  `json:"content"`
	Active  int     `json:"active"`
	Enabled *int    `json:"enabled"`
	Shared  int     `json:"shared"`
	Used    float64 `json:"used"`
	Total   float64 `json:"total"`
}

type pveStorageCfg struct {
	Storage   string     `json:"storage"`
	Type      string     `json:"type"`
	Path      string     `json:"path"`
	Pool      string     `json:"pool"`
	Server    string     `json:"server"`
	Export    string     `json:"export"`
	Datastore string     `json:"datastore"`
	VGName    string     `json:"vgname"`
	ThinPool  string     `json:"thinpool"`
	Share     string     `json:"share"`
	Monhost   string     `json:"monhost"`
	Sparse    flexString `json:"sparse"`
}

// thin reports whether volumes on the storage take space only as they are
// written: LVM-thin, Ceph RBD, ZFS with "sparse", and image files (raw
// files are sparse, qcow2 grows) on file storages.
func (c pveStorageCfg) thin(typ string) bool {
	switch typ {
	case "lvmthin", "rbd", "dir", "nfs", "cifs", "cephfs", "glusterfs", "btrfs":
		return true
	case "zfspool", "zfs":
		return c.Sparse == "1" || c.Sparse == "true"
	}
	return false
}

func (c pveStorageCfg) detail() string {
	switch {
	case c.Pool != "":
		return c.Pool
	case c.Datastore != "" && c.Server != "":
		return c.Server + ":" + c.Datastore
	case c.Server != "" && c.Export != "":
		return c.Server + ":" + c.Export
	case c.Server != "" && c.Share != "":
		return "//" + c.Server + "/" + c.Share
	case c.VGName != "" && c.ThinPool != "":
		return c.VGName + "/" + c.ThinPool
	case c.VGName != "":
		return c.VGName
	case c.Path != "":
		return c.Path
	case c.Server != "":
		return c.Server
	}
	return ""
}

type pveBackupJob struct {
	ID       string      `json:"id"`
	Enabled  *flexString `json:"enabled"`
	Schedule string      `json:"schedule"`
	Mode     string      `json:"mode"`
	Storage  string      `json:"storage"`
	Node     string      `json:"node"`
	All      flexString  `json:"all"`
	VMID     flexString  `json:"vmid"`
	Exclude  flexString  `json:"exclude"`
	Pool     string      `json:"pool"`
	NextRun  int64       `json:"next-run"`
	Type     string      `json:"type"`
}

func (j pveBackupJob) enabled() bool {
	return j.Enabled == nil || (*j.Enabled != "0" && *j.Enabled != "false")
}

// covers reports whether the job backs up the guest when it runs on node:
// every guest but the excluded ones (all), the guests of a pool, or a
// list of vmids, like PVE::VZDump::get_included_guests.
func (j pveBackupJob) covers(node string, vmid int, pool string) bool {
	if (j.Type != "" && j.Type != "vzdump") || !j.enabled() || (j.Node != "" && j.Node != node) {
		return false
	}
	id := strconv.Itoa(vmid)
	if containsStr(pveSplitList(string(j.Exclude)), id) {
		return false
	}
	switch {
	case j.All == "1" || j.All == "true":
		return true
	case j.Pool != "":
		return pool == j.Pool
	}
	return containsStr(pveSplitList(string(j.VMID)), id)
}

// backupCovered reports whether an enabled backup job covers the guest.
func backupCovered(jobs []pveBackupJob, node string, vmid int, pool string) bool {
	for _, j := range jobs {
		if j.covers(node, vmid, pool) {
			return true
		}
	}
	return false
}

type pveTask struct {
	UPID      string `json:"upid"`
	Type      string `json:"type"`
	ID        string `json:"id"`
	Status    string `json:"status"`
	StartTime int64  `json:"starttime"`
	EndTime   int64  `json:"endtime"`
}

// vzdumpLog is what the agent extracts from a vzdump task log.
type vzdumpLog struct {
	Mode     string
	Storage  string
	Total    int
	OK       int
	Failed   []int
	Done     []int
	Written  uint64
	Warnings int
	// Guests: per-guest result ("ok" | "error") and start time (zero when
	// the log has no parseable "Backup started at" line).
	Guests map[int]vzdumpGuest
}

type vzdumpGuest struct {
	Result string
	At     time.Time
}

var (
	vzStartRE   = regexp.MustCompile(`^INFO: Starting Backup of VM (\d+) `)
	vzFinishRE  = regexp.MustCompile(`^INFO: Finished Backup of VM (\d+) `)
	vzFailRE    = regexp.MustCompile(`^ERROR: Backup of VM (\d+) failed`)
	vzSizeRE    = regexp.MustCompile(`^INFO: archive file size: ([0-9.]+)\s*([KMGTP]?i?B)`)
	vzXferRE    = regexp.MustCompile(`^INFO: transferred ([0-9.]+) ([KMGTP]?i?B) in`)
	vzReusedRE  = regexp.MustCompile(`^INFO: backup was done incrementally, reused ([0-9.]+) ([KMGTP]?i?B)`)
	vzStartedRE = regexp.MustCompile(`^INFO: Backup started at (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)`)
	vzModeRE    = regexp.MustCompile(`--mode (\w+)`)
	vzStorageRE = regexp.MustCompile(`--storage (\S+)`)
)

// sizeUnit converts vzdump's size strings (binary units; "MB" means MiB).
func sizeUnit(num, unit string) uint64 {
	f, err := strconv.ParseFloat(num, 64)
	if err != nil {
		return 0
	}
	mult := map[string]float64{"B": 1, "KB": 1 << 10, "KiB": 1 << 10, "MB": 1 << 20, "MiB": 1 << 20, "GB": 1 << 30, "GiB": 1 << 30, "TB": 1 << 40, "TiB": 1 << 40, "PB": 1 << 50, "PiB": 1 << 50}[unit]
	return uint64(f * mult)
}

// parseVzdumpLog parses a vzdump task log. Times in the log are node local
// time (loc).
func parseVzdumpLog(lines []string, loc *time.Location) *vzdumpLog {
	l := &vzdumpLog{Guests: map[int]vzdumpGuest{}}
	var xfer, reused uint64
	var haveArchive bool
	cur := 0
	var curAt time.Time
	for _, t := range lines {
		if m := vzStartRE.FindStringSubmatch(t); m != nil {
			cur, _ = strconv.Atoi(m[1])
			curAt = time.Time{}
		}
		if m := vzStartedRE.FindStringSubmatch(t); m != nil && cur != 0 {
			if at, err := time.ParseInLocation("2006-01-02 15:04:05", m[1], loc); err == nil {
				curAt = at.UTC()
			}
		}
		if strings.HasPrefix(t, "INFO: starting new backup job: vzdump") {
			if m := vzModeRE.FindStringSubmatch(t); m != nil {
				l.Mode = m[1]
			}
			if m := vzStorageRE.FindStringSubmatch(t); m != nil {
				l.Storage = strings.Trim(m[1], `'"`)
			}
		}
		if vzStartRE.MatchString(t) {
			l.Total++
		}
		if m := vzFinishRE.FindStringSubmatch(t); m != nil {
			l.OK++
			id, _ := strconv.Atoi(m[1])
			l.Done = append(l.Done, id)
			at := curAt
			if id != cur {
				at = time.Time{}
			}
			l.Guests[id] = vzdumpGuest{Result: "ok", At: at}
		}
		if m := vzFailRE.FindStringSubmatch(t); m != nil {
			id, _ := strconv.Atoi(m[1])
			l.Failed = append(l.Failed, id)
			at := curAt
			if id != cur {
				at = time.Time{}
			}
			l.Guests[id] = vzdumpGuest{Result: "error", At: at}
		}
		if m := vzSizeRE.FindStringSubmatch(t); m != nil {
			l.Written += sizeUnit(m[1], m[2])
			haveArchive = true
		}
		if m := vzXferRE.FindStringSubmatch(t); m != nil {
			xfer += sizeUnit(m[1], m[2])
		}
		if m := vzReusedRE.FindStringSubmatch(t); m != nil {
			reused += sizeUnit(m[1], m[2])
		}
	}
	if !haveArchive && xfer > reused {
		// Proxmox Backup Server: only the new chunks were uploaded.
		l.Written = xfer - reused
	}
	if l.Mode == "" {
		l.Mode = "snapshot"
	}
	return l
}

// taskResult maps a task status ("OK", "WARNINGS: 2", error text).
func taskResult(status string) (result string, warnings int) {
	switch {
	case status == "OK":
		return "ok", 0
	case strings.HasPrefix(status, "WARNINGS"):
		_, n, _ := strings.Cut(status, ":")
		w, _ := strconv.Atoi(strings.TrimSpace(n))
		return "warning", w
	}
	return "error", 0
}

func (p *pveCollector) runSlow(ctx context.Context) error {
	p.mu.Lock()
	enabled, node, hasErr := p.enabled, p.node, p.err != ""
	p.mu.Unlock()
	if !enabled {
		return nil
	}
	if node == "" || hasErr {
		return errors.New("pve: waiting for the API (see pve collector)")
	}
	var errs []error
	enode := url.PathEscape(node)

	// Storages as seen from this node.
	var list []pveStorageEntry
	if err := p.get(ctx, "/nodes/"+enode+"/storage", &list); err != nil {
		errs = append(errs, err)
	}
	var cfgs []pveStorageCfg
	_ = p.get(ctx, "/storage", &cfgs)
	cfgByID := map[string]pveStorageCfg{}
	for _, c := range cfgs {
		cfgByID[c.Storage] = c
	}
	var storages []proto.PVEStorage
	for _, s := range list {
		if s.Enabled != nil && *s.Enabled == 0 {
			continue
		}
		st := proto.PVEStorage{
			ID: s.Storage, Type: s.Type, Content: s.Content,
			Detail: cfgByID[s.Storage].detail(),
			Shared: s.Shared == 1, Active: s.Active == 1,
			UsedBytes: uint64(s.Used), TotalBytes: uint64(s.Total),
			Thin: cfgByID[s.Storage].thin(s.Type),
		}
		storages = append(storages, st)
	}
	sort.Slice(storages, func(i, j int) bool { return storages[i].ID < storages[j].ID })

	// Provisioned space: the configured disk sizes of this node's guests
	// and templates (from the cached configs) per storage.
	prov := map[string]uint64{}
	p.mu.Lock()
	for _, gc := range p.cfgCache {
		for id, n := range gc.disks {
			prov[id] += n
		}
	}
	p.mu.Unlock()
	for i := range storages {
		storages[i].ProvisionedBytes = prov[storages[i].ID]
	}

	// Backup jobs and recent vzdump tasks.
	var jobs []pveBackupJob
	jobsErr := p.get(ctx, "/cluster/backup", &jobs)
	if jobsErr != nil {
		errs = append(errs, jobsErr)
	}
	var tasks []pveTask
	if err := p.get(ctx, "/nodes/"+enode+"/tasks?typefilter=vzdump&limit=50&source=all", &tasks); err != nil {
		errs = append(errs, err)
	}
	backups, last := p.buildBackups(ctx, enode, node, jobs, tasks)

	// Last backup per guest: the newest of the task logs above and the
	// archives on the backup storages. (With the PVEAuditor role, PVE hides
	// backup volumes, so the content listing is usually empty; it helps
	// when the configured token has Datastore.AllocateSpace.)
	for _, s := range storages {
		if !s.Active || !containsStr(strings.Split(s.Content, ","), "backup") {
			continue
		}
		var content []struct {
			VMID  int   `json:"vmid"`
			CTime int64 `json:"ctime"`
		}
		if err := p.get(ctx, "/nodes/"+enode+"/storage/"+url.PathEscape(s.ID)+"/content?content=backup", &content); err != nil {
			errs = append(errs, err)
			continue
		}
		for _, c := range content {
			at := time.Unix(c.CTime, 0).UTC()
			if m := last[c.VMID]; m == nil || at.After(m.At) {
				last[c.VMID] = &proto.BackupMark{Result: "ok", At: at}
			}
		}
	}

	// Snapshot counts and the oldest snapshot of this node's guests
	// ("current" is not a snapshot).
	p.mu.Lock()
	type gref struct {
		vmid int
		typ  string
	}
	var refs []gref
	for _, g := range p.guests {
		typ := "qemu"
		if g.Kind == "container" {
			typ = "lxc"
		}
		refs = append(refs, gref{g.VMID, typ})
	}
	p.mu.Unlock()
	snaps := map[int]int{}
	oldest := map[int]time.Time{}
	for _, r := range refs {
		var list []struct {
			Name     string `json:"name"`
			SnapTime int64  `json:"snaptime"`
		}
		if err := p.get(ctx, fmt.Sprintf("/nodes/%s/%s/%d/snapshot", enode, r.typ, r.vmid), &list); err != nil {
			continue
		}
		n := 0
		for _, s := range list {
			if s.Name == "current" {
				continue
			}
			n++
			if s.SnapTime > 0 {
				if t, ok := oldest[r.vmid]; !ok || s.SnapTime < t.Unix() {
					oldest[r.vmid] = time.Unix(s.SnapTime, 0).UTC()
				}
			}
		}
		snaps[r.vmid] = n
	}

	// Ceph health, when this cluster has Ceph. PVEAuditor may read it;
	// 403 (no permission) and 501 (not installed) are not errors.
	var ceph *proto.CephHealth
	if p.c.host.root.exists("/etc/pve/ceph.conf") {
		var st pveCephStatus
		if err := p.get(ctx, "/cluster/ceph/status", &st); err == nil {
			ceph = cephHealth(st)
		} else if c := pveStatus(err); c != http.StatusForbidden && c != http.StatusNotImplemented {
			errs = append(errs, err)
		}
	}

	p.mu.Lock()
	p.snaps = snaps
	p.oldestSnap = oldest
	p.ceph = ceph
	if jobsErr == nil {
		// Keep the previous jobs when the list cannot be read.
		p.backupJobs = append([]pveBackupJob{}, jobs...)
	}
	for i := range p.guests {
		g := &p.guests[i]
		if n, ok := snaps[g.VMID]; ok {
			g.SnapshotsCount = ptr(n)
		}
		g.OldestSnapshot = nil
		if t, ok := oldest[g.VMID]; ok {
			g.OldestSnapshot = ptr(t)
		}
		if p.backupJobs != nil {
			g.BackupJob = ptr(backupCovered(p.backupJobs, node, g.VMID, p.pools[g.VMID]))
		}
	}
	p.storages = storages
	p.backups = backups
	p.lastBackup = last
	for i := range p.guests {
		if m := last[p.guests[i].VMID]; m != nil {
			mm := *m
			p.guests[i].LastBackup = &mm
		}
	}
	p.mu.Unlock()
	return errors.Join(errs...)
}

// buildBackups summarizes the backup jobs and the newest vzdump task.
// The returned marks hold each guest's newest backup result from the task logs.
func (p *pveCollector) buildBackups(ctx context.Context, enode, node string, jobs []pveBackupJob, tasks []pveTask) (*proto.PVEBackups, map[int]*proto.BackupMark) {
	marks := map[int]*proto.BackupMark{}
	var relevant []pveBackupJob
	for _, j := range jobs {
		if (j.Type == "" || j.Type == "vzdump") && j.enabled() && (j.Node == "" || j.Node == node) {
			relevant = append(relevant, j)
		}
	}
	if len(relevant) == 0 && len(tasks) == 0 {
		return nil, marks
	}
	b := &proto.PVEBackups{}
	var nextJob *pveBackupJob
	for i := range relevant {
		j := &relevant[i]
		if j.NextRun > 0 && (nextJob == nil || j.NextRun < nextJob.NextRun) {
			nextJob = j
		}
	}
	if nextJob != nil {
		t := time.Unix(nextJob.NextRun, 0).UTC()
		b.NextRun = &t
		b.Target = nextJob.Storage
	} else if len(relevant) > 0 {
		b.Target = relevant[0].Storage
	}

	// Finished tasks, newest first.
	var done []pveTask
	for _, t := range tasks {
		if t.Type == "vzdump" && t.EndTime > 0 && t.Status != "" {
			done = append(done, t)
		}
	}
	sort.Slice(done, func(i, j int) bool { return done[i].StartTime > done[j].StartTime })

	weekAgo := time.Now().Add(-7 * 24 * time.Hour).Unix()
	var sum, n int64
	for _, t := range done {
		// A job's task id is "" (several guests) or the vmid (one guest).
		if t.StartTime >= weekAgo {
			sum += t.EndTime - t.StartTime
			n++
		}
	}
	for i, t := range done {
		if i >= 30 {
			break
		}
		lg := p.taskLog(ctx, enode, t.UPID)
		if lg == nil {
			continue
		}
		// Per-guest result of the newest task that backed the guest up.
		for id, g := range lg.Guests {
			if marks[id] != nil {
				continue
			}
			at := g.At
			if at.IsZero() {
				at = time.Unix(t.StartTime, 0).UTC()
			}
			marks[id] = &proto.BackupMark{Result: g.Result, At: at}
		}
		if i == 0 {
			res, warn := taskResult(t.Status)
			job := &proto.PVEBackupJob{
				At:           time.Unix(t.StartTime, 0).UTC(),
				Mode:         lg.Mode,
				Result:       res,
				GuestsOK:     lg.OK,
				GuestsTotal:  lg.Total,
				Warnings:     warn,
				WrittenBytes: lg.Written,
				DurationS:    int(t.EndTime - t.StartTime),
			}
			// Schedule of the job that most likely ran this task.
			for _, j := range relevant {
				if (lg.Storage == "" || j.Storage == lg.Storage) && (j.Mode == "" || j.Mode == lg.Mode) {
					job.Schedule = j.Schedule
					break
				}
			}
			if job.Schedule == "" && len(relevant) > 0 {
				job.Schedule = relevant[0].Schedule
			}
			if n > 0 {
				avg := int(sum / n)
				job.AvgDurationWeek = &avg
			}
			if lg.Storage != "" && b.Target == "" {
				b.Target = lg.Storage
			}
			b.LastJob = job
		}
	}
	return b, marks
}

// taskLog fetches and parses a finished task's log (cached by UPID).
func (p *pveCollector) taskLog(ctx context.Context, enode, upid string) *vzdumpLog {
	p.mu.Lock()
	lg, ok := p.taskLogs[upid]
	p.mu.Unlock()
	if ok {
		return lg
	}
	var lines []struct {
		T string `json:"t"`
	}
	if err := p.get(ctx, "/nodes/"+enode+"/tasks/"+url.PathEscape(upid)+"/log?limit=20000", &lines); err != nil {
		return nil
	}
	ts := make([]string, len(lines))
	for i, l := range lines {
		ts[i] = l.T
	}
	lg = parseVzdumpLog(ts, time.Local)
	p.mu.Lock()
	if len(p.taskLogs) > 100 {
		p.taskLogs = map[string]*vzdumpLog{}
	}
	p.taskLogs[upid] = lg
	p.mu.Unlock()
	return lg
}

// snapshot assembles the PVE part of the report.
func (p *pveCollector) snapshot() *proto.PVE {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.enabled {
		return nil
	}
	out := &proto.PVE{
		Version:            p.version,
		Error:              p.err,
		Node:               p.node,
		HAResourcesStarted: p.haStarted,
		HAResourcesTotal:   p.haTotal,
	}
	if p.cluster != nil {
		c := *p.cluster
		out.Cluster = &c
	}
	out.Nodes = append([]proto.PVENode(nil), p.nodes...)
	out.Storages = append([]proto.PVEStorage(nil), p.storages...)
	if p.backups != nil {
		b := *p.backups
		if b.LastJob != nil {
			j := *b.LastJob
			b.LastJob = &j
		}
		out.Backups = &b
	}
	if p.err == "" || (!p.lastGood.IsZero() && time.Since(p.lastGood) < keepOnError) {
		out.Guests = append([]proto.Guest{}, p.guests...)
		out.Templates = append([]proto.TemplateGuest(nil), p.templates...)
	}
	out.Tasks = append([]proto.PVETask(nil), p.tasks...)
	out.Replication = append([]proto.PVEReplication(nil), p.repl...)
	if p.ceph != nil {
		c := *p.ceph
		c.Summary = append([]string(nil), p.ceph.Summary...)
		out.Ceph = &c
	}
	return out
}
