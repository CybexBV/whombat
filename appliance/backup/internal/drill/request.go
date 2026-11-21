package drill

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/sys/unix"

	"github.com/CybexBV/whombat/appliance/backup/internal/state"
)

// Request is “Check this backup now” (BKO-07): the API queues it in <stateDir>/drill-request.json, whose existence
// starts the drill unit (its path unit); the drill takes the first only once it holds the run lock, so a request made
// while a backup runs waits for it instead of being lost. While requests are left the file stays, and the path unit
// starts the drill again for the next.
type Request struct {
	CheckpointID string    `json:"checkpointId"`
	Own          bool      `json:"own"`
	At           time.Time `json:"at"`
}

// queue is the file's form; a file holding one bare Request is read too (written before the queue).
type queue struct {
	Queue []Request `json:"queue"`
}

// RequestPath is the file the path unit watches.
func RequestPath(c *state.Config) string { return filepath.Join(c.StateDir, "drill-request.json") }

// withQueue runs fn on the queue under its own small lock (the API adds, the drill takes; neither waits for the
// run lock to do so) and writes the result back: removed when empty.
func withQueue(c *state.Config, fn func(q *queue)) error {
	lf, err := os.OpenFile(filepath.Join(c.StateDir, "drill-request.lock"), os.O_RDWR|os.O_CREATE|unix.O_NOFOLLOW, 0o600)
	if err != nil {
		return err
	}
	defer lf.Close()
	if err := unix.Flock(int(lf.Fd()), unix.LOCK_EX); err != nil {
		return err
	}
	defer func() { _ = unix.Flock(int(lf.Fd()), unix.LOCK_UN) }()
	q := readQueue(c)
	fn(q)
	if len(q.Queue) == 0 {
		if err := state.RemoveStateFile(RequestPath(c)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}
	return state.WriteJSON(RequestPath(c), q, 0o600)
}

func readQueue(c *state.Config) *queue {
	q := &queue{}
	b, err := state.ReadStateFile(RequestPath(c))
	if err != nil {
		return q
	}
	if json.Unmarshal(b, q) == nil && q.Queue != nil {
		return q
	}
	var one Request
	if json.Unmarshal(b, &one) == nil && one.CheckpointID != "" {
		q.Queue = []Request{one}
	}
	return q
}

// Enqueue adds a request (the same backup asked for twice is checked once).
func Enqueue(c *state.Config, r Request) error {
	return withQueue(c, func(q *queue) {
		for _, x := range q.Queue {
			if x.CheckpointID == r.CheckpointID && x.Own == r.Own {
				return
			}
		}
		q.Queue = append(q.Queue, r)
	})
}

// Pending says whether a request is waiting.
func Pending(c *state.Config) bool { return len(readQueue(c).Queue) > 0 }

// Take removes and returns the first request (nil when none). Call it holding the run lock.
func Take(c *state.Config) (*Request, error) {
	var out *Request
	err := withQueue(c, func(q *queue) {
		for len(q.Queue) > 0 && out == nil {
			r := q.Queue[0]
			q.Queue = q.Queue[1:]
			if r.CheckpointID != "" {
				out = &r
			}
		}
	})
	return out, err
}

// WaitLock waits for the run lock (a backup, a restore or another check holds it) until ctx ends.
func WaitLock(ctx context.Context, c *state.Config, poll time.Duration) (*state.Lock, error) {
	for {
		l, err := state.TryLock(c)
		if !errors.Is(err, state.ErrBusy) {
			return l, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(poll):
		}
	}
}
