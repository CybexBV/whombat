package agent

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"rackoon/internal/proto"
)

// fakeAgent is a "binary" that prints its version like whombat-agent.
func fakeAgent(version string) []byte {
	return []byte("#!/bin/sh\necho \"whombat-agent " + version + "\"\n")
}

type updateFixture struct {
	dir, exe, state string
	pub             ed25519.PublicKey
	priv            ed25519.PrivateKey
	u               *Updater
}

func newUpdateFixture(t *testing.T) *updateFixture {
	t.Helper()
	t.Setenv("INVOCATION_ID", "") // never systemd-run from tests
	dir := t.TempDir()
	f := &updateFixture{dir: dir, exe: filepath.Join(dir, "bin", "whombat-agent"), state: filepath.Join(dir, "state")}
	if err := os.MkdirAll(filepath.Dir(f.exe), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.exe, fakeAgent("v1"), 0o755); err != nil {
		t.Fatal(err)
	}
	f.pub, f.priv, _ = ed25519.GenerateKey(rand.Reader)
	f.u = &Updater{Exe: f.exe, StateDir: f.state, Version: "v1", Arch: runtime.GOARCH, Key: f.pub,
		Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	return f
}

// request signs payload for version.
func (f *updateFixture) request(version string, payload []byte) proto.UpdateRequest {
	sum := sha256.Sum256(payload)
	return proto.UpdateRequest{Version: version, Arch: runtime.GOARCH, Size: int64(len(payload)),
		SHA256: sum[:], Signature: ed25519.Sign(f.priv, sum[:])}
}

// chunks feeds payload in pieces of n bytes, then fails with io.EOF.
func chunks(payload []byte, n int) func() ([]byte, error) {
	return func() ([]byte, error) {
		if len(payload) == 0 {
			return nil, io.EOF
		}
		k := min(n, len(payload))
		c := payload[:k]
		payload = payload[k:]
		return c, nil
	}
}

func TestUpdateCheck(t *testing.T) {
	f := newUpdateFixture(t)
	payload := fakeAgent("v2")
	good := f.request("v2", payload)
	if r := f.u.Check(good); r != nil {
		t.Fatalf("good request: %+v", r)
	}
	cases := map[string]struct {
		mod  func(*proto.UpdateRequest)
		code string
	}{
		"same version":  {func(r *proto.UpdateRequest) { *r = f.request("v1", payload) }, CodeSameVersion},
		"same as v":     {func(r *proto.UpdateRequest) { *r = f.request("1", payload) }, CodeSameVersion},
		"older":         {func(r *proto.UpdateRequest) { *r = f.request("v0.9", payload) }, CodeOlderVersion},
		"order unknown": {func(r *proto.UpdateRequest) { *r = f.request("dev", payload) }, CodeOlderVersion},
		"wrong arch":    {func(r *proto.UpdateRequest) { r.Arch = "riscv64" }, CodeWrongArch},
		"too large":     {func(r *proto.UpdateRequest) { r.Size = MaxUpdateSize + 1 }, CodeInstallFailed},
		"no size":       {func(r *proto.UpdateRequest) { r.Size = 0 }, CodeInstallFailed},
		"bad version":   {func(r *proto.UpdateRequest) { r.Version = "v2; rm -rf /" }, CodeInstallFailed},
		"bad sig": {func(r *proto.UpdateRequest) {
			r.Signature = append([]byte(nil), r.Signature...)
			r.Signature[0] ^= 1
		}, CodeBadSignature},
		"short sig": {func(r *proto.UpdateRequest) { r.Signature = r.Signature[:10] }, CodeBadSignature},
		"wrong key": {func(r *proto.UpdateRequest) {
			_, other, _ := ed25519.GenerateKey(rand.Reader)
			r.Signature = ed25519.Sign(other, r.SHA256)
		}, CodeBadSignature},
	}
	for name, c := range cases {
		req := good
		c.mod(&req)
		if r := f.u.Check(req); r == nil || r.Code != c.code {
			t.Errorf("%s: %+v, want %s", name, r, c.code)
		}
	}
	// The appliance's builds are ordered by their time, not their revision.
	stamped := *f.u
	stamped.Version = "0.0.0-20261018094703.5394c53"
	if r := stamped.Check(f.request("0.0.0-20261020101500.0a1b2c3", payload)); r != nil {
		t.Fatalf("newer build refused: %+v", r)
	}
	if r := stamped.Check(f.request("0.0.0-20261017000000.fffffff", payload)); r == nil || r.Code != CodeOlderVersion {
		t.Fatalf("older build: %+v", r)
	}
	nokey := *f.u
	nokey.Key = nil
	if r := nokey.Check(good); r == nil || r.Code != CodeUpdateDisabled {
		t.Fatalf("no key: %+v", r)
	}
}

func TestUpdateReceive(t *testing.T) {
	f := newUpdateFixture(t)
	payload := append(fakeAgent("v2"), make([]byte, 3<<20)...) // a few chunks
	req := f.request("v2", payload)

	// Truncated stream.
	if _, r := f.u.Receive(req, chunks(payload[:len(payload)-10], 1<<20)); r == nil || r.Code != CodeInstallFailed || !strings.Contains(r.Message, "ended after") {
		t.Fatalf("truncated: %+v", r)
	}
	if _, err := os.Stat(f.exe + ".new"); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("partial file left behind")
	}
	// Tampered content (same size).
	bad := append([]byte(nil), payload...)
	bad[len(bad)-1] = 1
	if _, r := f.u.Receive(req, chunks(bad, 1<<20)); r == nil || r.Code != CodeBadSignature {
		t.Fatalf("tampered: %+v", r)
	}
	// Chunk limits.
	if _, r := f.u.Receive(req, chunks(payload, 2<<20)); r == nil || !strings.Contains(r.Message, "invalid chunk") {
		t.Fatalf("2 MiB chunk: %+v", r)
	}
	short := req
	short.Size = 100
	if _, r := f.u.Receive(short, chunks(payload, 1<<20)); r == nil || !strings.Contains(r.Message, "more data") {
		t.Fatalf("more than announced: %+v", r)
	}
	// Good.
	staged, r := f.u.Receive(req, chunks(payload, 1<<20))
	if r != nil {
		t.Fatalf("good: %+v", r)
	}
	if staged != f.exe+".new" {
		t.Fatalf("staged at %s", staged)
	}
	if fi, _ := os.Stat(staged); fi.Mode().Perm() != 0o755 || fi.Size() != int64(len(payload)) {
		t.Fatalf("staged file %v", fi.Mode())
	}
}

func TestUpdateInstall(t *testing.T) {
	f := newUpdateFixture(t)
	f.u.Flash = filepath.Join(f.dir, "flash", "whombat-agent")
	os.MkdirAll(filepath.Dir(f.u.Flash), 0o700)
	os.WriteFile(f.u.Flash, fakeAgent("v1"), 0o600)
	now := time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)
	f.u.now = func() time.Time { return now }

	// A binary that reports another version is refused; nothing changes.
	payload := fakeAgent("v3")
	staged, r := f.u.Receive(f.request("v2", payload), chunks(payload, 1<<20))
	if r != nil {
		t.Fatal(r)
	}
	if r := f.u.Install(context.Background(), staged, "v2"); r.OK || r.Code != CodeInstallFailed || !strings.Contains(r.Message, `"v3"`) {
		t.Fatalf("wrong version: %+v", r)
	}
	if b, _ := os.ReadFile(f.exe); string(b) != string(fakeAgent("v1")) {
		t.Fatal("executable changed")
	}
	if _, err := os.Stat(markerPath(f.state)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("marker left behind")
	}

	payload = fakeAgent("v2")
	staged, r = f.u.Receive(f.request("v2", payload), chunks(payload, 1<<20))
	if r != nil {
		t.Fatal(r)
	}
	if r := f.u.Install(context.Background(), staged, "v2"); !r.OK {
		t.Fatalf("install: %+v", r)
	}
	for path, want := range map[string]string{f.exe: "v2", f.exe + ".prev": "v1", f.u.Flash: "v2"} {
		if b, _ := os.ReadFile(path); string(b) != string(fakeAgent(want)) {
			t.Errorf("%s: %q, want %s", path, b, want)
		}
	}
	if fi, _ := os.Stat(f.exe); fi.Mode().Perm() != 0o755 {
		t.Fatalf("mode %v", fi.Mode())
	}
	if _, err := os.Stat(staged); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("staged file left")
	}
	m, err := readMarker(f.state)
	if err != nil {
		t.Fatal(err)
	}
	if m.Version != "v2" || m.Previous != "v1" || m.Exe != f.exe || m.Prev != f.exe+".prev" || m.Attempts != 0 ||
		!m.Deadline.Equal(now.Add(UpdateConfirmWindow)) || m.Flash != f.u.Flash {
		t.Fatalf("marker %+v", m)
	}

	// Rolling back restores the previous executable and the flash copy.
	if err := RollBack(m, f.state, "test", f.u.Log); err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string]string{f.exe: "v1", f.u.Flash: "v1"} {
		if b, _ := os.ReadFile(path); string(b) != string(fakeAgent(want)) {
			t.Errorf("after rollback %s: %q, want %s", path, b, want)
		}
	}
	if _, err := os.Stat(markerPath(f.state)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("marker not removed by the rollback")
	}
	if _, err := os.Stat(filepath.Join(f.state, rollbackNoteName)); err != nil {
		t.Fatal("no rollback note for the hub")
	}
}

func TestUpdateReadOnlyDir(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores directory permissions")
	}
	f := newUpdateFixture(t)
	if err := os.Chmod(filepath.Dir(f.exe), 0o555); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(filepath.Dir(f.exe), 0o755)
	payload := fakeAgent("v2")
	staged, r := f.u.Receive(f.request("v2", payload), chunks(payload, 1<<20))
	if r != nil {
		t.Fatal(r)
	}
	if filepath.Dir(staged) != f.state {
		t.Fatalf("staged at %s, want the state dir", staged)
	}
	// Without systemd there is no helper: the install fails cleanly.
	if r := f.u.Install(context.Background(), staged, "v2"); r.OK || r.Code != CodeInstallFailed {
		t.Fatalf("read-only install: %+v", r)
	}
	if _, err := os.Stat(staged); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("staged file left")
	}
	if _, err := os.Stat(markerPath(f.state)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("marker left behind")
	}
	if b, _ := os.ReadFile(f.exe); string(b) != string(fakeAgent("v1")) {
		t.Fatal("executable changed")
	}
}

func TestDecideStart(t *testing.T) {
	now := time.Now()
	m := func(v string, attempts int, deadline time.Time) *PendingUpdate {
		return &PendingUpdate{Version: v, Attempts: attempts, Deadline: deadline}
	}
	cases := []struct {
		m    *PendingUpdate
		want startDecision
	}{
		{nil, startNormal},
		{m("v2", 1, now.Add(time.Minute)), startWatch},
		{m("v2", 3, now.Add(time.Minute)), startWatch},
		{m("v2", 4, now.Add(time.Minute)), startRollback},  // crash loop
		{m("v2", 1, now.Add(-time.Second)), startRollback}, // never connected
		{m("v1", 9, now.Add(-time.Hour)), startStale},      // already rolled back
		{m("v3", 1, now.Add(time.Minute)), startStale},     // someone installed another binary
	}
	for i, c := range cases {
		if got, _ := decideStart(c.m, "v2", now); got != c.want {
			t.Errorf("case %d: %v, want %v", i, got, c.want)
		}
	}
}

func TestCheckPendingUpdate(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	state := t.TempDir()
	if m, err := CheckPendingUpdate(state, "v2", log); m != nil || err != nil {
		t.Fatal("no marker")
	}
	writeMarker(state, &PendingUpdate{Version: "v2", Previous: "v1", Deadline: time.Now().Add(time.Minute)})
	for i := 1; i <= 3; i++ {
		m, err := CheckPendingUpdate(state, "v2", log)
		if err != nil || m == nil || m.Attempts != i {
			t.Fatalf("start %d: %+v %v", i, m, err)
		}
	}
	if m, _ := readMarker(state); m.Attempts != 3 {
		t.Fatalf("attempts not persisted: %+v", m)
	}
	// The previous version starting (after a rollback) drops the marker.
	if m, _ := CheckPendingUpdate(state, "v1", log); m != nil {
		t.Fatal("stale marker returned")
	}
	if _, err := os.Stat(markerPath(state)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("stale marker kept")
	}
	// A rollback whose previous executable is gone keeps the new version.
	writeMarker(state, &PendingUpdate{Version: "v2", Previous: "v1", Exe: filepath.Join(state, "x"), Prev: filepath.Join(state, "gone"),
		Attempts: 3, Deadline: time.Now().Add(time.Minute)})
	if m, err := CheckPendingUpdate(state, "v2", log); m != nil || err != nil {
		t.Fatalf("failed rollback: %+v %v", m, err)
	}
	if _, err := os.Stat(markerPath(state)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("marker kept after a failed rollback")
	}
}

func TestUpdateKeyFingerprint(t *testing.T) {
	old := UpdatePublicKey
	defer func() { UpdatePublicKey = old }()
	UpdatePublicKey = ""
	if UpdateKeyFingerprint() != "" {
		t.Fatal("fingerprint without a key")
	}
	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	UpdatePublicKey = base64.StdEncoding.EncodeToString(pub)
	fp := UpdateKeyFingerprint()
	if len(fp) != 16 || fp != KeyFingerprint(pub) {
		t.Fatalf("fingerprint %q", fp)
	}
	UpdatePublicKey = "not base64!"
	if UpdateKeyFingerprint() != "" {
		t.Fatal("malformed key accepted")
	}
	if reportedVersion("whombat-agent v1.2.3\n") != "v1.2.3" || reportedVersion("rackoon-agent v1.2.2\n") != "v1.2.2" || reportedVersion("other v1") != "" {
		t.Fatal("reportedVersion")
	}
}
