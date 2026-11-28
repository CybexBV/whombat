package collect

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"rackoon/internal/agent/apps"
	"rackoon/internal/agent/broker"
	"rackoon/internal/proto"
)

const dockerSocket = "/var/run/docker.sock"

// dockerSizeEvery is how often the writable-layer sizes are fetched
// (containers/json?size=true walks every container's upper directory).
const dockerSizeEvery = 10 * time.Minute

// dockerCollector talks raw HTTP to the Docker Engine API.
type dockerCollector struct {
	lastGood time.Time // last successful run (failedPlatform)
	toggle   toggleFn
	c        *collector
	socket   string
	client   *http.Client

	mu        sync.Mutex
	platform  *proto.Platform
	prev      map[string]dockerSample
	inspect   map[string]dockerInspectCache
	version   string
	versionAt time.Time
	// Writable-layer sizes by container id, fetched in the background.
	sizes     map[string]uint64
	sizesAt   time.Time
	sizesBusy bool
	running   []imageCand // running containers' images (image updates)
	warnings  []proto.PlatformWarning
	extras    map[string]dockerExtra // by container name, for unRAID (unraid.go)
	// names maps container ids to names, kept dockerNamesFor after a
	// container was last listed: an OOM kill in a container that is gone
	// still names it (oom.go).
	names map[string]dockerName
}

type dockerName struct {
	name string
	seen time.Time
}

// dockerNamesFor is how long a removed container's name is kept.
const dockerNamesFor = 2 * time.Hour

// containerName is the name of a container id (also one removed in the
// last two hours), "" when unknown.
func (d *dockerCollector) containerName(id string) string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.names[id].name
}

// dockerExtra is what the unRAID collector needs of a container beyond
// the guest: its image as created, dockerMan's web page label, the
// network mode and the published ports.
type dockerExtra struct {
	image       string
	webUI       string
	networkMode string
	ports       []dockerPort
}

// dockerWarnings converts /info Warnings ("WARNING: No swap limit
// support") into platform warnings.
func dockerWarnings(ws []string) []proto.PlatformWarning {
	var out []proto.PlatformWarning
	for _, w := range ws {
		w = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(w), "WARNING:"))
		if w == "" {
			continue
		}
		out = append(out, proto.PlatformWarning{Type: "daemon", Message: truncate(w, 300), Count: 1})
	}
	return out
}

// imageCand is a running container's image for the update check.
type imageCand struct {
	Ref     string // as the container was created: "nginx:stable-alpine"
	ImageID string // "sha256:..."
}

func (c imageCand) key() string { return c.Ref + "@" + c.ImageID }

func newDockerCollector(toggle toggleFn, c *collector) *dockerCollector {
	return &dockerCollector{
		toggle:  toggle,
		c:       c,
		socket:  dockerSocket,
		client:  unixHTTPClient(dockerSocket, 15*time.Second),
		prev:    map[string]dockerSample{},
		inspect: map[string]dockerInspectCache{},
	}
}

type dockerListEntry struct {
	ID      string            `json:"Id"`
	Names   []string          `json:"Names"`
	Image   string            `json:"Image"`
	ImageID string            `json:"ImageID"`
	State   string            `json:"State"`
	Status  string            `json:"Status"`
	Created int64             `json:"Created"`
	Labels  map[string]string `json:"Labels"`
	SizeRw  *int64            `json:"SizeRw"` // with size=true
	Ports   []dockerPort      `json:"Ports"`
	HostCfg struct {
		NetworkMode string `json:"NetworkMode"`
	} `json:"HostConfig"`
	Health *struct {
		Status string `json:"Status"`
	} `json:"Health"`
}

func (e *dockerListEntry) name() string {
	if len(e.Names) > 0 {
		return strings.TrimPrefix(e.Names[0], "/")
	}
	if len(e.ID) >= 12 {
		return e.ID[:12]
	}
	return e.ID
}

// health returns the health status ("healthy", "unhealthy", "starting") or
// "" when the container has no health check.
func (e *dockerListEntry) health() string {
	if e.Health != nil && e.Health.Status != "" && e.Health.Status != "none" {
		return e.Health.Status
	}
	switch {
	case strings.Contains(e.Status, "(unhealthy)"):
		return "unhealthy"
	case strings.Contains(e.Status, "(healthy)"):
		return "healthy"
	case strings.Contains(e.Status, "(health: starting)"):
		return "starting"
	}
	return ""
}

type dockerStats struct {
	Read     time.Time `json:"read"`
	CPUStats struct {
		CPUUsage struct {
			TotalUsage  uint64   `json:"total_usage"`
			PercpuUsage []uint64 `json:"percpu_usage"`
		} `json:"cpu_usage"`
		SystemUsage uint64 `json:"system_cpu_usage"`
		OnlineCPUs  int    `json:"online_cpus"`
	} `json:"cpu_stats"`
	MemoryStats struct {
		Usage uint64            `json:"usage"`
		Limit uint64            `json:"limit"`
		Stats map[string]uint64 `json:"stats"`
	} `json:"memory_stats"`
	Networks map[string]struct {
		RxBytes uint64 `json:"rx_bytes"`
		TxBytes uint64 `json:"tx_bytes"`
	} `json:"networks"`
	BlkioStats struct {
		IOServiceBytesRecursive []struct {
			Op    string `json:"op"`
			Value uint64 `json:"value"`
		} `json:"io_service_bytes_recursive"`
	} `json:"blkio_stats"`
}

// memUsed follows the docker CLI: usage minus inactive file cache.
func (s *dockerStats) memUsed() uint64 {
	u := s.MemoryStats.Usage
	st := s.MemoryStats.Stats
	var sub uint64
	if v, ok := st["inactive_file"]; ok { // cgroup v2
		sub = v
	} else if v, ok := st["total_inactive_file"]; ok { // cgroup v1
		sub = v
	} else if v, ok := st["cache"]; ok {
		sub = v
	}
	if sub < u {
		return u - sub
	}
	return u
}

func (s *dockerStats) blkio() (rd, wr uint64) {
	for _, e := range s.BlkioStats.IOServiceBytesRecursive {
		switch strings.ToLower(e.Op) {
		case "read":
			rd += e.Value
		case "write":
			wr += e.Value
		}
	}
	return
}

func (s *dockerStats) net() (rx, tx uint64, ok bool) {
	for _, n := range s.Networks {
		rx += n.RxBytes
		tx += n.TxBytes
		ok = true
	}
	return
}

// dockerSample is the previous counters of a container, for rates.
type dockerSample struct {
	at         time.Time
	cpu, sys   uint64
	rd, wr     uint64
	rx, tx     uint64
	haveNet    bool
	cpuPct     *float64
	rdBps      *float64
	wrBps      *float64
	rxBps      *float64
	txBps      *float64
	onlineCPUs int
}

type dockerInspect struct {
	RestartCount int `json:"RestartCount"`
	Config       struct {
		Image string `json:"Image"`
	} `json:"Config"`
	State struct {
		Status     string `json:"Status"`
		OOMKilled  bool   `json:"OOMKilled"`
		ExitCode   int    `json:"ExitCode"`
		StartedAt  string `json:"StartedAt"`
		FinishedAt string `json:"FinishedAt"`
		Health     *struct {
			Status string `json:"Status"`
			Log    []struct {
				ExitCode int    `json:"ExitCode"`
				Output   string `json:"Output"`
			} `json:"Log"`
		} `json:"Health"`
	} `json:"State"`
	NetworkSettings struct {
		Networks map[string]struct {
			IPAddress         string `json:"IPAddress"`
			GlobalIPv6Address string `json:"GlobalIPv6Address"`
		} `json:"Networks"`
	} `json:"NetworkSettings"`
}

// addresses returns the container's IPs on its networks, IPv4 first,
// sorted by network name (host-network containers have none).
func (in *dockerInspect) addresses() []string {
	names := make([]string, 0, len(in.NetworkSettings.Networks))
	for n := range in.NetworkSettings.Networks {
		names = append(names, n)
	}
	sort.Strings(names)
	var v4, v6 []string
	for _, n := range names {
		nw := in.NetworkSettings.Networks[n]
		if nw.IPAddress != "" {
			v4 = append(v4, nw.IPAddress)
		}
		if nw.GlobalIPv6Address != "" {
			v6 = append(v6, nw.GlobalIPv6Address)
		}
	}
	return append(v4, v6...)
}

type dockerInspectCache struct {
	key        string // state + health; re-inspect when it changes
	at         time.Time
	startedAt  *time.Time
	finishedAt *time.Time
	healthText string
	restarts   int
	exitCode   int
	oomKilled  bool
	addrs      []string
	image      string // Config.Image
}

func parseDockerTime(s string) *time.Time {
	if s == "" || strings.HasPrefix(s, "0001-") {
		return nil
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return nil
	}
	t = t.UTC()
	return &t
}

// dockerImage shortens the image reference for display.
func dockerImage(image, imageID string) string {
	img := image
	if i := strings.Index(img, "@sha256:"); i >= 0 {
		img = img[:i]
	}
	if strings.HasPrefix(img, "sha256:") {
		if len(img) >= 19 {
			return img[7:19]
		}
		return img
	}
	img = strings.TrimSuffix(img, ":latest")
	img = strings.TrimPrefix(img, "docker.io/library/")
	img = strings.TrimPrefix(img, "docker.io/")
	if img == "" && len(imageID) >= 19 {
		return imageID[7:19]
	}
	return img
}

func (d *dockerCollector) get(ctx context.Context, path string, v any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker"+path, nil)
	if err != nil {
		return err
	}
	resp, err := d.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("docker %s: %s: %s", path, resp.Status, strings.TrimSpace(string(b)))
	}
	return json.NewDecoder(resp.Body).Decode(v)
}

func (d *dockerCollector) enabled() (enabled, detected bool) {
	detected = socketExists(d.socket)
	return d.toggle.enabled(detected), detected
}

// invalidate drops a container's cached inspect data (after an event: a
// restart changes the restart count and addresses without a visible state
// change between two polls).
func (d *dockerCollector) invalidate(id string) {
	d.mu.Lock()
	delete(d.inspect, id)
	d.mu.Unlock()
}

// refreshSizes fetches the writable-layer sizes in the background (it can
// take seconds on hosts with many containers, longer than a report).
func (d *dockerCollector) refreshSizes() {
	d.mu.Lock()
	if d.sizesBusy || time.Since(d.sizesAt) < dockerSizeEvery {
		d.mu.Unlock()
		return
	}
	d.sizesBusy = true
	d.mu.Unlock()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		var list []dockerListEntry
		err := d.get(ctx, "/containers/json?all=1&size=true", &list)
		d.mu.Lock()
		defer d.mu.Unlock()
		d.sizesBusy = false
		d.sizesAt = time.Now()
		if err != nil {
			return
		}
		d.sizes = map[string]uint64{}
		for _, e := range list {
			if e.SizeRw != nil && *e.SizeRw >= 0 {
				d.sizes[e.ID] = uint64(*e.SizeRw)
			}
		}
	}()
}

// runningImages returns the images of running containers (for the image
// update check).
func (d *dockerCollector) runningImages() []imageCand {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]imageCand(nil), d.running...)
}

func (d *dockerCollector) run(ctx context.Context) error {
	enabled, detected := d.enabled()
	d.c.dockerSub.setAbsent(!enabled)
	if !enabled {
		d.mu.Lock()
		d.platform = nil
		d.mu.Unlock()
		return nil
	}
	fail := func(err error) error {
		d.mu.Lock()
		d.platform = failedPlatform(d.platform, d.lastGood, d.version, err)
		d.mu.Unlock()
		return err
	}
	if !detected {
		return fail(fmt.Errorf("docker socket %s not found", d.socket))
	}
	if time.Since(d.versionAt) > 10*time.Minute || d.version == "" {
		var v struct {
			Version string `json:"Version"`
		}
		if err := d.get(ctx, "/version", &v); err != nil {
			return fail(err)
		}
		// The daemon's own warnings (no swap limit support, bridge
		// netfilter disabled, ...), refreshed with the version.
		var info struct {
			Warnings []string `json:"Warnings"`
		}
		werr := d.get(ctx, "/info", &info)
		d.mu.Lock()
		d.version, d.versionAt = v.Version, time.Now()
		if werr == nil {
			d.warnings = dockerWarnings(info.Warnings)
		}
		d.mu.Unlock()
	}
	var list []dockerListEntry
	if err := d.get(ctx, "/containers/json?all=1", &list); err != nil {
		return fail(err)
	}

	hostMem := d.c.hostMemTotal()
	hostThreads := d.c.hostThreads()

	// Stats for running containers, at most 8 at a time.
	type statRes struct {
		st  *dockerStats
		err error
		at  time.Time
	}
	stats := make([]statRes, len(list))
	sem := make(chan struct{}, 8)
	var wg sync.WaitGroup
	for i := range list {
		if list[i].State != "running" {
			continue
		}
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			var st dockerStats
			err := d.get(ctx, "/containers/"+list[i].ID+"/stats?stream=false&one-shot=true", &st)
			stats[i] = statRes{st: &st, err: err, at: time.Now()}
		}(i)
	}
	wg.Wait()

	// Inspect containers whose state changed (start / finish times).
	for i := range list {
		e := &list[i]
		key := e.State + "/" + e.health()
		d.mu.Lock()
		cached, ok := d.inspect[e.ID]
		d.mu.Unlock()
		if ok && cached.key == key && time.Since(cached.at) < time.Hour {
			continue
		}
		var in dockerInspect
		if err := d.get(ctx, "/containers/"+e.ID+"/json", &in); err != nil {
			continue
		}
		ic := dockerInspectCache{key: key, at: time.Now(), startedAt: parseDockerTime(in.State.StartedAt), finishedAt: parseDockerTime(in.State.FinishedAt),
			restarts: in.RestartCount, exitCode: in.State.ExitCode, oomKilled: in.State.OOMKilled, addrs: in.addresses(), image: in.Config.Image}
		if h := in.State.Health; h != nil && h.Status != "" && h.Status != "none" {
			ic.healthText = h.Status
			if h.Status == "unhealthy" && len(h.Log) > 0 {
				if out := strings.TrimSpace(h.Log[len(h.Log)-1].Output); out != "" {
					ic.healthText += ": " + truncate(firstLine(out), 160)
				}
			}
		}
		d.mu.Lock()
		d.inspect[e.ID] = ic
		d.mu.Unlock()
	}

	d.refreshSizes()
	var updates map[string]imageResult
	if d.c != nil && d.c.images != nil {
		updates = d.c.images.results()
	}

	d.mu.Lock()
	defer d.mu.Unlock()
	guests := make([]proto.Guest, 0, len(list))
	seen := map[string]bool{}
	var running []imageCand
	extras := make(map[string]dockerExtra, len(list))
	for i := range list {
		e := &list[i]
		seen[e.ID] = true
		ex := dockerExtra{webUI: e.Labels["net.unraid.docker.webui"], networkMode: e.HostCfg.NetworkMode, ports: e.Ports}
		if ic, ok := d.inspect[e.ID]; ok {
			ex.image = ic.image
		}
		extras[e.name()] = ex
		g := proto.Guest{
			ID:      e.name(),
			Name:    e.name(),
			Kind:    "container",
			Image:   dockerImage(e.Image, e.ImageID),
			ImageID: e.ImageID,
			State:   dockerState(e.State, e.health()),
			Project: e.Labels["com.docker.compose.project"],
			// Whombat's own services carry this label; Whombat hides them.
			WhombatService: e.Labels["whombat.service"] == "1",
		}
		g.Console = broker.Caps(proto.PlatformDocker, broker.GuestDisplay{Kind: "container", Running: e.State == "running"})
		if ic, ok := d.inspect[e.ID]; ok {
			g.RestartCount = ptr(ic.restarts)
			g.OOMKilled = ic.oomKilled
			if e.State == "running" || e.State == "paused" {
				g.HealthCheckText = ic.healthText
				g.StartedAt = copyPtr(ic.startedAt)
				g.Addresses = append([]string(nil), ic.addrs...)
			} else {
				g.FinishedAt = copyPtr(ic.finishedAt)
				g.ExitCode = ptr(ic.exitCode)
			}
		}
		if sz, ok := d.sizes[e.ID]; ok {
			g.DiskUsedBytes = ptr(sz)
		}
		var newer imageResult
		cand := imageCand{Ref: e.Image, ImageID: e.ImageID}
		if e.State == "running" {
			running = append(running, cand)
			if u, ok := updates[cand.key()]; ok {
				g.UpdateAvailable = copyPtr(u.update)
				newer = u
			}
		} else if u, ok := updates[cand.key()]; ok {
			// A stopped container isn't checked itself; one from the same
			// image that runs was, and an update takes both to that image.
			newer = u
		}
		g.App = composeApp(e.Labels, ex.image, e.Image, newer)
		if sr := stats[i]; sr.st != nil && sr.err == nil {
			st := sr.st
			at := st.Read
			if at.IsZero() {
				at = sr.at
			}
			cur := dockerSample{at: at, cpu: st.CPUStats.CPUUsage.TotalUsage, sys: st.CPUStats.SystemUsage}
			cur.rd, cur.wr = st.blkio()
			cur.rx, cur.tx, cur.haveNet = st.net()
			online := st.CPUStats.OnlineCPUs
			if online == 0 {
				online = len(st.CPUStats.CPUUsage.PercpuUsage)
			}
			if online == 0 {
				online = hostThreads
			}
			if p, ok := d.prev[e.ID]; ok {
				dt := cur.at.Sub(p.at).Seconds()
				if dt >= 1 {
					if cur.sys > p.sys && cur.cpu >= p.cpu {
						cur.cpuPct = ptr(round1(float64(cur.cpu-p.cpu) / float64(cur.sys-p.sys) * float64(online) * 100))
					}
					cur.rdBps = rate(cur.rd, p.rd, dt)
					cur.wrBps = rate(cur.wr, p.wr, dt)
					if cur.haveNet && p.haveNet {
						cur.rxBps = rate(cur.rx, p.rx, dt)
						cur.txBps = rate(cur.tx, p.tx, dt)
					}
				} else {
					// Too close to the previous sample (event-triggered
					// run): keep the previous rates and baseline.
					cur.cpuPct, cur.rdBps, cur.wrBps, cur.rxBps, cur.txBps = p.cpuPct, p.rdBps, p.wrBps, p.rxBps, p.txBps
					cur.at, cur.cpu, cur.sys, cur.rd, cur.wr, cur.rx, cur.tx = p.at, p.cpu, p.sys, p.rd, p.wr, p.rx, p.tx
				}
			}
			d.prev[e.ID] = cur
			g.CPUPct = copyPtr(cur.cpuPct)
			g.DiskReadBps, g.DiskWriteBps = copyPtr(cur.rdBps), copyPtr(cur.wrBps)
			g.NetRxBps, g.NetTxBps = copyPtr(cur.rxBps), copyPtr(cur.txBps)
			g.MemUsedBytes = ptr(st.memUsed())
			if lim := st.MemoryStats.Limit; lim > 0 && (hostMem == 0 || float64(lim) < float64(hostMem)*0.99) {
				g.MemLimitBytes = ptr(lim)
			}
		} else if e.State != "running" {
			delete(d.prev, e.ID)
		}
		guests = append(guests, g)
	}
	for id := range d.prev {
		if !seen[id] {
			delete(d.prev, id)
		}
	}
	for id := range d.inspect {
		if !seen[id] {
			delete(d.inspect, id)
		}
	}
	if d.names == nil {
		d.names = map[string]dockerName{}
	}
	now := time.Now()
	for i := range list {
		d.names[list[i].ID] = dockerName{list[i].name(), now}
	}
	for id, n := range d.names {
		if now.Sub(n.seen) > dockerNamesFor {
			delete(d.names, id)
		}
	}
	d.running = running
	d.extras = extras
	d.platform = &proto.Platform{Version: d.version, Guests: guests, Warnings: d.warnings}
	d.lastGood = time.Now()
	return nil
}

func dockerState(state, health string) string {
	switch state {
	case "running":
		if health == "unhealthy" {
			return proto.StateUnhealthy
		}
		return proto.StateRunning
	case "restarting":
		return proto.StateUnhealthy
	case "paused":
		return proto.StatePaused
	}
	return proto.StateStopped
}

// extrasSnapshot returns the containers' extras of the last run.
func (d *dockerCollector) extrasSnapshot() map[string]dockerExtra {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.extras
}

func (d *dockerCollector) snapshot() *proto.Platform {
	d.mu.Lock()
	defer d.mu.Unlock()
	return copyPlatform(d.platform)
}

// copyPlatform deep-copies the guest slice so the report does not share
// memory with the collector's cache.
func copyPlatform(p *proto.Platform) *proto.Platform {
	if p == nil {
		return nil
	}
	out := *p
	if p.Guests != nil {
		out.Guests = append([]proto.Guest(nil), p.Guests...)
	}
	return &out
}

// ---- events ---------------------------------------------------------------------

type dockerEvent struct {
	Type   string `json:"Type"`
	Action string `json:"Action"`
	Actor  struct {
		ID         string            `json:"ID"`
		Attributes map[string]string `json:"Attributes"`
	} `json:"Actor"`
}

// dockerEventState maps a container event action to a guest state ("" =
// not a state change).
func dockerEventState(action string) (state, msg string) {
	switch {
	case action == "start" || action == "unpause":
		return proto.StateRunning, action
	case action == "pause":
		return proto.StatePaused, "paused"
	case action == "die" || action == "stop":
		return proto.StateStopped, action
	case action == "destroy":
		return proto.StateStopped, "removed"
	case action == "create":
		return proto.StateStopped, "created"
	case strings.HasPrefix(action, "health_status"):
		st := strings.TrimSpace(strings.TrimPrefix(action, "health_status:"))
		if st == "unhealthy" {
			return proto.StateUnhealthy, "health check failing"
		}
		if st == "healthy" {
			return proto.StateRunning, "healthy"
		}
	}
	return "", ""
}

func (d *dockerCollector) startEvents(ctx context.Context) {
	go func() {
		backoff := time.Second
		stream := unixHTTPClient(d.socket, 0)
		for ctx.Err() == nil {
			enabled, detected := d.enabled()
			if !enabled || !detected {
				sleepCtx(ctx, 30*time.Second)
				continue
			}
			start := time.Now()
			err := d.streamEvents(ctx, stream)
			if ctx.Err() != nil {
				return
			}
			_ = err
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

func (d *dockerCollector) streamEvents(ctx context.Context, client *http.Client) error {
	filters := url.QueryEscape(`{"type":["container"]}`)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker/events?filters="+filters, nil)
	if err != nil {
		return err
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("docker events: %s", resp.Status)
	}
	dec := json.NewDecoder(resp.Body)
	for {
		var ev dockerEvent
		if err := dec.Decode(&ev); err != nil {
			return err
		}
		if ev.Type != "container" {
			continue
		}
		name := ev.Actor.Attributes["name"]
		if name == "" {
			name = ev.Actor.ID
		}
		if ev.Action == "oom" {
			// The kernel killed a process in the container for memory; the
			// container may survive (only the main process' death stops it).
			d.invalidate(ev.Actor.ID)
			d.c.dockerSub.markDirty()
			d.c.emit(proto.Event{Kind: "guest.oom", Platform: proto.PlatformDocker, GuestID: name,
				Message: "out of memory: the kernel killed a process in the container"}, false)
			continue
		}
		state, msg := dockerEventState(ev.Action)
		if state == "" {
			continue
		}
		d.invalidate(ev.Actor.ID)
		d.c.guestEvent(proto.PlatformDocker, name, state, msg)
	}
}

func sleepCtx(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
	case <-ctx.Done():
	}
}

// composeApp marks a container Whombat can update: one started by Docker
// Compose, from an image it can pull again (not pinned to a digest).
// Whether its project folder can be read is checked when it is updated:
// the agent's sandbox hides home folders, the update runs outside it. The
// newer image's digest and Compose's hash of the service's settings go with
// it, so an update deploys exactly what was checked.
func composeApp(labels map[string]string, configured, image string, newer imageResult) *proto.GuestApp {
	p, ok := apps.ProjectOf(labels)
	if !ok {
		return nil
	}
	ref := configured
	if ref == "" {
		ref = image
	}
	a := &proto.GuestApp{Service: p.Service, Version: apps.VersionOf(labels, ref), NewVersion: newer.version,
		ConfigHash: apps.ConfigHashOf(labels)}
	if apps.ValidDigest(newer.digest) {
		a.NewDigest = newer.digest
	}
	if apps.Pinned(ref) {
		a.Blocked = proto.AppReasonPinned
	}
	return a
}
