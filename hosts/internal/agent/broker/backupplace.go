package broker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/crypto/bcrypt"

	"rackoon/internal/proto"
)

// Backup places (docs/MANAGE.md 2.10): this server keeps Whombats'
// backups. Per Whombat ("client") it runs two containers:
//
//   - <prefix><client>: restic's REST server, append-only and with private
//     repositories, two users whose bcrypt lines are in
//     <root>/.whombat/<client>.htpasswd: the client, whose data is
//     <root>/<client>, and the kit user (proto.PlaceKitUser), whose
//     repository /kit/ is <root>/.whombat/<client>.kit; its port the first
//     free from 8747 (kept once chosen);
//   - <prefix><client>-cleanup: restic itself, which once a week clears
//     snapshots older than the client's days straight on the data folder,
//     with the repository password in <root>/.whombat/<client>.pass, and
//     writes how it went to <root>/.whombat/<client>.cleanup.json; it also
//     keeps only the newest kit files of each Whombat.
//
// <root> is the client's location (backupplace_move.go): on Unraid the
// dedicated share whombat-backups (made through Unraid's own emcmd,
// exported over neither SMB nor NFS) or a folder "whombat" in another
// user share the person chose, on other Linux servers
// /srv/whombat-backups. A client's root is where its server container's
// data bind points. On Unraid both containers get a dockerMan template
// and start with the array. Images are pinned by digest.

// The pinned images (resolved from Docker Hub when this was built: the
// multi-architecture index digests of restic/rest-server:0.14.0 and
// restic/restic:0.18.1).
const (
	PlaceRestImage    = "restic/rest-server@sha256:d2aff06f47eb38637dff580c3e6bce4af98f386c396a25d32eb6727ec96214a5"
	PlaceCleanupImage = "restic/restic@sha256:39d9072fb5651c80d75c7a811612eb60b4c06b32ffe87c2e9f3c7222e1797e76"
)

// Container labels of the backup places.
const (
	placeLabelService = "whombat.service" // = backup-place
	placeLabelClient  = "whombat.client"
	placeLabelRole    = "whombat.role" // server | cleanup
	placeLabelPort    = "whombat.port"
	placeLabelKeep    = "whombat.keep_days"
	// placeLabelKeepPolicy is the person's windows and limit (placeKeep.label), so a move keeps them (HS-251).
	placeLabelKeepPolicy = "whombat.keep"
	placeLabelConfig     = "whombat.config" // a hash of the container's settings
	placeLabelKit        = "whombat.kit"    // "1": a REST server with the kit user and its folder
	placeService         = "backup-place"
	// placeVersion changes when the containers' settings change shape, so
	// an updated agent recreates them.
	placeVersion = "1"
)

// Default roots and container prefix.
const (
	placeRootLinux   = proto.PlaceRootLinux
	placePrefix      = "whombat-backup-"
	placeRestPort    = "8000/tcp"
	placeStateDir    = ".whombat"
	placeCleanupFile = "cleanup.sh"
	placeSizeEvery   = 30 * time.Minute
)

// placeManager runs the backup place operations and reads the place for
// the report.
type placeManager struct {
	docker   *dockerDriver
	unraid   *unraidManager // emcmd, dockerMan's files, var.ini (its root in tests)
	isUnraid func() bool
	root     string // the dedicated root; "" = by platform
	// userShares is Unraid's /mnt/user ("" = the real one; tests).
	userShares string
	// testLocations are more locations (id -> root) on a server without
	// Unraid (tests: a move between two roots).
	testLocations map[string]string
	fs            placeFS
	prefix        string            // container names
	labels        map[string]string // more labels on every container (tests)
	user          string            // the containers' user, "" = the image's (tests)

	restImage, cleanupImage string
	// portFree reports whether nothing listens on a host port.
	portFree func(port int) bool
	// addresses are the server's LAN addresses (the latest report's).
	addresses func() []string
	// readyWait bounds the wait for the REST server's first answer; poll
	// is the wait's interval.
	readyWait, poll time.Duration
	// probe checks that the REST server answers (nil: HTTP on 127.0.0.1).
	probe func(ctx context.Context, port int) error
	now   func() time.Time

	mu sync.Mutex // one change at a time

	sizeMu sync.Mutex
	sizes  map[string]placeSize
}

type placeSize struct {
	bytes uint64
	at    time.Time
}

func newPlaceManager(u *unraidManager, inv func() *proto.Report) *placeManager {
	m := &placeManager{docker: &dockerDriver{}, unraid: u, isUnraid: isUnraid, prefix: placePrefix,
		restImage: PlaceRestImage, cleanupImage: PlaceCleanupImage, portFree: portFree,
		readyWait: 60 * time.Second, poll: time.Second, now: time.Now, sizes: map[string]placeSize{}}
	m.addresses = func() []string {
		if inv == nil {
			return nil
		}
		if r := inv(); r != nil {
			return PlaceAddresses(r.Host.Addresses)
		}
		return nil
	}
	return m
}

// filesystem returns how the manager writes below the root: directly on
// Unraid (the agent runs unsandboxed there), else outside the agent's
// systemd sandbox, which keeps /srv read-only.
func (m *placeManager) filesystem() placeFS {
	if m.fs != nil {
		return m.fs
	}
	if underSystemd() && !m.isUnraid() {
		return outsideFS{}
	}
	return directFS{}
}

// PlaceAddresses are the private IPv4 addresses of a report's address
// list (the default route's interface first, as the report has them).
func PlaceAddresses(addrs []string) []string {
	var out []string
	for _, a := range addrs {
		ip := net.ParseIP(a)
		if ip == nil || ip.To4() == nil || !ip.IsPrivate() {
			continue
		}
		out = append(out, ip.To4().String())
	}
	return out
}

func (m *placeManager) platform() string {
	if m.isUnraid() {
		return proto.PlacePlatformUnraid
	}
	return proto.PlacePlatformLinux
}

func (m *placeManager) rootDir() string {
	switch {
	case m.root != "":
		return m.root
	case m.isUnraid():
		return filepath.Join(m.sharesDir(), proto.PlaceShareName)
	}
	return placeRootLinux
}

// stateDir, dataDir and stateFile are in the dedicated root; the In
// forms in a client's root.
func (m *placeManager) stateDir() string { return stateDirIn(m.rootDir()) }

func (m *placeManager) dataDir(client string) string { return dataIn(m.rootDir(), client) }

func (m *placeManager) stateFile(client, ext string) string {
	return stateFileIn(m.rootDir(), client, ext)
}

func stateDirIn(root string) string { return filepath.Join(root, placeStateDir) }

func dataIn(root, client string) string { return filepath.Join(root, client) }

func stateFileIn(root, client, ext string) string {
	return filepath.Join(stateDirIn(root), client+"."+ext)
}

// kitDirIn is the folder of a client's REST server's kit repository.
func kitDirIn(root, client string) string { return stateFileIn(root, client, "kit") }

// clientRoot is the root a container's binds keep the client's data in
// ("" = none).
func clientRoot(binds []string, client string) string {
	for _, b := range binds {
		parts := strings.Split(b, ":")
		if len(parts) >= 2 && parts[1] == "/data/"+client {
			return filepath.Dir(filepath.Clean(parts[0]))
		}
	}
	return ""
}

func (m *placeManager) serverName(client string) string  { return m.prefix + client }
func (m *placeManager) cleanupName(client string) string { return m.prefix + client + "-cleanup" }

// unraidStarted reads whether Unraid's array is started (var.ini).
func (m *placeManager) unraidStarted() bool {
	v, err := m.unraid.varINI()
	return err == nil && strings.EqualFold(v["mdState"], "STARTED")
}

// unsupportedReason is why the server can't keep backups now ("" = it
// can): Unraid's array stopped, no Docker, Docker not answering.
func (m *placeManager) unsupportedReason(ctx context.Context) string {
	if m.isUnraid() && !m.unraidStarted() {
		return proto.PlaceArrayStopped
	}
	if _, err := m.docker.socketPath(); err != nil {
		return proto.PlaceNoDocker
	}
	if err := m.docker.dockerPing(ctx); err != nil {
		return proto.PlaceDockerDown
	}
	return ""
}

// placeReasonText is the plain sentence of a reason.
var placeReasonText = map[string]string{
	proto.PlaceArrayStopped: "Unraid’s array is stopped: start it first.",
	proto.PlaceNoDocker:     "This server has no Docker, which the backup app needs.",
	proto.PlaceDockerDown:   "Docker isn’t answering on this server.",
	proto.PlaceNFSOff:       "NFS is off on this Unraid server: turn it on in Settings → NFS first.",
	proto.PlaceNotUnraid:    "Only Unraid servers share a folder for backups this way.",
}

// placeUnsupported is an unsupported refusal with its reason.
type placeUnsupported struct{ reason string }

func (e *placeUnsupported) Error() string {
	if t := placeReasonText[e.reason]; t != "" {
		return t
	}
	return "This server can’t keep backups."
}

// ---- the report ----------------------------------------------------------------------

// placeCleanupStatus is <client>.cleanup.json as the cleanup writes it.
type placeCleanupStatus struct {
	KeepWithinDays int     `json:"keep_within_days"`
	Keep           string  `json:"keep"`
	OverLimit      bool    `json:"over_limit"`
	Running        bool    `json:"running"`
	LastRunAt      *string `json:"last_run_at"`
	LastOK         *bool   `json:"last_ok"`
	LastError      string  `json:"last_error"`
}

// status reads the place: what is possible, the root's space and every
// client's containers and cleanup. It pulls nothing and changes nothing.
func (m *placeManager) status(ctx context.Context) *proto.BackupPlace {
	bp := &proto.BackupPlace{Platform: m.platform(), Root: m.rootDir()}
	if free, total, ok := spaceOf(m.rootDir()); ok {
		bp.FreeBytes, bp.TotalBytes = &free, &total
	}
	if m.isUnraid() {
		if v, err := m.unraid.varINI(); err == nil {
			bp.NFS = strings.EqualFold(v["shareNFSEnabled"], "yes")
		}
	}
	bp.Reason = m.unsupportedReason(ctx)
	bp.Supported = bp.Reason == ""
	if bp.Reason == proto.PlaceNoDocker || bp.Reason == proto.PlaceDockerDown {
		return bp
	}
	list, err := m.docker.listContainers(ctx, placeLabelService+"="+placeService)
	if err != nil {
		return bp
	}
	byClient := map[string]*proto.BackupPlaceClient{}
	roots := map[string]string{}
	get := func(client string) *proto.BackupPlaceClient {
		c := byClient[client]
		if c == nil {
			c = &proto.BackupPlaceClient{Client: client}
			byClient[client] = c
		}
		return c
	}
	for _, e := range list {
		client := e.Labels[placeLabelClient]
		if !proto.ValidPlaceClient(client) {
			continue
		}
		c := get(client)
		if c.Kit == nil {
			c.Kit = new(bool)
		}
		for _, mt := range e.Mounts {
			if mt.Destination == "/data/"+client && (roots[client] == "" || e.Labels[placeLabelRole] == "server") {
				roots[client] = filepath.Dir(filepath.Clean(mt.Source))
			}
		}
		running := e.State == "running"
		switch e.Labels[placeLabelRole] {
		case "server":
			c.Running, c.Image = running, e.Image
			*c.Kit = e.Labels[placeLabelKit] == "1"
			c.Port, _ = strconv.Atoi(e.Labels[placeLabelPort])
			for _, p := range e.Ports {
				if p.PrivatePort == 8000 && p.PublicPort > 0 {
					c.Port = p.PublicPort
				}
			}
		case "cleanup":
			c.Cleanup.Set, c.Cleanup.Running = true, running
			c.Cleanup.KeepWithinDays, _ = strconv.Atoi(e.Labels[placeLabelKeep])
			c.Cleanup.Keep = e.Labels[placeLabelKeepPolicy]
		}
	}
	for client, c := range byClient {
		root := roots[client]
		if root == "" {
			root = m.rootDir()
		}
		c.Location = m.locationOf(root)
		if c.Cleanup.Set {
			m.readCleanup(root, client, &c.Cleanup)
		}
		if n, ok := m.usedBytes(ctx, dataIn(root, client)); ok {
			c.UsedBytes = &n
		}
		bp.Clients = append(bp.Clients, *c)
	}
	sort.Slice(bp.Clients, func(i, j int) bool { return bp.Clients[i].Client < bp.Clients[j].Client })
	return bp
}

// readCleanup adds the cleanup's own report (<client>.cleanup.json).
func (m *placeManager) readCleanup(root, client string, c *proto.BackupPlaceCleanup) {
	b, err := os.ReadFile(stateFileIn(root, client, "cleanup.json"))
	if err != nil || len(b) > 64<<10 {
		return
	}
	var st placeCleanupStatus
	if json.Unmarshal(b, &st) != nil {
		return
	}
	if st.KeepWithinDays > 0 {
		c.KeepWithinDays = st.KeepWithinDays
	}
	c.Keep, c.OverLimit = st.Keep, st.OverLimit
	if st.LastRunAt != nil {
		if t, err := time.Parse(time.RFC3339, *st.LastRunAt); err == nil {
			t = t.UTC()
			c.LastRunAt = &t
		}
	}
	c.LastOK = st.LastOK
	c.LastError = firstLine(st.LastError, 300)
}

// usedBytes is a client's data folder size, measured at most every
// half hour (a walk over the repository's files).
func (m *placeManager) usedBytes(ctx context.Context, dir string) (uint64, bool) {
	m.sizeMu.Lock()
	s, ok := m.sizes[dir]
	m.sizeMu.Unlock()
	if ok && m.now().Sub(s.at) < placeSizeEvery {
		return s.bytes, true
	}
	wctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	n, err := dirSize(wctx, dir)
	if err != nil {
		return s.bytes, ok
	}
	m.sizeMu.Lock()
	m.sizes[dir] = placeSize{bytes: n, at: m.now()}
	m.sizeMu.Unlock()
	return n, true
}

// dirSize sums the disk blocks of a folder's files.
func dirSize(ctx context.Context, dir string) (uint64, error) {
	var total uint64
	err := filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		if st, ok := info.Sys().(*syscall.Stat_t); ok {
			total += uint64(st.Blocks) * 512
		} else {
			total += uint64(info.Size())
		}
		return nil
	})
	return total, err
}

// spaceOf is the free and total space of the file system path is on (or
// its nearest existing parent's).
func spaceOf(path string) (free, total uint64, ok bool) {
	for p := path; ; p = filepath.Dir(p) {
		var st syscall.Statfs_t
		if err := syscall.Statfs(p, &st); err == nil {
			// Unraid's /mnt/user is there only while the array runs; /mnt
			// and / are the RAM disk, which says nothing about its space.
			if strings.HasPrefix(path, "/mnt/user/") && (p == "/mnt" || p == "/") {
				return 0, 0, false
			}
			return st.Bavail * uint64(st.Bsize), st.Blocks * uint64(st.Bsize), true
		}
		if p == filepath.Dir(p) {
			return 0, 0, false
		}
	}
}

// ---- ensure --------------------------------------------------------------------------

// ensure makes or updates a client's REST server (docs/MANAGE.md 2.10)
// in the location asked for, moving its backups there when they are in
// another one (move).
func (m *placeManager) ensure(ctx context.Context, req *proto.PlaceRequest) (proto.PlaceResult, error) {
	if err := validatePlaceClient(req.Client); err != nil {
		return proto.PlaceResult{}, err
	}
	if n := len(req.RestPassword); n < proto.PlaceRestPasswordMin || n > proto.PlaceRestPasswordMax || !printableASCII(req.RestPassword) {
		return proto.PlaceResult{}, invalidField("rest_password", fmt.Sprintf("The password is %d to %d printable characters.",
			proto.PlaceRestPasswordMin, proto.PlaceRestPasswordMax))
	}
	if req.Port != 0 && (req.Port < 1024 || req.Port > 65535) {
		return proto.PlaceResult{}, invalidField("port", "The port is a number from 1024 to 65535, or 0 to choose one.")
	}
	if req.Location != "" && !proto.ValidPlaceLocation(req.Location) {
		return proto.PlaceResult{}, invalidField("location", "That isn’t a place on this server.")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if r := m.unsupportedReason(ctx); r != "" {
		return proto.PlaceResult{}, &placeUnsupported{reason: r}
	}
	client := req.Client
	name := m.serverName(client)
	cur, err := m.docker.inspectContainer(ctx, name)
	if err != nil {
		return proto.PlaceResult{}, err
	}
	from := ""
	if cur != nil {
		from = clientRoot(cur.HostConfig.Binds, client)
	}
	root := from
	if req.Location != "" {
		if root, err = m.locationRoot(req.Location); err != nil {
			return proto.PlaceResult{}, err
		}
	} else if root == "" {
		root = m.rootDir()
	}
	if from != "" && from != root {
		return m.move(ctx, req, cur, from, root)
	}
	// Only a move takes longer than the usual backup place budget.
	ctx, cancel := context.WithTimeout(ctx, proto.LongManageWait)
	defer cancel()
	if err := m.prepareRoot(ctx, root); err != nil {
		return proto.PlaceResult{}, err
	}
	port, err := m.install(ctx, client, root, req.RestPassword, req.Port, cur)
	if err != nil {
		return proto.PlaceResult{}, err
	}
	if err := m.refreshCleanup(ctx, root, client); err != nil {
		return proto.PlaceResult{}, err
	}
	return proto.PlaceResult{Client: client, Port: port, Addresses: m.addresses(), Path: dataIn(root, client), Created: cur == nil,
		Location: m.locationOf(root), Kit: true}, nil
}

// refreshCleanup makes a client's cleanup container again when the
// cleanup script it would run changed (an updated agent: the kit files'
// tidying), keeping its days and windows; one that is current, or no
// cleanup at all, is left as it is.
func (m *placeManager) refreshCleanup(ctx context.Context, root, client string) error {
	cl, err := m.docker.inspectContainer(ctx, m.cleanupName(client))
	if err != nil || cl == nil {
		return err
	}
	if clientRoot(cl.HostConfig.Binds, client) != filepath.Clean(root) {
		return nil
	}
	spec := m.cleanupSpec(root, client, keepFromLabels(cl.Config.Labels))
	if cl.Config.Labels[placeLabelConfig] == spec.Labels[placeLabelConfig] {
		return nil
	}
	return m.installCleanup(ctx, root, client, keepFromLabels(cl.Config.Labels))
}

// install makes or updates the client's REST server on a root: its data
// folder and the kit folder, its users, the image and the container (cur:
// the one there is), its Unraid template; it waits until the server
// answers.
func (m *placeManager) install(ctx context.Context, client, root, password string, wantPort int, cur *placeContainer) (int, error) {
	fsys := m.filesystem()
	if err := fsys.mkdirAll(ctx, dataIn(root, client), 0o700); err != nil {
		return 0, placeFSError("make the backup folder", err)
	}
	if err := fsys.mkdirAll(ctx, kitDirIn(root, client), 0o700); err != nil {
		return 0, placeFSError("make the backup folder", err)
	}
	htpasswd, err := m.writeHtpasswd(ctx, root, client, password)
	if err != nil {
		return 0, err
	}
	if err := m.ensureImage(ctx, m.restImage); err != nil {
		return 0, err
	}
	name := m.serverName(client)
	port, err := m.choosePort(ctx, wantPort, cur, name)
	if err != nil {
		return 0, err
	}
	spec := m.serverSpec(root, client, port, htpasswd)
	if err := m.apply(ctx, name, cur, spec); err != nil {
		return 0, err
	}
	if m.isUnraid() {
		if err := m.unraidTemplate(ctx, name, spec, port); err != nil {
			return 0, err
		}
	}
	if err := m.waitReady(ctx, name, port); err != nil {
		return 0, err
	}
	return port, nil
}

func validatePlaceClient(client string) error {
	if client == proto.PlaceKitUser {
		return invalidField("client", "“kit” is a name the backup app keeps for itself.")
	}
	if !proto.ValidPlaceClient(client) {
		return invalidField("client", "The name is 3 to 63 lower-case letters, digits and dashes.")
	}
	return nil
}

func printableASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < 0x20 || s[i] > 0x7e {
			return false
		}
	}
	return true
}

// placeFSError says which step on the server's disk failed.
func placeFSError(what string, err error) error {
	return codeErr(CodePlatformError, "Couldn’t "+what+" on this server: "+firstLine(err.Error(), 200))
}

// prepareRoot makes a root (the dedicated one on Unraid as its share, in
// another share the folder "whombat", 0700, the share left as it is), its
// state folder and the cleanup script.
func (m *placeManager) prepareRoot(ctx context.Context, root string) error {
	fsys := m.filesystem()
	mode := os.FileMode(0o755)
	if root == m.rootDir() {
		if m.isUnraid() {
			if _, err := m.ensureShare(ctx, proto.PlaceShareName, "Whombat’s backups", nil); err != nil {
				return err
			}
		}
	} else if m.isUnraid() {
		mode = 0o700
	}
	if st, err := os.Stat(root); err != nil || !st.IsDir() {
		if err := fsys.mkdirAll(ctx, root, mode); err != nil {
			return placeFSError("make the backups folder", err)
		}
	}
	if err := fsys.mkdirAll(ctx, stateDirIn(root), 0o700); err != nil {
		return placeFSError("make the backups folder", err)
	}
	script := filepath.Join(stateDirIn(root), placeCleanupFile)
	if b, err := os.ReadFile(script); err != nil || string(b) != placeCleanupScript {
		if err := fsys.writeFile(ctx, script, []byte(placeCleanupScript), 0o644); err != nil {
			return placeFSError("write the cleanup script", err)
		}
	}
	return nil
}

// writeHtpasswd writes the REST server's two users, the client and the
// kit user, keeping each bcrypt line that still matches its password; the
// file is written only when it changes. It returns the file's content.
func (m *placeManager) writeHtpasswd(ctx context.Context, root, client, password string) (string, error) {
	p := stateFileIn(root, client, "htpasswd")
	old, _ := os.ReadFile(p)
	have := map[string]string{}
	for _, line := range strings.Split(string(old), "\n") {
		if user, hash, ok := strings.Cut(strings.TrimSpace(line), ":"); ok {
			have[user] = hash
		}
	}
	line := func(user, pw string) (string, error) {
		if h := have[user]; h != "" && bcrypt.CompareHashAndPassword([]byte(h), []byte(pw)) == nil {
			return user + ":" + h + "\n", nil
		}
		hash, err := bcrypt.GenerateFromPassword([]byte(pw), bcrypt.DefaultCost)
		if err != nil {
			return "", invalidField("rest_password", "This password can’t be used: "+err.Error())
		}
		return user + ":" + string(hash) + "\n", nil
	}
	own, err := line(client, password)
	if err != nil {
		return "", err
	}
	kit, err := line(proto.PlaceKitUser, proto.PlaceKitPassword)
	if err != nil {
		return "", err
	}
	content := own + kit
	if content == string(old) {
		return content, nil
	}
	if err := m.filesystem().writeFile(ctx, p, []byte(content), 0o600); err != nil {
		return "", placeFSError("write the backup app’s user", err)
	}
	return content, nil
}

// ensureImage pulls a pinned image unless it is there.
func (m *placeManager) ensureImage(ctx context.Context, ref string) error {
	ok, err := m.docker.hasImage(ctx, ref)
	if err != nil {
		return err
	}
	if ok {
		return nil
	}
	pctx, cancel := context.WithTimeout(ctx, 4*time.Minute)
	defer cancel()
	return m.docker.pullImage(pctx, ref)
}

// choosePort is the REST server's host port: the asked one, the one it
// has, or the first free from 8747. A port is free when no other
// container publishes it and nothing listens on it.
func (m *placeManager) choosePort(ctx context.Context, want int, cur *placeContainer, name string) (int, error) {
	have := 0
	if cur != nil {
		have = cur.publishedPort(placeRestPort)
	}
	if want == 0 && have > 0 {
		return have, nil
	}
	if want > 0 && want == have {
		return want, nil
	}
	list, err := m.docker.listContainers(ctx, "")
	if err != nil {
		return 0, err
	}
	used := map[int]bool{}
	for _, e := range list {
		if len(e.Names) > 0 && strings.TrimPrefix(e.Names[0], "/") == name {
			continue
		}
		for _, p := range e.Ports {
			used[p.PublicPort] = true
		}
		if e.Labels[placeLabelService] == placeService {
			if n, err := strconv.Atoi(e.Labels[placeLabelPort]); err == nil {
				used[n] = true
			}
		}
	}
	if want > 0 {
		if used[want] || !m.portFree(want) {
			return 0, invalidField("port", fmt.Sprintf("Port %d is in use on this server.", want))
		}
		return want, nil
	}
	for p := proto.PlaceFirstPort; p < proto.PlaceFirstPort+200; p++ {
		if !used[p] && m.portFree(p) {
			return p, nil
		}
	}
	return 0, codeErr(CodePlatformError, "No free port from 8747 on this server.")
}

// portFree reports whether a TCP port can be bound on every address.
func portFree(port int) bool {
	l, err := net.Listen("tcp", ":"+strconv.Itoa(port))
	if err != nil {
		return false
	}
	_ = l.Close()
	return true
}

// baseLabels are the labels both containers of a client have.
func (m *placeManager) baseLabels(client, role string) map[string]string {
	l := map[string]string{placeLabelService: placeService, placeLabelClient: client, placeLabelRole: role}
	if m.isUnraid() {
		// Unraid's Docker page treats it as one of its own (a template).
		l["net.unraid.docker.managed"] = "dockerman"
	}
	for k, v := range m.labels {
		l[k] = v
	}
	return l
}

// serverSpec is the REST server's container on a root.
func (m *placeManager) serverSpec(root, client string, port int, htpasswd string) containerSpec {
	s := containerSpec{
		Image: m.restImage,
		// The image's own CMD is an entrypoint.sh with its own htpasswd
		// handling; the binary is started directly instead.
		Entrypoint: []string{"/usr/bin/rest-server"},
		Cmd: []string{"--path", "/data", "--listen", ":8000", "--append-only", "--private-repos",
			"--htpasswd-file", "/auth/.htpasswd"},
		User:         m.user,
		Labels:       m.baseLabels(client, "server"),
		ExposedPorts: map[string]struct{}{placeRestPort: {}},
	}
	s.Labels[placeLabelPort] = strconv.Itoa(port)
	if hasKitUser(htpasswd) {
		// Not so when a failed move puts back a server from before the kit
		// user: the next ensure adds it.
		s.Labels[placeLabelKit] = "1"
	}
	// The kit user's private repository is /kit/, so its folder is
	// /data/kit; it lives with the client's files in .whombat, which a move
	// carries along and the cleanup sees.
	s.HostConfig.Binds = []string{dataIn(root, client) + ":/data/" + client, stateFileIn(root, client, "htpasswd") + ":/auth/.htpasswd:ro",
		kitDirIn(root, client) + ":/data/" + proto.PlaceKitUser}
	// The image declares /data a volume: a small tmpfs there keeps Docker
	// from leaving an anonymous volume behind every container.
	s.HostConfig.Tmpfs = map[string]string{"/data": "size=1m,mode=0755"}
	s.HostConfig.PortBindings = map[string][]portBinding{placeRestPort: {{HostPort: strconv.Itoa(port)}}}
	s.HostConfig.RestartPolicy.Name = "unless-stopped"
	s.Labels[placeLabelConfig] = configHash(s, htpasswd)
	return s
}

// hasKitUser reports whether an htpasswd file has the kit user's line.
func hasKitUser(htpasswd string) bool {
	return strings.HasPrefix(htpasswd, proto.PlaceKitUser+":") || strings.Contains(htpasswd, "\n"+proto.PlaceKitUser+":")
}

// cleanupSpec is the cleanup's container on a root.
func (m *placeManager) cleanupSpec(root, client string, keep placeKeep) containerSpec {
	s := containerSpec{
		Image:      m.cleanupImage,
		Entrypoint: []string{"/bin/sh", "/state/" + placeCleanupFile},
		Cmd:        append([]string{client}, keep.args()...),
		Env:        []string{"TZ=UTC"},
		User:       m.user,
		Labels:     m.baseLabels(client, "cleanup"),
	}
	s.Labels[placeLabelKeep] = strconv.Itoa(keep.All)
	if keep.windows() {
		s.Labels[placeLabelKeepPolicy] = keep.label()
	}
	s.HostConfig.Binds = []string{dataIn(root, client) + ":/data/" + client, stateDirIn(root) + ":/state"}
	s.HostConfig.RestartPolicy.Name = "unless-stopped"
	s.HostConfig.NetworkMode = "none"
	s.Labels[placeLabelConfig] = configHash(s, placeCleanupScript)
	return s
}

// configHash is a short hash of a container's settings and the files it
// depends on.
func configHash(s containerSpec, extra string) string {
	b, _ := json.Marshal(s)
	h := sha256.Sum256(append(append([]byte(placeVersion+"\x00"), b...), extra...))
	return hex.EncodeToString(h[:8])
}

// apply creates the container, or recreates it when its settings
// changed, and starts it.
func (m *placeManager) apply(ctx context.Context, name string, cur *placeContainer, spec containerSpec) error {
	if cur != nil && cur.Config.Labels[placeLabelConfig] == spec.Labels[placeLabelConfig] {
		if cur.State.Running {
			return nil
		}
		return m.docker.startContainer(ctx, name)
	}
	if cur != nil {
		if err := m.docker.removeContainer(ctx, name); err != nil {
			return err
		}
	}
	if err := m.docker.createContainer(ctx, name, spec); err != nil {
		return err
	}
	return m.docker.startContainer(ctx, name)
}

// waitReady waits until the REST server answers HTTP on its port.
func (m *placeManager) waitReady(ctx context.Context, name string, port int) error {
	deadline := m.now().Add(m.readyWait)
	probe := m.probe
	if probe == nil {
		probe = httpAnswers
	}
	for {
		if probe(ctx, port) == nil {
			return nil
		}
		c, err := m.docker.inspectContainer(ctx, name)
		if err == nil && c != nil && !c.State.Running && c.State.Status == "exited" {
			return codeErr(CodePlatformError, fmt.Sprintf("The backup app stopped right after it started (exit code %d).", c.State.ExitCode))
		}
		if m.now().After(deadline) {
			return codeErr(CodeTimeout, "The backup app didn’t answer within a minute.")
		}
		select {
		case <-ctx.Done():
			return codeErr(CodeTimeout, "The backup app didn’t answer in time.")
		case <-time.After(m.poll):
		}
	}
}

// httpAnswers reports whether anything answers HTTP on the port (the
// REST server answers 401 without a user).
func httpAnswers(ctx context.Context, port int) error {
	client := &http.Client{Timeout: 2 * time.Second}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://127.0.0.1:"+strconv.Itoa(port)+"/", nil)
	if err != nil {
		return err
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

// ---- cleanup and remove --------------------------------------------------------------

// setCleanup writes the repository password and makes or updates the
// client's cleanup.
func (m *placeManager) setCleanup(ctx context.Context, req *proto.PlaceRequest) (proto.PlaceResult, error) {
	if err := validatePlaceClient(req.Client); err != nil {
		return proto.PlaceResult{}, err
	}
	pw := req.RepositoryPassword
	if pw == "" || len(pw) > proto.PlaceRepoPasswordMax || strings.ContainsAny(pw, "\r\n\x00") {
		return proto.PlaceResult{}, invalidField("repository_password", "Give the repository password (one line).")
	}
	keep := placeKeep{All: req.KeepWithinDays, Daily: req.KeepDailyDays, Weekly: req.KeepWeeklyDays,
		Monthly: req.KeepMonthlyMonths, Limit: req.LimitBytes}
	if keep.All == 0 {
		keep.All = proto.PlaceKeepDaysDefault
	}
	if err := keep.validate(); err != nil {
		return proto.PlaceResult{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if r := m.unsupportedReason(ctx); r != "" {
		return proto.PlaceResult{}, &placeUnsupported{reason: r}
	}
	client := req.Client
	c, err := m.docker.inspectContainer(ctx, m.serverName(client))
	if err != nil {
		return proto.PlaceResult{}, err
	} else if c == nil {
		return proto.PlaceResult{}, codeErr(proto.CodeNotFound, "This server doesn’t keep that Whombat’s backups yet: set the place up first.")
	}
	root := clientRoot(c.HostConfig.Binds, client)
	if root == "" {
		root = m.rootDir()
	}
	if err := m.prepareRoot(ctx, root); err != nil {
		return proto.PlaceResult{}, err
	}
	if err := m.filesystem().writeFile(ctx, stateFileIn(root, client, "pass"), []byte(pw), 0o600); err != nil {
		return proto.PlaceResult{}, placeFSError("store the repository password", err)
	}
	if err := m.installCleanup(ctx, root, client, keep); err != nil {
		return proto.PlaceResult{}, err
	}
	return proto.PlaceResult{Client: client, Set: true}, nil
}

// installCleanup makes or updates the client's cleanup container on a
// root (its password file is there already) and its Unraid template.
func (m *placeManager) installCleanup(ctx context.Context, root, client string, keep placeKeep) error {
	if err := m.ensureImage(ctx, m.cleanupImage); err != nil {
		return err
	}
	name := m.cleanupName(client)
	cur, err := m.docker.inspectContainer(ctx, name)
	if err != nil {
		return err
	}
	spec := m.cleanupSpec(root, client, keep)
	if err := m.apply(ctx, name, cur, spec); err != nil {
		return err
	}
	if m.isUnraid() {
		return m.unraidTemplate(ctx, name, spec, 0)
	}
	return nil
}

// remove takes a client's containers, templates and files away; its
// backups stay unless DeleteData.
func (m *placeManager) remove(ctx context.Context, req *proto.PlaceRequest) (proto.PlaceResult, error) {
	if err := validatePlaceClient(req.Client); err != nil {
		return proto.PlaceResult{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, err := m.docker.socketPath(); err != nil {
		return proto.PlaceResult{}, &placeUnsupported{reason: proto.PlaceNoDocker}
	}
	client := req.Client
	roots, err := m.clientRoots(ctx, client)
	if err != nil {
		return proto.PlaceResult{}, err
	}
	for _, name := range []string{m.cleanupName(client), m.serverName(client)} {
		if err := m.docker.removeContainer(ctx, name); err != nil {
			return proto.PlaceResult{}, err
		}
		if m.isUnraid() {
			if err := m.unraidForget(ctx, name); err != nil {
				return proto.PlaceResult{}, err
			}
		}
	}
	fsys := m.filesystem()
	for _, root := range roots {
		for _, ext := range []string{"htpasswd", "pass", "cleanup.json", "cleanup.json.tmp"} {
			if err := fsys.remove(ctx, stateFileIn(root, client, ext)); err != nil {
				return proto.PlaceResult{}, placeFSError("remove the backup app’s files", err)
			}
		}
		if req.DeleteData {
			dir := dataIn(root, client)
			if filepath.Dir(dir) != filepath.Clean(root) {
				return proto.PlaceResult{}, codeErr(CodeInvalid, "not a backup folder")
			}
			if err := fsys.removeAll(ctx, dir); err != nil {
				return proto.PlaceResult{}, placeFSError("delete the backups", err)
			}
			// The locked backup details go with the backups; without
			// delete_data they stay, as the backups do.
			if err := fsys.removeAll(ctx, kitDirIn(root, client)); err != nil {
				return proto.PlaceResult{}, placeFSError("delete the backups", err)
			}
		}
		m.sizeMu.Lock()
		delete(m.sizes, dataIn(root, client))
		m.sizeMu.Unlock()
	}
	return proto.PlaceResult{Client: client, Removed: true}, nil
}

// ---- the broker's side ---------------------------------------------------------------

// place returns the manager (created on first use).
func (b *Broker) place() *placeManager {
	b.placeOnce.Do(func() {
		if b.placeMgr == nil {
			b.placeMgr = newPlaceManager(b.unraid(), b.inventory)
		}
	})
	return b.placeMgr
}

// placeManage answers the backup place operations; ok is false for
// every other request.
func (b *Broker) placeManage(ctx context.Context, req proto.ManageRequest) (proto.ManageResponse, bool) {
	switch req.Op {
	case proto.OpPlaceEnsure, proto.OpPlaceCleanup, proto.OpPlaceRemove, proto.OpPlaceNFS:
	default:
		return proto.ManageResponse{}, false
	}
	if req.Place == nil {
		return proto.ManageResponse{Code: CodeInvalid, Message: "the request has no backup place values"}, true
	}
	m := b.place()
	var res proto.PlaceResult
	var err error
	switch req.Op {
	case proto.OpPlaceEnsure:
		res, err = m.ensure(ctx, req.Place)
	case proto.OpPlaceCleanup:
		res, err = m.setCleanup(ctx, req.Place)
	case proto.OpPlaceRemove:
		res, err = m.remove(ctx, req.Place)
	case proto.OpPlaceNFS:
		res, err = m.nfsShare(ctx, req.Place)
	}
	if err != nil {
		return placeFailure(err), true
	}
	return proto.ManageResponse{OK: true, Place: &res}, true
}

// placeFailure is the answer of a failed place operation.
func placeFailure(err error) proto.ManageResponse {
	var un *placeUnsupported
	if errors.As(err, &un) {
		return proto.ManageResponse{Code: CodeUnsupported, Message: un.Error(), Place: &proto.PlaceResult{Reason: un.reason}}
	}
	var fe *fieldError
	if errors.As(err, &fe) {
		return proto.ManageResponse{Code: proto.CodeInvalidValue, Message: fe.msg, FieldErrors: map[string]string{fe.field: fe.msg}}
	}
	code, msg := errCode(err, CodePlatformError)
	return proto.ManageResponse{Code: code, Message: msg}
}

// BackupPlaceReader reads this server's backup place for the report.
type BackupPlaceReader struct{ m *placeManager }

// NewBackupPlaceReader returns a reader with the real paths and socket.
func NewBackupPlaceReader() *BackupPlaceReader {
	return &BackupPlaceReader{m: newPlaceManager(newUnraidManager(""), nil)}
}

// Read returns the place (never nil); Addresses are left to the caller,
// which has the host's addresses.
func (r *BackupPlaceReader) Read(ctx context.Context) *proto.BackupPlace { return r.m.status(ctx) }

// placeKeep is what a cleanup keeps (HS-251, Whombat backup-options.md BKO-03, BKO-05): every backup of All days,
// one a day for Daily days, one a week for Weekly days, one a month for Monthly months (restic's --keep-within*
// windows, never counts), and the client's backups thinned oldest first while over Limit bytes (0 = none).
type placeKeep struct {
	All, Daily, Weekly, Monthly int
	Limit                       int64
}

// windows: more than the plain days (a cleanup from before had only those).
func (k placeKeep) windows() bool { return k.Daily > 0 || k.Weekly > 0 || k.Monthly > 0 || k.Limit > 0 }

func (k placeKeep) validate() error {
	minAll := proto.PlaceKeepDaysMin
	if k.Daily >= 7 {
		minAll = proto.PlaceKeepDaysMinWithDaily
	}
	if k.All < minAll || k.All > proto.PlaceKeepDaysMax {
		return invalidField("keep_within_days", fmt.Sprintf("Keep backups from %d to %d days.", minAll, proto.PlaceKeepDaysMax))
	}
	if k.Daily < 0 || k.Daily > proto.PlaceKeepDaysMax || k.Weekly < 0 || k.Weekly > proto.PlaceKeepDaysMax ||
		k.Monthly < 0 || k.Monthly > 240 {
		return invalidField("keep_daily_days", "Keep one a day, a week or a month for 0 to 3650 days (months: 0 to 240).")
	}
	if k.Limit != 0 && k.Limit < 1_000_000_000 {
		return invalidField("limit_bytes", "The limit is 0 (none) or at least 1 GB.")
	}
	return nil
}

// args are the cleanup script's arguments after the client: the days alone for a plain cleanup (what an older
// script also reads), else the days, the windows and the limit.
func (k placeKeep) args() []string {
	if !k.windows() {
		return []string{strconv.Itoa(k.All)}
	}
	return []string{strconv.Itoa(k.All), strconv.Itoa(k.Daily), strconv.Itoa(k.Weekly), strconv.Itoa(k.Monthly),
		strconv.FormatInt(k.Limit, 10)}
}

func (k placeKeep) label() string { return strings.Join(k.args(), ",") }

// keepFromLabels reads a cleanup container's keep back (a move rebuilds it).
func keepFromLabels(labels map[string]string) placeKeep {
	k := placeKeep{}
	k.All, _ = strconv.Atoi(labels[placeLabelKeep])
	if parts := strings.Split(labels[placeLabelKeepPolicy], ","); len(parts) == 5 {
		k.All, _ = strconv.Atoi(parts[0])
		k.Daily, _ = strconv.Atoi(parts[1])
		k.Weekly, _ = strconv.Atoi(parts[2])
		k.Monthly, _ = strconv.Atoi(parts[3])
		k.Limit, _ = strconv.ParseInt(parts[4], 10, 64)
	}
	if k.All == 0 {
		k.All = proto.PlaceKeepDaysDefault
	}
	return k
}
