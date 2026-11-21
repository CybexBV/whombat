package ownaddress

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
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

	mu       sync.Mutex
	saved    Saved
	pair     *Pair
	state    local.OwnAddressAcmeState
	errCode  string
	next     time.Time
	wake     chan struct{}
	watching bool
	watchWG  sync.WaitGroup
}

var (
	labelRe = regexp.MustCompile(protocol.OwnAddressLabelPattern)
	hostRe  = regexp.MustCompile(protocol.OwnAddressHostPattern)
)

// ErrHostMismatch: control answered a host other than the label under this box's zone.
var ErrHostMismatch = errors.New("control's host is not the label under this box's zone")

// Open loads the saved label and pair. A pair that can't be read is dropped (the loop orders a new one).
func Open(mode Mode, store *Store, log *slog.Logger) (*Service, error) {
	s := &Service{Mode: mode, Store: store, Log: log, state: local.OwnAddressAcmeStateIdle, wake: make(chan struct{}, 1)}
	saved, err := store.State()
	if err != nil {
		return nil, err
	}
	if saved.Label != "" && saved.Host != saved.Label+"."+mode.Zone {
		// The zone moved (a box switched between dev and prod); the name and its pairs no longer apply.
		s.log().Warn("own address: the saved name is not under this zone; it is forgotten", "zone", mode.Zone)
		saved = Saved{}
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
	if err := store.Prune(saved.Current, saved.Previous); err != nil {
		s.log().Warn("own address: pruning old pairs", "err", err)
	}
	return s, nil
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

// State is /v1/own-address/state.
func (s *Service) State() local.OwnAddressStateResponse {
	s.mu.Lock()
	defer s.mu.Unlock()
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
	return r
}

// Cert is /v1/own-address/cert: the current pair, or false when there is none yet.
func (s *Service) Cert() (*local.OwnAddressCertResponse, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pair == nil {
		return nil, false
	}
	m := s.pair.Meta
	return &local.OwnAddressCertResponse{V: 1, Serial: m.Serial, SpkiSHA256: m.SpkiSHA256, NotBefore: m.NotBefore,
		NotAfter: m.NotAfter, Host: s.saved.Host, CertPem: s.pair.CertPEM, KeyPem: s.pair.KeyPEM}, true
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
			Missed: []local.OwnAddressCtResponseMissedItem{}, Certs: []local.OwnAddressCtCert{}}
	}
	ordered, err := s.Store.Ordered()
	if err != nil {
		return nil, err
	}
	r.Ordered = ordered
	return r, nil
}

// Accept saves control's answer to address.register (MG-166). Control is the registry, but the box's name never
// depends on what control says the zone is: the host must be the label under this box's own zone.
func (s *Service) Accept(resp *device.AddressRegisterResponse) error {
	if !labelRe.MatchString(resp.Label) || !hostRe.MatchString(resp.Host) || resp.Host != resp.Label+"."+s.Mode.Zone {
		return fmt.Errorf("%w (label %q, host %q, zone %s)", ErrHostMismatch, resp.Label, resp.Host, s.Mode.Zone)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.saved.Label == resp.Label && s.saved.Host == resp.Host {
		return nil
	}
	next := s.saved
	if next.Label != "" {
		// Phase 1 never changes a label; if control ever does, the old name's pairs are of no use.
		next = Saved{}
	}
	next.Label, next.Host, next.RegisteredAt = resp.Label, resp.Host, resp.RegisteredAt
	if err := s.Store.SaveState(next); err != nil {
		return err
	}
	if s.saved.Label != "" {
		s.pair = nil
	}
	s.saved = next
	s.log().Info("own address: registered", "host", resp.Host)
	select {
	case s.wake <- struct{}{}:
	default:
	}
	return nil
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
// 1 minute doubling up to 6 hours; a 429 waits its Retry-After. The certificate watch starts with the label.
func (s *Service) Run(ctx context.Context) {
	defer s.watchWG.Wait()
	retryMin, retryMax := or(s.RetryMin, time.Minute), or(s.RetryMax, 6*time.Hour)
	retry := retryMin
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
		label, host, pair, dir := s.saved.Label, s.saved.Host, s.pair, s.saved.Directory
		s.mu.Unlock()
		if label == "" {
			s.set(local.OwnAddressAcmeStateIdle, "", time.Time{})
			if !s.sleep(ctx, 24*time.Hour) {
				return
			}
			continue
		}
		s.startWatch(ctx, host)
		now := s.now()
		if pair != nil && dir == s.Mode.Directory && now.Before(pair.RenewAt()) {
			renew := pair.RenewAt()
			s.set(local.OwnAddressAcmeStateValid, "", renew)
			retry = retryMin
			if !s.sleep(ctx, renew.Sub(now)) {
				return
			}
			continue
		}
		s.set(local.OwnAddressAcmeStateProbing, "", time.Time{})
		if err := s.Prober.Probe(ctx, host); err != nil {
			if ctx.Err() != nil {
				return
			}
			if !s.sleep(ctx, fail("probe_failed", err, 0)) {
				return
			}
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
		if err := s.makeCurrent(p); err != nil {
			if !s.sleep(ctx, fail("order_failed", err, 0)) {
				return
			}
			continue
		}
		s.log().Info("own address: certificate issued", "serial", p.Meta.Serial, "notAfter", p.Meta.NotAfter)
	}
}

func (s *Service) makeCurrent(p *Pair) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := s.saved
	if next.Current != p.Meta.Serial {
		next.Previous = next.Current
	}
	next.Current, next.Directory = p.Meta.Serial, s.Mode.Directory
	if err := s.Store.SaveState(next); err != nil {
		return err
	}
	s.saved, s.pair = next, p
	if err := s.Store.Prune(next.Current, next.Previous); err != nil {
		s.log().Warn("own address: pruning old pairs", "err", err)
	}
	return nil
}

func (s *Service) startWatch(ctx context.Context, host string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.watching || s.Watch == nil {
		return
	}
	s.watching = true
	s.watchWG.Add(1)
	go func() { defer s.watchWG.Done(); s.Watch.Run(ctx, host) }()
}
