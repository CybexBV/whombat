package dest

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/CybexBV/whombat/appliance/backup/internal/state"
)

// Disk destinations (BK-20, BK-27): the repository is <mount>/whombat/repository on the disk labelled
// WHOMBAT-BACKUP. Configuring it is the owner's consent to that disk: the service asks the root helper
// (whombat-backup disk-init, started by a path unit) to pin the disk's filesystem UUID and mount it — the
// mounted one, the one labelled disk attached, or, with allowInit, the one empty disk formatted. From then
// on only the pinned disk is ever mounted (whombat-backup disk-attach). The service itself can't format,
// pin or mount anything, and never names a device.

// InitRequest is <stateDir>/disk-init/request.json (written by the service, read by the root helper).
type InitRequest struct {
	Nonce string    `json:"nonce"`
	At    time.Time `json:"at"`
	// Init allows formatting the one empty disk (the owner's allowInit).
	Init bool `json:"init"`
}

// InitResult is <stateDir>/disk-init/result.json (written by the root helper).
type InitResult struct {
	Nonce   string    `json:"nonce"`
	OK      bool      `json:"ok"`
	Device  string    `json:"device,omitempty"`
	Message string    `json:"message,omitempty"` // owner-facing (ASCII)
	At      time.Time `json:"at"`
}

// InitDir is where requests and results are exchanged.
func InitDir(c *state.Config) string { return filepath.Join(c.StateDir, "disk-init") }

// ensureDisk has the disk pinned and mounted (by the root helper) and its folder ready.
func ensureDisk(ctx context.Context, c *state.Config, allowInit bool) error {
	switch {
	case c.DiskHelper:
		if err := requestDisk(ctx, c, allowInit); err != nil {
			return err
		}
	case c.DiskPresent(): // no root helper (tests): an attached disk is used as it is
	case !allowInit:
		return &DestError{Reason: "No disk labelled WHOMBAT-BACKUP is attached. Attach one, or attach an empty disk and let Whombat prepare it.",
			Err: errors.New("disk absent")}
	default:
		if err := requestDisk(ctx, c, true); err != nil {
			return err
		}
	}
	// On the appliance the root helper made this folder for the backup user already.
	if err := os.MkdirAll(filepath.Dir(c.DiskRepository()), 0o700); err != nil {
		return &DestError{Reason: "The backup disk is attached but Whombat can't write to it.", Err: err}
	}
	return nil
}

// requestDisk asks the root helper to pin and mount the disk and waits until it is mounted.
func requestDisk(ctx context.Context, c *state.Config, init bool) error {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	nonce := hex.EncodeToString(b)
	dir := InitDir(c)
	_ = os.Remove(filepath.Join(dir, "result.json"))
	if err := state.WriteJSON(filepath.Join(dir, "request.json"), InitRequest{Nonce: nonce, At: time.Now().UTC(), Init: init}, 0o644); err != nil {
		return err
	}
	deadline := time.Now().Add(time.Duration(c.DiskInitTimeoutMs) * time.Millisecond)
	var res *InitResult
	for time.Now().Before(deadline) {
		if res == nil {
			if b, err := os.ReadFile(filepath.Join(dir, "result.json")); err == nil {
				var r InitResult
				if json.Unmarshal(b, &r) == nil && r.Nonce == nonce {
					res = &r
					if !r.OK {
						msg := strings.TrimSpace(r.Message)
						if msg == "" {
							msg = "The backup disk couldn't be set up."
						}
						return &DestError{Reason: msg, Err: errors.New("disk-init refused")}
					}
				}
			}
		}
		if res != nil && c.DiskPresent() {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
	_ = os.Remove(filepath.Join(dir, "request.json"))
	if res != nil {
		return &DestError{Reason: "The disk was prepared but isn't mounted yet: try again in a minute.", Err: errors.New("disk not mounted")}
	}
	return &DestError{Reason: "The disk couldn't be prepared in time: try again, or prepare it yourself (ext4 or btrfs, labelled WHOMBAT-BACKUP).",
		Err: errors.New("disk-init: no answer")}
}

const absentPrefix = "disk-absent-"

// absentFlagged: the status says the disk is missing (from a status read or a checkpoint's preflight).
func absentFlagged(s *state.Status) bool {
	return s.LastFailure != nil && s.LastFailure.Reason == ReasonDiskAbsent && s.LastAttemptOK != nil && !*s.LastAttemptOK
}

// clearPresenceFailure undoes a "disk absent" state (it was never an attempt): the state goes back to what
// the last real attempt said. The failure stays in lastFailure as history.
func clearPresenceFailure(s *state.Status) {
	if !absentFlagged(s) {
		return
	}
	if s.LastSuccess != nil {
		ok := true
		s.LastAttemptOK = &ok
	} else {
		s.LastAttemptOK = nil
	}
	s.FailedAttempts = 0
}

// RefreshPresence puts "the disk isn't attached" into the status as soon as someone reads it (and takes it
// out when the disk is back), so the owner doesn't wait for the next backup to learn it (BK-20).
func RefreshPresence(c *state.Config) {
	d, err := state.LoadDestination(c)
	if err != nil || d == nil || d.Kind != state.KindDisk {
		return
	}
	s, err := state.LoadStatus(c)
	if err != nil {
		return
	}
	present, flagged := c.DiskPresent(), absentFlagged(s)
	switch {
	case !present && !flagged:
		now := time.Now().UTC()
		_, _ = state.UpdateStatus(c, func(s *state.Status) {
			ok := false
			s.LastAttemptOK = &ok
			s.FailedAttempts = state.FailingAfter // a missing disk isn't a blip: say failing at once
			s.LastFailure = &state.Failure{ID: absentPrefix + now.Format("20060102T150405Z"), At: now, Stage: "preflight", Reason: ReasonDiskAbsent}
		})
	case present && flagged:
		_, _ = state.UpdateStatus(c, clearPresenceFailure)
	}
}
