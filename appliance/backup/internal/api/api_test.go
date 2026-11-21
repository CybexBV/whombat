package api

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/CybexBV/whombat/appliance/backup/internal/state"
)

func serve(t *testing.T, runtimeUID int) (*http.Client, *state.Config) {
	t.Helper()
	c := &state.Config{ApplianceID: "apl-api", Persist: t.TempDir(), RuntimeUID: runtimeUID, ManagerUID: -1, BackupUID: -1}
	c.Defaults()
	sock := filepath.Join(t.TempDir(), "api.sock")
	l, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{Cfg: c, RuntimeUID: runtimeUID, ManagerUID: -1}
	go func() { _ = s.Serve(l) }()
	t.Cleanup(func() { _ = s.Close() })
	return &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", sock)
	}}}, c
}

func call(t *testing.T, hc *http.Client, method, path, body string) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(method, "http://backup"+path, strings.NewReader(body))
	resp, err := hc.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	return resp.StatusCode, m
}

// GET /v1/ssh-public-key (CT-142): the runtime only; the same key every time; never the private half.
func TestSSHPublicKey(t *testing.T) {
	hc, c := serve(t, os.Getuid())
	code, a := call(t, hc, "GET", "/v1/ssh-public-key", "")
	if code != 200 || !strings.HasPrefix(a["publicKey"].(string), "ssh-ed25519 ") || !strings.HasPrefix(a["fingerprint"].(string), "SHA256:") {
		t.Fatalf("%d %v", code, a)
	}
	_, b := call(t, hc, "GET", "/v1/ssh-public-key", "")
	if a["publicKey"] != b["publicKey"] || len(a) != 2 {
		t.Fatalf("%v %v", a, b)
	}
	if _, err := os.Stat(c.SecretWritePath(state.SecretSSHKey)); err != nil {
		t.Fatal(err)
	}
	other, _ := serve(t, os.Getuid()+1)
	if code, _ := call(t, other, "GET", "/v1/ssh-public-key", ""); code != 403 {
		t.Fatalf("another uid: %d", code)
	}
}

// PUT /v1/destination takes exactly the contract's input: unknown members and impossible combinations are
// bad requests (400), never silently ignored.
func TestDestinationRequestIsStrict(t *testing.T) {
	hc, _ := serve(t, os.Getuid())
	for _, body := range []string{
		`{"repository":"disk:","sftpPort":22}`,
		`{"repository":"s3:https://s3.example.com/b/p","s3AccessKeyId":"A"}`,
		`{"repository":"sftp:nas:/p","sftpUser":"u","restUser":"x"}`,
		`{"repository":"/srv/restic"}`,
		`{}`,
	} {
		code, m := call(t, hc, "PUT", "/v1/destination", body)
		if code != 400 {
			t.Fatalf("%s: %d %v", body, code, m)
		}
		if e, _ := m["error"].(map[string]any); e == nil || e["code"] != "bad_request" {
			t.Fatalf("%s: %v", body, m)
		}
	}
}

// Opening a backup for reading is the runtime's only, and says so plainly where it isn't set up.
func TestPeekRoutesAccess(t *testing.T) {
	hc, _ := serve(t, os.Getuid())
	if code, b := call(t, hc, "POST", "/v1/peeks", `{"checkpointId":"ck-1"}`); code != 503 {
		t.Fatalf("not set up: %d %v", code, b)
	}
	if code, _ := call(t, hc, "POST", "/v1/peeks", `{"checkpointId":"../x"}`); code != 400 {
		t.Fatalf("bad id: %d", code)
	}
	other, _ := serve(t, os.Getuid()+1)
	for _, r := range [][2]string{{"POST", "/v1/peeks"}, {"GET", "/v1/peeks/pk-1"}, {"DELETE", "/v1/peeks/pk-1"}} {
		if code, _ := call(t, other, r[0], r[1], `{"checkpointId":"ck-1"}`); code != 403 {
			t.Fatalf("%s %s from another uid: %d", r[0], r[1], code)
		}
	}
}
