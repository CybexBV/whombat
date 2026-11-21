package broker_test

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/CybexBV/whombat/appliance/manager/internal/broker"
	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi"
	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi/fakecontrol"
	"github.com/CybexBV/whombat/contracts/go/device"
	"github.com/CybexBV/whombat/contracts/go/local"
)

func kitPush() string {
	return `{"envelopes":[{"credentialId":"Y3JlZC0x","salt":"c2FsdA","envelope":"wbkit1.bm9uY2U.Y2lwaGVy","generation":3}],"adoptedFrom":"wb-old-1"}`
}

// The kit's locked copies go to control unchanged, signed like the status reports; a malformed push is refused before
// it leaves the box; control out of reach is 503 control_unreachable (the runtime tries again).
func TestKitEnvelopesForwarded(t *testing.T) {
	t.Parallel()
	me := uint32(os.Getuid())
	fc, sock, _ := start(t, me, nil)
	c := client(sock)
	resp, m := post(t, c, broker.PathBackupKitEnvelopes, kitPush())
	if resp.StatusCode != 200 || m["stored"] != float64(1) {
		t.Fatalf("push: %d %v", resp.StatusCode, m)
	}
	if len(fc.KitEnvelopes) != 1 || len(fc.AuthErrors) != 0 {
		t.Fatalf("control got %d pushes, auth errors %v", len(fc.KitEnvelopes), fc.AuthErrors)
	}
	var got local.RuntimeKitEnvelopesRequest
	if err := json.Unmarshal(fc.KitEnvelopes[0], &got); err != nil || len(got.Envelopes) != 1 ||
		got.Envelopes[0].CredentialID != "Y3JlZC0x" || got.Envelopes[0].Generation != 3 || got.AdoptedFrom == nil || *got.AdoptedFrom != "wb-old-1" {
		t.Fatalf("control got %s (%v)", fc.KitEnvelopes[0], err)
	}
	for _, bad := range []string{
		`{"adoptedFrom":"wb-old-1"}`,
		`{"envelopes":[{"credentialId":"Y3JlZC0x","salt":"c2FsdA","envelope":"plain text","generation":1}]}`,
		`{"envelopes":[{"credentialId":"Y3JlZC0x","salt":"c2FsdA","envelope":"wbkit1.a.b","generation":1,"key":"x"}]}`,
		`{"envelopes":[{"credentialId":"Y3JlZC0x","salt":"c2FsdA","envelope":"wbkit1.a.b","generation":1}],"adoptedFrom":"../x"}`,
		`{"envelopes":[{"credentialId":"Y3JlZC0x","salt":"c2FsdA","envelope":"wbkit1.a.b","generation":1}],"adoptedFrom":"wb_old"}`,
	} {
		if resp, _ := post(t, c, broker.PathBackupKitEnvelopes, bad); resp.StatusCode != 400 {
			t.Fatalf("%s: %d", bad, resp.StatusCode)
		}
	}
	if len(fc.KitEnvelopes) != 1 {
		t.Fatal("a refused push reached control")
	}
	fc.Down = true
	resp, m = post(t, c, broker.PathBackupKitEnvelopes, kitPush())
	if e, _ := m["error"].(map[string]any); resp.StatusCode != 503 || e["code"] != "control_unreachable" {
		t.Fatalf("control down: %d %v", resp.StatusCode, m)
	}
}

// The Whombat's own name goes to control with its kits, as the contract has it: 1–80 characters, none of them a control
// character, no space at either end. A name outside that is refused before it leaves the box.
func TestKitEnvelopesName(t *testing.T) {
	t.Parallel()
	me := uint32(os.Getuid())
	fc, sock, _ := start(t, me, nil)
	c := client(sock)
	withName := func(name string) string {
		n, _ := json.Marshal(name)
		return `{"envelopes":[{"credentialId":"Y3JlZC0x","salt":"c2FsdA","envelope":"wbkit1.bm9uY2U.Y2lwaGVy","generation":3}],"applianceName":` + string(n) + `}`
	}
	for _, name := range []string{"Study", "Café Whombat 🦘", strings.Repeat("W", 80)} {
		resp, m := post(t, c, broker.PathBackupKitEnvelopes, withName(name))
		if resp.StatusCode != 200 || m["stored"] != float64(1) {
			t.Fatalf("%q: %d %v", name, resp.StatusCode, m)
		}
		var got local.RuntimeKitEnvelopesRequest
		last := fc.KitEnvelopes[len(fc.KitEnvelopes)-1]
		if err := json.Unmarshal(last, &got); err != nil || got.ApplianceName == nil || *got.ApplianceName != name {
			t.Fatalf("control got %s (%v)", last, err)
		}
	}
	sent := len(fc.KitEnvelopes)
	for _, bad := range []string{"", " Study", "Study ", "Stu\ndy", strings.Repeat("W", 81)} {
		if resp, _ := post(t, c, broker.PathBackupKitEnvelopes, withName(bad)); resp.StatusCode != 400 {
			t.Fatalf("%q: %d", bad, resp.StatusCode)
		}
	}
	if len(fc.KitEnvelopes) != sent {
		t.Fatal("a refused name reached control")
	}
}

// Only the runtime pushes; a box without control has nowhere to push to.
func TestKitEnvelopesCallers(t *testing.T) {
	t.Parallel()
	me := uint32(os.Getuid())
	_, sock, _ := start(t, me+1, nil)
	if resp, _ := post(t, client(sock), broker.PathBackupKitEnvelopes, kitPush()); resp.StatusCode != 403 {
		t.Fatalf("another caller: %d", resp.StatusCode)
	}
	c := serveSupport(t, &broker.Server{RuntimeUID: me})
	if resp, _ := post(t, c, broker.PathBackupKitEnvelopes, kitPush()); resp.StatusCode != 404 {
		t.Fatalf("no control: %d", resp.StatusCode)
	}
}

// The push control gets is a device request like any other: a key control doesn't know is refused.
func TestKitEnvelopesSigned(t *testing.T) {
	t.Parallel()
	fc := fakecontrol.New("dev")
	t.Cleanup(fc.Close)
	pub, priv, _ := ed25519.GenerateKey(nil)
	_, other, _ := ed25519.GenerateKey(nil)
	fc.Devices["dev-1"] = pub
	cc := &controlapi.Client{BaseURL: fc.Server.URL, Env: "dev", DeviceID: "dev-1", Key: other}
	err := cc.Do(context.Background(), device.DeviceOpNameKitEnvelopesPut, json.RawMessage(kitPush()), nil)
	var he *controlapi.HTTPError
	if !errors.As(err, &he) || he.Status != 401 || len(fc.KitEnvelopes) != 0 {
		t.Fatalf("a wrong key: %v", err)
	}
	cc.Key = priv
	var out device.KitEnvelopesPutResponse
	if err := cc.Do(context.Background(), device.DeviceOpNameKitEnvelopesPut, json.RawMessage(kitPush()), &out); err != nil {
		t.Fatal(err)
	}
	if len(fc.KitEnvelopes) != 1 || !strings.Contains(string(fc.KitEnvelopes[0]), "wbkit1.") || out.Stored != 1 {
		t.Fatalf("control got %v, answered %+v", fc.KitEnvelopes, out)
	}
}
