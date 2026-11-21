package updatechannel

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/proto"
	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
)

type fakeHelper struct {
	channel  string
	channels bool
	asked    int
}

func (f *fakeHelper) Do(_ context.Context, req proto.Request) (*proto.Result, error) {
	if err := req.Validate(); err != nil {
		return nil, &proto.Error{Code: proto.CodeBadRequest, Message: err.Error()}
	}
	f.asked++
	switch req.Op {
	case proto.OpChannel:
		return &proto.Result{Channel: f.channel}, nil
	case proto.OpSetChannel:
		if !f.channels {
			return nil, &proto.Error{Code: proto.CodeBadRequest, Message: "this box's image has no update channels"}
		}
		done := f.channel == req.Channel
		f.channel = req.Channel
		return &proto.Result{Channel: req.Channel, AlreadyDone: done}, nil
	}
	return nil, &proto.Error{Code: proto.CodeBadRequest, Message: "unexpected"}
}

type helperFunc func(proto.Request) (*proto.Result, error)

func (f helperFunc) Do(_ context.Context, req proto.Request) (*proto.Result, error) { return f(req) }

func TestServiceReadsAndChangesTheHelpersChannel(t *testing.T) {
	ctx := context.Background()
	h := &fakeHelper{channel: trust.ChannelProduction, channels: true}
	changed := 0
	s := &Service{Helper: h, Changed: func() { changed++ }}
	if got := s.Current(); got != trust.ChannelProduction {
		t.Fatalf("current %q", got)
	}
	s.Current()
	if h.asked != 1 {
		t.Fatalf("asked the helper %d times", h.asked)
	}
	if _, err := s.Set(ctx, "beta"); err == nil {
		t.Fatal("an unknown channel was set")
	}
	if got, err := s.Set(ctx, trust.ChannelDevelopment); err != nil || got != trust.ChannelDevelopment || changed != 1 {
		t.Fatalf("set: %q %v changed %d", got, err, changed)
	}
	if s.Current() != trust.ChannelDevelopment || h.channel != trust.ChannelDevelopment {
		t.Fatal("not recorded")
	}
	if _, err := s.Set(ctx, trust.ChannelDevelopment); err != nil || changed != 1 {
		t.Fatalf("again: %v changed %d", err, changed)
	}
	// A helper before channels answers bad_request to the unknown operation: no channels, asked once.
	old := &fakeHelper{}
	oldHelper := &Service{Helper: helperFunc(func(req proto.Request) (*proto.Result, error) {
		old.asked++
		return nil, &proto.Error{Code: proto.CodeBadRequest, Message: "unknown operation"}
	})}
	if oldHelper.Current() != "" || oldHelper.Current() != "" || old.asked != 1 {
		t.Fatalf("an old helper was asked %d times", old.asked)
	}
	none := &Service{Helper: &fakeHelper{}}
	if got := none.Current(); got != "" {
		t.Fatalf("a box without channels: %q", got)
	}
	if _, err := none.Set(ctx, trust.ChannelDevelopment); !errors.Is(err, ErrNoChannels) {
		t.Fatalf("no channels: %v", err)
	}
	if _, err := none.Response(ctx); !errors.Is(err, ErrNoChannels) {
		t.Fatalf("no channels: %v", err)
	}
}

// The Updates page says when a box moved to production waits for production to pass its release (LNK-21).
func TestStatusWaitsForTheChannel(t *testing.T) {
	now := time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)
	r, err := devtuf.New(filepath.Join(t.TempDir(), "repo"), devtuf.Options{Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	if err := r.AddChannelRoles(nil, nil); err != nil {
		t.Fatal(err)
	}
	r.InChannel(trust.ChannelDevelopment)
	for _, f := range []devtuf.FakeRelease{devtuf.StandardRelease("whombat-dev-20261118.1", "26.05.1", "1.0.0"),
		devtuf.StandardRelease("whombat-dev-20261118.2", "26.05.1", "1.1.0")} {
		if _, err := r.AddFakeRelease(f); err != nil {
			t.Fatal(err)
		}
		if err := r.Publish(); err != nil {
			t.Fatal(err)
		}
	}
	r.InChannel("")
	if _, err := r.Promote("whombat-dev-20261118.1", trust.ChannelDevelopment, trust.ChannelProduction, nil); err != nil {
		t.Fatal(err)
	}
	view := func(ch string) *trust.Repo {
		repo, err := trust.Refresh(trust.Config{PinnedRoot: r.InitialRoot(), MetadataDir: t.TempDir(), MetadataURL: "m://x",
			Fetcher: trust.DirFetcher{BaseURL: "m://x", Dir: r.MetadataDir()}, Now: now, Channel: ch})
		if err != nil {
			t.Fatal(err)
		}
		return repo
	}
	dev := view(trust.ChannelDevelopment)
	two, _ := dev.Release("whombat-dev-20261118.2")
	v := two.VersionsOf()
	if st := StatusOf(view(trust.ChannelProduction), two.ID(), &v); !st.Waiting || st.Newest != "whombat-dev-20261118.1" {
		t.Fatalf("production status %+v", st)
	}
	if st := StatusOf(dev, two.ID(), &v); st.Waiting || st.Newest != two.ID() {
		t.Fatalf("development status %+v", st)
	}
	// The route's answer names the release the box stays on.
	prodView := view(trust.ChannelProduction)
	svc := &Service{Helper: &fakeHelper{channel: trust.ChannelProduction, channels: true},
		View: func() *trust.Repo { return prodView }, Installed: func() (string, *trust.Versions) { return two.ID(), &v }}
	res, err := svc.Response(context.Background())
	if err != nil || res.StaysOn == nil || *res.StaysOn != two.ID() || string(res.Channel) != trust.ChannelProduction {
		t.Fatalf("response %+v %v", res, err)
	}
	// Pausing production keeps staysOn accurate: a box on production's own release does not look ahead of it,
	// while a box ahead on development still shows staysOn.
	if _, err := r.PauseChannel(trust.ChannelProduction, nil); err != nil {
		t.Fatal(err)
	}
	pausedProd := view(trust.ChannelProduction)
	if !pausedProd.ChannelPaused {
		t.Fatal("expected paused production view")
	}
	one, _ := pausedProd.Release("whombat-dev-20261118.1")
	v1 := one.VersionsOf()
	if st := StatusOf(pausedProd, one.ID(), &v1); st.Waiting || st.Newest != one.ID() {
		t.Fatalf("paused production on current release: %+v", st)
	}
	if st := StatusOf(pausedProd, two.ID(), &v); !st.Waiting || st.Newest != one.ID() {
		t.Fatalf("paused production behind development release: %+v", st)
	}
}
