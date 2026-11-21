package broker_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/broker"
	"github.com/CybexBV/whombat/appliance/manager/internal/tailscale"
	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// fakeTS is the broker's Tailscale with answers set by the test.
type fakeTS struct {
	state   protocol.TailscaleStatus
	err     error
	signOut *bool
	server  *string
	cert    *local.TailscaleCertResponse
	peers   []local.TailscalePeer
}

func (f *fakeTS) State(context.Context) protocol.TailscaleStatus { return f.state }
func (f *fakeTS) On(_ context.Context, loginServer string) (protocol.TailscaleStatus, error) {
	f.server = &loginServer
	return f.state, f.err
}
func (f *fakeTS) Off(_ context.Context, signOut bool) (protocol.TailscaleStatus, error) {
	f.signOut = &signOut
	return f.state, f.err
}
func (f *fakeTS) SignIn(context.Context) (protocol.TailscaleStatus, error) { return f.state, f.err }
func (f *fakeTS) Cert(context.Context) (*local.TailscaleCertResponse, error) {
	return f.cert, f.err
}
func (f *fakeTS) Peers(context.Context) ([]local.TailscalePeer, error) {
	return f.peers, f.err
}

func startTS(t *testing.T, runtimeUID uint32, supportUIDs []uint32, ts broker.Tailscale) string {
	t.Helper()
	d, err := os.MkdirTemp("", "bt") // a short path: sockets
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(d) })
	s := &broker.Server{RuntimeUID: runtimeUID, SupportUIDs: supportUIDs, Tailscale: ts}
	sock := filepath.Join(d, "api.sock")
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

func TestTailscaleRoutes(t *testing.T) {
	t.Parallel()
	me := uint32(os.Getuid())
	link := "https://login.tailscale.com/a/f00d"
	f := &fakeTS{state: protocol.TailscaleStatus{State: protocol.TailscaleStateNeedsSignIn, LoginURL: &link, Addresses: []string{}}}
	c := client(startTS(t, me, nil, f))

	resp, m := post(t, c, local.ManagerPathTailscaleState, `{"v":1}`)
	if resp.StatusCode != 200 || m["tailscale"].(map[string]any)["loginUrl"] != link {
		t.Fatalf("%d %v", resp.StatusCode, m)
	}
	for _, path := range []string{local.ManagerPathTailscaleOn, local.ManagerPathTailscaleSignIn} {
		if resp, m := post(t, c, path, `{"v":1}`); resp.StatusCode != 200 || m["tailscale"].(map[string]any)["state"] != "needs_sign_in" {
			t.Fatalf("%s: %d %v", path, resp.StatusCode, m)
		}
	}
	if *f.server != "" {
		t.Fatalf("no login server is Tailscale's own: %q", *f.server)
	}
	// The owner's own coordination server (CT-1306, MG-135); one the contract doesn't take is refused before the manager.
	if resp, m := post(t, c, local.ManagerPathTailscaleOn, `{"v":1,"loginServer":"http://10.0.3.1:8080"}`); resp.StatusCode != 200 || *f.server != "http://10.0.3.1:8080" {
		t.Fatalf("%d %v %q", resp.StatusCode, m, *f.server)
	}
	if resp, m := post(t, c, local.ManagerPathTailscaleOn, `{"v":1,"loginServer":"ftp://x"}`); resp.StatusCode != 400 {
		t.Fatalf("%d %v", resp.StatusCode, m)
	}
	f.state = protocol.TailscaleStatus{State: protocol.TailscaleStateOff, Addresses: []string{}}
	if resp, _ := post(t, c, local.ManagerPathTailscaleOff, `{"v":1,"signOut":true}`); resp.StatusCode != 200 || f.signOut == nil || !*f.signOut {
		t.Fatalf("%d %v", resp.StatusCode, f.signOut)
	}
	if resp, _ := post(t, c, local.ManagerPathTailscaleOff, `{"v":1}`); resp.StatusCode != 200 || *f.signOut {
		t.Fatalf("%d %v", resp.StatusCode, *f.signOut)
	}
	// Strict bodies.
	if resp, m := post(t, c, local.ManagerPathTailscaleOn, `{"v":1,"authKey":"tskey-x"}`); resp.StatusCode != 400 {
		t.Fatalf("%d %v", resp.StatusCode, m)
	}
	// The contract's errors.
	for err, want := range map[error][2]any{
		tailscale.ErrBusy:        {409.0, "tailscale.busy"},
		tailscale.ErrOff:         {409.0, "tailscale.off"},
		tailscale.ErrNoHTTPS:     {409.0, "tailscale.no_https"},
		tailscale.ErrUnavailable: {503.0, "unavailable"},
	} {
		f.err = err
		path := local.ManagerPathTailscaleCert
		if err == tailscale.ErrBusy {
			path = local.ManagerPathTailscaleOn
		}
		resp, m := post(t, c, path, `{"v":1}`)
		if float64(resp.StatusCode) != want[0] || m["error"].(map[string]any)["code"] != want[1] {
			t.Fatalf("%v: %d %v", err, resp.StatusCode, m)
		}
	}
	f.err = nil
	f.cert = &local.TailscaleCertResponse{V: 1, Name: "whombat.tail1234.ts.net", CertPem: "c", KeyPem: "k", NotAfter: "2027-01-21T10:00:00Z"}
	if resp, m := post(t, c, local.ManagerPathTailscaleCert, `{"v":1}`); resp.StatusCode != 200 || m["keyPem"] != "k" {
		t.Fatalf("%d %v", resp.StatusCode, m)
	}
	// A state that breaks the contract is never answered.
	f.state = protocol.TailscaleStatus{State: protocol.TailscaleStateOff, LoginURL: &link, Addresses: []string{}}
	if resp, _ := post(t, c, local.ManagerPathTailscaleState, `{"v":1}`); resp.StatusCode != 500 {
		t.Fatal(resp.StatusCode)
	}
	// The tailnet's devices (MG-140): an empty list is a list; one that breaks the contract is never answered.
	f.peers = []local.TailscalePeer{}
	if resp, m := post(t, c, local.ManagerPathTailscalePeers, `{"v":1}`); resp.StatusCode != 200 || len(m["peers"].([]any)) != 0 {
		t.Fatalf("%d %v", resp.StatusCode, m)
	}
	name := "ha.tail1234.ts.net"
	f.peers = []local.TailscalePeer{{Name: &name, Addresses: []string{"100.64.12.10"}, Online: true, Routes: []string{}}}
	if resp, m := post(t, c, local.ManagerPathTailscalePeers, `{"v":1}`); resp.StatusCode != 200 || m["peers"].([]any)[0].(map[string]any)["name"] != name {
		t.Fatalf("%d %v", resp.StatusCode, m)
	}
	f.peers[0].Routes = []string{"no route"}
	if resp, _ := post(t, c, local.ManagerPathTailscalePeers, `{"v":1}`); resp.StatusCode != 500 {
		t.Fatal(resp.StatusCode)
	}
}

// The runtime only (the support service reads the state and the devices), and a manager without Tailscale answers 404 unavailable.
func TestTailscaleCallers(t *testing.T) {
	t.Parallel()
	me := uint32(os.Getuid())
	f := &fakeTS{state: protocol.TailscaleStatus{State: protocol.TailscaleStateOff, Addresses: []string{}}}
	c := client(startTS(t, me+1, []uint32{me}, f))
	if resp, _ := post(t, c, local.ManagerPathTailscaleState, `{"v":1}`); resp.StatusCode != 200 {
		t.Fatal(resp.StatusCode)
	}
	f.peers = []local.TailscalePeer{}
	if resp, _ := post(t, c, local.ManagerPathTailscalePeers, `{"v":1}`); resp.StatusCode != 200 {
		t.Fatal("support's Look reads the tailnet's devices as it reads the state:", resp.StatusCode)
	}
	for _, path := range []string{local.ManagerPathTailscaleOn, local.ManagerPathTailscaleOff, local.ManagerPathTailscaleSignIn,
		local.ManagerPathTailscaleCert} {
		if resp, _ := post(t, c, path, `{"v":1}`); resp.StatusCode != 403 {
			t.Fatalf("%s: %d", path, resp.StatusCode)
		}
	}
	c = client(startTS(t, me, nil, nil))
	if resp, m := post(t, c, local.ManagerPathTailscaleState, `{"v":1}`); resp.StatusCode != 404 || m["error"].(map[string]any)["code"] != "unavailable" {
		t.Fatalf("%d %v", resp.StatusCode, m)
	}
}
