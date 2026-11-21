package collect

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"rackoon/internal/agent/broker"
	"rackoon/internal/proto"
)

var incusSockets = []string{"/var/lib/incus/unix.socket", "/run/incus/unix.socket"}

// incusSlowEvery is how often snapshot counts and the server's warnings
// are refreshed (a snapshot event refreshes the counts at once).
const incusSlowEvery = 5 * time.Minute

// incusCollector reads Incus instances over the local REST API. Every
// 10 s it lists the instances (recursion=1: configuration, no state, no
// snapshots) and fetches the state of the running and frozen ones;
// recursion=2 would decode every snapshot of every instance each time.
type incusCollector struct {
	lastGood time.Time // last successful run (failedPlatform)
	toggle   toggleFn
	c        *collector
	root     fsRoot
	zfs      *objsetIndex

	mu        sync.Mutex
	socket    string
	client    *http.Client
	platform  *proto.Platform
	prev      map[string]incusSample
	version   string
	versionAt time.Time
	snaps     map[string]int // by guest id
	slowAt    time.Time
	slowDirty bool
	warnings  []proto.PlatformWarning
	failedOps []proto.PVETask      // failed operations, last 48 h
	backups   map[string]time.Time // newest backup by guest id (slow path)
	detail    *proto.IncusDetail   // the host view (incus_detail.go, slow path)
	clustered bool
}

func newIncusCollector(toggle toggleFn, c *collector) *incusCollector {
	return &incusCollector{toggle: toggle, c: c, zfs: newObjsetIndex(""), prev: map[string]incusSample{}, snaps: map[string]int{}}
}

type incusResponse struct {
	Type      string          `json:"type"`
	Status    string          `json:"status"`
	ErrorCode int             `json:"error_code"`
	Error     string          `json:"error"`
	Metadata  json.RawMessage `json:"metadata"`
}

type incusInstance struct {
	Name            string                       `json:"name"`
	Project         string                       `json:"project"`
	Type            string                       `json:"type"`
	Status          string                       `json:"status"`
	Description     string                       `json:"description"`
	ExpandedConfig  map[string]string            `json:"expanded_config"`
	ExpandedDevices map[string]map[string]string `json:"expanded_devices"`
	State           *incusState                  `json:"state"`
	Snapshots       []struct{}                   `json:"snapshots"` // recursion=2 only
	CreatedAt       time.Time                    `json:"created_at"`
}

// incusState is /1.0/instances/<name>/state.
type incusState struct {
	Status string `json:"status"`
	Memory struct {
		Usage int64 `json:"usage"`
		Total int64 `json:"total"`
	} `json:"memory"`
	Disk map[string]struct {
		Usage int64 `json:"usage"`
	} `json:"disk"`
	Network map[string]struct {
		Addresses []struct {
			Family  string `json:"family"`
			Address string `json:"address"`
			Scope   string `json:"scope"`
		} `json:"addresses"`
		Counters struct {
			BytesReceived int64 `json:"bytes_received"`
			BytesSent     int64 `json:"bytes_sent"`
		} `json:"counters"`
		Type     string `json:"type"`
		HostName string `json:"host_name"`
	} `json:"network"`
	Pid       int64 `json:"pid"`
	Processes int64 `json:"processes"`
	CPU       struct {
		Usage int64 `json:"usage"`
	} `json:"cpu"`
	StartedAt time.Time `json:"started_at"`
	OSInfo    *struct {
		OS        string `json:"os"`
		OSVersion string `json:"os_version"`
	} `json:"os_info"`
}

// incusAmp is the separator for one more query parameter of path.
func incusAmp(path string) string {
	if strings.Contains(path, "?") {
		return "&"
	}
	return "?"
}

// path returns the API path of an instance sub-resource with its project.
func (in *incusInstance) path(sub string) string {
	p := "/1.0/instances/" + url.PathEscape(in.Name) + sub
	if in.Project != "" {
		p += "?project=" + url.QueryEscape(in.Project)
	}
	return p
}

func (in *incusInstance) guestID() string {
	if in.Project != "" && in.Project != "default" {
		return in.Project + "/" + in.Name
	}
	return in.Name
}

type incusSample struct {
	at       time.Time
	cpuNs    int64
	rd, wr   uint64
	ioSource string
	rx, tx   uint64
	cpuPct   *float64
	rdBps    *float64
	wrBps    *float64
	rxBps    *float64
	txBps    *float64
}

func (x *incusCollector) findSocket() string {
	for _, s := range incusSockets {
		if socketExists(s) {
			return s
		}
	}
	return ""
}

func (x *incusCollector) get(ctx context.Context, path string, v any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://incus"+path, nil)
	if err != nil {
		return err
	}
	resp, err := x.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	var r incusResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<20)).Decode(&r); err != nil {
		return fmt.Errorf("incus %s: %w", path, err)
	}
	if r.Type == "error" || resp.StatusCode != http.StatusOK {
		return fmt.Errorf("incus %s: %s", path, r.Error)
	}
	return json.Unmarshal(r.Metadata, v)
}

func (x *incusCollector) run(ctx context.Context) error {
	sock := x.findSocket()
	enabled := x.toggle.enabled(sock != "")
	x.c.incusSub.setAbsent(!enabled)
	if !enabled {
		x.mu.Lock()
		x.platform = nil
		x.mu.Unlock()
		return nil
	}
	fail := func(err error) error {
		x.mu.Lock()
		x.platform = failedPlatform(x.platform, x.lastGood, x.version, err)
		x.mu.Unlock()
		return err
	}
	if sock == "" {
		return fail(fmt.Errorf("incus socket not found (%s)", strings.Join(incusSockets, ", ")))
	}
	if x.socket != sock || x.client == nil {
		x.socket = sock
		x.client = unixHTTPClient(sock, 20*time.Second)
	}
	if x.version == "" || time.Since(x.versionAt) > 10*time.Minute {
		var srv struct {
			Environment struct {
				ServerVersion   string `json:"server_version"`
				ServerClustered bool   `json:"server_clustered"`
			} `json:"environment"`
		}
		if err := x.get(ctx, "/1.0", &srv); err != nil {
			return fail(err)
		}
		x.mu.Lock()
		x.version, x.versionAt = srv.Environment.ServerVersion, time.Now()
		x.clustered = srv.Environment.ServerClustered
		x.mu.Unlock()
	}
	var insts []incusInstance
	if err := x.get(ctx, "/1.0/instances?recursion=1&all-projects=true", &insts); err != nil {
		return fail(err)
	}
	// Live state of running and frozen instances, at most 8 at a time.
	sem := make(chan struct{}, 8)
	var wg sync.WaitGroup
	for i := range insts {
		if st := insts[i].Status; st != "Running" && st != "Frozen" {
			continue
		}
		wg.Add(1)
		go func(in *incusInstance) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			var st incusState
			if err := x.get(ctx, in.path("/state"), &st); err == nil {
				in.State = &st
			}
		}(&insts[i])
	}
	wg.Wait()
	x.refreshSlow(ctx, insts)
	now := time.Now()
	hostThreads := x.c.hostThreads()
	hostMem := x.c.hostMemTotal()

	x.mu.Lock()
	defer x.mu.Unlock()
	guests := make([]proto.Guest, 0, len(insts))
	seen := map[string]bool{}
	for i := range insts {
		in := &insts[i]
		g := incusGuest(in, hostMem)
		seen[g.ID] = true
		if n, ok := x.snaps[g.ID]; ok && in.Snapshots == nil {
			g.SnapshotsCount = ptr(n)
		}
		if at, ok := x.backups[g.ID]; ok {
			g.LastBackup = &proto.BackupMark{Result: "ok", At: at}
		}
		running := g.State == proto.StateRunning
		if running && in.State != nil {
			cur := incusSample{at: now, cpuNs: in.State.CPU.Usage}
			cur.rx, cur.tx = incusNetCounters(in)
			var ioOK bool
			cur.rd, cur.wr, cur.ioSource, ioOK = x.instanceIO(in)
			if p, ok := x.prev[g.ID]; ok {
				dt := now.Sub(p.at).Seconds()
				if dt >= 1 {
					n := float64(g.VCPU)
					if n <= 0 {
						n = float64(hostThreads)
					}
					if n > 0 && cur.cpuNs >= p.cpuNs {
						cur.cpuPct = ptr(round1(clamp(float64(cur.cpuNs-p.cpuNs)/(dt*1e9*n)*100, 0, 100)))
					}
					if ioOK && p.ioSource == cur.ioSource {
						cur.rdBps = rate(cur.rd, p.rd, dt)
						cur.wrBps = rate(cur.wr, p.wr, dt)
					}
					cur.rxBps = rate(cur.rx, p.rx, dt)
					cur.txBps = rate(cur.tx, p.tx, dt)
				} else {
					cur = p
				}
			}
			x.prev[g.ID] = cur
			g.CPUPct = copyPtr(cur.cpuPct)
			g.DiskReadBps, g.DiskWriteBps = copyPtr(cur.rdBps), copyPtr(cur.wrBps)
			g.NetRxBps, g.NetTxBps = copyPtr(cur.rxBps), copyPtr(cur.txBps)
		} else {
			delete(x.prev, g.ID)
		}
		guests = append(guests, g)
	}
	for id := range x.prev {
		if !seen[id] {
			delete(x.prev, id)
		}
	}
	x.platform = &proto.Platform{Version: x.version, Guests: guests, Warnings: x.warnings, Incus: incusWithCounts(x.detail, insts)}
	x.lastGood = time.Now()
	return nil
}

// refreshSlow updates the snapshot counts, the newest backups, the
// server's warnings and the host view (incus_detail.go) every
// incusSlowEvery or after a lifecycle event that changes them.
func (x *incusCollector) refreshSlow(ctx context.Context, insts []incusInstance) {
	x.mu.Lock()
	due := x.slowDirty || x.slowAt.IsZero() || time.Since(x.slowAt) >= incusSlowEvery
	clustered := x.clustered
	x.mu.Unlock()
	if !due {
		return
	}
	snaps := map[string]int{}
	backups := map[string]time.Time{}
	ok := true
	for i := range insts {
		var urls []string
		if err := x.get(ctx, insts[i].path("/snapshots"), &urls); err != nil {
			ok = false
			continue
		}
		snaps[insts[i].guestID()] = len(urls)
		var bks []struct {
			CreatedAt time.Time `json:"created_at"`
		}
		bp := insts[i].path("/backups")
		if x.get(ctx, bp+incusAmp(bp)+"recursion=1", &bks) == nil {
			for _, b := range bks {
				if t := incusTime(b.CreatedAt); t != nil && t.After(backups[insts[i].guestID()]) {
					backups[insts[i].guestID()] = *t
				}
			}
		}
	}
	var raw []incusWarning
	werr := x.get(ctx, "/1.0/warnings?recursion=1&all-projects=true", &raw)
	detail, derr := x.readDetail(ctx, clustered)
	x.mu.Lock()
	defer x.mu.Unlock()
	x.snaps = snaps
	x.backups = backups
	if werr == nil {
		x.warnings = incusWarnings(raw)
	}
	if derr == nil {
		x.detail = detail
	}
	if ok && werr == nil {
		x.slowAt, x.slowDirty = time.Now(), false
	}
}

// incusWarning is an entry of /1.0/warnings?recursion=1.
type incusWarning struct {
	Type        string    `json:"type"`
	LastMessage string    `json:"last_message"`
	Count       int       `json:"count"`
	LastSeen    time.Time `json:"last_seen_at"`
	Project     string    `json:"project"`
	Status      string    `json:"status"` // new | acknowledged | resolved
	Severity    string    `json:"severity"`
}

// incusWarnings keeps new and acknowledged warnings and merges repeats of
// the same warning (Incus files one per network or entity): counts add
// up, the latest time wins. Sorted by last seen, newest first.
func incusWarnings(raw []incusWarning) []proto.PlatformWarning {
	byKey := map[string]*proto.PlatformWarning{}
	var keys []string
	for _, w := range raw {
		if w.Status != "new" && w.Status != "acknowledged" {
			continue
		}
		k := w.Project + "\x00" + w.Type + "\x00" + w.LastMessage
		pw := byKey[k]
		if pw == nil {
			pw = &proto.PlatformWarning{Type: w.Type, Message: w.LastMessage, Project: w.Project}
			byKey[k] = pw
			keys = append(keys, k)
		}
		pw.Count += w.Count
		if w.LastSeen.After(pw.LastSeen) {
			pw.LastSeen = w.LastSeen.UTC()
		}
	}
	out := make([]proto.PlatformWarning, 0, len(keys))
	for _, k := range keys {
		out = append(out, *byKey[k])
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].LastSeen.After(out[j].LastSeen) })
	if len(out) == 0 {
		return nil
	}
	return out
}

// incusInternalIfaces are interfaces inside a guest whose addresses are
// not the guest's own (container bridges, veth pairs).
var incusInternalIfaces = []string{"docker", "br-", "veth", "virbr", "cni", "podman", "flannel", "cali", "kube", "lxcbr", "incusbr", "lxdbr"}

// incusAddresses returns the guest's global addresses (no CIDR), IPv4 first.
func incusAddresses(st *incusState) []string {
	names := make([]string, 0, len(st.Network))
	for n := range st.Network {
		names = append(names, n)
	}
	sort.Strings(names)
	var v4, v6 []string
outer:
	for _, n := range names {
		nw := st.Network[n]
		if n == "lo" || nw.Type == "loopback" {
			continue
		}
		for _, p := range incusInternalIfaces {
			if strings.HasPrefix(n, p) {
				continue outer
			}
		}
		for _, a := range nw.Addresses {
			if a.Scope != "global" {
				continue
			}
			if a.Family == "inet" {
				v4 = append(v4, a.Address)
			} else if a.Family == "inet6" {
				v6 = append(v6, a.Address)
			}
		}
	}
	return append(v4, v6...)
}

// incusNetCounters sums the byte counters of the instance's Incus-managed
// NICs (those with a host-side device). Interfaces created inside the guest
// (docker0, veth*, tailscale0) would count the same traffic twice; they are
// only used when no NIC reports a host device (older Incus).
func incusNetCounters(in *incusInstance) (rx, tx uint64) {
	managed := false
	for _, n := range in.State.Network {
		if n.HostName != "" {
			managed = true
			break
		}
	}
	for name, n := range in.State.Network {
		if name == "lo" || n.Type == "loopback" || (managed && n.HostName == "") {
			continue
		}
		rx += uint64(max(n.Counters.BytesReceived, 0))
		tx += uint64(max(n.Counters.BytesSent, 0))
	}
	return rx, tx
}

// incusGuest converts the static and memory parts of an instance.
func incusGuest(in *incusInstance, hostMem uint64) proto.Guest {
	cfg := in.ExpandedConfig
	kind := "container"
	if in.Type == "virtual-machine" {
		kind = "vm"
	}
	id := in.guestID()
	status := in.Status
	if in.State != nil && in.State.Status != "" {
		status = in.State.Status
	}
	state := proto.StateStopped
	switch status {
	case "Running":
		state = proto.StateRunning
	case "Frozen":
		state = proto.StatePaused
	}
	g := proto.Guest{
		ID:    id,
		Name:  in.Name,
		Kind:  kind,
		State: state,
		Image: incusImage(cfg, in),
	}
	g.VCPU = incusVCPU(cfg["limits.cpu"], kind)
	memCfg, hasMemLimit := incusMemory(cfg["limits.memory"], hostMem)
	if !hasMemLimit && kind == "vm" {
		memCfg, hasMemLimit = 1<<30, true // Incus VM default
	}
	if hasMemLimit {
		g.MemConfigBytes = memCfg
	}
	if in.Snapshots != nil { // recursion=2 listings (tests)
		g.SnapshotsCount = ptr(len(in.Snapshots))
	}
	osName := strings.ToLower(cfg["image.os"])
	if osName == "" && in.State != nil && in.State.OSInfo != nil {
		osName = strings.ToLower(in.State.OSInfo.OS)
	}
	if osName != "" {
		switch {
		case strings.Contains(osName, "windows"):
			g.OSType = "windows"
		case strings.Contains(osName, "bsd"):
			g.OSType = "freebsd"
		default:
			g.OSType = "linux"
		}
	}
	if state == proto.StateRunning && in.State != nil {
		if in.State.Memory.Usage > 0 {
			g.MemUsedBytes = ptr(uint64(in.State.Memory.Usage))
		}
		if hasMemLimit {
			g.MemLimitBytes = ptr(memCfg)
		}
		if !in.State.StartedAt.IsZero() && in.State.StartedAt.Year() > 2000 {
			g.StartedAt = ptr(in.State.StartedAt.UTC())
		}
	}
	if (state == proto.StateRunning || state == proto.StatePaused) && in.State != nil {
		if root, ok := in.State.Disk["root"]; ok && root.Usage > 0 {
			g.DiskUsedBytes = ptr(uint64(root.Usage))
		}
		if in.State.Processes >= 0 && (in.State.Processes > 0 || kind == "container") {
			g.Processes = ptr(int(in.State.Processes))
		}
		g.Addresses = incusAddresses(in.State)
	}
	g.Console = broker.Caps(proto.PlatformIncus, broker.GuestDisplay{Kind: kind, Running: state == proto.StateRunning})
	g.MACs = incusMACs(in)
	g.SnapshotSchedule = strings.TrimSpace(cfg["snapshots.schedule"])
	g.CreatedAt = incusTime(in.CreatedAt)
	return g
}

// incusVCPU parses limits.cpu: a count ("4") or a CPU set ("0-3,8").
// Containers without a limit report 0; VMs default to 1.
func incusVCPU(s, kind string) int {
	s = strings.TrimSpace(s)
	if s == "" {
		if kind == "vm" {
			return 1
		}
		return 0
	}
	if n, err := strconv.Atoi(s); err == nil {
		return n
	}
	return parseCPUList(s)
}

// incusMemory parses limits.memory ("2GiB", "512MB", "50%").
func incusMemory(s string, hostMem uint64) (uint64, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	if p, ok := strings.CutSuffix(s, "%"); ok {
		f, err := strconv.ParseFloat(p, 64)
		if err != nil || hostMem == 0 {
			return 0, false
		}
		return uint64(float64(hostMem) * f / 100), true
	}
	v, err := parseByteSize(s)
	return v, err == nil
}

// parseByteSize parses Incus/LXD size strings: decimal kB/MB/GB/TB/PB/EB and
// binary KiB/MiB/GiB/TiB/PiB/EiB suffixes, or a plain byte count.
func parseByteSize(s string) (uint64, error) {
	s = strings.TrimSpace(s)
	i := len(s)
	for i > 0 && (s[i-1] < '0' || s[i-1] > '9') && s[i-1] != '.' {
		i--
	}
	num, unit := strings.TrimSpace(s[:i]), strings.TrimSpace(s[i:])
	f, err := strconv.ParseFloat(num, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid size %q", s)
	}
	mult := map[string]float64{
		"": 1, "B": 1,
		"kB": 1e3, "KB": 1e3, "MB": 1e6, "GB": 1e9, "TB": 1e12, "PB": 1e15, "EB": 1e18,
		"KiB": 1 << 10, "MiB": 1 << 20, "GiB": 1 << 30, "TiB": 1 << 40, "PiB": 1 << 50, "EiB": 1 << 60,
	}[unit]
	if mult == 0 {
		return 0, fmt.Errorf("invalid size unit %q", s)
	}
	return uint64(math.Round(f * mult)), nil
}

// codenames maps distribution release codenames to version numbers so the
// image text matches the image server aliases ("debian/13").
var codenames = map[string]string{
	"forky": "14", "trixie": "13", "bookworm": "12", "bullseye": "11", "buster": "10",
	"questing": "25.10", "plucky": "25.04", "oracular": "24.10", "noble": "24.04", "mantic": "23.10",
	"lunar": "23.04", "jammy": "22.04", "focal": "20.04", "bionic": "18.04",
}

func incusImage(cfg map[string]string, in *incusInstance) string {
	osName := strings.TrimSpace(cfg["image.os"])
	release := strings.TrimSpace(cfg["image.release"])
	if osName == "" && in.State != nil && in.State.OSInfo != nil {
		osName, release = in.State.OSInfo.OS, in.State.OSInfo.OSVersion
	}
	if osName == "" {
		return truncate(strings.TrimSpace(cfg["image.description"]), 40)
	}
	f := strings.Fields(strings.ToLower(osName))
	name := f[0]
	if v, ok := codenames[strings.ToLower(release)]; ok {
		release = v
	}
	if release == "" {
		return name
	}
	return name + "/" + strings.ToLower(release)
}

// instanceIO returns cumulative disk read/write bytes of a running
// instance and the counter source.
func (x *incusCollector) instanceIO(in *incusInstance) (rd, wr uint64, source string, ok bool) {
	storage := in.Name
	if in.Project != "" && in.Project != "default" {
		storage = in.Project + "_" + in.Name
	}
	if in.Type == "virtual-machine" {
		if p := x.zfs.find("/virtual-machines/" + storage + ".block"); p != "" {
			if rd, wr, ok = readObjsetIO(p); ok {
				return rd, wr, "zfs", true
			}
		}
		if in.State != nil && in.State.Pid > 0 {
			if rd, wr, ok = readProcIO(x.root, in.State.Pid); ok {
				return rd, wr, "proc", true
			}
		}
		return 0, 0, "", false
	}
	if p := x.zfs.find("/containers/" + storage); p != "" {
		if rd, wr, ok = readObjsetIO(p); ok {
			return rd, wr, "zfs", true
		}
	}
	if b, err := x.root.read("/sys/fs/cgroup/lxc.payload." + storage + "/io.stat"); err == nil {
		if rd, wr, ok = parseCgroupIOStat(b); ok {
			return rd, wr, "cgroup", true
		}
	}
	return 0, 0, "", false
}

func (x *incusCollector) snapshot() *proto.Platform {
	x.mu.Lock()
	defer x.mu.Unlock()
	p := copyPlatform(x.platform)
	if p != nil && len(x.failedOps) > 0 {
		x.pruneOps(time.Now())
		p.Tasks = append([]proto.PVETask(nil), x.failedOps...)
	}
	return p
}

// Failed operations are kept this long, at most maxFailedOps of them.
const (
	failedOpsWindow = 48 * time.Hour
	maxFailedOps    = 50
)

// pruneOps drops failed operations past the window. Caller holds x.mu.
func (x *incusCollector) pruneOps(now time.Time) {
	keep := x.failedOps[:0]
	for _, t := range x.failedOps {
		if t.End == nil || now.Sub(*t.End) < failedOpsWindow {
			keep = append(keep, t)
		}
	}
	x.failedOps = keep
}

type incusOperation struct {
	ID          string              `json:"id"`
	Class       string              `json:"class"`
	Description string              `json:"description"`
	CreatedAt   time.Time           `json:"created_at"`
	UpdatedAt   time.Time           `json:"updated_at"`
	Status      string              `json:"status"`
	Resources   map[string][]string `json:"resources"`
	Err         string              `json:"err"`
	Location    string              `json:"location"`
}

// operationTask turns a failed operation event into a task (ok false: not
// a failure).
func operationTask(op incusOperation, project, node string) (proto.PVETask, bool) {
	if op.Status != "Failure" {
		return proto.PVETask{}, false
	}
	t := proto.PVETask{UPID: op.ID, Type: op.Description, Node: node, Start: op.CreatedAt, Status: op.Err, OK: false}
	if t.Type == "" {
		t.Type = op.Class
	}
	if t.Status == "" {
		t.Status = "failed"
	}
	end := op.UpdatedAt
	if end.IsZero() {
		end = time.Now()
	}
	t.End = &end
	for _, src := range op.Resources["instances"] {
		ev := incusEvent{Project: project}
		ev.Metadata.Source = src
		if id := incusEventGuest(&ev); id != "" {
			t.ID = id
			break
		}
	}
	if op.Location != "" && op.Location != "none" {
		t.Node = op.Location
	}
	return t, true
}

func (x *incusCollector) recordOperation(raw json.RawMessage, project string) {
	var op incusOperation
	if json.Unmarshal(raw, &op) != nil {
		return
	}
	node, _ := os.Hostname()
	t, ok := operationTask(op, project, node)
	if !ok {
		return
	}
	x.mu.Lock()
	defer x.mu.Unlock()
	for _, o := range x.failedOps {
		if o.UPID == t.UPID {
			return
		}
	}
	x.failedOps = append(x.failedOps, t)
	if len(x.failedOps) > maxFailedOps {
		x.failedOps = x.failedOps[len(x.failedOps)-maxFailedOps:]
	}
}

// ---- events ---------------------------------------------------------------------

type incusEvent struct {
	Type     string `json:"type"`
	Project  string `json:"project"`
	Metadata struct {
		Action string `json:"action"`
		Source string `json:"source"`
	} `json:"metadata"`
}

// incusRawEvent keeps the metadata of operation events for recordOperation.
type incusRawEvent struct {
	Type     string          `json:"type"`
	Project  string          `json:"project"`
	Metadata json.RawMessage `json:"metadata"`
}

func incusEventState(action string) (state, msg string) {
	switch action {
	case "instance-started", "instance-restarted", "instance-resumed":
		return proto.StateRunning, strings.TrimPrefix(action, "instance-")
	case "instance-paused":
		return proto.StatePaused, "paused"
	case "instance-stopped", "instance-shutdown":
		return proto.StateStopped, strings.TrimPrefix(action, "instance-")
	case "instance-deleted":
		return proto.StateStopped, "removed"
	case "instance-created":
		return proto.StateStopped, "created"
	}
	return "", ""
}

// incusEventGuest extracts the guest id from an event source
// ("/1.0/instances/web?project=lab" -> "lab/web").
func incusEventGuest(ev *incusEvent) string {
	src := ev.Metadata.Source
	u, err := url.Parse(src)
	if err != nil {
		return ""
	}
	name, ok := strings.CutPrefix(u.Path, "/1.0/instances/")
	if !ok || name == "" || strings.Contains(name, "/") {
		return ""
	}
	if n, err := url.PathUnescape(name); err == nil {
		name = n
	}
	project := ev.Project
	if p := u.Query().Get("project"); p != "" {
		project = p
	}
	if project != "" && project != "default" {
		return project + "/" + name
	}
	return name
}

func (x *incusCollector) startEvents(ctx context.Context) {
	go func() {
		backoff := time.Second
		for ctx.Err() == nil {
			sock := x.findSocket()
			if sock == "" || !x.toggle.enabled(true) {
				sleepCtx(ctx, 30*time.Second)
				continue
			}
			start := time.Now()
			_ = x.streamEvents(ctx, sock)
			if ctx.Err() != nil {
				return
			}
			if time.Since(start) > time.Minute {
				backoff = time.Second
			}
			sleepCtx(ctx, backoff)
			if backoff < 30*time.Second {
				backoff *= 2
			}
		}
	}()
}

func (x *incusCollector) streamEvents(ctx context.Context, sock string) error {
	client := unixHTTPClient(sock, 0)
	dctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	conn, _, err := websocket.Dial(dctx, "ws://incus/1.0/events?type=lifecycle,operation&all-projects=true", &websocket.DialOptions{HTTPClient: client})
	cancel()
	if err != nil {
		return err
	}
	defer conn.CloseNow()
	conn.SetReadLimit(1 << 20)
	for {
		_, b, err := conn.Read(ctx)
		if err != nil {
			return err
		}
		var raw incusRawEvent
		if json.Unmarshal(b, &raw) != nil {
			continue
		}
		if raw.Type == "operation" {
			x.recordOperation(raw.Metadata, raw.Project)
			continue
		}
		var ev incusEvent
		if json.Unmarshal(b, &ev) != nil || ev.Type != "lifecycle" {
			continue
		}
		if strings.HasPrefix(ev.Metadata.Action, "instance-snapshot-") || incusDetailEvent(ev.Metadata.Action) {
			x.mu.Lock()
			x.slowDirty = true
			x.mu.Unlock()
			x.c.incusSub.markDirty()
			if strings.HasPrefix(ev.Metadata.Action, "instance-snapshot-") || !strings.HasPrefix(ev.Metadata.Action, "instance-") {
				continue
			}
		}
		state, msg := incusEventState(ev.Metadata.Action)
		if state == "" {
			continue
		}
		if id := incusEventGuest(&ev); id != "" {
			x.c.guestEvent(proto.PlatformIncus, id, state, msg)
		}
	}
}
