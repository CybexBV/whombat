// Package events is the support service's event log (SupportEvent, RH-08): grants, stops, expiries, visits and
// lock-outs, numbered by a seq that keeps rising across restarts (the runtime's follower keeps its cursor), the newest
// Keep of them on disk, read by a long poll.
package events

import (
	"context"
	"encoding/json"
	"os"
	"sync"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/atomicfile"
	"github.com/CybexBV/whombat/appliance/support/internal/wire"
)

// Keep is how many events the log holds; an answer carries all of them after its cursor, so Next is always the newest.
const Keep = 200

type file struct {
	V      int          `json:"v"`
	Seq    int64        `json:"seq"`
	Events []wire.Event `json:"events"`
}

// Log is the event log. The zero value isn't usable: Open it.
type Log struct {
	mu     sync.Mutex
	path   string
	now    func() time.Time
	seq    int64
	events []wire.Event
	added  chan struct{} // closed and replaced on every Add
	logf   func(string, ...any)
}

// Open reads the log at path (absent: a new log). A file it can't read starts a new log after the seq it had, when it
// can tell, so a follower's cursor is never ahead of a fresh start by accident.
func Open(path string, now func() time.Time, logf func(string, ...any)) *Log {
	l := &Log{path: path, now: now, added: make(chan struct{}), logf: logf}
	b, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			logf("whombat-support: events: %v (a new log)", err)
		}
		return l
	}
	var f file
	if err := json.Unmarshal(b, &f); err != nil || f.V != 1 || f.Seq < 0 {
		logf("whombat-support: events: the log isn't readable (a new log)")
		return l
	}
	l.seq = f.Seq
	for _, e := range f.Events {
		if e.Seq > 0 && e.Seq <= f.Seq {
			l.events = append(l.events, e)
		}
	}
	if len(l.events) > Keep {
		l.events = l.events[len(l.events)-Keep:]
	}
	return l
}

// Add numbers e, stamps it and keeps it; it returns the event as stored.
func (l *Log) Add(e wire.Event) wire.Event {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.seq++
	e.Seq = l.seq
	if e.At == "" {
		e.At = l.now().UTC().Format(time.RFC3339)
	}
	l.events = append(l.events, e)
	if len(l.events) > Keep {
		l.events = l.events[len(l.events)-Keep:]
	}
	if err := atomicfile.WriteFile(l.path, mustJSON(file{V: 1, Seq: l.seq, Events: l.events}), 0o600); err != nil {
		l.logf("whombat-support: events: can't save the log: %v", err)
	}
	close(l.added)
	l.added = make(chan struct{})
	return e
}

// After answers the events after seq after, waiting up to wait for one when there is none yet. Next is always the
// newest seq: a cursor ahead of it (the state directory was wiped) shows itself to the follower.
func (l *Log) After(ctx context.Context, after int64, wait time.Duration) wire.Events {
	var timer <-chan time.Time
	if wait > 0 {
		t := time.NewTimer(wait)
		defer t.Stop()
		timer = t.C
	}
	for {
		l.mu.Lock()
		out := wire.Events{Events: []wire.Event{}, Next: l.seq}
		for _, e := range l.events {
			if e.Seq > after {
				out.Events = append(out.Events, e)
			}
		}
		added := l.added
		l.mu.Unlock()
		if len(out.Events) > 0 || after > out.Next || timer == nil {
			return out
		}
		select {
		case <-added:
		case <-timer:
			timer = nil
		case <-ctx.Done():
			return out
		}
	}
}

// Seq is the newest seq.
func (l *Log) Seq() int64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.seq
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}
