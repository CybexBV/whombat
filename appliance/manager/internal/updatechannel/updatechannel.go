// Package updatechannel is the manager's side of the box's update channel (Whombat LNK-20, LNK-21, LNK-42): the
// update helper keeps the channel (root-owned) and enforces it; the manager reads it for its TUF refresh, changes it
// for the owner, and says on the Updates page when the box stays on a release its channel hasn't passed yet.
//
// The change comes over the manager socket (contracts 4.4.0 `updateChannelSet`, the runtime's only, as Ask before
// updating's switch): the runtime has checked the owner's signed session op `updates.channel.set` and records the
// appliance event `update.channel_set`. The helper never trusts the choice beyond "which channel": it still activates
// only that channel's newest release, forward only.
package updatechannel

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/proto"
	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/release"
)

// Helper is the update helper (helperclient.Client).
type Helper interface {
	Do(ctx context.Context, req proto.Request) (*proto.Result, error)
}

// ErrNoChannels: the box's image has no update channels (an image before them; the edition decides). The route
// answers local.LinkErrorUpdateChannelUnavailable.
var ErrNoChannels = errors.New("this box has no update channels")

// Service reads and changes the channel.
type Service struct {
	Helper Helper
	// Changed runs after the helper recorded another channel: the daemon refreshes TUF and offers the newest release
	// of the new channel.
	Changed func()
	// View returns the latest verified TUF view (tufclient.Client.Latest) and Installed the installed release (the
	// update engine's state), for staysOn. Either nil: no staysOn.
	View      func() *trust.Repo
	Installed func() (id string, v *trust.Versions)
	// AskTimeout bounds a lazy read from the helper (default 5 s).
	AskTimeout time.Duration

	mu      sync.Mutex
	current string
	known   bool
}

// Load asks the helper for the channel and remembers it.
func (s *Service) Load(ctx context.Context) (string, error) {
	res, err := s.Helper.Do(ctx, proto.Request{V: proto.Version, Op: proto.OpChannel})
	var pe *proto.Error
	if errors.As(err, &pe) && pe.Code == proto.CodeBadRequest {
		// A helper before channels doesn't know the operation: no channels, for good (it changes only with a release,
		// which restarts the manager).
		res, err = &proto.Result{}, nil
	}
	if err != nil {
		return "", err
	}
	if res.Channel != "" && !trust.ValidChannel(res.Channel) {
		return "", fmt.Errorf("the helper answered the unknown channel %q", res.Channel)
	}
	s.mu.Lock()
	s.current, s.known = res.Channel, true
	s.mu.Unlock()
	return res.Channel, nil
}

// Current is the channel for a TUF refresh: the remembered one, else the helper's (asked once; "" while it can't
// answer, so a refresh then reads the top-level targets and the helper's own check still decides).
func (s *Service) Current() string {
	s.mu.Lock()
	cur, known := s.current, s.known
	s.mu.Unlock()
	if known {
		return cur
	}
	t := s.AskTimeout
	if t == 0 {
		t = 5 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), t)
	defer cancel()
	c, err := s.Load(ctx)
	if err != nil {
		return ""
	}
	return c
}

// Set has the helper record the channel (the runtime checked that the owner asked for it).
func (s *Service) Set(ctx context.Context, channel string) (string, error) {
	if !trust.ValidChannel(channel) {
		return "", fmt.Errorf("unknown channel %q", channel)
	}
	res, err := s.Helper.Do(ctx, proto.Request{V: proto.Version, Op: proto.OpSetChannel, Channel: channel})
	if err != nil {
		var pe *proto.Error
		if errors.As(err, &pe) && pe.Code == proto.CodeBadRequest {
			return "", errors.Join(ErrNoChannels, err)
		}
		return "", err
	}
	s.mu.Lock()
	s.current, s.known = res.Channel, true
	s.mu.Unlock()
	if !res.AlreadyDone && s.Changed != nil {
		s.Changed()
	}
	return res.Channel, nil
}

// Response is the route's answer for the channel: staysOn names the installed release when the channel's newest
// doesn't pass it (LNK-21), as far as the latest verified view (of this channel) tells.
func (s *Service) Response(ctx context.Context) (*local.UpdateChannelResponse, error) {
	ch, err := s.Load(ctx)
	if err != nil {
		return nil, err
	}
	if ch == "" {
		return nil, ErrNoChannels
	}
	out := &local.UpdateChannelResponse{V: 1, Channel: release.UpdateChannel(ch)}
	if s.View == nil || s.Installed == nil {
		return out, nil
	}
	repo := s.View()
	if repo == nil || repo.Channel != ch {
		return out, nil
	}
	id, v := s.Installed()
	if st := StatusOf(repo, id, v); st.Waiting && id != "" {
		out.StaysOn = &id
	}
	return out, nil
}

// Status is what Settings → This Whombat → Updates says about the channel (LNK-42).
type Status struct {
	Channel string `json:"channel"`
	// Newest is the newest release the channel lists ("" none).
	Newest string `json:"newest,omitempty"`
	// Waiting: the box runs a release the channel's newest doesn't pass yet (it came from the other channel); it
	// stays on it until the channel has a newer one (LNK-21: Development → Production never downgrades).
	Waiting bool `json:"waiting,omitempty"`
}

// StatusOf reads a channel's view (a Repo refreshed with that channel) against the installed release.
func StatusOf(repo *trust.Repo, installedID string, installed *trust.Versions) Status {
	st := Status{Channel: repo.Channel}
	newest, err := repo.NewestRelease("", nil, "")
	if err != nil || newest == nil {
		st.Waiting = installed != nil
		return st
	}
	st.Newest = newest.ID()
	if installed != nil && newest.ID() != installedID && trust.CheckForward(installedID, *installed, newest) != nil {
		st.Waiting = true
	}
	return st
}
