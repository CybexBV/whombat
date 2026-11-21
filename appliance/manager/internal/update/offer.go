package update

import (
	"fmt"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
)

// VerifyParams are the manager-side expectations for an assignment.
type VerifyParams struct {
	DeviceID     string
	Env          string
	Now          time.Time
	LastSequence int64
	MaxClockSkew time.Duration
}

// VerifyOffer verifies a raw control assignment with the contract verifier against the
// TUF-published assignment keys, and for `install` requires that it names an approved, compatible
// tuple with the same digest. An assignment naming an unapproved tuple is refused here (and again
// by the helper at activation).
func VerifyOffer(repo *trust.Repo, raw []byte, p VerifyParams) (*Offered, error) {
	ks, err := repo.AssignmentKeys(p.Env, p.Now)
	if err != nil {
		return nil, err
	}
	sa, err := trust.VerifyAssignment(raw, ks, trust.VerifyParams{DeviceID: p.DeviceID, Env: p.Env, Now: p.Now,
		LastSequence: p.LastSequence, MaxClockSkew: p.MaxClockSkew})
	if err != nil {
		return nil, err
	}
	if sa.Payload.Action == "hold" {
		return &Offered{Raw: raw, Payload: &sa.Payload}, nil
	}
	rel, err := repo.Release(*sa.Payload.ReleaseID)
	if err != nil {
		return nil, fmt.Errorf("assignment %d names %s: %w", sa.Payload.Sequence, *sa.Payload.ReleaseID, err)
	}
	if err := trust.CheckAgainst(&sa.Payload, rel); err != nil {
		return nil, err
	}
	return &Offered{Raw: raw, Payload: &sa.Payload, Release: rel}, nil
}
