package agent

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"rackoon/internal/proto"
	"rackoon/internal/wire"
)

func TestCheckHelper(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	payload := []byte("helper zip")
	sum := sha256Sum(payload)
	good := proto.UpdateRequest{Component: proto.UpdateComponentHelper, Version: "1.1.0", Arch: proto.HelperArch,
		Size: int64(len(payload)), SHA256: sum, Signature: ed25519.Sign(priv, sum), Team: "AB12CD34EF"}
	_, other, _ := ed25519.GenerateKey(rand.Reader)
	with := func(f func(*proto.UpdateRequest)) proto.UpdateRequest {
		r := good
		f(&r)
		return r
	}
	cases := []struct {
		name      string
		req       proto.UpdateRequest
		key       ed25519.PublicKey
		installed string
		code      string
	}{
		{"newer than installed", good, pub, "1.0.0", ""},
		{"none installed", good, pub, "", ""},
		{"no key", good, nil, "", CodeUpdateDisabled},
		{"same", good, pub, "1.1.0", CodeSameVersion},
		{"same, written otherwise", good, pub, "v1.1.0", CodeSameVersion},
		{"older", good, pub, "1.2.0", CodeOlderVersion},
		{"unknown order", good, pub, "dev", CodeOlderVersion},
		{"bad version", with(func(r *proto.UpdateRequest) { r.Version = "1.0 beta" }), pub, "", CodeInstallFailed},
		{"an agent's arch", with(func(r *proto.UpdateRequest) { r.Arch = runtime.GOARCH }), pub, "", CodeWrongArch},
		{"too big", with(func(r *proto.UpdateRequest) { r.Size = MaxHelperSize + 1 }), pub, "", CodeInstallFailed},
		{"bad team", with(func(r *proto.UpdateRequest) { r.Team = "team; rm" }), pub, "", CodeInstallFailed},
		{"no team", with(func(r *proto.UpdateRequest) { r.Team = "" }), pub, "", ""},
		{"no signature", with(func(r *proto.UpdateRequest) { r.Signature = nil }), pub, "", CodeBadSignature},
		{"another key's", with(func(r *proto.UpdateRequest) { r.Signature = ed25519.Sign(other, sum) }), pub, "", CodeBadSignature},
	}
	for _, c := range cases {
		r := CheckHelper(c.req, c.key, c.installed)
		switch {
		case c.code == "" && r != nil:
			t.Errorf("%s: refused %+v", c.name, r)
		case c.code != "" && (r == nil || r.Code != c.code):
			t.Errorf("%s: %+v, want %s", c.name, r, c.code)
		}
	}
}

// fakeHelperUpdater stands in for the Mac's installer.
type fakeHelperUpdater struct {
	mu      sync.Mutex
	version string
	calls   int
	zip     []byte
	team    string
	answer  *proto.UpdateResponse
}

func (f *fakeHelperUpdater) HelperVersion() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.version
}

func (f *fakeHelperUpdater) InstallHelper(ctx context.Context, zip, version, team string) proto.UpdateResponse {
	b, err := os.ReadFile(zip)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	f.zip, f.team = b, team
	if err != nil {
		return proto.UpdateResponse{Code: CodeInstallFailed, Message: err.Error()}
	}
	if fi, err := os.Stat(zip); err != nil || fi.Mode().Perm() != 0o600 {
		return proto.UpdateResponse{Code: CodeInstallFailed, Message: "the zip isn't root's alone"}
	}
	if f.answer != nil {
		return *f.answer
	}
	f.version = version
	return proto.UpdateResponse{OK: true, Message: "Whombat Helper " + version + " is running."}
}

// sendUpdate opens an update stream, sends req and body, and reads the answer.
func sendUpdate(t *testing.T, side *hubSide, req proto.UpdateRequest, body []byte) proto.UpdateResponse {
	t.Helper()
	st := side.open(t, proto.StreamUpdate)
	defer st.Close()
	if err := wire.WriteMsg(st, req); err != nil {
		t.Fatal(err)
	}
	go func() {
		for len(body) > 0 {
			n := min(len(body), 1<<20)
			if wire.WriteMsg(st, proto.UpdateChunk{Data: body[:n]}) != nil {
				return
			}
			body = body[n:]
		}
	}()
	st.SetReadDeadline(time.Now().Add(20 * time.Second))
	var resp proto.UpdateResponse
	if err := wire.ReadMsg(st, &resp); err != nil {
		t.Fatal(err)
	}
	return resp
}

func TestHelperUpdateStream(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	old := UpdatePublicKey
	UpdatePublicKey = base64.StdEncoding.EncodeToString(pub)
	t.Cleanup(func() { UpdatePublicKey = old })
	t.Setenv("INVOCATION_ID", "")

	h := newFakeHub(t)
	cfg := enrollAgent(t, h)
	exe := filepath.Join(t.TempDir(), "whombat-agent")
	os.WriteFile(exe, fakeAgent("test"), 0o755)
	fh := &fakeHelperUpdater{version: "1.0.0"}
	restarted := make(chan struct{}, 1)
	tr := startRuntime(t, cfg, func(rt *Runtime) {
		rt.Updater = &Updater{Exe: exe, StateDir: cfg.StateDir, Version: "v1", Arch: runtime.GOARCH, Key: pub,
			Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
		rt.Restart = func() { restarted <- struct{}{} }
		rt.Helper = fh
	})
	side := h.waitSide(t)
	if r := recv(t, h.reports, "report"); !slices.Equal(r.Agent.Caps, []string{proto.CapHelperUpdate, proto.CapRestoreIsolate}) {
		t.Fatalf("caps %v", r.Agent.Caps)
	}
	payload := append([]byte("PK helper zip "), make([]byte, 1200<<10)...)
	sum := sha256Sum(payload)
	req := proto.UpdateRequest{Component: proto.UpdateComponentHelper, Version: "1.1.0", Arch: proto.HelperArch,
		Size: int64(len(payload)), SHA256: sum, Signature: ed25519.Sign(priv, sum), Team: "AB12CD34EF"}

	// The host shell is off by default: refused, nothing installed.
	if r := sendUpdate(t, side, req, payload); r.Code != CodeUpdateDisabled || !strings.Contains(r.Message, "host shell") {
		t.Fatalf("host shell off: %+v", r)
	}
	setTOML(t, tr.rt, map[string]string{"host_shell": "true", "allow": "false"})
	if r := sendUpdate(t, side, req, payload); r.Code != CodeUpdateDisabled || !strings.Contains(r.Message, "allow") {
		t.Fatalf("updates off: %+v", r)
	}
	setTOML(t, tr.rt, map[string]string{"allow": "true"})
	older := req
	older.Version = "0.9.0"
	if r := sendUpdate(t, side, older, payload); r.Code != CodeOlderVersion {
		t.Fatalf("older: %+v", r)
	}
	tampered := append([]byte(nil), payload...)
	tampered[3] ^= 1
	if r := sendUpdate(t, side, req, tampered); r.Code != CodeBadSignature {
		t.Fatalf("tampered: %+v", r)
	}
	fh.mu.Lock()
	if fh.calls != 0 {
		t.Fatalf("installer called %d times before a good update", fh.calls)
	}
	fh.mu.Unlock()

	// Installed through the Mac's installer; the agent keeps running.
	if r := sendUpdate(t, side, req, payload); !r.OK || !strings.Contains(r.Message, "1.1.0") {
		t.Fatalf("update: %+v", r)
	}
	fh.mu.Lock()
	if fh.calls != 1 || string(fh.zip) != string(payload) || fh.team != "AB12CD34EF" {
		t.Fatalf("installer got %d calls, %d bytes, team %q", fh.calls, len(fh.zip), fh.team)
	}
	fh.mu.Unlock()
	if _, err := os.Stat(filepath.Join(cfg.StateDir, helperZipName)); !os.IsNotExist(err) {
		t.Fatalf("the received zip is still there: %v", err)
	}
	select {
	case <-restarted:
		t.Fatal("the agent restarted for a helper update")
	case <-time.After(200 * time.Millisecond):
	}
	if r := sendUpdate(t, side, req, payload); r.Code != CodeSameVersion {
		t.Fatalf("again: %+v", r)
	}
	// The installer's own refusal is the answer.
	fh.mu.Lock()
	fh.answer = &proto.UpdateResponse{Code: CodeNoAnswer, Message: "the previous one is back"}
	fh.mu.Unlock()
	next := req
	next.Version = "1.2.0"
	if r := sendUpdate(t, side, next, payload); r.Code != CodeNoAnswer {
		t.Fatalf("no answer: %+v", r)
	}
	// An unknown component.
	odd := req
	odd.Component = "kernel"
	if r := sendUpdate(t, side, odd, payload); r.Code != CodeUnsupported {
		t.Fatalf("unknown component: %+v", r)
	}
}

func TestHelperUpdateNotAMac(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	old := UpdatePublicKey
	UpdatePublicKey = base64.StdEncoding.EncodeToString(pub)
	t.Cleanup(func() { UpdatePublicKey = old })
	h := newFakeHub(t)
	cfg := enrollAgent(t, h)
	tr := startRuntime(t, cfg, nil)
	side := h.waitSide(t)
	if r := recv(t, h.reports, "report"); !slices.Equal(r.Agent.Caps, []string{proto.CapRestoreIsolate}) {
		t.Fatalf("caps without a helper: %v", r.Agent.Caps)
	}
	setTOML(t, tr.rt, map[string]string{"host_shell": "true"})
	payload := []byte("zip")
	sum := sha256Sum(payload)
	req := proto.UpdateRequest{Component: proto.UpdateComponentHelper, Version: "1.1.0", Arch: proto.HelperArch,
		Size: 3, SHA256: sum, Signature: ed25519.Sign(priv, sum)}
	if r := sendUpdate(t, side, req, payload); r.Code != CodeUnsupported {
		t.Fatalf("%+v", r)
	}
}
