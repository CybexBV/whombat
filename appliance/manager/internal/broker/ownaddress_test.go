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
	"github.com/CybexBV/whombat/appliance/manager/internal/ownaddress"
	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
	"github.com/CybexBV/whombat/contracts/go/local"
)

// startOA is start with an own-address service (nil: a manager without one).
func startOA(t *testing.T, runtimeUID uint32, on bool) (*fakecontrol.Control, string, *ownaddress.Service) {
	t.Helper()
	w := testworld.New(t)
	fc := fakecontrol.New("dev")
	t.Cleanup(fc.Close)
	pub, priv, _ := ed25519.GenerateKey(nil)
	fc.Devices["dev-1"] = pub
	cc := &controlapi.Client{BaseURL: fc.Server.URL, Env: "dev", DeviceID: "dev-1", Key: priv}
	s := &broker.Server{RuntimeUID: runtimeUID, Control: cc, Engine: w.Engine}
	var svc *ownaddress.Service
	if on {
		st, err := ownaddress.OpenStore(filepath.Join(t.TempDir(), "own-address"))
		if err != nil {
			t.Fatal(err)
		}
		svc, err = ownaddress.Open(ownaddress.Mode{Enabled: true, Zone: "dev.whombat.app", Directory: "https://ca.example.com/dir"}, st, nil)
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
	return fc, sock, svc
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
		local.ManagerPathOwnAddressCt, local.ManagerPathAccountLinkLookup, local.ManagerPathAccountLink, local.ManagerPathKitCredentials} {
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
