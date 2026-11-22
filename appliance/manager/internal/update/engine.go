package update

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"maps"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/atomicfile"
	"github.com/CybexBV/whombat/appliance/helper/pkg/proto"
	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/manager/internal/health"
	"github.com/CybexBV/whombat/appliance/manager/internal/journal"
	"github.com/CybexBV/whombat/appliance/manager/internal/runtimeapi"
	"github.com/CybexBV/whombat/contracts/go/release"
)

// Helper runs typed helper operations.
type Helper interface {
	Do(ctx context.Context, req proto.Request) (*proto.Result, error)
}

// Runtime is the runtime admin endpoint (safe-boundary protocol).
type Runtime interface {
	Drain(ctx context.Context, r runtimeapi.DrainRequest) (*runtimeapi.DrainStatus, error)
	Resume(ctx context.Context, requestID string) error
}

// HealthChecker evaluates local health.
type HealthChecker interface {
	Check(ctx context.Context, expectVersion string) health.Evidence
}

// Host exposes boot identity and the booted system.
type Host interface {
	BootID() (string, error)
	CurrentSystem() (string, error)
}

// Staging downloads and verifies artifacts.
type Staging interface {
	EnsureSpace(arts []trust.Artifact, keep map[string]bool) error
	Download(ctx context.Context, a trust.Artifact) error
	Present(a trust.Artifact) bool
	// ReadStaged returns a staged, verified file (closure indexes; bounded by the artifact's length).
	ReadStaged(a trust.Artifact) ([]byte, error)
	// Prune removes staged files not in keep once an update has finished (MG-60).
	Prune(keep map[string]bool) (files int, bytes int64)
}

// CheckpointRequest asks the backup service for a consistent, verified checkpoint (MD-06, MA-13)
// while the runtime is quiesced at a safe boundary. UnderDrain is the manager's drain request id
// (local CheckpointRequest.underDrain, CT-30).
type CheckpointRequest struct {
	ReleaseID  string
	Migrations []string
	UnderDrain string
}

// Checkpointer takes verified checkpoints (the appliance backup service).
type Checkpointer interface {
	Checkpoint(ctx context.Context, req CheckpointRequest) (ref string, err error)
}

// Policy holds the tunables (defaults in DefaultPolicy, MG-07).
type Policy struct {
	MaxAttempts     int
	RetryBase       time.Duration
	RetryMax        time.Duration
	NoSpaceRetry    time.Duration
	DrainLease      time.Duration
	DrainPoll       time.Duration
	DrainWindow     time.Duration
	DeferralRecheck time.Duration
	// While running work keeps the safe boundary away, the manager doesn't hold the runtime drained: it asks every
	// ProbeInterval, in a drain it gives back as soon as the runtime answers, and holds DrainWindow windows only once
	// it has asked for DrainHoldAfter without finding a quiet moment (MG-137).
	ProbeInterval         time.Duration
	DrainHoldAfter        time.Duration
	DeferralEscalateAfter time.Duration
	RuntimeDownGrace      time.Duration
	VerifyTimeout         time.Duration
	// HostRebootTimeout: how long a host activation may take to reboot into the candidate (or back to known-good)
	// before verification starts counting; the replaced manager sets the deadline at activation (MG-55).
	HostRebootTimeout time.Duration
	// RollbackRetryBase/Max: a failing rollback step (the helper) is retried after RollbackRetryBase, doubling up to
	// RollbackRetryMax, and never given up (MG-55).
	RollbackRetryBase time.Duration
	RollbackRetryMax  time.Duration
	// A release that failed verification after it was activated is retried only when control assigns it again, not
	// before VerifyRetryDelay since the failure, and quarantined after MaxVerifyFailures such failures (MG-56).
	VerifyRetryDelay  time.Duration
	MaxVerifyFailures int
	HealthInterval    time.Duration
	HealthyStreak     int
	IdleInterval      time.Duration
	// CheckpointRetry: a checkpoint request that lost its connection to the backup service (EOF, refused, reset: the
	// API restarting) is asked again after this, up to CheckpointRetries times, before the update waits for the next
	// window. A refusal the service answered (unprotected, a failed snapshot) is not retried.
	CheckpointRetry   time.Duration
	CheckpointRetries int
}

// DefaultPolicy returns production defaults.
func DefaultPolicy() Policy {
	return Policy{
		MaxAttempts: 3, RetryBase: time.Minute, RetryMax: time.Hour, NoSpaceRetry: 30 * time.Minute,
		DrainLease: 2 * time.Minute, DrainPoll: 5 * time.Second, DrainWindow: 10 * time.Minute,
		DeferralRecheck: 15 * time.Minute, ProbeInterval: 30 * time.Second, DrainHoldAfter: 6 * time.Hour,
		DeferralEscalateAfter: 24 * time.Hour, RuntimeDownGrace: 5 * time.Minute,
		VerifyTimeout: 10 * time.Minute, HostRebootTimeout: 20 * time.Minute, HealthInterval: 10 * time.Second,
		RollbackRetryBase: 5 * time.Second, RollbackRetryMax: 10 * time.Minute,
		VerifyRetryDelay: 30 * time.Minute, MaxVerifyFailures: 2,
		HealthyStreak: 3, IdleInterval: time.Minute,
		CheckpointRetry: 5 * time.Second, CheckpointRetries: 3,
	}
}

// Engine drives the state machine.
type Engine struct {
	J            *journal.Journal
	Helper       Helper
	Runtime      Runtime
	Health       HealthChecker
	Host         Host
	Staging      Staging
	Checkpointer Checkpointer // nil: candidates that need a checkpoint wait with an explanation
	// Refresh refreshes TUF metadata and the helper's mirror (called when the helper reports stale
	// metadata); nil to rely on the daemon's periodic refresh.
	Refresh        func(ctx context.Context) error
	AssignmentPath string
	Now            func() time.Time
	Policy         Policy
	// RecoveryMode (known-good recovery manager): finish or start rollbacks, never activate.
	RecoveryMode bool
	// Crash is a test hook called at every crash point; a non-nil error aborts the step there.
	Crash func(point string) error
	// OnTransition is called after every persisted state, with its JournalSeq, in journal order (status reporting;
	// must not block on the network, nor call back into the engine: the daemon records the report durably and returns,
	// SR-03, SR-11).
	OnTransition func(State)
	// Heartbeat, when set, is called every HeartbeatEvery (default 20 s) while a step waits for the store collection
	// after an update, a bounded helper operation that may take minutes (UP-X19): the engine loop is the manager's
	// watchdog heartbeat (MG-16).
	Heartbeat      func()
	HeartbeatEvery time.Duration
	Log            *slog.Logger
	// Channel returns the box's update channel (the helper's, LNK-21); nil or "": not known, nothing is checked. A
	// candidate a channel offered is retired before any drain when the box follows another channel now.
	Channel func() string

	// wmu serializes the journal writes: each checks that the journal is still at the record its state was loaded
	// from (SR-11). Held for the write, the assignment file and OnTransition only, never across a network call or a
	// health check.
	wmu sync.Mutex
	// conflicts counts the steps in a row that lost to a concurrent mutation.
	conflicts atomic.Int64
}

// ErrConflict: another mutation wrote the journal after this one loaded it (SR-11). The engine's own entry points
// load again and redo the mutation; callers see it only if that keeps failing.
var ErrConflict = errors.New("the journal changed since it was loaded")

// conflictRetries bounds how often a mutation is redone after ErrConflict.
const conflictRetries = 20

// retry runs a mutation (load, change, persist) again while a concurrent one wrote the journal in between.
func retry[T any](f func() (T, error)) (T, error) {
	for i := 0; ; i++ {
		v, err := f()
		if !errors.Is(err, ErrConflict) || i == conflictRetries {
			return v, err
		}
	}
}

// foreign are the fields that Offer, the hold, the maintenance lock and the owner's ask and approval change, besides the
// steps (SR-13).
type foreign struct {
	Hold              bool
	ChannelPaused     bool
	ChannelVersions   map[string]int64
	AskFirst          bool
	Approved          string
	Lock              *Lock
	Pending           *PendingAssignment
	LastAssignmentSeq int64
	LastOffer         string
	TimeFloor         int64
	// The candidate's assignment, renewed by Offer while it is in flight.
	AssignmentSeq int64
	NotBefore     int64
	AssignmentRaw []byte
}

func foreignOf(st *State) foreign {
	f := foreign{Hold: st.Hold, ChannelPaused: st.ChannelPaused, ChannelVersions: maps.Clone(st.ChannelVersions),
		AskFirst: st.AskFirst, Approved: st.Approved, Lock: st.Lock, Pending: st.Pending,
		LastAssignmentSeq: st.LastAssignmentSeq, LastOffer: st.LastOffer, TimeFloor: st.TimeFloor}
	if c := st.Candidate; c != nil {
		f.AssignmentSeq, f.NotBefore, f.AssignmentRaw = c.AssignmentSeq, c.NotBefore, c.AssignmentRaw
	}
	return f
}

func setForeign(st *State, f foreign) {
	st.Hold, st.ChannelPaused, st.ChannelVersions = f.Hold, f.ChannelPaused, maps.Clone(f.ChannelVersions)
	st.AskFirst, st.Approved = f.AskFirst, f.Approved
	st.Lock, st.Pending, st.LastAssignmentSeq, st.TimeFloor = f.Lock, f.Pending, f.LastAssignmentSeq, f.TimeFloor
	st.LastOffer = f.LastOffer
	if c := st.Candidate; c != nil {
		c.AssignmentSeq, c.NotBefore, c.AssignmentRaw = f.AssignmentSeq, f.NotBefore, f.AssignmentRaw
	}
}

func digest(v any) string {
	b, _ := json.Marshal(v)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// restDigest digests the state without its foreign fields and its derived record.
func restDigest(st *State) string {
	c := *st
	if st.Candidate != nil {
		cc := *st.Candidate
		c.Candidate = &cc
	}
	setForeign(&c, foreign{})
	c.Record = release.UpdateJournalRecord{}
	c.JournalSeq = 0
	return digest(&c)
}

// merge lets a step's save take a concurrent change of the foreign fields instead of dropping the step (SR-13):
// only for a step that may (st.mergeable: the activation, whose steps read none of them and have effects that must
// not run twice), that changed none of them itself, and whose other fields nobody changed meanwhile.
func (e *Engine) merge(st *State) bool {
	if !st.mergeable || digest(foreignOf(st)) != st.base.foreign {
		return false
	}
	cur, err := e.Load()
	if err != nil || cur.base.rest != st.base.rest {
		return false
	}
	setForeign(st, foreignOf(cur))
	st.JournalSeq = cur.JournalSeq
	st.Record = e.contractRecord(st)
	if st.Record.Validate() != nil {
		return false
	}
	e.log().Info("update step kept over a concurrent change of the hold, lock, owner's approval or assignments (SR-13)", "phase", st.Phase)
	return true
}

// syncAssignment makes the assignment file the candidate's signed assignment (SR-12): the helper checks it at
// activation, so it must be the one of the candidate the journal holds, never an assignment whose save lost.
// Called with wmu held.
func (e *Engine) syncAssignment(st *State) error {
	c := st.Candidate
	if c == nil || len(c.AssignmentRaw) == 0 {
		return nil
	}
	if b, err := os.ReadFile(e.AssignmentPath); err == nil && bytes.Equal(b, c.AssignmentRaw) {
		return nil
	}
	return e.writeAssignment(c.AssignmentRaw)
}

// syncAssignmentOf is syncAssignment at the start of a step: the file may be behind after a crash between the file
// and the journal write, or after a failed write.
func (e *Engine) syncAssignmentOf(st *State) error {
	e.wmu.Lock()
	defer e.wmu.Unlock()
	if e.J.Seq() != st.JournalSeq {
		return nil // written meanwhile: the next step looks again
	}
	c := st.Candidate
	if c != nil && len(c.AssignmentRaw) > 0 {
		if b, err := os.ReadFile(e.AssignmentPath); err != nil || !bytes.Equal(b, c.AssignmentRaw) {
			e.log().Warn("the assignment file is not the candidate's; written again (SR-12)", "release", c.Tuple.ReleaseID)
		}
	}
	return e.syncAssignment(st)
}

// ErrNotProvisioned means the journal has no installed tuple yet.
var ErrNotProvisioned = errors.New("manager journal not provisioned")

// ErrBadTransition is a programming error: a transition the contract forbids.
var ErrBadTransition = errors.New("update journal transition not allowed by the contract")

func (e *Engine) now() time.Time {
	if e.Now != nil {
		return e.Now()
	}
	return time.Now()
}

func (e *Engine) log() *slog.Logger {
	if e.Log != nil {
		return e.Log
	}
	return slog.Default()
}

func (e *Engine) crash(point string) error {
	if e.Crash != nil {
		return e.Crash(point)
	}
	return nil
}

func (e *Engine) effect(name string) error { return e.crash("effect:" + name) }

// Load returns the current journal state.
func (e *Engine) Load() (*State, error) {
	var st State
	seq, found, err := e.J.LoadSeq(&st)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, ErrNotProvisioned
	}
	st.JournalSeq = seq
	st.base.rest, st.base.foreign = restDigest(&st), digest(foreignOf(&st))
	if st.Quarantine == nil {
		st.Quarantine = map[string]Quarantine{}
	}
	return &st, nil
}

// Provision records the factory tuple as current and known-good (first boot).
func (e *Engine) Provision(rel *trust.Release) error {
	if _, err := e.Load(); err == nil {
		return errors.New("already provisioned")
	} else if !errors.Is(err, ErrNotProvisioned) {
		return err
	}
	t := TupleOf(rel)
	st := &State{Phase: Healthy, Current: t, KnownGood: t, Quarantine: map[string]Quarantine{}}
	st.record("", Healthy, t.ReleaseID, "provisioned", e.now())
	st.Record = e.contractRecord(st)
	if err := st.Record.Validate(); err != nil {
		return fmt.Errorf("journal record: %w", err)
	}
	return e.J.Save(st)
}

// contractRecord derives the @whombat/release UpdateJournalRecord view of the state.
func (e *Engine) contractRecord(st *State) release.UpdateJournalRecord {
	r := release.UpdateJournalRecord{V: 1, State: st.Phase, UpdateClass: string(ClassRuntime), MaxAttempts: int64(max(e.Policy.MaxAttempts, 1)),
		AssignmentSequence: st.LastAssignmentSeq, UpdatedAt: e.now().Unix(), Health: []release.HealthEvidence{}}
	if st.Current != nil {
		r.Current = st.Current.ReleaseID
	}
	if st.KnownGood != nil {
		r.KnownGood = st.KnownGood.ReleaseID
	}
	r.MaintenanceLock = st.Activation() || (st.Lock != nil && e.now().Before(st.Lock.Expires))
	var f *Failure
	if c := st.Candidate; c != nil {
		id := c.Tuple.ReleaseID
		r.Candidate = &id
		r.UpdateClass = string(c.Class)
		r.AssignmentSequence = c.AssignmentSeq
		r.Attempt = int64(min(c.Attempts, 100))
		f = c.Failure
		if c.Rollback != nil && f == nil {
			code := c.Rollback.Code
			r.Failure = &code
		}
		if n := len(c.Evidence); n > 0 {
			r.Health = contractEvidence(c.Evidence[n-1], c.Class == ClassHost)
		}
	} else if st.Phase != Healthy {
		f = st.LastFailure
	}
	if f != nil && f.Code != "" {
		code := f.Code
		r.Failure = &code
	}
	return r
}

func contractEvidence(ev health.Evidence, host bool) []release.HealthEvidence {
	at := ev.At.Unix()
	mk := func(check string, ok bool, code string) release.HealthEvidence {
		h := release.HealthEvidence{Check: check, Ok: ok, At: at}
		if code != "" {
			h.Code = &code
		}
		return h
	}
	code := func(ok bool, c string) string {
		if ok {
			return ""
		}
		return c
	}
	runtimeOK := ev.ProcessActive && ev.RuntimeReachable && ev.RuntimeStatus == "ok" && ev.VersionMatches
	out := []release.HealthEvidence{
		mk("runtime", runtimeOK, code(runtimeOK, "runtime_unhealthy")),
		mk("database", ev.DB && ev.Migrations, code(ev.DB && ev.Migrations, "schema_or_db")),
		mk("session_endpoint", ev.SessionListening, code(ev.SessionListening, "not_listening")),
	}
	if host {
		out = append(out, mk("boot", true, ""))
	}
	return out
}

func (e *Engine) persist(st *State, to Phase, note string) error {
	from := st.Phase
	if from != to && !release.CanTransition(from, to) {
		return fmt.Errorf("%w: %s -> %s", ErrBadTransition, from, to)
	}
	id := ""
	if st.Current != nil {
		id = st.Current.ReleaseID
	}
	if st.Candidate != nil {
		id = st.Candidate.Tuple.ReleaseID
		if from != to {
			st.Candidate.PhaseSince = e.now()
		}
	}
	if from != to {
		st.record(from, to, id, note, e.now())
	}
	endApproval(st, to)
	st.Phase = to
	st.Record = e.contractRecord(st)
	if err := st.Record.Validate(); err != nil {
		return fmt.Errorf("journal record violates the contract: %w", err)
	}
	if err := e.crash(fmt.Sprintf("persist:%s->%s:before", from, to)); err != nil {
		return err
	}
	e.wmu.Lock()
	defer e.wmu.Unlock()
	// SR-11: st was loaded (or last saved) as record st.JournalSeq; if another mutation wrote since, saving st would
	// undo it (a lost update). The caller loads again and redoes its change, unless SR-13 lets it keep it.
	if cur := e.J.Seq(); st.JournalSeq != cur && !e.merge(st) {
		return fmt.Errorf("%w: %s -> %s from record %d, the journal is at %d", ErrConflict, from, to, st.JournalSeq, cur)
	}
	if err := e.syncAssignment(st); err != nil {
		return err
	}
	seq, err := e.J.SaveSeq(st)
	if err != nil {
		return err
	}
	st.JournalSeq = seq
	if err := e.crash(fmt.Sprintf("persist:%s->%s:after", from, to)); err != nil {
		return err
	}
	if from != to {
		e.log().Info("update transition", "from", from, "to", to, "release", id, "note", note)
	}
	if e.OnTransition != nil {
		e.OnTransition(*st) // under wmu: reports are recorded in journal order
	}
	return nil
}

func newID(prefix string) string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return prefix + hex.EncodeToString(b)
}

// Offered is an assignment the manager already verified (signature, scope, TUF approval, tuple
// compatibility). The engine decides whether to start, queue, hold or refuse it.
type Offered struct {
	Raw     []byte
	Payload *release.AssignmentPayload
	Release *trust.Release // nil for a hold
	// Channel is the channel whose newest release this is (OfferLatest); "" for control's assignments and a
	// community box's offers.
	Channel string
	// ChannelVersion is the verified TUF role version of Channel (OfferLatest); 0 when none.
	ChannelVersion int64
}

// Decision is the outcome of Offer.
type Decision string

// Offer decisions.
const (
	DecisionStarted Decision = "started"
	DecisionQueued  Decision = "queued"
	DecisionNoop    Decision = "noop"
	DecisionHold    Decision = "hold"
	DecisionRefused Decision = "refused"
)

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

type decided struct {
	d   Decision
	why string
}

// Offer considers a verified assignment.
func (e *Engine) Offer(ctx context.Context, o Offered) (Decision, string, error) {
	r, err := retry(func() (decided, error) {
		d, why, err := e.offer(ctx, o)
		return decided{d, why}, err
	})
	return r.d, r.why, err
}

func (e *Engine) offer(ctx context.Context, o Offered) (Decision, string, error) {
	st, err := e.Load()
	if err != nil {
		return "", "", err
	}
	p := o.Payload
	if p.Sequence <= st.LastAssignmentSeq {
		return DecisionNoop, "already processed", nil
	}
	if p.IssuedAt > st.TimeFloor {
		st.TimeFloor = p.IssuedAt
	}
	if p.Action == "hold" {
		// Pause/emergency stop: stay on the current tuple, start no activation, interrupt nothing.
		st.LastAssignmentSeq, st.Hold = p.Sequence, true
		return DecisionHold, "rollout on hold", e.persist(st, st.Phase, "hold assignment "+deref(p.RolloutID))
	}
	rel := o.Release
	id := rel.Tuple.ReleaseID
	if o.Channel != "" {
		if ok, why := e.channelRepoFresh(st, o.Channel, o.ChannelVersion); !ok {
			return DecisionNoop, why, nil
		}
		st.LastOffer = offerKey(o.Channel, rel.Digest)
		recordChannelVersion(st, o.Channel, o.ChannelVersion)
	}
	if q, ok := st.Quarantine[id]; ok && q.Digest == rel.Digest {
		st.LastAssignmentSeq = p.Sequence
		st.LastRefusal = fmt.Sprintf("release %s is quarantined on this device: %s", id, q.Reason)
		return DecisionRefused, st.LastRefusal, e.persist(st, st.Phase, "assignment refused: quarantined")
	}
	if err := forward(st, rel); err != nil {
		st.LastAssignmentSeq = p.Sequence
		st.LastRefusal = err.Error()
		e.log().Warn("assignment refused", "err", err)
		return DecisionRefused, st.LastRefusal, e.persist(st, st.Phase, "assignment refused: downgrade")
	}
	st.Hold = false
	if c := st.Candidate; c != nil && st.Phase == RolledBack && c.Tuple.Digest == rel.Digest && c.Failure != nil && c.Failure.AfterActivation {
		// Control assigns a release again that failed verification here (an operator's “Retry this Whombat”;
		// control holds such a device otherwise): it is retried, but not before VerifyRetryDelay since the failure
		// (MG-56).
		c.AssignmentSeq, c.NotBefore, c.RolloutID, c.Reassigned, c.AssignmentRaw = p.Sequence, p.NotBefore, deref(p.RolloutID), true, o.Raw
		reoffered(c, o)
		st.LastAssignmentSeq, st.Pending = p.Sequence, nil
		why := "control assigned it again; retried from " + c.Failure.At.Add(e.Policy.VerifyRetryDelay).UTC().Format(time.RFC3339)
		return DecisionQueued, why, e.persist(st, RolledBack, why)
	}
	if c := st.Candidate; c != nil && c.Tuple.Digest == rel.Digest && !st.Steady() && st.Phase != Failed {
		// Re-issued assignment for the release already in flight (renewed before expiry): keep
		// progress and refresh the assignment the helper checks.
		c.AssignmentSeq, c.NotBefore, c.AssignmentRaw = p.Sequence, p.NotBefore, o.Raw
		reoffered(c, o)
		st.LastAssignmentSeq, st.Pending = p.Sequence, nil
		return DecisionNoop, "assignment renewed", e.persist(st, st.Phase, "assignment renewed")
	}
	if st.Activation() || e.RecoveryMode {
		st.Pending = &PendingAssignment{Raw: o.Raw, Seq: p.Sequence, Release: rel, Rollout: deref(p.RolloutID), NotBefore: p.NotBefore, Channel: o.Channel}
		return DecisionQueued, "activation in progress", e.persist(st, st.Phase, "assignment queued")
	}
	if st.Current != nil && st.Current.Digest == rel.Digest {
		st.LastAssignmentSeq = p.Sequence
		if st.Candidate != nil && !st.Steady() {
			if err := e.abandon(ctx, st); err != nil {
				return "", "", err
			}
			st.Candidate = nil
		}
		return DecisionNoop, "already installed", e.persist(st, st.Phase, "")
	}
	if err := e.abandon(ctx, st); err != nil {
		return "", "", err
	}
	if err := e.start(st, o.Raw, p.Sequence, deref(p.RolloutID), p.NotBefore, rel); err != nil {
		return "", "", err
	}
	st.Candidate.Channel = o.Channel
	return DecisionStarted, "", e.persist(st, Assigned, "assignment "+deref(p.RolloutID))
}

// reoffered takes the channel and release of an offer of the candidate's own tuple: when the owner switched to a channel
// that offers the same release (a promotion), the candidate is that channel's now, so it isn't retired as off-channel.
func reoffered(c *Candidate, o Offered) {
	if o.Channel == "" {
		return
	}
	c.Channel, c.Release = o.Channel, o.Release
}

// forward refuses a release older than the installed one unless release custody allowed moving back
// from it (TUF-signed allowDowngradeFrom; MA-21c). The helper enforces the same at activation.
func forward(st *State, rel *trust.Release) error {
	cur := st.Current
	if cur == nil || cur.Release == nil || cur.Digest == rel.Digest {
		return nil
	}
	v := trust.Versions{Host: cur.Release.Host.Version, Runtime: cur.Release.Runtime.Version, Manager: cur.Release.Manager.Version}
	return trust.CheckForward(cur.ReleaseID, v, rel)
}

// abandon releases a pre-activation candidate (resuming the runtime if it is drained).
func (e *Engine) abandon(ctx context.Context, st *State) error {
	c := st.Candidate
	if c == nil {
		return nil
	}
	if c.Deferral != nil && c.Deferral.Draining {
		if err := e.Runtime.Resume(ctx, c.DrainRequestID); err != nil {
			return fmt.Errorf("resume runtime before abandoning candidate: %w", err)
		}
		c.Deferral.Draining = false
	}
	return nil
}

func (e *Engine) writeAssignment(raw []byte) error {
	if err := os.MkdirAll(filepath.Dir(e.AssignmentPath), 0o755); err != nil {
		return err
	}
	return atomicfile.WriteFile(e.AssignmentPath, raw, 0o644)
}

// classOf maps release.UpdateClass (CT-35) to the activation path: host (reboot) when the host
// generation or the manager changes, otherwise runtime.
func classOf(current *Tuple, rel *trust.Release) Class {
	if current == nil || current.Release == nil {
		return ClassHost
	}
	switch release.UpdateClass(current.Release, &rel.Tuple) {
	case release.UpdateClassHost, release.UpdateClassRuntimeHost:
		return ClassHost
	}
	return ClassRuntime
}

// start makes rel the candidate; its assignment file is written with the save that records it (SR-12).
func (e *Engine) start(st *State, raw []byte, seq int64, rollout string, notBefore int64, rel *trust.Release) error {
	attempts := 0
	if st.Candidate != nil && st.Candidate.Tuple.Digest == rel.Digest {
		// The same release still in flight (after a failure before anything changed, or a forward repair that only
		// this release finishes) keeps its attempts and the owner's approval.
		attempts = st.Candidate.Attempts
	} else {
		st.Approved = "" // another release: it waits for its own yes
	}
	st.Candidate = &Candidate{Release: rel, Tuple: TupleOf(rel), Class: classOf(st.Current, rel), AssignmentSeq: seq,
		RolloutID: rollout, NotBefore: notBefore, Attempts: attempts, PhaseSince: e.now(), AssignmentRaw: raw}
	st.LastAssignmentSeq, st.Pending, st.LastRefusal = seq, nil, ""
	return nil
}

// SetHold lets an operator (or control rollout state) hold activations locally.
func (e *Engine) SetHold(hold bool) error {
	_, err := retry(func() (struct{}, error) { return struct{}{}, e.setHold(hold) })
	return err
}

func (e *Engine) setHold(hold bool) error {
	st, err := e.Load()
	if err != nil {
		return err
	}
	if st.Hold == hold {
		return nil
	}
	st.Hold = hold
	return e.persist(st, st.Phase, fmt.Sprintf("hold=%v", hold))
}

// SetChannelPaused records whether the box's update channel currently carries the signed TUF pause marker.
func (e *Engine) SetChannelPaused(paused bool) error {
	_, err := retry(func() (struct{}, error) { return struct{}{}, e.setChannelPaused(paused) })
	return err
}

func (e *Engine) setChannelPaused(paused bool) error {
	st, err := e.Load()
	if err != nil {
		return err
	}
	if st.ChannelPaused == paused {
		return nil
	}
	st.ChannelPaused = paused
	note := "channel resumed"
	if paused {
		note = "channel paused"
	}
	return e.persist(st, st.Phase, note)
}

func (e *Engine) channelRepoFresh(st *State, channel string, version int64) (bool, string) {
	if channel == "" {
		return true, ""
	}
	if e.Channel != nil {
		if cur := e.Channel(); cur == "" || channel != cur {
			return false, "wrong channel"
		}
	}
	if version < 0 {
		return false, "stale channel metadata"
	}
	if prev, ok := st.ChannelVersions[channel]; ok && prev > 0 && (version <= 0 || version < prev) {
		return false, "stale channel metadata"
	}
	return true, ""
}

func recordChannelVersion(st *State, channel string, version int64) {
	if channel == "" || version <= 0 {
		return
	}
	if st.ChannelVersions == nil {
		st.ChannelVersions = map[string]int64{}
	}
	if version > st.ChannelVersions[channel] {
		st.ChannelVersions[channel] = version
	}
}

// SyncChannelPause applies the verified channel pause flag and role version for repo's channel, ignoring metadata for
// another channel or an older role version than already applied for that channel.
func (e *Engine) SyncChannelPause(repo *trust.Repo) (changed bool, applied bool, err error) {
	type res struct{ changed, applied bool }
	r, err := retry(func() (res, error) {
		c, a, err := e.syncChannelPause(repo)
		return res{c, a}, err
	})
	return r.changed, r.applied, err
}

func (e *Engine) syncChannelPause(repo *trust.Repo) (changed bool, applied bool, err error) {
	if repo == nil || repo.Channel == "" {
		return false, false, nil
	}
	st, err := e.Load()
	if err != nil {
		return false, false, err
	}
	if ok, _ := e.channelRepoFresh(st, repo.Channel, repo.ChannelVersion); !ok {
		return false, false, nil
	}
	prevPaused := st.ChannelPaused
	prevVer := st.ChannelVersions[repo.Channel]
	st.ChannelPaused = repo.ChannelPaused
	recordChannelVersion(st, repo.Channel, repo.ChannelVersion)
	if prevPaused == st.ChannelPaused && prevVer == st.ChannelVersions[repo.Channel] {
		return false, true, nil
	}
	note := "channel metadata"
	if prevPaused != st.ChannelPaused {
		if repo.ChannelPaused {
			note = "channel paused"
		} else {
			note = "channel resumed"
		}
	}
	if err := e.persist(st, st.Phase, note); err != nil {
		return false, false, err
	}
	return prevPaused != st.ChannelPaused, true, nil
}

// RetireWithdrawn retires any pre-activation candidate or queued assignment from repo's channel (or an unsigned
// community offer when repo.Channel is empty) that no longer matches offeredDigest. Called before clearing
// ChannelPaused on resume and whenever an unpaused refresh leaves an existing candidate unreplaced, so a withdrawn
// release never drains or activates once a pause lifts or an owner approves it. Activations already under way
// (Activating, Verifying, ForwardRepairRequired) are untouched.
func (e *Engine) RetireWithdrawn(ctx context.Context, repo *trust.Repo, offeredDigest string) (bool, error) {
	return retry(func() (bool, error) { return e.retireWithdrawn(ctx, repo, offeredDigest) })
}

func (e *Engine) retireWithdrawn(ctx context.Context, repo *trust.Repo, offeredDigest string) (bool, error) {
	if repo == nil || repo.ChannelPaused {
		return false, nil
	}
	st, err := e.Load()
	if err != nil {
		return false, err
	}
	if repo.Channel != "" {
		if ok, _ := e.channelRepoFresh(st, repo.Channel, repo.ChannelVersion); !ok {
			return false, nil
		}
	}
	belongsToRepo := func(channel string, assignmentRaw []byte) bool {
		if repo.Channel != "" {
			return channel == repo.Channel
		}
		return channel == "" && len(assignmentRaw) == 0
	}
	pendingCleared := false
	if p := st.Pending; p != nil && belongsToRepo(p.Channel, p.Raw) && (offeredDigest == "" || p.Release.Digest != offeredDigest) {
		st.Pending = nil
		pendingCleared = true
	}
	if c := st.Candidate; c != nil && belongsToRepo(c.Channel, c.AssignmentRaw) && (offeredDigest == "" || c.Tuple.Digest != offeredDigest) {
		switch st.Phase {
		case Assigned, Downloading, Verified, Staged, WaitingForSafeBoundary, Failed:
			if st.Phase == Failed && c.Failure != nil && c.Failure.Blocked {
				break // already retired; nothing retries it
			}
			if st.Approved == c.Tuple.ReleaseID {
				st.Approved = ""
			}
			if repo.Channel != "" && st.LastOffer == offerKey(repo.Channel, c.Tuple.Digest) {
				st.LastOffer = ""
			}
			if c.Deferral != nil && c.Deferral.Draining && e.Runtime != nil {
				if err := e.Runtime.Resume(ctx, c.DrainRequestID); err == nil {
					c.Deferral.Draining = false
				}
			}
			draining := c.Deferral != nil && c.Deferral.Draining
			recordChannelVersion(st, repo.Channel, repo.ChannelVersion)
			msg := fmt.Sprintf("%s is no longer offered by the %s channel, so it isn't installed", c.Tuple.ReleaseID, repo.Channel)
			if repo.Channel == "" {
				msg = fmt.Sprintf("%s is no longer offered by the update repository, so it isn't installed", c.Tuple.ReleaseID)
			}
			return true, e.fail(st, &Failure{Stage: st.Phase, Code: "not_assigned", Message: msg, Blocked: true, ResumeRequired: draining})
		case RolledBack:
			if st.Approved == c.Tuple.ReleaseID {
				st.Approved = ""
			}
			if repo.Channel != "" && st.LastOffer == offerKey(repo.Channel, c.Tuple.Digest) {
				st.LastOffer = ""
			}
			st.Candidate = nil
			recordChannelVersion(st, repo.Channel, repo.ChannelVersion)
			return true, e.persist(st, RolledBack, "withdrawn release retired")
		}
	}
	if pendingCleared {
		recordChannelVersion(st, repo.Channel, repo.ChannelVersion)
		return true, e.persist(st, st.Phase, "withdrawn queued release")
	}
	return false, nil
}

// channelPaused reports whether a candidate belongs to a channel that is currently paused.
func channelPaused(st *State, c *Candidate) bool {
	return st.ChannelPaused && c != nil && c.Channel != ""
}

// SetAskFirst turns the owner's “Ask before updating” on or off (the runtime, for the owner: Whombat
// ask-before-updating.md). On, every candidate waits for the owner's approval before it activates; off, one that
// waits goes ahead at its next step, as any update does.
func (e *Engine) SetAskFirst(on bool) error {
	_, err := retry(func() (struct{}, error) { return struct{}{}, e.setAskFirst(on) })
	return err
}

func (e *Engine) setAskFirst(on bool) error {
	st, err := e.Load()
	if err != nil {
		return err
	}
	if st.AskFirst == on {
		return nil
	}
	st.AskFirst = on
	return e.persist(st, st.Phase, fmt.Sprintf("ask before updating=%v", on))
}

// ErrNotWaiting: no update waits for the owner's approval, or another release does (409 not_waiting).
var ErrNotWaiting = errors.New("no update waits for the owner's approval")

// Approve records the owner's approval of release, the candidate waiting for it (Waiting "owner"). It covers that
// release only: the candidate then activates at the next safe moment like any update (running work, a checkpoint, the
// maintenance window), and a newer release offered meanwhile waits for its own approval.
func (e *Engine) Approve(release string) error {
	_, err := retry(func() (struct{}, error) { return struct{}{}, e.approve(release) })
	return err
}

func (e *Engine) approve(id string) error {
	st, err := e.Load()
	if err != nil {
		return err
	}
	c := st.Candidate
	if channelPaused(st, c) || c == nil || c.Deferral == nil || c.Deferral.Waiting != "owner" || (st.Phase != Staged && st.Phase != WaitingForSafeBoundary) {
		return ErrNotWaiting
	}
	if c.Tuple.ReleaseID != id {
		return fmt.Errorf("%w: %s waits, not %s", ErrNotWaiting, c.Tuple.ReleaseID, id)
	}
	if st.Approved == id {
		return nil // approved already; the next step takes it
	}
	st.Approved = id
	return e.persist(st, st.Phase, "the owner approved "+id)
}

// endApproval ends the owner's approval with the candidate it was given for: once that candidate is gone (installed,
// rolled back, quarantined, replaced or dropped), a later offer of the same release asks again. A retry of the same
// candidate after a failure before anything changed keeps it.
func endApproval(st *State, to Phase) {
	c := st.Candidate
	if st.Approved != "" && (c == nil || c.Tuple.ReleaseID != st.Approved || to == Healthy || to == RolledBack) {
		st.Approved = ""
	}
}

// ErrLockBusy means maintenance cannot be locked right now.
var ErrLockBusy = errors.New("maintenance lock unavailable")

// AcquireLock takes the maintenance lock for another component (e.g. backup checkpoint).
func (e *Engine) AcquireLock(holder, reason string, ttl time.Duration) (*Lock, error) {
	return retry(func() (*Lock, error) { return e.acquireLock(holder, reason, ttl) })
}

func (e *Engine) acquireLock(holder, reason string, ttl time.Duration) (*Lock, error) {
	st, err := e.Load()
	if err != nil {
		return nil, err
	}
	now := e.now()
	if st.Activation() {
		return nil, fmt.Errorf("%w: update %s is %s", ErrLockBusy, st.Candidate.Tuple.ReleaseID, st.Phase)
	}
	if st.Lock != nil && st.Lock.Holder != holder && now.Before(st.Lock.Expires) {
		return nil, fmt.Errorf("%w: held by %s (%s)", ErrLockBusy, st.Lock.Holder, st.Lock.Reason)
	}
	st.Lock = &Lock{Holder: holder, Reason: reason, Since: now, Expires: now.Add(ttl)}
	return st.Lock, e.persist(st, st.Phase, "maintenance lock "+holder)
}

// ReleaseLock drops a lock held by holder.
func (e *Engine) ReleaseLock(holder string) error {
	_, err := retry(func() (struct{}, error) { return struct{}{}, e.releaseLock(holder) })
	return err
}

func (e *Engine) releaseLock(holder string) error {
	st, err := e.Load()
	if err != nil {
		return err
	}
	if st.Lock == nil || st.Lock.Holder != holder {
		return nil
	}
	st.Lock = nil
	return e.persist(st, st.Phase, "maintenance lock released")
}

func (e *Engine) lockedByOther(st *State) *Lock {
	if st.Lock != nil && e.now().Before(st.Lock.Expires) {
		return st.Lock
	}
	return nil
}

func (e *Engine) backoff(attempts int) time.Duration {
	d := e.Policy.RetryBase
	for i := 1; i < attempts && d < e.Policy.RetryMax; i++ {
		d *= 2
	}
	return min(d, e.Policy.RetryMax)
}

func keepSet(st *State) map[string]bool {
	keep := map[string]bool{}
	for _, t := range []*Tuple{st.Current, st.KnownGood, st.PreviousKnownGood} {
		if t != nil {
			for _, s := range t.ArtifactSHA256 {
				keep[s] = true
			}
		}
	}
	if st.Pending != nil {
		for _, a := range st.Pending.Release.Artifacts() {
			keep[a.SHA256()] = true
		}
	}
	return keep
}

func (c *Candidate) addEvidence(ev health.Evidence) {
	c.Evidence = append(c.Evidence, ev)
	if len(c.Evidence) > maxEvidence {
		c.Evidence = c.Evidence[len(c.Evidence)-maxEvidence:]
	}
}

// Step performs at most one transition and returns how long to wait before the next useful step. A step whose
// journal write lost to a concurrent mutation (ErrConflict) is dropped like a crash at that point, and the next step
// starts from the journal again at once (its effects are idempotent, SR-11).
func (e *Engine) Step(ctx context.Context) (time.Duration, error) {
	wait, err := e.step(ctx)
	if !errors.Is(err, ErrConflict) {
		e.conflicts.Store(0)
		return wait, err
	}
	// Steps that keep losing (they shouldn't: the other mutations are rare) back off and say so.
	n := e.conflicts.Add(1)
	if n < conflictStreak {
		e.log().Debug("update step lost to a concurrent journal change; stepping again", "err", err)
		return 0, nil
	}
	if n == conflictStreak || n%100 == 0 {
		e.log().Warn("update steps keep losing to concurrent journal changes; backing off", "count", n, "err", err)
	}
	return min(time.Duration(n-conflictStreak+1)*100*time.Millisecond, 5*time.Second), nil
}

// conflictStreak is the number of steps in a row that lost before Step backs off and warns.
const conflictStreak = 5

// step is Step.
func (e *Engine) step(ctx context.Context) (time.Duration, error) {
	st, err := e.Load()
	if err != nil {
		return time.Minute, err
	}
	if err := e.syncAssignmentOf(st); err != nil {
		return 10 * time.Second, fmt.Errorf("assignment file: %w", err)
	}
	// The activation's steps read none of the foreign fields and have effects that must not run twice (SR-13).
	st.mergeable = st.Phase == Activating || st.Phase == Verifying
	if e.RecoveryMode {
		return e.recoveryStep(ctx, st)
	}
	switch st.Phase {
	case Healthy, RolledBack, Quarantined, ForwardRepairRequired:
		return e.steady(ctx, st)
	case Assigned:
		return e.assigned(ctx, st)
	case Downloading:
		return e.downloading(ctx, st)
	case Verified:
		return e.verified(ctx, st)
	case Staged:
		return e.staged(ctx, st)
	case WaitingForSafeBoundary:
		return e.waiting(ctx, st)
	case Activating:
		return e.activating(ctx, st)
	case Verifying:
		return e.verifying(ctx, st)
	case Failed:
		return e.failed(ctx, st)
	}
	return time.Minute, fmt.Errorf("unknown phase %q", st.Phase)
}

func (e *Engine) recoveryStep(ctx context.Context, st *State) (time.Duration, error) {
	switch st.Phase {
	case Activating, Verifying:
		c := st.Candidate
		if c.Guard != nil {
			return e.resolveGuard(ctx, st)
		}
		if c.Rollback == nil {
			e.beginRollback(c, "manager_recovery", "the manager failed during activation; the known-good recovery manager rolls back")
			return 0, e.persist(st, st.Phase, "recovery: rollback")
		}
		return e.rollingBack(ctx, st)
	case Failed:
		if f := st.Candidate.Failure; f.ResumeRequired {
			return e.failed(ctx, st)
		}
	}
	return e.Policy.IdleInterval, nil
}

func (e *Engine) steady(ctx context.Context, st *State) (time.Duration, error) {
	if done, wait, err := e.reconcileHost(ctx, st); done || err != nil {
		return wait, err
	}
	if st.Phase == RolledBack && st.Candidate != nil && st.Candidate.Failure.AfterActivation {
		if done, wait, err := e.afterVerificationFailure(ctx, st); done || err != nil {
			return wait, err
		}
	} else if st.Phase == RolledBack && st.Candidate != nil {
		c := st.Candidate
		if c.Attempts >= e.Policy.MaxAttempts && !release.IsRetryableUpdateFailure(c.Failure.Code) {
			return 0, e.quarantine(ctx, st, c.Failure.Code, fmt.Sprintf("%s after %d attempts: %s", c.Failure.Code, c.Attempts, c.Failure.Message))
		}
		if st.Pending == nil {
			if st.Hold || channelPaused(st, c) {
				return e.Policy.IdleInterval, nil
			}
			if wait := c.Failure.NextRetry.Sub(e.now()); wait > 0 {
				return min(wait, e.Policy.IdleInterval), nil
			}
			e.resetForRetry(c)
			return 0, e.persist(st, Assigned, fmt.Sprintf("retry after rollback (attempt %d)", c.Attempts+1))
		}
	}
	if st.Pending != nil {
		p := st.Pending
		if st.ChannelPaused && p.Channel != "" {
			return e.Policy.IdleInterval, nil
		}
		if q, ok := st.Quarantine[p.Release.Tuple.ReleaseID]; ok && q.Digest == p.Release.Digest {
			st.Pending = nil
			st.LastRefusal = "queued assignment names a quarantined release"
			return 0, e.persist(st, st.Phase, st.LastRefusal)
		}
		if err := forward(st, p.Release); err != nil {
			st.Pending = nil
			st.LastRefusal = "queued assignment refused: " + err.Error()
			return 0, e.persist(st, st.Phase, st.LastRefusal)
		}
		if err := e.start(st, p.Raw, p.Seq, p.Rollout, p.NotBefore, p.Release); err != nil {
			return time.Minute, err
		}
		st.Candidate.Channel = p.Channel
		return 0, e.persist(st, Assigned, "queued assignment "+p.Rollout)
	}
	return e.Policy.IdleInterval, nil
}

// reconcileHost handles a booted system that is not the journal's current host outside an
// activation — e.g. boot counting fell back to the known-good generation after the runtime profile
// had been switched, or a generation was chosen at the boot menu. If the booted host belongs to the
// known-good (or previous known-good) tuple, the helper re-activates that tuple (runtime profiles
// switched back and restarted; boot default fixed; no reboot since it is booted) and the journal
// records it as current and known-good. An unknown booted system is reported, never "fixed".
func (e *Engine) reconcileHost(ctx context.Context, st *State) (bool, time.Duration, error) {
	if st.Current == nil {
		return false, 0, nil
	}
	booted, err := e.Host.CurrentSystem()
	if err != nil || booted == st.Current.HostStorePath {
		return false, 0, nil
	}
	var match *Tuple
	for _, t := range []*Tuple{st.KnownGood, st.PreviousKnownGood} {
		if t != nil && t.HostStorePath == booted {
			match = t
			break
		}
	}
	if match == nil {
		msg := fmt.Sprintf("booted system %s belongs to no known tuple (current %s)", booted, st.Current.ReleaseID)
		if st.LastRefusal != msg {
			st.LastRefusal = msg
			e.log().Warn("host mismatch", "booted", booted, "current", st.Current.ReleaseID)
			return true, e.Policy.IdleInterval, e.persist(st, st.Phase, msg)
		}
		return false, 0, nil
	}
	if _, err := e.Helper.Do(ctx, proto.Request{V: proto.Version, Op: proto.OpActivateHostOnReboot, ReleaseID: match.ReleaseID}); err != nil {
		e.log().Warn("re-activating the booted known-good tuple failed; retrying", "err", err)
		return true, e.backoff(1), nil
	}
	if err := e.effect("reconcile-host"); err != nil {
		return true, 0, err
	}
	from := st.Current.ReleaseID
	if st.KnownGood == nil || st.KnownGood.Digest != match.Digest {
		st.PreviousKnownGood = st.KnownGood
	}
	st.Current, st.KnownGood = match, match
	st.mergeable = true // after the helper's activation; this step reads none of the foreign fields (SR-13)
	note := fmt.Sprintf("booted %s (host fallback): runtime restored to %s, was %s", match.ReleaseID, match.ReleaseID, from)
	st.record(st.Phase, st.Phase, match.ReleaseID, note, e.now()) // same-state event, kept in the history
	return true, 0, e.persist(st, st.Phase, note)
}

func (e *Engine) resetForRetry(c *Candidate) {
	c.Failure, c.Deferral, c.Rollback, c.Schema, c.Guard = nil, nil, nil, nil, nil
	c.HealthyStreak, c.ActivateBootID, c.DrainRequestID, c.Reassigned = 0, "", "", false
}

// afterVerificationFailure decides for a candidate that rolled back after it was activated (MG-56: it ran and failed
// its checks, didn't boot or didn't come up in time). Retrying it from local state would be another outage for the
// owner, so it is re-activated only when control assigns this very release again after the failure (control holds a
// device that failed a release and pauses the rollout, so normally nothing retries), not before VerifyRetryDelay since
// the failure, and it is quarantined after MaxVerifyFailures such failures. done=false: steady() goes on (a queued
// assignment of another release).
func (e *Engine) afterVerificationFailure(ctx context.Context, st *State) (bool, time.Duration, error) {
	c := st.Candidate
	id := c.Tuple.ReleaseID
	if n := st.VerificationFailures[c.Tuple.Digest]; n >= max(e.Policy.MaxVerifyFailures, 1) {
		delete(st.VerificationFailures, c.Tuple.Digest)
		return true, 0, e.quarantine(ctx, st, c.Failure.Code, fmt.Sprintf("%s: %s failed verification %d times: %s", c.Failure.Code, id, n, c.Failure.Message))
	}
	if p := st.Pending; p != nil {
		if p.Release.Digest != c.Tuple.Digest {
			return false, 0, nil // another release: started as queued
		}
		// Assigned again while the rollback ran: the same as a new assignment now.
		c.AssignmentSeq, c.NotBefore, c.RolloutID, c.Reassigned, st.Pending = p.Seq, p.NotBefore, p.Rollout, true, nil
		c.AssignmentRaw = p.Raw
		return true, 0, e.persist(st, RolledBack, "control assigned "+id+" again")
	}
	if !c.Reassigned || st.Hold || channelPaused(st, c) {
		return true, e.Policy.IdleInterval, nil // control decides; it holds such a device
	}
	if wait := c.Failure.At.Add(e.Policy.VerifyRetryDelay).Sub(e.now()); wait > 0 {
		return true, min(wait, e.Policy.IdleInterval), nil
	}
	e.resetForRetry(c)
	return true, 0, e.persist(st, Assigned, fmt.Sprintf("retry after a verification failure: control assigned %s again (attempt %d)", id, c.Attempts+1))
}

func (e *Engine) assigned(ctx context.Context, st *State) (time.Duration, error) {
	c := st.Candidate
	if channelPaused(st, c) {
		return e.Policy.IdleInterval, nil
	}
	arts, _, err := e.plan(ctx, c)
	if err != nil {
		if failed, ferr := e.planFailure(st, Assigned, err); failed {
			return 0, ferr
		}
		return e.backoff(1), nil
	}
	if err := e.Staging.EnsureSpace(arts, keepSet(st)); err != nil {
		if errors.Is(err, errNoSpace) {
			return 0, e.fail(st, &Failure{Stage: Assigned, Code: "no_space", Message: err.Error(), NextRetry: e.now().Add(e.Policy.NoSpaceRetry)})
		}
		return time.Minute, err
	}
	return 0, e.persist(st, Downloading, "")
}

// downloading plans again (idempotent: what is staged or already in the store is skipped) and downloads what is left.
func (e *Engine) downloading(ctx context.Context, st *State) (time.Duration, error) {
	c := st.Candidate
	if channelPaused(st, c) {
		return e.Policy.IdleInterval, nil
	}
	arts, plans, err := e.plan(ctx, c)
	if err != nil {
		if failed, ferr := e.planFailure(st, Downloading, err); failed {
			return 0, ferr
		}
		return e.backoff(1), nil
	}
	e.logPlan(c, plans)
	for _, a := range arts {
		if e.Staging.Present(a) {
			continue
		}
		if err := e.Staging.Download(ctx, a); err != nil {
			switch {
			case errors.Is(err, trust.ErrArtifact):
				return 0, e.fail(st, &Failure{Stage: Downloading, Code: "download_corrupt", Message: err.Error(), CountsAttempt: true})
			case errors.Is(err, errNoSpace):
				return 0, e.fail(st, &Failure{Stage: Downloading, Code: "no_space", Message: err.Error(), NextRetry: e.now().Add(e.Policy.NoSpaceRetry)})
			default:
				// Repository/network unavailable: the installation keeps running; retry later.
				e.log().Warn("artifact download failed; will retry", "target", a.Target, "err", err)
				return e.backoff(1), nil
			}
		}
		if err := e.effect("download:" + a.SHA256()[:12]); err != nil {
			return 0, err
		}
	}
	for _, a := range arts {
		if !e.Staging.Present(a) {
			return 0, e.fail(st, &Failure{Stage: Downloading, Code: "download_corrupt", Message: a.Target + " failed verification", CountsAttempt: true})
		}
	}
	return 0, e.persist(st, Verified, "")
}

// helperFailure maps a helper error to a failure; nil means "helper unreachable, retry later".
func (e *Engine) helperFailure(stage Phase, err error) *Failure {
	msg := err.Error()
	switch proto.CodeOf(err) {
	case proto.CodeIncompatible:
		return &Failure{Stage: stage, Code: "incompatible", Message: msg, CountsAttempt: true}
	case proto.CodeVerificationFailed:
		return &Failure{Stage: stage, Code: "helper_verification_failed", Message: msg, CountsAttempt: true}
	case proto.CodeNotAssigned:
		return &Failure{Stage: stage, Code: "not_assigned", Message: msg, NextRetry: e.now().Add(e.Policy.RetryBase)}
	case proto.CodeNoSpace:
		return &Failure{Stage: stage, Code: "no_space", Message: msg, NextRetry: e.now().Add(e.Policy.NoSpaceRetry)}
	case proto.CodeNotStaged:
		return &Failure{Stage: stage, Code: "not_staged", Message: msg}
	case proto.CodeMetadataStale:
		return nil // freshness/availability, not a verdict: refresh and retry
	case proto.CodeActivationFailed:
		return &Failure{Stage: stage, Code: "activation_failed", Message: msg, CountsAttempt: true}
	case "":
		return nil
	default:
		return &Failure{Stage: stage, Code: "helper_" + proto.CodeOf(err), Message: msg, CountsAttempt: true}
	}
}

// retryHelper handles a retryable helper error: refresh metadata if it was stale, then back off.
func (e *Engine) retryHelper(ctx context.Context, err error) time.Duration {
	if proto.CodeOf(err) == proto.CodeMetadataStale && e.Refresh != nil {
		if rerr := e.Refresh(ctx); rerr != nil {
			e.log().Warn("TUF refresh failed; the installed release keeps running", "err", rerr)
		}
	}
	e.log().Warn("helper operation will be retried", "err", err)
	return e.backoff(1)
}

func (e *Engine) verified(ctx context.Context, st *State) (time.Duration, error) {
	c := st.Candidate
	if channelPaused(st, c) {
		return e.Policy.IdleInterval, nil
	}
	op := proto.OpStageRuntime
	if c.Class == ClassHost {
		op = proto.OpStageHost
		// Before a new host candidate: drop failed candidate generations so the known-good
		// generation never falls off the boot partition (the helper keeps booted, current,
		// known-good and pending). Not fatal: a failure only leaves old entries behind.
		if res, err := e.Helper.Do(ctx, proto.Request{V: proto.Version, Op: proto.OpPruneHostGenerations}); err != nil {
			e.log().Warn("pruning host generations failed; staging anyway", "err", err)
		} else if len(res.Deleted) > 0 {
			e.log().Info("pruned host generations", "deleted", res.Deleted)
		}
		if err := e.effect("prune-host-generations"); err != nil {
			return 0, err
		}
	}
	if _, err := e.Helper.Do(ctx, proto.Request{V: proto.Version, Op: op, ReleaseID: c.Tuple.ReleaseID}); err != nil {
		f := e.helperFailure(Verified, err)
		switch {
		case f == nil:
			return e.retryHelper(ctx, err), nil
		case f.Code == "not_staged":
			return 0, e.persist(st, Assigned, "helper reports an artifact missing; re-downloading")
		case f.Code == "incompatible":
			return 0, e.quarantine(ctx, st, f.Code, f.Message)
		}
		return 0, e.fail(st, f)
	}
	if err := e.effect(string(op)); err != nil {
		return 0, err
	}
	return 0, e.persist(st, Staged, "")
}

// schemaMigration is what a candidate's schema check says about the migration it needs (release.SchemaMigration): the
// target schema and its floors when the runtime reports them (Whombat MD-12), else the tuple's schemaWrites and no
// floors (the tuple-only check, as before MG-43).
func schemaMigration(s *proto.Schema, candidate *release.ReleaseTuple) release.SchemaMigration {
	m := release.SchemaMigration{Target: candidate.Runtime.SchemaWrites, NeedsCheckpoint: s.NeedsCheckpoint}
	if t := s.Target; t != nil {
		r, w := int64(t.Readers), int64(t.Writers)
		m.Target, m.Readers, m.Writers = int64(t.Version), &r, &w
	}
	return m
}

// checkSchema runs the candidate's read-only schema check (MD-10) once per attempt.
func (e *Engine) checkSchema(ctx context.Context, st *State) (done bool, wait time.Duration, err error) {
	c := st.Candidate
	if c.Schema != nil && c.Schema.Checked {
		return true, 0, nil
	}
	res, herr := e.Helper.Do(ctx, proto.Request{V: proto.Version, Op: proto.OpCheckSchema, ReleaseID: c.Tuple.ReleaseID})
	if herr != nil || res.Schema == nil {
		return false, e.retryHelper(ctx, errOr(herr)), nil
	}
	s := res.Schema
	plan := &SchemaPlan{Checked: true, Verdict: s.Verdict, Access: s.Access, DatabaseVersion: s.DatabaseVersion}
	switch s.Exit {
	case proto.SchemaExitOK:
	case proto.SchemaExitMigrationRequired:
		plan.NeedsMigration, plan.NeedsCheckpoint = true, s.NeedsCheckpoint
	case proto.SchemaExitLockTimeout:
		return false, e.backoff(1), nil
	case proto.SchemaExitReadOnly, proto.SchemaExitRefused:
		// The candidate cannot use this database (it is older than the schema, or foreign/PG major).
		msg := fmt.Sprintf("candidate %s cannot run on this database (%s): %s", c.Tuple.ReleaseID, s.Verdict, s.Reason)
		return false, 0, e.fail(st, &Failure{Stage: Staged, Code: "schema_incompatible", Message: msg, CountsAttempt: true,
			Reasons: []string{refusalReason(s)}, Schema: failureSchema(s, &c.Release.Tuple)})
	default:
		if s.ErrorKind != "" || s.Exit == 1 {
			e.log().Warn("candidate schema check failed; will retry", "kind", s.ErrorKind, "reason", s.Reason)
			return false, e.backoff(1), nil
		}
	}
	plan.Pending, plan.Target = s.Pending, s.Target
	// The contract's activation check against the installed tuple and the live schema (CT-35). A candidate that must
	// migrate first (its own check said so: exit 10, not refused or read-only) is judged by the schema it migrates to
	// and, when its runtime reports them, that schema's floors (CT-134, MG-43): what the installed runtime could still
	// do after the migration decides between no checkpoint (read-write rollback) and a verified checkpoint first. A
	// candidate with nothing to migrate (exit 0) whose runtime reports the live schema's floors is judged by those
	// floors (CT-135, MG-45): an older runtime on a database a newer one expanded (a custody rollback) activates when
	// its own schema is at or above the writers floor, as its own check said; without floors, the tuples' ranges.
	if cur := st.Current; cur != nil && cur.Release != nil {
		var act release.ActivationCheck
		switch f := liveFloors(s); {
		case plan.NeedsMigration:
			act = release.CheckMigratingActivation(cur.Release, &c.Release.Tuple, int64(s.DatabaseVersion), schemaMigration(s, &c.Release.Tuple))
		case f != nil:
			act = release.CheckCompatibleActivation(cur.Release, &c.Release.Tuple, int64(s.DatabaseVersion), *f)
		default:
			act = release.CheckActivation(cur.Release, &c.Release.Tuple, int64(s.DatabaseVersion))
		}
		// A new session protocol major is no reason to refuse (MG-131, Whombat HE-52): clients and box speak one major,
		// and a client of the old one is told to update the app.
		reasons := act.Reasons
		if len(reasons) > 0 {
			msg := fmt.Sprintf("candidate %s cannot activate on this appliance (schema %d): %s", c.Tuple.ReleaseID, s.DatabaseVersion, strings.Join(reasons, ", "))
			return false, 0, e.fail(st, &Failure{Stage: Staged, Code: "schema_incompatible", Message: msg, CountsAttempt: true,
				Reasons: reasons, Schema: failureSchema(s, &c.Release.Tuple), RollbackAccess: act.RollbackAccess})
		}
		plan.RollbackCompatible, plan.RollbackAccess = act.RollbackCompatible, act.RollbackAccess
		// A migration after which the installed runtime could not read and write needs a checkpoint even when no
		// single migration is a contract one (requiresCheckpoint).
		if plan.NeedsMigration && act.RequiresCheckpoint && len(plan.NeedsCheckpoint) == 0 {
			plan.NeedsCheckpoint = plan.Pending
			if len(plan.NeedsCheckpoint) == 0 {
				plan.NeedsCheckpoint = []string{fmt.Sprintf("schema-%d", c.Release.Tuple.Runtime.SchemaWrites)}
			}
		}
	}
	c.Schema = plan
	if err := e.effect("check-schema"); err != nil {
		return false, 0, err
	}
	return false, 0, e.persist(st, st.Phase, fmt.Sprintf("schema %s (db %d)", s.Verdict, s.DatabaseVersion))
}

func (e *Engine) staged(ctx context.Context, st *State) (time.Duration, error) {
	done, wait, err := e.checkSchema(ctx, st)
	if !done || err != nil {
		return wait, err
	}
	if retired, err := e.retireOffChannel(st); retired || err != nil {
		return 0, err
	}
	c := st.Candidate
	if c.Deferral == nil {
		c.Deferral = &Deferral{Since: e.now()}
	}
	if why, wait := e.blocked(st); why != "" {
		if c.Deferral.Waiting != why {
			c.Deferral.Waiting, c.Deferral.Explanation = why, e.explainWait(st, why)
			return wait, e.persist(st, Staged, c.Deferral.Explanation)
		}
		return wait, nil
	}
	c.DrainRequestID = newID("drain-")
	d := c.Deferral
	d.Waiting, d.Explanation, d.NextCheck = "", "", time.Time{}
	return 0, e.persist(st, WaitingForSafeBoundary, "")
}

// offChannel reports the channel the box follows now when the candidate came from another one (the owner changed the
// channel while it was staged or waiting, and the new channel had nothing newer to replace it).
func (e *Engine) offChannel(c *Candidate) (string, bool) {
	if c == nil || c.Channel == "" || e.Channel == nil {
		return "", false
	}
	now := e.Channel()
	return now, now != "" && now != c.Channel
}

// retireOffChannel retires a candidate of another channel before anything drains or activates: it fails, blocked
// (nothing retries it by itself, and not_assigned is the helper's own word for it: it would refuse the activation), the
// runtime resumed if a drain had started, the owner's approval and the last offer forgotten, so the box keeps its
// release and the same release is offered again if the owner switches back. Staged and WaitingForSafeBoundary may go to
// Failed; Failed goes to Assigned with the next offer.
func (e *Engine) retireOffChannel(st *State) (bool, error) {
	c := st.Candidate
	now, off := e.offChannel(c)
	if !off {
		return false, nil
	}
	draining := c.Deferral != nil && c.Deferral.Draining
	msg := fmt.Sprintf("%s came from the %s channel; this Whombat follows %s now, so it isn't installed", c.Tuple.ReleaseID, c.Channel, now)
	if st.Approved == c.Tuple.ReleaseID {
		st.Approved = ""
	}
	st.LastOffer = ""
	return true, e.fail(st, &Failure{Stage: st.Phase, Code: "not_assigned", Message: msg, Blocked: true, ResumeRequired: draining})
}

// blocked reports a reason activation must not start now: hold, the owner's approval (Ask before updating), another
// maintenance lock, or the assignment's notBefore (maintenance window). Only a candidate on its way to activation asks:
// a rollback to known-good and an activation already under way never come here.
func (e *Engine) blocked(st *State) (string, time.Duration) {
	if st.Hold || channelPaused(st, st.Candidate) {
		return "hold", e.Policy.IdleInterval
	}
	if st.AskFirst && st.Approved != st.Candidate.Tuple.ReleaseID {
		return "owner", e.Policy.IdleInterval
	}
	if e.lockedByOther(st) != nil {
		return "lock", e.Policy.IdleInterval
	}
	if nb := time.Unix(st.Candidate.NotBefore, 0); e.now().Before(nb) {
		return "window", min(nb.Sub(e.now()), e.Policy.IdleInterval)
	}
	return "", 0
}

func (e *Engine) explainWait(st *State, why string) string {
	switch why {
	case "hold":
		if channelPaused(st, st.Candidate) {
			return "Updates are paused for now."
		}
		return "Update staged; the rollout is on hold (pause or emergency stop). The installed release keeps running."
	case "owner":
		return "Update staged; it waits for the owner to approve it (ask before updating is on). The installed release keeps running."
	case "lock":
		l := st.Lock
		return fmt.Sprintf("Update staged; waiting because %s holds maintenance (%s) until %s.", l.Holder, l.Reason, l.Expires.UTC().Format(time.RFC3339))
	case "window":
		return fmt.Sprintf("Update staged; the maintenance window opens at %s.", time.Unix(st.Candidate.NotBefore, 0).UTC().Format(time.RFC3339))
	}
	return ""
}

func (e *Engine) drainReq(c *Candidate) runtimeapi.DrainRequest {
	reason := "update"
	if c.Class == ClassHost {
		reason = "host-update"
	}
	id := c.Tuple.ReleaseID
	return runtimeapi.DrainRequest{V: runtimeapi.Version, RequestID: c.DrainRequestID, Reason: reason, Scope: "all",
		ReleaseID: &id, LeaseMs: e.Policy.DrainLease.Milliseconds()}
}

// probeSafe asks the runtime for a safe boundary (idempotent; renews the drain lease). A runtime
// whose process has been down for the grace period counts as safe: there is no running work.
func (e *Engine) probeSafe(ctx context.Context, c *Candidate) (safe bool, status *runtimeapi.DrainStatus, changed bool) {
	status, err := e.Runtime.Drain(ctx, e.drainReq(c))
	if err == nil {
		changed = !c.Deferral.RuntimeDown.IsZero()
		c.Deferral.RuntimeDown = time.Time{}
		return status.Safe, status, changed
	}
	var busy *runtimeapi.BusyError
	if errors.As(err, &busy) {
		return false, &runtimeapi.DrainStatus{Blockers: []runtimeapi.Blocker{{Kind: "backup", ID: "drain-holder",
			Description: "another maintenance drain (backup checkpoint) holds the runtime"}}}, false
	}
	ev := e.Health.Check(ctx, "")
	if ev.ProcessActive {
		return false, &runtimeapi.DrainStatus{Blockers: []runtimeapi.Blocker{{Kind: "other", ID: "runtime-admin",
			Description: "the runtime is running but does not answer the drain request"}}}, false
	}
	if c.Deferral.RuntimeDown.IsZero() {
		c.Deferral.RuntimeDown = e.now()
		return false, &runtimeapi.DrainStatus{}, true
	}
	return e.now().Sub(c.Deferral.RuntimeDown) >= e.Policy.RuntimeDownGrace, &runtimeapi.DrainStatus{}, false
}

func (e *Engine) waiting(ctx context.Context, st *State) (time.Duration, error) {
	if retired, err := e.retireOffChannel(st); retired || err != nil {
		return 0, err
	}
	c := st.Candidate
	d := c.Deferral
	now := e.now()
	if why, wait := e.blocked(st); why != "" {
		if d.Draining {
			if err := e.Runtime.Resume(ctx, c.DrainRequestID); err != nil {
				return e.Policy.DrainPoll, nil
			}
			d.Draining = false
		}
		if d.Waiting != why {
			d.Waiting, d.Explanation = why, e.explainWait(st, why)
			return wait, e.persist(st, WaitingForSafeBoundary, d.Explanation)
		}
		return wait, nil
	}
	if d.Waiting != "" && d.Waiting != "boundary" && d.Waiting != "checkpoint" && d.Waiting != "metadata" {
		// What held it is over (a hold lifted, the owner's yes, …): the journal says so now, so the owner's facts and
		// control's reports don't show the old reason until the next change.
		d.Waiting, d.Explanation = "", ""
		return 0, e.persist(st, WaitingForSafeBoundary, "")
	}
	if !d.Draining {
		if wait := d.NextCheck.Sub(now); wait > 0 {
			return min(wait, e.Policy.IdleInterval), nil
		}
		if now.Sub(c.PhaseSince) < e.Policy.DrainHoldAfter {
			return e.probe(ctx, st)
		}
		d.Draining, d.WindowStart, d.Windows = true, now, d.Windows+1
		if err := e.persist(st, WaitingForSafeBoundary, "new drain window"); err != nil {
			return 0, err
		}
	}
	safe, status, changed := e.probeSafe(ctx, c)
	if err := e.effect("drain"); err != nil {
		return 0, err
	}
	if safe {
		return e.atBoundary(ctx, st)
	}
	changed = e.noteBlockers(d, status) || changed
	return e.endWindowIfDue(ctx, st, changed)
}

// probe asks whether the box is quiet without holding new work back (MG-137): the runtime is drained only until it
// answers and, when something still runs, resumed at once; the next probe follows after ProbeInterval. People keep
// using the box while an update waits for an agent's long run.
func (e *Engine) probe(ctx context.Context, st *State) (time.Duration, error) {
	c := st.Candidate
	d := c.Deferral
	safe, status, changed := e.probeSafe(ctx, c)
	if err := e.effect("drain"); err != nil {
		return 0, err
	}
	if safe {
		// The quiet moment: the drain stays, a window of its own, until the activation.
		d.Draining, d.WindowStart, d.Windows = true, e.now(), d.Windows+1
		return e.atBoundary(ctx, st)
	}
	// Only a drain this probe took is given back (not the backup's, nor a runtime that is down).
	if status.Draining {
		if err := e.Runtime.Resume(ctx, c.DrainRequestID); err != nil {
			e.log().Warn("resume after a probe failed; the runtime's drain lease will expire", "err", err)
		}
	}
	changed = e.noteBlockers(d, status) || changed
	d.NextCheck = e.now().Add(e.Policy.ProbeInterval)
	if changed {
		return e.Policy.ProbeInterval, e.persist(st, WaitingForSafeBoundary, d.Explanation)
	}
	return e.Policy.ProbeInterval, nil
}

// noteBlockers records what keeps the safe boundary away and explains it; true when that changed.
func (e *Engine) noteBlockers(d *Deferral, status *runtimeapi.DrainStatus) bool {
	changed := key(status.Blockers) != key(d.Blockers)
	d.Blockers, d.Waiting = status.Blockers, "boundary"
	if escalated := e.now().Sub(d.Since) >= e.Policy.DeferralEscalateAfter; escalated != d.Escalated {
		d.Escalated, changed = escalated, true
	}
	d.Explanation = explainBlockers(d.Blockers, d.Since, d.Escalated)
	return changed
}

// atBoundary goes on from a safe boundary, the runtime drained: fresh metadata, the pre-migration checkpoint when one
// is needed, then the activation.
func (e *Engine) atBoundary(ctx context.Context, st *State) (time.Duration, error) {
	c := st.Candidate
	d := c.Deferral
	// The helper re-verifies TUF metadata at activation: make sure it is fresh before going on
	// (otherwise users would wait drained on a metadata outage).
	if e.Refresh != nil {
		if err := e.Refresh(ctx); err != nil {
			d.Waiting = "metadata"
			d.Explanation = fmt.Sprintf("Update metadata could not be refreshed (%v); the installed release keeps running and the update retries at the next window.", err)
			d.WindowStart = e.now().Add(-e.Policy.DrainWindow)
			return e.endWindowIfDue(ctx, st, true)
		}
		if cur, lerr := e.Load(); lerr == nil && channelPaused(cur, c) {
			// Fresh metadata paused this channel right before activation: release the drain and let waiting() record the pause hold.
			_ = e.Runtime.Resume(ctx, c.DrainRequestID)
			return 0, nil
		}
	}
	if s := c.Schema; s != nil && s.NeedsMigration && len(s.NeedsCheckpoint) > 0 && !e.checkpointFresh(c) {
		if s.CheckpointRef != "" {
			e.log().Info("pre-migration checkpoint no longer covers every write; taking a new one", "stale", s.CheckpointRef)
			s.CheckpointRef = ""
		}
		return e.takeCheckpoint(ctx, st)
	}
	d.Blockers, d.Explanation, d.Waiting = nil, "", ""
	c.ActivateBootID, _ = e.Host.BootID()
	return 0, e.persist(st, Activating, "safe boundary reached")
}

// endWindowIfDue bounds how long new turns are held back: after DrainWindow the runtime resumes
// and the next window starts after DeferralRecheck. Acknowledged work is never interrupted.
func (e *Engine) endWindowIfDue(ctx context.Context, st *State, changed bool) (time.Duration, error) {
	c := st.Candidate
	d := c.Deferral
	now := e.now()
	if now.Sub(d.WindowStart) >= e.Policy.DrainWindow {
		if err := e.Runtime.Resume(ctx, c.DrainRequestID); err != nil {
			e.log().Warn("resume after drain window failed; the runtime's drain lease will expire", "err", err)
		}
		d.Draining = false
		d.NextCheck = now.Add(e.Policy.DeferralRecheck)
		return min(e.Policy.DeferralRecheck, e.Policy.IdleInterval), e.persist(st, WaitingForSafeBoundary, "deferred: "+d.Explanation)
	}
	if changed {
		return e.Policy.DrainPoll, e.persist(st, WaitingForSafeBoundary, d.Explanation)
	}
	return e.Policy.DrainPoll, nil
}

// takeCheckpoint asks the backup service for a verified checkpoint while quiesced (MD-06): the
// migration that follows narrows the schema for older code. The drain lease is renewed meanwhile.
func (e *Engine) takeCheckpoint(ctx context.Context, st *State) (time.Duration, error) {
	c := st.Candidate
	d := c.Deferral
	var ref string
	err := errors.New("no backup service configured on this appliance")
	if e.Checkpointer != nil {
		cctx, cancel := context.WithCancel(ctx)
		renewed := make(chan struct{})
		go func() {
			defer close(renewed)
			t := time.NewTicker(max(e.Policy.DrainLease/3, time.Second))
			defer t.Stop()
			for {
				select {
				case <-cctx.Done():
					return
				case <-t.C:
					_, _ = e.Runtime.Drain(cctx, e.drainReq(c))
				}
			}
		}()
		req := CheckpointRequest{ReleaseID: c.Tuple.ReleaseID, Migrations: c.Schema.NeedsCheckpoint, UnderDrain: c.DrainRequestID}
		ref, err = e.Checkpointer.Checkpoint(cctx, req)
		for i := 0; i < e.Policy.CheckpointRetries && err != nil && lostConnection(err); i++ {
			e.log().Warn("checkpoint request lost its connection to the backup service; asking again", "err", err, "in", e.Policy.CheckpointRetry)
			select {
			case <-cctx.Done():
			case <-time.After(e.Policy.CheckpointRetry):
			}
			if cctx.Err() != nil {
				break
			}
			ref, err = e.Checkpointer.Checkpoint(cctx, req)
		}
		cancel()
		<-renewed
	}
	if err == nil && !proto.ValidCheckpointID(ref) {
		err = fmt.Errorf("backup service returned an invalid checkpoint id %q", ref)
	}
	if err != nil {
		d.Waiting = "checkpoint"
		d.Explanation = fmt.Sprintf("Update needs a verified checkpoint before migrating the database (%v); it will retry at the next window. Nothing was changed.", err)
		d.WindowStart = e.now().Add(-e.Policy.DrainWindow) // end this window now
		return e.endWindowIfDue(ctx, st, true)
	}
	if err := e.effect("checkpoint"); err != nil {
		return 0, err
	}
	c.Schema.CheckpointRef, c.Schema.CheckpointWindow, c.Schema.CheckpointAt = ref, d.Windows, e.now()
	return 0, e.persist(st, WaitingForSafeBoundary, "verified checkpoint "+ref)
}

// lostConnection reports whether err is the connection to the backup service failing (closed mid-request, refused,
// reset), not an answer it gave: the API is socket-activated, and a restart (the seal after a new destination) drops
// a request in flight.
func lostConnection(err error) bool {
	return errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, syscall.ECONNREFUSED) ||
		errors.Is(err, syscall.ECONNRESET) || errors.Is(err, syscall.EPIPE)
}

// checkpointFresh reports whether the pre-migration checkpoint still covers every acknowledged write:
// taken in the current drain window, the runtime drained since, and so recently that the drain lease
// (renewed every DrainLease/3 while the checkpoint ran) cannot have lapsed in between (L-1).
func (e *Engine) checkpointFresh(c *Candidate) bool {
	s, d := c.Schema, c.Deferral
	if s == nil || s.CheckpointRef == "" || d == nil || !d.Draining || s.CheckpointWindow != d.Windows {
		return false
	}
	return e.now().Sub(s.CheckpointAt) < e.Policy.DrainLease*2/3
}

func (e *Engine) activating(ctx context.Context, st *State) (time.Duration, error) {
	c := st.Candidate
	if c.Rollback != nil {
		return e.rollingBack(ctx, st)
	}
	if c.Guard != nil {
		return e.resolveGuard(ctx, st)
	}
	if c.Class == ClassHost && c.ActivateBootID != "" {
		if boot, err := e.Host.BootID(); err == nil && boot != c.ActivateBootID {
			c.VerifyDeadline = e.now().Add(e.Policy.VerifyTimeout)
			return 0, e.persist(st, Verifying, "rebooted")
		}
	}
	// Re-confirm the boundary (renews the lease): after a crash it may have expired.
	if safe, _, _ := e.probeSafe(ctx, c); !safe {
		return 0, e.fail(st, &Failure{Stage: Activating, Code: "boundary_lost", Message: "the safe boundary was lost before activation; retrying", NextRetry: e.now()})
	}
	if s := c.Schema; s != nil && s.NeedsMigration && !s.Migrated {
		if !s.MigrateAttempted && len(s.NeedsCheckpoint) > 0 && !e.checkpointFresh(c) {
			// The drain lapsed between the checkpoint and the migration (e.g. manager restart): retry
			// with a new checkpoint; nothing was changed.
			return 0, e.fail(st, &Failure{Stage: Activating, Code: "checkpoint_stale", Message: "the pre-migration checkpoint may miss writes accepted since; taking a new one", ResumeRequired: true, NextRetry: e.now()})
		}
		return e.migrate(ctx, st)
	}
	op := proto.OpActivateRuntime
	if c.Class == ClassHost {
		op = proto.OpActivateHostOnReboot
	}
	res, err := e.Helper.Do(ctx, proto.Request{V: proto.Version, Op: op, ReleaseID: c.Tuple.ReleaseID})
	if err != nil {
		f := e.helperFailure(Activating, err)
		switch {
		case f == nil:
			if e.now().Sub(c.PhaseSince) < e.Policy.DrainWindow {
				return e.retryHelper(ctx, err), nil
			}
			// Bounded: do not keep users drained while the helper or metadata is unavailable.
			f = &Failure{Stage: Activating, Code: "activation_deferred", Message: err.Error(), NextRetry: e.now().Add(e.Policy.DeferralRecheck)}
		case f.Code == "activation_failed":
			// The helper recorded the activation intent; roll back from whatever partial state.
			e.beginRollback(c, f.Code, f.Message)
			return 0, e.persist(st, Activating, "activation failed; rolling back")
		case f.Code == "incompatible":
			c.Attempts = max(c.Attempts, e.Policy.MaxAttempts-1) // deterministic: quarantine after resuming
		}
		f.ResumeRequired = true
		if c.Schema != nil && c.Schema.MigrateAttempted {
			return 0, e.guard(st, f)
		}
		return 0, e.fail(st, f)
	}
	if err := e.effect(string(op)); err != nil {
		return 0, err
	}
	c.HealthyStreak = 0
	c.VerifyDeadline = e.now().Add(e.Policy.VerifyTimeout)
	note := "activated"
	if c.Class == ClassHost && res.RebootPending {
		c.VerifyDeadline = e.now().Add(e.Policy.HostRebootTimeout + e.Policy.VerifyTimeout)
		note = "reboot scheduled"
	}
	return 0, e.persist(st, Verifying, note)
}

// migrate runs the candidate's migration authority at the safe boundary (MD-10).
func (e *Engine) migrate(ctx context.Context, st *State) (time.Duration, error) {
	c := st.Candidate
	s := c.Schema
	if !s.MigrateAttempted {
		s.MigrateAttempted = true // recorded before the call: the database may change from here on
		return 0, e.persist(st, Activating, "migrating database")
	}
	res, err := e.Helper.Do(ctx, proto.Request{V: proto.Version, Op: proto.OpMigrateRuntime, ReleaseID: c.Tuple.ReleaseID, CheckpointID: s.CheckpointRef})
	if err != nil || res.Schema == nil {
		if f := e.helperFailure(Activating, errOr(err)); f != nil && proto.CodeOf(err) != proto.CodeSchema {
			f.ResumeRequired = true
			return 0, e.guard(st, f)
		}
		return e.retryHelper(ctx, errOr(err)), nil
	}
	if err := e.effect("migrate"); err != nil {
		return 0, err
	}
	m := res.Schema
	switch {
	case m.Exit == proto.SchemaExitOK && m.Access == "read-write":
		s.Migrated, s.Verdict, s.DatabaseVersion = true, m.Verdict, m.DatabaseVersion
		return 0, e.persist(st, Activating, fmt.Sprintf("migrated to schema %d", m.DatabaseVersion))
	case m.Exit == proto.SchemaExitCheckpointRequired:
		// Discard the plan: the retry re-checks, re-quiesces and takes a checkpoint first.
		// Nothing was applied (exit 13), so no guard is needed.
		return 0, e.fail(st, &Failure{Stage: Activating, Code: "checkpoint_required", Message: m.Reason, ResumeRequired: true, NextRetry: e.now()})
	case m.Exit == proto.SchemaExitLockTimeout:
		return e.backoff(1), nil
	default:
		return 0, e.guard(st, &Failure{Stage: Activating, Code: "migrate_failed", Message: fmt.Sprintf("%s %s: %s", m.ErrorKind, m.Verdict, m.Reason),
			CountsAttempt: true, ResumeRequired: true, Reasons: idents(m.ErrorKind, m.Verdict)})
	}
}

// guard parks a failure that happened after a migration attempt without activation: the next
// step confirms with the known-good binary that it can use the database before leaving Activating.
func (e *Engine) guard(st *State, f *Failure) error {
	f.At, f.Release = e.now(), st.Candidate.Tuple.ReleaseID
	st.Candidate.Guard = f
	return e.persist(st, Activating, "checking the database with the known-good release after "+f.Code)
}

func (e *Engine) resolveGuard(ctx context.Context, st *State) (time.Duration, error) {
	c := st.Candidate
	f := c.Guard
	access, err := e.knownGoodAccess(ctx, st, e.now().After(f.At.Add(e.Policy.VerifyTimeout)))
	if err != nil {
		return e.retryHelper(ctx, err), nil
	}
	c.Guard = nil
	if access == "none" {
		return 0, e.forwardRepair(ctx, st, false, f.Code, "the migration ran but the candidate did not activate ("+f.Code+"), and the installed release cannot use the database now")
	}
	f.KnownGoodAccess, f.RollbackAccess = access, access
	return 0, e.fail(st, f)
}

func errOr(err error) error {
	if err == nil {
		return errors.New("helper returned no schema answer")
	}
	return err
}

func (e *Engine) verifying(ctx context.Context, st *State) (time.Duration, error) {
	c := st.Candidate
	if c.Rollback != nil {
		return e.rollingBack(ctx, st)
	}
	now := e.now()
	if c.Class == ClassHost {
		boot, err := e.Host.BootID()
		if err != nil {
			return e.Policy.HealthInterval, err
		}
		if boot == c.ActivateBootID {
			if now.After(c.VerifyDeadline) {
				e.beginRollback(c, "reboot_timeout", "the appliance did not reboot into the candidate")
				return 0, e.persist(st, Verifying, "reboot timeout; rolling back")
			}
			return e.Policy.HealthInterval, nil
		}
		booted, err := e.Host.CurrentSystem()
		if err != nil {
			return e.Policy.HealthInterval, err
		}
		if booted != c.Tuple.HostStorePath {
			e.beginRollback(c, "boot_fallback", fmt.Sprintf("booted %s instead of the candidate (boot counting fell back)", booted))
			return 0, e.persist(st, Verifying, "boot fell back; rolling back")
		}
	}
	ev := e.Health.Check(ctx, c.Tuple.RuntimeVersion)
	c.addEvidence(ev)
	if !ev.OK {
		c.HealthyStreak = 0
		if now.After(c.VerifyDeadline) {
			e.beginRollback(c, "unhealthy", "candidate failed local health: "+joinFailures(ev.Failures))
			c.Rollback.FailedChecks = failedChecks(ev, c.Class == ClassHost)
			return 0, e.persist(st, Verifying, "unhealthy; rolling back")
		}
		return e.Policy.HealthInterval, e.persist(st, Verifying, "")
	}
	c.HealthyStreak++
	if c.HealthyStreak < e.Policy.HealthyStreak {
		return e.Policy.HealthInterval, e.persist(st, Verifying, "")
	}
	if c.Class == ClassHost {
		if _, err := e.Helper.Do(ctx, proto.Request{V: proto.Version, Op: proto.OpBlessBoot}); err != nil {
			if proto.CodeOf(err) == proto.CodeBootMismatch {
				e.beginRollback(c, "boot_fallback", err.Error())
				return 0, e.persist(st, Verifying, "boot mismatch; rolling back")
			}
			return e.backoff(1), nil
		}
		if err := e.effect("bless-boot"); err != nil {
			return 0, err
		}
	}
	if c.DrainRequestID != "" {
		_ = e.Runtime.Resume(ctx, c.DrainRequestID) // the runtime restarted; idempotent
	}
	if st.KnownGood == nil || st.KnownGood.Digest != c.Tuple.Digest {
		st.PreviousKnownGood = st.KnownGood
	}
	delete(st.VerificationFailures, c.Tuple.Digest)
	st.LastUpdate = &LastUpdate{Release: c.Tuple.ReleaseID, At: now}
	if st.Current != nil {
		st.LastUpdate.From = st.Current.ReleaseID
	}
	st.KnownGood, st.Current, st.Candidate, st.LastFailure = c.Tuple, c.Tuple, nil, nil
	if err := e.persist(st, Healthy, "candidate verified healthy"); err != nil {
		return 0, err
	}
	// The imported blobs (and closures no tuple keeps) go now, not at the next update's space check (MG-60).
	if n, b := e.Staging.Prune(keepSet(st)); n > 0 {
		e.log().Info("staging pruned after the update", "files", n, "bytes", b)
	}
	// Then the store: the runtime generations no record keeps, and every closure no generation keeps (UP-X18, UP-X19).
	return 0, e.collectStore(ctx)
}

// collectStore asks the helper to drop the runtime-profile generations its records no longer need, then to collect the
// store at low priority (UP-X18, UP-X19). It runs here only, right after an update became Healthy and staging was
// pruned, inside that step: no other step runs until it returns, so no candidate is staged meanwhile (a staged closure
// is no GC root until its activation: never between Downloading and Verifying), and a manager restart after the Healthy
// record skips it until the next update (at most once per update). Failures are warnings: the update is done.
func (e *Engine) collectStore(ctx context.Context) error {
	if res, err := e.Helper.Do(ctx, proto.Request{V: proto.Version, Op: proto.OpPruneRuntimeGenerations}); err != nil {
		e.log().Warn("pruning runtime generations failed; collecting the store anyway", "err", err)
	} else if len(res.Deleted) > 0 {
		e.log().Info("pruned runtime generations", "deleted", res.Deleted)
	}
	if err := e.effect("prune-runtime-generations"); err != nil {
		return err
	}
	stop := e.heartbeat()
	res, err := e.Helper.Do(ctx, proto.Request{V: proto.Version, Op: proto.OpCollectGarbage})
	stop()
	switch {
	case err != nil:
		e.log().Warn("collecting the store failed; the update is done", "err", err)
	case res.Collected != nil:
		c := res.Collected
		e.log().Info("store collected after the update", "paths", c.Paths, "freedBytes", c.FreedBytes, "rootFreeBytes", c.FreeBytes)
	}
	return e.effect("collect-garbage")
}

// heartbeat calls e.Heartbeat every HeartbeatEvery until stop returns (after which it is never called).
func (e *Engine) heartbeat() (stop func()) {
	if e.Heartbeat == nil {
		return func() {}
	}
	every := e.HeartbeatEvery
	if every <= 0 {
		every = 20 * time.Second
	}
	done, stopped := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(stopped)
		t := time.NewTicker(every)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-t.C:
				e.Heartbeat()
			}
		}
	}()
	return func() { close(done); <-stopped }
}

func joinFailures(fs []string) string {
	out := ""
	for i, f := range fs {
		if i > 0 {
			out += "; "
		}
		out += f
	}
	return out
}

func (e *Engine) beginRollback(c *Candidate, code, msg string) {
	now := e.now()
	c.Rollback = &Rollback{Code: code, Message: msg, Started: now, Deadline: now.Add(e.Policy.VerifyTimeout)}
	if code == "boot_fallback" || code == "reboot_timeout" {
		c.Rollback.FailedChecks = []string{"boot"} // the detail's failed check (MG-46)
	}
}

// rollingBack runs a rollback inside Activating/Verifying: (1) decide with the known-good binary
// whether it can use the database (MD-10), (2) switch back (runtime profiles, or the known-good host
// generation with reboot/bless), (3) verify known-good health, then RolledBack. When the known-good
// runtime cannot use the database it does not rewind anything: forward repair (RolledBack →
// Quarantined with forward_repair_required, the candidate stays installed).
func (e *Engine) rollingBack(ctx context.Context, st *State) (time.Duration, error) {
	c := st.Candidate
	rb := c.Rollback
	now := e.now()
	if st.KnownGood == nil {
		return e.Policy.IdleInterval, nil
	}
	if !rb.SchemaDecided {
		if c.Schema == nil || !c.Schema.MigrateAttempted {
			rb.SchemaDecided, rb.KGAccess = true, "read-write"
			return 0, e.persist(st, st.Phase, "database unchanged; rolling back")
		}
		access, err := e.knownGoodAccess(ctx, st, now.After(rb.Deadline))
		if err != nil {
			e.log().Warn("known-good schema check unavailable; will retry", "err", err)
			return e.backoff(1), nil
		}
		rb.SchemaDecided, rb.KGAccess = true, access
		if access == "none" {
			return 0, e.forwardRepair(ctx, st, true, rb.Code, c.Tuple.ReleaseID+" migrated the database and then failed ("+rb.Code+")")
		}
		return 0, e.persist(st, st.Phase, "known-good can use the database ("+access+"); rolling back")
	}
	if !rb.Done {
		if wait := rb.NextStepAt.Sub(now); wait > 0 {
			return wait, nil // a failed step's backoff (MG-55), kept across manager restarts
		}
		if c.Class == ClassRuntime {
			// "from" the candidate: the helper undoes only an activation it recorded (never past known-good).
			res, err := e.Helper.Do(ctx, proto.Request{V: proto.Version, Op: proto.OpRollbackRuntime, ReleaseID: c.Tuple.ReleaseID})
			if err != nil {
				return e.rollbackStepFailed(st, "runtime rollback", err)
			}
			if err := e.effect("rollback-runtime"); err != nil {
				return 0, err
			}
			if res.ReleaseID != st.KnownGood.ReleaseID {
				e.log().Warn("helper rolled back to a different release than known-good", "helper", res.ReleaseID, "knownGood", st.KnownGood.ReleaseID)
			}
		} else if rb.BootID == "" {
			bootBefore, err := e.Host.BootID()
			if err != nil {
				return e.Policy.HealthInterval, err
			}
			res, err := e.Helper.Do(ctx, proto.Request{V: proto.Version, Op: proto.OpActivateHostOnReboot, ReleaseID: st.KnownGood.ReleaseID})
			if err != nil {
				return e.rollbackStepFailed(st, "host rollback", err)
			}
			if err := e.effect("rollback-host"); err != nil {
				return 0, err
			}
			if res.RebootPending {
				rb.BootID, rb.Deadline = bootBefore, now.Add(e.Policy.HostRebootTimeout+e.Policy.VerifyTimeout)
				rb.StepFailures, rb.NextStepAt = 0, time.Time{}
				return e.Policy.HealthInterval, e.persist(st, st.Phase, "rolling back host (reboot)")
			}
		} else {
			boot, err := e.Host.BootID()
			if err != nil || boot == rb.BootID {
				return e.Policy.HealthInterval, err
			}
			if _, err := e.Helper.Do(ctx, proto.Request{V: proto.Version, Op: proto.OpBlessBoot}); err != nil {
				return e.rollbackStepFailed(st, "blessing the known-good boot", err)
			}
		}
		rb.Done, rb.Deadline, rb.Streak = true, now.Add(e.Policy.VerifyTimeout), 0
		rb.StepFailures, rb.NextStepAt = 0, time.Time{}
		return 0, e.persist(st, st.Phase, "rolled back to "+st.KnownGood.ReleaseID+"; verifying")
	}
	ev := e.Health.Check(ctx, st.KnownGood.RuntimeVersion)
	c.addEvidence(ev)
	if !ev.OK {
		rb.Streak = 0
		note := ""
		if now.After(rb.Deadline) && rb.Code != "known_good_unhealthy" {
			rb.Message = rb.Code + ": " + rb.Message + "; after rollback the known-good installation is unhealthy: " + joinFailures(ev.Failures)
			rb.Code, note = "known_good_unhealthy", "known-good unhealthy after rollback"
			rb.FailedChecks = failedChecks(ev, c.Class == ClassHost)
		}
		return e.Policy.HealthInterval, e.persist(st, st.Phase, note)
	}
	rb.Streak++
	if rb.Streak < e.Policy.HealthyStreak {
		return e.Policy.HealthInterval, e.persist(st, st.Phase, "")
	}
	if c.DrainRequestID != "" {
		_ = e.Runtime.Resume(ctx, c.DrainRequestID)
	}
	c.Attempts++
	code := rb.Code
	if rb.KGAccess == "read-only" {
		code = "rolled_back_read_only"
	}
	// A rollback in Verifying undid a candidate that was activated (it ran, or its host was booted into): only control
	// may have it retried (MG-56, afterVerificationFailure).
	after := st.Phase == Verifying
	c.Failure = &Failure{Stage: st.Phase, Code: code, Message: rb.Message, At: now, CountsAttempt: true,
		NextRetry: now.Add(e.backoff(c.Attempts)), KnownGoodAccess: rb.KGAccess, Release: c.Tuple.ReleaseID,
		FailedChecks: rb.FailedChecks, RollbackAccess: rb.KGAccess, AfterActivation: after}
	if after {
		if st.VerificationFailures == nil {
			st.VerificationFailures = map[string]int{}
		}
		st.VerificationFailures[c.Tuple.Digest]++
	}
	c.Rollback = nil
	if c.Deferral != nil {
		c.Deferral.Draining = false
	}
	st.Current, st.LastFailure = st.KnownGood, c.Failure
	return 0, e.persist(st, RolledBack, "rolled back after "+rb.Code)
}

// rollbackStepFailed schedules the next try of a rollback step that failed (MG-55): RollbackRetryBase doubling up to
// RollbackRetryMax, persisted (a manager restart keeps the backoff), one log line per attempt. A rollback is never
// given up: it is the way back to the known-good release. The journal state stays where it is (Activating or
// Verifying with the rollback in progress); the failure detail says the rollback is retrying.
func (e *Engine) rollbackStepFailed(st *State, step string, err error) (time.Duration, error) {
	rb := st.Candidate.Rollback
	rb.StepFailures++
	d := max(e.Policy.RollbackRetryBase, time.Second)
	for i := 1; i < rb.StepFailures && d < e.Policy.RollbackRetryMax; i++ {
		d *= 2
	}
	d = min(d, max(e.Policy.RollbackRetryMax, e.Policy.RollbackRetryBase))
	rb.NextStepAt = e.now().Add(d)
	e.log().Warn("rollback step failed; retrying", "step", step, "attempt", rb.StepFailures, "retryIn", d, "err", err)
	return d, e.persist(st, st.Phase, fmt.Sprintf("%s failed (attempt %d); retrying in %s", step, rb.StepFailures, d))
}

// knownGoodAccess asks the known-good binary what it may do on the database now (MD-10). After the
// deadline without an answer it falls back to the tuples' declared ranges.
func (e *Engine) knownGoodAccess(ctx context.Context, st *State, fallback bool) (string, error) {
	res, err := e.Helper.Do(ctx, proto.Request{V: proto.Version, Op: proto.OpCheckSchema, ReleaseID: st.KnownGood.ReleaseID})
	if err == nil && res.Schema != nil && res.Schema.Access != "" && res.Schema.ErrorKind == "" {
		return res.Schema.Access, nil
	}
	if !fallback {
		if err == nil {
			err = fmt.Errorf("schema-check answered %+v", res.Schema)
		}
		return "", err
	}
	kg, cand := st.KnownGood, st.Candidate
	if kg.Release != nil {
		// The floors the candidate reported for the schema it migrated to say what the known-good runtime can do on
		// it, as its own check would (MG-43); without them, the tuples' declared ranges.
		if s := cand.Schema; s != nil && s.Target != nil && s.NeedsMigration {
			m := schemaMigration(&proto.Schema{Target: s.Target}, &cand.Release.Tuple)
			return release.CheckMigratingActivation(kg.Release, &cand.Release.Tuple, int64(s.DatabaseVersion), m).RollbackAccess, nil
		}
		// (Only a migration attempt asks this, so the plan migrates; an exit-0 plan's floors are the live schema's.)
		if release.CheckActivation(kg.Release, &cand.Release.Tuple, cand.Tuple.SchemaWrites).RollbackCompatible {
			return "read-write", nil
		}
		return "none", nil
	}
	if w := cand.Tuple.SchemaWrites; w >= kg.SchemaReads.Min && w <= kg.SchemaReads.Max {
		return "read-write", nil
	}
	return "none", nil
}

// forwardRepair enters ForwardRepairRequired (CT-31): nothing is rolled back or rewound; the release
// is quarantined locally (so the same release is not retried) and only a fix-forward assignment
// leaves the state. candidateRunning says whether the candidate is what now runs; cause is the failure code that led
// here (the detail's reason). A cause that says the box couldn't finish right now, not that the release is bad
// (release.IsRetryableUpdateFailure: the helper or metadata unavailable after the migration ran, …), quarantines
// nothing: the candidate is the release that uses the migrated database, and assigning it again (control's “Retry
// this Whombat”) is the way forward (MG-54).
func (e *Engine) forwardRepair(ctx context.Context, st *State, candidateRunning bool, cause, why string) error {
	c := st.Candidate
	msg := fmt.Sprintf("Forward repair required: %s. Known-good %s cannot use the database; the database is not rewound. A fix-forward release is needed (maintenance).",
		why, st.KnownGood.ReleaseID)
	if release.IsRetryableUpdateFailure(cause) {
		msg = fmt.Sprintf("Forward repair required: %s. Known-good %s cannot use the database; the database is not rewound. %s is not quarantined: assigning it again finishes the update.",
			why, st.KnownGood.ReleaseID, c.Tuple.ReleaseID)
	}
	if c.DrainRequestID != "" {
		_ = e.Runtime.Resume(ctx, c.DrainRequestID)
	}
	c.Attempts++
	c.Failure = &Failure{Stage: st.Phase, Code: "forward_repair_required", Message: msg, At: e.now(), CountsAttempt: true, Blocked: true,
		Release: c.Tuple.ReleaseID, Reasons: idents(cause), RollbackAccess: release.RollbackAccessNone}
	c.Rollback, c.Guard = nil, nil
	if c.Deferral != nil {
		c.Deferral.Draining = false
	}
	if !release.IsRetryableUpdateFailure(cause) {
		st.Quarantine[c.Tuple.ReleaseID] = Quarantine{ReleaseID: c.Tuple.ReleaseID, Digest: c.Tuple.Digest, At: e.now(), Code: "forward_repair_required", Reason: msg, Attempts: c.Attempts}
	}
	if candidateRunning {
		st.Current = c.Tuple
	}
	st.LastFailure = c.Failure
	return e.persist(st, ForwardRepairRequired, "forward repair required")
}

func (e *Engine) fail(st *State, f *Failure) error {
	c := st.Candidate
	f.At = e.now()
	if f.Release == "" {
		f.Release = c.Tuple.ReleaseID
	}
	if c.Deferral != nil && c.Deferral.Draining {
		f.ResumeRequired = true
	}
	if f.CountsAttempt {
		c.Attempts++
	}
	if f.NextRetry.IsZero() {
		f.NextRetry = e.now().Add(e.backoff(max(c.Attempts, 1)))
	}
	c.Failure = f
	st.LastFailure = f
	return e.persist(st, Failed, f.Code+": "+f.Message)
}

func (e *Engine) quarantine(ctx context.Context, st *State, code, reason string) error {
	c := st.Candidate
	if c.Deferral != nil && c.Deferral.Draining {
		if err := e.Runtime.Resume(ctx, c.DrainRequestID); err != nil {
			return err
		}
	}
	st.Quarantine[c.Tuple.ReleaseID] = Quarantine{ReleaseID: c.Tuple.ReleaseID, Digest: c.Tuple.Digest, At: e.now(), Code: code, Reason: reason, Attempts: c.Attempts}
	f := c.Failure
	if f == nil {
		f = &Failure{Stage: st.Phase, Code: code, Message: reason, At: e.now()}
	}
	if f.Release == "" {
		f.Release = c.Tuple.ReleaseID
	}
	st.LastFailure = f
	st.Candidate = nil
	return e.persist(st, Quarantined, reason)
}

// failed handles failures before the installation changed: resume the runtime (after confirming
// with the known-good binary that it can still use the database if a migration was attempted),
// then retry or quarantine.
func (e *Engine) failed(ctx context.Context, st *State) (time.Duration, error) {
	c := st.Candidate
	f := c.Failure
	now := e.now()
	if done, wait, err := e.reconcileHost(ctx, st); done || err != nil {
		return wait, err
	}
	if f.ResumeRequired {
		if err := e.Runtime.Resume(ctx, c.DrainRequestID); err != nil {
			return e.Policy.DrainPoll, nil
		}
		f.ResumeRequired = false
		if c.Deferral != nil {
			c.Deferral.Draining = false
		}
		return 0, e.persist(st, Failed, "runtime resumed")
	}
	if f.Blocked {
		return e.Policy.IdleInterval, nil
	}
	// A retryable failure (release.IsRetryableUpdateFailure: this box can't right now) never quarantines the release,
	// however often it happens (MG-54); none of them counts an attempt, and this holds even if one did.
	if f.CountsAttempt && c.Attempts >= e.Policy.MaxAttempts && !release.IsRetryableUpdateFailure(f.Code) {
		return 0, e.quarantine(ctx, st, f.Code, fmt.Sprintf("%s after %d attempts: %s", f.Code, c.Attempts, f.Message))
	}
	if st.Hold || channelPaused(st, c) {
		return e.Policy.IdleInterval, nil
	}
	if wait := f.NextRetry.Sub(now); wait > 0 {
		return min(wait, e.Policy.IdleInterval), nil
	}
	e.resetForRetry(c)
	return 0, e.persist(st, Assigned, "retry")
}

func explainBlockers(bs []runtimeapi.Blocker, since time.Time, escalated bool) string {
	if len(bs) == 0 {
		return ""
	}
	names := ""
	for i, b := range sortedBlockers(bs) {
		if i > 0 {
			names += "; "
		}
		names += fmt.Sprintf("%s %s (%s)", b.Kind, b.ID, b.Description)
	}
	s := fmt.Sprintf("Update waiting for %d running item(s) to finish: %s. Acknowledged work is never interrupted for an update.", len(bs), names)
	if escalated {
		s = fmt.Sprintf("Update deferred since %s. ", since.UTC().Format(time.RFC3339)) + s
	}
	return s
}

func sortedBlockers(bs []runtimeapi.Blocker) []runtimeapi.Blocker {
	out := append([]runtimeapi.Blocker(nil), bs...)
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].ID < out[j-1].ID; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

func key(bs []runtimeapi.Blocker) string {
	s := ""
	for _, b := range sortedBlockers(bs) {
		s += b.Kind + ":" + b.ID + ","
	}
	return s
}
