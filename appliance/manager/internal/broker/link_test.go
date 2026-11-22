package broker_test

import (
	"context"
	"crypto/ed25519"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/broker"
	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi"
	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi/fakecontrol"
	"github.com/CybexBV/whombat/appliance/manager/internal/link"
	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
	"github.com/CybexBV/whombat/contracts/go/device"
	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// fakeLink is the manager's Link state as the broker sees it.
type fakeLink struct {
	mu       sync.Mutex
	rec      link.Record
	onErr    error
	observed []protocol.LinkState
	ons      []string
	claims   []string
	// onObserve runs after an observed state, outside the fake's lock (the daemon's OnChange drops the tickets).
	onObserve func()
}

func (f *fakeLink) Available() bool { return true }
func (f *fakeLink) Active() bool    { f.mu.Lock(); defer f.mu.Unlock(); return f.rec.Active() }
func (f *fakeLink) Known() bool     { f.mu.Lock(); defer f.mu.Unlock(); return f.rec.Known() }
func (f *fakeLink) Snapshot() link.Record {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.rec
}
func (f *fakeLink) set(st protocol.LinkState) {
	f.mu.Lock()
	f.rec = link.Record{State: st, Since: time.Unix(1790000000, 0)}
	f.mu.Unlock()
}
func (f *fakeLink) On(_ context.Context, proof, name string) (link.Record, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ons = append(f.ons, proof+"/"+name)
	if f.onErr != nil {
		return f.rec, f.onErr
	}
	f.rec = link.Record{State: protocol.LinkStateStarting, Since: time.Unix(1790000000, 0),
		Pending: &link.Pending{Code: "ABCD-EFGH", URL: "https://app.whombat.com/link", ExpiresAt: time.Unix(1790000900, 0)}}
	return f.rec, nil
}
func (f *fakeLink) Off(context.Context) (link.Record, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.rec = link.Record{State: protocol.LinkStateOff, Since: time.Unix(1790000000, 0)}
	return f.rec, nil
}
func (f *fakeLink) Observe(st *device.DeviceLinkStatus) {
	f.mu.Lock()
	f.observed = append(f.observed, st.State)
	hook := f.onObserve
	f.mu.Unlock()
	if hook != nil {
		hook()
	}
}

func (f *fakeLink) SetClaimLink(secret string) {
	f.mu.Lock()
	f.claims = append(f.claims, secret)
	f.mu.Unlock()
}

func startLink(t *testing.T, fl *fakeLink) (*fakecontrol.Control, string) {
	fc, sock, _ := startLinkServer(t, fl)
	return fc, sock
}

func startLinkServer(t *testing.T, fl *fakeLink) (*fakecontrol.Control, string, *broker.Server) {
	t.Helper()
	w := testworld.New(t)
	fc := fakecontrol.New("dev")
	t.Cleanup(fc.Close)
	pub, priv, _ := ed25519.GenerateKey(nil)
	fc.Devices["dev-1"] = pub
	cc := &controlapi.Client{BaseURL: fc.Server.URL, Env: "dev", DeviceID: "dev-1", Key: priv}
	me := uint32(os.Getuid())
	s := &broker.Server{RuntimeUID: me, SupportUIDs: []uint32{me}, Control: cc, Support: cc, Engine: w.Engine, Link: fl}
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
	return fc, sock, s
}

// A ticket whose answer ends Link: the keeper's change drops the cached tickets, which needs the broker's lock; the
// ticket route hands the state over only once it let go of it.
func TestTicketThatEndsLinkDoesNotDeadlock(t *testing.T) {
	t.Parallel()
	fl := &fakeLink{}
	fl.set(protocol.LinkStateOn)
	fc, sock, s := startLinkServer(t, fl)
	fl.onObserve = s.DropTickets
	fc.SetLink(&device.DeviceLinkStatus{State: protocol.LinkStateEnded, Since: 1790000000})
	done := make(chan int, 1)
	go func() {
		resp, _ := post(t, client(sock), local.ManagerPathTicket, `{"class":"interactive"}`)
		done <- resp.StatusCode
	}()
	select {
	case code := <-done:
		if code != 200 || len(fl.observed) != 1 || fl.observed[0] != protocol.LinkStateEnded {
			t.Fatalf("%d %v", code, fl.observed)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the ticket route deadlocked")
	}
}

const pushToken = `{"token":{"platform":"fcm","token":"fcm-token-of-a-test-phone","appId":"com.example.whombat"}}`

const securityPush = `{"kind":"security","ref":"security_notice_000001","handles":["ph_handle_of_the_box_0001"],"ttlS":3600}`

// MG-171: what each Link state lets through to control. Off: nothing, a security push included (Whombat LNK-54: off
// means off). Ended: what is never gated (claim and revocation reports, push.send, so a security push still goes, and
// forgetting a push token). Starting, on, grace: everything.
func TestLinkGate(t *testing.T) {
	t.Parallel()
	fl := &fakeLink{}
	fc, sock := startLink(t, fl)
	c := client(sock)
	claimed := fmt.Sprintf(`{"claimId":"clm_%s","claimedAt":"2026-11-18T12:00:00Z"}`, strings.Repeat("a", 22))
	routes := []struct {
		path, body string
		known      bool // allowed once control knows the box (ended too)
	}{
		{local.ManagerPathTicket, `{"class":"interactive"}`, false},
		{local.ManagerPathSupportTicket, `{}`, false},
		{local.ManagerPathPushRegister, pushToken, false},
		{local.ManagerPathClaimed, claimed, true},
		{local.ManagerPathPush, securityPush, true},
		{local.ManagerPathPushUnregister, `{"handle":"ph_handle_of_the_box_0001"}`, true},
	}
	for _, st := range []protocol.LinkState{protocol.LinkStateOff, protocol.LinkStateEnded, protocol.LinkStateStarting,
		protocol.LinkStateOn, protocol.LinkStateGrace} {
		fl.set(st)
		active := st != protocol.LinkStateOff && st != protocol.LinkStateEnded
		for _, r := range routes {
			resp, m := post(t, c, r.path, r.body)
			allowed := active || (r.known && st == protocol.LinkStateEnded)
			if allowed != (resp.StatusCode == 200) {
				t.Errorf("%s %s: %d %v", st, r.path, resp.StatusCode, m)
			}
			if !allowed && resp.StatusCode != 404 {
				t.Errorf("%s %s: refused with %d, not 404", st, r.path, resp.StatusCode)
			}
		}
	}
	// The security push reached control in ended, starting, on and grace: never while off.
	sent := 0
	for _, o := range fc.Other {
		if strings.HasPrefix(o, string(device.DeviceOpNamePushSend)+" ") && strings.Contains(o, `"security"`) {
			sent++
		}
	}
	if sent != 4 {
		t.Fatalf("security pushes at control: %d, want 4 (all but off)", sent)
	}
	// Tickets are cached: one from control serves the three states that allow them.
	if fc.Tickets != 1 || fc.SupportTickets != 1 || len(fc.PushTokens) != 3 || len(fc.PushDropped) != 4 {
		t.Fatalf("control: tickets %d support %d push %d dropped %d", fc.Tickets, fc.SupportTickets, len(fc.PushTokens), len(fc.PushDropped))
	}
}

// MG-171: the Link routes, the errors as the contract names them, a ticket's Link state passed on.
func TestLinkRoutes(t *testing.T) {
	t.Parallel()
	fl := &fakeLink{}
	fl.set(protocol.LinkStateOff)
	fc, sock := startLink(t, fl)
	c := client(sock)
	resp, m := post(t, c, local.ManagerPathLinkState, `{"v":1}`)
	if resp.StatusCode != 200 || m["enabled"] != true || m["link"].(map[string]any)["state"] != "off" {
		t.Fatalf("%d %v", resp.StatusCode, m)
	}
	proof := strings.Repeat("ab", 64)
	resp, m = post(t, c, local.ManagerPathLinkOn, `{"v":1,"contentProof":"`+proof+`","name":"Kitchen"}`)
	l, _ := m["link"].(map[string]any)
	if resp.StatusCode != 200 || l["state"] != "starting" || l["pending"].(map[string]any)["code"] != "ABCD-EFGH" ||
		len(fl.ons) != 1 || fl.ons[0] != proof+"/Kitchen" {
		t.Fatalf("on: %d %v %v", resp.StatusCode, m, fl.ons)
	}
	if resp, _ := post(t, c, local.ManagerPathLinkOn, `{"v":1,"contentProof":"nothex"}`); resp.StatusCode != 400 {
		t.Fatalf("bad request: %d", resp.StatusCode)
	}
	for err, want := range map[error]struct {
		status int
		code   string
	}{
		link.ErrBusy:              {409, local.LinkErrorBusy},
		link.ErrDeviceExists:      {409, local.LinkErrorDeviceExists},
		link.ErrRateLimited:       {429, local.LinkErrorRateLimited},
		link.ErrUnavailable:       {404, local.LinkErrorUnavailable},
		controlapi.ErrUnavailable: {503, "control_unreachable"},
		link.ErrInvalid:           {502, "control_refused"},
	} {
		fl.onErr = err
		resp, m := post(t, c, local.ManagerPathLinkOn, `{"v":1,"contentProof":"`+proof+`"}`)
		if resp.StatusCode != want.status || m["error"].(map[string]any)["code"] != want.code {
			t.Errorf("%v: %d %v", err, resp.StatusCode, m)
		}
	}
	fl.onErr = nil
	// A ticket's answer carries control's Link state to the keeper.
	fl.set(protocol.LinkStateOn)
	fc.SetLink(&device.DeviceLinkStatus{State: protocol.LinkStateGrace, Since: 1790000000, GraceEndsAt: ptrOf(int64(1790604800))})
	if resp, _ := post(t, c, local.ManagerPathTicket, `{"class":"interactive"}`); resp.StatusCode != 200 {
		t.Fatal(resp.StatusCode)
	}
	if len(fl.observed) != 1 || fl.observed[0] != protocol.LinkStateGrace {
		t.Fatalf("observed %v", fl.observed)
	}
	// Off answers off, and no cached ticket is handed out after it.
	resp, m = post(t, c, local.ManagerPathLinkOff, `{"v":1}`)
	if resp.StatusCode != 200 || m["link"].(map[string]any)["state"] != "off" {
		t.Fatalf("off: %d %v", resp.StatusCode, m)
	}
	if resp, _ := post(t, c, local.ManagerPathTicket, `{"class":"interactive"}`); resp.StatusCode != 404 {
		t.Fatalf("ticket after off: %d", resp.StatusCode)
	}
}

func ptrOf[T any](v T) *T { return &v }

// The runtime hands over the claim link for link.status, and takes it back once there is none; anything that isn't a
// claim link is refused and kept from the keeper. Without a keeper it is answered and dropped.
func TestLinkClaimRoute(t *testing.T) {
	t.Parallel()
	fl := &fakeLink{}
	fl.set(protocol.LinkStateOn)
	_, sock := startLink(t, fl)
	c := client(sock)
	for _, body := range []string{`{"v":1,"claimLink":"pqrtvw"}`, `{"v":1}`} {
		if resp, m := post(t, c, local.ManagerPathLinkClaim, body); resp.StatusCode != 200 || m["ok"] != true {
			t.Fatalf("%s: %d %v", body, resp.StatusCode, m)
		}
	}
	for _, body := range []string{`{"v":1,"claimLink":"PQRTVW"}`, `{"v":1,"claimLink":"pqrtvwx"}`, `{"v":2}`, `{"v":1,"host":"x"}`} {
		if resp, _ := post(t, c, local.ManagerPathLinkClaim, body); resp.StatusCode != 400 {
			t.Fatalf("%s: %d", body, resp.StatusCode)
		}
	}
	if len(fl.claims) != 2 || fl.claims[0] != "pqrtvw" || fl.claims[1] != "" {
		t.Fatalf("%q", fl.claims)
	}
	_, bare, _ := start(t, uint32(os.Getuid()), nil)
	if resp, _ := post(t, client(bare), local.ManagerPathLinkClaim, `{"v":1,"claimLink":"pqrtvw"}`); resp.StatusCode != 200 {
		t.Fatal(resp.StatusCode)
	}
}

// Without a Link keeper (a manager built without one) the Link routes answer off and unavailable.
func TestLinkRoutesWithoutLink(t *testing.T) {
	t.Parallel()
	_, sock, _ := start(t, uint32(os.Getuid()), nil)
	c := client(sock)
	if resp, m := post(t, c, local.ManagerPathLinkState, `{"v":1}`); resp.StatusCode != 200 || m["enabled"] != false {
		t.Fatalf("%d %v", resp.StatusCode, m)
	}
	if resp, m := post(t, c, local.ManagerPathLinkOn, `{"v":1,"contentProof":"`+strings.Repeat("ab", 64)+`"}`); resp.StatusCode != 404 ||
		m["error"].(map[string]any)["code"] != local.LinkErrorUnavailable {
		t.Fatalf("%d %v", resp.StatusCode, m)
	}
}
