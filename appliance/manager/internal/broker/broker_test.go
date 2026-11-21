package broker_test

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/broker"
	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi"
	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi/fakecontrol"
	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
	"github.com/CybexBV/whombat/contracts/go/local"
)

func client(sock string) *http.Client {
	return &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "unix", sock)
	}}}
}

func start(t *testing.T, runtimeUID uint32, lockUIDs []uint32) (*fakecontrol.Control, string, *testworld.World) {
	w := testworld.New(t)
	fc := fakecontrol.New("dev")
	t.Cleanup(fc.Close)
	pub, priv, _ := ed25519.GenerateKey(nil)
	fc.Devices["dev-1"] = pub
	cc := &controlapi.Client{BaseURL: fc.Server.URL, Env: "dev", DeviceID: "dev-1", Key: priv}
	s := &broker.Server{RuntimeUID: runtimeUID, LockUIDs: lockUIDs, Control: cc, Engine: w.Engine}
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
	return fc, sock, w
}

func post(t *testing.T, c *http.Client, path, body string) (*http.Response, map[string]any) {
	resp, err := c.Post("http://manager"+path, "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var m map[string]any
	json.NewDecoder(resp.Body).Decode(&m)
	return resp, m
}

func TestTicketsForRuntimeOnly(t *testing.T) {
	t.Parallel()
	me := uint32(os.Getuid())
	fc, sock, _ := start(t, me, nil)
	c := client(sock)
	resp, m := post(t, c, "/v1/runtime/ticket", `{"class":"interactive"}`)
	if resp.StatusCode != 200 || m["ticket"] == "" || m["relayUrl"] != "wss://relay.dev.whombat.com" || m["worker"] != "w1" {
		t.Fatalf("%d %v", resp.StatusCode, m)
	}
	if _, err := time.Parse(time.RFC3339, m["expiresAt"].(string)); err != nil {
		t.Fatalf("expiresAt must be RFC 3339: %v", m["expiresAt"])
	}
	post(t, c, "/v1/runtime/ticket", `{"class":"interactive"}`)
	if fc.Tickets != 1 {
		t.Fatalf("ticket not cached: %d control calls", fc.Tickets)
	}
	resp, _ = post(t, c, "/v1/runtime/ticket", `{"class":"interactive","managementKey":"please"}`)
	if resp.StatusCode != 400 {
		t.Fatalf("unknown field accepted: %d", resp.StatusCode)
	}
	// Claim and revocation facts reach control in contract form.
	resp, _ = post(t, c, "/v1/runtime/claimed", `{"claimedAt":"2026-09-25T12:00:00Z"}`)
	if resp.StatusCode != 400 {
		t.Fatalf("claimed without claimId must be refused (CT-27): %d", resp.StatusCode)
	}
	resp, _ = post(t, c, "/v1/runtime/claimed", `{"claimId":"clm_0123456789","claimedAt":"2026-09-25T12:00:00Z"}`)
	if resp.StatusCode != 200 {
		t.Fatalf("claimed: %d", resp.StatusCode)
	}
	if got := strings.Join(fc.Other, "\n"); !strings.Contains(got, `"claimId":"clm_0123456789"`) || !strings.Contains(got, `"claimedAt":1790337600`) {
		t.Fatalf("claim.claimed body: %s", got)
	}
	resp, _ = post(t, c, "/v1/runtime/revocations", `{"peerId":"12D3KooW9w6DSVSH3c1ea57aKZvt1uACiQA5TDwyzeBXD9gjQstH","revokedAt":"2026-09-25T12:00:00Z"}`)
	if resp.StatusCode != 200 {
		t.Fatalf("revocations: %d", resp.StatusCode)
	}
	fc.SetDown(true)
	resp, m = post(t, c, "/v1/runtime/ticket", `{"class":"bulk"}`)
	if resp.StatusCode != 503 || m["error"].(map[string]any)["code"] != "unavailable" {
		t.Fatalf("control down: %d %v", resp.StatusCode, m)
	}
	// Lock endpoints are not for the runtime.
	resp, _ = post(t, c, "/v1/maintenance/lock", `{"holder":"x","reason":"y","ttlS":60}`)
	if resp.StatusCode != 403 {
		t.Fatalf("runtime took the maintenance lock: %d", resp.StatusCode)
	}
}

func TestWrongPeerRefused(t *testing.T) {
	t.Parallel()
	_, sock, _ := start(t, uint32(os.Getuid())+1, nil)
	resp, _ := post(t, client(sock), "/v1/runtime/ticket", `{}`)
	if resp.StatusCode != 403 {
		t.Fatalf("%d", resp.StatusCode)
	}
}

func TestMaintenanceLockForBackup(t *testing.T) {
	t.Parallel()
	me := uint32(os.Getuid())
	_, sock, w := start(t, me+1, []uint32{me})
	c := client(sock)
	resp, m := post(t, c, "/v1/maintenance/lock", `{"holder":"backup","reason":"checkpoint","ttlS":600}`)
	if resp.StatusCode != 200 {
		t.Fatalf("%d", resp.StatusCode)
	}
	b, _ := json.Marshal(m)
	if _, err := local.ParseMaintenanceLock(b); err != nil {
		t.Fatalf("lock answer is not a contract MaintenanceLock: %v %s", err, b)
	}
	if st := w.State(); st.Lock == nil || st.Lock.Holder != "backup" {
		t.Fatal("lock not recorded")
	}
	resp, _ = post(t, c, "/v1/maintenance/unlock", `{"holder":"backup"}`)
	if resp.StatusCode != 200 || w.State().Lock != nil {
		t.Fatal("unlock")
	}
	r, err := c.Get("http://manager/v1/update/status")
	if err != nil || r.StatusCode != 200 {
		t.Fatalf("status: %v %v", err, r)
	}
	body, _ := io.ReadAll(r.Body)
	if _, err := local.ParseUpdateStatusResponse(body); err != nil {
		t.Fatalf("status is not a contract UpdateStatusResponse: %v %s", err, body)
	}
}
