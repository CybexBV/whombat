package broker_test

import (
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/broker"
	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi"
	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi/fakecontrol"
	"github.com/CybexBV/whombat/appliance/manager/internal/link"
	"github.com/CybexBV/whombat/appliance/manager/internal/ownaddress"
	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
	"github.com/CybexBV/whombat/contracts/go/device"
	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// startOA is start with an own-address service (nil: a manager without one).
func startOA(t *testing.T, runtimeUID uint32, on bool) (*fakecontrol.Control, string, *ownaddress.Service) {
	t.Helper()
	var mode *ownaddress.Mode
	if on {
		mode = &ownaddress.Mode{Enabled: true, Zone: "dev.whombat.app", Directory: "https://ca.example.com/dir"}
	}
	return startOAWith(t, runtimeUID, mode, nil)
}

// startOAWith is startOA in mode (nil: none), with a Link state (nil: none).
func startOAWith(t *testing.T, runtimeUID uint32, mode *ownaddress.Mode, l broker.Link) (*fakecontrol.Control, string, *ownaddress.Service) {
	t.Helper()
	fc, sock, svc, _ := startOAServer(t, runtimeUID, mode, l)
	return fc, sock, svc
}

// startOAServer is startOAWith that also gives the server.
func startOAServer(t *testing.T, runtimeUID uint32, mode *ownaddress.Mode, l broker.Link) (*fakecontrol.Control, string, *ownaddress.Service, *broker.Server) {
	t.Helper()
	w := testworld.New(t)
	fc := fakecontrol.New("dev")
	t.Cleanup(fc.Close)
	pub, priv, _ := ed25519.GenerateKey(nil)
	fc.Devices["dev-1"] = pub
	cc := &controlapi.Client{BaseURL: fc.Server.URL, Env: "dev", DeviceID: "dev-1", Key: priv}
	s := &broker.Server{RuntimeUID: runtimeUID, Control: cc, Engine: w.Engine}
	if l != nil {
		s.Link = l
	}
	var svc *ownaddress.Service
	if mode != nil {
		st, err := ownaddress.OpenStore(filepath.Join(t.TempDir(), "own-address"))
		if err != nil {
			t.Fatal(err)
		}
		svc, err = ownaddress.Open(*mode, st, nil)
		if err != nil {
			t.Fatal(err)
		}
		s.OwnAddress = svc
	}
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
	return fc, sock, svc, s
}

const v1 = `{"v":1}`

func TestOwnAddressOff(t *testing.T) {
	t.Parallel()
	_, sock, _ := startOA(t, uint32(os.Getuid()), false)
	c := client(sock)
	resp, m := post(t, c, local.ManagerPathOwnAddressState, v1)
	if resp.StatusCode != 200 || m["enabled"] != false || m["acme"].(map[string]any)["state"] != "idle" {
		t.Fatalf("state: %d %v", resp.StatusCode, m)
	}
	for path, body := range map[string]string{
		local.ManagerPathOwnAddressRegister: `{"v":1,"label":"maple-otter-river"}`,
		local.ManagerPathOwnAddressCert:     v1, local.ManagerPathOwnAddressCt: v1,
		local.ManagerPathOwnAddressCheck:  `{"v":1,"label":"home"}`,
		local.ManagerPathOwnAddressRename: `{"v":1,"label":"home"}`,
	} {
		if resp, m := post(t, c, path, body); resp.StatusCode != 404 || errCode(m) != local.OwnAddressErrorOff {
			t.Fatalf("%s: %d %v", path, resp.StatusCode, m)
		}
	}
}

func TestOwnAddressRegister(t *testing.T) {
	t.Parallel()
	fc, sock, svc := startOA(t, uint32(os.Getuid()), true)
	c := client(sock)
	// A ticket before the label is cached …
	if resp, _ := post(t, c, local.ManagerPathTicket, `{"class":"interactive"}`); resp.StatusCode != 200 {
		t.Fatal("ticket", resp.StatusCode)
	}
	for _, bad := range []string{`{"v":1}`, `{"v":1,"label":"Maple-otter-river"}`, `{"v":1,"label":"ma"}`, `{"v":2,"label":"maple-otter-river"}`, `{"v":1,"label":"maple-otter-river","x":1}`} {
		if resp, _ := post(t, c, local.ManagerPathOwnAddressRegister, bad); resp.StatusCode != 400 {
			t.Fatalf("%s: %d", bad, resp.StatusCode)
		}
	}
	fc.Set(func(f *fakecontrol.Control) { f.Taken = map[string]bool{"taken-word-here": true} })
	if resp, m := post(t, c, local.ManagerPathOwnAddressRegister, `{"v":1,"label":"taken-word-here"}`); resp.StatusCode != 409 || errCode(m) != local.OwnAddressErrorLabelTaken {
		t.Fatalf("taken: %d %v", resp.StatusCode, m)
	}
	fc.SetDown(true)
	if resp, m := post(t, c, local.ManagerPathOwnAddressRegister, `{"v":1,"label":"maple-otter-river"}`); resp.StatusCode != 503 || errCode(m) != "control_unreachable" {
		t.Fatalf("down: %d %v", resp.StatusCode, m)
	}
	fc.SetDown(false)
	resp, m := post(t, c, local.ManagerPathOwnAddressRegister, `{"v":1,"label":"maple-otter-river"}`)
	if resp.StatusCode != 200 || m["label"] != "maple-otter-river" || m["host"] != "maple-otter-river.dev.whombat.app" || m["enabled"] != true {
		t.Fatalf("register: %d %v", resp.StatusCode, m)
	}
	b, _ := json.Marshal(m)
	if _, err := local.ParseOwnAddressStateResponse(b); err != nil {
		t.Fatal(err)
	}
	// … and dropped by the registration: the next ticket comes from control, so it can carry lbl.
	before := fc.Tickets
	if resp, _ := post(t, c, local.ManagerPathTicket, `{"class":"interactive"}`); resp.StatusCode != 200 || fc.Tickets != before+1 {
		t.Fatalf("the ticket after registering came from the cache (%d → %d)", before, fc.Tickets)
	}
	// Persisted, and the manager's label is the answer from now on, whatever the runtime sends; control isn't asked.
	calls := fc.AddressCalls
	if resp, m := post(t, c, local.ManagerPathOwnAddressRegister, `{"v":1,"label":"other-name-here"}`); resp.StatusCode != 200 || m["label"] != "maple-otter-river" || fc.AddressCalls != calls {
		t.Fatalf("again: %d %v (%d calls)", resp.StatusCode, m, fc.AddressCalls-calls)
	}
	if l, _ := svc.Label(); l != "maple-otter-river" {
		t.Fatal("not kept:", l)
	}
	saved, _ := ownaddress.OpenStore(svc.Store.Dir())
	if st, _ := saved.State(); st.Label != "maple-otter-river" {
		t.Fatal("not persisted:", st)
	}
	// No certificate yet; the watch's record is empty.
	if resp, m := post(t, c, local.ManagerPathOwnAddressCert, v1); resp.StatusCode != 409 || errCode(m) != local.OwnAddressErrorNoCert {
		t.Fatalf("cert: %d %v", resp.StatusCode, m)
	}
	if resp, m := post(t, c, local.ManagerPathOwnAddressCt, v1); resp.StatusCode != 200 || m["source"] != "certspotter" {
		t.Fatalf("ct: %d %v", resp.StatusCode, m)
	}
}

func TestOwnAddressRegisterRefusesAHostMismatch(t *testing.T) {
	t.Parallel()
	fc, sock, svc := startOA(t, uint32(os.Getuid()), true)
	fc.Set(func(f *fakecontrol.Control) { f.AddressHost = "maple-otter-river.box.whombat.app" })
	resp, m := post(t, client(sock), local.ManagerPathOwnAddressRegister, `{"v":1,"label":"maple-otter-river"}`)
	if resp.StatusCode != 502 || errCode(m) != "control_refused" {
		t.Fatalf("%d %v", resp.StatusCode, m)
	}
	if l, _ := svc.Label(); l != "" {
		t.Fatal("kept a mismatched host")
	}
}

func TestOwnAddressCertAndCallers(t *testing.T) {
	t.Parallel()
	_, sock, svc := startOA(t, uint32(os.Getuid()), true)
	c := client(sock)
	if resp, _ := post(t, c, local.ManagerPathOwnAddressRegister, `{"v":1,"label":"maple-otter-river"}`); resp.StatusCode != 200 {
		t.Fatal(resp.StatusCode)
	}
	// A pair saved as an order would, made current by the loop's own step (a renewal-free order loop run).
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(0xab12), DNSNames: []string{"maple-otter-river.dev.whombat.app"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(90 * 24 * time.Hour)}
	der, _ := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	p, err := svc.Store.SavePair([][]byte{der}, key)
	if err != nil {
		t.Fatal(err)
	}
	svc.Prober, svc.Orderer = okProber{}, onceOrderer{p}
	ctx, cancel := context.WithCancel(context.Background())
	svc.Sleep = func(context.Context, <-chan struct{}, time.Duration) bool { cancel(); return false }
	svc.Run(ctx)
	resp, m := post(t, c, local.ManagerPathOwnAddressCert, v1)
	if resp.StatusCode != 200 || m["serial"] != "ab12" || m["host"] != "maple-otter-river.dev.whombat.app" || !strings.Contains(m["keyPem"].(string), "PRIVATE KEY") {
		t.Fatalf("cert: %d %v", resp.StatusCode, m)
	}
	b, _ := json.Marshal(m)
	if _, err := local.ParseOwnAddressCertResponse(b); err != nil {
		t.Fatal(err)
	}
	_, m = post(t, c, local.ManagerPathOwnAddressCt, v1)
	if o, _ := m["ordered"].([]any); len(o) != 1 {
		t.Fatalf("ct: %v", m)
	}
}

type okProber struct{}

func (okProber) Probe(context.Context, string) error { return nil }

type onceOrderer struct{ p *ownaddress.Pair }

func (o onceOrderer) Order(context.Context, string) (*ownaddress.Pair, error) { return o.p, nil }

func TestOwnAddressOnlyForTheRuntime(t *testing.T) {
	t.Parallel()
	_, sock, _ := startOA(t, uint32(os.Getuid())+1, true)
	c := client(sock)
	for _, path := range []string{local.ManagerPathOwnAddressState, local.ManagerPathOwnAddressRegister, local.ManagerPathOwnAddressCert,
		local.ManagerPathOwnAddressCt, local.ManagerPathOwnAddressCheck, local.ManagerPathOwnAddressRename, local.ManagerPathAccountLinkLookup, local.ManagerPathAccountLink, local.ManagerPathKitCredentials} {
		if resp, _ := post(t, c, path, v1); resp.StatusCode != 403 {
			t.Fatalf("%s: %d", path, resp.StatusCode)
		}
	}
}

func TestAccountLinkAndKitCredentialsForwarded(t *testing.T) {
	t.Parallel()
	fc, sock, _ := startOA(t, uint32(os.Getuid()), true)
	c := client(sock)
	resp, m := post(t, c, local.ManagerPathAccountLinkLookup, `{"code":"ABCD-EFGH"}`)
	if resp.StatusCode != 200 || m["email"] != "owner@example.com" {
		t.Fatalf("lookup: %d %v", resp.StatusCode, m)
	}
	resp, m = post(t, c, local.ManagerPathAccountLink, `{"code":"ABCD-EFGH"}`)
	if resp.StatusCode != 200 || m["linkedAt"] != float64(1790000000) {
		t.Fatalf("link: %d %v", resp.StatusCode, m)
	}
	resp, m = post(t, c, local.ManagerPathKitCredentials, `{"credentialIds":["Y3JlZC0x","Y3JlZC0y"]}`)
	if resp.StatusCode != 200 || m["declared"] != float64(2) {
		t.Fatalf("declare: %d %v", resp.StatusCode, m)
	}
	if len(fc.Forwarded) != 3 || !strings.HasPrefix(fc.Forwarded[0], "account.link.lookup ") || !strings.HasPrefix(fc.Forwarded[2], "kit.credentials.declare ") {
		t.Fatalf("control saw %v", fc.Forwarded)
	}
	// Bodies out of the contract never leave the box.
	for path, bad := range map[string]string{
		local.ManagerPathAccountLinkLookup: `{"code":"abcd-efgh"}`,
		local.ManagerPathAccountLink:       `{"code":"ABCD-EFGH","x":1}`,
		local.ManagerPathKitCredentials:    `{"credentialIds":"Y3JlZC0x"}`,
	} {
		if resp, _ := post(t, c, path, bad); resp.StatusCode != 400 {
			t.Fatalf("%s %s: %d", path, bad, resp.StatusCode)
		}
	}
	// Control's refusal code leads the message, for the runtime to tell the person.
	fc.Set(func(f *fakecontrol.Control) { f.LinkRefuse = "link_code_invalid" })
	resp, m = post(t, c, local.ManagerPathAccountLink, `{"code":"ABCD-EFGH"}`)
	msg, _ := m["error"].(map[string]any)["message"].(string)
	if resp.StatusCode != 502 || errCode(m) != "control_refused" || !strings.HasPrefix(msg, "conflict link_code_invalid") {
		t.Fatalf("refused: %d %v", resp.StatusCode, m)
	}
	fc.SetDown(true)
	if resp, m := post(t, c, local.ManagerPathAccountLinkLookup, `{"code":"ABCD-EFGH"}`); resp.StatusCode != 503 || errCode(m) != "control_unreachable" {
		t.Fatalf("down: %d %v", resp.StatusCode, m)
	}
}

// issue gives svc a current pair for its host, as the order loop would.
func issue(t *testing.T, svc *ownaddress.Service, serial int64) {
	t.Helper()
	_, host := svc.Label()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(serial), DNSNames: []string{host},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(90 * 24 * time.Hour)}
	der, _ := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	p, err := svc.Store.SavePair([][]byte{der}, key)
	if err != nil {
		t.Fatal(err)
	}
	svc.Prober, svc.Orderer = okProber{}, onceOrderer{p}
	ctx, cancel := context.WithCancel(context.Background())
	svc.Sleep = func(context.Context, <-chan struct{}, time.Duration) bool { cancel(); return false }
	svc.Run(ctx)
}

// The owner's name check and rename go to control; the rename answers the new state, keeps the old host answering
// with its pair, and drops the cached tickets.
func TestOwnAddressCheckAndRename(t *testing.T) {
	t.Parallel()
	fc, sock, svc := startOA(t, uint32(os.Getuid()), true)
	c := client(sock)
	if resp, _ := post(t, c, local.ManagerPathOwnAddressRegister, `{"v":1,"label":"maple-otter-river"}`); resp.StatusCode != 200 {
		t.Fatal(resp.StatusCode)
	}
	issue(t, svc, 0xab12)
	fc.Set(func(f *fakecontrol.Control) {
		f.Reserved = map[string]bool{"admin": true}
		f.Taken = map[string]bool{"taken-name": true}
	})
	for label, want := range map[string]string{"home-box": "free", "maple-otter-river": "yours", "admin": "reserved",
		"taken-name": "taken", "a": "invalid", "-ab": "invalid"} {
		resp, m := post(t, c, local.ManagerPathOwnAddressCheck, `{"v":1,"label":"`+label+`"}`)
		if resp.StatusCode != 200 || m["verdict"] != want || m["label"] != label {
			t.Fatalf("check %s: %d %v", label, resp.StatusCode, m)
		}
		b, _ := json.Marshal(m)
		if _, err := local.ParseOwnAddressCheckResponse(b); err != nil {
			t.Fatal(err)
		}
	}
	for _, bad := range []string{`{"v":1}`, `{"v":1,"label":"Home"}`, `{"v":1,"label":"home","x":1}`} {
		if resp, _ := post(t, c, local.ManagerPathOwnAddressCheck, bad); resp.StatusCode != 400 {
			t.Fatalf("check %s: %d", bad, resp.StatusCode)
		}
		if resp, _ := post(t, c, local.ManagerPathOwnAddressRename, bad); resp.StatusCode != 400 {
			t.Fatalf("rename %s: %d", bad, resp.StatusCode)
		}
	}
	for label, want := range map[string]string{"admin": local.OwnAddressErrorLabelReserved, "taken-name": local.OwnAddressErrorLabelTaken} {
		if resp, m := post(t, c, local.ManagerPathOwnAddressRename, `{"v":1,"label":"`+label+`"}`); resp.StatusCode != 409 || errCode(m) != want {
			t.Fatalf("rename %s: %d %v", label, resp.StatusCode, m)
		}
	}
	if resp, _ := post(t, c, local.ManagerPathTicket, `{"class":"interactive"}`); resp.StatusCode != 200 {
		t.Fatal("ticket", resp.StatusCode)
	}
	resp, m := post(t, c, local.ManagerPathOwnAddressRename, `{"v":1,"label":"home-box"}`)
	leaving, _ := m["leaving"].(map[string]any)
	if resp.StatusCode != 200 || m["host"] != "home-box.dev.whombat.app" || leaving["host"] != "maple-otter-river.dev.whombat.app" {
		t.Fatalf("rename: %d %v", resp.StatusCode, m)
	}
	b, _ := json.Marshal(m)
	if _, err := local.ParseOwnAddressStateResponse(b); err != nil {
		t.Fatal(err)
	}
	before := fc.Tickets
	if resp, _ := post(t, c, local.ManagerPathTicket, `{"class":"interactive"}`); resp.StatusCode != 200 || fc.Tickets != before+1 {
		t.Fatal("the ticket after the rename came from the cache")
	}
	// The old host's pair, by its host; the new host has none yet; a host the box doesn't answer at has none.
	if resp, m := post(t, c, local.ManagerPathOwnAddressCert, `{"v":1,"host":"maple-otter-river.dev.whombat.app"}`); resp.StatusCode != 200 || m["serial"] != "ab12" || m["host"] != "maple-otter-river.dev.whombat.app" {
		t.Fatalf("old host's cert: %d %v", resp.StatusCode, m)
	}
	for _, body := range []string{v1, `{"v":1,"host":"home-box.dev.whombat.app"}`, `{"v":1,"host":"nobody-here.dev.whombat.app"}`} {
		if resp, m := post(t, c, local.ManagerPathOwnAddressCert, body); resp.StatusCode != 409 || errCode(m) != local.OwnAddressErrorNoCert {
			t.Fatalf("cert %s: %d %v", body, resp.StatusCode, m)
		}
	}
	// Control's limit and its other refusals.
	fc.Set(func(f *fakecontrol.Control) { f.RenameLimit = 1 })
	if resp, m := post(t, c, local.ManagerPathOwnAddressRename, `{"v":1,"label":"garden-shed"}`); resp.StatusCode != 409 || errCode(m) != local.OwnAddressErrorRenameLimit {
		t.Fatalf("limit: %d %v", resp.StatusCode, m)
	}
	fc.Set(func(f *fakecontrol.Control) { f.RenameRefuse = "link_off" })
	if resp, m := post(t, c, local.ManagerPathOwnAddressRename, `{"v":1,"label":"garden-shed"}`); resp.StatusCode != 409 || errCode(m) != local.OwnAddressErrorLinkOff {
		t.Fatalf("link off at control: %d %v", resp.StatusCode, m)
	}
	fc.SetDown(true)
	if resp, m := post(t, c, local.ManagerPathOwnAddressCheck, `{"v":1,"label":"garden-shed"}`); resp.StatusCode != 503 || errCode(m) != "control_unreachable" {
		t.Fatalf("down: %d %v", resp.StatusCode, m)
	}
}

// A prod box under box.whombat.app moves with its own label: the same label under whombat.app, the old host leaving;
// the Link state names the new host. Asking again changes nothing.
func TestOwnAddressMove(t *testing.T) {
	t.Parallel()
	fl := &fakeLink{rec: link.Record{State: protocol.LinkStateOn, Label: "maple-otter-river"}}
	mode := &ownaddress.Mode{Enabled: true, Zone: "whombat.app", Directory: "https://ca.example.com/dir"}
	fc, sock, svc := startOAWith(t, uint32(os.Getuid()), mode, fl)
	c := client(sock)
	fc.Set(func(f *fakecontrol.Control) {
		f.Zone = "box.whombat.app"
		f.Link = &device.DeviceLinkStatus{State: protocol.LinkStateOn, Since: 1790000000}
	})
	if resp, m := post(t, c, local.ManagerPathOwnAddressRegister, `{"v":1,"label":"maple-otter-river"}`); resp.StatusCode != 200 || m["host"] != "maple-otter-river.box.whombat.app" {
		t.Fatalf("register: %d %v", resp.StatusCode, m)
	}
	issue(t, svc, 0xcd34)
	fc.Set(func(f *fakecontrol.Control) { f.Zone = "whombat.app" })
	label, ok := svc.MoveWanted("whombat.app")
	if !ok {
		t.Fatal("no move wanted")
	}
	resp, m := post(t, c, local.ManagerPathOwnAddressRename, `{"v":1,"label":"`+label+`"}`)
	leaving, _ := m["leaving"].(map[string]any)
	if resp.StatusCode != 200 || m["host"] != "maple-otter-river.whombat.app" || leaving["host"] != "maple-otter-river.box.whombat.app" {
		t.Fatalf("move: %d %v", resp.StatusCode, m)
	}
	if r := fl.Snapshot(); r.Host != "maple-otter-river.whombat.app" || r.Label != "maple-otter-river" {
		t.Fatalf("link state %+v", r)
	}
	if resp, m := post(t, c, local.ManagerPathOwnAddressCert, `{"v":1,"host":"maple-otter-river.box.whombat.app"}`); resp.StatusCode != 200 || m["serial"] != "cd34" {
		t.Fatalf("old host's cert: %d %v", resp.StatusCode, m)
	}
	if fc.Renamed["dev-1"] != 0 {
		t.Fatal("a move counted as a rename")
	}
	resp, m2 := post(t, c, local.ManagerPathOwnAddressRename, `{"v":1,"label":"maple-otter-river"}`)
	if resp.StatusCode != 200 || m2["host"] != m["host"] || m2["leaving"] == nil {
		t.Fatalf("again: %d %v", resp.StatusCode, m2)
	}
	// Link off: control isn't asked.
	fl.mu.Lock()
	fl.rec.State = protocol.LinkStateOff
	fl.mu.Unlock()
	calls := fc.RenameCalls
	if resp, m := post(t, c, local.ManagerPathOwnAddressRename, `{"v":1,"label":"home"}`); resp.StatusCode != 409 || errCode(m) != local.OwnAddressErrorLinkOff || fc.RenameCalls != calls {
		t.Fatalf("link off: %d %v", resp.StatusCode, m)
	}
}

// The daemon's move and the owner's rename race: whichever reaches control first, the box ends at the owner's name.
// The address is held for one change at a time, so the rename waits for a move under way; and a move chosen before
// the rename that reaches control after it carries move, so control changes nothing and the box keeps the new name.
func TestALateMoveNeverUndoesARename(t *testing.T) {
	t.Parallel()
	const oldHost, movedHost = "maple-otter-river.box.whombat.app", "maple-otter-river.whombat.app"
	fl := &fakeLink{rec: link.Record{State: protocol.LinkStateOn, Label: "maple-otter-river"}}
	mode := &ownaddress.Mode{Enabled: true, Zone: "whombat.app", Directory: "https://ca.example.com/dir"}
	fc, sock, svc, srv := startOAServer(t, uint32(os.Getuid()), mode, fl)
	c := client(sock)
	fc.Set(func(f *fakecontrol.Control) {
		f.Zone = "box.whombat.app"
		f.Link = &device.DeviceLinkStatus{State: protocol.LinkStateOn, Since: 1790000000}
	})
	if resp, m := post(t, c, local.ManagerPathOwnAddressRegister, `{"v":1,"label":"maple-otter-river"}`); resp.StatusCode != 200 || m["host"] != oldHost {
		t.Fatalf("register: %d %v", resp.StatusCode, m)
	}
	issue(t, svc, 0xcd34)
	fc.Set(func(f *fakecontrol.Control) { f.Zone = "whombat.app" })
	label, ok := svc.MoveWanted("whombat.app")
	if !ok {
		t.Fatal("no move wanted")
	}

	// The move holds the address: the owner's rename waits, then renames the moved box.
	unlock := srv.LockAddress()
	renamed := make(chan int, 1)
	go func() {
		resp, err := c.Post("http://manager"+local.ManagerPathOwnAddressRename, "application/json", strings.NewReader(`{"v":1,"label":"home"}`))
		if err != nil {
			renamed <- 0
			return
		}
		resp.Body.Close()
		renamed <- resp.StatusCode
	}()
	select {
	case code := <-renamed:
		t.Fatalf("the rename didn't wait for the move: %d", code)
	case <-time.After(200 * time.Millisecond):
	}
	if err := srv.RenameAddress(context.Background(), label, true); err != nil {
		t.Fatal(err)
	}
	if _, h := svc.Label(); h != movedHost {
		t.Fatalf("moved to %s", h)
	}
	unlock()
	if code := <-renamed; code != 200 {
		t.Fatalf("rename: %d", code)
	}
	if _, h := svc.Label(); h != "home.whombat.app" {
		t.Fatalf("after the rename: %s", h)
	}
	if l := svc.Leaving(); l == nil || l.Host != oldHost {
		t.Fatalf("leaving %+v", l)
	}

	// The same move again, late: control changes nothing, and neither does the box.
	unlock = srv.LockAddress()
	err := srv.RenameAddress(context.Background(), label, true)
	unlock()
	if err != nil {
		t.Fatal(err)
	}
	if _, h := svc.Label(); h != "home.whombat.app" {
		t.Fatalf("a late move undid the rename: %s", h)
	}
	if l := svc.Leaving(); l == nil || l.Host != oldHost {
		t.Fatalf("leaving %+v", l)
	}
	if r := fl.Snapshot(); r.Host != "home.whombat.app" {
		t.Fatalf("link state %+v", r)
	}
	fc.Set(func(f *fakecontrol.Control) {
		if a := f.Addresses["dev-1"]; a.Host != "home.whombat.app" || f.Renamed["dev-1"] != 1 {
			t.Errorf("control: %+v, %d renames", a, f.Renamed["dev-1"])
		}
	})
}
