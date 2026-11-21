package state

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/CybexBV/whombat/contracts/go/local"

	"github.com/CybexBV/whombat/appliance/backup/pkg/coverage"
)

// StatusKind is the status document's format (BK-11). The runtime reads it (file or API) and serves it to
// clients; @whombat/protocol needs a matching schema (contract gap, docs/decisions/backup.md).
const StatusKind = "whombat.backup-status/1"

// States.
const (
	StateUnprotected = "unprotected" // no destination configured — never shown as "backups enabled"
	StatePending     = "pending"     // destination configured, no successful checkpoint yet
	StateProtected   = "protected"   // last attempt succeeded and is recent
	StateStale       = "stale"       // last success older than staleAfter
	StateFailing     = "failing"     // FailingAfter attempts in a row failed, or one did and the backups are late (lastSuccess still shown)
)

// FailingAfter is how many attempts in a row must fail before the status says failing while the backups aren't late
// yet: one failure is often a blip (the first run after a boot on Wi-Fi, a NAS that was asleep), and the next try is
// 15 minutes later.
const FailingAfter = 2

// DestinationStatus is the client-safe view of the destination (never credentials).
type DestinationStatus struct {
	Configured   bool   `json:"configured"`
	Kind         string `json:"kind,omitempty"`
	Display      string `json:"display,omitempty"`
	AppendOnly   string `json:"appendOnly,omitempty"`
	RepositoryID string `json:"repositoryId,omitempty"`
}

// Success is the last successful checkpoint.
type Success struct {
	ID            string    `json:"id"`
	At            time.Time `json:"at"`
	AgeSeconds    int64     `json:"ageSeconds"`
	SnapshotID    string    `json:"snapshotId"`
	Method        string    `json:"method"`
	QuiesceHeldMs int64     `json:"quiesceHeldMs"`
	DurationMs    int64     `json:"durationMs"`
	BytesAdded    int64     `json:"bytesAdded"`
	TotalBytes    int64     `json:"totalBytes"`
	Files         int64     `json:"files"`
	SchemaVersion int       `json:"schemaVersion"`
	// Incomplete is set when the backup was made with a gap (it was uploaded anyway): what it lacks, in plain words.
	Incomplete *Incomplete `json:"incomplete,omitempty"`
}

// Incomplete is what the last backup lacks.
type Incomplete struct {
	Attachments int    `json:"attachments,omitempty"` // attachments that weren't on the box
	Servers     bool   `json:"servers,omitempty"`     // the servers couldn't be backed up
	Reason      string `json:"reason"`                // one or two sentences for people (OneLine)
}

// Failure is the last failed attempt.
type Failure struct {
	ID     string    `json:"id"`
	At     time.Time `json:"at"`
	Stage  string    `json:"stage"`  // Stages (contract enum)
	Reason string    `json:"reason"` // one line for people in any script, at most 500 characters (OneLine)
}

// Drill is the last restore drill (recoverability).
type Drill struct {
	At               time.Time `json:"at"`
	OK               bool      `json:"ok"`
	CheckpointID     string    `json:"checkpointId"`
	RTOSeconds       int64     `json:"rtoSeconds"`
	BackupAgeSeconds int64     `json:"backupAgeSeconds"`
	Failed           []string  `json:"failed,omitempty"`
	Skipped          []string  `json:"skipped,omitempty"`
}

// CoverageStatus is one coverage class for the client.
type CoverageStatus struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Covered bool   `json:"covered"`
	Relogin bool   `json:"relogin,omitempty"`
}

// Running is an operation in progress.
type Running struct {
	ID    string    `json:"id"`
	Op    string    `json:"op"`
	Stage string    `json:"stage"`
	Since time.Time `json:"since"`
}

// Status is the document.
type Status struct {
	Kind          string            `json:"kind"`
	State         string            `json:"state"`
	Protected     bool              `json:"protected"`
	Destination   DestinationStatus `json:"destination"`
	LastSuccess   *Success          `json:"lastSuccess"`
	LastFailure   *Failure          `json:"lastFailure"`
	LastAttemptOK *bool             `json:"lastAttemptOk"`
	// FailedAttempts counts the attempts that failed since the last success (0 after one).
	FailedAttempts int              `json:"failedAttempts"`
	Coverage       []CoverageStatus `json:"coverage"`
	Recoverability struct {
		LastDrill *Drill `json:"lastDrill"`
	} `json:"recoverability"`
	KitGeneration int      `json:"kitGeneration"`
	Running       *Running `json:"running"`
	// Clearing says who clears old backups at the destination and how the box's own clearing went.
	Clearing  *Clearing `json:"clearing,omitempty"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// Who clears old backups (Clearing.By).
const (
	// ClearedByBox: this Whombat's own key may delete there (every destination that isn't append-only), so the box
	// applies the person's windows and space limit after a backup, at most once a day.
	ClearedByBox = "box"
	// ClearedByDestination: the destination refuses this Whombat's deletes (append-only), so only its own side can
	// clear: a backup place's cleanup, or nobody.
	ClearedByDestination = "destination"
)

// ClearedBy is who clears old backups at d.
func ClearedBy(d *Destination) string {
	if d.AppendOnly == "verified" {
		return ClearedByDestination
	}
	return ClearedByBox
}

// Clearing is the status's view of clearing old backups.
type Clearing struct {
	By string `json:"by"` // ClearedByBox | ClearedByDestination
	// The box's last clearing (when By is box and it ran).
	At    *time.Time `json:"at,omitempty"`
	OK    *bool      `json:"ok,omitempty"`
	Error string     `json:"error,omitempty"`
	// Bytes is the repository's size after it; OverLimit: still over the space limit with only the windows the limit
	// may not shorten left (the last 7 days, and every window already at its shortest).
	Bytes     *int64 `json:"bytes,omitempty"`
	OverLimit bool   `json:"overLimit,omitempty"`
}

// ClearingRecord is <stateDir>/forget.json: the box's last clearing of old backups (BKO-04, BKO-05).
type ClearingRecord struct {
	At         time.Time `json:"at"`
	OK         bool      `json:"ok"`
	Error      string    `json:"error,omitempty"`
	Repository string    `json:"repository,omitempty"` // the destination it cleared
	Bytes      *int64    `json:"bytes,omitempty"`
	OverLimit  bool      `json:"overLimit,omitempty"`
	// Steps are the windows it forgot with: the person's, then the limit's shorter ones it needed.
	Steps [][]string `json:"steps,omitempty"`
}

// ClearingPath is <stateDir>/forget.json.
func (c *Config) ClearingPath() string { return filepath.Join(c.StateDir, "forget.json") }

// LoadClearing reads the box's last clearing (nil when it never ran).
func LoadClearing(c *Config) *ClearingRecord {
	b, err := ReadStateFile(c.ClearingPath())
	if err != nil {
		return nil
	}
	var r ClearingRecord
	if json.Unmarshal(b, &r) != nil || r.At.IsZero() {
		return nil
	}
	return &r
}

// Stages are the contract's failure stages (local.BackupServiceStatus lastFailure.stage).
var Stages = []string{"preflight", "quiesce", "snapshot", "dump", "upload", "verify"}

// ASCII folds text to printable ASCII (the contract's free-text rule): typographic quotes and dashes to
// their ASCII forms, other non-printables to spaces, runs of whitespace collapsed, truncated to max.
func ASCII(s string, max int) string {
	r := strings.NewReplacer("\u2018", "'", "\u2019", "'", "\u201c", `"`, "\u201d", `"`, "\u2013", "-", "\u2014", "-",
		"\u2026", "...", "\u2192", "->", "\u00b7", "-", "\u2212", "-")
	s = r.Replace(s)
	var b strings.Builder
	space := false
	for _, c := range s {
		if c < 0x20 || c > 0x7e {
			c = ' '
		}
		if c == ' ' {
			if space {
				continue
			}
			space = true
		} else {
			space = false
		}
		b.WriteRune(c)
	}
	out := strings.TrimSpace(b.String())
	if len(out) > max {
		out = out[:max-3] + "..."
	}
	return out
}

// OneLine makes a sentence for people one line of at most max characters (code points), the Whombat server's rule for
// a backup's failure reasons: control, format and separator characters (newlines, tabs, zero-width and direction
// marks, no-break spaces) become one space, runs of spaces one, and a longer text is cut with "…". Curly quotes,
// accents and every script stay as they are.
func OneLine(s string, max int) string {
	var b strings.Builder
	space, n := false, 0
	for _, c := range strings.ToValidUTF8(s, "\uFFFD") {
		if c != ' ' && unicode.In(c, unicode.Cc, unicode.Cf, unicode.Cs, unicode.Z) {
			c = ' '
		}
		if c == ' ' && (space || n == 0) {
			continue
		}
		space = c == ' '
		b.WriteRune(c)
		n++
	}
	out := strings.TrimRight(b.String(), " ")
	if max > 0 && utf8.RuneCountInString(out) > max {
		r := []rune(out)[:max-1]
		out = strings.TrimRight(string(r), " ") + "…"
	}
	return out
}

// Validate checks the document against the contract schema (whombat-contracts local.BackupServiceStatus), whose
// reasons are one line in any script (OneLine).
func (s *Status) Validate() error {
	b, err := json.Marshal(s)
	if err != nil {
		return err
	}
	_, err = local.ParseBackupServiceStatus(b)
	return err
}

func sanitize(s *Status) {
	if s.LastSuccess != nil && s.LastSuccess.Incomplete != nil {
		s.LastSuccess.Incomplete.Reason = OneLine(s.LastSuccess.Incomplete.Reason, 500)
	}
	if f := s.LastFailure; f != nil {
		f.Reason = OneLine(f.Reason, 500)
		if !slices.Contains(Stages, f.Stage) {
			f.Stage = "preflight"
		}
	}
	if d := s.Recoverability.LastDrill; d != nil {
		d.RTOSeconds = max(d.RTOSeconds, 0)
		d.BackupAgeSeconds = max(d.BackupAgeSeconds, 0)
	}
	s.Destination.Display = ASCII(s.Destination.Display, 200)
	for i := range s.Coverage {
		s.Coverage[i].Title = ASCII(s.Coverage[i].Title, 80)
	}
}

var statusMu sync.Mutex

// LoadStatus reads the status file (a fresh one when absent).
func LoadStatus(c *Config) (*Status, error) {
	b, err := ReadStateFile(c.StatusPath())
	s := &Status{}
	if err == nil {
		if err := json.Unmarshal(b, s); err != nil {
			return nil, err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	return s, nil
}

// Derive recomputes State, Protected, ages, destination and coverage.
func Derive(c *Config, s *Status, d *Destination, now time.Time) {
	s.Kind = StatusKind
	s.Coverage = s.Coverage[:0]
	for _, cl := range coverage.Classes(c.Layout()) {
		s.Coverage = append(s.Coverage, CoverageStatus{ID: cl.ID, Title: cl.Title, Covered: cl.Covered, Relogin: cl.Relogin})
	}
	s.Clearing = nil
	if d == nil {
		s.Destination = DestinationStatus{Configured: false}
	} else {
		s.Destination = DestinationStatus{Configured: true, Kind: d.Kind, Display: d.Display(), AppendOnly: d.AppendOnly, RepositoryID: d.RepositoryID}
		s.KitGeneration = d.Generation
		s.Clearing = &Clearing{By: ClearedBy(d)}
		if r := LoadClearing(c); r != nil && s.Clearing.By == ClearedByBox && (r.Repository == "" || r.Repository == d.Repository) {
			at, ok := r.At, r.OK
			s.Clearing.At, s.Clearing.OK, s.Clearing.Error = &at, &ok, ASCII(r.Error, 300)
			s.Clearing.Bytes, s.Clearing.OverLimit = r.Bytes, r.OverLimit
		}
	}
	if s.LastSuccess != nil {
		s.LastSuccess.AgeSeconds = max(int64(now.Sub(s.LastSuccess.At).Seconds()), 0)
	}
	failed := s.FailedAttempts
	if s.LastAttemptOK != nil && !*s.LastAttemptOK {
		failed = max(failed, 1) // a status written before the count
	} else {
		failed = 0
	}
	s.FailedAttempts = failed
	late := s.LastSuccess != nil && now.Sub(s.LastSuccess.At) > staleAfter(c)
	switch {
	case d == nil:
		s.State = StateUnprotected
	case failed >= FailingAfter || (failed > 0 && late):
		s.State = StateFailing
	case s.LastSuccess == nil:
		s.State = StatePending
	case late:
		s.State = StateStale
	default:
		s.State = StateProtected
	}
	s.Protected = s.State == StateProtected
	s.UpdatedAt = now.UTC()
	sanitize(s)
}

// UpdateStatus loads, mutates, derives and writes the status (0644: the runtime reads it).
func UpdateStatus(c *Config, mutate func(*Status)) (*Status, error) {
	statusMu.Lock()
	defer statusMu.Unlock()
	s, err := LoadStatus(c)
	if err != nil {
		s = &Status{}
	}
	if mutate != nil {
		mutate(s)
	}
	d, _ := LoadDestination(c)
	Derive(c, s, d, time.Now())
	if err := s.Validate(); err != nil {
		return s, fmt.Errorf("status document fails the contract schema: %w", err)
	}
	return s, WriteJSON(c.StatusPath(), s, 0o644)
}

// CurrentStatus derives the status now without writing.
func CurrentStatus(c *Config) (*Status, error) {
	s, err := LoadStatus(c)
	if err != nil {
		return nil, err
	}
	d, err := LoadDestination(c)
	if err != nil {
		return nil, err
	}
	Derive(c, s, d, time.Now())
	return s, nil
}

// staleAfter follows the person's frequency once a policy is set (BKO-02), else the configured value.
func staleAfter(c *Config) time.Duration {
	if policyFileExists(c) {
		return LoadPolicy(c).StaleAfter()
	}
	return time.Duration(c.StaleAfterMs) * time.Millisecond
}
