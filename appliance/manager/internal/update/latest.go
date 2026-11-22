package update

import (
	"context"
	"fmt"

	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/contracts/go/release"
)

// LatestOffer is a community box's assignment (Whombat HE-58, MG-136): no control signs one, so the offer is the newest
// release of the verified repository over the installed one (trust.NewestRelease, the same answer the update helper
// requires at activation), unsigned (Raw empty: no assignment file is written) and numbered with OfferSequence, which
// only grows (TUF refuses an older one), so the same repository state is offered once and a new publication is a new
// offer. Nil, nil: nothing newer. Hold, rollouts and not-before don't exist without control.
func LatestOffer(repo *trust.Repo, st *State, deviceID, env string) (*Offered, error) {
	if repo.ChannelPaused {
		return nil, nil
	}
	var curID, curDigest string
	var cur *trust.Versions
	if c := st.Current; c != nil {
		curID, curDigest = c.ReleaseID, c.Digest
		if r := c.Release; r != nil {
			cur = &trust.Versions{Host: r.Host.Version, Runtime: r.Runtime.Version, Manager: r.Manager.Version}
		}
	}
	rel, err := repo.NewestRelease(curID, cur, curDigest)
	if err != nil || rel == nil {
		return nil, err
	}
	id, digest := rel.Tuple.ReleaseID, rel.Digest
	return &Offered{Release: rel, Payload: &release.AssignmentPayload{Purpose: release.AssignmentPurpose,
		Env: release.Environment(env), Device: deviceID, Sequence: OfferSequence(repo), Action: "install",
		ReleaseID: &id, TupleDigest: &digest}}, nil
}

// OfferSequence numbers an offer of the newest release: the targets version, which grows with every publication of
// the box's repository; with a channel (LNK-23) the snapshot version, because a release published into a channel role
// changes that role and the snapshot but not the top-level targets. The snapshot is also re-signed every few hours
// without any change: OfferLatest offers a channel's release once (State.LastOffer), and the first offer after a
// channel change gets the next sequence even when the snapshot is still the same one.
func OfferSequence(repo *trust.Repo) int64 {
	if repo.Channel != "" {
		return repo.SnapshotVersion
	}
	return repo.TargetsVersion
}

// OfferLatest offers LatestOffer to the engine: the community edition's poll (MG-136). Without anything newer it
// decides nothing (DecisionNoop, offered nil).
func (e *Engine) OfferLatest(ctx context.Context, repo *trust.Repo, deviceID, env string) (dec Decision, why string, offered *Offered, err error) {
	return e.offerLatest(ctx, repo, deviceID, env, false)
}

// OfferLatestNow is the owner's “Check for updates”: OfferLatest, but a channel's release offered before is offered
// again (a release that failed here for a passing reason, or was rolled back, is tried again when the owner asks:
// on a channel nobody else assigns it). A quarantined release stays refused (Engine.offer).
func (e *Engine) OfferLatestNow(ctx context.Context, repo *trust.Repo, deviceID, env string) (dec Decision, why string, offered *Offered, err error) {
	return e.offerLatest(ctx, repo, deviceID, env, true)
}

func (e *Engine) offerLatest(ctx context.Context, repo *trust.Repo, deviceID, env string, again bool) (dec Decision, why string, offered *Offered, err error) {
	if repo == nil {
		return DecisionNoop, "no metadata", nil, nil
	}
	st, err := e.Load()
	if err != nil {
		return "", "", nil, err
	}
	if repo.Channel != "" {
		if ok, reason := e.channelRepoFresh(st, repo.Channel, repo.ChannelVersion); !ok {
			return DecisionNoop, reason, nil, nil
		}
	}
	if repo.ChannelPaused {
		return DecisionNoop, "channel paused", nil, nil
	}
	o, err := LatestOffer(repo, st, deviceID, env)
	if err != nil {
		return "", "", nil, fmt.Errorf("newest release: %w", err)
	}
	if o == nil {
		if _, err := e.RetireWithdrawn(ctx, repo, ""); err != nil {
			return "", "", nil, err
		}
		return DecisionNoop, "nothing newer", nil, nil
	}
	if repo.Channel != "" {
		o.Channel = repo.Channel
		o.ChannelVersion = repo.ChannelVersion
		if st.LastOffer == offerKey(repo.Channel, o.Release.Digest) && !again && !retryableRepair(st, o.Release.Digest) {
			// Offered before: a re-signed snapshot is no new offer, so a release refused or rolled back here, or one
			// waiting for the owner, isn't taken up again four times a day. Still retire any older withdrawn candidate.
			if _, err := e.RetireWithdrawn(ctx, repo, o.Release.Digest); err != nil {
				return "", "", nil, err
			}
			return DecisionNoop, "already processed", o, nil
		}
		// Another release or another channel: a new offer, also within the snapshot an earlier offer came from (a
		// channel change reads the same snapshot). It replaces a candidate that hasn't started activating.
		o.Payload.Sequence = max(o.Payload.Sequence, st.LastAssignmentSeq+1)
	}
	dec, why, err = e.Offer(ctx, *o)
	if err != nil {
		return dec, why, o, err
	}
	if dec == DecisionNoop && (why == "stale channel metadata" || why == "wrong channel") {
		return dec, why, nil, nil
	}
	if dec == DecisionRefused || (dec == DecisionNoop && why != "assignment renewed") {
		if _, err := e.RetireWithdrawn(ctx, repo, o.Release.Digest); err != nil {
			return "", "", nil, err
		}
	}
	return dec, why, o, nil
}

// offerKey is State.LastOffer of a channel's release.
func offerKey(channel, digest string) string { return channel + " " + digest }

// retryableRepair reports a forward repair of this release whose cause says the box couldn't finish right now
// (release.IsRetryableUpdateFailure): offering the release again is what finishes the update (Engine.forwardRepair), and
// on a channel nobody else assigns it, so the once-per-release rule doesn't hold it back.
func retryableRepair(st *State, digest string) bool {
	c := st.Candidate
	if st.Phase != ForwardRepairRequired || c == nil || c.Tuple == nil || c.Tuple.Digest != digest || c.Failure == nil {
		return false
	}
	f := c.Failure
	return len(f.Reasons) > 0 && release.IsRetryableUpdateFailure(f.Reasons[0])
}
