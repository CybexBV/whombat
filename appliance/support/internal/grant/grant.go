// Package grant is the owner's grant of remote help (Whombat RH-01…RH-05; NX-413): which level support may use and
// until when, who turned it on, and on prod images the help code support must give. It is the only judge: Forever only
// where the image's environment isn't prod (RH-03), the help code only on prod (RH-05), five wrong codes end it.
//
// The grant survives restarts in one file (grant.json, 0600, replaced atomically). Every change closes and replaces the
// channel Changed returns, so the relay worker and the open connections look again at once; every change is an event
// (grant, stop, expired, locked_out). A grant whose time has passed is over the moment anyone asks (Level, CheckCode,
// Grant), and a timer ends it on time when nobody does.
package grant

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/CybexBV/whombat/appliance/helper/pkg/atomicfile"
	"github.com/CybexBV/whombat/appliance/support/internal/wire"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// Errors of Start and Stop.
var (
	ErrBadLevel          = errors.New("grant: the level is look or fix")
	ErrBadDuration       = errors.New("grant: the duration is an hour, a day, a week or forever")
	ErrForeverNotAllowed = errors.New("grant: forever is only for test Whombats")
	ErrBadPerson         = errors.New("grant: who isn't an account id and a name")
	ErrBadReason         = errors.New("grant: a stop is an owner's (with who) or the desk's (without)")
	ErrNotSaved          = errors.New("grant: the change couldn't be saved")
)

// recheck is the longest the timer sleeps: a wall clock that jumps (the first time sync after boot) is noticed within it.
const recheck = time.Minute

var accountID = regexp.MustCompile(`^acc_[A-Za-z0-9_-]{1,64}$`)

// Events is where changes are told (events.Log).
type Events interface {
	Add(wire.Event) wire.Event
}

// Options of a Store.
type Options struct {
	Path        string // grant.json
	Environment string // whombat.environment: local, dev or prod
	Events      Events
	Now         func() time.Time                                   // time.Now unless a test sets it
	After       func(d time.Duration, f func()) (stop func() bool) // time.AfterFunc unless a test sets it
	NewCode     func() (string, error)                             // wire.NewHelpCode unless a test sets it
	Logf        func(string, ...any)
}

// state is the active grant as it is kept.
type state struct {
	Level      string      `json:"level"`
	Since      time.Time   `json:"since"`
	Until      *time.Time  `json:"until"`
	GrantedBy  wire.Person `json:"grantedBy"`
	HelpCode   *string     `json:"helpCode"`
	WrongCodes int         `json:"wrongCodes"`
}

type file struct {
	V     int    `json:"v"`
	Grant *state `json:"grant"`
}

// Store holds the grant. The zero value isn't usable: Open it.
type Store struct {
	o       Options
	mu      sync.Mutex
	g       *state
	changed chan struct{}
	gen     uint64      // moves when a grant ends (Generation)
	stop    func() bool // the timer's
	closed  bool
}

// Open reads the grant at o.Path. A grant it can't read, or one that doesn't fit this image (a level, a code or a
// Forever it wouldn't give), is dropped: nothing is let in by a file it doesn't understand. One that ran out while the
// service was down ends now, with its expired event.
func Open(o Options) (*Store, error) {
	switch o.Environment {
	case wire.EnvLocal, wire.EnvDev, wire.EnvProd:
	default:
		return nil, fmt.Errorf("grant: environment %q isn't local, dev or prod", o.Environment)
	}
	if o.Events == nil {
		return nil, errors.New("grant: no event log")
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.After == nil {
		o.After = func(d time.Duration, f func()) func() bool { return time.AfterFunc(d, f).Stop }
	}
	if o.NewCode == nil {
		o.NewCode = wire.NewHelpCode
	}
	if o.Logf == nil {
		o.Logf = func(string, ...any) {}
	}
	s := &Store{o: o, changed: make(chan struct{})}
	b, err := os.ReadFile(o.Path)
	switch {
	case os.IsNotExist(err):
		return s, nil
	case err != nil:
		return nil, err
	}
	var f file
	if err := json.Unmarshal(b, &f); err != nil || f.V != 1 {
		o.Logf("whombat-support: grant: the saved grant isn't readable; remote help is off")
		s.saveLocked()
		return s, nil
	}
	if f.Grant == nil {
		return s, nil
	}
	if why := s.fits(f.Grant); why != "" {
		o.Logf("whombat-support: grant: the saved grant %s; remote help is off", why)
		s.saveLocked()
		return s, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.g = f.Grant
	if !s.expireLocked() {
		s.armLocked()
	}
	return s, nil
}

// fits says why a saved grant can't be this image's, or "".
func (s *Store) fits(g *state) string {
	switch {
	case g.Level != wire.LevelLook && g.Level != wire.LevelFix:
		return "has no level"
	case g.Since.IsZero():
		return "has no start"
	case g.Until == nil && !s.ForeverAllowed():
		return "is forever on a prod image"
	case validPerson(g.GrantedBy) != nil:
		return "names nobody"
	case s.HelpCodeRequired() && (g.HelpCode == nil || wire.NormalizeHelpCode(*g.HelpCode) != *g.HelpCode):
		return "has no help code"
	case !s.HelpCodeRequired() && g.HelpCode != nil:
		return "has a help code this image doesn't use"
	case g.WrongCodes < 0 || g.WrongCodes >= wire.WrongCodes:
		return "has too many wrong codes"
	}
	return ""
}

// Environment is the image's environment.
func (s *Store) Environment() string { return s.o.Environment }

// ForeverAllowed: Forever only on test Whombats (RH-03).
func (s *Store) ForeverAllowed() bool { return s.o.Environment != wire.EnvProd }

// HelpCodeRequired: the help code only on prod images (RH-05).
func (s *Store) HelpCodeRequired() bool { return s.o.Environment == wire.EnvProd }

// Start turns remote help on for level, for durationS seconds (nil: forever), granted by by; or changes the level and
// time of the grant that runs, keeping its start, its help code and its wrong codes (a change isn't a new grant). A new
// grant gets a new help code where one is required.
func (s *Store) Start(level string, durationS *int64, by wire.Person) (wire.Grant, error) {
	if level != wire.LevelLook && level != wire.LevelFix {
		return wire.Grant{}, ErrBadLevel
	}
	duration, ok := wire.DurationName(durationS)
	if !ok {
		return wire.Grant{}, ErrBadDuration
	}
	if durationS == nil && !s.ForeverAllowed() {
		return wire.Grant{}, ErrForeverNotAllowed
	}
	if err := validPerson(by); err != nil {
		return wire.Grant{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return wire.Grant{}, ErrNotSaved
	}
	s.expireLocked()
	now := s.o.Now().UTC().Truncate(time.Second)
	g := &state{Level: level, Since: now, GrantedBy: by}
	if durationS != nil {
		until := now.Add(time.Duration(*durationS) * time.Second)
		g.Until = &until
	}
	if old := s.g; old != nil {
		g.Since, g.HelpCode, g.WrongCodes = old.Since, old.HelpCode, old.WrongCodes
	} else if s.HelpCodeRequired() {
		code, err := s.o.NewCode()
		if err != nil || wire.NormalizeHelpCode(code) != code {
			s.o.Logf("whombat-support: grant: no help code: %v", err)
			return wire.Grant{}, ErrNotSaved
		}
		g.HelpCode = &code
	}
	old := s.g
	s.g = g
	if err := s.saveLocked(); err != nil {
		s.g = old
		return wire.Grant{}, ErrNotSaved
	}
	s.armLocked()
	s.changeLocked()
	s.o.Events.Add(wire.Event{Kind: wire.EventGrant, Level: wire.Ptr(protocol.RemoteHelpLevel(level)),
		Duration: wire.Ptr(protocol.RemoteHelpDuration(duration)), By: &by})
	return s.wireLocked(), nil
}

// Stop turns remote help off now: reason owner (with by) or desk (without). Stopping what is off changes nothing and
// tells nobody. The grant is off in memory whatever happens on disk; ErrNotSaved says the file still holds it (it would
// come back after a restart until its time ran out).
func (s *Store) Stop(reason string, by *wire.Person) error {
	switch {
	case reason == wire.StopOwner && by != nil:
		if err := validPerson(*by); err != nil {
			return err
		}
	case reason == wire.StopDesk && by == nil:
	default:
		return ErrBadReason
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.expireLocked() || s.g == nil {
		return nil
	}
	e := wire.Event{Kind: wire.EventStop, Reason: wire.Ptr(protocol.RemoteHelpOffReason(reason))}
	if by != nil {
		p := *by
		e.By = &p
	}
	return s.endLocked(e)
}

// Expire ends the grant now as if its time had run out: the image can no longer let anyone in (it pins no support CA
// any more), and a grant nobody can use isn't shown as on.
func (s *Store) Expire() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.expireLocked() && s.g != nil {
		_ = s.endLocked(wire.Event{Kind: wire.EventExpired})
	}
}

// Grant is the active grant with its help code (nil: off).
func (s *Store) Grant() *wire.Grant {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.expireLocked() || s.g == nil {
		return nil
	}
	g := s.wireLocked()
	return &g
}

// Level is the active grant's level, or "" (Gate).
func (s *Store) Level() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.expireLocked() || s.g == nil {
		return ""
	}
	return s.g.Level
}

// CheckCode says whether the SSH user name support gave is the help code (Gate): normalised, compared in constant time.
// Without a grant nothing passes; where no code is required anything does. A wrong code counts, and the fifth ends the
// grant (locked_out, RH-05). Neither code is ever logged.
func (s *Store) CheckCode(user string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.expireLocked() || s.g == nil {
		return false
	}
	if !s.HelpCodeRequired() {
		return true
	}
	if s.g.HelpCode != nil && wire.HelpCodeMatches(user, *s.g.HelpCode) {
		return true
	}
	s.g.WrongCodes++
	if s.g.WrongCodes >= wire.WrongCodes {
		_ = s.endLocked(wire.Event{Kind: wire.EventLockedOut})
		return false
	}
	_ = s.saveLocked()
	return false
}

// Changed is closed (and replaced) when the grant starts, changes or ends (Gate).
func (s *Store) Changed() <-chan struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.changed
}

// Generation moves whenever a grant ends (stopped, expired or locked out), so a connection that signed in under one
// grant never carries over into the next, even when both changes happen before it looks again (Gate).
func (s *Store) Generation() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expireLocked()
	return s.gen
}

// Close stops the timer; the grant stays saved for the next start.
func (s *Store) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	if s.stop != nil {
		s.stop()
		s.stop = nil
	}
}

// expireLocked ends a grant whose time has passed; true when it did.
func (s *Store) expireLocked() bool {
	if s.g == nil || s.g.Until == nil || s.o.Now().Before(*s.g.Until) {
		return false
	}
	_ = s.endLocked(wire.Event{Kind: wire.EventExpired})
	return true
}

// endLocked ends the grant with event e.
func (s *Store) endLocked(e wire.Event) error {
	s.g = nil
	s.gen++
	if s.stop != nil {
		s.stop()
		s.stop = nil
	}
	err := s.saveLocked()
	s.changeLocked()
	s.o.Events.Add(e)
	return err
}

// tick is the timer's: it ends a grant whose time has passed, or sleeps again.
func (s *Store) tick() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.stop = nil
	if !s.expireLocked() {
		s.armLocked()
	}
}

// armLocked sets the timer for the grant's end (at most recheck away); a forever grant needs none.
func (s *Store) armLocked() {
	if s.stop != nil {
		s.stop()
		s.stop = nil
	}
	if s.closed || s.g == nil || s.g.Until == nil {
		return
	}
	d := min(max(s.g.Until.Sub(s.o.Now()), 0), recheck)
	s.stop = s.o.After(d, s.tick)
}

func (s *Store) changeLocked() {
	close(s.changed)
	s.changed = make(chan struct{})
}

// saveLocked writes the grant (or none). When the file can't be written, an end still removes it: what is off must not
// come back after a restart.
func (s *Store) saveLocked() error {
	b, err := json.Marshal(file{V: 1, Grant: s.g})
	if err == nil {
		err = atomicfile.WriteFile(s.o.Path, b, 0o600)
	}
	if err == nil {
		return nil
	}
	s.o.Logf("whombat-support: grant: can't save the grant: %v", err)
	if s.g == nil {
		if rerr := os.Remove(s.o.Path); rerr == nil || os.IsNotExist(rerr) {
			return nil
		}
	}
	return err
}

func (s *Store) wireLocked() wire.Grant {
	g := wire.Grant{Level: protocol.RemoteHelpLevel(s.g.Level), Since: stamp(s.g.Since), GrantedBy: s.g.GrantedBy,
		WrongCodes: int64(s.g.WrongCodes)}
	if s.g.Until != nil {
		u := stamp(*s.g.Until)
		g.Until = &u
	}
	if s.g.HelpCode != nil {
		c := *s.g.HelpCode
		g.HelpCode = &c
	}
	return g
}

func stamp(t time.Time) string { return t.UTC().Format(time.RFC3339) }

// validPerson checks an owner as the contract has them: an `acc_` id and a name of 1…120 code points on one line
// (RemoteHelpGrantedBy: no control, format or surrogate code point, no separator but a space).
func validPerson(p wire.Person) error {
	if !accountID.MatchString(p.AccountID) || !utf8.ValidString(p.Name) {
		return ErrBadPerson
	}
	n := 0
	for _, r := range p.Name {
		n++
		if r != ' ' && unicode.In(r, unicode.Cc, unicode.Cf, unicode.Cs, unicode.Z) {
			return ErrBadPerson
		}
	}
	if n < 1 || n > 120 {
		return ErrBadPerson
	}
	return nil
}
