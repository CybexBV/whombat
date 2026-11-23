package ownaddress

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"slices"
	"sync"
	"time"

	"github.com/CybexBV/whombat/contracts/go/device"
	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// Service is the own address as the broker and the daemon see it.
type Service struct {
	Mode      Mode
	Store     *Store
	Responder *Responder
	// Prober and Orderer are *Prober and *Orderer (interfaces so the loop can be tested on its own).
	Prober interface {
		Probe(ctx context.Context, host string) error
	}
	Orderer interface {
		Order(ctx context.Context, host string) (*Pair, error)
	}
	// Watch is nil when this mode has no certificate watch (pebble without a fake Cert Spotter).
	Watch *Watch
	Now   func() time.Time
	Log   *slog.Logger
	// The order loop's retry bounds (MG-162); zero: 1 minute up to 6 hours.
	RetryMin, RetryMax time.Duration
	// Sleep waits d, or until a wake or ctx (nil: a timer); tests replace it.
	Sleep func(ctx context.Context, wake <-chan struct{}, d time.Duration) bool

	mu    sync.Mutex
	saved Saved
	pair  *Pair
	// leaving is the pair of saved.Leaving (nil when there is none).
	leaving *Pair
	state   local.OwnAddressAcmeState
	errCode string
	next    time.Time
	wake    chan struct{}
	// soonUntil: until then a failed probe is tried again within seconds (a new label, or the first look after a
	// start), while the path to the box is still being put together.
	soonUntil time.Time
}

// A failed probe right after the box got its label is usually the path still being put together: the runtime declares
// the name to the relay only once it read it from the manager, a few seconds later. The person who just linked the box
// waits for its address, so a probe that failed then is tried again within seconds rather than in a minute; a probe
// costs nothing at the CA. After probeSoonFor the usual retries apply, so a path that stays broken isn't hammered.
const (
	probeSoon    = 5 * time.Second
	probeSoonFor = 3 * time.Minute
)

var (
	labelRe = regexp.MustCompile(protocol.OwnAddressLabelPattern)
	hostRe  = regexp.MustCompile(protocol.OwnAddressHostPattern)
)

// ErrHostMismatch: control answered a host other than the label under one of this box's zones.
var ErrHostMismatch = errors.New("control's host is not the label under one of this box's zones")

// fits: host is label directly under one of the mode's zones, both of the contract's shape.
func (m Mode) fits(label, host string) bool {
	z := ZoneOf(host)
	return validLabel(label) && len(host) <= protocol.OwnAddressHostMax && hostRe.MatchString(host) &&
		slices.Contains(m.Zones(), z) && host == label+"."+z
}

// Open loads the saved label, pair and leaving address. A saved address stays as long as it is under one of the
// environment's zones (prod keeps one under its earlier zone: the box moves when control says so); one under no zone of
// this environment (a box switched between dev and prod) is forgotten. A pair that can't be read is dropped (the loop
// orders a new one); a leaving address without a readable pair is forgotten (none is ever ordered for it).
func Open(mode Mode, store *Store, log *slog.Logger) (*Service, error) {
	s := &Service{Mode: mode, Store: store, Log: log, state: local.OwnAddressAcmeStateIdle, wake: make(chan struct{}, 1)}
	saved, err := store.State()
	if err != nil {
		return nil, err
	}
	dirty := false
	if saved.Label != "" && !mode.fits(saved.Label, saved.Host) {
		s.log().Warn("own address: the saved name is under none of this environment's zones; it is forgotten",
			"host", saved.Host, "zone", mode.Zone)
		saved, dirty = Saved{}, true
	}
	if l := saved.Leaving; l != nil {
		ok := saved.Label != "" && mode.fits(l.Label, l.Host) && l.Host != saved.Host
		if ok {
			p, err := store.Pair(l.Pair)
			if err != nil {
				s.log().Warn("own address: the earlier address's pair is unreadable; it stops now", "host", l.Host, "err", err)
				ok = false
			} else {
				s.leaving = p
			}
		}
		if !ok {
			saved.Leaving, dirty = nil, true
		}
	}
	if dirty {
		if err := store.SaveState(saved); err != nil {
			return nil, err
		}
	}
	if saved.Current != "" {
		p, err := store.Pair(saved.Current)
		if err != nil {
			s.log().Warn("own address: the current pair is unreadable; a new one is ordered", "err", err)
			saved.Current = ""
		} else {
			s.pair = p
		}
	}
	s.saved = saved
	if err := store.Prune(saved.keep()...); err != nil {
		s.log().Warn("own address: pruning old pairs", "err", err)
	}
	return s, nil
}

// keep is the serials whose files stay.
func (v Saved) keep() []string {
	k := []string{v.Current, v.Previous}
	if v.Leaving != nil {
		k = append(k, v.Leaving.Pair)
	}
	return k
}

func (s *Service) log() *slog.Logger {
	if s.Log != nil {
		return s.Log
	}
	return slog.Default()
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

// Label is the registered label and host ("" before registration).
func (s *Service) Label() (label, host string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.saved.Label, s.saved.Host
}

// Hosts is every host the box answers at now: its address first, then an earlier one that still answers.
func (s *Service) Hosts() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expireLocked()
	var out []string
	if s.saved.Label != "" {
		out = append(out, s.saved.Host)
	}
	if s.saved.Leaving != nil {
		out = append(out, s.saved.Leaving.Host)
	}
	return out
}

// Leaving is the earlier address while it still answers (nil otherwise), with when it stops.
func (s *Service) Leaving() *local.OwnAddressLeavingState {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expireLocked()
	return s.leavingLocked()
}

func (s *Service) leavingLocked() *local.OwnAddressLeavingState {
	l := s.saved.Leaving
	if l == nil {
		return nil
	}
	return &local.OwnAddressLeavingState{Label: l.Label, Host: l.Host, Until: l.End(s.leaving).UTC().Format(time.RFC3339)}
}

// expireLocked forgets the leaving address once it stopped, with its pair's files (mu held).
func (s *Service) expireLocked() {
	l := s.saved.Leaving
	if l == nil || s.now().Before(l.End(s.leaving)) {
		return
	}
	next := s.saved
	next.Leaving = nil
	if err := s.Store.SaveState(next); err != nil {
		s.log().Warn("own address: the earlier address stopped but isn't forgotten yet", "host", l.Host, "err", err)
		return
	}
	s.saved, s.leaving = next, nil
	if err := s.Store.Prune(next.keep()...); err != nil {
		s.log().Warn("own address: pruning old pairs", "err", err)
	}
	s.log().Info("own address: the earlier address stopped", "host", l.Host)
}

// MoveWanted is the label to send address.rename with to move the box to zone, control's zone for new names: only
// while the box's host is under an earlier zone of its environment, zone is another of its zones, and no earlier
// address is still answering (one move, and never a second leaving address).
func (s *Service) MoveWanted(zone string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expireLocked()
	if s.saved.Label == "" || s.saved.Leaving != nil {
		return "", false
	}
	have := ZoneOf(s.saved.Host)
	if !OldZone(have) || zone == "" || zone == have || !slices.Contains(s.Mode.Zones(), zone) {
		return "", false
	}
	return s.saved.Label, true
}

// State is /v1/own-address/state.
func (s *Service) State() local.OwnAddressStateResponse {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expireLocked()
	r := local.OwnAddressStateResponse{V: 1, Enabled: true, Acme: local.OwnAddressStateResponseAcme{State: s.state}}
	if s.saved.Label != "" {
		l, h := s.saved.Label, s.saved.Host
		r.Label, r.Host = &l, &h
	}
	if s.errCode != "" {
		e := s.errCode
		r.Acme.Error = &e
	}
	if !s.next.IsZero() {
		n := s.next.UTC().Format(time.RFC3339)
		r.Acme.NextAttemptAt = &n
	}
	if s.pair != nil {
		m := s.pair.Meta
		r.Cert = &m
	}
	r.Leaving = s.leavingLocked()
	return r
}

// Cert is /v1/own-address/cert: the pair to serve now for host ("" the current host), or false when there is none
// (none yet, or a host the box doesn't answer at).
func (s *Service) Cert(host string) (*local.OwnAddressCertResponse, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expireLocked()
	p, h := s.pair, s.saved.Host
	if host != "" && host != s.saved.Host {
		if s.saved.Leaving == nil || s.saved.Leaving.Host != host {
			return nil, false
		}
		p, h = s.leaving, host
	}
	if p == nil {
		return nil, false
	}
	m := p.Meta
	return &local.OwnAddressCertResponse{V: 1, Serial: m.Serial, SpkiSHA256: m.SpkiSHA256, NotBefore: m.NotBefore,
		NotAfter: m.NotAfter, Host: h, CertPem: p.CertPEM, KeyPem: p.KeyPEM}, true
}

// CT is /v1/own-address/ct.
func (s *Service) CT() (*local.OwnAddressCtResponse, error) {
	now := s.now()
	var r *local.OwnAddressCtResponse
	if s.Watch != nil {
		r = s.Watch.Response(now)
	}
	if r == nil {
		// Not watching yet (no label) or not at all: nothing checked, from now.
		r = &local.OwnAddressCtResponse{V: 1, Source: "certspotter", CheckingSince: now.UTC().Format(time.RFC3339),
			Missed: []local.OwnAddressCtResponseMissedItem{}, Hosts: []string{}, Certs: []local.OwnAddressCtCert{}}
	}
	ordered, err := s.Store.Ordered()
	if err != nil {
		return nil, err
	}
	r.Ordered = ordered
	return r, nil
}

// Address is the box's address as control answers it: address.register, address.rename, link.status.
type Address struct {
	Label, Host  string
	RegisteredAt int64
	// Leaving is control's earlier address of the box while it still routes it (nil: none, or control didn't say).
	Leaving *device.AddressLeaving
}

// Accept saves control's answer to address.register (MG-166).
func (s *Service) Accept(resp *device.AddressRegisterResponse) error {
	_, err := s.Adopt(Address{Label: resp.Label, Host: resp.Host, RegisteredAt: resp.RegisteredAt, Leaving: resp.Leaving})
	return err
}

// Adopt saves control's answer about the box's address; changed is true when the host the box answers at changed.
// Control is the registry, but the box's name never leaves its environment: the host must be the label directly under
// one of the environment's zones.
//
// A new host takes over at once (its certificate is ordered now, after a probe). The host it replaces keeps answering
// with the pair it has when control names it as leaving; an earlier address already leaving stays when control still
// names it (a rename during a move: the name in between stops at once). There is at most one leaving address, and an
// answer without one never ends it early: its date does.
func (s *Service) Adopt(a Address) (changed bool, err error) {
	if !s.Mode.fits(a.Label, a.Host) {
		return false, fmt.Errorf("%w (label %q, host %q, zone %s)", ErrHostMismatch, a.Label, a.Host, s.Mode.Zone)
	}
	lv := a.Leaving
	if lv != nil && (!s.Mode.fits(lv.Label, lv.Host) || lv.Host == a.Host) {
		s.log().Warn("own address: control's earlier address is none this box can answer at", "host", lv.Host)
		lv = nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expireLocked()
	cur := s.saved
	next, leavingPair := cur, s.leaving
	if cur.Leaving != nil {
		l := *cur.Leaving
		next.Leaving = &l
	}
	if a.Host == cur.Host {
		if a.RegisteredAt != 0 {
			next.RegisteredAt = a.RegisteredAt
		}
		if lv != nil && next.Leaving != nil && lv.Host == next.Leaving.Host {
			next.Leaving.Until = time.Unix(lv.Until, 0).UTC()
		}
	} else {
		next = Saved{Label: a.Label, Host: a.Host, RegisteredAt: a.RegisteredAt}
		leavingPair = nil
		switch {
		case lv == nil:
		case lv.Host == cur.Host && cur.Label != "" && s.pair != nil:
			next.Leaving = &Leaving{Label: cur.Label, Host: cur.Host, Until: time.Unix(lv.Until, 0).UTC(), Pair: cur.Current}
			leavingPair = s.pair
		case cur.Leaving != nil && lv.Host == cur.Leaving.Host:
			next.Leaving = &Leaving{Label: cur.Leaving.Label, Host: cur.Leaving.Host, Until: time.Unix(lv.Until, 0).UTC(), Pair: cur.Leaving.Pair}
			leavingPair = s.leaving
		}
		if next.Leaving != nil && !s.now().Before(next.Leaving.End(leavingPair)) {
			next.Leaving, leavingPair = nil, nil
		}
	}
	if sameSaved(cur, next) {
		return false, nil
	}
	if err := s.Store.SaveState(next); err != nil {
		return false, err
	}
	changed = next.Host != cur.Host
	s.saved, s.leaving = next, leavingPair
	if changed {
		s.pair = nil
		s.soonUntil = s.now().Add(probeSoonFor)
		if err := s.Store.Prune(next.keep()...); err != nil {
			s.log().Warn("own address: pruning old pairs", "err", err)
		}
		if cur.Label == "" {
			s.log().Info("own address: registered", "host", a.Host)
		} else {
			s.log().Info("own address: the address changed", "from", cur.Host, "to", a.Host, "leaving", next.Leaving != nil)
		}
	}
	select {
	case s.wake <- struct{}{}:
	default:
	}
	return changed, nil
}

func sameSaved(a, b Saved) bool {
	la, lb := a.Leaving, b.Leaving
	sameLeaving := (la == nil) == (lb == nil) && (la == nil || (la.Label == lb.Label && la.Host == lb.Host && la.Pair == lb.Pair && la.Until.Equal(lb.Until)))
	a.Leaving, b.Leaving = nil, nil
	return a == b && sameLeaving
}

func (s *Service) set(state local.OwnAddressAcmeState, code string, next time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.state, s.errCode, s.next = state, code, next
}

func (s *Service) sleep(ctx context.Context, d time.Duration) bool {
	if s.Sleep != nil {
		return s.Sleep(ctx, s.wake, d)
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-s.wake:
		return true
	case <-t.C:
		return true
	}
}

// Run is the order loop (MG-162): it waits for a label, then keeps a current certificate from the mode's directory,
// renewing at two thirds of its lifetime. Before every order it probes the path (MG-164). Failures retry forever, from
// 1 minute doubling up to 6 hours; a 429 waits its Retry-After. The certificate watch starts with the label and follows
// every host the box answers at. A leaving address gets no orders; the loop wakes when it stops, to forget it.
func (s *Service) Run(ctx context.Context) {
	if s.Watch != nil {
		defer s.Watch.Wait()
	}
	retryMin, retryMax := or(s.RetryMin, time.Minute), or(s.RetryMax, 6*time.Hour)
	retry := retryMin
	s.mu.Lock()
	if s.pair == nil {
		// The first look after a start: the runtime may still be declaring the name to the relay.
		s.soonUntil = s.now().Add(probeSoonFor)
	}
	s.mu.Unlock()
	fail := func(code string, err error, wait time.Duration) time.Duration {
		if wait <= 0 {
			wait = retry
			retry = min(retry*2, retryMax)
		}
		s.set(local.OwnAddressAcmeStateFailing, code, s.now().Add(wait))
		s.log().Warn("own address: no certificate this time", "error", code, "err", err, "retry", wait)
		return wait
	}
	for ctx.Err() == nil {
		s.mu.Lock()
		s.expireLocked()
		label, host, pair, dir := s.saved.Label, s.saved.Host, s.pair, s.saved.Directory
		var stops time.Time
		if s.saved.Leaving != nil {
			stops = s.saved.Leaving.End(s.leaving)
		}
		s.mu.Unlock()
		if label == "" {
			s.set(local.OwnAddressAcmeStateIdle, "", time.Time{})
			if !s.sleep(ctx, 24*time.Hour) {
				return
			}
			continue
		}
		if s.Watch != nil {
			s.Watch.Follow(ctx, s.Hosts())
		}
		now := s.now()
		if pair != nil && dir == s.Mode.Directory && now.Before(pair.RenewAt()) {
			renew := pair.RenewAt()
			s.set(local.OwnAddressAcmeStateValid, "", renew)
			retry = retryMin
			wait := renew.Sub(now)
			if !stops.IsZero() && stops.Sub(now) < wait {
				wait = max(stops.Sub(now), time.Second)
			}
			if !s.sleep(ctx, wait) {
				return
			}
			continue
		}
		s.set(local.OwnAddressAcmeStateProbing, "", time.Time{})
		if err := s.Prober.Probe(ctx, host); err != nil {
			if ctx.Err() != nil {
				return
			}
			wait := time.Duration(0)
			s.mu.Lock()
			if s.now().Before(s.soonUntil) {
				wait = probeSoon
			}
			s.mu.Unlock()
			if !s.sleep(ctx, fail("probe_failed", err, wait)) {
				return
			}
			continue
		}
		s.mu.Lock()
		moved := s.saved.Host != host
		s.mu.Unlock()
		if moved {
			// The address changed while its path was probed: probe the new one instead.
			continue
		}
		s.set(local.OwnAddressAcmeStateOrdering, "", time.Time{})
		p, err := s.Orderer.Order(ctx, host)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			oe := classify(err)
			wait := time.Duration(0)
			if oe.Code == "rate_limited" {
				wait = max(oe.RetryAfter, retryMin)
			}
			if !s.sleep(ctx, fail(oe.Code, err, wait)) {
				return
			}
			continue
		}
		if err := s.makeCurrent(p, host); errors.Is(err, errHostChanged) {
			s.log().Info("own address: a certificate for an address the box left is dropped", "host", host)
			continue
		} else if err != nil {
			if !s.sleep(ctx, fail("order_failed", err, 0)) {
				return
			}
			continue
		}
		s.log().Info("own address: certificate issued", "serial", p.Meta.Serial, "notAfter", p.Meta.NotAfter)
	}
}

// errHostChanged: the address changed while its certificate was ordered.
var errHostChanged = errors.New("the address changed during the order")

func (s *Service) makeCurrent(p *Pair, host string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.saved.Host != host {
		if err := s.Store.Prune(s.saved.keep()...); err != nil {
			s.log().Warn("own address: pruning old pairs", "err", err)
		}
		return errHostChanged
	}
	next := s.saved
	if next.Current != p.Meta.Serial {
		next.Previous = next.Current
	}
	next.Current, next.Directory = p.Meta.Serial, s.Mode.Directory
	if err := s.Store.SaveState(next); err != nil {
		return err
	}
	s.saved, s.pair = next, p
	if err := s.Store.Prune(next.keep()...); err != nil {
		s.log().Warn("own address: pruning old pairs", "err", err)
	}
	return nil
}
