package agent

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"

	"rackoon/internal/proto"
)

// fakeScreen answers screen steps and counts them.
type fakeScreen struct{ calls atomic.Int32 }

func (f *fakeScreen) Screen(ctx context.Context, req proto.ScreenRequest) proto.ScreenResponse {
	f.calls.Add(1)
	return proto.ScreenResponse{OK: true, ScreenW: 1920, ScreenH: 1080}
}

func TestScreenPolicy(t *testing.T) {
	h := newFakeHub(t)
	cfg := enrollAgent(t, h)
	scr := &fakeScreen{}
	tr := startRuntime(t, cfg, func(rt *Runtime) { rt.Screen = scr })
	side := h.waitSide(t)
	step := func(op string) proto.ScreenResponse {
		return rpc[proto.ScreenRequest, proto.ScreenResponse](t, side, proto.StreamScreen,
			proto.ScreenRequest{Op: op, Account: &proto.ScreenAccount{User: "alex", Password: "secret"}})
	}
	thumb := func() proto.ThumbnailResponse {
		return rpc[proto.ThumbnailRequest, proto.ThumbnailResponse](t, side, proto.StreamThumbnail,
			proto.ThumbnailRequest{Platform: proto.PlatformHost, GuestID: "host", MaxWidth: 320})
	}
	vnc := func() proto.ConsoleResponse {
		return rpc[proto.ConsoleRequest, proto.ConsoleResponse](t, side, proto.StreamConsole,
			proto.ConsoleRequest{SessionID: "cs_s", Platform: proto.PlatformHost, GuestID: "host", Protocol: proto.ProtoVNC})
	}

	// Defaults (diagnose on): the state only.
	if r := step(proto.ScreenStatus); !r.OK {
		t.Fatalf("status with diagnose: %+v", r)
	}
	for _, op := range []string{proto.ScreenLook, proto.ScreenClick, proto.ScreenAccountSet, proto.ScreenUIPress} {
		if r := step(op); r.Code != CodeRemoteControlDisabled || !strings.Contains(r.Message, "host_shell") {
			t.Fatalf("%s without host_shell: %+v", op, r)
		}
	}
	// Console does not open the host's screen either.
	setTOML(t, tr.rt, map[string]string{"console": "true", "diagnose": "false"})
	if r := step(proto.ScreenStatus); r.Code != CodeRemoteControlDisabled {
		t.Fatalf("status without diagnose or host_shell: %+v", r)
	}
	if r := thumb(); r.Code != CodeRemoteControlDisabled || !strings.Contains(r.Message, "host_shell") {
		t.Fatalf("host thumbnail with console only: %+v", r)
	}
	if r := vnc(); r.Code != CodeRemoteControlDisabled || !strings.Contains(r.Message, "host_shell") {
		t.Fatalf("host vnc with console only: %+v", r)
	}
	if n := scr.calls.Load(); n != 1 {
		t.Fatalf("screen called %d times", n)
	}
	setTOML(t, tr.rt, map[string]string{"console": "false", "host_shell": "true"})
	for _, op := range []string{proto.ScreenStatus, proto.ScreenLook, proto.ScreenAccountSet} {
		if r := step(op); !r.OK || r.ScreenW != 1920 {
			t.Fatalf("%s with host_shell: %+v", op, r)
		}
	}
	if r := thumb(); r.Code != "" || len(r.Image) == 0 {
		t.Fatalf("host thumbnail with host_shell: %+v", r)
	}
	// Guests' thumbnails still need console.
	if r := rpc[proto.ThumbnailRequest, proto.ThumbnailResponse](t, side, proto.StreamThumbnail,
		proto.ThumbnailRequest{Platform: "incus", GuestID: "web"}); r.Code != CodeRemoteControlDisabled {
		t.Fatalf("guest thumbnail without console: %+v", r)
	}
	if r := vnc(); r.Code == CodeRemoteControlDisabled {
		t.Fatalf("host vnc with host_shell: %+v", r)
	}
}

func TestScreenUnsupported(t *testing.T) {
	h := newFakeHub(t)
	cfg := enrollAgent(t, h)
	tr := startRuntime(t, cfg, nil)
	side := h.waitSide(t)
	setTOML(t, tr.rt, map[string]string{"host_shell": "true"})
	r := rpc[proto.ScreenRequest, proto.ScreenResponse](t, side, proto.StreamScreen, proto.ScreenRequest{Op: proto.ScreenLook})
	if r.Code != CodeUnsupported {
		t.Fatalf("%+v", r)
	}
}
