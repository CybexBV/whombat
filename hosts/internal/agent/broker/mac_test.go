package broker

import (
	"context"
	"slices"
	"strings"
	"testing"
	"time"

	"rackoon/internal/agent"
	"rackoon/internal/proto"
	"rackoon/internal/wire"
)

func TestMacBroker(t *testing.T) {
	m := NewMacBroker(&agent.Config{Dir: t.TempDir(), StateDir: t.TempDir()}, nil, nil)
	ran := make(chan []string, 1)
	m.b.hostDelay = time.Millisecond
	m.b.hostRun = func(argv []string) error { ran <- argv; return nil }
	ctx := context.Background()

	if r := m.Action(ctx, proto.ActionRequest{Platform: proto.PlatformDocker, GuestID: "web", Action: proto.ActionStart}); r.Code != CodeUnsupported {
		t.Errorf("guest action: %+v", r)
	}
	if r := m.Action(ctx, proto.ActionRequest{Platform: proto.PlatformHost, GuestID: HostID, Action: proto.ActionHostReboot}); !r.OK || r.State != "rebooting" {
		t.Fatalf("reboot: %+v", r)
	}
	if argv := <-ran; !slices.Equal(argv, []string{"/sbin/shutdown", "-r", "now"}) {
		t.Errorf("reboot ran %q", argv)
	}
	if got := macHostPowerCommands(proto.ActionHostShutdown); !slices.Equal(got[0], []string{"/sbin/shutdown", "-h", "now"}) {
		t.Errorf("shutdown %q", got)
	}

	if _, r := m.Console(ctx, proto.ConsoleRequest{Platform: proto.PlatformHost, GuestID: HostID, Protocol: proto.ProtoSPICE}); r.Code != CodeUnsupportedProtocol {
		t.Errorf("spice: %+v", r)
	}
	defer macScreen.Store(nil)
	macScreen.Store(nil)
	if _, r := m.Console(ctx, proto.ConsoleRequest{Platform: proto.PlatformHost, GuestID: HostID, Protocol: proto.ProtoVNC}); r.Code != CodeUnsupported {
		t.Errorf("vnc without the screen: %+v", r)
	}
	if r := m.Thumbnail(ctx, proto.ThumbnailRequest{Platform: proto.PlatformHost, GuestID: HostID}); r.Code != CodeUnsupported {
		t.Errorf("thumbnail without the screen: %+v", r)
	}
	SetMacScreen(func(context.Context) (agent.ConsoleSession, proto.ConsoleResponse) {
		return fakeSession{}, proto.ConsoleResponse{OK: true, Resolution: "5120x2880"}
	}, func(_ context.Context, req proto.ThumbnailRequest) proto.ThumbnailResponse {
		return proto.ThumbnailResponse{Image: []byte("img"), Width: req.MaxWidth}
	})
	if s, r := m.Console(ctx, proto.ConsoleRequest{Platform: proto.PlatformHost, GuestID: HostID, Protocol: proto.ProtoVNC}); !r.OK || s == nil || r.Resolution != "5120x2880" {
		t.Errorf("vnc: %+v", r)
	}
	if r := m.Thumbnail(ctx, proto.ThumbnailRequest{Platform: proto.PlatformHost, GuestID: HostID, MaxWidth: 320}); string(r.Image) != "img" || r.Width != 320 {
		t.Errorf("thumbnail: %+v", r)
	}
	if r := m.Thumbnail(ctx, proto.ThumbnailRequest{Platform: proto.PlatformHost, GuestID: HostID, Format: "gif"}); r.Code != CodeInvalid {
		t.Errorf("gif: %+v", r)
	}

	if r := m.Inspect(ctx, proto.InspectRequest{Kind: proto.InspectSnapshots, Platform: proto.PlatformHost, GuestID: HostID}); r.Code != CodeUnsupported {
		t.Errorf("snapshots: %+v", r)
	}
	if r := m.Inspect(ctx, proto.InspectRequest{Kind: proto.InspectServices, Platform: proto.PlatformDocker, GuestID: "x"}); r.Code != CodeInvalid {
		t.Errorf("guest view: %+v", r)
	}
	if r := m.Manage(ctx, proto.ManageRequest{Op: "guest.config", Platform: proto.PlatformHost}); r.Code != CodeUnsupported {
		t.Errorf("manage: %+v", r)
	}
	if r := m.Manage(ctx, proto.ManageRequest{Op: proto.OpTaskList, Platform: proto.PlatformHost}); !r.OK {
		t.Errorf("task.list: %+v", r)
	}
	if !strings.Contains(MacLogArgv[2], "log show --last 10m --style syslog") || !strings.Contains(MacLogArgv[2], "exec /usr/bin/log stream --style syslog") {
		t.Errorf("log argv %q", MacLogArgv)
	}
}

type fakeSession struct{}

func (fakeSession) Run(context.Context, <-chan wire.Frame, func(wire.Frame) error) error { return nil }
