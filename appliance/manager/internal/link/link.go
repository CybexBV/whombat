// Package link keeps the box's Whombat Link state (Whombat LNK-02…LNK-06; MG-170…MG-175): `off · starting · on ·
// grace · ended`. Control is the authority (it bills); the manager learns the state from every answer control gives
// (link.begin, link.status, link.leave, and every ticket.issue answer) and keeps it in a journal of its own, so the
// runtime, the screen and the manager's own loops read one answer at once, without asking control.
//
// What each state lets the box do (Gate):
//
//	off       no control calls at all (LNK-03), no push either, security included (LNK-54): a box that never turns
//	          Link on never talks to control. The one exception is a link.leave the owner asked for that control
//	          hasn't confirmed yet.
//	starting  Link features (Active): the code on the screen, the label and its certificate as soon as control gives one.
//	on, grace Link features (Active).
//	ended     what is never gated (Known): claim and revocation reports, security pushes, bringing a Whombat back; and a
//	          link.status now and then, so the box sees its owner subscribe again.
//
// The owner turns Link on (link.begin: the box's registration, which also introduces a box control never saw) and off
// (link.leave) through the runtime, the installer's choice or the recovery menu (internal/reach). Turning it off takes
// effect on the box at once, also when control can't be reached: link.leave is then sent again until control takes it.
package link

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi"
	"github.com/CybexBV/whombat/appliance/manager/internal/journal"
	"github.com/CybexBV/whombat/contracts/go/device"
	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// Pending is the code the box shows while Link starts.
type Pending struct {
	Code      string    `json:"code"`
	URL       string    `json:"url"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// Record is the journal's state.
type Record struct {
	State             protocol.LinkState `json:"state"`
	Since             time.Time          `json:"since"`
	Pending           *Pending           `json:"pending,omitempty"`
	WaitingForAddress bool               `json:"waitingForAddress,omitempty"`
	GraceEndsAt       *time.Time         `json:"graceEndsAt,omitempty"`
	TrialEndsAt       *time.Time         `json:"trialEndsAt,omitempty"`
	Label             string             `json:"label,omitempty"`
	Email             string             `json:"email,omitempty"`
	// CheckedAt is when control last told the box its state; nil before it ever did.
	CheckedAt *time.Time `json:"checkedAt,omitempty"`
	// Carried: a box registered at control before Link (Cybex's own boxes, LNK-37, LNK-50) starts `on`, as it worked
	// before, until control says otherwise.
	Carried bool `json:"carried,omitempty"`
	// CarriedOff: a carried box that control answered `off` (it wasn't comped yet when the release reached it, LNK-50).
	// Not the owner's choice, so it keeps asking link.status and comes back by itself once control comps it; the owner
	// turning Link off clears it.
	CarriedOff bool `json:"carriedOff,omitempty"`
	// Leaving: the owner turned Link off and control hasn't confirmed link.leave yet.
	Leaving bool `json:"leaving,omitempty"`
	// Want is "on" while the owner's choice from the reach file (installer, recovery menu) waits for control to answer
	// link.begin (the network may not be up at the first start).
	Want string `json:"want,omitempty"`
	// ReachSeq is the reach file's seq the manager acted on.
	ReachSeq uint64 `json:"reachSeq,omitempty"`
	// ContentProof is the content key's signature of the box's registration (the runtime's, or provisioning's), kept so
	// that a code that ran out can be renewed without the runtime. Public: a signature over public facts.
	ContentProof string `json:"contentProof,omitempty"`
	// Name is the box's name for the confirm page, as the runtime last gave it.
	Name string `json:"name,omitempty"`
}

// Active: Link features run (starting, on, grace).
func (r Record) Active() bool {
	if r.Leaving {
		return false
	}
	switch r.State {
	case protocol.LinkStateStarting, protocol.LinkStateOn, protocol.LinkStateGrace:
		return true
	}
	return false
}

// Known: control knows the box (any state but off): what is never gated may go to control.
func (r Record) Known() bool { return !r.Leaving && r.State != protocol.LinkStateOff && r.State != "" }

// Registration builds the box's signed registration for link.begin; contentProof is the content key's signature (from
// the runtime's request, or "" for the one the box kept from provisioning).
type Registration func(contentProof string) (*device.DeviceRegistration, error)

// Control is what the keeper calls at control.
type Control interface {
	Do(ctx context.Context, op device.DeviceOpName, body, out any) error
}

// Keeper keeps the Link state.
type Keeper struct {
	// Control is nil when this box's environment has no Link (Available is false).
	Control      Control
	Registration Registration
	Log          *slog.Logger
	// Now is the clock (tests); nil: the wall clock.
	Now func() time.Time
	// OnChange is called (outside the lock) after every saved change, with the state before and after it.
	OnChange func(before, after Record)

	j *journal.Journal

	mu  sync.Mutex
	rec Record
	// busy: an owner's change (On, Off) runs; the poll loop and a second change wait or answer busy.
	busy bool
	// notes are the changes saved under mu, for OnChange once it is released.
	notes [][2]Record
	wake  chan struct{}
}

// Errors of On and Off (the broker maps them to the contract's LINK_ERRORS).
var (
	ErrUnavailable  = errors.New("this Whombat has no Whombat Link")
	ErrBusy         = errors.New("a Whombat Link change is already running")
	ErrDeviceExists = errors.New("control holds another Whombat with this one's keys or id")
	ErrRateLimited  = errors.New("control's limit on new codes: try again later")
	ErrRevoked      = errors.New("control retired this Whombat")
	ErrInvalid      = errors.New("control refused this Whombat's registration")
)

// Open loads the journal at dir. A box without a record starts `on` when carried (it was registered at control before
// Link: it keeps working as it did), else `off`.
func Open(dir string, carried bool, now time.Time) (*Keeper, error) {
	j, err := journal.Open(dir)
	if err != nil {
		return nil, err
	}
	k := &Keeper{j: j, wake: make(chan struct{}, 1)}
	found, err := j.Load(&k.rec)
	if err != nil {
		return nil, fmt.Errorf("link journal: %w", err)
	}
	if !found {
		k.rec = Record{State: protocol.LinkStateOff, Since: now.UTC()}
		if carried {
			k.rec = Record{State: protocol.LinkStateOn, Since: now.UTC(), Carried: true}
		}
		if err := j.Save(k.rec); err != nil {
			return nil, err
		}
	}
	return k, nil
}

func (k *Keeper) now() time.Time {
	if k.Now != nil {
		return k.Now()
	}
	return time.Now()
}

func (k *Keeper) log() *slog.Logger {
	if k.Log != nil {
		return k.Log
	}
	return slog.Default()
}

// Available reports whether this box can have Link at all (its environment has a control).
func (k *Keeper) Available() bool { return k.Control != nil }

// Snapshot is the state now.
func (k *Keeper) Snapshot() Record {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.rec
}

// Active and Known are the snapshot's (the broker's gate).
func (k *Keeper) Active() bool { return k.Available() && k.Snapshot().Active() }
func (k *Keeper) Known() bool  { return k.Available() && k.Snapshot().Known() }

// saveLocked writes next as the record (mu held) and queues OnChange for unlock.
func (k *Keeper) saveLocked(next Record) error {
	before := k.rec
	if err := k.j.Save(next); err != nil {
		return err
	}
	k.rec = next
	if k.OnChange != nil && changed(before, next) {
		k.notes = append(k.notes, [2]Record{before, next})
	}
	return nil
}

// unlock releases mu, then tells OnChange about the changes saved meanwhile (never under the lock: it may read the
// state).
func (k *Keeper) unlock() {
	notes := k.notes
	k.notes = nil
	k.mu.Unlock()
	for _, n := range notes {
		k.OnChange(n[0], n[1])
	}
}

// changed: something the box acts on or shows differs.
func changed(a, b Record) bool {
	pa, pb := a.Pending, b.Pending
	samePending := (pa == nil) == (pb == nil) && (pa == nil || *pa == *pb)
	return a.State != b.State || a.Leaving != b.Leaving || a.Label != b.Label || !samePending ||
		a.WaitingForAddress != b.WaitingForAddress || !sameTime(a.GraceEndsAt, b.GraceEndsAt)
}

func sameTime(a, b *time.Time) bool { return (a == nil) == (b == nil) && (a == nil || a.Equal(*b)) }

func unix(v int64) time.Time { return time.Unix(v, 0).UTC() }

func unixPtr(v *int64) *time.Time {
	if v == nil {
		return nil
	}
	t := unix(*v)
	return &t
}

// adopt merges control's answer into r: control is the authority on everything it says.
func adopt(r Record, st *device.DeviceLinkStatus, now time.Time) Record {
	r.State, r.Since = st.State, unix(st.Since)
	r.Pending = nil
	if st.Pending != nil {
		r.Pending = &Pending{Code: st.Pending.Code, URL: st.Pending.URL, ExpiresAt: unix(st.Pending.ExpiresAt)}
	}
	r.WaitingForAddress = st.WaitingForAddress != nil && *st.WaitingForAddress
	r.GraceEndsAt, r.TrialEndsAt = unixPtr(st.GraceEndsAt), unixPtr(st.TrialEndsAt)
	if st.Label != nil {
		r.Label = *st.Label // labels are never taken back (LNK-06): an answer without one keeps the one the box has
	}
	if st.Email != nil {
		r.Email = *st.Email
	}
	t := now.UTC()
	r.CarriedOff = (r.Carried || r.CarriedOff) && r.State == protocol.LinkStateOff
	r.CheckedAt, r.Carried = &t, false
	if r.State != protocol.LinkStateOff && r.State != protocol.LinkStateEnded {
		r.Want = ""
	}
	return r
}

// Observe takes a Link state control sent with another answer (ticket.issue). Ignored while the owner's change runs
// (its own answer is newer) and while the box is leaving (control's answer to link.leave decides).
func (k *Keeper) Observe(st *device.DeviceLinkStatus) {
	if st == nil || (&device.LinkStatusResponse{Link: *st}).Validate() != nil {
		return
	}
	k.mu.Lock()
	defer k.unlock()
	if k.busy || k.rec.Leaving {
		return
	}
	if err := k.saveLocked(adopt(k.rec, st, k.now())); err != nil {
		k.log().Warn("link: the state control sent wasn't kept", "err", err)
	}
	k.poke()
}

func (k *Keeper) poke() {
	select {
	case k.wake <- struct{}{}:
	default:
	}
}

func (k *Keeper) begin() error {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.busy {
		return ErrBusy
	}
	k.busy = true
	return nil
}

func (k *Keeper) end() {
	k.mu.Lock()
	k.busy = false
	k.mu.Unlock()
}

// refusal maps control's refusal of a link op to the keeper's errors (the error otherwise, ErrUnavailable-wrapped
// network failures included).
func refusal(err error) error {
	if err == nil {
		return nil
	}
	code, detail := controlapi.ErrorCodes(err)
	switch {
	case controlapi.IsRevoked(err):
		return fmt.Errorf("%w: %w", ErrRevoked, err)
	case code == "device_exists" || detail == "device_exists":
		return fmt.Errorf("%w: %w", ErrDeviceExists, err)
	case code == "registration_invalid" || detail == "registration_invalid":
		return fmt.Errorf("%w: %w", ErrInvalid, err)
	case code == "rate_limited" || detail == "rate_limited":
		return fmt.Errorf("%w: %w", ErrRateLimited, err)
	}
	return err
}

// On turns Link on for the owner: link.begin with the box's registration. contentProof is the runtime's ("" uses
// the one kept); name is the box's name for the confirm page ("" keeps the last). A box already on or in grace gets its
// state from control without a new code.
//
// While Link runs (on or in grace) the runtime also calls it with the box's name whenever the box is named or renamed,
// so the account site shows that name: an Easy box links at its first start, before its setup asks for one. Then only a
// name control wasn't given yet goes, and only once control says Link still runs (rename).
func (k *Keeper) On(ctx context.Context, contentProof, name string) (Record, error) {
	if !k.Available() {
		return k.Snapshot(), ErrUnavailable
	}
	if err := k.begin(); err != nil {
		return k.Snapshot(), err
	}
	defer k.end()
	if name != "" && running(k.Snapshot()) {
		return k.rename(ctx, contentProof, name)
	}
	return k.linkBegin(ctx, contentProof, name)
}

// running: Link is on or in grace, and the owner isn't turning it off.
func running(r Record) bool {
	return !r.Leaving && (r.State == protocol.LinkStateOn || r.State == protocol.LinkStateGrace)
}

// rename gives control the box's new name while Link runs. link.begin keeps a name it carries without a new code while
// control has Link on or in grace, but it starts Link again with a fresh code on a box whose Link ended meanwhile: so
// control's state is read first, and nothing goes when it no longer runs. The name control already has costs no call.
func (k *Keeper) rename(ctx context.Context, contentProof, name string) (Record, error) {
	if name == k.Snapshot().Name {
		return k.Snapshot(), nil
	}
	if err := k.status(ctx); err != nil {
		return k.Snapshot(), err
	}
	if !running(k.Snapshot()) {
		return k.Snapshot(), nil
	}
	return k.linkBegin(ctx, contentProof, name)
}

func (k *Keeper) linkBegin(ctx context.Context, contentProof, name string) (Record, error) {
	cur := k.Snapshot()
	if contentProof == "" {
		contentProof = cur.ContentProof
	}
	if name == "" {
		name = cur.Name
	}
	reg, err := k.Registration(contentProof)
	if err != nil {
		return cur, fmt.Errorf("the registration: %w", err)
	}
	if !device.VerifyRegistration(reg) {
		return cur, fmt.Errorf("%w: the registration's signatures don't verify", ErrInvalid)
	}
	body := device.LinkBeginRequest{Registration: *reg}
	if name != "" {
		body.Name = &name
	}
	var out device.LinkBeginResponse
	if err := k.Control.Do(ctx, device.DeviceOpNameLinkBegin, body, &out); err != nil {
		return cur, refusal(err)
	}
	if err := out.Validate(); err != nil {
		return cur, fmt.Errorf("link.begin answer: %w", err)
	}
	k.mu.Lock()
	defer k.unlock()
	next := adopt(k.rec, &out.Link, k.now())
	next.Leaving, next.ContentProof, next.Name = false, reg.ContentProof, name
	if err := k.saveLocked(next); err != nil {
		return k.rec, err
	}
	k.log().Info("link: on", "state", next.State, "pending", next.Pending != nil, "waitingForAddress", next.WaitingForAddress)
	k.poke()
	return k.rec, nil
}

// Off turns Link off for the owner. The box stops using Link at once; link.leave tells control (the subscription's
// quantity drops, the label stays the box's), now if it answers, else from the poll loop until it takes it.
func (k *Keeper) Off(ctx context.Context) (Record, error) {
	if !k.Available() {
		return k.Snapshot(), ErrUnavailable
	}
	if err := k.begin(); err != nil {
		return k.Snapshot(), err
	}
	defer k.end()
	k.mu.Lock()
	if k.rec.State == protocol.LinkStateOff && !k.rec.Leaving {
		if k.rec.CarriedOff {
			next := k.rec
			next.CarriedOff = false // the owner's choice: no more asking
			err := k.saveLocked(next)
			r := k.rec
			k.unlock()
			return r, err
		}
		r := k.rec
		k.unlock()
		return r, nil
	}
	next := k.rec
	next.Leaving, next.Want, next.Pending, next.WaitingForAddress = true, "", nil, false
	next.Carried, next.CarriedOff = false, false // the owner's choice: no more asking
	err := k.saveLocked(next)
	k.unlock()
	if err != nil {
		return k.Snapshot(), err
	}
	if err := k.leave(ctx); err != nil {
		k.log().Info("link: off on the box; control is told later", "err", err)
	}
	return k.Snapshot(), nil
}

// leave sends link.leave and takes control's answer.
func (k *Keeper) leave(ctx context.Context) error {
	var out device.LinkLeaveResponse
	if err := k.Control.Do(ctx, device.DeviceOpNameLinkLeave, device.LinkLeaveRequest{}, &out); err != nil {
		var he *controlapi.HTTPError
		if errors.As(err, &he) && (he.Status == 404 || controlapi.IsRevoked(err)) {
			// Control doesn't know the box (it never linked, or it was retired): nothing to leave.
			return k.settleOff()
		}
		return err
	}
	if err := out.Validate(); err != nil {
		return fmt.Errorf("link.leave answer: %w", err)
	}
	k.mu.Lock()
	defer k.unlock()
	next := adopt(k.rec, &out.Link, k.now())
	next.Leaving = false
	if next.State != protocol.LinkStateOff {
		// Control still has the box linked (another of the account's changes): the owner's off holds on the box.
		next.State, next.Since = protocol.LinkStateOff, k.now().UTC()
	}
	return k.saveLocked(next)
}

func (k *Keeper) settleOff() error {
	k.mu.Lock()
	defer k.unlock()
	next := k.rec
	next.State, next.Since, next.Leaving, next.Pending, next.WaitingForAddress = protocol.LinkStateOff, k.now().UTC(), false, nil, false
	return k.saveLocked(next)
}

// WantOn records the owner's choice from the reach file (seq) and has the poll loop begin Link until control answers.
// A box already linked (starting, on, grace) only records the seq.
func (k *Keeper) WantOn(seq uint64) error {
	k.mu.Lock()
	defer k.unlock()
	next := k.rec
	next.ReachSeq = seq
	if !next.Active() {
		next.Want = "on"
	}
	err := k.saveLocked(next)
	k.poke()
	return err
}

// ReachSeen records that the reach file's seq was acted on (without a change to Link).
func (k *Keeper) ReachSeen(seq uint64) error {
	k.mu.Lock()
	defer k.unlock()
	next := k.rec
	next.ReachSeq = seq
	return k.saveLocked(next)
}

// Status is the state as the manager socket answers it (local.LocalLinkStatus).
func (r Record) Status() local.LocalLinkStatus {
	rfc := func(t time.Time) string { return t.UTC().Format(time.RFC3339) }
	opt := func(t *time.Time) *string {
		if t == nil {
			return nil
		}
		s := rfc(*t)
		return &s
	}
	str := func(s string) *string {
		if s == "" {
			return nil
		}
		return &s
	}
	state := r.State
	if state == "" || r.Leaving {
		state = protocol.LinkStateOff
	}
	out := local.LocalLinkStatus{State: state, Since: rfc(r.Since), GraceEndsAt: opt(r.GraceEndsAt),
		TrialEndsAt: opt(r.TrialEndsAt), Label: str(r.Label), Email: str(r.Email), CheckedAt: opt(r.CheckedAt)}
	if r.Pending != nil && state == protocol.LinkStateStarting {
		out.Pending = &local.LocalLinkPending{Code: r.Pending.Code, URL: r.Pending.URL, ExpiresAt: rfc(r.Pending.ExpiresAt)}
	}
	if r.WaitingForAddress && state == protocol.LinkStateStarting {
		t := true
		out.WaitingForAddress = &t
	}
	return out
}

// The poll loop's waits per state: soon while a person types the code, now and then otherwise (every ticket answer
// brings the state too). Once Link ended the box has no tickets, so link.status is the only way it hears that its owner
// subscribed again: as often as in grace, so it comes back within minutes, not hours (LNK-06).
const (
	pollPending  = 5 * time.Second
	pollWaiting  = time.Minute
	pollOn       = time.Hour
	pollGrace    = 15 * time.Minute
	pollEnded    = 15 * time.Minute
	retryBase    = 15 * time.Second
	retryMax     = 30 * time.Minute
	carriedRetry = time.Hour
)

// Run keeps the state fresh: link.status while Link is known, link.begin again when a code ran out or the owner's
// choice waits, link.leave until control takes it. A box with Link off makes no call at all.
func (k *Keeper) Run(ctx context.Context) {
	if !k.Available() {
		return
	}
	failures := 0
	for ctx.Err() == nil {
		wait, err := k.step(ctx)
		if err != nil {
			failures++
			wait = min(retryBase<<min(failures-1, 10), retryMax)
			if errors.Is(err, ErrRevoked) || errors.Is(err, ErrDeviceExists) || errors.Is(err, ErrInvalid) {
				wait = retryMax
			}
			k.log().Info("link: control didn't answer as hoped; trying again", "err", err, "in", wait)
		} else {
			failures = 0
		}
		select {
		case <-ctx.Done():
		case <-k.wake:
		case <-time.After(wait):
		}
	}
}

// step does what the state asks for now and answers how long until the next look.
func (k *Keeper) step(ctx context.Context) (time.Duration, error) {
	if err := k.begin(); err != nil {
		return time.Second, nil
	}
	defer k.end()
	r, now := k.Snapshot(), k.now()
	switch {
	case r.Leaving:
		return pollOn, k.leave(ctx)
	case r.Want == "on" && !r.Active():
		_, err := k.linkBegin(ctx, "", "")
		return pollPending, err
	case (r.State == protocol.LinkStateOff || r.State == "") && !r.CarriedOff:
		return 24 * time.Hour, nil // no calls; a change wakes the loop
	case r.State == protocol.LinkStateStarting && r.Pending == nil && !r.WaitingForAddress && r.CheckedAt != nil:
		// The code ran out (control answers starting without one): a fresh one for the screen.
		_, err := k.linkBegin(ctx, "", "")
		return pollPending, err
	case r.State == protocol.LinkStateStarting && r.Pending != nil && !now.Before(r.Pending.ExpiresAt):
		_, err := k.linkBegin(ctx, "", "")
		return pollPending, err
	}
	if err := k.status(ctx); err != nil {
		if r.Carried {
			// Control from before Link doesn't know link.status: the carried box keeps working as it did.
			return carriedRetry, nil
		}
		return 0, err
	}
	r = k.Snapshot()
	switch r.State {
	case protocol.LinkStateStarting:
		if r.WaitingForAddress {
			return pollWaiting, nil
		}
		return pollPending, nil
	case protocol.LinkStateGrace:
		return pollGrace, nil
	case protocol.LinkStateEnded:
		return pollEnded, nil
	case protocol.LinkStateOff:
		return pollEnded, nil // a carried box control turned off: until its comp
	}
	return pollOn, nil
}

func (k *Keeper) status(ctx context.Context) error {
	var out device.LinkStatusResponse
	if err := k.Control.Do(ctx, device.DeviceOpNameLinkStatus, device.LinkStatusRequest{}, &out); err != nil {
		return refusal(err)
	}
	if err := out.Validate(); err != nil {
		return fmt.Errorf("link.status answer: %w", err)
	}
	k.mu.Lock()
	defer k.unlock()
	if k.rec.Leaving {
		return nil
	}
	return k.saveLocked(adopt(k.rec, &out.Link, k.now()))
}
