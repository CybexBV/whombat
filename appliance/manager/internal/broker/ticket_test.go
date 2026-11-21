package broker_test

import (
	"context"
	"crypto/ed25519"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/broker"
	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi"
	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi/fakecontrol"
	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
)

// A cached ticket the runtime asks for again (it drops its own only when a relay refused it, 4401, or it restarted) is
// replaced by a fresh one from control, at most once a minute (MG-167). The finding it fixes: after control's lbl
// switch went off and the relay went back, the cached ticket still carried lbl and the old relay refused it on every
// reconnect until the cache ran out (3 min 20 s off the relay in the loopback run).
func TestTicketAskedAgainIsRefreshed(t *testing.T) {
	t.Parallel()
	var mu sync.Mutex
	now := time.Now()
	clock := func() time.Time { mu.Lock(); defer mu.Unlock(); return now }
	advance := func(d time.Duration) { mu.Lock(); now = now.Add(d); mu.Unlock() }

	w := testworld.New(t)
	fc := fakecontrol.New("dev")
	t.Cleanup(fc.Close)
	fc.Now = clock
	pub, priv, _ := ed25519.GenerateKey(nil)
	fc.Devices["dev-1"] = pub
	cc := &controlapi.Client{BaseURL: fc.Server.URL, Env: "dev", DeviceID: "dev-1", Key: priv, Now: clock}
	s := &broker.Server{RuntimeUID: uint32(os.Getuid()), Control: cc, Engine: w.Engine, Now: clock}
	sock := filepath.Join(filepath.Dir(w.P.HelperSock), "api.sock")
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go s.Listen(ctx, sock)
	for i := 0; i < 100; i++ {
		if _, err := os.Stat(sock); err == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	c := client(sock)
	ask := func() string {
		t.Helper()
		resp, m := post(t, c, "/v1/runtime/ticket", `{"class":"interactive"}`)
		if resp.StatusCode != 200 {
			t.Fatalf("ticket: %d %v", resp.StatusCode, m)
		}
		return m["ticket"].(string)
	}
	calls := func() int { var n int; fc.Set(func(f *fakecontrol.Control) { n = f.Tickets }); return n }

	first := ask()
	// Within the minute: the cached ticket, control not asked (a runtime restart, a data connection's ask).
	if ask() != first || calls() != 1 {
		t.Fatalf("within the minute: %d control calls", calls())
	}
	// Asked again later, long before it runs out: the runtime dropped it, so a fresh one.
	advance(61 * time.Second)
	second := ask()
	if second == first || calls() != 2 {
		t.Fatalf("asked again: the same ticket, %d control calls", calls())
	}
	// A relay that keeps refusing: the runtime asks on every reconnect, control at most once a minute.
	for range 20 {
		advance(2 * time.Second)
		if ask() != second {
			t.Fatal("a new ticket within the minute")
		}
	}
	if calls() != 2 {
		t.Fatalf("%d control calls for 20 asks within a minute", calls())
	}
	// Control out of reach: the cached ticket still goes out, and control is tried again only a minute later.
	advance(30 * time.Second)
	fc.SetDown(true)
	if ask() != second {
		t.Fatal("control down: not the cached ticket")
	}
	refused := fc.RefusedCount()
	advance(10 * time.Second)
	if ask() != second || fc.RefusedCount() != refused {
		t.Fatalf("control down: asked again within the minute (%d → %d)", refused, fc.RefusedCount())
	}
	// Back: the next ask after the minute gets a fresh one.
	fc.SetDown(false)
	advance(61 * time.Second)
	if third := ask(); third == second || calls() != 3 {
		t.Fatalf("after control came back: %d control calls", calls())
	}
}
