// Package diskusage measures what fills a single mounted filesystem on request.
//
// It never runs on a schedule: it answers proto.StreamDiskUsage only when asked.
// It validates that the requested path is a real local mount, refuses mounts
// backed by spun-down disks without touching them, runs its walk on a low CPU
// and I/O priority thread, stays strictly on that one filesystem (never crosses
// mounts or follows symlinks), and bounds depth, entry count and wall time.
package diskusage

import (
	"context"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync/atomic"
	"time"

	"rackoon/internal/agent"
	"rackoon/internal/proto"
)

// Error codes returned in proto.DiskUsageResponse.Code.
const (
	CodeInvalid        = "invalid_request"
	CodeSpunDown       = "spun_down"
	CodeStandbyUnknown = "standby_unknown"
	CodeBusy           = "busy"
	CodeFailed         = "failed"
)

// Default and maximum bounds for one measurement.
const (
	DefaultMaxDepth   = 6
	MaxAllowedDepth   = 12
	DefaultTimeout    = 20 * time.Second
	MaxAllowedTimeout = 45 * time.Second
	DefaultMaxEntries = 250_000
	MaxSeenInodes     = 200_000
	MaxFolders        = 15
	MaxMountLen       = 512
)

// mountInfo describes one mounted filesystem known to the kernel.
type mountInfo struct {
	ID         int
	ParentID   int
	MajMin     string
	MountPoint string
	FSType     string
	Source     string
	Remote     bool
	Virtual    bool
}

// mountScope resolves path ownership against the active visible mount table
// using mountinfo mount IDs so probes and walks never touch another mount
// (including same-device bind mounts).
type mountScope struct {
	target      mountInfo
	visible     []mountInfo
	otherMounts map[string]bool
}

// fsStat is the usable capacity and used bytes of one filesystem (df style).
type fsStat struct {
	TotalBytes uint64
	UsedBytes  uint64
}

// Runner executes on-request disk usage measurements. At most one scan runs at
// a time so concurrent callers cannot pile disk I/O onto the host.
type Runner struct {
	inventory agent.InventoryFunc
	log       *slog.Logger
	busy      atomic.Bool

	// Seams for tests; New wires the real host implementations.
	root           string // optional filesystem prefix in tests ("" = host /)
	goos           string // optional OS override in tests ("" = runtime.GOOS)
	dockerSockets  []string
	listMounts     func() ([]mountInfo, error)
	statfs         func(path string) (fsStat, error)
	lstat          func(path string) (fs.FileInfo, error)
	readDir        func(logicalPath string) ([]fs.DirEntry, error)
	statMountID    func(logicalPath string) (uint64, bool)
	checkStandby   func(ctx context.Context, dev string) standbyState
	runCmd         func(ctx context.Context, name string, args ...string) ([]byte, error)
	now            func() time.Time
	maxEntries     int
	hangGrace      time.Duration
	setLowPriority func()
	isUnraid       func() bool
}

// New returns a disk usage runner wired for the live host.
func New(inv agent.InventoryFunc, log *slog.Logger) *Runner {
	if log == nil {
		log = slog.Default()
	}
	r := &Runner{
		inventory:      inv,
		log:            log,
		goos:           runtime.GOOS,
		dockerSockets:  []string{"/var/run/docker.sock", "/run/docker.sock", "/run/podman/podman.sock"},
		listMounts:     hostMounts,
		statfs:         hostStatfs,
		checkStandby:   hostDiskStandby,
		runCmd:         runLowPriorityCmd,
		now:            time.Now,
		maxEntries:     DefaultMaxEntries,
		setLowPriority: setThreadLowPriority,
	}
	r.isUnraid = r.detectUnraid
	return r
}

// DiskUsage implements agent.DiskUsage.
func (r *Runner) DiskUsage(ctx context.Context, req proto.DiskUsageRequest) proto.DiskUsageResponse {
	start := r.now().UTC()
	mount, err := validateMountPath(req.Mount)
	if err != nil {
		return proto.DiskUsageResponse{Code: CodeInvalid, Message: err.Error(), MeasuredAt: start}
	}
	if !r.busy.CompareAndSwap(false, true) {
		return proto.DiskUsageResponse{
			Code:       CodeBusy,
			Message:    "A disk usage check is already running on this host.",
			Mount:      mount,
			MeasuredAt: start,
		}
	}
	defer r.busy.Store(false)

	maxDepth := req.MaxDepth
	if maxDepth <= 0 {
		maxDepth = DefaultMaxDepth
	}
	if maxDepth > MaxAllowedDepth {
		maxDepth = MaxAllowedDepth
	}
	timeout := DefaultTimeout
	if req.TimeoutS > 0 {
		timeout = time.Duration(req.TimeoutS) * time.Second
		if timeout > MaxAllowedTimeout {
			timeout = MaxAllowedTimeout
		}
	}

	mounts, err := r.listMounts()
	if err != nil {
		return proto.DiskUsageResponse{
			Code:       CodeFailed,
			Message:    "Could not read the server's mounted filesystems.",
			Mount:      mount,
			MeasuredAt: start,
		}
	}

	scope, found := buildMountScope(mounts, mount)
	if !found {
		return proto.DiskUsageResponse{
			Code:       CodeInvalid,
			Message:    fmt.Sprintf("%s is not a mounted filesystem.", mount),
			Mount:      mount,
			MeasuredAt: start,
		}
	}
	target := scope.target
	if target.Remote {
		return proto.DiskUsageResponse{
			Code:       CodeInvalid,
			Message:    fmt.Sprintf("%s is a network mount and is not scanned.", mount),
			Mount:      mount,
			FSType:     target.FSType,
			Device:     target.Source,
			MeasuredAt: start,
		}
	}
	if target.Virtual && !(r.isUnraid() && target.FSType == "tmpfs" && mount == "/var/log") {
		return proto.DiskUsageResponse{
			Code:       CodeInvalid,
			Message:    fmt.Sprintf("%s is a virtual filesystem and is not scanned.", mount),
			Mount:      mount,
			FSType:     target.FSType,
			Device:     target.Source,
			MeasuredAt: start,
		}
	}

	wctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	// Check spun-down disks BEFORE touching the mount point at all, so sleeping
	// drives (or mounts whose backing devices, disk types or spin states cannot
	// be established) are never woken by a statfs or directory read.
	if check := r.spunDownDisksFor(wctx, mount, target); check.shouldSkip() {
		sort.Strings(check.spun)
		sort.Strings(check.unknown)
		sort.Strings(check.unknownRotational)
		return proto.DiskUsageResponse{
			Code:            check.code(),
			Message:         formatStandbySkipMessage(mount, check),
			Mount:           mount,
			FSType:          target.FSType,
			Device:          target.Source,
			MeasuredAt:      start,
			DurationMs:      r.now().UTC().Sub(start).Milliseconds(),
			SkippedSpunDown: check.spun,
		}
	}

	hostPath := r.hostPath(mount)

	// Run the entire mount probe and scan on a dedicated OS thread at lowest CPU
	// and I/O priority, and select on wctx.Done() so a hung filesystem read
	// never wedges this request or leaves r.busy stuck.
	// Keeping the goroutine locked when it exits tells the Go runtime to
	// retire the lowered-priority thread instead of reusing it for normal work.
	type scanOut struct {
		errCode    string
		errMsg     string
		totalBytes uint64
		usedBytes  uint64
		walk       walkResult
		categories []proto.DiskUsageCategory
		catPartial bool
	}
	done := make(chan scanOut, 1)
	go func() {
		runtime.LockOSThread()
		if r.setLowPriority != nil {
			r.setLowPriority()
		}
		rootInfo, err := r.doLstat(hostPath)
		if err != nil {
			done <- scanOut{errCode: CodeFailed, errMsg: fmt.Sprintf("Could not read %s.", mount)}
			return
		}
		rootDev, ok := statDev(rootInfo)
		if !ok {
			done <- scanOut{errCode: CodeFailed, errMsg: fmt.Sprintf("Could not identify the filesystem device for %s.", mount)}
			return
		}
		var rootMntID uint64
		if id, ok := r.mountIDAt(mount, 0, false); ok {
			rootMntID = id
		}

		var totalBytes, usedBytes uint64
		if st, err := r.statfs(hostPath); err == nil {
			totalBytes, usedBytes = st.TotalBytes, st.UsedBytes
		}

		// Give specialised category probes up to 40% of the budget (at least 4s)
		// so container/ZFS queries finish even on huge filesystems, then spend the
		// rest walking folders.
		catBudget := timeout * 2 / 5
		if catBudget < 4*time.Second {
			catBudget = min(4*time.Second, timeout)
		}
		cctx, ccancel := context.WithTimeout(wctx, catBudget)
		cats, catPartial := r.collectCategories(cctx, scope, rootDev, rootMntID)
		ccancel()

		w := r.walkMount(wctx, scope, rootDev, rootMntID, maxDepth)
		done <- scanOut{
			totalBytes: totalBytes,
			usedBytes:  usedBytes,
			walk:       w,
			categories: cats,
			catPartial: catPartial,
		}
	}()

	var res scanOut
	timedOut := false
	select {
	case res = <-done:
	case <-wctx.Done():
		// Give the worker a short grace window to unwind and return partial
		// results already collected, while refusing to wedge if a syscall hangs.
		grace := r.hangGrace
		if grace <= 0 {
			grace = 500 * time.Millisecond
		}
		timer := time.NewTimer(grace)
		select {
		case res = <-done:
			timer.Stop()
		case <-timer.C:
			timedOut = true
		}
	}

	finished := r.now().UTC()
	durMs := finished.Sub(start).Milliseconds()
	if durMs < 0 {
		durMs = 0
	}

	if timedOut {
		return proto.DiskUsageResponse{
			Code:       CodeFailed,
			Message:    fmt.Sprintf("Timed out while reading %s.", mount),
			Mount:      mount,
			FSType:     target.FSType,
			Device:     target.Source,
			MeasuredAt: finished,
			DurationMs: durMs,
			Partial:    true,
		}
	}
	if res.errCode != "" {
		return proto.DiskUsageResponse{
			Code:       res.errCode,
			Message:    res.errMsg,
			Mount:      mount,
			FSType:     target.FSType,
			Device:     target.Source,
			MeasuredAt: finished,
			DurationMs: durMs,
		}
	}

	return proto.DiskUsageResponse{
		Mount:      mount,
		FSType:     target.FSType,
		Device:     target.Source,
		MeasuredAt: finished,
		DurationMs: durMs,
		TotalBytes: res.totalBytes,
		UsedBytes:  res.usedBytes,
		Partial:    res.walk.partial || res.catPartial,
		Categories: res.categories,
		Folders:    res.walk.folders,
	}
}

func validateMountPath(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", fmt.Errorf("mount is required")
	}
	if len(s) > MaxMountLen {
		return "", fmt.Errorf("mount path is too long")
	}
	for _, c := range s {
		if c == 0 || c == '\n' || c == '\r' || c < 0x20 {
			return "", fmt.Errorf("mount path contains control characters")
		}
	}
	if !strings.HasPrefix(s, "/") {
		return "", fmt.Errorf("mount must be an absolute path")
	}
	cleaned := filepath.Clean(s)
	// Reject path traversal segments explicitly.
	for _, seg := range strings.Split(s, "/") {
		if seg == ".." {
			return "", fmt.Errorf("mount path must not contain ..")
		}
	}
	return cleaned, nil
}

func (r *Runner) isDarwin() bool {
	if r.goos != "" {
		return r.goos == "darwin"
	}
	return runtime.GOOS == "darwin"
}

func (r *Runner) hostPath(p string) string {
	if r.root == "" {
		return p
	}
	return filepath.Join(r.root, filepath.FromSlash(strings.TrimPrefix(p, "/")))
}

func (r *Runner) detectUnraid() bool {
	if r.inventory != nil {
		if rep := r.inventory(); rep != nil && rep.Unraid != nil {
			return true
		}
	}
	if _, err := os.Stat(r.hostPath("/etc/unraid-version")); err == nil {
		return true
	}
	if _, err := os.Stat(r.hostPath("/var/local/emhttp/disks.ini")); err == nil {
		return true
	}
	return false
}

func (r *Runner) doLstat(path string) (fs.FileInfo, error) {
	if r.lstat != nil {
		return r.lstat(path)
	}
	return os.Lstat(path)
}

func buildMountScope(mounts []mountInfo, targetMount string) (mountScope, bool) {
	if len(mounts) == 0 {
		return mountScope{}, false
	}
	norm := make([]mountInfo, len(mounts))
	maxID := 0
	for i, m := range mounts {
		m.MountPoint = filepath.Clean(m.MountPoint)
		if m.ID > maxID {
			maxID = m.ID
		}
		norm[i] = m
	}
	for i := range norm {
		if norm[i].ID == 0 {
			maxID++
			norm[i].ID = maxID
		}
	}

	byID := make(map[int]mountInfo, len(norm))
	lastByMP := make(map[string]int, len(norm))
	for _, m := range norm {
		byID[m.ID] = m
		lastByMP[m.MountPoint] = m.ID
	}

	covered := map[int]bool{}
	for _, m := range norm {
		if m.ParentID != 0 {
			if p, ok := byID[m.ParentID]; ok && p.ID != m.ID && p.MountPoint == m.MountPoint {
				covered[p.ID] = true
			}
		}
		if lastByMP[m.MountPoint] != m.ID {
			covered[m.ID] = true
		}
	}

	hidden := func(m mountInfo) bool {
		if covered[m.ID] {
			return true
		}
		cur := m
		for depth := 0; depth < 64; depth++ {
			if cur.ParentID == 0 {
				return false
			}
			p, ok := byID[cur.ParentID]
			if !ok || p.ID == cur.ID {
				return false
			}
			if covered[p.ID] && p.MountPoint != cur.MountPoint {
				return true
			}
			cur = p
		}
		return false
	}

	visible := make([]mountInfo, 0, len(norm))
	var target mountInfo
	found := false
	for _, m := range norm {
		if hidden(m) {
			continue
		}
		visible = append(visible, m)
		if m.MountPoint == targetMount {
			target = m
			found = true
		}
	}
	if !found {
		return mountScope{}, false
	}

	otherMounts := map[string]bool{}
	for _, m := range visible {
		if m.ID == target.ID {
			continue
		}
		if hasPathPrefix(m.MountPoint, target.MountPoint) {
			otherMounts[m.MountPoint] = true
		}
	}
	return mountScope{
		target:      target,
		visible:     visible,
		otherMounts: otherMounts,
	}, true
}

func (s mountScope) ownerMount(logicalPath string) (mountInfo, bool) {
	p := filepath.Clean(logicalPath)
	if !strings.HasPrefix(p, "/") {
		return mountInfo{}, false
	}
	var best mountInfo
	bestLen := -1
	for _, m := range s.visible {
		if hasPathPrefix(p, m.MountPoint) && len(m.MountPoint) > bestLen {
			best = m
			bestLen = len(m.MountPoint)
		}
	}
	return best, bestLen >= 0
}

func (s mountScope) containsPath(logicalPath string) bool {
	p := filepath.Clean(logicalPath)
	if !strings.HasPrefix(p, "/") {
		return false
	}
	if !hasPathPrefix(p, s.target.MountPoint) {
		return false
	}
	if s.target.MountPoint == "/" {
		for vr := range virtualRoots {
			if hasPathPrefix(p, vr) {
				return false
			}
		}
	}
	owner, ok := s.ownerMount(p)
	return ok && owner.ID == s.target.ID
}

func (s mountScope) isOtherMount(logicalPath string) bool {
	p := filepath.Clean(logicalPath)
	if s.otherMounts[p] {
		return true
	}
	if s.target.MountPoint == "/" && virtualRoots[p] {
		return true
	}
	return !s.containsPath(p)
}

func hasPathPrefix(p, prefix string) bool {
	if prefix == "/" {
		return strings.HasPrefix(p, "/")
	}
	return p == prefix || strings.HasPrefix(p, prefix+"/")
}

func formatDiskList(disks []string) string {
	switch len(disks) {
	case 0:
		return "a backing disk is"
	case 1:
		return disks[0] + " is"
	case 2:
		return disks[0] + " and " + disks[1] + " are"
	default:
		return strings.Join(disks[:len(disks)-1], ", ") + " and " + disks[len(disks)-1] + " are"
	}
}

func formatDiskNames(disks []string) string {
	switch len(disks) {
	case 0:
		return "a backing disk"
	case 1:
		return disks[0]
	case 2:
		return disks[0] + " and " + disks[1]
	default:
		return strings.Join(disks[:len(disks)-1], ", ") + " and " + disks[len(disks)-1]
	}
}

func formatStandbySkipMessage(mount string, check standbyCheckResult) string {
	var reasons []string
	if len(check.spun) > 0 {
		reasons = append(reasons, fmt.Sprintf("%s spun down", formatDiskList(check.spun)))
	}
	if len(check.unknown) > 0 {
		reasons = append(reasons, fmt.Sprintf("the spin state of %s could not be checked", formatDiskNames(check.unknown)))
	}
	if len(check.unknownRotational) > 0 {
		reasons = append(reasons, fmt.Sprintf("the disk type of %s could not be checked", formatDiskNames(check.unknownRotational)))
	}
	if check.partialBacking {
		reasons = append(reasons, "not all of its backing disks could be identified")
	} else if check.unknownBacking {
		reasons = append(reasons, "its backing disks could not be identified")
	}
	if len(check.spun) > 0 {
		return fmt.Sprintf("Skipped %s because %s; sleeping disks are not woken.", mount, strings.Join(reasons, " and "))
	}
	if len(reasons) == 0 {
		return fmt.Sprintf("Skipped %s because Whombat cannot tell whether its backing disks are asleep.", mount)
	}
	// Single-reason disk messages read more naturally with "it is" / "they are".
	if len(reasons) == 1 && len(check.unknown) > 0 {
		pronoun := "it is"
		if len(check.unknown) > 1 {
			pronoun = "they are"
		}
		return fmt.Sprintf("Skipped %s because %s, so Whombat cannot tell whether %s asleep.", mount, reasons[0], pronoun)
	}
	if len(reasons) == 1 && len(check.unknownRotational) > 0 {
		pronoun := "it is"
		if len(check.unknownRotational) > 1 {
			pronoun = "they are"
		}
		return fmt.Sprintf("Skipped %s because %s, so Whombat cannot tell whether %s asleep.", mount, reasons[0], pronoun)
	}
	return fmt.Sprintf("Skipped %s because %s, so Whombat cannot tell whether a disk is asleep.", mount, strings.Join(reasons, " and "))
}
