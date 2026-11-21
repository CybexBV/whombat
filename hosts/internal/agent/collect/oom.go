package collect

import (
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/unix"

	"rackoon/internal/agent/inspect"
	"rackoon/internal/agent/services"
	"rackoon/internal/proto"
)

// Out-of-memory kills: the machine's or a cgroup's own limit (LM-04).
//
// /proc/vmstat's oom_kill counts every kill of the kernel's OOM killer,
// also those inside a container's own memory limit while the machine has
// plenty free. The kernel's log says which it was: every kill prints
// "<why>: Killed process <pid> (<name>) …", where <why> is "Memory cgroup
// out of memory" when a cgroup reached its limit (constraint
// CONSTRAINT_MEMCG) and "Out of memory" when the machine, a NUMA node or a
// cpuset ran out. That line is never rate-limited and comes once per
// vmstat increment. Just before it, the rate-limited summary
// "oom-kill:constraint=…,oom_memcg=<cgroup at its limit>,task_memcg=…,
// task=<name>,pid=<pid>,uid=…" names the cgroup.
//
// The agent reads the log from /dev/kmsg where it may (OpenRC, SysV,
// Unraid, an agent started by hand), else from the journal (journalctl
// -k): the systemd unit's sandbox (ProtectKernelLogs=yes) hides /dev/kmsg
// but not the journal, so no unit change is needed. Comparing vmstat with
// the cgroups' memory.events instead cannot tell a machine-wide kill of a
// process inside a container from a kill at its limit (memory.events'
// oom_kill counts both).
//
// A kill the agent does not see in the log counts as the machine's
// (OOMLimitKills only counts what it saw), so a missing log keeps today's
// warning. vmstat is read before the log and the count is clamped to it,
// so the limit count never runs ahead of the total.

const (
	oomRecentFor   = time.Hour        // SystemInfo.OOMLimited covers this long
	oomContextGap  = 10 * time.Second // a summary or oom.group line belongs to a kill this close
	oomSettleTries = 3                // reads more while the log lags behind vmstat
	oomReopenAfter = 10 * time.Minute // retry a kernel log that could not be opened
	kmsgMaxRecords = 1 << 20          // bound of one /dev/kmsg read
)

// oomSettleWait is the pause between those reads (tests shorten it).
var oomSettleWait = time.Second

// kernelMsg is one kernel log message.
type kernelMsg struct {
	at   time.Time
	text string
}

// kernelLog is a source of kernel messages.
type kernelLog interface {
	// read returns the OOM killer's messages (oomRelevant) logged since
	// the previous read; the first read returns what the source still
	// holds from before.
	read(ctx context.Context) ([]kernelMsg, error)
}

// oomRelevant keeps the messages the parser looks at.
func oomRelevant(s string) bool {
	return strings.Contains(s, "Killed process ") || strings.Contains(s, "Kill process ") ||
		strings.HasPrefix(s, "oom-kill:") || strings.Contains(s, "memory.oom.group")
}

// openKernelLog opens /dev/kmsg, else the journal on systemd hosts.
// Replaced by tests.
var openKernelLog = func(root fsRoot, initSystem string) (kernelLog, error) {
	k, err := openKmsg(root.path("/dev/kmsg"))
	if err == nil {
		return k, nil
	}
	if initSystem == services.Systemd {
		if _, lerr := lookPath("journalctl"); lerr == nil {
			return &journalLog{}, nil
		}
	}
	return nil, err
}

// ---- /dev/kmsg -----------------------------------------------------------------------

type kmsgLog struct {
	fd  int
	buf []byte
}

func openKmsg(path string) (*kmsgLog, error) {
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	return &kmsgLog{fd: fd, buf: make([]byte, 16<<10)}, nil
}

// read reads records without blocking until none is left (a new reader
// starts at the oldest record the ring buffer still holds).
func (k *kmsgLog) read(context.Context) ([]kernelMsg, error) {
	zero := monotonicZero()
	var out []kernelMsg
	for range kmsgMaxRecords {
		n, err := unix.Read(k.fd, k.buf)
		switch {
		case err == unix.EAGAIN || err == nil && n == 0:
			return out, nil
		case err == unix.EPIPE || err == unix.EINTR:
			continue // records overwritten before they were read: go on with the next
		case err != nil:
			return out, err
		}
		if m, ok := parseKmsg(k.buf[:n], zero); ok && oomRelevant(m.text) {
			out = append(out, m)
		}
	}
	return out, nil
}

// parseKmsg parses a /dev/kmsg record ("6,1234,5678901,-;text\n KEY=v\n"):
// kernel messages only (facility 0; user space may write there too), the
// text unescaped, the time from the record's microseconds since boot.
func parseKmsg(b []byte, zero time.Time) (kernelMsg, bool) {
	hdr, text, ok := strings.Cut(string(b), ";")
	if !ok {
		return kernelMsg{}, false
	}
	text, _, _ = strings.Cut(text, "\n")
	f := strings.Split(hdr, ",")
	if len(f) < 3 {
		return kernelMsg{}, false
	}
	prio, err := strconv.Atoi(f[0])
	us, err2 := strconv.ParseInt(f[2], 10, 64)
	if err != nil || err2 != nil || prio>>3 != 0 {
		return kernelMsg{}, false
	}
	return kernelMsg{at: zero.Add(time.Duration(us) * time.Microsecond), text: unescapeHex(text)}, true
}

// unescapeHex undoes \xNN escapes in one pass: /dev/kmsg's (control
// bytes, bytes from 127 and the backslash itself) or systemd's in unit
// names (\x2d for "-").
func unescapeHex(s string) string {
	if !strings.Contains(s, `\x`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+3 < len(s) && s[i+1] == 'x' {
			if v, err := strconv.ParseUint(s[i+2:i+4], 16, 8); err == nil {
				b.WriteByte(byte(v))
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

// monotonicZero is the wall-clock time of CLOCK_MONOTONIC's zero (boot,
// without time suspended): /dev/kmsg's timestamps count from there.
func monotonicZero() time.Time {
	var ts unix.Timespec
	if err := unix.ClockGettime(unix.CLOCK_MONOTONIC, &ts); err != nil {
		return time.Time{}
	}
	return time.Now().Add(-time.Duration(ts.Nano()))
}

// ---- the journal ---------------------------------------------------------------------

// journalLog reads kernel messages from the journal: the first read the
// last hour, then everything after the last entry seen.
type journalLog struct {
	cursor string
}

// journalctl runs journalctl and returns its standard output. Replaced
// by tests.
var journalctl = func(ctx context.Context, args ...string) ([]byte, error) {
	return runCmd(ctx, 20*time.Second, "journalctl", args...)
}

func (j *journalLog) read(ctx context.Context) ([]kernelMsg, error) {
	args := []string{"-k", "-q", "--no-pager", "-o", "json"}
	if j.cursor != "" {
		args = append(args, "--after-cursor="+j.cursor)
	} else {
		args = append(args, "--since=-1h")
	}
	out, err := journalctl(ctx, args...)
	if err != nil && !noEntries(err, out) {
		return nil, err
	}
	msgs, last := parseJournalJSON(out)
	if last != "" {
		j.cursor = last
	} else if j.cursor == "" {
		// Nothing in the last hour: go on after the newest kernel message
		// (a kill logged in between is missed, so it counts as the
		// machine's).
		tail, err := journalctl(ctx, "-k", "-q", "--no-pager", "-o", "json", "-n", "1")
		if err != nil && !noEntries(err, tail) {
			return nil, err
		}
		_, j.cursor = parseJournalJSON(tail)
	}
	return msgs, nil
}

// noEntries: journalctl exits 1 without output or words when nothing
// matches (some versions).
func noEntries(err error, out []byte) bool {
	var ee *exec.ExitError
	return errors.As(err, &ee) && ee.ExitCode() == 1 && len(strings.TrimSpace(string(out))) == 0 &&
		strings.HasSuffix(err.Error(), "exit status 1")
}

// parseJournalJSON reads journalctl -o json: the relevant kernel messages
// and the cursor of the last entry.
func parseJournalJSON(b []byte) (msgs []kernelMsg, last string) {
	scanLines(b, func(line string) {
		var e struct {
			Cursor   string          `json:"__CURSOR"`
			Realtime string          `json:"__REALTIME_TIMESTAMP"`
			Facility string          `json:"SYSLOG_FACILITY"`
			Message  json.RawMessage `json:"MESSAGE"`
		}
		if json.Unmarshal([]byte(line), &e) != nil || e.Cursor == "" {
			return
		}
		last = e.Cursor
		if e.Facility != "" && e.Facility != "0" {
			return
		}
		text := journalText(e.Message)
		if !oomRelevant(text) {
			return
		}
		us, _ := strconv.ParseInt(e.Realtime, 10, 64)
		msgs = append(msgs, kernelMsg{at: time.UnixMicro(us), text: text})
	})
	return msgs, last
}

// journalText is MESSAGE as text: a string, or an array of bytes when it
// is not valid UTF-8.
func journalText(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var b []byte
	var n []int
	if json.Unmarshal(raw, &n) == nil {
		for _, v := range n {
			b = append(b, byte(v))
		}
	}
	return string(b)
}

// ---- parsing ---------------------------------------------------------------------------

var (
	oomKilledRe = regexp.MustCompile(`^(?:(.+?): )?Killed process (\d+) \((.*?)\)`)
	oomKillRe   = regexp.MustCompile(`^(.+?): Kill process (\d+) \(`) // older kernels
	oomGroupRe  = regexp.MustCompile(`^Tasks in (.+) are going to be killed due to memory\.oom\.group set`)
)

// oomEvent is a kill read from the kernel log.
type oomEvent struct {
	at      time.Time
	limit   bool   // a cgroup reached its own limit
	process string // the killed process's name
	cgroup  string // limit: the cgroup at its limit, when the summary said
}

// oomSummary is the kernel's "oom-kill:" summary line.
type oomSummary struct {
	at         time.Time
	constraint string // CONSTRAINT_NONE | CONSTRAINT_CPUSET | CONSTRAINT_MEMORY_POLICY | CONSTRAINT_MEMCG
	memcg      string // oom_memcg
	pid        int
}

// oomParser turns kernel messages into kills, keeping the context lines
// that come before a kill.
type oomParser struct {
	sum     oomSummary
	group   string // memory.oom.group: the cgroup whose tasks all die
	groupAt time.Time
	old     struct { // "<why>: Kill process <pid> (…) score …" (older kernels)
		limit bool
		at    time.Time
	}
}

func memcgWhy(why string) bool { return strings.HasPrefix(why, "Memory cgroup out of memory") }

// feed reads one message; ok when it is a kill.
func (p *oomParser) feed(m kernelMsg) (oomEvent, bool) {
	t := m.text
	if rest, ok := strings.CutPrefix(t, "oom-kill:"); ok {
		p.sum = parseOOMSummary(rest)
		p.sum.at = m.at
		return oomEvent{}, false
	}
	if g := oomGroupRe.FindStringSubmatch(t); g != nil {
		p.group, p.groupAt = g[1], m.at
		return oomEvent{}, false
	}
	if g := oomKillRe.FindStringSubmatch(t); g != nil {
		p.old.limit, p.old.at = memcgWhy(g[1]), m.at
		return oomEvent{}, false
	}
	g := oomKilledRe.FindStringSubmatch(t)
	if g == nil {
		return oomEvent{}, false
	}
	pid, _ := strconv.Atoi(g[2])
	near := func(at time.Time) bool {
		d := m.at.Sub(at)
		return !at.IsZero() && d < oomContextGap && d > -oomContextGap
	}
	sum := p.sum.pid == pid && pid != 0 && near(p.sum.at)
	ev := oomEvent{at: m.at, process: g[3]}
	switch why := g[1]; {
	case why != "":
		ev.limit = memcgWhy(why)
	case sum:
		ev.limit = p.sum.constraint == "CONSTRAINT_MEMCG"
	case near(p.old.at):
		ev.limit = p.old.limit
	}
	if ev.limit {
		switch {
		case sum:
			ev.cgroup = p.sum.memcg
		case near(p.groupAt):
			ev.cgroup = p.group
		}
	}
	return ev, true
}

// parseOOMSummary parses what follows "oom-kill:":
// "constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=/,mems_allowed=0,
// oom_memcg=/a/b,task_memcg=/a/b/c,task=python3,pid=177097,uid=1000"
// (global_oom instead of oom_memcg when the machine ran out). Cgroup paths
// are cut at the next known key, so a comma in a path does not matter.
func parseOOMSummary(s string) oomSummary {
	var o oomSummary
	if v, ok := strings.CutPrefix(s, "constraint="); ok {
		o.constraint, _, _ = strings.Cut(v, ",")
	}
	if i := strings.Index(s, ",oom_memcg="); i >= 0 {
		v := s[i+len(",oom_memcg="):]
		if j := strings.Index(v, ",task_memcg="); j >= 0 {
			v = v[:j]
		} else if j := strings.LastIndex(v, ",task="); j >= 0 {
			v = v[:j]
		}
		o.memcg = v
	}
	if i := strings.LastIndex(s, ",task="); i >= 0 {
		v := s[i+len(",task="):]
		if j := strings.LastIndex(v, ",pid="); j >= 0 {
			pid, _, _ := strings.Cut(v[j+len(",pid="):], ",")
			o.pid, _ = strconv.Atoi(pid)
		}
	}
	return o
}

// ---- the tracker -----------------------------------------------------------------------

// oomTracker follows the kernel log for the system collector: run() calls
// poll, Collect calls resolve and report.
type oomTracker struct {
	root fsRoot

	// Used by poll only (one run at a time).
	src       kernelLog
	openAt    time.Time
	p         oomParser
	primed    bool
	totalBase uint64 // vmstat and kills seen when primed
	killsBase uint64
	missing   uint64 // kills vmstat counted that the log did not show (yet)

	mu     sync.Mutex
	ok     bool // the kernel log was read in the last run
	kills  uint64
	limit  uint64
	total  uint64 // vmstat oom_kill of the last run
	haveT  bool
	recent []oomRecord // limit kills, oldest first
}

type oomRecord struct {
	proto.OOMKill
	resolved bool // Platform and GuestID are final (a guest, or none)
}

// poll reads the kernel log after vmstat said total (have: vmstat was
// read). When vmstat counted kills the log does not show yet (journald
// may lag), it waits a little for them.
func (o *oomTracker) poll(ctx context.Context, initSystem string, total uint64, have bool) {
	if o.src == nil {
		if !o.openAt.IsZero() && time.Since(o.openAt) < oomReopenAfter {
			o.setOK(false, total, have)
			return
		}
		o.openAt = time.Now()
		src, err := openKernelLog(o.root, initSystem)
		if err != nil {
			o.setOK(false, total, have)
			return
		}
		o.src = src
	}
	ok := o.readLog(ctx)
	if ok && have {
		if !o.primed {
			o.mu.Lock()
			o.primed, o.totalBase, o.killsBase = true, total, o.kills
			o.mu.Unlock()
		} else {
			for i := 0; i < oomSettleTries && o.missingNow(total) > o.missing; i++ {
				select {
				case <-ctx.Done():
				case <-time.After(oomSettleWait):
				}
				if ctx.Err() != nil || !o.readLog(ctx) {
					break
				}
			}
			o.missing = o.missingNow(total)
		}
	}
	o.setOK(ok, total, have)
}

func (o *oomTracker) setOK(ok bool, total uint64, have bool) {
	o.mu.Lock()
	o.ok, o.total, o.haveT = ok, total, have
	o.mu.Unlock()
}

// missingNow is how many kills vmstat counted since priming that the log
// has not shown.
func (o *oomTracker) missingNow(total uint64) uint64 {
	o.mu.Lock()
	defer o.mu.Unlock()
	want := total - min(total, o.totalBase)
	got := o.kills - o.killsBase
	return want - min(want, got)
}

// readLog reads new messages; false when the source failed.
func (o *oomTracker) readLog(ctx context.Context) bool {
	msgs, err := o.src.read(ctx)
	for _, m := range msgs {
		if ev, ok := o.p.feed(m); ok {
			o.add(ev)
		}
	}
	return err == nil
}

func (o *oomTracker) add(ev oomEvent) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.kills++
	if !ev.limit {
		return
	}
	o.limit++
	o.recent = append(o.recent, oomRecord{OOMKill: proto.OOMKill{At: ev.at.UTC(), Process: ev.process, Cgroup: ev.cgroup}})
	if n := len(o.recent) - proto.OOMLimitedMax; n > 0 {
		o.recent = append(o.recent[:0:0], o.recent[n:]...)
	}
}

// resolve names the guests of the recent kills: guest(cgroup) returns
// the guest's platform and id, and ok when that is final (a guest found,
// or the cgroup is no guest's); a guest not known (yet) is tried again
// with the next report.
func (o *oomTracker) resolve(guest func(cgroup string) (platform, id string, ok bool)) {
	o.mu.Lock()
	defer o.mu.Unlock()
	for i := range o.recent {
		k := &o.recent[i]
		if k.resolved {
			continue
		}
		if k.Cgroup == "" {
			k.resolved = true
			continue
		}
		if platform, id, ok := guest(k.Cgroup); ok {
			k.Platform, k.GuestID, k.resolved = platform, id, true
		}
	}
}

// report is SystemInfo's OOMLimitKills and OOMLimited at now: nil when
// the kernel log could not be read.
func (o *oomTracker) report(now time.Time) (*uint64, []proto.OOMKill) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if !o.ok {
		return nil, nil
	}
	n := o.limit
	if o.haveT {
		n = min(n, o.total)
	}
	var out []proto.OOMKill
	keep := o.recent[:0]
	for _, k := range o.recent {
		if now.Sub(k.At) < oomRecentFor {
			keep = append(keep, k)
			out = append(out, k.OOMKill)
		}
	}
	clear(o.recent[len(keep):])
	o.recent = keep
	return &n, out
}

// ---- cgroups and guests ----------------------------------------------------------------

// oomGuests resolves the guests of oomTracker.resolve against a report's
// guests. The cgroup is mapped like the processes view does
// (inspect.ContainerOf: Docker's docker-<id>.scope or docker/<id>, Incus'
// lxc.payload.<name>, Proxmox VE's lxc/<vmid> and qemu.slice/<vmid>.scope,
// libvirt's machine-qemu\x2d<n>\x2d<name>.scope); dockerName maps a
// container id to its name (also of containers removed lately).
func oomGuests(r *proto.Report, dockerName func(id string) string) func(cgroup string) (platform, id string, ok bool) {
	return func(cgroup string) (string, string, bool) {
		platform, key := inspect.ContainerOf("0::" + cgroup)
		switch platform {
		case proto.PlatformDocker:
			if dockerName != nil {
				if n := dockerName(key); n != "" {
					return platform, n, true
				}
			}
		case proto.PlatformIncus:
			// "project_name" outside the default project: instance names
			// cannot hold "_", so the last one ends the project.
			if r.FindGuest(platform, key) != nil {
				return platform, key, true
			}
			if j := strings.LastIndexByte(key, '_'); j > 0 && r.FindGuest(platform, key[:j]+"/"+key[j+1:]) != nil {
				return platform, key[:j] + "/" + key[j+1:], true
			}
		case proto.PlatformPVE:
			if r.FindGuest(platform, key) != nil {
				return platform, key, true
			}
		case proto.PlatformLibvirt:
			if r.Libvirt != nil {
				if id, ok := libvirtGuestOf(key, r.Libvirt.Guests); ok {
					return platform, id, true
				}
			}
		}
		return "", "", platform == ""
	}
}

// libvirtGuestOf finds the domain of the name in a libvirt machine name:
// libvirt drops characters outside [A-Za-z0-9-] and cuts the machine name
// ("qemu-<n>-<name>") at 64, so names compare by their letters and digits,
// a long one by its start; two candidates are none.
func libvirtGuestOf(name string, guests []proto.Guest) (string, bool) {
	want := alnumLower(name)
	cut := len(name) >= 50
	var hit string
	n := 0
	for i := range guests {
		have := alnumLower(guests[i].ID)
		if have == want || cut && strings.HasPrefix(have, want) {
			hit = guests[i].ID
			n++
		}
	}
	if n != 1 || want == "" {
		return "", false
	}
	return hit, true
}

func alnumLower(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}
