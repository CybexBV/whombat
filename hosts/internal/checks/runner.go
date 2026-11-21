package checks

import (
	"context"
	"fmt"
	"math/rand/v2"
	"reflect"
	"sort"
	"sync"
	"time"

	"rackoon/internal/proto"
)

// MaxChecks bounds the checks one runner accepts.
const MaxChecks = 200

// DefaultConcurrency is how many checks run at the same time.
const DefaultConcurrency = 8

// Runner runs a set of checks, each on its own interval (with jitter, so
// checks set at the same time do not fire together), at most
// DefaultConcurrency at a time, and keeps the latest result of each.
// SetSpecs replaces the set atomically; Run drives the schedule.
type Runner struct {
	run  func(ctx context.Context, s proto.CheckSpec) proto.CheckResult
	unit time.Duration // one second; tests shorten it
	conc int

	mu      sync.Mutex
	entries map[string]*entry
	wake    chan struct{}
}

type entry struct {
	spec    proto.CheckSpec
	next    time.Time
	running bool
	result  *proto.CheckResult
	invalid bool // the spec failed validation; result is fixed
}

// NewRunner returns an idle runner with no checks.
func NewRunner() *Runner {
	return &Runner{
		run:     Run,
		unit:    time.Second,
		conc:    DefaultConcurrency,
		entries: map[string]*entry{},
		wake:    make(chan struct{}, 1),
	}
}

// SetSpecs replaces the checks. Checks whose spec did not change keep
// their schedule and latest result; new and changed ones run within a few
// seconds; removed ones are dropped (a run in flight is discarded). Invalid
// specs are kept with a failed result naming the problem (specs without a
// usable id are skipped). The returned errors describe what was rejected.
func (r *Runner) SetSpecs(specs []proto.CheckSpec) []error {
	var errs []error
	if len(specs) > MaxChecks {
		errs = append(errs, fmt.Errorf("%d checks, only the first %d are run", len(specs), MaxChecks))
		specs = specs[:MaxChecks]
	}
	now := time.Now()
	r.mu.Lock()
	next := make(map[string]*entry, len(specs))
	for _, s := range specs {
		if s.ID == "" || len(s.ID) > 64 {
			errs = append(errs, fmt.Errorf("check without a valid id skipped"))
			continue
		}
		if _, dup := next[s.ID]; dup {
			errs = append(errs, fmt.Errorf("check %s: duplicate id skipped", s.ID))
			continue
		}
		if old := r.entries[s.ID]; old != nil && reflect.DeepEqual(old.spec, s) {
			next[s.ID] = old
			continue
		}
		e := &entry{spec: s}
		if err := Validate(s); err != nil {
			errs = append(errs, fmt.Errorf("check %s: %w", s.ID, err))
			e.invalid = true
			e.result = &proto.CheckResult{ID: s.ID, At: now.UTC(), Error: "invalid check: " + err.Error()}
		} else {
			e.next = now.Add(r.initialDelay(s.IntervalS))
		}
		next[s.ID] = e
	}
	r.entries = next
	r.mu.Unlock()
	r.poke()
	return errs
}

// initialDelay spreads first runs over up to 10 s (or the interval).
func (r *Runner) initialDelay(intervalS int) time.Duration {
	spread := 10 * r.unit
	if iv := time.Duration(intervalS) * r.unit; iv < spread {
		spread = iv
	}
	return rand.N(spread + 1)
}

// period is the interval plus up to 5 % jitter.
func (r *Runner) period(intervalS int) time.Duration {
	iv := time.Duration(intervalS) * r.unit
	return iv + rand.N(iv/20+1)
}

// Results returns the latest result of every current check, by id.
func (r *Runner) Results() []proto.CheckResult {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]proto.CheckResult, 0, len(r.entries))
	for _, e := range r.entries {
		if e.result != nil {
			out = append(out, *e.result)
		}
	}
	if len(out) == 0 {
		return nil
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Len returns the number of checks in the set.
func (r *Runner) Len() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.entries)
}

// Run runs due checks until ctx ends, then waits for the runs in flight
// (each is bounded by its timeout and ctx).
func (r *Runner) Run(ctx context.Context) {
	sem := make(chan struct{}, r.conc)
	var wg sync.WaitGroup
	defer wg.Wait()
	timer := time.NewTimer(time.Hour)
	defer timer.Stop()
	for {
		now := time.Now()
		next := now.Add(time.Hour)
		var due []*entry
		r.mu.Lock()
		for _, e := range r.entries {
			if e.invalid || e.running {
				continue
			}
			if !e.next.After(now) {
				e.running = true
				e.next = now.Add(r.period(e.spec.IntervalS))
				due = append(due, e)
			}
			if e.next.Before(next) {
				next = e.next
			}
		}
		r.mu.Unlock()
		sort.Slice(due, func(i, j int) bool { return due[i].spec.ID < due[j].spec.ID })
		for _, e := range due {
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				r.mu.Lock()
				e.running = false
				r.mu.Unlock()
				return
			}
			wg.Add(1)
			go func(e *entry) {
				defer wg.Done()
				defer func() { <-sem }()
				res := r.run(ctx, e.spec)
				r.mu.Lock()
				e.running = false
				if ctx.Err() == nil && r.entries[e.spec.ID] == e {
					e.result = &res
				}
				r.mu.Unlock()
				r.poke() // its next run may already be due
			}(e)
		}
		if len(due) > 0 {
			continue // recompute: runs that were queued on the semaphore took time
		}
		timer.Reset(time.Until(next)) // Go >= 1.23: no stale tick after Reset
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		case <-r.wake:
		}
	}
}

func (r *Runner) poke() {
	select {
	case r.wake <- struct{}{}:
	default:
	}
}
