package ops

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/CybexBV/whombat/appliance/helper/internal/activator"
	"github.com/CybexBV/whombat/appliance/helper/pkg/atomicfile"
	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
)

// Activated records a tuple the helper activated, with the store paths it resolved from verified
// metadata at the time. Rollbacks use these records and therefore work without fresh TUF metadata.
type Activated struct {
	ReleaseID string               `json:"releaseId"`
	Digest    string               `json:"digest"`
	Host      string               `json:"host"`
	Runtime   activator.RuntimeSet `json:"runtime"`
	At        int64                `json:"at"`
	// Manager is the tuple's whombat-manager store path (TUF-verified): the known-good manager that
	// whombat-manager-recovery runs is taken from these records (M-3).
	Manager string `json:"manager,omitempty"`
	// Versions are the tuple's component versions, compared against new tuples (no downgrade, M-2).
	Versions *trust.Versions `json:"versions,omitempty"`
}

// State is the helper's own root-owned record (independent of the manager journal).
type State struct {
	V int64 `json:"v"`
	// DeviceID is the identity these records belong to; seed-factory for another identity (a factory
	// reset and re-provisioning) starts from fresh records (L-5).
	DeviceID         string `json:"deviceId,omitempty"`
	MaxAssignmentSeq int64  `json:"maxAssignmentSeq"`
	TimeFloor        int64  `json:"timeFloor"`
	Runtime          struct {
		Current          *Activated `json:"current,omitempty"`
		Previous         *Activated `json:"previous,omitempty"`
		LastRollbackFrom string     `json:"lastRollbackFrom,omitempty"`
	} `json:"runtime"`
	Host struct {
		Current  *Activated `json:"current,omitempty"`
		Previous *Activated `json:"previous,omitempty"`
		Pending  *Activated `json:"pending,omitempty"`
	} `json:"host"`
	Network struct {
		Pending   string `json:"pending,omitempty"`
		Committed string `json:"committed,omitempty"`
	} `json:"network"`
	// Wifi: the Wi-Fi change that can still be undone (NX-245); helpers before it ignore the field.
	Wifi struct {
		Pending *WifiChange `json:"pending,omitempty"`
	} `json:"wifi"`
	// Cable: the cable change that can still be undone, and the last one that ended; helpers before it
	// ignore the field.
	Cable struct {
		Pending *CableChange `json:"pending,omitempty"`
		Last    *CableEnded  `json:"last,omitempty"`
	} `json:"cable"`
	// Channel is where helpers of the first channel releases kept the box's channel: read when there is no
	// channelFile yet. A helper from before channels rewrites state.json without it, so the channel lives in a file of
	// its own (channelFile).
	Channel string `json:"channel,omitempty"`
}

// channelFile is the update channel the owner set on this box (LNK-21), in the helper's state directory beside
// state.json: no helper from before channels reads or writes it, so a rollback to one and forward again keeps it.
const channelFile = "channel.json"

type channelRecord struct {
	Channel string `json:"channel"`
}

// loadChannel is the channel recorded in channelFile ("" none or unreadable).
func loadChannel(dir string) string {
	b, err := os.ReadFile(filepath.Join(dir, channelFile))
	if err != nil {
		return ""
	}
	var r channelRecord
	if json.Unmarshal(b, &r) != nil {
		return ""
	}
	return r.Channel
}

func saveChannel(dir, channel string) error {
	b, _ := json.Marshal(channelRecord{Channel: channel})
	return atomicfile.WriteFile(filepath.Join(dir, channelFile), b, 0o600)
}

func loadState(dir string) (*State, error) {
	b, err := os.ReadFile(filepath.Join(dir, "state.json"))
	if os.IsNotExist(err) {
		return &State{V: 1}, nil
	}
	if err != nil {
		return nil, err
	}
	var s State
	if err := json.Unmarshal(b, &s); err != nil {
		return nil, fmt.Errorf("helper state corrupt: %w", err)
	}
	return &s, nil
}

func saveState(dir string, s *State) error {
	b, err := json.MarshalIndent(s, "", " ")
	if err != nil {
		return err
	}
	return atomicfile.WriteFile(filepath.Join(dir, "state.json"), b, 0o600)
}
