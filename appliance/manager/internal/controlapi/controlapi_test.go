package controlapi_test

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi"
	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi/fakecontrol"
	"github.com/CybexBV/whombat/contracts/go/device"
	"github.com/CybexBV/whombat/contracts/go/release"
)

func TestSignedRequestsAgainstContractVerifier(t *testing.T) {
	fc := fakecontrol.New("dev")
	defer fc.Close()
	pub, priv, _ := ed25519.GenerateKey(nil)
	fc.Devices["dev_1"] = pub
	c := &controlapi.Client{BaseURL: fc.Server.URL, Env: "dev", DeviceID: "dev_1", Key: priv}
	tk, err := c.AdmissionTicket(context.Background(), "interactive")
	if err != nil {
		t.Fatal(err)
	}
	if exp, err := controlapi.JWSExpiry(tk.Ticket); err != nil || exp.Unix() != tk.ExpiresAt {
		t.Fatalf("expiry %v %v", exp, err)
	}
	if res, raw, _, err := c.Assignment(context.Background(), "rt-1", 0); err != nil || raw != nil || res != controlapi.ResultNone {
		t.Fatalf("assignment %s %s %v", res, raw, err)
	}
	fc.BadResult = "assigned" // "assigned" without an assignment is inconsistent (CT-28)
	if _, _, _, err := c.Assignment(context.Background(), "rt-1", 0); err == nil {
		t.Fatal("inconsistent result accepted")
	}
	fc.BadResult = ""
	cand := "rt-2"
	if err := c.Progress(context.Background(), device.UpdateProgressRequest{Sequence: 1, State: release.UpdateJournalStateAssigned,
		Current: "rt-1", Candidate: &cand, FailedChecks: []string{}, At: time.Now().Unix()}); err != nil {
		t.Fatal(err)
	}
	// Foreign key, wrong environment audience, stale clock are refused by the contract verifier.
	_, other, _ := ed25519.GenerateKey(nil)
	var he *controlapi.HTTPError
	for name, bad := range map[string]*controlapi.Client{
		"foreign-key": {BaseURL: fc.Server.URL, Env: "dev", DeviceID: "dev_1", Key: other},
		"wrong-env":   {BaseURL: fc.Server.URL, Env: "prod", DeviceID: "dev_1", Key: priv},
		"stale":       {BaseURL: fc.Server.URL, Env: "dev", DeviceID: "dev_1", Key: priv, Now: func() time.Time { return time.Now().Add(-10 * time.Minute) }},
	} {
		if _, _, _, err := bad.Assignment(context.Background(), "rt-1", 0); !errors.As(err, &he) || he.Status != 401 {
			t.Errorf("%s: %v", name, err)
		}
	}
	fc.SetDown(true)
	if _, _, _, err := c.Assignment(context.Background(), "rt-1", 0); !errors.Is(err, controlapi.ErrUnavailable) {
		t.Fatalf("down: %v", err)
	}
}

// The contracts' device-request vectors verify with the same verifier the fake control uses, and our
// signing reproduces the vector signature for the development seed key.
func TestDeviceRequestVectors(t *testing.T) {
	b, err := os.ReadFile("../../../../contracts/go/testdata/vectors/signed.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		DeviceRequests struct {
			Audience   string            `json:"audience"`
			PublicKeys map[string]string `json:"publicKeys"`
			Cases      []struct {
				Name     string          `json:"name"`
				Envelope json.RawMessage `json:"envelope"`
				Now      int64           `json:"now"`
				Audience string          `json:"audience"`
				Expect   string          `json:"expect"`
			} `json:"cases"`
		} `json:"deviceRequests"`
	}
	json.Unmarshal(b, &v)
	seen := map[string]bool{}
	resigned := 0
	defer func() {
		if resigned == 0 {
			t.Error("no vector signature was reproduced")
		}
	}()
	for _, c := range v.DeviceRequests.Cases {
		aud := c.Audience
		if aud == "" {
			aud = v.DeviceRequests.Audience
		}
		_, err := device.VerifyDeviceRequest(c.Envelope, device.DeviceRequestContext{Audience: aud, Now: c.Now,
			PublicKeyOf: func(id string) (ed25519.PublicKey, bool) {
				k, ok := v.DeviceRequests.PublicKeys[id]
				p, _ := hex.DecodeString(k)
				return p, ok
			},
			ClaimNonce: func(d, n string) bool { k := c.Name + d + n; s := seen[k]; seen[k] = true; return !s }})
		got := "ok"
		var de *device.DeviceRequestError
		if errors.As(err, &de) {
			got = string(de.Code)
		}
		if got != c.Expect {
			t.Errorf("%s: got %s want %s", c.Name, got, c.Expect)
		}
		if c.Expect == "ok" {
			var env device.DeviceRequestEnvelope
			json.Unmarshal(c.Envelope, &env)
			seed := sha256.Sum256([]byte("whombat/seed-key/v1\x00whombat-contracts-vectors\x00device-" + env.Device + "-management"))
			key := ed25519.NewKeyFromSeed(seed[:])
			if hex.EncodeToString(key.Public().(ed25519.PublicKey)) != v.DeviceRequests.PublicKeys[env.Device] {
				continue // vector key is not the derivable dev seed for this device
			}
			var body any
			json.Unmarshal(env.Body, &body)
			re, err := device.SignDeviceRequest(env.Aud, env.Device, env.Op, env.Ts, env.Nonce, body, key)
			if err != nil || re.Sig != env.Sig {
				t.Errorf("%s: our signature differs: %v", c.Name, err)
			}
			resigned++
		}
	}
}

// TestClaimLookupOverEachFamily (MG-32): claim.lookup forced over IPv4 or IPv6 goes over that family and says so;
// a family control can't be reached over fails without touching the other.
func TestClaimLookupOverEachFamily(t *testing.T) {
	fc := fakecontrol.New("dev")
	defer fc.Close()
	pub, priv, _ := ed25519.GenerateKey(nil)
	fc.Devices["dev_1"] = pub
	v4only := &controlapi.Client{BaseURL: "http://localhost:" + fc.Server.URL[strings.LastIndex(fc.Server.URL, ":")+1:], Env: "dev", DeviceID: "dev_1", Key: priv}
	ctx := context.Background()
	if _, used, err := v4only.ClaimLookupOver(ctx, controlapi.FamilyIPv4); err != nil || used != controlapi.FamilyIPv4 {
		t.Fatalf("over IPv4: %s %v", used, err)
	}
	// Only 127.0.0.1 listens: IPv6 fails, and an IPv4 literal has no IPv6 address at all.
	if _, _, err := v4only.ClaimLookupOver(ctx, controlapi.FamilyIPv6); err == nil {
		t.Fatal("IPv6 reached an IPv4-only control")
	}
	literal := &controlapi.Client{BaseURL: fc.Server.URL, Env: "dev", DeviceID: "dev_1", Key: priv}
	if _, _, err := literal.ClaimLookupOver(ctx, controlapi.FamilyIPv6); err == nil {
		t.Fatal("IPv6 to an IPv4 literal")
	}
	if _, used, err := literal.ClaimLookupOver(ctx, controlapi.FamilyAny); err != nil || used != controlapi.FamilyIPv4 {
		t.Fatalf("any: %s %v", used, err)
	}
	if v4, v6 := fc.LookupFamilies(); v4 != 2 || v6 != 0 {
		t.Fatalf("families %d/%d", v4, v6)
	}

	url, err := fc.ServeDualStack()
	if err != nil {
		t.Skipf("no IPv6 loopback: %v", err)
	}
	dual := &controlapi.Client{BaseURL: url, Env: "dev", DeviceID: "dev_1", Key: priv}
	for _, fam := range []string{controlapi.FamilyIPv6, controlapi.FamilyIPv4} {
		if _, used, err := dual.ClaimLookupOver(ctx, fam); err != nil || used != fam {
			t.Fatalf("over %s: %s %v", fam, used, err)
		}
	}
	if _, used, err := dual.ClaimLookupOver(ctx, controlapi.FamilyAny); err != nil || used == controlapi.FamilyAny {
		t.Fatalf("any: %q %v", used, err)
	} else if controlapi.OtherFamily(used) == controlapi.FamilyAny {
		t.Fatalf("no other family for %q", used)
	}
	if v4, v6 := fc.LookupFamilies(); v4 < 3 || v6 < 1 || v4+v6 != 5 {
		t.Fatalf("families %d/%d", v4, v6)
	}
}

// Forward (MG-39): the op's own request limit before anything is sent, the caller's answer limit, the answer as sent.
func TestForwardLimits(t *testing.T) {
	fc := fakecontrol.New("dev")
	defer fc.Close()
	pub, priv, _ := ed25519.GenerateKey(nil)
	fc.Devices["dev_1"] = pub
	c := &controlapi.Client{BaseURL: fc.Server.URL, Env: "dev", DeviceID: "dev_1", Key: priv}
	ctx := context.Background()
	ack := device.FeedbackDropsAckRequest{DropIds: []string{"fdr_" + strings.Repeat("a", 22)}}
	raw, err := c.Forward(ctx, device.DeviceOpNameFeedbackDropsAck, ack, 1<<20, 5*time.Second)
	if err != nil || string(raw) != `{"ok":true}` {
		t.Fatalf("ack: %s %v", raw, err)
	}
	fc.Set(func(fc *fakecontrol.Control) {
		fc.FeedbackAnswer = json.RawMessage(`{"ok":true,"pad":"` + strings.Repeat("x", 2000) + `"}`)
	})
	if _, err := c.Forward(ctx, device.DeviceOpNameFeedbackDropsAck, ack, 1024, 5*time.Second); !errors.Is(err, controlapi.ErrAnswerTooLarge) {
		t.Fatalf("answer above the limit: %v", err)
	}
	fc.Set(func(fc *fakecontrol.Control) { fc.FeedbackAnswer = nil })
	// A card sync above FEEDBACK_CARDS_SYNC_MAX_BYTES is refused before it is sent.
	cards := make([]device.FeedbackCardWire, 200)
	for i := range cards {
		cards[i] = device.FeedbackCardWire{Card: json.RawMessage(`{"t":"` + strings.Repeat("x", 22000) + `"}`), Sig: strings.Repeat("A", 86)}
	}
	before := len(fc.FeedbackSyncs)
	if _, err := c.Forward(ctx, device.DeviceOpNameFeedbackCardsSync, device.FeedbackCardsSyncRequest{Seq: 1, Cards: cards}, 1<<20, 5*time.Second); !errors.Is(err, controlapi.ErrTooLarge) {
		t.Fatalf("oversized sync: %v", err)
	}
	if len(fc.FeedbackSyncs) != before {
		t.Fatal("an oversized sync reached control")
	}
	// Half of it is within the op's 4 MiB (every other op keeps 64 KiB, CT-91).
	if _, err := c.Forward(ctx, device.DeviceOpNameFeedbackCardsSync, device.FeedbackCardsSyncRequest{Seq: 1, Cards: cards[:100]}, 1<<20, 5*time.Second); err != nil {
		t.Fatalf("a 2 MiB sync: %v", err)
	}
	// A control that doesn't answer within the op's timeout is unavailable.
	fc.Set(func(fc *fakecontrol.Control) { fc.Delay = 300 * time.Millisecond })
	if _, err := c.Forward(ctx, device.DeviceOpNameFeedbackDropsAck, ack, 1<<20, 100*time.Millisecond); !errors.Is(err, controlapi.ErrUnavailable) {
		t.Fatalf("timeout: %v", err)
	}
}

// MG-46, MG-53: update.progress and status.report carry the failure detail, the wait and the runtime version.
func TestReportsCarryTheDetail(t *testing.T) {
	fc := fakecontrol.New("dev")
	defer fc.Close()
	pub, priv, _ := ed25519.GenerateKey(nil)
	fc.Devices["dev_1"] = pub
	c := &controlapi.Client{BaseURL: fc.Server.URL, Env: "dev", DeviceID: "dev_1", Key: priv}
	ctx := context.Background()
	target := int64(49)
	cand, code, rv := "pve-20260928.5", "schema_incompatible", "0.1.0-2be6fc1"
	detail := device.UpdateFailureReport(release.UpdateFailureDetail{Stage: release.UpdateJournalStateStaged, Code: code,
		Reasons: []string{"candidate_cannot_read_schema"}, Release: cand, Schema: &release.UpdateFailureSchema{Database: 48, Target: &target,
			CandidateWrites: 49, CandidateReads: release.IntRange{Min: 49, Max: 49}}, FailedChecks: []string{}, At: time.Now().Unix()})
	waiting := device.UpdateWaitingReport{Reason: release.UpdateWaitReasonCheckpoint, Since: time.Now().Unix()}
	progress := device.UpdateProgressRequest{Sequence: 1, State: release.UpdateJournalStateFailed, Current: "pve-20260928.4", Candidate: &cand,
		Failure: &code, FailedChecks: []string{}, FailureDetail: &detail, Waiting: &waiting, At: time.Now().Unix()}
	status := device.StatusReportRequest{Release: "pve-20260928.4", ManagerVersion: "0.3.0-0.dev", RuntimeVersion: &rv, UptimeS: 10,
		Update: device.StatusReportRequestUpdate{State: release.UpdateJournalStateFailed, Candidate: &cand, Failure: &code, FailureDetail: &detail,
			Waiting: &waiting},
		Health:      device.StatusReportRequestHealth{Runtime: "ok", Database: "ok", Runner: "ok", SessionEndpoint: "ok", Relay: "ok", Backup: "unconfigured"},
		RecoveryKit: "not_created"}
	if err := status.Validate(); err != nil {
		t.Fatal(err)
	}
	if err := c.Progress(ctx, progress); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Status(ctx, status); err != nil {
		t.Fatal(err)
	}
	p, _ := fc.LastProgress()
	s := fc.StatusReports()[0]
	if p.FailureDetail == nil || p.FailureDetail.Schema.Database != 48 || s.RuntimeVersion == nil || *s.RuntimeVersion != rv ||
		s.Update.FailureDetail == nil || p.Waiting == nil || p.Waiting.Reason != release.UpdateWaitReasonCheckpoint || s.Update.Waiting == nil {
		t.Fatalf("progress %+v status %+v", p, s)
	}
}
