package ops

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/CybexBV/whombat/appliance/helper/pkg/proto"
	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
)

// channels gives the repository both channel roles and makes w's helper a box with update channels (LNK-21).
func (w *world) channels(def string) {
	w.t.Helper()
	must(w.t, w.repo.AddChannelRoles(nil, nil))
	w.h.cfg.DefaultChannel = def
}

func (w *world) addIn(channel string, f devtuf.FakeRelease) {
	w.t.Helper()
	must(w.t, w.repo.InChannel(channel))
	defer w.repo.InChannel("")
	must(w.t, w.add(f))
	must(w.t, w.repo.Publish())
}

func (w *world) promote(id string) {
	w.t.Helper()
	if _, err := w.repo.Promote(id, trust.ChannelDevelopment, trust.ChannelProduction, nil); err != nil {
		w.t.Fatal(err)
	}
}

func (w *world) setChannel(c string) *proto.Error {
	_, perr, _ := w.h.Handle(context.Background(), proto.Request{V: 1, Op: proto.OpSetChannel, Channel: c})
	return perr
}

func (w *world) readChannel() string {
	w.t.Helper()
	res, perr, _ := w.h.Handle(context.Background(), proto.Request{V: 1, Op: proto.OpChannel})
	if perr != nil {
		w.t.Fatal(perr)
	}
	return res.Channel
}

// activateIn stages and activates a runtime release as read through the channel.
func (w *world) activateIn(channel, id string) *proto.Error {
	w.t.Helper()
	w.channel = channel
	defer func() { w.channel = "" }()
	w.stageFiles(id)
	if _, perr := w.do(proto.OpStageRuntime, id); perr != nil {
		return perr
	}
	_, perr := w.do(proto.OpActivateRuntime, id)
	return perr
}

// A box with channels (LNK-20…LNK-23): it activates only the newest release of its own channel, without any
// assignment; the owner's channel change moves it to the other channel's releases but never back.
func TestChannelActivatesTheNewestOfItsChannel(t *testing.T) {
	t.Parallel()
	w := newWorld(t)
	w.channels(trust.ChannelProduction)
	w.addIn(trust.ChannelDevelopment, devtuf.StandardRelease("whombat-dev-20261118.1", "26.05.1", "2.0.0"))
	w.addIn(trust.ChannelDevelopment, devtuf.StandardRelease("whombat-dev-20261118.2", "26.05.1", "2.1.0"))
	if got := w.readChannel(); got != trust.ChannelProduction {
		t.Fatalf("default channel %q", got)
	}
	// Production lists nothing: a development release is not this box's, nor is a top-level one (assignment or not).
	if perr := w.activateIn(trust.ChannelDevelopment, "whombat-dev-20261118.2"); perr == nil {
		t.Fatal("a production box activated a development release")
	}
	w.assign("rt-3")
	if perr := w.activateIn("", "rt-3"); perr == nil {
		t.Fatal("a box with channels activated a top-level release by assignment")
	}
	// The owner moves it to development: the newest there, and only it.
	if perr := w.setChannel(trust.ChannelDevelopment); perr != nil {
		t.Fatal(perr)
	}
	if got := w.readChannel(); got != trust.ChannelDevelopment {
		t.Fatalf("channel %q", got)
	}
	if perr := w.activateIn(trust.ChannelDevelopment, "whombat-dev-20261118.1"); code(perr) != proto.CodeNotAssigned {
		t.Fatalf("not the newest of development: %v", perr)
	}
	if perr := w.activateIn(trust.ChannelDevelopment, "whombat-dev-20261118.2"); perr != nil {
		t.Fatal(perr)
	}
	// Back to production, which has only the older .1: the box stays (LNK-21) …
	w.promote("whombat-dev-20261118.1")
	if perr := w.setChannel(trust.ChannelProduction); perr != nil {
		t.Fatal(perr)
	}
	if perr := w.activateIn(trust.ChannelProduction, "whombat-dev-20261118.1"); perr == nil {
		t.Fatal("moving to production went back to an older release")
	}
	// … until production passes it.
	w.addIn(trust.ChannelDevelopment, devtuf.StandardRelease("whombat-dev-20261119.1", "26.05.1", "2.2.0"))
	w.promote("whombat-dev-20261119.1")
	if perr := w.activateIn(trust.ChannelProduction, "whombat-dev-20261119.1"); perr != nil {
		t.Fatal(perr)
	}
	// The same channel again is no change.
	res, perr, _ := w.h.Handle(context.Background(), proto.Request{V: 1, Op: proto.OpSetChannel, Channel: trust.ChannelProduction})
	if perr != nil || !res.AlreadyDone {
		t.Fatalf("again: %+v %v", res, perr)
	}
}

// Without channels in the image the operation is refused and the channel reads empty; the request is strict.
func TestSetChannelRules(t *testing.T) {
	t.Parallel()
	w := newWorld(t)
	if got := w.readChannel(); got != "" {
		t.Fatalf("a box without channels reads %q", got)
	}
	if perr := w.setChannel(trust.ChannelDevelopment); code(perr) != proto.CodeBadRequest {
		t.Fatalf("set-channel without channels: %v", perr)
	}
	for _, req := range []proto.Request{
		{V: 1, Op: proto.OpSetChannel},
		{V: 1, Op: proto.OpSetChannel, Channel: "beta"},
		{V: 1, Op: proto.OpSetChannel, Channel: trust.ChannelProduction, ReleaseID: "rt-1"},
		{V: 1, Op: proto.OpChannel, Channel: trust.ChannelProduction},
		{V: 1, Op: proto.OpStageRuntime, ReleaseID: "rt-1", Channel: trust.ChannelProduction},
	} {
		if err := req.Validate(); err == nil {
			t.Errorf("accepted %v", req)
		}
	}
	if err := w.h.SetChannel("beta"); err == nil {
		t.Fatal("SetChannel accepted an unknown channel")
	}
	w.h.cfg.DefaultChannel = trust.ChannelProduction
	if err := w.h.SetChannel(trust.ChannelDevelopment); err != nil {
		t.Fatal(err)
	}
	if got := w.readChannel(); got != trust.ChannelDevelopment {
		t.Fatalf("after SetChannel: %q", got)
	}
}

// The one image's channel bridge (ONE-03): --if-unset records a channel only on a box that has none, so a box that
// followed its image's default (Home on development) keeps it, and an owner's choice is never overwritten.
func TestSetChannelIfUnset(t *testing.T) {
	t.Parallel()
	w := newWorld(t)
	if _, err := w.h.SetChannelIfUnset(trust.ChannelDevelopment); err == nil {
		t.Fatal("a box without channels recorded a channel")
	}
	w.h.cfg.DefaultChannel = trust.ChannelProduction
	if _, err := w.h.SetChannelIfUnset("beta"); err == nil {
		t.Fatal("accepted an unknown channel")
	}
	wrote, err := w.h.SetChannelIfUnset(trust.ChannelDevelopment)
	if err != nil || !wrote {
		t.Fatalf("first bridge: wrote %v, %v", wrote, err)
	}
	if got := w.readChannel(); got != trust.ChannelDevelopment {
		t.Fatalf("after the bridge: %q", got)
	}
	// At every later start: nothing to do, and never over the owner's choice.
	if wrote, err := w.h.SetChannelIfUnset(trust.ChannelDevelopment); err != nil || wrote {
		t.Fatalf("again: wrote %v, %v", wrote, err)
	}
	if err := w.h.SetChannel(trust.ChannelProduction); err != nil {
		t.Fatal(err)
	}
	if wrote, err := w.h.SetChannelIfUnset(trust.ChannelDevelopment); err != nil || wrote {
		t.Fatalf("over the owner's choice: wrote %v, %v", wrote, err)
	}
	if got := w.readChannel(); got != trust.ChannelProduction {
		t.Fatalf("the owner's choice became %q", got)
	}
}

// The owner's channel survives a helper from before channels (LNK-21): rolled back to one, it reads state.json into
// its own struct and writes it back without `channel`; forward again, the box is still on the owner's channel, not
// the image's default. A channel recorded in state.json by the first channel helpers is still read.
func TestChannelSurvivesAnOlderHelper(t *testing.T) {
	t.Parallel()
	w := newWorld(t)
	w.channels(trust.ChannelDevelopment)
	if perr := w.setChannel(trust.ChannelProduction); perr != nil {
		t.Fatal(perr)
	}
	// The older helper's write: every field it knows, no channel.
	p := filepath.Join(w.cfg.StateDir, "state.json")
	b, err := os.ReadFile(p)
	must(t, err)
	var m map[string]json.RawMessage
	must(t, json.Unmarshal(b, &m))
	delete(m, "channel")
	b, _ = json.Marshal(m)
	must(t, os.WriteFile(p, b, 0o600))
	if got := w.readChannel(); got != trust.ChannelProduction {
		t.Fatalf("after an older helper's write: %q", got)
	}
	// state.json's channel from the first channel helpers, without the file.
	must(t, os.Remove(filepath.Join(w.cfg.StateDir, channelFile)))
	m["channel"] = json.RawMessage(`"production"`)
	b, _ = json.Marshal(m)
	must(t, os.WriteFile(p, b, 0o600))
	if got := w.readChannel(); got != trust.ChannelProduction {
		t.Fatalf("from state.json: %q", got)
	}
}

func TestPausedChannelBlocksNewActivationAllowsRollbackAndResume(t *testing.T) {
	t.Parallel()
	w := newWorld(t)
	w.channels(trust.ChannelProduction)
	w.addIn(trust.ChannelDevelopment, devtuf.StandardRelease("whombat-20261121.1", "26.05.1", "2.0.0"))
	w.addIn(trust.ChannelDevelopment, devtuf.StandardRelease("whombat-20261121.2", "26.05.1", "2.1.0"))
	w.addIn(trust.ChannelDevelopment, devtuf.StandardRelease("whombat-20261121.3", "26.05.1", "2.2.0"))
	w.promote("whombat-20261121.1")
	if perr := w.activateIn(trust.ChannelProduction, "whombat-20261121.1"); perr != nil {
		t.Fatal(perr)
	}
	// Promote .2 and activate it so .1 is the previous runtime for rollback.
	w.promote("whombat-20261121.2")
	if perr := w.activateIn(trust.ChannelProduction, "whombat-20261121.2"); perr != nil {
		t.Fatal(perr)
	}
	// Promote .3, then pause production: .3 must be refused, re-activating installed .2 still works, and rolling back
	// from .2 to .1 still works because listed releases remain intact.
	w.promote("whombat-20261121.3")
	if _, err := w.repo.PauseChannel(trust.ChannelProduction, nil); err != nil {
		t.Fatal(err)
	}
	if perr := w.activateIn(trust.ChannelProduction, "whombat-20261121.3"); code(perr) != proto.CodeNotAssigned {
		t.Fatalf("paused channel activated newer release: %v", perr)
	}
	if perr := w.activateIn(trust.ChannelProduction, "whombat-20261121.2"); perr != nil {
		t.Fatalf("re-activating installed release while paused failed: %v", perr)
	}
	if res, perr := w.do(proto.OpRollbackRuntime, "whombat-20261121.2"); perr != nil || res.ReleaseID != "whombat-20261121.1" {
		t.Fatalf("rollback while paused failed: %+v %v", res, perr)
	}
	// After rollback to .1, production is still paused so .3 is still refused (and no downgrade occurs).
	if perr := w.activateIn(trust.ChannelProduction, "whombat-20261121.3"); code(perr) != proto.CodeNotAssigned {
		t.Fatalf("paused channel activated .3 after rollback: %v", perr)
	}
	// Resuming production allows activating .3.
	if _, err := w.repo.ResumeChannel(trust.ChannelProduction, nil); err != nil {
		t.Fatal(err)
	}
	if perr := w.activateIn(trust.ChannelProduction, "whombat-20261121.3"); perr != nil {
		t.Fatalf("activation after resume failed: %v", perr)
	}
}
