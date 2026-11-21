package netguard

import (
	"context"
	"time"
)

// “Online” (Whombat HD-10, MG-101): the manager connected to control's endpoint in its last check, at most OnlineFor
// ago (an answer that it didn't counts for OfflineFor). A check is a TCP connect (Check, the guard's DialChecker): made when someone asks and the last one is older,
// and by every confirmation step of a change. Nothing checks in the background.

// OnlineFor is how long a check that reached control answers for; OfflineFor how long one that didn't: shorter, so the
// box looks online again soon after its network came back (a revert, a cable plugged in).
const (
	OnlineFor  = 60 * time.Second
	OfflineFor = 10 * time.Second
)

// onlineCheckTimeout bounds one check (DNS and the connect).
const onlineCheckTimeout = 10 * time.Second

type onlineState struct {
	ok      bool
	at      time.Time     // zero: never checked
	running chan struct{} // closed when the check under way ends; nil when none runs
}

func (g *Guard) noteOnline(ok bool) {
	g.onlineMu.Lock()
	g.online.ok, g.online.at = ok, g.now()
	g.onlineMu.Unlock()
}

// staleOnline makes the next question check again: the network changed since the last check (a change ended).
func (g *Guard) staleOnline() {
	g.onlineMu.Lock()
	g.online.at = time.Time{}
	g.onlineMu.Unlock()
}

// startCheck starts a check unless one runs; it returns the channel closed when it ends.
func (g *Guard) startCheck() <-chan struct{} {
	g.onlineMu.Lock()
	defer g.onlineMu.Unlock()
	if g.online.running != nil {
		return g.online.running
	}
	done := make(chan struct{})
	g.online.running = done
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), onlineCheckTimeout)
		err := g.Check.Check(ctx)
		cancel()
		g.onlineMu.Lock()
		g.online.ok, g.online.at, g.online.running = err == nil, g.now(), nil
		g.onlineMu.Unlock()
		close(done)
	}()
	return done
}

// Online answers whether the box is online and when that was checked (zero: never). A check older than OnlineFor is
// made again; Online waits for it at most wait (the answer is then the previous one) and the check goes on.
func (g *Guard) Online(ctx context.Context, wait time.Duration) (bool, time.Time) {
	g.onlineMu.Lock()
	keep := OfflineFor
	if g.online.ok {
		keep = OnlineFor
	}
	fresh := !g.online.at.IsZero() && g.now().Sub(g.online.at) <= keep
	ok, at := g.online.ok, g.online.at
	g.onlineMu.Unlock()
	if fresh {
		return ok, at
	}
	done := g.startCheck()
	t := time.NewTimer(wait)
	defer t.Stop()
	select {
	case <-done:
	case <-ctx.Done():
	case <-t.C:
	}
	g.onlineMu.Lock()
	defer g.onlineMu.Unlock()
	return g.online.ok, g.online.at
}

// CheckOnline checks now (whatever the last check said) and waits for it at most wait: whether a change must be
// guarded (HD-06) is decided on a fresh answer. A check that doesn't end in time counts as offline.
func (g *Guard) CheckOnline(ctx context.Context, wait time.Duration) bool {
	t := time.NewTimer(wait)
	defer t.Stop()
	g.onlineMu.Lock()
	running := g.online.running
	g.onlineMu.Unlock()
	for _, step := range []func() <-chan struct{}{
		func() <-chan struct{} { return running }, // a check under way began before this question: then ask again
		g.startCheck,
	} {
		done := step()
		if done == nil {
			continue
		}
		select {
		case <-done:
		case <-ctx.Done():
			return false
		case <-t.C:
			return false
		}
	}
	g.onlineMu.Lock()
	defer g.onlineMu.Unlock()
	return g.online.ok
}
