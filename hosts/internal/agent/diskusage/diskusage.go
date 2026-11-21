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
	CodeInvalid  = "invalid_request"
	CodeSpunDown = "spun_down"
	CodeBusy     = "busy"
	CodeFailed   = "failed"
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
	MountPoint string
	FSType     string
	Source     string
	Remote     bool
	Virtual    bool
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
	dockerSockets  []string
	listMounts     func() ([]mountInfo, error)
	statfs         func(path string) (fsStat, error)
	checkStandby   func(ctx context.Context, dev string) bool
	runCmd         func(ctx context.Context, name string, args ...string) ([]byte, error)
	now            func() time.Time
	maxEntries     int
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

	target, found := findMount(mounts, mount)
	if !found {
		return proto.DiskUsageResponse{
			Code:       CodeInvalid,
			Message:    fmt.Sprintf("%s is not a mounted filesystem.", mount),
			Mount:      mount,
			MeasuredAt: start,
		}
	}
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
	// drives are never woken by a statfs or directory read.
	if spun := r.spunDownDisksFor(wctx, mount, target); len(spun) > 0 {
		sort.Strings(spun)
		return proto.DiskUsageResponse{
			Code:            CodeSpunDown,
			Message:         fmt.Sprintf("Skipped %s because %s spun down; sleeping disks are not woken.", mount, formatDiskList(spun)),
			Mount:           mount,
			FSType:          target.FSType,
			Device:          target.Source,
			MeasuredAt:      start,
			DurationMs:      r.now().UTC().Sub(start).Milliseconds(),
			SkippedSpunDown: spun,
		}
	}

	hostPath := r.hostPath(mount)
	rootInfo, err := os.Lstat(hostPath)
	if err != nil {
		return proto.DiskUsageResponse{
			Code:       CodeFailed,
			Message:    fmt.Sprintf("Could not read %s.", mount),
			Mount:      mount,
			FSType:     target.FSType,
			Device:     target.Source,
			MeasuredAt: start,
			DurationMs: r.now().UTC().Sub(start).Milliseconds(),
		}
	}
	rootDev, ok := statDev(rootInfo)
	if !ok {
		return proto.DiskUsageResponse{
			Code:       CodeFailed,
			Message:    fmt.Sprintf("Could not identify the filesystem device for %s.", mount),
			Mount:      mount,
			FSType:     target.FSType,
			Device:     target.Source,
			MeasuredAt: start,
			DurationMs: r.now().UTC().Sub(start).Milliseconds(),
		}
	}

	var totalBytes, usedBytes uint64
	if st, err := r.statfs(hostPath); err == nil {
		totalBytes, usedBytes = st.TotalBytes, st.UsedBytes
	}

	// Build the set of other mount points beneath this mount so the walker skips
	// them without even calling Lstat (which could wake a sleeping disk or stall
	// on an unresponsive network mount).
	otherMounts := childMountSet(mounts, mount)

	// Run the scan on a dedicated OS thread at lowest CPU and I/O priority.
	// Keeping the goroutine locked when it exits tells the Go runtime to
	// retire the lowered-priority thread instead of reusing it for normal work.
	type scanOut struct {
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
		// Give specialised category probes up to 40% of the budget (at least 4s)
		// so container/ZFS queries finish even on huge filesystems, then spend the
		// rest walking folders.
		catBudget := timeout * 2 / 5
		if catBudget < 4*time.Second {
			catBudget = min(4*time.Second, timeout)
		}
		cctx, ccancel := context.WithTimeout(wctx, catBudget)
		cats, catPartial := r.collectCategories(cctx, mount, target, rootDev, otherMounts)
		ccancel()

		w := r.walkMount(wctx, mount, rootDev, maxDepth, otherMounts)
		done <- scanOut{walk: w, categories: cats, catPartial: catPartial}
	}()

	res := <-done
	finished := r.now().UTC()
	durMs := finished.Sub(start).Milliseconds()
	if durMs < 0 {
		durMs = 0
	}

	return proto.DiskUsageResponse{
		Mount:      mount,
		FSType:     target.FSType,
		Device:     target.Source,
		MeasuredAt: finished,
		DurationMs: durMs,
		TotalBytes: totalBytes,
		UsedBytes:  usedBytes,
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

func findMount(mounts []mountInfo, target string) (mountInfo, bool) {
	// If several entries share the same mountpoint (overmounts), the last one
	// in mountinfo is the active mount on top.
	var matched mountInfo
	found := false
	for _, m := range mounts {
		if filepath.Clean(m.MountPoint) == target {
			matched = m
			found = true
		}
	}
	return matched, found
}

func childMountSet(mounts []mountInfo, target string) map[string]bool {
	out := map[string]bool{}
	for _, m := range mounts {
		mp := filepath.Clean(m.MountPoint)
		if mp == target {
			continue
		}
		if hasPathPrefix(mp, target) {
			out[mp] = true
		}
	}
	return out
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
