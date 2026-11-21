package daemon_test

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/internal/reach"
	"github.com/CybexBV/whombat/appliance/manager/internal/config"
	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi/fakecontrol"
	"github.com/CybexBV/whombat/appliance/manager/internal/daemon"
	"github.com/CybexBV/whombat/appliance/manager/internal/identity"
	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
	"github.com/CybexBV/whombat/appliance/manager/internal/update"
	"github.com/CybexBV/whombat/contracts/go/device"
	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/protocol"
	"github.com/CybexBV/whombat/contracts/go/release"
)

// localBox makes the harness's box one that made its identity itself (LNK-01): device.json with every member of its
// registration, the signed registration provisioning keeps, and a control that has never heard of it.
func localBox(w *testworld.World, fc *fakecontrol.Control, c *config.Config) {
	key, err := identity.Load(c.ManagementKey)
	if err != nil {
		panic(err)
	}
	cpub, cpriv, _ := ed25519.GenerateKey(rand.Reader)
	peer, err := protocol.PeerIDFromEd25519PublicKey(cpub)
	if err != nil {
		panic(err)
	}
	reg := device.DeviceRegistration{Env: release.Environment("dev"), HardwareSerial: "SN-LINK-1", Model: "self-installed",
		ManagementPublicKey: hex.EncodeToString(key.Public), ContentPeerID: peer, ContentPublicKey: hex.EncodeToString(cpub),
		ProvisionedAt: 1790000000}
	if err := device.SignRegistration(&reg, key.Private, cpriv); err != nil {
		panic(err)
	}
	dev := map[string]any{"v": 1, "deviceId": "dev-1", "env": "dev", "applianceRoute": "local", "model": reg.Model,
		"serial": reg.HardwareSerial, "contentPeerId": peer, "contentPublicKey": reg.ContentPublicKey,
		"managementPublicKey": reg.ManagementPublicKey, "provisionedAt": reg.ProvisionedAt}
	b, _ := json.Marshal(dev)
	if err := os.WriteFile(c.DeviceFile, b, 0o644); err != nil {
		panic(err)
	}
	rb, _ := json.Marshal(reg)
	if err := os.WriteFile(filepath.Join(filepath.Dir(c.DeviceFile), "registration.json"), rb, 0o644); err != nil {
		panic(err)
	}
	delete(fc.Devices, "dev-1") // control first hears of the box at link.begin
}

// withReach points the daemon at a reach choice of the test's own.
func withReach(path string) func(*daemon.Daemon) {
	return func(d *daemon.Daemon) {
		d.ReachFile = path
		d.RegistrationFile = filepath.Join(filepath.Dir(d.Cfg.DeviceFile), "registration.json")
	}
}

func controlCalls(fc *fakecontrol.Control) int {
	return fc.Tickets + len(fc.StatusReports()) + fc.AssignmentCount() + fc.LookupCount() + fc.LicenceCount() +
		fc.LinkCount(device.DeviceOpNameLinkBegin) + fc.LinkCount(device.DeviceOpNameLinkStatus) +
		fc.LinkCount(device.DeviceOpNameLinkLeave) + len(fc.AuthErrors) + fc.SupportTickets
}

func post(t *testing.T, h *harness, path, body string) (int, string) {
	t.Helper()
	var code int
	var out []byte
	h.eventually("manager socket answers "+path, func() bool {
		resp, err := managerClient(h).Post("http://manager"+path, "application/json", strings.NewReader(body))
		if err != nil {
			return false
		}
		defer resp.Body.Close()
		code = resp.StatusCode
		out, _ = io.ReadAll(resp.Body)
		return true
	}, func() string { return "no answer" })
	return code, string(out)
}

func linkState(t *testing.T, h *harness) local.LinkStateResponse {
	t.Helper()
	code, body := post(t, h, local.ManagerPathLinkState, `{"v":1}`)
	r, err := local.ParseLinkStateResponse([]byte(body))
	if code != http.StatusOK || err != nil {
		t.Fatalf("link state: %d %s (%v)", code, body, err)
	}
	return *r
}

const ticketBody = `{"class":"interactive"}`

// TestLinkOffAsksControlNothing (LNK-03): a box that made its identity itself and never turned Link on runs, reports its
// facts to its runtime and takes updates, and sends control nothing at all; every route that would go there answers
// 404 unavailable.
func TestLinkOffAsksControlNothing(t *testing.T) {
	t.Parallel()
	h := startDaemonWith(t, nil, withReach(filepath.Join(t.TempDir(), "none.json")), localBox)
	h.eventually("facts at the runtime", factsCurrent(h.w, testworld.Factory), func() string { return "none" })
	if st := linkState(t, h); !st.Enabled || st.Link.State != protocol.LinkStateOff {
		t.Fatalf("%+v", st)
	}
	// (The support route is root's: the broker's own tests cover its gate.)
	if code, body := post(t, h, local.ManagerPathTicket, ticketBody); code != http.StatusNotFound || !strings.Contains(body, "unavailable") {
		t.Fatalf("ticket: %d %s", code, body)
	}
	if code, body := post(t, h, local.ManagerPathOwnAddressState, `{"v":1}`); code != http.StatusOK || !strings.Contains(body, `"enabled":false`) {
		t.Fatalf("own address: %d %s", code, body)
	}
	time.Sleep(3 * time.Second) // several poll, status and refresh intervals of this configuration
	if n := controlCalls(h.fc); n != 0 {
		t.Fatalf("%d control calls with Link off (tickets %d, reports %d, polls %d, lookups %d, auth errors %v)", n,
			h.fc.Tickets, len(h.fc.StatusReports()), h.fc.AssignmentCount(), h.fc.LookupCount(), h.fc.AuthErrors)
	}
}

// TestLinkFromTheInstallersChoice (LNK-12, LNK-13): the installer's choice turns Link on at the first start with the
// registration provisioning kept; the code shows; control's answers move the state (a ticket's too); turning Link off
// stops tickets at once and tells control.
func TestLinkFromTheInstallersChoice(t *testing.T) {
	t.Parallel()
	choice := filepath.Join(t.TempDir(), "reach.json")
	if err := reach.Write(choice, &reach.Choice{V: 1, Seq: 1, Link: true, By: reach.ByInstaller, At: "2026-11-18T12:00:00Z"}); err != nil {
		t.Fatal(err)
	}
	h := startDaemonWith(t, nil, withReach(choice), localBox)
	h.eventually("link.begin", func() bool { return h.fc.LinkCount(device.DeviceOpNameLinkBegin) == 1 },
		func() string { return fmt.Sprint(h.fc.AuthErrors) })
	h.eventually("starting with a code", func() bool {
		st := linkState(t, h)
		return st.Link.State == protocol.LinkStateStarting && st.Link.Pending != nil && st.Link.Pending.Code == "ABCD-EFGH"
	}, func() string { return fmt.Sprintf("%+v", linkState(t, h)) })
	if len(h.fc.Registered) != 1 || !device.VerifyRegistration(&h.fc.Registered[0]) {
		t.Fatalf("registered %+v", h.fc.Registered)
	}
	// The person confirms; the next ticket's answer carries `on`.
	h.fc.SetLink(&device.DeviceLinkStatus{State: protocol.LinkStateOn, Since: time.Now().Unix()})
	if code, body := post(t, h, local.ManagerPathTicket, ticketBody); code != http.StatusOK {
		t.Fatalf("ticket: %d %s", code, body)
	}
	if st := linkState(t, h); st.Link.State != protocol.LinkStateOn || st.Link.CheckedAt == nil {
		t.Fatalf("%+v", st)
	}
	// A restart doesn't begin again: the choice's seq was acted on.
	h.restart()
	time.Sleep(time.Second)
	if n := h.fc.LinkCount(device.DeviceOpNameLinkBegin); n != 1 {
		t.Fatalf("link.begin %d times", n)
	}
	// Off: tickets stop at once, control is told.
	if code, body := post(t, h, local.ManagerPathLinkOff, `{"v":1}`); code != http.StatusOK || !strings.Contains(body, `"state":"off"`) {
		t.Fatalf("off: %d %s", code, body)
	}
	if h.fc.LinkCount(device.DeviceOpNameLinkLeave) != 1 {
		t.Fatal("control wasn't told")
	}
	if code, _ := post(t, h, local.ManagerPathTicket, ticketBody); code != http.StatusNotFound {
		t.Fatalf("ticket after off: %d", code)
	}
}

// TestLinkOnFromTheRuntime (MG-171): the owner turns Link on in the apps: the runtime's content proof goes with the
// manager's proof; a bad proof never leaves the box. Push tokens go through while Link is on.
func TestLinkOnFromTheRuntime(t *testing.T) {
	t.Parallel()
	h := startDaemonWith(t, nil, withReach(filepath.Join(t.TempDir(), "none.json")), localBox)
	if code, body := post(t, h, local.ManagerPathPushRegister, `{"token":{"platform":"apns","token":"`+strings.Repeat("a", 64)+`","appId":"com.example.whombat"}}`); code != http.StatusNotFound {
		t.Fatalf("push register with Link off: %d %s", code, body)
	}
	if code, body := post(t, h, local.ManagerPathLinkOn, `{"v":1,"contentProof":"`+strings.Repeat("0", 128)+`"}`); code != http.StatusBadGateway {
		t.Fatalf("bad proof: %d %s", code, body)
	}
	if h.fc.LinkCount(device.DeviceOpNameLinkBegin) != 0 {
		t.Fatal("a bad registration reached control")
	}
	var reg device.DeviceRegistration
	b, _ := os.ReadFile(filepath.Join(filepath.Dir(h.cfg.DeviceFile), "registration.json"))
	_ = json.Unmarshal(b, &reg)
	code, body := post(t, h, local.ManagerPathLinkOn, `{"v":1,"contentProof":"`+reg.ContentProof+`","name":"Kitchen"}`)
	if code != http.StatusOK || !strings.Contains(body, `"state":"starting"`) || !strings.Contains(body, `"enabled":true`) {
		t.Fatalf("on: %d %s", code, body)
	}
	code, body = post(t, h, local.ManagerPathPushRegister, `{"token":{"platform":"apns","token":"`+strings.Repeat("a", 64)+`","appId":"com.example.whombat"}}`)
	if code != http.StatusOK || !strings.Contains(body, `"handle"`) || len(h.fc.PushTokens) != 1 {
		t.Fatalf("push register: %d %s", code, body)
	}
}

// TestUpdatesWhateverTheLinkState (LNK-05): a box control registered before Link and that has no update channel takes
// its releases as control's assignments; turning Link off stops tickets, not updates.
func TestUpdatesWhateverTheLinkState(t *testing.T) {
	t.Parallel()
	h := startDaemonWith(t, nil, withReach(filepath.Join(t.TempDir(), "none.json")))
	h.eventually("facts at the runtime", factsCurrent(h.w, testworld.Factory), func() string { return "none" })
	if code, body := post(t, h, local.ManagerPathLinkOff, `{"v":1}`); code != http.StatusOK || !strings.Contains(body, `"state":"off"`) {
		t.Fatalf("off: %d %s", code, body)
	}
	if code, _ := post(t, h, local.ManagerPathTicket, ticketBody); code != http.StatusNotFound {
		t.Fatalf("ticket with Link off: %d", code)
	}
	raw, _ := h.w.Repo.Assign("dev-1", testworld.RuntimeGood, 1, 24*time.Hour)
	h.fc.SetAssignment(raw)
	h.waitFor("rt-2 healthy with Link off", func(st *update.State) bool {
		return st.Phase == update.Healthy && st.Current.ReleaseID == testworld.RuntimeGood
	})
}
