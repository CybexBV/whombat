package ops

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/kernlog"
	"github.com/CybexBV/whombat/appliance/helper/pkg/proto"
)

func TestParseJournal(t *testing.T) {
	t.Parallel()
	in := strings.Join([]string{
		`{"__CURSOR":"s=1","MESSAGE":"mt7925e 0000:c3:00.0: Direct firmware load for a.bin failed with error -2","PRIORITY":"4"}`,
		// Not UTF-8: journalctl sends the bytes.
		`{"MESSAGE":[105,119,108,119,105,102,105,32,255],"PRIORITY":"3"}`,
		// Too long for journalctl's JSON (null), no message, no priority, not JSON.
		`{"MESSAGE":null,"PRIORITY":"3"}`,
		`{"PRIORITY":"3"}`,
		`{"MESSAGE":"usb 3-5: new device"}`,
		`not json`,
		`{"MESSAGE":"last","PRIORITY":"6"}`,
	}, "\n")
	got, full := parseJournal(strings.NewReader(in), 100)
	if full || len(got) != 4 {
		t.Fatalf("%v %+v", full, got)
	}
	if got[0].Priority != 4 || got[1].Message != "iwlwifi \xff" || got[2].Priority != -1 || got[3].Message != "last" {
		t.Fatalf("%+v", got)
	}
	if got, full := parseJournal(strings.NewReader(in), 2); !full || len(got) != 2 {
		t.Fatalf("%v %+v", full, got)
	}
}

func TestHardwareLog(t *testing.T) {
	t.Parallel()
	h, err := New(Config{DeviceID: "dev-1", Env: "dev", StateDir: t.TempDir(),
		KernelMessages: func(ctx context.Context) ([]kernlog.Entry, error) {
			if dl, ok := ctx.Deadline(); !ok || time.Until(dl) > hardwareLogTimeout {
				t.Error("no bound on reading the kernel's messages")
			}
			return []kernlog.Entry{
				{Message: "ACPI BIOS Error (bug): Could not resolve symbol", Priority: 3},
				{Message: "iwlwifi 0000:00:14.3: no suitable firmware found!", Priority: 3},
				{Message: "r8152 5-1:1.0 eth0: carrier on", Priority: 6},
			}, nil
		}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	// Another operation holds the lock (a staging that takes an hour): hardware-log doesn't wait for it.
	h.mu.Lock()
	defer h.mu.Unlock()
	done := make(chan struct{})
	var res *proto.Result
	var perr *proto.Error
	go func() {
		res, perr, _ = h.Handle(context.Background(), proto.Request{V: 1, Op: proto.OpHardwareLog})
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("hardware-log waited for the operation lock")
	}
	if perr != nil || len(res.KernelLog) != 1 || res.KernelLog[0] != "iwlwifi 0000:00:14.3: no suitable firmware found!" {
		t.Fatalf("%v %+v", perr, res)
	}

	// The journal can't be read: an error, not an empty answer.
	h.cfg.KernelMessages = func(context.Context) ([]kernlog.Entry, error) { return nil, errors.New("no journal") }
	if _, perr, _ := h.Handle(context.Background(), proto.Request{V: 1, Op: proto.OpHardwareLog}); perr == nil || perr.Code != proto.CodeInternal {
		t.Fatalf("%v", perr)
	}
	// It takes no argument.
	if _, perr, _ := h.Handle(context.Background(), proto.Request{V: 1, Op: proto.OpHardwareLog, ReleaseID: "rt-1"}); perr == nil || perr.Code != proto.CodeBadRequest {
		t.Fatalf("%v", perr)
	}
}
