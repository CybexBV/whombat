package rules

import (
	"crypto/rand"
	"encoding/hex"
	"sort"
	"sync"
	"time"
)

// Alert states.
const (
	AlertOpen     = "open"
	AlertResolved = "resolved"
)

// Alert is a firing (open) or resolved alert.
type Alert struct {
	ID       string
	Server   string
	Key      string // rule:entity, stable per server
	Rule     string
	Entity   string
	Severity string
	Text
	Link       string
	StatusNote string
	State      string
	OpenedAt   time.Time
	ResolvedAt *time.Time
	// ClearAfter is copied from the condition (not persisted).
	ClearAfter time.Duration
	// Ack is set while someone acknowledged (or snoozed) the alert.
	Ack *Ack
}

// Ack is an acknowledgement: the alert stays open but stops asking for
// attention (no reminders, not counted in the badge). With Until set it is
// a snooze: it lapses at that time if the alert is still open.
type Ack struct {
	At    time.Time
	By    string
	Note  string
	Until *time.Time
}

// Active reports whether the acknowledgement holds at now.
func (a *Ack) Active(now time.Time) bool { return a != nil && (a.Until == nil || now.Before(*a.Until)) }

// Changes are the alert transitions produced by one evaluation.
type Changes struct {
	Opened   []Alert
	Updated  []Alert // open alerts whose text or severity changed
	Resolved []Alert
	// Severity are the open alerts (also in Updated) whose severity changed
	// within their rule (ups.on_battery, ceph.health). A rise ends the
	// acknowledgement: AckEnded are those alerts' ids.
	Severity []Alert
	AckEnded []string
}

// Empty reports whether nothing changed.
func (c Changes) Empty() bool { return len(c.Opened)+len(c.Updated)+len(c.Resolved) == 0 }

type track struct {
	since    time.Time // condition true since (pending until held >= For)
	lastTrue time.Time
}

// Engine is the alert state machine: a condition is pending until it has
// held for its rule's duration, then the alert fires (open); it resolves
// when the condition no longer holds (after the rule's ClearAfter). When a
// critical and a warning alert concern the same entity (temp_high and
// temp_critical for one sensor), only the critical one is open.
type Engine struct {
	mu     sync.Mutex
	tracks map[string]map[string]*track // server -> key -> track
	open   map[string]map[string]*Alert // server -> key -> open alert
	NewID  func() string
	// Off reports whether a rule is switched off for a server's entity (the
	// server's watch settings, HS-195; nil: nothing is). Its conditions are
	// not evaluated, and an open alert of it resolves at once. Never asked
	// for hub-level alerts (server "").
	Off func(server, rule, entity string) bool
}

// NewEngine returns an empty engine.
func NewEngine() *Engine {
	return &Engine{
		tracks: map[string]map[string]*track{},
		open:   map[string]map[string]*Alert{},
		NewID:  func() string { return "al_" + randHex(6) },
	}
}

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// Load restores open alerts (after a restart).
func (e *Engine) Load(alerts []Alert) {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, a := range alerts {
		if a.State != AlertOpen {
			continue
		}
		a := a
		m := e.open[a.Server]
		if m == nil {
			m = map[string]*Alert{}
			e.open[a.Server] = m
		}
		m[a.Key] = &a
	}
}

// Evaluate applies the currently true conditions of a server. Only open
// alerts whose rule satisfies managed can be resolved by this call (so the
// report rules and the heartbeat rule can be evaluated independently).
func (e *Engine) Evaluate(server string, conds []Condition, managed func(rule string) bool, now time.Time) Changes {
	return e.EvaluateHolding(server, conds, managed, nil, now)
}

// EvaluateHolding leaves alerts for entities without fresh observations in their current state.
func (e *Engine) EvaluateHolding(server string, conds []Condition, managed func(rule string) bool, held map[string]bool, now time.Time) Changes {
	e.mu.Lock()
	defer e.mu.Unlock()
	var ch Changes
	tr := e.tracks[server]
	if tr == nil {
		tr = map[string]*track{}
		e.tracks[server] = tr
	}
	open := e.open[server]
	if open == nil {
		open = map[string]*Alert{}
		e.open[server] = open
	}
	off := func(rule, entity string) bool { return server != "" && e.Off != nil && e.Off(server, rule, entity) }
	if server != "" && e.Off != nil {
		kept := make([]Condition, 0, len(conds))
		for _, c := range conds {
			if !off(c.Rule, c.Entity) {
				kept = append(kept, c)
			}
		}
		conds = kept
	}

	present := map[string]Condition{}
	for _, c := range conds {
		k := c.Key()
		present[k] = c
		t := tr[k]
		if t == nil {
			t = &track{since: now}
			if a := open[k]; a != nil {
				// Restored alert: assume it held since it opened minus the rule duration.
				t.since = a.OpenedAt.Add(-c.For)
			}
			tr[k] = t
		}
		if !c.Since.IsZero() {
			t.since = c.Since
		}
		t.lastTrue = now
	}

	// Desired firing set.
	desired := map[string]Condition{}
	for k, c := range present {
		if open[k] != nil || now.Sub(tr[k].since) >= c.For {
			desired[k] = c
		}
	}
	// A critical alert supersedes a warning for the same entity: consider the
	// critical conditions that fire now and the open critical alerts still in
	// their clear-after window.
	critical := map[string]bool{}
	for _, c := range desired {
		if c.Severity == SevCritical {
			critical[c.Rule[:dot(c.Rule)]+"|"+c.Entity] = true
		}
	}
	for k, a := range open {
		if _, ok := desired[k]; ok || a.Severity != SevCritical || off(a.Rule, a.Entity) {
			continue
		}
		if t := tr[k]; t != nil && now.Sub(t.lastTrue) < a.ClearAfter {
			critical[a.Rule[:dot(a.Rule)]+"|"+a.Entity] = true
		}
	}
	suppressed := map[string]bool{}
	for k, c := range desired {
		if c.Severity != SevCritical && critical[c.Rule[:dot(c.Rule)]+"|"+c.Entity] {
			delete(desired, k)
			suppressed[k] = true
		}
	}

	keys := make([]string, 0, len(desired))
	for k := range desired {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		c := desired[k]
		txt := c.Render(now.Sub(tr[k].since))
		if a := open[k]; a != nil {
			a.ClearAfter = c.ClearAfter
			if a.Text != txt || a.Severity != c.Severity || a.Link != c.Link || a.StatusNote != c.StatusNote {
				sevChanged := a.Severity != c.Severity
				// Worse than what was acknowledged: it asks for attention
				// again (HS-193).
				if sevChanged && SeverityRank(c.Severity) < SeverityRank(a.Severity) && a.Ack != nil {
					a.Ack = nil
					ch.AckEnded = append(ch.AckEnded, a.ID)
				}
				a.Text, a.Severity, a.Link, a.StatusNote = txt, c.Severity, c.Link, c.StatusNote
				ch.Updated = append(ch.Updated, *a)
				if sevChanged {
					ch.Severity = append(ch.Severity, *a)
				}
			}
			continue
		}
		opened := now
		if !c.Since.IsZero() {
			opened = c.Since
		}
		a := &Alert{
			ID: e.NewID(), Server: server, Key: k, Rule: c.Rule, Entity: c.Entity, Severity: c.Severity,
			Text: txt, Link: c.Link, StatusNote: c.StatusNote, State: AlertOpen, OpenedAt: opened,
			ClearAfter: c.ClearAfter,
		}
		open[k] = a
		ch.Opened = append(ch.Opened, *a)
	}

	// Resolve open alerts that no longer hold.
	okeys := make([]string, 0, len(open))
	for k := range open {
		okeys = append(okeys, k)
	}
	sort.Strings(okeys)
	for _, k := range okeys {
		a := open[k]
		if _, ok := desired[k]; ok || held[a.Entity] || !managed(a.Rule) {
			continue
		}
		t := tr[k]
		if !suppressed[k] && !off(a.Rule, a.Entity) && t != nil && now.Sub(t.lastTrue) < a.ClearAfter {
			continue
		}
		r := now
		a.State, a.ResolvedAt = AlertResolved, &r
		ch.Resolved = append(ch.Resolved, *a)
		delete(open, k)
	}

	// Forget tracks of conditions that are no longer true and not open.
	for k, t := range tr {
		if _, ok := present[k]; ok || held[k[len(ruleOfKey(k))+1:]] {
			continue
		}
		if c := open[k]; c != nil && now.Sub(t.lastTrue) < c.ClearAfter {
			continue
		}
		if r := ruleOfKey(k); managed(r) {
			delete(tr, k)
		}
	}
	return ch
}

func dot(rule string) int {
	for i := 0; i < len(rule); i++ {
		if rule[i] == '.' {
			return i
		}
	}
	return len(rule)
}

func ruleOfKey(k string) string {
	for i := 0; i < len(k); i++ {
		if k[i] == ':' {
			return k[:i]
		}
	}
	return k
}

// ResolveOff resolves at once the server's open alerts that Off switches
// off, whichever evaluation owns their rule, and forgets their tracks (a
// rule switched on again starts from scratch).
func (e *Engine) ResolveOff(server string, now time.Time) []Alert {
	e.mu.Lock()
	defer e.mu.Unlock()
	if server == "" || e.Off == nil {
		return nil
	}
	var out []Alert
	for k, a := range e.open[server] {
		if !e.Off(server, a.Rule, a.Entity) {
			continue
		}
		r := now
		a.State, a.ResolvedAt = AlertResolved, &r
		out = append(out, *a)
		delete(e.open[server], k)
		delete(e.tracks[server], k)
	}
	SortAlerts(out)
	return out
}

// SetAck sets (ack non-nil) or clears the acknowledgement of an open alert
// and returns the updated alert; ok is false when it is not open.
func (e *Engine) SetAck(server, id string, ack *Ack) (Alert, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, a := range e.open[server] {
		if a.ID == id {
			a.Ack = ack
			return *a, true
		}
	}
	return Alert{}, false
}

// ExpireAcks clears snoozes that lapsed at now and returns the alerts
// whose acknowledgement ended.
func (e *Engine) ExpireAcks(now time.Time) []Alert {
	e.mu.Lock()
	defer e.mu.Unlock()
	var out []Alert
	for _, m := range e.open {
		for _, a := range m {
			if a.Ack != nil && !a.Ack.Active(now) {
				a.Ack = nil
				out = append(out, *a)
			}
		}
	}
	return out
}

// Find returns an open alert by id.
func (e *Engine) Find(id string) (Alert, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, m := range e.open {
		for _, a := range m {
			if a.ID == id {
				return *a, true
			}
		}
	}
	return Alert{}, false
}

// Open returns the open alerts of a server, most severe first, then oldest.
func (e *Engine) Open(server string) []Alert {
	e.mu.Lock()
	defer e.mu.Unlock()
	var out []Alert
	for _, a := range e.open[server] {
		out = append(out, *a)
	}
	SortAlerts(out)
	return out
}

// AllOpen returns every open alert, most severe first, then oldest.
func (e *Engine) AllOpen() []Alert {
	e.mu.Lock()
	defer e.mu.Unlock()
	var out []Alert
	for _, m := range e.open {
		for _, a := range m {
			out = append(out, *a)
		}
	}
	SortAlerts(out)
	return out
}

// Forget drops all state of a server (deleted) and returns its open alerts
// marked resolved.
func (e *Engine) Forget(server string, now time.Time) []Alert {
	e.mu.Lock()
	defer e.mu.Unlock()
	var out []Alert
	for _, a := range e.open[server] {
		r := now
		a.State, a.ResolvedAt = AlertResolved, &r
		out = append(out, *a)
	}
	delete(e.open, server)
	delete(e.tracks, server)
	return out
}

// SortAlerts orders alerts most severe first, then by opened_at ascending,
// then by id.
func SortAlerts(a []Alert) {
	sort.SliceStable(a, func(i, j int) bool {
		if ri, rj := SeverityRank(a[i].Severity), SeverityRank(a[j].Severity); ri != rj {
			return ri < rj
		}
		if !a[i].OpenedAt.Equal(a[j].OpenedAt) {
			return a[i].OpenedAt.Before(a[j].OpenedAt)
		}
		return a[i].ID < a[j].ID
	})
}

// Banner picks the alert shown in the server's banner: the most severe open
// alert (ties: the most recent). ok is false when there is none.
func Banner(open []Alert) (Alert, bool) {
	if len(open) == 0 {
		return Alert{}, false
	}
	best := open[0]
	for _, a := range open[1:] {
		rb, ra := SeverityRank(best.Severity), SeverityRank(a.Severity)
		if ra < rb || (ra == rb && a.OpenedAt.After(best.OpenedAt)) {
			best = a
		}
	}
	return best, true
}

// StatusNote is the short reason shown next to a warning/offline status:
// the note of the most severe open alert.
func StatusNote(open []Alert) string {
	if a, ok := Banner(open); ok {
		return a.StatusNote
	}
	return ""
}
