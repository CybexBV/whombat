// Package jobs runs one speech job at a time with a short queue behind it (voice socket §2.4: one job, a queue of 2).
// A request that finds the queue full is refused at once (503 busy) rather than waiting: the desk has one person
// talking, so a full queue means something is wrong, and the runtime says so instead of hanging.
package jobs

import (
	"context"
	"errors"
	"sync"
)

// ErrBusy: a job is running and the queue is full.
var ErrBusy = errors.New("busy")

// Limiter admits one running job and up to Queue waiting ones.
type Limiter struct {
	mu       sync.Mutex
	admitted int
	queue    int
	run      chan struct{}
}

// New returns a limiter with one running job and a queue of queue.
func New(queue int) *Limiter {
	return &Limiter{queue: queue, run: make(chan struct{}, 1)}
}

// Acquire waits for the job's turn. It fails with ErrBusy when the queue is full, or with ctx's error when the caller
// gives up while waiting. Call release exactly once when the job is done.
func (l *Limiter) Acquire(ctx context.Context) (release func(), err error) {
	l.mu.Lock()
	if l.admitted >= 1+l.queue {
		l.mu.Unlock()
		return nil, ErrBusy
	}
	l.admitted++
	l.mu.Unlock()
	select {
	case l.run <- struct{}{}:
		var once sync.Once
		return func() {
			once.Do(func() {
				<-l.run
				l.leave()
			})
		}, nil
	case <-ctx.Done():
		l.leave()
		return nil, ctx.Err()
	}
}

func (l *Limiter) leave() {
	l.mu.Lock()
	l.admitted--
	l.mu.Unlock()
}

// Admitted is the number of jobs running or waiting.
func (l *Limiter) Admitted() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.admitted
}
