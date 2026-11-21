package tailscale

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// fakeTailscaled answers the local API calls the manager makes, on a unix socket.
type fakeTailscaled struct {
	t     *testing.T
	mu    sync.Mutex
	st    rawStatus
	prefs rawPrefs
	// login is what login-interactive sets as AuthURL ("" leaves none: no control reachable).
	login string
	calls []string
	pair  []byte
	// started is the last start's UpdatePrefs.
	started map[string]any
	// peers is the status's Peer map (tailscaled's ipnstate.PeerStatus by node key).
	peers map[string]any
	// patches are the masked prefs of every PATCH prefs; patchFails refuses them.
	patches    []map[string]any
	patchFails bool
	// profileID is the current profile's id: "" until tailscaled has saved it (a sign-in, a moment after Running).
	profileID string
}

func startFake(t *testing.T, f *fakeTailscaled) string {
	t.Helper()
	sock := filepath.Join(t.TempDir(), "ts.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(f.serve)}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
	return sock
}

func (f *fakeTailscaled) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.Host != localAPIHost {
		http.Error(w, "bad host", http.StatusForbidden)
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/localapi/v0/")
	f.calls = append(f.calls, r.Method+" "+path)
	switch {
	case path == "status" && r.Method == http.MethodGet:
		if r.URL.Query().Get("peers") == "false" {
			json.NewEncoder(w).Encode(f.st)
			return
		}
		json.NewEncoder(w).Encode(struct {
			rawStatus
			Peer map[string]any
		}{f.st, f.peers})
	case path == "prefs" && r.Method == http.MethodGet:
		// More than the manager reads: start must hand all of it back.
		json.NewEncoder(w).Encode(map[string]any{"WantRunning": f.prefs.WantRunning, "LoggedOut": f.prefs.LoggedOut,
			"ControlURL": f.prefs.ControlURL, "OperatorUser": "whombat-manager", "Hostname": "whombat",
			"ExitNodeID": f.prefs.ExitNodeID, "ExitNodeIP": f.prefs.ExitNodeIP, "AdvertiseRoutes": f.prefs.AdvertiseRoutes,
			"RunSSH": f.prefs.RunSSH, "RunWebClient": f.prefs.RunWebClient, "ShieldsUp": f.prefs.ShieldsUp,
			"RouteAll": f.prefs.RouteAll})
	case path == "start" && r.Method == http.MethodPost:
		// ipn.Options{UpdatePrefs}: whole prefs, the control client started again on its server.
		var o struct{ UpdatePrefs map[string]any }
		if err := json.NewDecoder(r.Body).Decode(&o); err != nil || o.UpdatePrefs == nil {
			http.Error(w, "bad start", 400)
			return
		}
		f.started = o.UpdatePrefs
		f.prefs.ControlURL, _ = o.UpdatePrefs["ControlURL"].(string)
		f.prefs.WantRunning, _ = o.UpdatePrefs["WantRunning"].(bool)
		f.prefs.LoggedOut, _ = o.UpdatePrefs["LoggedOut"].(bool)
		f.st = rawStatus{BackendState: "NeedsLogin"}
		w.WriteHeader(http.StatusNoContent)
	case path == "prefs" && r.Method == http.MethodPatch:
		if f.patchFails {
			http.Error(w, "refused", http.StatusInternalServerError)
			return
		}
		var mp map[string]any
		if err := json.NewDecoder(r.Body).Decode(&mp); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		f.patches = append(f.patches, mp)
		set := func(k string) bool { b, _ := mp[k+"Set"].(bool); return b }
		if set("WantRunning") {
			f.prefs.WantRunning, _ = mp["WantRunning"].(bool)
		}
		if set("LoggedOut") {
			f.prefs.LoggedOut, _ = mp["LoggedOut"].(bool)
		}
		if set("ExitNodeID") {
			f.prefs.ExitNodeID, _ = mp["ExitNodeID"].(string)
		}
		if set("ExitNodeIP") {
			f.prefs.ExitNodeIP, _ = mp["ExitNodeIP"].(string)
		}
		if set("AdvertiseRoutes") {
			f.prefs.AdvertiseRoutes = nil
			routes, _ := mp["AdvertiseRoutes"].([]any)
			for _, r := range routes {
				f.prefs.AdvertiseRoutes = append(f.prefs.AdvertiseRoutes, r.(string))
			}
		}
		for k, p := range map[string]*bool{"RunSSH": &f.prefs.RunSSH, "RunWebClient": &f.prefs.RunWebClient, "ShieldsUp": &f.prefs.ShieldsUp, "RouteAll": &f.prefs.RouteAll} {
			if set(k) {
				*p, _ = mp[k].(bool)
			}
		}
		if !f.prefs.WantRunning && f.st.BackendState == "Running" {
			f.st.BackendState = "Stopped"
		}
		json.NewEncoder(w).Encode(f.prefs)
	case path == "profiles/current" && r.Method == http.MethodGet:
		json.NewEncoder(w).Encode(map[string]any{"ID": f.profileID, "Name": "", "Key": ""})
	case path == "login-interactive" && r.Method == http.MethodPost:
		f.st.AuthURL = f.login
		w.WriteHeader(http.StatusNoContent)
	case path == "logout" && r.Method == http.MethodPost:
		f.st = rawStatus{BackendState: "NeedsLogin"}
		f.prefs.LoggedOut = true
		w.WriteHeader(http.StatusNoContent)
	case strings.HasPrefix(path, "cert/") && r.URL.Query().Get("type") == "pair":
		w.Write(f.pair)
	default:
		http.Error(w, "unexpected "+r.Method+" "+path, http.StatusNotFound)
	}
}

func (f *fakeTailscaled) callsSoFar() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string{}, f.calls...)
}

func newManager(t *testing.T, sock string, log *slog.Logger) *Manager {
	return New(Config{Socket: sock, Log: log, Settle: 200 * time.Millisecond, Poll: 20 * time.Millisecond})
}

func valid(t *testing.T, s protocol.TailscaleStatus) {
	t.Helper()
	if !Valid(s) {
		t.Fatalf("not valid: %+v", s)
	}
	resp := local.TailscaleStateResponse{V: 1, Tailscale: s}
	if err := resp.Validate(); err != nil {
		t.Fatalf("%+v: %v", s, err)
	}
}

func str(s string) *string { return &s }

func runningAs(name string, certs ...string) rawStatus {
	st := rawStatus{BackendState: "Running", CertDomains: certs}
	st.Self = &struct {
		DNSName      string
		TailscaleIPs []string
	}{DNSName: name, TailscaleIPs: []string{"fd7a:115c:a1e0::1", "100.101.102.103"}}
	st.CurrentTailnet = &struct{ Name string }{Name: " john@example.com​ "}
	return st
}

func TestStatusOf(t *testing.T) {
	for _, tc := range []struct {
		name  string
		st    rawStatus
		want  bool
		state protocol.TailscaleState
	}{
		{"fresh box", rawStatus{BackendState: "NeedsLogin"}, false, protocol.TailscaleStateOff},
		{"on, no link yet", rawStatus{BackendState: "NeedsLogin"}, true, protocol.TailscaleStateStarting},
		{"link", rawStatus{BackendState: "NeedsLogin", AuthURL: "https://login.tailscale.com/a/abc123"}, true, protocol.TailscaleStateNeedsSignIn},
		{"not a link", rawStatus{BackendState: "NeedsLogin", AuthURL: "ftp://login.tailscale.com/a/x"}, false, protocol.TailscaleStateOff},
		{"an own server's link", rawStatus{BackendState: "NeedsLogin", AuthURL: "http://10.0.3.1:8080/register/mkey:ab12"}, true, protocol.TailscaleStateNeedsSignIn},
		{"approval", rawStatus{BackendState: "NeedsMachineAuth"}, true, protocol.TailscaleStateNeedsApproval},
		{"stopped", rawStatus{BackendState: "Stopped"}, false, protocol.TailscaleStateOff},
		{"starting", rawStatus{BackendState: "Starting"}, true, protocol.TailscaleStateStarting},
		{"no state", rawStatus{BackendState: "NoState"}, false, protocol.TailscaleStateOff},
		{"running", runningAs("Whombat-R7M4.tail1234.ts.net.", "whombat-r7m4.tail1234.ts.net"), true, protocol.TailscaleStateOn},
		{"bad name", runningAs("not a name."), true, protocol.TailscaleStateError},
		{"unknown", rawStatus{BackendState: "InUseOtherUser"}, true, protocol.TailscaleStateError},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := statusOf(&tc.st, &rawPrefs{WantRunning: tc.want})
			if s.State != tc.state {
				t.Fatalf("%+v", s)
			}
			valid(t, s)
		})
	}
	s := statusOf(&rawStatus{BackendState: "NeedsLogin", AuthURL: "https://login.tailscale.com/a/abc123"}, &rawPrefs{WantRunning: true})
	if s.LoginURL == nil || *s.LoginURL != "https://login.tailscale.com/a/abc123" {
		t.Fatalf("%+v", s)
	}
	// Turned off with the link still pending (MG-139): off, no link.
	s = statusOf(&rawStatus{BackendState: "NeedsLogin", AuthURL: "https://login.tailscale.com/a/abc123"}, &rawPrefs{})
	if s.State != protocol.TailscaleStateOff || s.LoginURL != nil {
		t.Fatalf("%+v", s)
	}
	st := runningAs("Whombat-R7M4.tail1234.ts.net.", "whombat-r7m4.tail1234.ts.net")
	s = statusOf(&st, &rawPrefs{WantRunning: true})
	if *s.Name != "whombat-r7m4.tail1234.ts.net" || !s.Https || *s.Tailnet != "john@example.com" ||
		strings.Join(s.Addresses, ",") != "100.101.102.103,fd7a:115c:a1e0::1" {
		t.Fatalf("%+v", s)
	}
	st = runningAs("whombat-r7m4.tail1234.ts.net.")
	if s := statusOf(&st, &rawPrefs{WantRunning: true}); s.Https {
		t.Fatalf("no certificate domains: %+v", s)
	}
}

func TestNotRunning(t *testing.T) {
	m := newManager(t, filepath.Join(t.TempDir(), "none.sock"), nil)
	s := m.State(context.Background())
	if s.State != protocol.TailscaleStateError || s.Problem == nil || *s.Problem != protocol.TailscaleProblemNotRunning {
		t.Fatalf("%+v", s)
	}
	valid(t, s)
	if _, err := m.On(context.Background(), ""); !errors.Is(err, ErrUnavailable) {
		t.Fatal(err)
	}
	if _, err := m.Cert(context.Background()); !errors.Is(err, ErrUnavailable) {
		t.Fatal(err)
	}
}

// A fresh box: on asks for a sign-in and comes back with Tailscale's link; off and sign-out (CT-1254).
func TestOnSignInOff(t *testing.T) {
	f := &fakeTailscaled{t: t, st: rawStatus{BackendState: "NeedsLogin"}, login: "https://login.tailscale.com/a/f00d"}
	m := newManager(t, startFake(t, f), nil)
	ctx := context.Background()
	if s := m.State(ctx); s.State != protocol.TailscaleStateOff {
		t.Fatalf("%+v", s)
	}
	s, err := m.On(ctx, "")
	if err != nil || s.State != protocol.TailscaleStateNeedsSignIn || *s.LoginURL != "https://login.tailscale.com/a/f00d" {
		t.Fatalf("%+v %v", s, err)
	}
	valid(t, s)
	if !f.prefs.WantRunning {
		t.Fatal("not wanted running")
	}
	if got := strings.Join(f.callsSoFar(), "|"); !strings.Contains(got, "PATCH prefs|GET status|GET prefs|POST login-interactive") {
		t.Fatal(got)
	}
	// The owner signed in: on comes back as it was, without a new link.
	f.mu.Lock()
	f.st, f.calls = runningAs("whombat-r7m4.tail1234.ts.net."), nil
	f.mu.Unlock()
	if s, err := m.On(ctx, ""); err != nil || s.State != protocol.TailscaleStateOn {
		t.Fatalf("%+v %v", s, err)
	}
	for _, c := range f.callsSoFar() {
		if c == "POST login-interactive" {
			t.Fatal("asked for a link while signed in")
		}
	}
	// A fresh link always asks.
	f.login = "https://login.tailscale.com/a/beef"
	f.mu.Lock()
	f.st.BackendState, f.st.Self = "NeedsLogin", nil
	f.mu.Unlock()
	if s, err := m.SignIn(ctx); err != nil || s.LoginURL == nil || *s.LoginURL != "https://login.tailscale.com/a/beef" {
		t.Fatalf("%+v %v", s, err)
	}
	// Off keeps the sign-in; off with sign-out leaves the tailnet.
	f.mu.Lock()
	f.st = runningAs("whombat-r7m4.tail1234.ts.net.")
	f.mu.Unlock()
	if s, err := m.Off(ctx, false); err != nil || s.State != protocol.TailscaleStateOff || f.prefs.LoggedOut {
		t.Fatalf("%+v %v %+v", s, err, f.prefs)
	}
	if s, err := m.Off(ctx, true); err != nil || s.State != protocol.TailscaleStateOff || !f.prefs.LoggedOut {
		t.Fatalf("%+v %v %+v", s, err, f.prefs)
	}
}

// No control reachable: on answers starting (a link may follow in the state), not an error.
func TestOnWithoutLink(t *testing.T) {
	f := &fakeTailscaled{t: t, st: rawStatus{BackendState: "NeedsLogin"}}
	m := newManager(t, startFake(t, f), nil)
	s, err := m.On(context.Background(), "")
	if err != nil || s.State != protocol.TailscaleStateStarting {
		t.Fatalf("%+v %v", s, err)
	}
	valid(t, s)
}

func TestBusy(t *testing.T) {
	f := &fakeTailscaled{t: t, st: rawStatus{BackendState: "NeedsLogin"}}
	m := newManager(t, startFake(t, f), nil)
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, op := range []func() error{
		func() error { _, err := m.On(context.Background(), ""); return err },
		func() error { _, err := m.Off(context.Background(), false); return err },
		func() error { _, err := m.SignIn(context.Background()); return err },
	} {
		if err := op(); !errors.Is(err, ErrBusy) {
			t.Fatal(err)
		}
	}
	// A read is never busy.
	if s := m.State(context.Background()); s.State != protocol.TailscaleStateOff {
		t.Fatalf("%+v", s)
	}
}

func selfSigned(t *testing.T, name string) []byte {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: name}, DNSNames: []string{name},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Date(2027, 1, 21, 10, 0, 0, 0, time.UTC)}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	kd, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	out := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kd})
	return append(out, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})...)
}

func TestCert(t *testing.T) {
	const name = "whombat-r7m4.tail1234.ts.net"
	f := &fakeTailscaled{t: t, st: rawStatus{BackendState: "NeedsLogin"}, pair: selfSigned(t, name)}
	var logs bytes.Buffer
	m := newManager(t, startFake(t, f), slog.New(slog.NewTextHandler(&logs, nil)))
	ctx := context.Background()
	if _, err := m.Cert(ctx); !errors.Is(err, ErrOff) {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.st = runningAs(name + ".")
	f.mu.Unlock()
	if _, err := m.Cert(ctx); !errors.Is(err, ErrNoHTTPS) {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.st = runningAs(name+".", name)
	f.mu.Unlock()
	c, err := m.Cert(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if c.Name != name || c.NotAfter != "2027-01-21T10:00:00Z" || !strings.Contains(c.KeyPem, "PRIVATE KEY") ||
		!strings.HasPrefix(c.CertPem, "-----BEGIN CERTIFICATE-----") || strings.Contains(c.CertPem, "PRIVATE") {
		t.Fatalf("%+v", c)
	}
	// A certificate for another name, or an answer without a key, is refused; the key never reaches a log line.
	f.mu.Lock()
	f.pair = selfSigned(t, "other.tail1234.ts.net")
	f.mu.Unlock()
	if _, err := m.Cert(ctx); !errors.Is(err, ErrUnavailable) {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.pair = f.pair[bytes.Index(f.pair, []byte("-----BEGIN CERTIFICATE")):]
	f.mu.Unlock()
	if _, err := m.Cert(ctx); !errors.Is(err, ErrUnavailable) {
		t.Fatal(err)
	}
	if strings.Contains(logs.String(), "PRIVATE") {
		t.Fatal(logs.String())
	}
}

// The owner's own coordination server (contracts 1.1.0 CT-1306, MG-135): another server starts tailscaled again on it
// with a fresh sign-in, keeping the rest of its prefs (the operator above all), and the state names it; the same server
// again changes nothing; Tailscale's own again goes back.
func TestOnLoginServer(t *testing.T) {
	const hs = "http://10.0.3.1:8080"
	f := &fakeTailscaled{t: t, st: runningAs("whombat-r7m4.tail1234.ts.net."), prefs: rawPrefs{WantRunning: true},
		login: hs + "/register/mkey:ab12"}
	m := newManager(t, startFake(t, f), nil)
	ctx := context.Background()
	if s := m.State(ctx); s.LoginServer != nil {
		t.Fatalf("Tailscale's own is no login server: %+v", s)
	}
	s, err := m.On(ctx, hs)
	if err != nil || s.State != protocol.TailscaleStateNeedsSignIn || *s.LoginURL != hs+"/register/mkey:ab12" ||
		s.LoginServer == nil || *s.LoginServer != hs {
		t.Fatalf("%+v %v", s, err)
	}
	valid(t, s)
	if f.started["OperatorUser"] != "whombat-manager" || f.started["Hostname"] != "whombat" || f.started["ControlURL"] != hs ||
		f.started["WantRunning"] != true || f.started["LoggedOut"] != false {
		t.Fatalf("start lost prefs: %v", f.started)
	}
	if got := strings.Join(f.callsSoFar(), "|"); !strings.Contains(got, "POST start|POST login-interactive") || strings.Contains(got, "logout") {
		t.Fatal(got)
	}
	// Signed in on it: on with the same server comes back as it was.
	f.mu.Lock()
	f.st, f.calls, f.started = runningAs("whombat.hs.test."), nil, nil
	f.mu.Unlock()
	if s, err := m.On(ctx, hs); err != nil || s.State != protocol.TailscaleStateOn || *s.LoginServer != hs || f.started != nil {
		t.Fatalf("%+v %v %v", s, err, f.started)
	}
	// Back to Tailscale's own.
	f.login = "https://login.tailscale.com/a/f00d"
	if s, err := m.On(ctx, ""); err != nil || s.LoginServer != nil || f.started["ControlURL"] != DefaultControlURL {
		t.Fatalf("%+v %v %v", s, err, f.started)
	}
	// Not an address the contract takes: refused before tailscaled.
	f.mu.Lock()
	f.calls = nil
	f.mu.Unlock()
	for _, bad := range []string{"ftp://x", "http://user:pw@hs.test", "http://HS.test", "http://hs.test/", "http://hs.test?x=1"} {
		if _, err := m.On(ctx, bad); !errors.Is(err, ErrLoginServer) {
			t.Fatalf("%s: %v", bad, err)
		}
	}
	if len(f.callsSoFar()) != 0 {
		t.Fatal(f.callsSoFar())
	}
	if serverOf("https://controlplane.tailscale.com/") != "" || serverOf("https://login.tailscale.com") != "" || serverOf(hs+"/") != hs {
		t.Fatal("serverOf")
	}
}

// MG-138: a box that is on keeps no exit node, advertises nothing and runs no SSH or web client, whoever set them; the
// state puts it back once, on and sign-in send it with their change, and a refusal isn't asked again on every read.
func TestKept(t *testing.T) {
	f := &fakeTailscaled{t: t, st: runningAs("whombat-r7m4.tail1234.ts.net."), prefs: rawPrefs{WantRunning: true,
		ExitNodeID: "nExit", AdvertiseRoutes: []string{"10.9.0.0/24"}, RunWebClient: true, ShieldsUp: true}}
	m := newManager(t, startFake(t, f), nil)
	ctx := context.Background()
	if s := m.State(ctx); s.State != protocol.TailscaleStateOn {
		t.Fatalf("%+v", s)
	}
	f.mu.Lock()
	p, n := f.prefs, len(f.patches)
	f.mu.Unlock()
	if !p.keeps() || n != 1 || !p.WantRunning || !p.RouteAll {
		t.Fatalf("not kept: %+v (%d patches)", p, n)
	}
	m.State(ctx)
	if len(f.patches) != 1 {
		t.Fatalf("patched again: %d", len(f.patches))
	}
	// Signed out (not running): nothing to keep yet.
	f.mu.Lock()
	f.st, f.prefs.ShieldsUp = rawStatus{BackendState: "NeedsLogin"}, true
	f.mu.Unlock()
	m.State(ctx)
	if len(f.patches) != 1 {
		t.Fatal("patched a signed-out box")
	}
	// On and sign-in carry it with their own change.
	for _, change := range []func() (protocol.TailscaleStatus, error){
		func() (protocol.TailscaleStatus, error) { return m.On(ctx, "") },
		func() (protocol.TailscaleStatus, error) { return m.SignIn(ctx) },
	} {
		f.mu.Lock()
		f.prefs.ShieldsUp, f.patches = true, nil
		f.mu.Unlock()
		if _, err := change(); err != nil {
			t.Fatal(err)
		}
		if f.prefs.ShieldsUp || len(f.patches) == 0 || f.patches[0]["WantRunning"] != true || f.patches[0]["ShieldsUpSet"] != true {
			t.Fatalf("%+v %+v", f.prefs, f.patches)
		}
	}
	// A refusal is tried again only after keepRetry.
	f.mu.Lock()
	f.st, f.prefs.RunWebClient, f.patchFails, f.patches = runningAs("whombat-r7m4.tail1234.ts.net."), true, true, nil
	f.mu.Unlock()
	m.State(ctx)
	m.State(ctx)
	if got := strings.Count(strings.Join(f.callsSoFar(), "|"), "PATCH prefs"); got < 1 {
		t.Fatal("never tried")
	}
	before := strings.Count(strings.Join(f.callsSoFar(), "|"), "PATCH prefs")
	m.State(ctx)
	if after := strings.Count(strings.Join(f.callsSoFar(), "|"), "PATCH prefs"); after != before {
		t.Fatalf("asked again at once: %d → %d", before, after)
	}
}

// A new login server starts tailscaled again with kept in the whole prefs.
func TestKeptOnNewServer(t *testing.T) {
	f := &fakeTailscaled{t: t, st: rawStatus{BackendState: "NeedsLogin"}, prefs: rawPrefs{ShieldsUp: true}}
	m := newManager(t, startFake(t, f), nil)
	if _, err := m.On(context.Background(), "https://headscale.example.net"); err != nil {
		t.Fatal(err)
	}
	if f.started["ShieldsUp"] != false || f.started["RunWebClient"] != false || f.started["ExitNodeID"] != "" {
		t.Fatalf("%+v", f.started)
	}
	for k := range f.started {
		if strings.HasSuffix(k, "Set") {
			t.Fatalf("a mask in whole prefs: %s", k)
		}
	}
}

// MG-139: a box that needs a sign-in nobody asked for (its key ran out) gets a link by itself, once a minute at most;
// one that was turned off with a link pending reads as off.
func TestSignedOutByTheTailnet(t *testing.T) {
	f := &fakeTailscaled{t: t, st: rawStatus{BackendState: "NeedsLogin"}, prefs: rawPrefs{WantRunning: true},
		login: "https://login.tailscale.com/a/c0ffee"}
	m := newManager(t, startFake(t, f), nil)
	m.linkGrace = 0 // TestNoLinkRightAfterASignIn has the wait
	ctx := context.Background()
	if s := m.State(ctx); s.State != protocol.TailscaleStateStarting {
		t.Fatalf("%+v", s)
	}
	s := m.State(ctx)
	if s.State != protocol.TailscaleStateNeedsSignIn || s.LoginURL == nil || *s.LoginURL != "https://login.tailscale.com/a/c0ffee" {
		t.Fatalf("%+v", s)
	}
	valid(t, s)
	f.mu.Lock()
	f.st.AuthURL = ""
	f.mu.Unlock()
	m.State(ctx)
	if got := strings.Count(strings.Join(f.callsSoFar(), "|"), "login-interactive"); got != 1 {
		t.Fatalf("asked %d times within a minute", got)
	}
	// Off with the link still there: off.
	f.mu.Lock()
	f.st.AuthURL, f.prefs.WantRunning = "https://login.tailscale.com/a/c0ffee", false
	f.mu.Unlock()
	if s := m.State(ctx); s.State != protocol.TailscaleStateOff || s.LoginURL != nil {
		t.Fatalf("%+v", s)
	}
}

// MG-140: the tailnet's other devices, online first, Mullvad's exit nodes left out, what the contract refuses dropped.
func TestPeers(t *testing.T) {
	f := &fakeTailscaled{t: t, st: runningAs("whombat.tail1234.ts.net."), peers: map[string]any{
		"nodekey:1": map[string]any{"DNSName": "blackbox.tail1234.ts.net.", "OS": "linux", "TailscaleIPs": []string{"fd7a:115c:a1e0::b801:9262", "100.64.12.11"},
			"Online": false, "LastSeen": "2026-10-30T15:21:30Z", "PrimaryRoutes": []string{"10.100.0.0/23", "not a route"}, "ExitNodeOption": true},
		"nodekey:2": map[string]any{"DNSName": "ha.tail1234.ts.net.", "OS": "linux", "TailscaleIPs": []string{"100.64.12.10"}, "Online": true,
			"LastSeen": "0001-01-01T00:00:00Z"},
		"nodekey:3": map[string]any{"DNSName": "nl-ams-wg-001.mullvad.ts.net.", "OS": "linux", "TailscaleIPs": []string{"100.65.0.1"},
			"Online": true, "ExitNodeOption": true, "Location": map[string]any{"Country": "Netherlands"}},
		"nodekey:4": map[string]any{"DNSName": "", "OS": "iOS", "TailscaleIPs": []string{"100.64.12.12"}, "Online": true},
	}}
	m := newManager(t, startFake(t, f), nil)
	peers, err := m.Peers(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	resp := local.TailscalePeersResponse{V: 1, Peers: peers}
	if err := resp.Validate(); err != nil {
		t.Fatal(err)
	}
	if len(peers) != 3 || peers[0].Name != nil || *peers[1].Name != "ha.tail1234.ts.net" || *peers[2].Name != "blackbox.tail1234.ts.net" {
		t.Fatalf("%+v", peers)
	}
	b := peers[2]
	if b.Online || b.LastSeen == nil || *b.LastSeen != "2026-10-30T15:21:30Z" || !b.ExitNode ||
		len(b.Routes) != 1 || b.Routes[0] != "10.100.0.0/23" || b.Addresses[0] != "100.64.12.11" {
		t.Fatalf("%+v", b)
	}
	if peers[1].LastSeen != nil {
		t.Fatalf("an online device has no last seen: %+v", peers[1])
	}
	// Signed out: none.
	f.mu.Lock()
	f.st = rawStatus{BackendState: "NeedsLogin"}
	f.mu.Unlock()
	if peers, err := m.Peers(context.Background()); err != nil || len(peers) != 0 || peers == nil {
		t.Fatalf("%+v %v", peers, err)
	}
}
