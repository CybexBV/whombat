// Package licence is the manager's side of the signed appliance licence (LC-06, MG-34): the key set pinned in the
// image, the token it holds and the time high-water mark, kept together in one 0600 file that is replaced
// atomically. The daemon renews (daemon/licence.go); this package only decides what to accept and keeps it.
//
// highWater = max(every accepted token's iat, control's `now` from every successful renewal) and never goes down,
// so rolling the clock back never gets earlier than the last time control or a signed token vouched for.
package licence

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// ErrStale: the offered token's iat is older than the one held (kept out, LC-06).
var ErrStale = errors.New("licence token is older than the one held (stale)")

// LoadKeys reads the pinned key set (protocol.ParseLicenceKeySet: strict schema, 1…8 Ed25519 keys).
func LoadKeys(path string) (*protocol.LicenceKeySet, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("licence keys: %w", err)
	}
	ks, err := protocol.ParseLicenceKeySet(b)
	if err != nil {
		return nil, fmt.Errorf("licence keys %s: %w", path, err)
	}
	return ks, nil
}

// Held is what the manager holds: the last accepted token (with its verified claims) and the high-water mark
// (epoch seconds). A zero Held holds nothing.
type Held struct {
	Token     string
	Claims    *protocol.LicenceClaims
	HighWater int64
	// RenewAt is when the next renewal is due (epoch seconds, the manager's clock; 0: at once). Kept so a manager
	// restart doesn't spend one of control's 12 renewals an hour (MG-38).
	RenewAt int64
}

// HighWaterTime is the mark as a time (zero when there is none).
func (h Held) HighWaterTime() time.Time {
	if h.HighWater <= 0 {
		return time.Time{}
	}
	return time.Unix(h.HighWater, 0).UTC()
}

// file is the on-disk form ({v, token, highWater}; highWater RFC 3339 like the admin socket's).
type file struct {
	V         int     `json:"v"`
	Token     *string `json:"token"`
	HighWater string  `json:"highWater"`
	RenewAt   int64   `json:"renewAt,omitempty"`
}

// Verifier checks tokens against the pinned key set for one device.
type Verifier struct {
	Keys   *protocol.LicenceKeySet
	Device string
}

// Verify is protocol.VerifyLicenceToken with the pinned set, this device and the effective time `now`.
func (v Verifier) Verify(token string, now int64) (*protocol.LicenceClaims, error) {
	_, c, err := protocol.VerifyLicenceToken(token, protocol.VerifyLicenceOptions{KeySet: *v.Keys, Device: v.Device, Now: now})
	return c, err
}

// Load reads the state file. A missing file holds nothing. A stored token that no longer verifies (another key set
// after an update, another device's file) is dropped and reported in dropped; the high-water mark is kept either way.
func (v Verifier) Load(path string, localNow int64) (h Held, dropped error, err error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return Held{}, nil, nil
	}
	if err != nil {
		return Held{}, nil, err
	}
	var f file
	if err := json.Unmarshal(b, &f); err != nil || f.V != 1 {
		return Held{}, nil, fmt.Errorf("licence state %s: unreadable (%v)", path, err)
	}
	if f.HighWater != "" {
		t, err := time.Parse(time.RFC3339, f.HighWater)
		if err != nil {
			return Held{}, nil, fmt.Errorf("licence state %s: highWater: %w", path, err)
		}
		h.HighWater = t.Unix()
	}
	h.RenewAt = f.RenewAt
	if f.Token != nil && *f.Token != "" {
		c, err := v.Verify(*f.Token, max(localNow, h.HighWater))
		if err != nil {
			h.RenewAt = 0
			return h, err, nil
		}
		h.Token, h.Claims = *f.Token, c
		h.HighWater = max(h.HighWater, c.Iat)
	}
	return h, nil, nil
}

// Save writes the state atomically (temporary file, fsync, rename, directory fsync), mode 0600.
func Save(path string, h Held) error {
	f := file{V: 1, HighWater: h.HighWaterTime().Format(time.RFC3339), RenewAt: h.RenewAt}
	if h.HighWater <= 0 {
		f.HighWater = ""
	}
	if h.Token != "" {
		t := h.Token
		f.Token = &t
	}
	b, err := json.Marshal(f)
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".licence-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(append(b, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return err
	}
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		d.Close()
	}
	return nil
}

// Accept decides about a token control just issued (licence.renew → {token, now}). It verifies the token at the
// effective time max(local clock, highWater, control's now), refuses a token whose iat is older than the held one's
// (ErrStale), and raises the high-water mark to max(highWater, iat, control's now). On any error the held state is
// returned unchanged. changed says whether anything to keep or push changed.
func (v Verifier) Accept(held Held, token string, controlNow, localNow int64) (next Held, changed bool, err error) {
	c, err := v.Verify(token, max(localNow, held.HighWater, controlNow))
	if err != nil {
		return held, false, err
	}
	if held.Claims != nil && c.Iat < held.Claims.Iat {
		return held, false, ErrStale
	}
	next = Held{Token: token, Claims: c, HighWater: max(held.HighWater, c.Iat, controlNow), RenewAt: held.RenewAt}
	return next, next.Token != held.Token || next.HighWater != held.HighWater, nil
}

// Status is protocol.LicenceStatus for what is held (the manager's log line; the runtime decides enforcement).
func (h Held) Status(localNow int64, claimedAt *int64) *protocol.LicenceStatusResult {
	return protocol.LicenceStatus(protocol.LicenceStatusParams{Claims: h.Claims, Now: localNow, HighWater: h.HighWater, ClaimedAt: claimedAt})
}
