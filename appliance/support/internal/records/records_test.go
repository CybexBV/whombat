package records

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/support/internal/wire"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// timers is a fake time.AfterFunc: tests fire the pending ones.
type timers struct {
	mu      sync.Mutex
	pending []*timer
}

type timer struct {
	d       time.Duration
	f       func()
	stopped bool
}

func (ts *timers) after(d time.Duration, f func()) func() bool {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	t := &timer{d: d, f: f}
	ts.pending = append(ts.pending, t)
	return func() bool {
		ts.mu.Lock()
		defer ts.mu.Unlock()
		was := !t.stopped
		t.stopped = true
		return was
	}
}

func (ts *timers) fire() {
	ts.mu.Lock()
	var due []*timer
	for _, t := range ts.pending {
		if !t.stopped {
			t.stopped = true
			due = append(due, t)
		}
	}
	ts.pending = nil
	ts.mu.Unlock()
	for _, t := range due {
		t.f()
	}
}

type fixture struct {
	s      *Store
	dir    string
	now    time.Time
	timers *timers
	starts []Meta
	ends   []Meta
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	f := &fixture{dir: t.TempDir(), now: time.Date(2026, 10, 21, 20, 0, 0, 0, time.UTC), timers: &timers{}}
	f.open(t)
	return f
}

func (f *fixture) open(t *testing.T) {
	t.Helper()
	s, err := Open(Options{Dir: f.dir, Now: func() time.Time { return f.now }, After: f.timers.after,
		OnStart: func(m Meta) { f.starts = append(f.starts, m) }, OnEnd: func(m Meta) { f.ends = append(f.ends, m) }})
	if err != nil {
		t.Fatal(err)
	}
	f.s = s
}

func kinds(steps []wire.Step) string {
	var k []string
	for _, s := range steps {
		k = append(k, string(s.Kind))
	}
	return strings.Join(k, ",")
}

func TestOneVisitPerCertificate(t *testing.T) {
	f := newFixture(t)
	v := f.s.Visit(7, "Claude (claude)", "Claude", wire.LevelLook)
	v.Connected()
	v.Step(wire.Step{Kind: wire.StepLook, Command: wire.Ptr(protocol.LookCommandLogs), Units: []string{"whombat-voice.service"}})
	v.Left()
	// Another connection with the same certificate before the idle time: the same visit.
	again := f.s.Visit(7, "Claude (claude)", "Claude", wire.LevelLook)
	if again.ID() != v.ID() {
		t.Fatalf("same certificate opened a new visit %s, want %s", again.ID(), v.ID())
	}
	again.Connected()
	if len(f.starts) != 1 {
		t.Fatalf("starts = %d, want 1", len(f.starts))
	}
	if got := f.s.Connected(); len(got) != 1 || got[0].Who != "Claude" || got[0].VisitID != v.ID() {
		t.Fatalf("connected = %+v", got)
	}
	// A different certificate is a different visit.
	other := f.s.Visit(8, "John (john)", "John", wire.LevelFix)
	if other.ID() == v.ID() {
		t.Fatal("a second certificate shared the visit")
	}
}

func TestIdleEndsTheVisit(t *testing.T) {
	f := newFixture(t)
	v := f.s.Visit(1, "Claude (claude)", "Claude", wire.LevelLook)
	v.Connected()
	v.Left()
	f.now = f.now.Add(wire.VisitIdleS * time.Second)
	f.timers.fire()
	if len(f.ends) != 1 || f.ends[0].ID != v.ID() || f.ends[0].EndedAt == nil {
		t.Fatalf("ends = %+v", f.ends)
	}
	visits, err := f.s.List("", 0)
	if err != nil || len(visits) != 1 {
		t.Fatalf("list = %+v, %v", visits, err)
	}
	if got := kinds(visits[0].Steps); got != "connected,left" {
		t.Fatalf("steps = %s", got)
	}
	if visits[0].EndedAt == nil {
		t.Fatal("ended visit has no end")
	}
	// Late calls on an ended visit change nothing.
	v.Step(wire.Step{Kind: wire.StepLook, Command: wire.Ptr(protocol.LookCommandStatus)})
	v.Connected()
	if visits, _ := f.s.List("", 0); kinds(visits[0].Steps) != "connected,left" || len(f.starts) != 1 {
		t.Fatalf("an ended visit took more steps: %s", kinds(visits[0].Steps))
	}
}

func TestAConnectionKeepsTheVisitOpen(t *testing.T) {
	f := newFixture(t)
	v := f.s.Visit(1, "k", "Claude", wire.LevelLook)
	v.Connected()
	v.Connected()
	v.Left()
	f.timers.fire() // no timer is armed while a connection is open
	if len(f.ends) != 0 {
		t.Fatal("the visit ended with a connection open")
	}
}

func TestEndOpenEndsEveryVisit(t *testing.T) {
	f := newFixture(t)
	a := f.s.Visit(1, "k", "Claude", wire.LevelFix)
	a.Connected()
	b := f.s.Visit(2, "k2", "John", wire.LevelFix)
	b.Connected()
	f.s.EndOpen()
	if len(f.ends) != 2 {
		t.Fatalf("ends = %d, want 2", len(f.ends))
	}
	if got := f.s.Connected(); len(got) != 0 {
		t.Fatalf("still connected: %+v", got)
	}
}

func TestAVisitWithoutAConnectionIsListedButNotAnnounced(t *testing.T) {
	f := newFixture(t)
	v := f.s.Visit(1, "k", "Mallory", wire.LevelLook)
	v.Step(wire.Step{Kind: wire.StepWrongCode})
	f.timers.fire()
	if len(f.starts) != 0 || len(f.ends) != 0 {
		t.Fatalf("starts %d ends %d, want none", len(f.starts), len(f.ends))
	}
	visits, _ := f.s.List("", 0)
	if len(visits) != 1 || kinds(visits[0].Steps) != "wrong_code" {
		t.Fatalf("list = %+v", visits)
	}
}

func TestTranscriptIsCappedAndNeverFails(t *testing.T) {
	f := newFixture(t)
	v := f.s.Visit(1, "k", "Claude", wire.LevelFix)
	v.Connected()
	w := v.Transcript()
	big := make([]byte, 1<<20)
	for i := range big {
		big[i] = 'x'
	}
	for written := 0; written <= wire.TranscriptBytesPerVisit; written += len(big) {
		if n, err := w.Write(big); n != len(big) || err != nil {
			t.Fatalf("write = %d, %v", n, err)
		}
	}
	visits, _ := f.s.List("", 0)
	if visits[0].TranscriptBytes != wire.TranscriptBytesPerVisit || !visits[0].Truncated {
		t.Fatalf("transcript %d bytes, truncated %v", visits[0].TranscriptBytes, visits[0].Truncated)
	}
	rc, err := f.s.Transcript(v.ID())
	if err != nil {
		t.Fatal(err)
	}
	n, _ := io.Copy(io.Discard, rc)
	rc.Close()
	if n != wire.TranscriptBytesPerVisit {
		t.Fatalf("transcript file %d bytes", n)
	}
}

func TestStepsAreCappedAndClipped(t *testing.T) {
	f := newFixture(t)
	v := f.s.Visit(1, "k", "Claude", wire.LevelFix)
	v.Connected()
	long := strings.Repeat("é", wire.CommandLineChars+50)
	units := make([]string, 20)
	for i := range units {
		units[i] = fmt.Sprintf("whombat-%d", i)
	}
	for range wire.StepsPerVisit + 10 {
		v.Step(wire.Step{Kind: wire.StepExec, Line: &long, Units: units})
	}
	visits, _ := f.s.List("", 0)
	got := visits[0]
	if len(got.Steps) != wire.StepsShown || !got.Truncated {
		t.Fatalf("shown %d truncated %v", len(got.Steps), got.Truncated)
	}
	last := got.Steps[len(got.Steps)-1]
	if n := len([]rune(*last.Line)); n != wire.CommandLineChars {
		t.Fatalf("line kept %d characters", n)
	}
	if len(last.Units) != maxUnits {
		t.Fatalf("units kept %d", len(last.Units))
	}
}

func TestTranscriptOfNoVisit(t *testing.T) {
	f := newFixture(t)
	for _, id := range []string{"", "../etc", "20261021T200000Z-0000000g", "20261021T200000Z-00000000"} {
		if _, err := f.s.Transcript(id); err != ErrNotFound {
			t.Fatalf("Transcript(%q) = %v, want ErrNotFound", id, err)
		}
	}
	v := f.s.Visit(1, "k", "Claude", wire.LevelLook)
	if _, err := f.s.Transcript(v.ID()); err != ErrNotFound {
		t.Fatalf("an empty transcript = %v, want ErrNotFound", err)
	}
}

func TestListPagesNewestFirst(t *testing.T) {
	f := newFixture(t)
	var ids []string
	for i := range 5 {
		f.now = f.now.Add(time.Minute)
		v := f.s.Visit(uint64(i+1), "k", "Claude", wire.LevelLook)
		ids = append(ids, v.ID())
	}
	page, _ := f.s.List("", 2)
	if len(page) != 2 || page[0].ID != ids[4] || page[1].ID != ids[3] {
		t.Fatalf("first page %v", page)
	}
	next, _ := f.s.List(page[1].ID, 2)
	if len(next) != 2 || next[0].ID != ids[2] {
		t.Fatalf("second page %v", next)
	}
	if _, err := f.s.List("../x", 2); err != ErrNotFound {
		t.Fatalf("bad cursor = %v", err)
	}
}

func TestACrashLeavesNoOpenVisit(t *testing.T) {
	f := newFixture(t)
	v := f.s.Visit(1, "k", "Claude", wire.LevelFix)
	v.Connected()
	v.Step(wire.Step{Kind: wire.StepExec, Line: wire.Ptr("systemctl status")})
	// The process dies without Close: a new Store ends the visit and reports it.
	f.starts, f.ends = nil, nil
	f.open(t)
	if len(f.ends) != 1 || f.ends[0].ID != v.ID() || f.ends[0].Steps != 2 {
		t.Fatalf("recovered = %+v", f.ends)
	}
	visits, _ := f.s.List("", 0)
	if visits[0].EndedAt == nil {
		t.Fatal("the recovered visit is still open")
	}
}

func TestPruneByAgeAndSize(t *testing.T) {
	f := newFixture(t)
	old := f.s.Visit(1, "k", "Claude", wire.LevelLook)
	old.Connected()
	f.s.EndOpen()
	f.now = f.now.Add(wire.KeepDays*24*time.Hour + time.Hour)
	recent := f.s.Visit(2, "k", "Claude", wire.LevelLook)
	recent.Connected()
	f.s.EndOpen()
	if err := f.s.Prune(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(f.dir, old.ID())); !os.IsNotExist(err) {
		t.Fatal("a visit older than KeepDays is still there")
	}
	if _, err := os.Stat(filepath.Join(f.dir, recent.ID())); err != nil {
		t.Fatal("a recent visit was pruned")
	}
}

func TestFilesAreOwnerOnly(t *testing.T) {
	f := newFixture(t)
	v := f.s.Visit(1, "k", "Claude", wire.LevelFix)
	v.Connected()
	v.Transcript().Write([]byte("ok\n"))
	for _, p := range []string{f.dir, filepath.Join(f.dir, v.ID()), filepath.Join(f.dir, v.ID(), metaFile),
		filepath.Join(f.dir, v.ID(), stepsFile), filepath.Join(f.dir, v.ID(), transcriptFile)} {
		st, err := os.Stat(p)
		if err != nil {
			t.Fatal(err)
		}
		if st.Mode().Perm()&0o077 != 0 {
			t.Fatalf("%s is %v", p, st.Mode().Perm())
		}
	}
	var m Meta
	b, _ := os.ReadFile(filepath.Join(f.dir, v.ID(), metaFile))
	if err := json.Unmarshal(b, &m); err != nil || m.KeyID != "k" || m.Who != "Claude" {
		t.Fatalf("meta = %+v, %v", m, err)
	}
}

func TestClosedStoreRecordsNothing(t *testing.T) {
	f := newFixture(t)
	f.s.Close()
	v := f.s.Visit(1, "k", "Claude", wire.LevelLook)
	v.Connected()
	if visits, _ := f.s.List("", 0); len(visits) != 0 || len(f.starts) != 0 {
		t.Fatalf("a closed store recorded %+v", visits)
	}
}

// Whatever support sends, every recorded step is the contract's (the owner's list is read strictly).
func TestStepsAreCleanedToTheContract(t *testing.T) {
	f := newFixture(t)
	v := f.s.Visit(1, "k", "Claude", wire.LevelFix)
	v.Connected()
	for _, st := range []wire.Step{
		{Kind: wire.StepExec, Line: wire.Ptr("echo one\n\techo two\x1b[2J‮")},
		{Kind: wire.StepExec, Line: wire.Ptr("\x00\x01")},
		{Kind: wire.StepRefused, Reason: wire.Ptr(protocol.RemoteHelpRefusal(wire.ReasonLimit)), Line: wire.Ptr("\x01")},
		{Kind: wire.StepForward, Target: wire.Ptr("é:1\n"), Bytes: wire.Ptr(int64(3))},
		{Kind: wire.StepLook, Command: wire.Ptr(protocol.LookCommandLogs), Units: []string{"whombat-voice", "-x", "a b"}},
		{Kind: wire.StepRestart, Units: []string{"--force"}},
	} {
		v.Step(st)
	}
	visits, err := f.s.List("", 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, st := range visits[0].Steps {
		if !wire.StepValid(st) {
			t.Errorf("not the contract's: %+v", st)
		}
		if st.Line != nil && strings.ContainsAny(*st.Line, "\n\t\x1b‮\x00") {
			t.Errorf("line kept control characters: %q", *st.Line)
		}
		if st.Target != nil && *st.Target != "?:1?" {
			t.Errorf("target %q", *st.Target)
		}
	}
	if got := kinds(visits[0].Steps); got != "connected,exec,exec,refused,forward,look,refused" {
		t.Fatalf("steps = %s", got)
	}
	if u := visits[0].Steps[5].Units; len(u) != 1 || u[0] != "whombat-voice" {
		t.Fatalf("units = %v", u)
	}
}
