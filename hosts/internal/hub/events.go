package hub

import (
	"encoding/json"
	"sync"
	"time"
)

// Event is one Server-Sent Event.
type Event struct {
	ID   uint64
	Name string
	Data []byte // JSON
	// User restricts delivery to one user id (0 = everyone).
	User int64
	// MinRank restricts delivery to roles of at least this rank (0 =
	// viewers and up).
	MinRank int
}

// Bus fans events out to SSE subscribers and keeps a ring buffer so a
// reconnecting client (Last-Event-ID) gets what it missed. Event ids start
// at the hub's start time in microseconds, so they increase across restarts
// and an id from a previous run is always older than the buffer.
type Bus struct {
	mu   sync.Mutex
	seq  uint64
	ring []Event
	head int // next write position
	n    int
	subs map[*Sub]struct{}
}

// Sub is one subscriber.
type Sub struct {
	C       chan Event
	user    int64
	rank    int
	created time.Time
	once    sync.Once
	done    chan struct{}
}

// MaxSubsPerUser bounds the open event streams of one user (each costs a
// goroutine and a session check every 20 s); the oldest is dropped.
const MaxSubsPerUser = 16

func (s *Sub) wants(ev Event) bool {
	return (ev.User == 0 || ev.User == s.user) && s.rank >= ev.MinRank
}

// Done is closed when the bus dropped the subscriber (too slow).
func (s *Sub) Done() <-chan struct{} { return s.done }

const busRing = 4096

// NewBus returns an empty bus.
func NewBus() *Bus {
	return &Bus{seq: uint64(time.Now().UnixMicro()), ring: make([]Event, busRing), subs: map[*Sub]struct{}{}}
}

// Publish sends an event to everyone.
func (b *Bus) Publish(name string, v any) { b.PublishTo(0, name, v) }

// PublishTo sends an event to one user (0 = everyone).
func (b *Bus) PublishTo(user int64, name string, v any) { b.publish(user, 0, name, v) }

// PublishMinRank sends an event to users whose role has at least rank
// (store.RoleRank; admin-only events such as enrollment.pending).
func (b *Bus) PublishMinRank(rank int, name string, v any) { b.publish(0, rank, name, v) }

func (b *Bus) publish(user int64, rank int, name string, v any) {
	data, err := json.Marshal(v)
	if err != nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.seq++
	ev := Event{ID: b.seq, Name: name, Data: data, User: user, MinRank: rank}
	b.ring[b.head] = ev
	b.head = (b.head + 1) % len(b.ring)
	if b.n < len(b.ring) {
		b.n++
	}
	for s := range b.subs {
		if !s.wants(ev) {
			continue
		}
		select {
		case s.C <- ev:
		default:
			// Too slow: drop it; the client reconnects with Last-Event-ID.
			b.drop(s)
		}
	}
}

func (b *Bus) drop(s *Sub) {
	delete(b.subs, s)
	s.once.Do(func() { close(s.done) })
}

// Subscribe registers a subscriber for a user. With lastID > 0 it returns
// the buffered events after lastID; gap is true when events were lost
// (lastID older than the buffer), in which case the client must refetch.
func (b *Bus) Subscribe(user int64, rank int, lastID uint64) (s *Sub, backlog []Event, gap bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	s = &Sub{C: make(chan Event, 512), user: user, rank: rank, created: time.Now(), done: make(chan struct{})}
	var mine []*Sub
	for o := range b.subs {
		if o.user == user {
			mine = append(mine, o)
		}
	}
	for len(mine) >= MaxSubsPerUser {
		oldest := 0
		for i, o := range mine {
			if o.created.Before(mine[oldest].created) {
				oldest = i
			}
		}
		b.drop(mine[oldest])
		mine = append(mine[:oldest], mine[oldest+1:]...)
	}
	b.subs[s] = struct{}{}
	if lastID == 0 || lastID >= b.seq {
		return s, nil, false
	}
	oldest := b.seq - uint64(b.n) + 1
	if lastID+1 < oldest {
		// Events were lost: the client refetches everything (event "resync").
		return s, nil, true
	}
	for i := 0; i < b.n; i++ {
		ev := b.ring[(b.head-b.n+i+len(b.ring))%len(b.ring)]
		if ev.ID > lastID && s.wants(ev) {
			backlog = append(backlog, ev)
		}
	}
	return s, backlog, gap
}

// DropUser ends every event stream of a user (signed out, deleted, or a
// changed role: a stream keeps the role it was opened with). The browser
// reconnects and is authorized again.
func (b *Bus) DropUser(user int64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for s := range b.subs {
		if s.user == user {
			b.drop(s)
		}
	}
}

// Unsubscribe removes a subscriber.
func (b *Bus) Unsubscribe(s *Sub) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.drop(s)
}

// LastID returns the id of the newest event.
func (b *Bus) LastID() uint64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.seq
}
