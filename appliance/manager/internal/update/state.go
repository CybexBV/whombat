// Package update is the manager's durable update state machine (MA-11, MG-06).
//
// States and allowed transitions are the @whombat/release contract (release.UpdateJournalState,
// release.CanTransition; CT-13):
//
//	Assigned → Downloading → Verified → Staged → WaitingForSafeBoundary → Activating → Verifying → Healthy
//	plus Failed (before anything changed), RolledBack and Quarantined.
//
// Once activation begins, the only ways out are forward (Verifying → Healthy) or RolledBack (and
// Failed from Activating only while nothing was changed); a rollback therefore runs inside
// Activating/Verifying and ends in RolledBack. The journal is the single source of truth: each Step
// loads it, performs at most one externally visible effect (all idempotent: resumable downloads,
// helper operations that report alreadyDone or re-apply, drains renewed under the same request id)
// and persists before the next effect, so a crash or kill at any point resumes correctly.
package update

import (
	"github.com/CybexBV/whombat/appliance/helper/pkg/proto"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/manager/internal/health"
	"github.com/CybexBV/whombat/appliance/manager/internal/runtimeapi"
	"github.com/CybexBV/whombat/contracts/go/release"
)

// Phase is a journal state (contract enum).
type Phase = release.UpdateJournalState

// Phases.
const (
	Assigned               = release.UpdateJournalStateAssigned
	Downloading            = release.UpdateJournalStateDownloading
	Verified               = release.UpdateJournalStateVerified
	Staged                 = release.UpdateJournalStateStaged
	WaitingForSafeBoundary = release.UpdateJournalStateWaitingForSafeBoundary
	Activating             = release.UpdateJournalStateActivating
	Verifying              = release.UpdateJournalStateVerifying
	Healthy                = release.UpdateJournalStateHealthy
	Failed                 = release.UpdateJournalStateFailed
	RolledBack             = release.UpdateJournalStateRolledBack
	Quarantined            = release.UpdateJournalStateQuarantined
	// ForwardRepairRequired (CT-31): the candidate runs (or the database was migrated past what the
	// known-good release can use); nothing is rewound; only a fix-forward assignment leaves it.
	ForwardRepairRequired = release.UpdateJournalStateForwardRepairRequired
)

// Class is the update class of a candidate (journal record updateClass).
type Class string

// Update classes (MA-11). A tuple changing runtime and host is activated as ClassHost (the host
// activation switches the runtime profiles too and reboots).
const (
	ClassRuntime Class = "runtime"
	ClassHost    Class = "host"
)

// Tuple is an installed or candidate tuple as recorded in the journal.
type Tuple struct {
	ReleaseID        string           `json:"releaseId"`
	Digest           string           `json:"digest"`
	HostStorePath    string           `json:"hostStorePath"`
	ManagerStorePath string           `json:"managerStorePath"`
	RuntimeStorePath string           `json:"runtimeStorePath"`
	RuntimeVersion   string           `json:"runtimeVersion"`
	ProviderPaths    []string         `json:"providerPaths"`
	SchemaReads      release.IntRange `json:"schemaReads"`
	SchemaWrites     int64            `json:"schemaWrites"`
	ArtifactSHA256   []string         `json:"artifactSha256"`
	// Release is the full contract tuple (for release.UpdateClass / CheckActivation).
	Release *release.ReleaseTuple `json:"release,omitempty"`
}

// TupleOf derives the journal tuple from a verified release.
func TupleOf(r *trust.Release) *Tuple {
	t := &Tuple{ReleaseID: r.Tuple.ReleaseID, Digest: r.Digest, HostStorePath: r.Tuple.Host.StorePath,
		ManagerStorePath: r.Tuple.Manager.StorePath, RuntimeStorePath: r.Tuple.Runtime.StorePath,
		RuntimeVersion: r.Tuple.Runtime.Version, SchemaReads: r.Tuple.Runtime.SchemaReads, SchemaWrites: r.Tuple.Runtime.SchemaWrites,
		ProviderPaths: []string{}}
	rt := r.Tuple
	t.Release = &rt
	for _, p := range r.Tuple.Providers {
		t.ProviderPaths = append(t.ProviderPaths, p.StorePath)
	}
	for _, a := range r.Artifacts() {
		t.ArtifactSHA256 = append(t.ArtifactSHA256, a.SHA256())
	}
	return t
}

// Failure describes why a candidate failed (Failed, RolledBack, Quarantined).
type Failure struct {
	Stage          Phase     `json:"stage"`
	Code           string    `json:"code"` // contract Ident: machine code
	Message        string    `json:"message"`
	At             time.Time `json:"at"`
	CountsAttempt  bool      `json:"countsAttempt"`
	ResumeRequired bool      `json:"resumeRequired"`
	NextRetry      time.Time `json:"nextRetry,omitempty"`
	// Blocked: no automatic action is possible (forward repair required); waits for a new assignment.
	Blocked bool `json:"blocked,omitempty"`
	// KnownGoodAccess is the known-good runtime's database access after a rollback ("read-only" is
	// reported as degraded service until a forward fix).
	KnownGoodAccess string `json:"knownGoodAccess,omitempty"`
	// The structured detail control and the owner get (MG-46, contracts UpdateFailureDetail; FailureDetail): the
	// candidate, the activation check's reasons, the schema numbers of a schema failure, the failed health checks and
	// what the installed runtime could do on the database the candidate leaves. Codes, ids and numbers only: Message
	// stays on the box.
	Release        string                       `json:"release,omitempty"`
	Reasons        []string                     `json:"reasons,omitempty"`
	Schema         *release.UpdateFailureSchema `json:"schema,omitempty"`
	FailedChecks   []string                     `json:"failedChecks,omitempty"`
	RollbackAccess string                       `json:"rollbackAccess,omitempty"`
	// AfterActivation: the candidate was activated and rolled back (it failed verification, didn't boot or didn't
	// come up in time): only control assigning it again retries it (MG-56).
	AfterActivation bool `json:"afterActivation,omitempty"`
}

// Rollback is an in-progress rollback inside Activating/Verifying.
type Rollback struct {
	Code          string    `json:"code"`
	Message       string    `json:"message"`
	Started       time.Time `json:"started"`
	Deadline      time.Time `json:"deadline"`
	SchemaDecided bool      `json:"schemaDecided"`
	KGAccess      string    `json:"kgAccess,omitempty"`
	Done          bool      `json:"done"`
	BootID        string    `json:"bootId,omitempty"`
	Streak        int       `json:"streak"`
	// FailedChecks: the candidate's failed health checks when it was unhealthy (MG-46); the failure keeps them.
	FailedChecks []string `json:"failedChecks,omitempty"`
	// StepFailures and NextStepAt: a rollback step (the helper) that keeps failing is retried with a backoff kept
	// here, so a manager restart doesn't retry in a tight loop (MG-55).
	StepFailures int       `json:"stepFailures,omitempty"`
	NextStepAt   time.Time `json:"nextStepAt,omitempty"`
}

// SchemaPlan is what the candidate's schema check and migration require (MD-10).
type SchemaPlan struct {
	Checked         bool     `json:"checked"`
	Verdict         string   `json:"verdict,omitempty"`
	Access          string   `json:"access,omitempty"`
	DatabaseVersion int      `json:"databaseVersion"`
	NeedsMigration  bool     `json:"needsMigration"`
	Pending         []string `json:"pending,omitempty"`
	// Target is the schema the candidate's migration leaves and its floors, as its schema check reported them
	// (Whombat MD-12); nil from a runtime before it.
	Target *proto.SchemaTarget `json:"target,omitempty"`
	// RollbackCompatible (release.CheckActivation / CheckMigratingActivation): the installed runtime can still
	// read and write what the candidate leaves. RollbackAccess: read-write, read-only or none (MG-43).
	RollbackCompatible bool     `json:"rollbackCompatible"`
	RollbackAccess     string   `json:"rollbackAccess,omitempty"`
	NeedsCheckpoint    []string `json:"needsCheckpoint,omitempty"`
	CheckpointRef      string   `json:"checkpointRef,omitempty"`
	// The checkpoint is bound to the drain it was taken in (L-1): its window and time. Once the runtime
	// resumed (hold, lock, window end) or the drain lease may have lapsed (manager down), the checkpoint
	// may miss acknowledged writes and a new one is taken before migrating.
	CheckpointWindow int       `json:"checkpointWindow,omitempty"`
	CheckpointAt     time.Time `json:"checkpointAt,omitempty"`
	MigrateAttempted bool      `json:"migrateAttempted"`
	Migrated         bool      `json:"migrated"`
}

// Deferral explains why activation is waiting.
type Deferral struct {
	Since       time.Time            `json:"since"`
	WindowStart time.Time            `json:"windowStart,omitempty"`
	Draining    bool                 `json:"draining"`
	NextCheck   time.Time            `json:"nextCheck,omitempty"`
	Windows     int                  `json:"windows"`
	Blockers    []runtimeapi.Blocker `json:"blockers,omitempty"`
	Explanation string               `json:"explanation,omitempty"`
	Escalated   bool                 `json:"escalated,omitempty"`
	RuntimeDown time.Time            `json:"runtimeDown,omitempty"`
	Waiting     string               `json:"waiting,omitempty"` // hold | owner | lock | window | checkpoint | metadata | boundary
}

// Candidate is the release being installed.
type Candidate struct {
	// Channel is the update channel that offered it ("" an assignment or a community box's newest): a candidate of
	// another channel than the box's is never drained for (Engine.offChannel).
	Channel        string            `json:"channel,omitempty"`
	Release        *trust.Release    `json:"release"`
	Tuple          *Tuple            `json:"tuple"`
	Class          Class             `json:"class"`
	AssignmentSeq  int64             `json:"assignmentSeq"`
	RolloutID      string            `json:"rolloutId"`
	NotBefore      int64             `json:"notBefore"`
	Attempts       int               `json:"attempts"`
	DrainRequestID string            `json:"drainRequestId,omitempty"`
	Deferral       *Deferral         `json:"deferral,omitempty"`
	Schema         *SchemaPlan       `json:"schema,omitempty"`
	ActivateBootID string            `json:"activateBootId,omitempty"`
	VerifyDeadline time.Time         `json:"verifyDeadline,omitempty"`
	HealthyStreak  int               `json:"healthyStreak"`
	Evidence       []health.Evidence `json:"evidence,omitempty"`
	Rollback       *Rollback         `json:"rollback,omitempty"`
	// Guard is a failure after a migration attempt that did not activate: before leaving Activating
	// the known-good binary must confirm it can still use the database (else ForwardRepairRequired).
	Guard      *Failure  `json:"guard,omitempty"`
	Failure    *Failure  `json:"failure,omitempty"`
	PhaseSince time.Time `json:"phaseSince"`
	// Reassigned: control assigned this release again after it failed verification (MG-56); it is retried once
	// VerifyRetryDelay since the failure passed.
	Reassigned bool `json:"reassigned,omitempty"`
	// AssignmentRaw is the signed assignment the helper checks at activation: the engine writes it to the assignment
	// file with every save of this candidate and before every step (SR-12); nil from a manager before it.
	AssignmentRaw []byte `json:"assignmentRaw,omitempty"`
}

// PendingAssignment is a verified assignment waiting for the current activation to finish.
type PendingAssignment struct {
	Raw       []byte         `json:"raw"`
	Seq       int64          `json:"seq"`
	Release   *trust.Release `json:"release"`
	Rollout   string         `json:"rollout"`
	NotBefore int64          `json:"notBefore"`
	Channel   string         `json:"channel,omitempty"`
}

// Quarantine records a locally quarantined release.
type Quarantine struct {
	ReleaseID string    `json:"releaseId"`
	Digest    string    `json:"digest"`
	At        time.Time `json:"at"`
	Code      string    `json:"code"`
	Reason    string    `json:"reason"`
	Attempts  int       `json:"attempts"`
}

// Lock is a maintenance lock held by another local component (backup agent, operator).
type Lock struct {
	Holder  string    `json:"holder"`
	Reason  string    `json:"reason"`
	Since   time.Time `json:"since"`
	Expires time.Time `json:"expires"`
}

// HistoryEntry is one transition (bounded list).
type HistoryEntry struct {
	At        time.Time `json:"at"`
	From      Phase     `json:"from"`
	To        Phase     `json:"to"`
	ReleaseID string    `json:"releaseId,omitempty"`
	Note      string    `json:"note,omitempty"`
}

// State is the journal content: the contract record (release.UpdateJournalRecord, validated on
// every write) plus the manager's own resume data.
type State struct {
	Record            release.UpdateJournalRecord `json:"record"`
	Phase             Phase                       `json:"phase"`
	Current           *Tuple                      `json:"current,omitempty"`
	KnownGood         *Tuple                      `json:"knownGood,omitempty"`
	PreviousKnownGood *Tuple                      `json:"previousKnownGood,omitempty"`
	Candidate         *Candidate                  `json:"candidate,omitempty"`
	Pending           *PendingAssignment          `json:"pending,omitempty"`
	LastAssignmentSeq int64                       `json:"lastAssignmentSeq"`
	// LastOffer is the channel and tuple digest of the last newest-of-a-channel offer (LNK-20): the same release of the
	// same channel is offered once, however often the snapshot is re-signed.
	LastOffer  string                `json:"lastOffer,omitempty"`
	TimeFloor  int64                 `json:"timeFloor"`
	Quarantine map[string]Quarantine `json:"quarantine,omitempty"`
	Lock       *Lock                 `json:"lock,omitempty"`
	Hold       bool                  `json:"hold"`
	// AskFirst is the owner's “Ask before updating”: every candidate waits (Waiting "owner") until the owner approves
	// that release. Approved is the release the owner approved, while it is the candidate; it ends when that candidate
	// is installed, rolled back or dropped, so a later offer of the same release asks again (Whombat
	// ask-before-updating.md).
	AskFirst    bool     `json:"askFirst,omitempty"`
	Approved    string   `json:"approved,omitempty"`
	LastRefusal string   `json:"lastRefusal,omitempty"`
	LastFailure *Failure `json:"lastFailure,omitempty"`
	// VerificationFailures counts, per release tuple digest, the times a release was activated and rolled back (MG-56):
	// at Policy.MaxVerifyFailures it is quarantined. Kept across candidates (another release in between).
	VerificationFailures map[string]int `json:"verificationFailures,omitempty"`
	// LastUpdate is the last candidate that became the healthy current release (MG-47; the owner's “Updated to …”).
	LastUpdate *LastUpdate    `json:"lastUpdate,omitempty"`
	History    []HistoryEntry `json:"history,omitempty"`
	// JournalSeq is the sequence number of the journal record this state was loaded from or saved as (not part of
	// the record): it orders the update reports built from it (SR-04).
	JournalSeq uint64 `json:"-"`

	// base digests the state as loaded (SR-11): what a step changed, and what changed under it.
	base struct{ rest, foreign string }
	// mergeable: this step's save may take a concurrent change of the foreign fields (SR-13).
	mergeable bool
}

// LastUpdate records a completed update: the release, the one it replaced and when it became healthy.
type LastUpdate struct {
	Release string    `json:"release"`
	From    string    `json:"from,omitempty"`
	At      time.Time `json:"at"`
}

const maxHistory = 64
const maxEvidence = 8

func (s *State) record(from, to Phase, id, note string, at time.Time) {
	s.History = append(s.History, HistoryEntry{At: at, From: from, To: to, ReleaseID: id, Note: note})
	if len(s.History) > maxHistory {
		s.History = s.History[len(s.History)-maxHistory:]
	}
}

// Steady reports whether no candidate is being processed.
func (s *State) Steady() bool {
	return s.Phase == Healthy || s.Phase == RolledBack || s.Phase == Quarantined || s.Phase == ForwardRepairRequired
}

// Activation reports whether the installation may be changing (new assignments are queued, no
// other maintenance may start).
func (s *State) Activation() bool {
	switch s.Phase {
	case Activating, Verifying:
		return true
	case WaitingForSafeBoundary:
		return s.Candidate != nil && s.Candidate.Deferral != nil && s.Candidate.Deferral.Draining
	}
	return false
}
