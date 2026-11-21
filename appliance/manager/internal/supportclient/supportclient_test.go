package supportclient_test

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/supportclient"
	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// hostKey is an ssh-ed25519 public key line for a fresh key.
func hostKey(t *testing.T) string {
	t.Helper()
	pub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	var b []byte
	for _, part := range [][]byte{[]byte("ssh-ed25519"), pub} {
		b = binary.BigEndian.AppendUint32(b, uint32(len(part)))
		b = append(b, part...)
	}
	return "ssh-ed25519 " + base64.StdEncoding.EncodeToString(b)
}

// fakeService serves answer on GET /v1/state with status, on a socket in a short temporary directory.
func fakeService(t *testing.T, status int, answer string) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "sup")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	sock := filepath.Join(dir, "api.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != local.SupportPathState {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(answer))
	})}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
	return sock
}

var now = time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC)

// stateJSON is a prod box's whole SupportState, help code and names included: the manager keeps none of those.
func stateJSON(key, until string, connected int) string {
	k := "null"
	if key != "" {
		k = `"` + key + `"`
	}
	conns := make([]string, connected)
	for i := range conns {
		conns[i] = fmt.Sprintf(`{"visitId":"v%d","who":"Claude","since":"2026-10-21T11:00:00Z"}`, i+1)
	}
	return `{"v":1,"available":true,"foreverAllowed":false,"helpCodeRequired":true,"environment":"prod","hostKey":` + k +
		`,"grant":{"level":"fix","since":"2026-10-21T10:00:00Z","until":"` + until +
		`","grantedBy":{"accountId":"acc_1","name":"John"},"helpCode":"KQ72MX","wrongCodes":0},"connected":[` +
		strings.Join(conns, ",") + `]}`
}

func TestState(t *testing.T) {
	key := hostKey(t)
	sock := fakeService(t, 200, stateJSON(key, "2026-10-21T14:00:00Z", 2))
	st, err := supportclient.Client{Socket: sock}.State(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	r := supportclient.Report(st, now)
	if r.State != "fix" || r.UntilS == nil || *r.UntilS != 7200 || r.Connected != 2 || !r.HelpCode || r.HostKey == nil || *r.HostKey != key {
		t.Fatalf("%+v", r)
	}
	// RH-09: metadata only — no help code, no names, in what the manager keeps or sends.
	for _, v := range []any{st, r} {
		b, _ := json.Marshal(v)
		if strings.Contains(string(b), "KQ72MX") || strings.Contains(string(b), "John") || strings.Contains(string(b), "Claude") {
			t.Fatalf("kept %s", b)
		}
	}
	// A host key with a comment is taken bare (control takes the bare key only).
	commented := strings.Replace(stateJSON(key, "2026-10-21T14:00:00Z", 0), key, " "+key+" root@whombat\\n", 1)
	st, err = supportclient.Client{Socket: fakeService(t, 200, commented)}.State(context.Background())
	if err != nil || st.HostKey == nil || *st.HostKey != key {
		t.Fatalf("%v %v", st, err)
	}
}

// The support service gives the manager its state without the help code (NX-414): still the contract's state.
func TestStateWithoutTheCode(t *testing.T) {
	key := hostKey(t)
	redacted := strings.Replace(stateJSON(key, "2026-10-21T14:00:00Z", 1), `"helpCode":"KQ72MX"`, `"helpCode":null`, 1)
	st, err := supportclient.Client{Socket: fakeService(t, 200, redacted)}.State(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if r := supportclient.Report(st, now); r.State != "fix" || !r.HelpCode || r.Connected != 1 {
		t.Fatalf("%+v", r)
	}
}

func TestStateRefused(t *testing.T) {
	ok := stateJSON("", "2026-10-21T14:00:00Z", 0)
	for name, tc := range map[string]struct {
		status int
		answer string
	}{
		"forbidden":            {403, `{"error":{"code":"forbidden"}}`},
		"not json":             {200, `{`},
		"another level":        {200, strings.Replace(ok, `"fix"`, `"root"`, 1)},
		"another environment":  {200, strings.Replace(ok, `"prod"`, `"staging"`, 1)},
		"until not a time":     {200, strings.Replace(ok, `2026-10-21T14:00:00Z`, `tomorrow`, 1)},
		"a help code off prod": {200, strings.Replace(strings.Replace(strings.Replace(ok, `"prod"`, `"local"`, 1), `"helpCodeRequired":true`, `"helpCodeRequired":false`, 1), `"foreverAllowed":false`, `"foreverAllowed":true`, 1)},
		"forever on prod":      {200, strings.Replace(ok, `"2026-10-21T14:00:00Z"`, `null`, 1)},
		"too large":            {200, `{"v":1,"pad":"` + strings.Repeat("x", 70<<10) + `"}`},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := supportclient.Client{Socket: fakeService(t, tc.status, tc.answer)}.State(context.Background())
			if err == nil || errors.Is(err, supportclient.ErrAbsent) {
				t.Fatalf("%v", err)
			}
			if strings.Contains(err.Error(), "KQ72MX") {
				t.Fatalf("the error repeats the answer: %v", err)
			}
		})
	}
	_, err := supportclient.Client{Socket: filepath.Join(t.TempDir(), "none.sock")}.State(context.Background())
	if !errors.Is(err, supportclient.ErrAbsent) {
		t.Fatalf("no service: %v", err)
	}
}

func TestReport(t *testing.T) {
	key := hostKey(t)
	rsaKey := "ssh-rsa AAAAB3NzaC1yc2E="
	until := func(s string) *string { return &s }
	grant := func(level protocol.RemoteHelpLevel, since string, u *string) *local.SupportGrant {
		return &local.SupportGrant{Level: level, Since: since, Until: u}
	}
	conns := func(n int) []protocol.RemoteHelpConnected { return make([]protocol.RemoteHelpConnected, n) }
	for name, tc := range map[string]struct {
		st        local.SupportState
		state     string
		untilS    int64 // -1: null
		connected int64
		key       bool
	}{
		"off":              {local.SupportState{Environment: "prod", HelpCodeRequired: true, HostKey: &key}, "off", -1, 0, true},
		"another key type": {local.SupportState{Environment: "prod", HostKey: &rsaKey}, "off", -1, 0, false},
		"look for an hour": {local.SupportState{Environment: "prod", Grant: grant("look", "2026-10-21T12:00:00Z", until("2026-10-21T13:00:00.9Z"))},
			"look", 3600, 0, false},
		"fix forever": {local.SupportState{Environment: "local", Grant: grant("fix", "2026-10-21T12:00:00Z", nil), Connected: conns(3)},
			"fix", -1, 3, false},
		// The service ends a grant within a second of its end; the report never says one runs that is over.
		"just ended": {local.SupportState{Environment: "dev", Grant: grant("fix", "2026-10-21T11:00:00Z", until("2026-10-21T12:00:00Z"))},
			"off", -1, 0, false},
		// A clock that moved: never more than a week.
		"far away": {local.SupportState{Environment: "dev", Grant: grant("look", "2026-10-21T11:00:00Z", until("2027-10-21T12:00:00Z"))},
			"look", 604800, 0, false},
		"more than eight connected": {local.SupportState{Environment: "dev", Connected: conns(12)}, "off", -1, 8, false},
	} {
		t.Run(name, func(t *testing.T) {
			r := supportclient.Report(&tc.st, now)
			if string(r.State) != tc.state || r.Connected != tc.connected || (r.HostKey != nil) != tc.key || r.HelpCode != tc.st.HelpCodeRequired {
				t.Fatalf("%+v", r)
			}
			if (tc.untilS < 0) != (r.UntilS == nil) || (r.UntilS != nil && *r.UntilS != tc.untilS) {
				t.Fatalf("untilS %v, want %d", r.UntilS, tc.untilS)
			}
		})
	}
}

func TestValidHostKey(t *testing.T) {
	key := hostKey(t)
	blob, _ := base64.StdEncoding.DecodeString(strings.TrimPrefix(key, "ssh-ed25519 "))
	enc := func(b []byte) string { return "ssh-ed25519 " + base64.StdEncoding.EncodeToString(b) }
	rsa := append(binary.BigEndian.AppendUint32(nil, 7), "ssh-rsa"...)
	if !supportclient.ValidHostKey(key) || len(key) != 80 {
		t.Fatal(key)
	}
	for name, bad := range map[string]string{
		"with a comment":   key + " root@box",
		"another type":     "ssh-rsa " + strings.TrimPrefix(key, "ssh-ed25519 "),
		"rsa blob":         enc(append(rsa, blob[15:]...)),
		"short key":        enc(blob[:len(blob)-1]),
		"trailing bytes":   enc(append(append([]byte{}, blob...), 0)),
		"not base64":       "ssh-ed25519 AAAA!!!!",
		"empty":            "ssh-ed25519 ",
		"too long":         "ssh-ed25519 " + strings.Repeat("A", 120),
		"a newline inside": strings.Replace(key, "AAAA", "AA\nAA", 1),
	} {
		if supportclient.ValidHostKey(bad) {
			t.Errorf("%s: accepted %q", name, bad)
		}
	}
}

// MG-120: what changes asks for a report at once — on, off, the level, the end, someone connecting or leaving, the host
// key, the help code — and what doesn't: the seconds running down.
func TestKey(t *testing.T) {
	key := hostKey(t)
	until := "2026-10-21T13:00:00Z"
	base := func() *local.SupportState {
		return &local.SupportState{Available: true, Environment: "prod", HelpCodeRequired: true, HostKey: &key,
			Grant: &local.SupportGrant{Level: "look", Since: "2026-10-21T12:00:00Z", Until: &until}}
	}
	same := base()
	commented := key + " root@whombat\n"
	same.HostKey = &commented
	if supportclient.Key(base()) != supportclient.Key(same) {
		t.Fatal("a comment on the host key changed the key")
	}
	later := "2026-10-22T12:00:00Z"
	for name, edit := range map[string]func(*local.SupportState){
		"off":       func(s *local.SupportState) { s.Grant = nil },
		"fix":       func(s *local.SupportState) { s.Grant.Level = "fix" },
		"longer":    func(s *local.SupportState) { s.Grant.Until = &later },
		"forever":   func(s *local.SupportState) { s.Grant.Until = nil },
		"no key":    func(s *local.SupportState) { s.HostKey = nil },
		"no code":   func(s *local.SupportState) { s.HelpCodeRequired = false },
		"turned on": func(s *local.SupportState) { s.Grant.Since = "2026-10-21T12:30:00Z" },
		"connected": func(s *local.SupportState) { s.Connected = make([]protocol.RemoteHelpConnected, 1) },
	} {
		s := base()
		edit(s)
		if supportclient.Key(s) == supportclient.Key(base()) {
			t.Errorf("%s: same key", name)
		}
	}
	if supportclient.Key(nil) == supportclient.Key(base()) || supportclient.Key(nil) == "" {
		t.Fatal("no answer")
	}
}
