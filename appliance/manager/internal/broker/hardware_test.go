package broker_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/broker"
	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

type fakeHardware struct {
	h   *protocol.HostHardware
	err error
}

func (f *fakeHardware) Collect(context.Context) (*protocol.HostHardware, error) { return f.h, f.err }

func TestHostHardwareEndpoint(t *testing.T) {
	t.Parallel()
	me := uint32(os.Getuid())
	drv := "mt7925e"
	good := &protocol.HostHardware{CollectedAt: "2026-10-20T12:00:00Z", Kernel: "6.18.53",
		Cpu: protocol.HardwareCpu{Model: "", Cores: 16, Threads: 32}, MemoryBytes: 1 << 35, Log: []string{},
		Devices: []protocol.HardwareDevice{{Kind: protocol.HardwareKindWifi, Name: "MT7925", Bus: protocol.HardwareBusPci,
			Driver: &drv, Status: protocol.HardwareStatusOk}}}
	bad := *good
	bad.Devices = []protocol.HardwareDevice{{Kind: protocol.HardwareKindWifi, Name: "", Bus: protocol.HardwareBusPci, Status: "fine"}}
	for _, tc := range []struct {
		name   string
		uid    uint32
		hw     *fakeHardware
		body   string
		status int
		code   string
	}{
		{"answered", me, &fakeHardware{h: good}, `{"v":1}`, 200, ""},
		{"strict", me, &fakeHardware{h: good}, `{"v":1,"devices":true}`, 400, "bad_request"},
		{"another version", me, &fakeHardware{h: good}, `{"v":2}`, 400, "bad_request"},
		{"not the runtime", me + 1, &fakeHardware{h: good}, `{"v":1}`, 403, "forbidden"},
		{"gone", me, &fakeHardware{err: context.Canceled}, `{"v":1}`, 503, "unavailable"},
		{"not the contract's", me, &fakeHardware{h: &bad}, `{"v":1}`, 500, "internal"},
		// As from a manager before MG-113: the runtime reports the hardware unavailable.
		{"no report here", me, nil, `{"v":1}`, 404, "unavailable"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := &broker.Server{RuntimeUID: tc.uid}
			if tc.hw != nil {
				s.Hardware = tc.hw
			}
			dir, err := os.MkdirTemp("", "hw") // a short path: a socket's is at most 107 bytes
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { os.RemoveAll(dir) })
			sock := filepath.Join(dir, "api.sock")
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			go s.Listen(ctx, sock)
			for i := 0; i < 100; i++ {
				if _, err := os.Stat(sock); err == nil {
					break
				}
				time.Sleep(10 * time.Millisecond)
			}
			resp, m := post(t, client(sock), local.ManagerPathHostHardware, tc.body)
			if resp.StatusCode != tc.status {
				t.Fatalf("%d %v", resp.StatusCode, m)
			}
			if tc.code != "" {
				if e, _ := m["error"].(map[string]any); e["code"] != tc.code {
					t.Fatalf("%v", m)
				}
				return
			}
			hw, _ := m["hardware"].(map[string]any)
			if m["v"] != float64(1) || hw["kernel"] != "6.18.53" || len(hw["devices"].([]any)) != 1 {
				t.Fatal(m)
			}
		})
	}
}
