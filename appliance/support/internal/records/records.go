// Package records is the owner's record of support visits (Whombat RH-07; John confirmed the design on 2026-10-21:
// “Build as designed”). Owners read it in Settings → This Whombat → About (“What support did”) through the runtime;
// it never leaves the box, and only the runtime (for owners) and root may read it.
//
// One directory per visit under Dir, 0700: meta.json (who, level, when, counts), steps.jsonl (one wire.Step per line,
// at most StepsPerVisit) and transcript.txt (what “Look and fix” commands printed, at most TranscriptBytesPerVisit;
// typed input is never written). A visit is one support certificate (its serial): it starts with the first
// connection, and ends VisitIdleS after the last connection closed, when the grant ends (EndOpen) or when the service
// stops (Close). Ended visits are kept KeepDays and within KeepBytes in all.
package records

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/CybexBV/whombat/appliance/helper/pkg/atomicfile"
	"github.com/CybexBV/whombat/appliance/support/internal/wire"
	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// ErrNotFound is a visit, or a transcript, that isn't there.
var ErrNotFound = errors.New("records: no such visit")

const (
	metaFile       = "meta.json"
	stepsFile      = "steps.jsonl"
	transcriptFile = "transcript.txt"
	maxStepLine    = 64 << 10
	maxUnits       = 8
	maxTarget      = 200
	defaultList    = 10
	maxList        = 20
)

// A visit id sorts by time: the start in UTC and eight random hex digits.
var idPattern = regexp.MustCompile(`^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$`)

// A unit name in a step (REMOTE_HELP_UNIT_RE).
var unitPattern = regexp.MustCompile(`^[A-Za-z0-9@._-]{1,80}$`)

// Meta is a visit's summary, as meta.json keeps it. KeyID is the certificate's whole key id (who and the operator it
// was issued to); it stays on the box for accountability and isn't on the wire.
type Meta struct {
	V               int        `json:"v"`
	ID              string     `json:"id"`
	Serial          uint64     `json:"serial"`
	KeyID           string     `json:"keyId"`
	Who             string     `json:"who"`
	Level           string     `json:"level"`
	StartedAt       time.Time  `json:"startedAt"`
	EndedAt         *time.Time `json:"endedAt"`
	Connected       bool       `json:"connected"` // a connection was made (a visit can hold only refusals)
	Steps           int        `json:"steps"`
	StepsDropped    int        `json:"stepsDropped"`
	TranscriptBytes int64      `json:"transcriptBytes"`
	TranscriptCut   bool       `json:"transcriptCut"`
}

// Options of a Store. OnStart is called when a visit's first connection opens, OnEnd when a visit that had one ends;
// both outside the Store's lock.
type Options struct {
	Dir     string
	Now     func() time.Time
	After   func(d time.Duration, f func()) (stop func() bool) // time.AfterFunc unless a test sets it
	OnStart func(Meta)
	OnEnd   func(Meta)
	Logf    func(string, ...any)
}

// Store is the record of visits. The zero value isn't usable: Open it.
type Store struct {
	o      Options
	mu     sync.Mutex
	open   map[uint64]*Visit // by certificate serial, while the visit lasts
	closed bool
}

// Visit is one certificate's visit. Its methods do nothing once it has ended.
type Visit struct {
	s          *Store
	meta       Meta
	dir        string
	conns      int
	ended      bool
	stopIdle   func() bool
	steps      *os.File
	transcript *os.File
}

// Open opens the record in o.Dir (created 0700). Visits a crash left open are ended at their last write and reported to
// OnEnd; old ones are pruned.
func Open(o Options) (*Store, error) {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.After == nil {
		o.After = func(d time.Duration, f func()) func() bool { return time.AfterFunc(d, f).Stop }
	}
	if o.Logf == nil {
		o.Logf = func(string, ...any) {}
	}
	if o.OnStart == nil {
		o.OnStart = func(Meta) {}
	}
	if o.OnEnd == nil {
		o.OnEnd = func(Meta) {}
	}
	if err := os.MkdirAll(o.Dir, 0o700); err != nil {
		return nil, err
	}
	if err := os.Chmod(o.Dir, 0o700); err != nil {
		return nil, err
	}
	s := &Store{o: o, open: map[uint64]*Visit{}}
	for _, m := range s.recover() {
		o.OnEnd(m)
	}
	if err := s.Prune(); err != nil {
		o.Logf("whombat-support: records: prune: %v", err)
	}
	return s, nil
}

// Visit returns the open visit of this certificate, or starts a new one. who is the name owners see (≤ NameChars),
// level the grant's level when the visit starts.
func (s *Store) Visit(serial uint64, keyID, who, level string) *Visit {
	s.mu.Lock()
	defer s.mu.Unlock()
	if v := s.open[serial]; v != nil && !v.ended {
		return v
	}
	now := s.o.Now().UTC().Truncate(time.Second)
	v := &Visit{s: s, meta: Meta{V: 1, ID: newID(now), Serial: serial, KeyID: clip(keyID, 200), Who: clip(who, wire.NameChars),
		Level: level, StartedAt: now}}
	v.dir = filepath.Join(s.o.Dir, v.meta.ID)
	if s.closed {
		v.ended = true
		return v
	}
	if err := os.Mkdir(v.dir, 0o700); err != nil {
		s.o.Logf("whombat-support: records: visit %s: %v", v.meta.ID, err)
	}
	v.steps = s.openAppend(filepath.Join(v.dir, stepsFile))
	v.transcript = s.openAppend(filepath.Join(v.dir, transcriptFile))
	s.saveMeta(v)
	s.open[serial] = v
	// A visit that never gets a connection (a refused certificate holder, say) still ends after the idle time.
	v.stopIdle = s.o.After(wire.VisitIdleS*time.Second, func() { s.endIdle(v) })
	return v
}

// Connected lists the visits with a connection open now (SupportState.connected), oldest first.
func (s *Store) Connected() []wire.Connected {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []wire.Connected{}
	for _, v := range s.open {
		if v.conns > 0 {
			out = append(out, wire.Connected{VisitID: v.meta.ID, Who: v.meta.Who, Since: stamp(v.meta.StartedAt)})
		}
	}
	slices.SortFunc(out, func(a, b wire.Connected) int { return strings.Compare(a.VisitID, b.VisitID) })
	return out
}

// EndOpen ends every open visit now: the grant ended (stopped, expired or locked out).
func (s *Store) EndOpen() {
	s.mu.Lock()
	var ended []Meta
	for _, v := range s.open {
		if m, ok := s.end(v); ok {
			ended = append(ended, m)
		}
	}
	s.mu.Unlock()
	for _, m := range ended {
		s.o.OnEnd(m)
	}
}

// Close ends every open visit (the service stops) and refuses new ones.
func (s *Store) Close() {
	s.EndOpen()
	s.mu.Lock()
	s.closed = true
	s.mu.Unlock()
}

// List answers GET /v1/visits: visits newest first, older than the visit before when it is set, at most limit (1…20;
// 0 means 10). Each carries its newest StepsShown steps, oldest first.
func (s *Store) List(before string, limit int) ([]wire.Visit, error) {
	if before != "" && !idPattern.MatchString(before) {
		return nil, ErrNotFound
	}
	if limit <= 0 {
		limit = defaultList
	}
	limit = min(limit, maxList)
	ids, err := s.ids()
	if err != nil {
		return nil, err
	}
	slices.Reverse(ids)
	out := []wire.Visit{}
	for _, id := range ids {
		if len(out) == limit {
			break
		}
		if before != "" && id >= before {
			continue
		}
		m, ok := s.meta(id)
		if !ok {
			continue
		}
		shown, total := s.readSteps(id)
		w := wire.Visit{ID: m.ID, Who: m.Who, Level: protocol.RemoteHelpLevel(m.Level), StartedAt: stamp(m.StartedAt), Steps: shown,
			Truncated: total > len(shown) || m.StepsDropped > 0 || m.TranscriptCut, TranscriptBytes: m.TranscriptBytes}
		if m.EndedAt != nil {
			e := stamp(*m.EndedAt)
			w.EndedAt = &e
		}
		out = append(out, w)
	}
	return out, nil
}

// Transcript opens a visit's transcript (GET /v1/visits/{id}/transcript); ErrNotFound when the visit or its transcript
// isn't there or is empty.
func (s *Store) Transcript(id string) (io.ReadCloser, error) {
	if !idPattern.MatchString(id) {
		return nil, ErrNotFound
	}
	f, err := os.Open(filepath.Join(s.o.Dir, id, transcriptFile))
	if err != nil {
		return nil, ErrNotFound
	}
	if st, err := f.Stat(); err != nil || st.Size() == 0 {
		f.Close()
		return nil, ErrNotFound
	}
	return f, nil
}

// Prune removes ended visits older than KeepDays, then the oldest ended ones until all fit in KeepBytes.
func (s *Store) Prune() error {
	ids, err := s.ids()
	if err != nil {
		return err
	}
	cutoff := s.o.Now().Add(-wire.KeepDays * 24 * time.Hour)
	type kept struct {
		id    string
		bytes int64
	}
	var ended []kept
	var total int64
	for _, id := range ids {
		size := dirSize(filepath.Join(s.o.Dir, id))
		total += size
		m, ok := s.meta(id)
		if !ok || m.EndedAt == nil || s.isOpen(id) {
			continue
		}
		if m.EndedAt.Before(cutoff) {
			total -= size
			s.remove(id)
			continue
		}
		ended = append(ended, kept{id, size})
	}
	for _, k := range ended { // oldest first: ids sort by time
		if total <= wire.KeepBytes {
			break
		}
		total -= k.bytes
		s.remove(k.id)
	}
	return nil
}

// ID is the visit's id.
func (v *Visit) ID() string { return v.meta.ID }

// Connected notes a connection opening. The first one starts the visit: a “connected” step and OnStart.
func (v *Visit) Connected() {
	s := v.s
	s.mu.Lock()
	if v.ended {
		s.mu.Unlock()
		return
	}
	v.conns++
	if v.stopIdle != nil {
		v.stopIdle()
		v.stopIdle = nil
	}
	first := !v.meta.Connected
	if first {
		v.meta.Connected = true
		s.appendStep(v, wire.Step{Kind: wire.StepConnected})
		s.saveMeta(v)
	}
	m := v.meta
	s.mu.Unlock()
	if first {
		s.o.OnStart(m)
	}
}

// Left notes a connection closing; with none left the visit ends after the idle time unless another opens.
func (v *Visit) Left() {
	s := v.s
	s.mu.Lock()
	defer s.mu.Unlock()
	if v.ended || v.conns == 0 {
		return
	}
	v.conns--
	if v.conns == 0 && v.stopIdle == nil {
		v.stopIdle = s.o.After(wire.VisitIdleS*time.Second, func() { s.endIdle(v) })
	}
}

// Step records one thing support did. Fields are clipped to the contract's limits; past StepsPerVisit steps are counted
// but not written.
func (v *Visit) Step(st wire.Step) {
	s := v.s
	s.mu.Lock()
	defer s.mu.Unlock()
	if v.ended {
		return
	}
	s.appendStep(v, st)
}

// Transcript is where “Look and fix” output goes: what commands and command lines printed, never what was typed. It
// never fails the caller: past TranscriptBytesPerVisit, or when the disk refuses, the rest is dropped and the visit is
// marked cut.
func (v *Visit) Transcript() io.Writer { return transcriptWriter{v} }

type transcriptWriter struct{ v *Visit }

func (w transcriptWriter) Write(p []byte) (int, error) {
	v, s := w.v, w.v.s
	s.mu.Lock()
	defer s.mu.Unlock()
	if v.ended || v.transcript == nil {
		return len(p), nil
	}
	room := wire.TranscriptBytesPerVisit - v.meta.TranscriptBytes
	chunk := p
	if int64(len(chunk)) > room {
		chunk = chunk[:max(room, 0)]
		v.meta.TranscriptCut = true
	}
	if len(chunk) > 0 {
		n, err := v.transcript.Write(chunk)
		v.meta.TranscriptBytes += int64(n)
		if err != nil {
			v.meta.TranscriptCut = true
			s.o.Logf("whombat-support: records: visit %s: transcript: %v", v.meta.ID, err)
		}
	}
	return len(p), nil
}

// appendStep writes one step; s.mu is held.
func (s *Store) appendStep(v *Visit, st wire.Step) {
	if v.meta.Steps >= wire.StepsPerVisit || v.steps == nil {
		v.meta.StepsDropped++
		return
	}
	st = cleanStep(st)
	st.At = stamp(s.o.Now())
	b, err := json.Marshal(st)
	if err == nil {
		_, err = v.steps.Write(append(b, '\n'))
	}
	if err != nil {
		v.meta.StepsDropped++
		s.o.Logf("whombat-support: records: visit %s: step: %v", v.meta.ID, err)
		return
	}
	v.meta.Steps++
}

// cleanStep makes a step the contract's, whatever support typed: the owner's list is read strictly (a step that isn't
// would hide a whole page of visits), and visitors choose command lines, forward targets and channel names. The line
// becomes one line of display text (local.HostText), the target printable ASCII, units only well-formed names; a step
// that still isn't the contract's is kept as a refusal with bad arguments, so it is still seen.
func cleanStep(st wire.Step) wire.Step {
	if st.Line != nil {
		if line := local.HostText(*st.Line, wire.CommandLineChars); line != "" {
			st.Line = &line
		} else {
			st.Line = wire.Ptr("…")
		}
	}
	if st.Target != nil {
		st.Target = wire.Ptr(asciiText(*st.Target, maxTarget))
	}
	units := st.Units[:0:0]
	for _, u := range st.Units {
		if unitPattern.MatchString(u) && !strings.HasPrefix(u, "-") && len(units) < maxUnits {
			units = append(units, u)
		}
	}
	st.Units = units
	if len(st.Units) == 0 {
		st.Units = nil
	}
	if !wire.StepValid(st) {
		return wire.Step{Kind: wire.StepRefused, Reason: wire.Ptr(protocol.RemoteHelpRefusal(wire.ReasonBadArguments))}
	}
	return st
}

// asciiText keeps printable ASCII, a '?' for anything else, at most n bytes, never empty.
func asciiText(s string, n int) string {
	b := make([]byte, 0, min(len(s), n))
	for _, r := range s {
		if len(b) == n {
			break
		}
		if r >= 0x20 && r <= 0x7e {
			b = append(b, byte(r))
		} else {
			b = append(b, '?')
		}
	}
	if len(b) == 0 {
		return "?"
	}
	return string(b)
}

func (s *Store) endIdle(v *Visit) {
	s.mu.Lock()
	if v.conns > 0 {
		s.mu.Unlock()
		return
	}
	m, ok := s.end(v)
	s.mu.Unlock()
	if ok {
		s.o.OnEnd(m)
	}
	if err := s.Prune(); err != nil {
		s.o.Logf("whombat-support: records: prune: %v", err)
	}
}

// end ends v; s.mu is held. It reports the visit's meta and whether OnEnd is due (it had a connection).
func (s *Store) end(v *Visit) (Meta, bool) {
	if v.ended {
		return Meta{}, false
	}
	if v.stopIdle != nil {
		v.stopIdle()
		v.stopIdle = nil
	}
	if v.meta.Connected {
		s.appendStep(v, wire.Step{Kind: wire.StepLeft})
	}
	v.ended = true
	now := s.o.Now().UTC().Truncate(time.Second)
	v.meta.EndedAt = &now
	s.saveMeta(v)
	for _, f := range []*os.File{v.steps, v.transcript} {
		if f != nil {
			f.Close()
		}
	}
	delete(s.open, v.meta.Serial)
	return v.meta, v.meta.Connected
}

// recover ends the visits a crash left open, at their last write, and returns those that had a connection.
func (s *Store) recover() []Meta {
	ids, err := s.ids()
	if err != nil {
		s.o.Logf("whombat-support: records: %v", err)
		return nil
	}
	var out []Meta
	for _, id := range ids {
		m, ok := s.readMeta(id)
		if !ok || m.EndedAt != nil {
			continue
		}
		dir := filepath.Join(s.o.Dir, id)
		last := m.StartedAt
		for _, name := range []string{metaFile, stepsFile, transcriptFile} {
			if st, err := os.Stat(filepath.Join(dir, name)); err == nil && st.ModTime().After(last) {
				last = st.ModTime()
			}
		}
		last = last.UTC().Truncate(time.Second)
		m.EndedAt = &last
		_, m.Steps = s.readSteps(id)
		if st, err := os.Stat(filepath.Join(dir, transcriptFile)); err == nil {
			m.TranscriptBytes = st.Size()
		}
		v := &Visit{s: s, meta: m, dir: dir}
		s.saveMeta(v)
		if m.Connected {
			out = append(out, m)
		}
	}
	return out
}

// ids lists the visit directories, oldest first.
func (s *Store) ids() ([]string, error) {
	entries, err := os.ReadDir(s.o.Dir)
	if err != nil {
		return nil, err
	}
	var ids []string
	for _, e := range entries {
		if e.IsDir() && idPattern.MatchString(e.Name()) {
			ids = append(ids, e.Name())
		}
	}
	slices.Sort(ids)
	return ids, nil
}

// meta is a visit's summary: from memory while it is open, else from meta.json.
func (s *Store) meta(id string) (Meta, bool) {
	s.mu.Lock()
	for _, v := range s.open {
		if v.meta.ID == id {
			m := v.meta
			s.mu.Unlock()
			return m, true
		}
	}
	s.mu.Unlock()
	return s.readMeta(id)
}

func (s *Store) isOpen(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, v := range s.open {
		if v.meta.ID == id {
			return true
		}
	}
	return false
}

func (s *Store) readMeta(id string) (Meta, bool) {
	b, err := os.ReadFile(filepath.Join(s.o.Dir, id, metaFile))
	if err != nil {
		return Meta{}, false
	}
	var m Meta
	if json.Unmarshal(b, &m) != nil || m.V != 1 || m.ID != id {
		return Meta{}, false
	}
	return m, true
}

// readSteps returns the newest StepsShown steps, oldest first, and how many readable steps there are.
func (s *Store) readSteps(id string) ([]wire.Step, int) {
	f, err := os.Open(filepath.Join(s.o.Dir, id, stepsFile))
	if err != nil {
		return []wire.Step{}, 0
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 4096), maxStepLine)
	ring := make([]wire.Step, 0, wire.StepsShown)
	total := 0
	for sc.Scan() {
		var st wire.Step
		if json.Unmarshal(sc.Bytes(), &st) != nil || st.Kind == "" {
			continue
		}
		total++
		if len(ring) == wire.StepsShown {
			ring = append(ring[:0:0], ring[1:]...)
		}
		ring = append(ring, st)
	}
	return ring, total
}

func (s *Store) saveMeta(v *Visit) {
	b, err := json.Marshal(v.meta)
	if err == nil {
		err = atomicfile.WriteFile(filepath.Join(v.dir, metaFile), b, 0o600)
	}
	if err != nil {
		s.o.Logf("whombat-support: records: visit %s: %v", v.meta.ID, err)
	}
}

func (s *Store) openAppend(path string) *os.File {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		s.o.Logf("whombat-support: records: %v", err)
		return nil
	}
	return f
}

func (s *Store) remove(id string) {
	if !idPattern.MatchString(id) {
		return
	}
	if err := os.RemoveAll(filepath.Join(s.o.Dir, id)); err != nil {
		s.o.Logf("whombat-support: records: remove %s: %v", id, err)
	}
}

func dirSize(dir string) int64 {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	var n int64
	for _, e := range entries {
		if info, err := e.Info(); err == nil && info.Mode().IsRegular() {
			n += info.Size()
		}
	}
	return n
}

func newID(t time.Time) string {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return t.UTC().Format("20060102T150405Z") + "-" + hex.EncodeToString(b[:])
}

func stamp(t time.Time) string { return t.UTC().Format(time.RFC3339) }

// clip keeps at most n characters, cutting on a rune boundary.
func clip(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n])
}
