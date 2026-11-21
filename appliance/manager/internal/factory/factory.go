// Package factory finds the release a box was installed with at its first start (MG-20), in whichever update channel
// lists it (MG-182).
//
// The same installer goes to Beta first and, unchanged, to Production when it is promoted. A box installed from it
// before the promotion (every Beta installer, and a promotion slower than an install) finds its release only in the
// development channel, while the image's default channel is production. It used to look there only, fail, and try
// again for ever, so it never started. Now its own channel is asked first and then the other: a release only
// Development lists makes the box follow Development, the channel its installer came from.
package factory

import (
	"context"
	"errors"
	"fmt"

	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
)

// ErrNotListed: no channel the box can read lists the release (it was never published, or it was withdrawn).
var ErrNotListed = errors.New("no update channel lists this release")

// ErrUnreachable: the update repository couldn't be read (no network yet, the repository out of reach) or didn't
// verify.
var ErrUnreachable = errors.New("the update repository can't be read")

// Refresher is the manager's TUF client (tufclient.Client).
type Refresher interface {
	Refresh(ctx context.Context) (*trust.Repo, error)
	RefreshIn(ctx context.Context, channel string) (*trust.Repo, error)
}

// Finder looks for the box's factory release.
type Finder struct {
	TUF Refresher
	// Follow records the channel the box follows from now on (the update helper's set-channel). Called only when the
	// release is found in a channel other than the box's.
	Follow func(ctx context.Context, channel string) error
}

// Found is the release and the channel the box follows; Moved when that isn't the channel it had.
type Found struct {
	Release *trust.Release
	Channel string
	Moved   bool
}

// Find resolves the release id: in the box's channel (or its repository's top level without channels), else in each
// other channel in the order a person reads them. A release found elsewhere makes the box follow that channel, so its
// update helper verifies it there and its updates come from there. The box's own channel is looked at again after the
// move, so the manager's mirror ends with the view the box now reads.
func (f Finder) Find(ctx context.Context, id string) (*Found, error) {
	repo, err := f.TUF.Refresh(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnreachable, err)
	}
	rel, err := repo.Release(id)
	if err == nil {
		return &Found{Release: rel, Channel: repo.Channel}, nil
	}
	if !errors.Is(err, trust.ErrNotApproved) {
		return nil, err
	}
	if repo.Channel == "" {
		// A box without channels reads one list only.
		return nil, fmt.Errorf("%w: %s", ErrNotListed, id)
	}
	for _, ch := range trust.Channels {
		if ch == repo.Channel {
			continue
		}
		other, err := f.TUF.RefreshIn(ctx, ch)
		if err != nil {
			if errors.Is(err, trust.ErrChannelUnavailable) {
				continue
			}
			return nil, fmt.Errorf("%w: %v", ErrUnreachable, err)
		}
		if _, err := other.Release(id); err != nil {
			continue
		}
		if f.Follow == nil {
			return nil, fmt.Errorf("%s is listed in the %s channel only, and this box can't change its channel", id, ch)
		}
		if err := f.Follow(ctx, ch); err != nil {
			return nil, fmt.Errorf("follow the %s channel: %w", ch, err)
		}
		now, err := f.TUF.Refresh(ctx)
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrUnreachable, err)
		}
		if now.Channel != ch {
			return nil, fmt.Errorf("the box reads the %q channel after it was moved to %s", now.Channel, ch)
		}
		rel, err := now.Release(id)
		if err != nil {
			return nil, err
		}
		return &Found{Release: rel, Channel: ch, Moved: true}, nil
	}
	return nil, fmt.Errorf("%w: %s (looked in %v)", ErrNotListed, id, trust.Channels)
}
