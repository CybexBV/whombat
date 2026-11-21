// Package journal is the manager's crash-safe state journal (MG-05).
//
// Two slots (journal.a.json, journal.b.json) are written alternately, each with temp file + fsync +
// rename + directory fsync. Every record carries a monotonically increasing sequence number, a format
// version, the minimum reader version able to act on it, and a SHA-256 of the canonical state. Load
// picks the valid record with the highest sequence, so a torn or corrupted latest write falls back
// to the previous complete state instead of losing the journal.
package journal

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/atomicfile"
	"github.com/CybexBV/whombat/appliance/helper/pkg/canonjson"
)

// Format identifies journal records.
const Format = "whombat-manager-journal"

// ReaderVersion is the record version this binary writes and understands. Older binaries (the
// known-good recovery manager) may read newer records when MinReader <= their ReaderVersion:
// changes are additive (new optional fields) unless MinReader is raised.
const ReaderVersion = 1

// ErrTooNew means the journal was written by a newer manager that older readers must not act on.
var ErrTooNew = errors.New("journal written by a newer manager (min reader version too high)")

// Record is the on-disk envelope.
type Record struct {
	Format    string          `json:"format"`
	Version   int             `json:"version"`
	MinReader int             `json:"minReader"`
	Seq       uint64          `json:"seq"`
	WrittenAt time.Time       `json:"writtenAt"`
	SHA256    string          `json:"sha256"`
	State     json.RawMessage `json:"state"`
}

// Journal stores one JSON-serializable state value.
type Journal struct {
	dir string
	mu  sync.Mutex
	seq uint64
	// BeforeWrite, if set, is called before a record is written (crash-injection in tests).
	BeforeWrite func(seq uint64) error
}

// Open opens (creating) a journal directory.
func Open(dir string) (*Journal, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	atomicfile.CleanTemps(dir)
	return &Journal{dir: dir}, nil
}

func (j *Journal) slot(seq uint64) string {
	if seq%2 == 0 {
		return filepath.Join(j.dir, "journal.a.json")
	}
	return filepath.Join(j.dir, "journal.b.json")
}

func readRecord(p string) (*Record, error) {
	b, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	var r Record
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, fmt.Errorf("%s: %w", p, err)
	}
	if r.Format != Format {
		return nil, fmt.Errorf("%s: not a journal record", p)
	}
	canon, err := canonjson.Canonicalize(r.State)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", p, err)
	}
	sum := sha256.Sum256(canon)
	if hex.EncodeToString(sum[:]) != r.SHA256 {
		return nil, fmt.Errorf("%s: checksum mismatch", p)
	}
	return &r, nil
}

// Load decodes the newest valid state into v. found is false for an empty journal.
func (j *Journal) Load(v any) (found bool, err error) {
	_, found, err = j.LoadSeq(v)
	return found, err
}

// LoadSeq is Load that also returns the sequence number of the record it decoded (0 for an empty journal). The
// sequence orders the journal's states across processes and manager versions (update reports, SR-04).
func (j *Journal) LoadSeq(v any) (seq uint64, found bool, err error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	var best *Record
	var errs []error
	for _, name := range []string{"journal.a.json", "journal.b.json"} {
		r, err := readRecord(filepath.Join(j.dir, name))
		if err != nil {
			if !errors.Is(err, os.ErrNotExist) {
				errs = append(errs, err)
			}
			continue
		}
		if best == nil || r.Seq > best.Seq {
			best = r
		}
	}
	if best == nil {
		if len(errs) > 0 {
			return 0, false, fmt.Errorf("journal unreadable: %w", errors.Join(errs...))
		}
		return 0, false, nil
	}
	if best.MinReader > ReaderVersion {
		return 0, false, fmt.Errorf("%w: minReader %d > %d", ErrTooNew, best.MinReader, ReaderVersion)
	}
	if err := json.Unmarshal(best.State, v); err != nil {
		return 0, false, fmt.Errorf("journal state: %w", err)
	}
	// The newest readable record, also when a newer one became unreadable: the next save follows it (SR-11).
	j.seq = best.Seq
	return best.Seq, true, nil
}

// Save durably writes v as the next record.
func (j *Journal) Save(v any) error {
	_, err := j.SaveSeq(v)
	return err
}

// SaveSeq is Save that returns the sequence number of the record it wrote.
func (j *Journal) SaveSeq(v any) (uint64, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	state, err := canonjson.Marshal(v)
	if err != nil {
		return 0, err
	}
	sum := sha256.Sum256(state)
	next := j.seq + 1
	rec := Record{Format: Format, Version: ReaderVersion, MinReader: 1, Seq: next, WrittenAt: time.Now().UTC(),
		SHA256: hex.EncodeToString(sum[:]), State: state}
	b, err := json.Marshal(rec)
	if err != nil {
		return 0, err
	}
	if j.BeforeWrite != nil {
		if err := j.BeforeWrite(next); err != nil {
			return 0, err
		}
	}
	if err := atomicfile.WriteFile(j.slot(next), b, 0o600); err != nil {
		return 0, err
	}
	j.seq = next
	return next, nil
}

// Seq returns the sequence number of the newest record this journal wrote or read (0 before either).
func (j *Journal) Seq() uint64 {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.seq
}

// Dir returns the journal directory.
func (j *Journal) Dir() string { return j.dir }
