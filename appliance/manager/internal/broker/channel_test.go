package broker_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/proto"
	"github.com/CybexBV/whombat/appliance/manager/internal/broker"
	"github.com/CybexBV/whombat/appliance/manager/internal/updatechannel"
	"github.com/CybexBV/whombat/contracts/go/local"
)

type channelHelper struct{ channel string }

func (h *channelHelper) Do(_ context.Context, req proto.Request) (*proto.Result, error) {
	switch req.Op {
	case proto.OpChannel:
		return &proto.Result{Channel: h.channel}, nil
	case proto.OpSetChannel:
		if h.channel == "" {
			return nil, &proto.Error{Code: proto.CodeBadRequest, Message: "this box's image has no update channels"}
		}
		h.channel = req.Channel
		return &proto.Result{Channel: req.Channel}, nil
	}
	return nil, &proto.Error{Code: proto.CodeBadRequest, Message: "unexpected"}
}

func startChannel(t *testing.T, runtimeUID uint32, svc *updatechannel.Service) string {
	t.Helper()
	s := &broker.Server{RuntimeUID: runtimeUID, Channel: svc}
	sock := filepath.Join(t.TempDir(), "api.sock")
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go s.Listen(ctx, sock)
	for i := 0; i < 100; i++ {
		if _, err := os.Stat(sock); err == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	return sock
}

// The update channel routes (LNK-21, contracts 4.4.0): the runtime's only, strict requests, the helper's channel.
func TestUpdateChannelRoutes(t *testing.T) {
	t.Parallel()
	h := &channelHelper{channel: "production"}
	changed := 0
	c := client(startChannel(t, uint32(os.Getuid()), &updatechannel.Service{Helper: h, Changed: func() { changed++ }}))
	if resp, m := post(t, c, local.ManagerPathUpdateChannel, `{"v":1}`); resp.StatusCode != 200 || m["channel"] != "production" {
		t.Fatalf("read: %d %v", resp.StatusCode, m)
	}
	for _, body := range []string{`{"v":1,"channel":"beta"}`, `{"v":1}`, `{"v":1,"channel":"development","by":"x"}`} {
		if resp, _ := post(t, c, local.ManagerPathUpdateChannelSet, body); resp.StatusCode != 400 {
			t.Fatalf("%s: %d", body, resp.StatusCode)
		}
	}
	if resp, m := post(t, c, local.ManagerPathUpdateChannelSet, `{"v":1,"channel":"development"}`); resp.StatusCode != 200 ||
		m["channel"] != "development" || h.channel != "development" || changed != 1 {
		t.Fatalf("set: %d %v %q changed %d", resp.StatusCode, m, h.channel, changed)
	}
	// Another caller can't.
	other := client(startChannel(t, uint32(os.Getuid())+1, &updatechannel.Service{Helper: h}))
	if resp, _ := post(t, other, local.ManagerPathUpdateChannelSet, `{"v":1,"channel":"production"}`); resp.StatusCode != 403 || h.channel != "development" {
		t.Fatalf("another caller: %d", resp.StatusCode)
	}
	// A box without channels answers update.channel_unavailable.
	none := client(startChannel(t, uint32(os.Getuid()), &updatechannel.Service{Helper: &channelHelper{}}))
	if resp, m := post(t, none, local.ManagerPathUpdateChannel, `{"v":1}`); resp.StatusCode != 404 || errCode(m) != local.LinkErrorUpdateChannelUnavailable {
		t.Fatalf("no channels: %d %v", resp.StatusCode, m)
	}
}
