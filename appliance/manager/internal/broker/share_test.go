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
)

const (
	shareA = "shr_AAAAAAAAAAAAAAAAAAAAAA"
	shareB = "shr_BBBBBBBBBBBBBBBBBBBBBB"
)

func sharePut(id, envelope string) string {
	return `{"shareId":"` + id + `","envelope":"` + envelope + `"}`
}

// A sealed copy goes to control as it is, signed like every device request; control's answer comes back as control
// sent it; delete and views do the same; a malformed body is refused before it leaves the box.
func TestShareForwarded(t *testing.T) {
	t.Parallel()
	me := uint32(os.Getuid())
	fc, sock, _ := start(t, me, nil)
	c := client(sock)
	resp, m := post(t, c, broker.PathSharePut, `{"shareId":"`+shareA+`","expiresAt":4102444800,"envelope":"c2VhbGVk"}`)
	if resp.StatusCode != 200 || m["url"] != "https://app.dev.whombat.com/s/"+shareA {
		t.Fatalf("put: %d %v", resp.StatusCode, m)
	}
	got, ok := fc.Shares[shareA]
	if !ok || got.Envelope != "c2VhbGVk" || got.ExpiresAt == nil || *got.ExpiresAt != 4102444800 || len(fc.AuthErrors) != 0 {
		t.Fatalf("control kept %+v (auth errors %v)", fc.Shares, fc.AuthErrors)
	}
	post(t, c, broker.PathSharePut, sharePut(shareB, "b3RoZXI"))
	fc.ShareViews[shareA] = 7

	resp, m = post(t, c, broker.PathShareViews, `{"shareIds":["`+shareA+`","shr_CCCCCCCCCCCCCCCCCCCCCC"]}`)
	shares, _ := m["shares"].([]any)
	if resp.StatusCode != 200 || len(shares) != 1 {
		t.Fatalf("views: %d %v", resp.StatusCode, m)
	}
	if v, _ := shares[0].(map[string]any); v["shareId"] != shareA || v["views"] != float64(7) {
		t.Fatalf("views: %v", m)
	}

	resp, m = post(t, c, broker.PathShareDelete, `{"shareIds":["`+shareA+`"]}`)
	if resp.StatusCode != 200 || m["ok"] != true {
		t.Fatalf("delete: %d %v", resp.StatusCode, m)
	}
	if _, kept := fc.Shares[shareA]; kept || len(fc.Shares) != 1 {
		t.Fatalf("control still keeps %v", fc.Shares)
	}

	puts := fc.SharePuts
	for path, bad := range map[string][]string{
		broker.PathSharePut: {
			sharePut("shr_short", "c2VhbGVk"),
			sharePut(shareA, "not base64url!"),
			`{"shareId":"` + shareA + `","envelope":"c2VhbGVk","key":"x"}`,
			`{"shareId":"` + shareA + `"}`,
		},
		broker.PathShareDelete: {`{"shareIds":[]}`, `{"shareIds":["nope"]}`, `{}`},
		broker.PathShareViews:  {`{"shareIds":[]}`, `{"shareIds":["` + shareA + `"],"all":true}`},
	} {
		for _, body := range bad {
			if resp, m := post(t, c, path, body); resp.StatusCode != 400 {
				t.Fatalf("%s %s: %d %v", path, body, resp.StatusCode, m)
			}
		}
	}
	if fc.SharePuts != puts || len(fc.Shares) != 1 {
		t.Fatal("a refused body reached control")
	}
}

// The largest copy the contract allows goes through: about 11 MiB to the manager and, signed, to control.
func TestShareLargest(t *testing.T) {
	t.Parallel()
	me := uint32(os.Getuid())
	fc, sock, _ := start(t, me, nil)
	big := strings.Repeat("A", (device.ShareMaxEnvelopeBytes*4+2)/3)
	resp, m := post(t, client(sock), broker.PathSharePut, sharePut(shareA, big))
	if resp.StatusCode != 200 || len(fc.Shares[shareA].Envelope) != len(big) {
		t.Fatalf("largest put: %d %v", resp.StatusCode, m)
	}
}

// A body above a path's limit is 413 too_large, before anything leaves the box: 11 MiB and a bit for a put, 64 KiB for
// delete and views.
func TestShareTooLarge(t *testing.T) {
	t.Parallel()
	me := uint32(os.Getuid())
	fc, sock, _ := start(t, me, nil)
	c := client(sock)
	huge := strings.Repeat("A", device.SharePutMaxBytes)
	if resp, m := post(t, c, broker.PathSharePut, sharePut(shareA, huge)); resp.StatusCode != 413 || errCode(m) != "too_large" {
		t.Fatalf("huge put: %d %v", resp.StatusCode, m)
	}
	ids := strings.Repeat(`"`+shareA+`",`, device.DeviceRequestMaxBytes/len(shareA))
	for _, path := range []string{broker.PathShareDelete, broker.PathShareViews} {
		if resp, m := post(t, c, path, `{"shareIds":[`+ids+`"`+shareB+`"]}`); resp.StatusCode != 413 || errCode(m) != "too_large" {
			t.Fatalf("%s: %d %v", path, resp.StatusCode, m)
		}
	}
	if fc.SharePuts != 0 {
		t.Fatal("a too large body reached control")
	}
}

// Control out of reach is 503 control_unreachable with Retry-After (the runtime tries again); control's refusal is 502
// control_refused with control's code first in the message, so the runtime can tell them apart.
func TestShareControlErrors(t *testing.T) {
	t.Parallel()
	me := uint32(os.Getuid())
	fc, sock, _ := start(t, me, nil)
	c := client(sock)
	for _, code := range []string{"share_taken", "share_limit", "bad_expiry"} {
		fc.ShareRefuse = code
		for path, body := range map[string]string{
			broker.PathSharePut:    sharePut(shareA, "c2VhbGVk"),
			broker.PathShareDelete: `{"shareIds":["` + shareA + `"]}`,
			broker.PathShareViews:  `{"shareIds":["` + shareA + `"]}`,
		} {
			resp, m := post(t, c, path, body)
			e, _ := m["error"].(map[string]any)
			msg, _ := e["message"].(string)
			if resp.StatusCode != 502 || e["code"] != "control_refused" || !strings.HasPrefix(msg, "refused "+code+":") {
				t.Fatalf("%s refused %s: %d %v", path, code, resp.StatusCode, m)
			}
		}
	}
	fc.ShareRefuse = ""
	fc.Retired = true
	resp, m := post(t, c, broker.PathSharePut, sharePut(shareA, "c2VhbGVk"))
	if msg, _ := m["error"].(map[string]any)["message"].(string); resp.StatusCode != 502 || !strings.HasPrefix(msg, "device_revoked device_retired:") {
		t.Fatalf("retired: %d %v", resp.StatusCode, m)
	}
	fc.Retired = false
	fc.Down = true
	for _, path := range []string{broker.PathSharePut, broker.PathShareDelete, broker.PathShareViews} {
		body := `{"shareIds":["` + shareA + `"]}`
		if path == broker.PathSharePut {
			body = sharePut(shareA, "c2VhbGVk")
		}
		resp, m := post(t, c, path, body)
		if resp.StatusCode != 503 || errCode(m) != "control_unreachable" || resp.Header.Get("Retry-After") != "300" {
			t.Fatalf("%s with control down: %d %v %q", path, resp.StatusCode, m, resp.Header.Get("Retry-After"))
		}
	}
}

// Only the runtime shares; a box without control has nowhere to keep a copy (404, read by the runtime as no control).
func TestShareCallers(t *testing.T) {
	t.Parallel()
	me := uint32(os.Getuid())
	_, sock, _ := start(t, me+1, nil)
	other := client(sock)
	c := serveSupport(t, &broker.Server{RuntimeUID: me})
	for path, body := range map[string]string{
		broker.PathSharePut:    sharePut(shareA, "c2VhbGVk"),
		broker.PathShareDelete: `{"shareIds":["` + shareA + `"]}`,
		broker.PathShareViews:  `{"shareIds":["` + shareA + `"]}`,
	} {
		if resp, _ := post(t, other, path, body); resp.StatusCode != 403 {
			t.Fatalf("%s from another caller: %d", path, resp.StatusCode)
		}
		if resp, _ := post(t, c, path, body); resp.StatusCode != 404 {
			t.Fatalf("%s without control: %d", path, resp.StatusCode)
		}
	}
}

// The put control gets is a device request like any other: a key control doesn't know is refused.
func TestShareSigned(t *testing.T) {
	t.Parallel()
	fc := fakecontrol.New("dev")
	t.Cleanup(fc.Close)
	pub, priv, _ := ed25519.GenerateKey(nil)
	_, other, _ := ed25519.GenerateKey(nil)
	fc.Devices["dev-1"] = pub
	cc := &controlapi.Client{BaseURL: fc.Server.URL, Env: "dev", DeviceID: "dev-1", Key: other}
	err := cc.Do(context.Background(), device.DeviceOpNameSharePut, json.RawMessage(sharePut(shareA, "c2VhbGVk")), nil)
	var he *controlapi.HTTPError
	if !errors.As(err, &he) || he.Status != 401 || fc.SharePuts != 0 {
		t.Fatalf("a wrong key: %v", err)
	}
	cc.Key = priv
	var out device.SharePutResponse
	if err := cc.Do(context.Background(), device.DeviceOpNameSharePut, json.RawMessage(sharePut(shareA, "c2VhbGVk")), &out); err != nil {
		t.Fatal(err)
	}
	if fc.SharePuts != 1 || !strings.HasSuffix(out.URL, "/s/"+shareA) {
		t.Fatalf("control kept %d, answered %+v", fc.SharePuts, out)
	}
}
