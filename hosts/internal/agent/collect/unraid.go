package collect

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"rackoon/internal/proto"
)

// unraidCollector reports the unRAID server (Report.Unraid) every 30 s
// from the files unRAID's own web page reads: emhttp's var.ini,
// disks.ini, shares.ini, sec.ini, sec_nfs.ini and monitor.ini, the flash
// configuration (parity history and schedule, pools, Docker and VM
// manager), the plugin manager's files and unRAID's notifications. It
// also keeps dockerMan's view of the containers (autostart list,
// templates, update status) for the Docker guests. Nothing is run: the
// checks for plugin, container and unRAID updates are unRAID's own
// (scheduled, or plugin.check / containers.check through the agent).
type unraidCollector struct {
	root fsRoot
	c    *collector

	mu     sync.Mutex
	detail *proto.Unraid
	docker unraidDockerView

	// Parsed files by path, kept while modification time and size match.
	plg  map[string]cachedFile[plgHeader]
	tmpl map[string]cachedFile[dockerTemplate]
}

// cachedFile is a parsed file with the stat it was parsed at.
type cachedFile[T any] struct {
	mod  time.Time
	size int64
	v    T
	ok   bool
}

// unraidDockerView is dockerMan's view of the containers.
type unraidDockerView struct {
	enabled   bool
	autostart map[string]bool // autostart list (nil: no list, nobody starts)
	templates map[string]dockerTemplate
	updates   map[string]unraidUpdateEntry
	lanIP     string
}

// unRAID paths (below the collector's root).
const (
	unraidVarINI       = "/var/local/emhttp/var.ini"
	unraidDisksINI     = "/var/local/emhttp/disks.ini"
	unraidSharesINI    = "/var/local/emhttp/shares.ini"
	unraidSecINI       = "/var/local/emhttp/sec.ini"
	unraidSecNFSINI    = "/var/local/emhttp/sec_nfs.ini"
	unraidMonitorINI   = "/var/local/emhttp/monitor.ini"
	unraidNginxINI     = "/var/local/emhttp/nginx.ini"
	unraidParityLog    = "/boot/config/parity-checks.log"
	unraidPoolsDir     = "/boot/config/pools"
	unraidDynamixCfg   = "/boot/config/plugins/dynamix/dynamix.cfg"
	unraidDockerCfg    = "/boot/config/docker.cfg"
	unraidDomainCfg    = "/boot/config/domain.cfg"
	unraidPluginsDir   = "/var/log/plugins"
	unraidPluginsNew   = "/tmp/plugins"
	unraidCheckResult  = "/tmp/unraidcheck/result.json"
	unraidCheckIgnored = "/tmp/unraidcheck/ignored.json"
	unraidMoverPID     = "/var/run/mover.pid"
	// UnraidAutostartFile, UnraidUpdateStatus and UnraidTemplatesDir are
	// dockerMan's.
	UnraidAutostartFile = "/var/lib/docker/unraid-autostart"
	UnraidUpdateStatus  = "/var/lib/docker/unraid-update-status.json"
	UnraidTemplatesDir  = "/boot/config/plugins/dockerMan/templates-user"
	unraidNotifyDefault = "/tmp/notifications"
	// unraidMaxNotifications bounds the unread files read per run.
	unraidMaxNotifications = 500
)

func newUnraidCollector(root fsRoot, c *collector) *unraidCollector {
	return &unraidCollector{root: root, c: c, plg: map[string]cachedFile[plgHeader]{}, tmpl: map[string]cachedFile[dockerTemplate]{}}
}

func (u *unraidCollector) run(ctx context.Context) error {
	if !isUnraid(u.root) && !u.root.exists(unraidVarINI) {
		if u.c != nil {
			u.c.unraidSub.setAbsent(true)
		}
		u.mu.Lock()
		u.detail, u.docker = nil, unraidDockerView{}
		u.mu.Unlock()
		return nil
	}
	if u.c != nil {
		u.c.unraidSub.setAbsent(false)
	}
	d, view, err := u.collect()
	u.mu.Lock()
	if d != nil {
		u.detail = d
	}
	u.docker = view
	u.mu.Unlock()
	return err
}

// collect reads everything. var.ini and disks.ini are required; the rest
// is reported as a partial problem when missing or unreadable.
func (u *unraidCollector) collect() (*proto.Unraid, unraidDockerView, error) {
	r := u.root
	vb, err := r.read(unraidVarINI)
	if err != nil {
		return nil, unraidDockerView{}, fmt.Errorf("unraid: %w", err)
	}
	db, err := r.read(unraidDisksINI)
	if err != nil {
		return nil, unraidDockerView{}, fmt.Errorf("unraid: %w", err)
	}
	var problems []string
	optional := func(p string) []byte {
		b, err := r.read(p)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			problems = append(problems, err.Error())
		}
		return b
	}
	v := parseINI(vb)[""]
	disks := parseINI(db)
	dyn := parseINI(optional(unraidDynamixCfg))
	monitor := parseINI(optional(unraidMonitorINI))

	d := &proto.Unraid{Version: v["version"], Name: v["NAME"], License: v["regTy"]}
	if d.Version == "" {
		d.Version = strings.Trim(strings.TrimPrefix(r.readString("/etc/unraid-version"), "version="), `"`)
	}

	// Array, pools, flash.
	var poolNames []string
	if ents, err := os.ReadDir(r.path(unraidPoolsDir)); err == nil {
		for _, e := range ents {
			if n, ok := strings.CutSuffix(e.Name(), ".cfg"); ok && !e.IsDir() && n != "" {
				poolNames = append(poolNames, n)
			}
		}
	}
	array, pools, flash := unraidStorage(disks, poolNames, monitor["poolsstatus"])
	d.Pools, d.Flash = pools, flash
	a := proto.UnraidArray{State: unraidArrayState(v), StateRaw: v["mdState"], StartOnBoot: v["startArray"] == "yes",
		ConfigValid: v["configValid"] == "yes", Disks: array}
	if a.Disks == nil {
		a.Disks = []proto.UnraidDisk{}
	}
	parityDisks := 0
	for _, x := range array {
		switch {
		case x.Slot == proto.UnraidSlotParity:
			parityDisks++
		case x.Slot == proto.UnraidSlotData && x.UsedBytes != nil:
			size := kib(disks[x.Name]["fsSize"])
			if size == 0 {
				size = x.SizeBytes
			}
			a.SizeBytes += size
			a.UsedBytes += *x.UsedBytes
			a.FreeBytes += *x.FreeBytes
		}
		switch x.StatusRaw {
		case "DISK_DSBL", "DISK_DSBL_NEW", "DISK_NP_DSBL":
			a.Disabled++
		case "DISK_INVALID":
			a.Invalid++
		case "DISK_NP_MISSING":
			a.Missing++
		}
		if strings.HasPrefix(x.FSType, "luks:") {
			d.Encrypted = true
		}
	}
	for _, p := range pools {
		if strings.HasPrefix(p.FSType, "luks:") {
			d.Encrypted = true
		}
	}
	if kf := v["luksKeyfile"]; kf != "" && filepath.IsAbs(kf) {
		d.KeyfilePresent = r.exists(kf)
	}
	a.MoverRunning = v["shareMoverActive"] == "yes" || u.moverRunning()

	loc := time.Local
	if tz := v["timeZone"]; tz != "" {
		if l, err := time.LoadLocation(tz); err == nil {
			loc = l
		}
	}
	history := parseParityLog(optional(unraidParityLog), loc)
	a.Parity = unraidParity(v, history, parityDisks, paritySchedule(dyn["parity"]))
	d.Array = a

	// Shares.
	if sb := optional(unraidSharesINI); len(sb) > 0 {
		d.Shares = unraidShares(parseINI(sb), parseINI(optional(unraidSecINI)), parseINI(optional(unraidSecNFSINI)))
	}

	// Plugins and unRAID's own update.
	d.Plugins, d.PluginsCheckedAt = u.plugins()
	d.OSUpdate = unraidOSUpdate(optional(unraidCheckResult), optional(unraidCheckIgnored), d.Version)
	if d.OSUpdate == "" {
		if h, ok := u.plgHeaderOf(filepath.Join(unraidPluginsNew, "unRAIDServer.plg")); ok && versionNewer(h.Version, d.Version) {
			d.OSUpdate = h.Version
		}
	}

	// Notifications.
	notifyPath := dyn["notify"]["path"]
	if notifyPath == "" || !filepath.IsAbs(notifyPath) {
		notifyPath = unraidNotifyDefault
	}
	d.Notifications, d.NotificationsUnread = u.notifications(notifyPath)

	// Docker and VMs.
	dockerCfg := parseINI(optional(unraidDockerCfg))[""]
	d.Docker.Enabled = dockerCfg["DOCKER_ENABLED"] == "yes"
	if s := monitor["system"]["docker"]; s != "" {
		if n, err := strconv.ParseFloat(s, 64); err == nil {
			d.Docker.ImageUsedPct = &n
		}
	}
	d.VMs.Enabled = parseINI(optional(unraidDomainCfg))[""]["SERVICE"] == "enable"
	d.LANAddress = parseINI(optional(unraidNginxINI))[""]["NGINX_LANIP"]

	view := unraidDockerView{enabled: d.Docker.Enabled, lanIP: d.LANAddress, templates: u.templates()}
	if b, err := r.read(UnraidAutostartFile); err == nil {
		view.autostart = parseAutostart(b)
	}
	if b, err := r.read(UnraidUpdateStatus); err == nil {
		view.updates = parseUpdateStatus(b)
	}
	if len(problems) > 0 {
		return d, view, partial("unraid: " + strings.Join(problems, "; "))
	}
	return d, view, nil
}

// moverRunning: the mover's PID file names a live process.
func (u *unraidCollector) moverRunning() bool {
	pid, ok := u.root.readInt(unraidMoverPID)
	return ok && pid > 0 && u.root.exists(fmt.Sprintf("/proc/%d", pid))
}

// plgHeaderOf parses a plugin file's head (cached by modification time
// and size; symlinks followed).
func (u *unraidCollector) plgHeaderOf(p string) (plgHeader, bool) {
	full := u.root.path(p)
	st, err := os.Stat(full)
	if err != nil || st.IsDir() {
		return plgHeader{}, false
	}
	if c, ok := u.plg[p]; ok && c.mod.Equal(st.ModTime()) && c.size == st.Size() {
		return c.v, c.ok
	}
	f, err := os.Open(full)
	if err != nil {
		return plgHeader{}, false
	}
	defer f.Close()
	// The DOCTYPE and the <PLUGIN> tag come first; 64 KiB is plenty.
	b, _ := io.ReadAll(io.LimitReader(f, 64<<10))
	h, ok := parsePlgHeader(b)
	u.plg[p] = cachedFile[plgHeader]{mod: st.ModTime(), size: st.Size(), v: h, ok: ok}
	return h, ok
}

// plugins lists the installed plugins (/var/log/plugins/*.plg, without
// unRAID itself) with the newer version unRAID's check downloaded to
// /tmp/plugins, and when that check last ran.
func (u *unraidCollector) plugins() ([]proto.UnraidPlugin, time.Time) {
	var checked time.Time
	if ents, err := os.ReadDir(u.root.path(unraidPluginsNew)); err == nil {
		for _, e := range ents {
			if !strings.HasSuffix(e.Name(), ".plg") {
				continue
			}
			if info, err := e.Info(); err == nil && info.ModTime().After(checked) {
				checked = info.ModTime().UTC()
			}
		}
	}
	ents, err := os.ReadDir(u.root.path(unraidPluginsDir))
	if err != nil {
		return nil, checked
	}
	seen := map[string]bool{}
	var out []proto.UnraidPlugin
	for _, e := range ents {
		file := e.Name()
		if !strings.HasSuffix(file, ".plg") || file == "unRAIDServer.plg" {
			continue
		}
		seen[unraidPluginsDir+"/"+file] = true
		h, ok := u.plgHeaderOf(filepath.Join(unraidPluginsDir, file))
		if !ok {
			continue
		}
		p := proto.UnraidPlugin{Name: h.Name, File: file, Version: h.Version, Author: h.Author, SupportURL: h.Support}
		if p.Name == "" {
			p.Name = strings.TrimSuffix(file, ".plg")
		}
		newer := filepath.Join(unraidPluginsNew, file)
		seen[newer] = true
		if n, ok := u.plgHeaderOf(newer); ok && n.Version != "" && versionNewer(n.Version, h.Version) {
			p.Update = n.Version
		}
		out = append(out, p)
	}
	seen[filepath.Join(unraidPluginsNew, "unRAIDServer.plg")] = true
	for k := range u.plg {
		if !seen[k] {
			delete(u.plg, k)
		}
	}
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name) })
	return out, checked
}

// notifications reads the unread notifications, newest first (at most
// 50 listed, all counted).
func (u *unraidCollector) notifications(path string) ([]proto.UnraidNotification, int) {
	ents, err := os.ReadDir(u.root.path(filepath.Join(path, "unread")))
	if err != nil {
		return nil, 0
	}
	var out []proto.UnraidNotification
	total := 0
	for _, e := range ents {
		id, ok := strings.CutSuffix(e.Name(), ".notify")
		if !ok || e.IsDir() {
			continue
		}
		total++
		if total > unraidMaxNotifications {
			continue
		}
		b, err := u.root.read(filepath.Join(path, "unread", e.Name()))
		if err != nil || len(b) > 64<<10 {
			continue
		}
		if n, ok := parseNotify(id, b); ok {
			out = append(out, n)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if !out[i].At.Equal(out[j].At) {
			return out[i].At.After(out[j].At)
		}
		return out[i].ID < out[j].ID
	})
	if len(out) > 50 {
		out = out[:50]
	}
	return out, total
}

// templates reads dockerMan's user templates by container name.
func (u *unraidCollector) templates() map[string]dockerTemplate {
	dir := UnraidTemplatesDir
	ents, err := os.ReadDir(u.root.path(dir))
	if err != nil {
		return nil
	}
	out := map[string]dockerTemplate{}
	seen := map[string]bool{}
	for _, e := range ents {
		if e.IsDir() || !strings.HasSuffix(strings.ToLower(e.Name()), ".xml") {
			continue
		}
		p := filepath.Join(dir, e.Name())
		seen[p] = true
		info, err := e.Info()
		if err != nil || info.Size() > 1<<20 {
			continue
		}
		c, ok := u.tmpl[p]
		if !ok || !c.mod.Equal(info.ModTime()) || c.size != info.Size() {
			c = cachedFile[dockerTemplate]{mod: info.ModTime(), size: info.Size()}
			if b, err := u.root.read(p); err == nil {
				c.v, c.ok = parseDockerTemplate(b)
			}
			u.tmpl[p] = c
		}
		if c.ok {
			if _, dup := out[c.v.Name]; !dup {
				out[c.v.Name] = c.v
			}
		}
	}
	for k := range u.tmpl {
		if !seen[k] {
			delete(u.tmpl, k)
		}
	}
	return out
}

// snapshot returns a copy of the latest unRAID detail with the report's
// disk models and serials (the disk collector reads them from the drive)
// and the docker.img use from the file systems when monitor.ini has none.
func (u *unraidCollector) snapshot(r *proto.Report) *proto.Unraid {
	u.mu.Lock()
	src := u.detail
	u.mu.Unlock()
	if src == nil {
		return nil
	}
	d := copyUnraid(src)
	byDev := map[string]proto.Disk{}
	for _, x := range r.Disks {
		byDev[x.Device] = x
	}
	fix := func(x *proto.UnraidDisk) {
		if pd, ok := byDev[x.Device]; ok && x.Device != "" {
			if pd.Model != "" {
				x.Model = pd.Model
			}
			if pd.Serial != "" {
				x.Serial = pd.Serial
			}
		}
	}
	for i := range d.Array.Disks {
		fix(&d.Array.Disks[i])
	}
	for i := range d.Pools {
		for j := range d.Pools[i].Disks {
			fix(&d.Pools[i].Disks[j])
		}
	}
	if d.Flash != nil {
		fix(d.Flash)
	}
	if d.Docker.ImageUsedPct == nil {
		for _, f := range r.Filesystems {
			if f.Mount == "/var/lib/docker" && f.SizeBytes > 0 {
				d.Docker.ImageUsedPct = ptr(round1(float64(f.UsedBytes) / float64(f.SizeBytes) * 100))
			}
		}
	}
	return d
}

// copyUnraid deep-copies the detail so the report shares nothing with the
// collector.
func copyUnraid(s *proto.Unraid) *proto.Unraid {
	d := *s
	copyDisks := func(in []proto.UnraidDisk) []proto.UnraidDisk {
		if in == nil {
			return nil
		}
		out := make([]proto.UnraidDisk, len(in))
		for i, x := range in {
			x.UsedBytes, x.FreeBytes, x.TempC, x.Rotational = copyPtr(x.UsedBytes), copyPtr(x.FreeBytes), copyPtr(x.TempC), copyPtr(x.Rotational)
			out[i] = x
		}
		return out
	}
	d.Array.Disks = copyDisks(s.Array.Disks)
	p := s.Array.Parity
	p.Pct, p.SpeedMBs, p.ETAS = copyPtr(p.Pct), copyPtr(p.SpeedMBs), copyPtr(p.ETAS)
	if p.Last != nil {
		l := *p.Last
		p.Last = &l
	}
	p.History = append([]proto.UnraidParityRun(nil), p.History...)
	d.Array.Parity = p
	if s.Pools != nil {
		d.Pools = make([]proto.UnraidPool, len(s.Pools))
		for i, x := range s.Pools {
			x.Disks = copyDisks(x.Disks)
			d.Pools[i] = x
		}
	}
	if s.Flash != nil {
		f := copyDisks([]proto.UnraidDisk{*s.Flash})[0]
		d.Flash = &f
	}
	d.Shares = append([]proto.UnraidShare(nil), s.Shares...)
	d.Plugins = append([]proto.UnraidPlugin(nil), s.Plugins...)
	d.Notifications = append([]proto.UnraidNotification(nil), s.Notifications...)
	d.Docker.ImageUsedPct = copyPtr(s.Docker.ImageUsedPct)
	return &d
}

// enrichDocker adds dockerMan's view to the Docker guests on unRAID:
// autostart, whether a template exists, the web page link and the update
// status of unRAID's own check (it wins over the agent's registry check
// when it knows).
func (u *unraidCollector) enrichDocker(p *proto.Platform, extras map[string]dockerExtra, hostAddrs []string) {
	if p == nil {
		return
	}
	u.mu.Lock()
	view := u.docker
	have := u.detail != nil
	u.mu.Unlock()
	if !have {
		return
	}
	lan := view.lanIP
	if lan == "" && len(hostAddrs) > 0 {
		lan = hostAddrs[0]
	}
	for i := range p.Guests {
		g := &p.Guests[i]
		ex := extras[g.ID]
		g.Autostart = ptr(view.autostart[g.ID])
		t, ok := view.templates[g.ID]
		g.UnraidTemplate = ok
		webui := ex.webUI
		if webui == "" && ok {
			webui = t.WebUI
		}
		ip := lan
		if ok && t.MyIP != "" && ex.networkMode != "host" {
			ip = t.MyIP
		}
		g.WebUI = resolveWebUI(webui, ip, ex.networkMode, ex.ports, g.Addresses)
		image := ex.image
		if image == "" {
			image = g.Image
		}
		if upd := dockerManUpdate(view.updates, image); upd != nil {
			g.UpdateAvailable = upd
		}
	}
}
