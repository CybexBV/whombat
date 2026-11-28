package offsite

import (
	"time"

	"github.com/CybexBV/whombat/appliance/backup/internal/state"
)

// DocKind is the kind of the second place's status document (GET /v1/offsite).
const DocKind = "whombat.backup-offsite/1"

// States of the second place.
const (
	StateNone    = "none"    // no second place
	StateFirst   = "first"   // set up, the first copy hasn't finished yet
	StateCopying = "copying" // a copy is running now
	StateOK      = "ok"      // the newest backup is in the copy
	StateBehind  = "behind"  // newer backups wait for the next copy
	StateFailing = "failing" // the last try failed (FailedAttempts in a row)
)

// Document is the second place's state for the runtime and the apps: never a secret, never a raw error (the step and
// its sentence only).
type Document struct {
	Kind       string `json:"kind"`
	Configured bool   `json:"configured"`
	State      string `json:"state"`
	// Provider ("b2", "r2", "hetzner", "aws", "s3"), the place for people (host/bucket/folder), its repository
	// address (no credential in it) and region: what the app shows and fills in when the person changes the place.
	Provider     string     `json:"provider,omitempty"`
	Display      string     `json:"display,omitempty"`
	Repository   string     `json:"repository,omitempty"`
	S3Region     string     `json:"s3Region,omitempty"`
	ConfiguredAt *time.Time `json:"configuredAt,omitempty"`
	Running      bool       `json:"running"`
	LastCopy     *Copied    `json:"lastCopy,omitempty"`
	LastFailure  *Failure   `json:"lastFailure,omitempty"`
	// FailedAttempts in a row since the last copy that worked.
	FailedAttempts int `json:"failedAttempts"`
	// NextTryAt is when a copy is tried again after a failure.
	NextTryAt *time.Time `json:"nextTryAt,omitempty"`
	// NewestBackupAt is the newest backup at the main place; BackupsInCopy how many of the main place's are copied.
	NewestBackupAt *time.Time `json:"newestBackupAt,omitempty"`
	BackupsInCopy  int        `json:"backupsInCopy"`
	// LastClearedAt is when old backups were last cleared in the copy (by the person's keep windows).
	LastClearedAt *time.Time `json:"lastClearedAt,omitempty"`
}

// Doc reads the second place's state.
func Doc(c *state.Config) *Document {
	d := &Document{Kind: DocKind, State: StateNone}
	p, err := Load(c)
	if err != nil || p == nil {
		return d
	}
	st := LoadStatus(c, p)
	at := p.ConfiguredAt
	d.Configured, d.Provider, d.Display, d.ConfiguredAt = true, p.Provider, p.Display(), &at
	if state.KindOf(p.Repository) == state.KindS3 {
		d.Repository, d.S3Region = p.Repository, p.S3Region
	}
	d.Running = Running(c)
	d.LastCopy, d.LastFailure, d.FailedAttempts, d.BackupsInCopy = st.LastCopy, st.LastFailure, st.FailedAttempts, len(st.Copied)
	if st.FailedAttempts > 0 && st.LastAttempt != nil {
		next := st.LastAttempt.At.Add(Backoff(st.FailedAttempts))
		d.NextTryAt = &next
	}
	if cl := st.Clearing; cl != nil && cl.OK {
		t := cl.At
		d.LastClearedAt = &t
	}
	upToDate := true
	if main, _ := state.LoadDestination(c); main != nil {
		if last, _ := state.LastChain(c); last != nil && last.Repository == main.Repository {
			t := last.At
			d.NewestBackupAt = &t
			upToDate = contains(st.Copied, last.ID)
		}
	}
	switch {
	case d.Running:
		d.State = StateCopying
	case st.FailedAttempts > 0:
		d.State = StateFailing
	case st.LastCopy == nil:
		d.State = StateFirst
	case !upToDate:
		d.State = StateBehind
	default:
		d.State = StateOK
	}
	return d
}
