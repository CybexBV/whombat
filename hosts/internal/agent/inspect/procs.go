// Package inspect builds the host's on-demand views for the inspect RPC
// (proto.InspectProcesses, proto.InspectPorts) straight from /proc, without
// external tools.
package inspect

import (
	"bufio"
	"bytes"
	"context"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"rackoon/internal/proto"
)

// Row limits.
const (
	DefaultProcesses = 100
	MaxProcesses     = 500
	maxCommand       = 512
)

// clockTicks is USER_HZ, 100 on every Linux architecture Go supports here
// (amd64, arm64).
const clockTicks = 100

// ProcOptions configures Processes.
type ProcOptions struct {
	Root     string        // procfs mount, default "/proc"
	Passwd   string        // default "/etc/passwd"
	Interval time.Duration // CPU sampling interval, default 1 s
	Limit    int           // rows, default DefaultProcesses, at most MaxProcesses
	// Container maps a process's cgroup to its guest ("docker:web"); nil
	// uses ContainerOf without name resolution.
	Container func(cgroup string) string
}

type procStat struct {
	pid, ppid int
	comm      string
	state     string
	ticks     uint64 // utime + stime
	threads   int
	start     uint64 // clock ticks after boot
	rssPages  uint64
}

// parseStat parses /proc/<pid>/stat. The command name may contain spaces
// and parentheses: it runs from the first '(' to the last ')'.
func parseStat(b []byte) (procStat, bool) {
	var s procStat
	open := bytes.IndexByte(b, '(')
	end := bytes.LastIndexByte(b, ')')
	if open < 0 || end < open || end+2 > len(b) {
		return s, false
	}
	pid, err := strconv.Atoi(string(bytes.TrimSpace(b[:open])))
	if err != nil {
		return s, false
	}
	s.pid = pid
	s.comm = string(b[open+1 : end])
	f := strings.Fields(string(b[end+2:]))
	// f[0] = field 3 (state); field n is f[n-3].
	if len(f) < 22 {
		return s, false
	}
	s.state = f[0]
	s.ppid, _ = strconv.Atoi(f[1])
	ut, _ := strconv.ParseUint(f[11], 10, 64)
	st, _ := strconv.ParseUint(f[12], 10, 64)
	s.ticks = ut + st
	s.threads, _ = strconv.Atoi(f[17])
	s.start, _ = strconv.ParseUint(f[19], 10, 64)
	s.rssPages, _ = strconv.ParseUint(f[21], 10, 64)
	return s, true
}

func readStats(root string) (map[int]procStat, error) {
	ents, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	out := make(map[int]procStat, len(ents))
	for _, e := range ents {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid <= 0 {
			continue
		}
		b, err := os.ReadFile(filepath.Join(root, e.Name(), "stat"))
		if err != nil {
			continue // exited
		}
		if s, ok := parseStat(b); ok {
			out[pid] = s
		}
	}
	return out, nil
}

// bootTime reads btime from <root>/stat.
func bootTime(root string) time.Time {
	f, err := os.Open(filepath.Join(root, "stat"))
	if err != nil {
		return time.Time{}
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		if v, ok := strings.CutPrefix(sc.Text(), "btime "); ok {
			if n, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64); err == nil {
				return time.Unix(n, 0).UTC()
			}
		}
	}
	return time.Time{}
}

// Processes returns the processes using the most CPU over opts.Interval
// (percent of one core), then by memory. truncated is set when more
// processes exist than the limit.
func Processes(ctx context.Context, opts ProcOptions) (rows []proto.Process, truncated bool, err error) {
	root := opts.Root
	if root == "" {
		root = "/proc"
	}
	limit := opts.Limit
	if limit <= 0 {
		limit = DefaultProcesses
	}
	if limit > MaxProcesses {
		limit = MaxProcesses
	}
	interval := opts.Interval
	if interval <= 0 {
		interval = time.Second
	}
	first, err := readStats(root)
	if err != nil {
		return nil, false, err
	}
	t0 := time.Now()
	select {
	case <-ctx.Done():
		return nil, false, ctx.Err()
	case <-time.After(interval):
	}
	second, err := readStats(root)
	if err != nil {
		return nil, false, err
	}
	elapsed := time.Since(t0).Seconds()
	type row struct {
		s   procStat
		cpu float64
	}
	all := make([]row, 0, len(second))
	for pid, s := range second {
		delta := s.ticks
		// A process missing from the first sample (or a reused pid) started
		// during the interval: all its CPU time falls into it.
		if p, ok := first[pid]; ok && p.start == s.start && s.ticks >= p.ticks {
			delta = s.ticks - p.ticks
		}
		cpu := float64(delta) / clockTicks / elapsed * 100
		all = append(all, row{s, float64(int64(cpu*10+0.5)) / 10})
	}
	sort.Slice(all, func(i, j int) bool {
		if all[i].cpu != all[j].cpu {
			return all[i].cpu > all[j].cpu
		}
		if all[i].s.rssPages != all[j].s.rssPages {
			return all[i].s.rssPages > all[j].s.rssPages
		}
		return all[i].s.pid < all[j].s.pid
	})
	if len(all) > limit {
		all, truncated = all[:limit], true
	}
	users := loadUsers(opts.Passwd)
	boot := bootTime(root)
	page := uint64(os.Getpagesize())
	container := opts.Container
	if container == nil {
		container = func(cg string) string {
			if p, id := ContainerOf(cg); p != "" {
				return p + ":" + id
			}
			return ""
		}
	}
	rows = make([]proto.Process, 0, len(all))
	for _, r := range all {
		dir := filepath.Join(root, strconv.Itoa(r.s.pid))
		p := proto.Process{
			PID:      r.s.pid,
			PPID:     r.s.ppid,
			Name:     r.s.comm,
			CPUPct:   r.cpu,
			RSSBytes: r.s.rssPages * page,
			State:    r.s.state,
			Threads:  r.s.threads,
		}
		if !boot.IsZero() {
			p.Started = boot.Add(time.Duration(r.s.start) * (time.Second / clockTicks))
		}
		p.Command = readCmdline(filepath.Join(dir, "cmdline"))
		if p.Command == "" {
			p.Command = "[" + r.s.comm + "]" // kernel thread or zombie
		}
		if uid, ok := readUID(filepath.Join(dir, "status")); ok {
			p.User = users.name(uid)
		}
		if cg, err := os.ReadFile(filepath.Join(dir, "cgroup")); err == nil {
			p.Container = container(string(cg))
		}
		rows = append(rows, p)
	}
	return rows, truncated, nil
}

// readCmdline returns the command line with NULs as spaces, at most
// maxCommand bytes (cut at a UTF-8 boundary).
func readCmdline(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	buf := make([]byte, maxCommand+1)
	n, _ := f.Read(buf)
	b := bytes.TrimRight(buf[:n], "\x00")
	for i := range b {
		if b[i] == 0 || b[i] == '\n' || b[i] == '\t' {
			b[i] = ' '
		}
	}
	if len(b) > maxCommand {
		b = b[:maxCommand]
		for len(b) > 0 && !utf8.Valid(b) {
			b = b[:len(b)-1]
		}
	}
	return strings.ToValidUTF8(string(b), "?")
}

// readUID returns the effective uid from /proc/<pid>/status.
func readUID(path string) (int, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	for _, line := range strings.Split(string(b), "\n") {
		if v, ok := strings.CutPrefix(line, "Uid:"); ok {
			f := strings.Fields(v)
			if len(f) >= 2 {
				uid, err := strconv.Atoi(f[1])
				return uid, err == nil
			}
		}
	}
	return 0, false
}

// users maps uids to names from /etc/passwd, cached until the file changes.
type userMap map[int]string

func (m userMap) name(uid int) string {
	if n, ok := m[uid]; ok {
		return n
	}
	return strconv.Itoa(uid)
}

var passwdCache struct {
	sync.Mutex
	path  string
	mtime time.Time
	users userMap
}

func loadUsers(path string) userMap {
	if path == "" {
		path = "/etc/passwd"
	}
	fi, err := os.Stat(path)
	if err != nil {
		return userMap{0: "root"}
	}
	c := &passwdCache
	c.Lock()
	defer c.Unlock()
	if c.users != nil && c.path == path && c.mtime.Equal(fi.ModTime()) {
		return c.users
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return userMap{0: "root"}
	}
	m := userMap{}
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.SplitN(line, ":", 4)
		if len(f) < 3 || strings.HasPrefix(f[0], "#") {
			continue
		}
		if uid, err := strconv.Atoi(f[2]); err == nil {
			if _, dup := m[uid]; !dup {
				m[uid] = f[0]
			}
		}
	}
	c.path, c.mtime, c.users = path, fi.ModTime(), m
	return m
}

var (
	reDockerScope = regexp.MustCompile(`(?:^|/)(?:docker|libpod)-([0-9a-f]{64})\.scope(?:/|$)`)
	reDockerPath  = regexp.MustCompile(`(?:^|/)(?:docker|libpod)/([0-9a-f]{64})(?:/|$)`)
	reIncus       = regexp.MustCompile(`(?:^|/)lxc\.payload\.([^/]+)(?:/|$)`)
	rePVELXC      = regexp.MustCompile(`(?:^|/)lxc/([1-9][0-9]{2,8})(?:/|$)`)
	rePVEQEMU     = regexp.MustCompile(`(?:^|/)qemu\.slice/([1-9][0-9]{2,8})\.scope(?:/|$)`)
	reLibvirt     = regexp.MustCompile(`(?:^|/)machine-qemu\\x2d[0-9]+\\x2d([^/]+)\.scope(?:/|$)`)
	reLibvirtFS   = regexp.MustCompile(`(?:^|/)qemu-[0-9]+-([^/]+)\.libvirt-qemu(?:/|$)`) // cgroupfs (no systemd: Unraid)
)

// ContainerOf finds the guest a process belongs to from the contents of
// /proc/<pid>/cgroup: ("docker", <container id>), ("incus", <name>, with
// "project_name" outside the default project), ("pve", <vmid>) for LXC and
// QEMU, ("libvirt", <domain name, possibly truncated by systemd>), or
// ("", "") for host processes.
func ContainerOf(cgroup string) (platform, id string) {
	for _, line := range strings.Split(cgroup, "\n") {
		// "0::/system.slice/docker-<id>.scope" (v2) or "4:memory:/docker/<id>" (v1).
		parts := strings.SplitN(line, ":", 3)
		if len(parts) != 3 {
			continue
		}
		path := parts[2]
		switch {
		case reDockerScope.MatchString(path):
			return "docker", reDockerScope.FindStringSubmatch(path)[1]
		case reDockerPath.MatchString(path):
			return "docker", reDockerPath.FindStringSubmatch(path)[1]
		case reIncus.MatchString(path):
			return "incus", reIncus.FindStringSubmatch(path)[1]
		case rePVELXC.MatchString(path):
			return "pve", rePVELXC.FindStringSubmatch(path)[1]
		case rePVEQEMU.MatchString(path):
			return "pve", rePVEQEMU.FindStringSubmatch(path)[1]
		case reLibvirt.MatchString(path):
			return "libvirt", strings.ReplaceAll(reLibvirt.FindStringSubmatch(path)[1], `\x2d`, "-")
		case reLibvirtFS.MatchString(path):
			return "libvirt", reLibvirtFS.FindStringSubmatch(path)[1]
		}
	}
	return "", ""
}
