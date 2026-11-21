//go:build linux

package collect

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"

	"rackoon/internal/proto"
)

var oomT0 = time.Date(2026, 10, 18, 10, 39, 0, 0, time.UTC)

func kmsgAt(s int, text string) kernelMsg {
	return kernelMsg{at: oomT0.Add(time.Duration(s) * time.Second), text: text}
}

// A build server, 2026-10-18 10:39: a test's python3 killed inside its own
// memory cgroup while the machine had 98 GB free.
const (
	beastSummary = "oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=user.slice,mems_allowed=0," +
		"oom_memcg=/user.slice/user-1000.slice/user@1000.service/wbtest159958.slice," +
		"task_memcg=/user.slice/user-1000.slice/user@1000.service/wbtest159958.slice/run-p177090.scope,task=python3,pid=177097,uid=1000"
	beastKill = "Memory cgroup out of memory: Killed process 177097 (python3) total-vm:9512340kB, anon-rss:8388608kB, " +
		"file-rss:2048kB, shmem-rss:0kB, UID:1000 pgtables:16800kB oom_score_adj:0"
)

func TestParseKmsg(t *testing.T) {
	zero := oomT0
	m, ok := parseKmsg([]byte("3,4711,2500000,-;"+beastKill+"\n SUBSYSTEM=x\n"), zero)
	if !ok || m.text != beastKill || !m.at.Equal(zero.Add(2500*time.Millisecond)) {
		t.Fatalf("record: %v %+v", ok, m)
	}
	// /dev/kmsg escapes the backslash of systemd's unit names.
	m, ok = parseKmsg([]byte(`6,1,1,-;oom-kill:constraint=CONSTRAINT_MEMCG,oom_memcg=/machine.slice/machine-qemu\x5cx2d1\x5cx2dweb.scope,task=qemu,pid=1,uid=0`), zero)
	if !ok || !strings.Contains(m.text, `machine-qemu\x2d1\x2dweb.scope`) {
		t.Fatalf("escapes: %q", m.text)
	}
	// User space writing to /dev/kmsg (facility 1 = user) is not the kernel.
	if _, ok := parseKmsg([]byte("14,2,3,-;Memory cgroup out of memory: Killed process 1 (x)"), zero); ok {
		t.Fatal("user-space record accepted")
	}
	if _, ok := parseKmsg([]byte("garbage"), zero); ok {
		t.Fatal("garbage accepted")
	}
	if unescapeHex(`a\x2db\x5c\xzz`) != `a-b\\xzz` {
		t.Fatalf("unescape %q", unescapeHex(`a\x2db\x5c\xzz`))
	}
}

func TestKmsgRead(t *testing.T) {
	// A non-blocking pipe stands in for /dev/kmsg: one record per write,
	// EAGAIN when none is left.
	var p [2]int
	if err := unix.Pipe2(p[:], unix.O_NONBLOCK|unix.O_CLOEXEC); err != nil {
		t.Fatal(err)
	}
	defer unix.Close(p[1])
	k := &kmsgLog{fd: p[0], buf: make([]byte, 16<<10)}
	defer unix.Close(p[0])
	if msgs, err := k.read(context.Background()); err != nil || len(msgs) != 0 {
		t.Fatalf("empty: %v %v", msgs, err)
	}
	for _, rec := range []string{"6,1,1000,-;eth0: link up\n", "3,2,2000,-;" + beastKill + "\n"} {
		unix.Write(p[1], []byte(rec))
		msgs, err := k.read(context.Background())
		if err != nil || strings.Contains(rec, "eth0") != (len(msgs) == 0) {
			t.Fatalf("%q: %v %v", rec, msgs, err)
		}
	}
	// The real device, where this test may read it.
	if real, err := openKmsg("/dev/kmsg"); err == nil {
		defer unix.Close(real.fd)
		if _, err := real.read(context.Background()); err != nil {
			t.Fatalf("/dev/kmsg: %v", err)
		}
	}
}

func TestOOMParser(t *testing.T) {
	type want struct {
		limit   bool
		process string
		cgroup  string
	}
	cases := []struct {
		name string
		msgs []kernelMsg
		want []want
	}{
		{"memcg (a build server)", []kernelMsg{kmsgAt(0, beastSummary), kmsgAt(0, beastKill)},
			[]want{{true, "python3", "/user.slice/user-1000.slice/user@1000.service/wbtest159958.slice"}}},
		{"machine-wide", []kernelMsg{
			kmsgAt(0, "oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),cpuset=/,mems_allowed=0,global_oom,task_memcg=/system.slice/docker-"+strings.Repeat("a", 64)+".scope,task=java,pid=4242,uid=0"),
			kmsgAt(0, "Out of memory: Killed process 4242 (java) total-vm:1kB, anon-rss:1kB, file-rss:0kB, shmem-rss:0kB, UID:0 pgtables:1kB oom_score_adj:0"),
		}, []want{{false, "java", ""}}},
		{"allocating task", []kernelMsg{kmsgAt(0, "Out of memory (oom_kill_allocating_task): Killed process 7 (dd) total-vm:1kB")},
			[]want{{false, "dd", ""}}},
		{"cpuset is the machine's", []kernelMsg{
			kmsgAt(0, "oom-kill:constraint=CONSTRAINT_CPUSET,nodemask=(null),cpuset=numa1,mems_allowed=1,global_oom,task_memcg=/,task=x,pid=9,uid=0"),
			kmsgAt(0, "Out of memory: Killed process 9 (x) total-vm:1kB"),
		}, []want{{false, "x", ""}}},
		{"summary rate-limited", []kernelMsg{
			kmsgAt(0, beastSummary), kmsgAt(0, beastKill),
			kmsgAt(1, "Memory cgroup out of memory: Killed process 177200 (python3) total-vm:1kB"),
		}, []want{{true, "python3", "/user.slice/user-1000.slice/user@1000.service/wbtest159958.slice"}, {true, "python3", ""}}},
		{"memory.oom.group", []kernelMsg{
			kmsgAt(0, "oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=/,mems_allowed=0,oom_memcg=/lxc.payload.web,task_memcg=/lxc.payload.web/system.slice/app.service,task=app,pid=10,uid=0"),
			kmsgAt(0, "Memory cgroup out of memory: Killed process 10 (app) total-vm:1kB"),
			kmsgAt(0, "Tasks in /lxc.payload.web/system.slice/app.service are going to be killed due to memory.oom.group set"),
			kmsgAt(0, "Memory cgroup out of memory: Killed process 11 (worker) total-vm:1kB"),
		}, []want{{true, "app", "/lxc.payload.web"}, {true, "worker", "/lxc.payload.web/system.slice/app.service"}}},
		{"older kernel without the why", []kernelMsg{
			kmsgAt(0, "Memory cgroup out of memory: Kill process 50 (java) score 900 or sacrifice child"),
			kmsgAt(0, "Killed process 51 (java-child) total-vm:1kB, anon-rss:1kB, file-rss:0kB, shmem-rss:0kB"),
			kmsgAt(60, "Killed process 52 (other) total-vm:1kB"), // no context: the machine's
		}, []want{{true, "java-child", ""}, {false, "other", ""}}},
		{"stale summary of another pid", []kernelMsg{
			kmsgAt(0, beastSummary),
			kmsgAt(30, "Killed process 177097 (python3) total-vm:1kB"),
		}, []want{{false, "python3", ""}}},
	}
	for _, c := range cases {
		var p oomParser
		var got []want
		for _, m := range c.msgs {
			if ev, ok := p.feed(m); ok {
				got = append(got, want{ev.limit, ev.process, ev.cgroup})
			}
		}
		if !slices.Equal(got, c.want) {
			t.Errorf("%s: got %+v, want %+v", c.name, got, c.want)
		}
	}
	if s := parseOOMSummary(strings.TrimPrefix(beastSummary, "oom-kill:")); s.constraint != "CONSTRAINT_MEMCG" || s.pid != 177097 {
		t.Errorf("summary %+v", s)
	}
}

func TestOOMGuests(t *testing.T) {
	id := strings.Repeat("0123456789abcdef", 4)
	other := strings.Repeat("cd", 32)
	r := &proto.Report{
		Incus:   &proto.Platform{Guests: []proto.Guest{{ID: "web"}, {ID: "dev/api"}, {ID: "my_proj/db"}}},
		PVE:     &proto.PVE{Guests: []proto.Guest{{ID: "101"}, {ID: "105"}}},
		Libvirt: &proto.Platform{Guests: []proto.Guest{{ID: "debian_12"}, {ID: "Windows 10"}, {ID: "a.b"}, {ID: "ab"}}},
	}
	names := map[string]string{id: "worker"}
	guest := oomGuests(r, func(id string) string { return names[id] })
	cases := []struct {
		cgroup, platform, id string
		ok                   bool // final
	}{
		{"/system.slice/docker-" + id + ".scope", proto.PlatformDocker, "worker", true},
		{"/docker/" + id, proto.PlatformDocker, "worker", true},
		{"/system.slice/docker-" + other + ".scope", "", "", false}, // not known yet
		{"/lxc.payload.web", proto.PlatformIncus, "web", true},
		{"/lxc.payload.dev_api/system.slice/app.service", proto.PlatformIncus, "dev/api", true},
		{"/lxc.payload.my_proj_db", proto.PlatformIncus, "my_proj/db", true},
		{"/lxc.payload.gone", "", "", false},
		{"/lxc/101/ns/system.slice/nginx.service", proto.PlatformPVE, "101", true},
		{"/qemu.slice/105.scope", proto.PlatformPVE, "105", true},
		{"/lxc/102", "", "", false},
		{`/machine.slice/machine-qemu\x2d3\x2ddebian12.scope/libvirt/emulator`, proto.PlatformLibvirt, "debian_12", true},
		{"/machine/qemu-1-Windows10.libvirt-qemu", proto.PlatformLibvirt, "Windows 10", true},
		{`/machine.slice/machine-qemu\x2d2\x2dab.scope`, "", "", false}, // a.b and ab: two candidates are none
		{"/user.slice/user-1000.slice/user@1000.service/wbtest159958.slice", "", "", true},
		{"/system.slice/incus.service", "", "", true}, // Incus VMs: no cgroup of their own
		{"/lxc.monitor.web", "", "", true},
	}
	for _, c := range cases {
		if p, got, ok := guest(c.cgroup); p != c.platform || got != c.id || ok != c.ok {
			t.Errorf("%s: %q %q %v, want %q %q %v", c.cgroup, p, got, ok, c.platform, c.id, c.ok)
		}
	}
	// A machine name libvirt cut at 64 characters matches by its start.
	long := "a-very-long-virtual-machine-name-that-libvirt-cuts-off-at-the-end"
	r.Libvirt.Guests = append(r.Libvirt.Guests, proto.Guest{ID: long})
	if p, got, ok := guest(`/machine.slice/machine-` + strings.ReplaceAll(("qemu-12-" + long)[:64], "-", `\x2d`) + ".scope"); !ok || p != proto.PlatformLibvirt || got != long {
		t.Errorf("cut machine name: %q %q %v", p, got, ok)
	}
}

func TestParseJournalJSON(t *testing.T) {
	out := []byte(`{"__CURSOR":"s=1;i=1","__REALTIME_TIMESTAMP":"1792312740000000","SYSLOG_FACILITY":"0","MESSAGE":"` + beastKill + `"}
{"__CURSOR":"s=1;i=2","__REALTIME_TIMESTAMP":"1792312741000000","MESSAGE":"eth0: link up"}
{"__CURSOR":"s=1;i=3","__REALTIME_TIMESTAMP":"1792312742000000","SYSLOG_FACILITY":"3","MESSAGE":"Out of memory: Killed process 1 (fake)"}
{"__CURSOR":"s=1;i=4","__REALTIME_TIMESTAMP":"1792312743000000","MESSAGE":[79,117,116,32,111,102,32,109,101,109,111,114,121,58,32,75,105,108,108,101,100,32,112,114,111,99,101,115,115,32,50,32,40,255,41]}
not json
`)
	msgs, last := parseJournalJSON(out)
	if last != "s=1;i=4" || len(msgs) != 2 || msgs[0].text != beastKill || !msgs[0].at.Equal(time.UnixMicro(1792312740000000)) ||
		!strings.HasPrefix(msgs[1].text, "Out of memory: Killed process 2 (") {
		t.Fatalf("%q %+v", last, msgs)
	}
}

func TestJournalLogRead(t *testing.T) {
	old := journalctl
	defer func() { journalctl = old }()
	var calls [][]string
	replies := [][]byte{nil, []byte(`{"__CURSOR":"tail","__REALTIME_TIMESTAMP":"1","MESSAGE":"eth0: link up"}` + "\n")}
	journalctl = func(_ context.Context, args ...string) ([]byte, error) {
		calls = append(calls, args)
		if len(replies) == 0 {
			return []byte(`{"__CURSOR":"c2","__REALTIME_TIMESTAMP":"2","MESSAGE":"` + beastKill + `"}` + "\n"), nil
		}
		r := replies[0]
		replies = replies[1:]
		return r, nil
	}
	var j journalLog
	// Quiet last hour: the next read starts after the newest kernel message.
	if msgs, err := j.read(context.Background()); err != nil || len(msgs) != 0 || j.cursor != "tail" {
		t.Fatalf("first read: %v %v %q", msgs, err, j.cursor)
	}
	if !slices.Contains(calls[0], "--since=-1h") || !slices.Contains(calls[1], "-n") {
		t.Fatalf("first calls %q", calls)
	}
	msgs, err := j.read(context.Background())
	if err != nil || len(msgs) != 1 || j.cursor != "c2" || !slices.Contains(calls[2], "--after-cursor=tail") {
		t.Fatalf("second read: %v %v %q %q", msgs, err, j.cursor, calls)
	}
	journalctl = func(context.Context, ...string) ([]byte, error) { return nil, errors.New("journalctl: broken") }
	if _, err := j.read(context.Background()); err == nil || j.cursor != "c2" {
		t.Fatal("an error is reported and keeps the cursor")
	}
}

// fakeKernelLog hands out queued batches of messages, one per read.
type fakeKernelLog struct {
	batches [][]kernelMsg
	err     error
	reads   int
}

func (f *fakeKernelLog) read(context.Context) ([]kernelMsg, error) {
	f.reads++
	if f.err != nil {
		return nil, f.err
	}
	if len(f.batches) == 0 {
		return nil, nil
	}
	b := f.batches[0]
	f.batches = f.batches[1:]
	return b, nil
}

func useKernelLog(t *testing.T, src kernelLog, err error) *int {
	t.Helper()
	oldOpen, oldWait := openKernelLog, oomSettleWait
	t.Cleanup(func() { openKernelLog, oomSettleWait = oldOpen, oldWait })
	oomSettleWait = time.Millisecond
	opens := 0
	openKernelLog = func(fsRoot, string) (kernelLog, error) {
		opens++
		return src, err
	}
	return &opens
}

func TestOOMTracker(t *testing.T) {
	ctx := context.Background()
	now := time.Now().UTC()
	at := func(ago time.Duration) time.Time { return now.Add(-ago) }
	src := &fakeKernelLog{batches: [][]kernelMsg{
		// From before the agent started: an old limit kill and a machine kill.
		{{at(3 * time.Hour), "Memory cgroup out of memory: Killed process 1 (old) total-vm:1kB"},
			{at(2 * time.Hour), "Out of memory: Killed process 2 (big) total-vm:1kB"}},
		// The build server's kill.
		{{at(time.Minute), beastSummary}, {at(time.Minute), beastKill}},
	}}
	useKernelLog(t, src, nil)
	var o oomTracker
	o.poll(ctx, "systemd", 2, true)
	if n, ks := o.report(now); n == nil || *n != 1 || len(ks) != 0 {
		t.Fatalf("baseline: %v %+v", n, ks)
	}
	o.poll(ctx, "systemd", 3, true)
	n, ks := o.report(now)
	if n == nil || *n != 2 || len(ks) != 1 || ks[0].Process != "python3" || ks[0].Platform != "" ||
		ks[0].Cgroup != "/user.slice/user-1000.slice/user@1000.service/wbtest159958.slice" {
		t.Fatalf("kill: %v %+v", n, ks)
	}
	if src.reads != 2 {
		t.Fatalf("no wait when the log explains vmstat: %d reads", src.reads)
	}
	// vmstat counted a kill the log does not show yet: a few more reads,
	// then it counts as the machine's.
	o.poll(ctx, "systemd", 4, true)
	if src.reads != 2+1+oomSettleTries {
		t.Fatalf("settle reads %d", src.reads)
	}
	o.poll(ctx, "systemd", 4, true)
	if src.reads != 2+1+oomSettleTries+1 {
		t.Fatalf("a kill never logged is not waited for again: %d", src.reads)
	}
	// A late line arrives in the settle wait.
	src.batches = [][]kernelMsg{nil, {{at(0), "Memory cgroup out of memory: Killed process 9 (late) total-vm:1kB"}}}
	reads := src.reads
	o.poll(ctx, "systemd", 5, true)
	if n, ks := o.report(now); src.reads != reads+2 || *n != 3 || len(ks) != 2 || ks[1].Process != "late" {
		t.Fatalf("late line: %d %v %+v", src.reads-reads, *n, ks)
	}
	// A kill logged after vmstat was read counts once vmstat has it.
	src.batches = [][]kernelMsg{{{at(0), "Memory cgroup out of memory: Killed process 10 (ahead) total-vm:1kB"}}}
	o.poll(ctx, "systemd", 5, true)
	if n, _ := o.report(now); *n != 4 {
		t.Fatalf("after %v", *n)
	}
	// Kills older than an hour leave the list.
	if _, ks := o.report(now.Add(oomRecentFor)); len(ks) != 0 {
		t.Fatalf("old kills listed: %+v", ks)
	}
	// Guests resolve once known.
	id := strings.Repeat("ab", 32)
	src.batches = [][]kernelMsg{{
		{at(0), "oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=/,mems_allowed=0,oom_memcg=/system.slice/docker-" + id + ".scope,task_memcg=/system.slice/docker-" + id + ".scope,task=php-fpm,pid=77,uid=33"},
		{at(0), "Memory cgroup out of memory: Killed process 77 (php-fpm) total-vm:1kB"}}}
	o.poll(ctx, "systemd", 7, true)
	name := ""
	resolve := func() { o.resolve(oomGuests(&proto.Report{}, func(string) string { return name })) }
	resolve()
	if _, ks := o.report(now); ks[len(ks)-1].GuestID != "" {
		t.Fatal("unknown container named")
	}
	name = "nextcloud"
	resolve()
	name = "renamed"
	resolve()
	if _, ks := o.report(now); ks[len(ks)-1].Platform != proto.PlatformDocker || ks[len(ks)-1].GuestID != "nextcloud" {
		t.Fatalf("container: %+v", ks[len(ks)-1])
	}
	// The list keeps the newest OOMLimitedMax.
	var many []kernelMsg
	for range proto.OOMLimitedMax + 3 {
		many = append(many, kernelMsg{at(0), "Memory cgroup out of memory: Killed process 5 (x) total-vm:1kB"})
	}
	src.batches = [][]kernelMsg{many}
	o.poll(ctx, "systemd", 100, true)
	if _, ks := o.report(now); len(ks) != proto.OOMLimitedMax {
		t.Fatalf("list length %d", len(ks))
	}
	// A failing read reports nothing known.
	src.err = errors.New("gone")
	o.poll(ctx, "systemd", 100, true)
	if n, ks := o.report(now); n != nil || ks != nil {
		t.Fatalf("failed read: %v %v", n, ks)
	}
}

func TestOOMTrackerClamp(t *testing.T) {
	// Kills logged between reading vmstat and the log: the limit count
	// never runs ahead of vmstat.
	kill := kernelMsg{time.Now(), "Memory cgroup out of memory: Killed process 5 (x) total-vm:1kB"}
	useKernelLog(t, &fakeKernelLog{batches: [][]kernelMsg{{kill, kill, kill}}}, nil)
	var o oomTracker
	o.poll(context.Background(), "systemd", 2, true)
	if n, ks := o.report(time.Now()); n == nil || *n != 2 || len(ks) != 3 {
		t.Fatalf("clamped: %v %d", n, len(ks))
	}
	// Without vmstat the count is the log's.
	o.poll(context.Background(), "systemd", 0, false)
	if n, _ := o.report(time.Now()); *n != 3 {
		t.Fatalf("no vmstat: %v", *n)
	}
}

func TestOOMTrackerNoKernelLog(t *testing.T) {
	opens := useKernelLog(t, nil, errors.New("permission denied"))
	var o oomTracker
	o.poll(context.Background(), "openrc", 4, true)
	o.poll(context.Background(), "openrc", 4, true)
	if n, ks := o.report(time.Now()); n != nil || ks != nil || *opens != 1 {
		t.Fatalf("no kernel log: %v %v, %d opens", n, ks, *opens)
	}
}
