package broker_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"testing"

	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi/fakecontrol"
	"github.com/CybexBV/whombat/contracts/go/device"
	"github.com/CybexBV/whombat/contracts/go/local"
)

const testSig = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

func site(i int) string { return fmt.Sprintf("fbs_%024d", i) }

// cardsBody is a card sync of n cards, each with pad bytes of owner text (non-ASCII included: FD-35).
func cardsBody(n, pad int) string {
	cards := make([]map[string]any, n)
	for i := range cards {
		cards[i] = map[string]any{"card": map[string]any{"purpose": "whombat-feedback-site-card", "v": 1, "site": site(i),
			"config": map[string]any{"productLabel": "Lumio “Billing” · € <b>" + strings.Repeat("x", pad)}}, "sig": testSig}
	}
	b, _ := json.Marshal(map[string]any{"seq": 17, "cards": cards})
	return string(b)
}

func errCode(m map[string]any) string {
	e, _ := m["error"].(map[string]any)
	s, _ := e["code"].(string)
	return s
}

func TestFeedbackCardsForwarded(t *testing.T) {
	t.Parallel()
	fc, sock, _ := start(t, uint32(os.Getuid()), nil)
	c := client(sock)
	// A sync far above 64 KiB (FD-32: up to 4 MiB): 200 cards of ~15 KiB.
	body := cardsBody(200, 15000)
	if len(body) < 2<<20 {
		t.Fatalf("test body too small: %d", len(body))
	}
	resp, m := post(t, c, local.ManagerPathFeedbackCards, body)
	if resp.StatusCode != 200 {
		t.Fatalf("cards: %d %v", resp.StatusCode, m)
	}
	if acc, _ := m["accepted"].([]any); len(acc) != 200 || acc[0] != site(0) {
		t.Fatalf("accepted: %v", m["accepted"])
	}
	if len(fc.FeedbackSyncs) != 1 {
		t.Fatalf("control got %d syncs", len(fc.FeedbackSyncs))
	}
	// The cards reach control as the runtime sent them (same JSON values; the signature is over canonical JSON).
	var sent, got any
	_ = json.Unmarshal([]byte(body), &sent)
	_ = json.Unmarshal(fc.FeedbackSyncs[0], &got)
	a, _ := json.Marshal(sent)
	b, _ := json.Marshal(got)
	if !bytes.Equal(a, b) {
		t.Fatal("the card sync changed on the way to control")
	}
	// Above 4 MiB: refused locally (413), control never sees it.
	resp, m = post(t, c, local.ManagerPathFeedbackCards, cardsBody(200, 22000))
	if resp.StatusCode != 413 || errCode(m) != "too_large" || len(fc.FeedbackSyncs) != 1 {
		t.Fatalf("oversized sync: %d %v (%d syncs)", resp.StatusCode, m, len(fc.FeedbackSyncs))
	}
	// Not the contract's shape: 400, nothing forwarded.
	for _, bad := range []string{`{"seq":1,"cards":[],"extra":1}`, `{"seq":0,"cards":[]}`, `{"seq":1,"cards":[{"card":"x","sig":"` + testSig + `"}]}`} {
		resp, m = post(t, c, local.ManagerPathFeedbackCards, bad)
		if resp.StatusCode != 400 || errCode(m) != "bad_request" {
			t.Fatalf("%s: %d %v", bad, resp.StatusCode, m)
		}
	}
	// The empty set (withdraw everything) is a valid sync.
	resp, m = post(t, c, local.ManagerPathFeedbackCards, `{"seq":18,"cards":[]}`)
	if resp.StatusCode != 200 || len(fc.FeedbackSyncs) != 2 {
		t.Fatalf("empty sync: %d %v", resp.StatusCode, m)
	}
}

func TestFeedbackPullAndAck(t *testing.T) {
	t.Parallel()
	fc, sock, _ := start(t, uint32(os.Getuid()), nil)
	c := client(sock)
	// A pull answer above the 1 MiB other answers get: two drops of 3 MiB of envelope each.
	env := strings.Repeat("A", 3<<20)
	fc.FeedbackDrops = []device.FeedbackDrop{
		{DropID: "fdr_" + strings.Repeat("a", 22), Site: site(1), ReceivedAt: 1790467200, Origin: "https://embed.whombat.com", Bytes: 2359296, Envelope: env},
		{DropID: "fdr_" + strings.Repeat("b", 22), Site: site(1), ReceivedAt: 1790467201, Origin: "https://embed.whombat.com", Bytes: 2359296, Envelope: env},
	}
	resp, err := c.Post("http://manager"+local.ManagerPathFeedbackPull, "application/json", strings.NewReader(`{"max":10,"maxBytes":16777216}`))
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("pull: %d %s", resp.StatusCode, raw[:min(len(raw), 300)])
	}
	out, err := local.ParseRuntimeFeedbackPullResponse(raw)
	if err != nil || len(out.Drops) != 2 || out.Drops[1].Envelope != env || out.NextPullS != device.FeedbackPullS {
		t.Fatalf("pull answer: %v", err)
	}
	if len(fc.FeedbackPulls) != 1 || fc.FeedbackPulls[0].Max != 10 || fc.FeedbackPulls[0].MaxBytes != 16777216 {
		t.Fatalf("pull request at control: %+v", fc.FeedbackPulls)
	}
	// maxBytes above 47 MiB (FD-33) and max above 20 are not the contract's.
	for _, bad := range []string{`{"max":10,"maxBytes":50331648}`, `{"max":21,"maxBytes":1048576}`, `{"max":1}`} {
		r, m := post(t, c, local.ManagerPathFeedbackPull, bad)
		if r.StatusCode != 400 {
			t.Fatalf("%s: %d %v", bad, r.StatusCode, m)
		}
	}
	r, m := post(t, c, local.ManagerPathFeedbackAck, `{"dropIds":["fdr_`+strings.Repeat("a", 22)+`","fdr_`+strings.Repeat("b", 22)+`"]}`)
	if r.StatusCode != 200 || m["ok"] != true || len(fc.FeedbackAcked) != 2 {
		t.Fatalf("ack: %d %v %v", r.StatusCode, m, fc.FeedbackAcked)
	}
	r, _ = post(t, c, local.ManagerPathFeedbackAck, `{"dropIds":[]}`)
	if r.StatusCode != 400 {
		t.Fatalf("empty ack: %d", r.StatusCode)
	}
}

func TestFeedbackRefusals(t *testing.T) {
	t.Parallel()
	fc, sock, _ := start(t, uint32(os.Getuid()), nil)
	c := client(sock)
	pull := `{"max":10,"maxBytes":1048576}`
	cases := []struct {
		mode   string
		status int
		code   string
	}{
		{"off", 501, "unsupported"},            // FEEDBACK_DROP=off: 404 feedback_drop_off (FD-38)
		{"unclaimed", 409, "device_unclaimed"}, // passes through (FD-20)
	}
	for _, tc := range cases {
		fc.Set(func(fc *fakecontrol.Control) { fc.FeedbackMode = tc.mode })
		for path, body := range map[string]string{
			local.ManagerPathFeedbackCards:     `{"seq":1,"cards":[]}`,
			local.ManagerPathFeedbackPull:      pull,
			local.ManagerPathFeedbackAck:       `{"dropIds":["fdr_` + strings.Repeat("a", 22) + `"]}`,
			local.ManagerPathFeedbackReporters: reportersBody(1, 1),
		} {
			r, m := post(t, c, path, body)
			if r.StatusCode != tc.status || errCode(m) != tc.code {
				t.Fatalf("%s %s: %d %v", tc.mode, path, r.StatusCode, m)
			}
		}
	}
	fc.Set(func(fc *fakecontrol.Control) { fc.FeedbackMode = "" })
	// An answer that isn't the contract's is not passed on.
	fc.Set(func(fc *fakecontrol.Control) {
		fc.FeedbackAnswer = []byte(`{"drops":[{"dropId":"x"}],"pending":0,"expired":[],"nextPullS":30}`)
	})
	r, m := post(t, c, local.ManagerPathFeedbackPull, pull)
	if r.StatusCode != 502 || errCode(m) != "control_refused" {
		t.Fatalf("bad answer: %d %v", r.StatusCode, m)
	}
	fc.Set(func(fc *fakecontrol.Control) { fc.FeedbackAnswer = nil })
	// Control unreachable: 503 unavailable, as for every op.
	fc.SetDown(true)
	r, m = post(t, c, local.ManagerPathFeedbackPull, pull)
	if r.StatusCode != 503 || errCode(m) != "unavailable" || r.Header.Get("Retry-After") == "" {
		t.Fatalf("down: %d %v", r.StatusCode, m)
	}
	fc.SetDown(false)
	// Retired: control_refused (never 404, which the runtime reads as an older manager).
	fc.Set(func(fc *fakecontrol.Control) { fc.Retired = true })
	r, m = post(t, c, local.ManagerPathFeedbackPull, pull)
	if r.StatusCode != 502 || errCode(m) != "control_refused" {
		t.Fatalf("retired: %d %v", r.StatusCode, m)
	}
}

func TestFeedbackRuntimeOnly(t *testing.T) {
	t.Parallel()
	me := uint32(os.Getuid())
	fc, sock, _ := start(t, me+1, []uint32{me})
	for _, path := range []string{local.ManagerPathFeedbackCards, local.ManagerPathFeedbackPull, local.ManagerPathFeedbackAck,
		local.ManagerPathFeedbackReporters} {
		r, _ := post(t, client(sock), path, `{}`)
		if r.StatusCode != 403 {
			t.Fatalf("%s for a lock holder: %d", path, r.StatusCode)
		}
	}
	if len(fc.FeedbackSyncs)+len(fc.FeedbackPulls)+len(fc.FeedbackAcked)+len(fc.FeedbackPublishes) != 0 {
		t.Fatal("a refused caller reached control")
	}
}

func ref(i int) string { return fmt.Sprintf("FB-%04d-%04d", i/10000%10000, i%10000) }

// reportersBody is a feedback.reporters.publish body of n updates and r removals, every member at its longest.
func reportersBody(n, r int) string {
	body := device.FeedbackReportersPublishRequest{Updates: []device.FeedbackReporterUpdate{}, Removals: []device.FeedbackReporterRemoval{}}
	for i := range n {
		body.Updates = append(body.Updates, device.FeedbackReporterUpdate{Site: site(i % 3), ReporterID: "fbr_" + strings.Repeat("R", 22),
			Reference: ref(i), Type: device.FeedbackReportTypeFeature, Status: device.FeedbackReporterStatusInProgress,
			ReceivedAt: 4102444800, UpdatedAt: 4102444800})
	}
	for i := range r {
		body.Removals = append(body.Removals, device.FeedbackReporterRemoval{Site: site(i % 3), Reference: ref(1000 + i)})
	}
	b, _ := json.Marshal(body)
	return string(b)
}

func TestFeedbackReportersForwarded(t *testing.T) {
	t.Parallel()
	fc, sock, _ := start(t, uint32(os.Getuid()), nil)
	c := client(sock)
	upd := func(reference string, status device.FeedbackReporterStatus, at int64) device.FeedbackReporterUpdate {
		return device.FeedbackReporterUpdate{Site: site(1), ReporterID: "fbr_" + strings.Repeat("a", 22), Reference: reference,
			Type: device.FeedbackReportTypeBug, Status: status, ReceivedAt: 1790467200, UpdatedAt: at}
	}
	send := func(body device.FeedbackReportersPublishRequest) (int, map[string]any) {
		b, _ := json.Marshal(body)
		r, m := post(t, c, local.ManagerPathFeedbackReporters, string(b))
		return r.StatusCode, m
	}
	none := []device.FeedbackReporterRemoval{}
	if st, m := send(device.FeedbackReportersPublishRequest{Updates: []device.FeedbackReporterUpdate{
		upd("FB-AAAA-0001", device.FeedbackReporterStatusReviewing, 1790467300),
		upd("FB-AAAA-0002", device.FeedbackReporterStatusReceived, 1790467300),
	}, Removals: none}); st != 200 || m["ok"] != true {
		t.Fatalf("publish: %d %v", st, m)
	}
	// A later status replaces the entry, an older one doesn't; a removal deletes.
	send(device.FeedbackReportersPublishRequest{Updates: []device.FeedbackReporterUpdate{upd("FB-AAAA-0001", device.FeedbackReporterStatusFixed, 1790467400)}, Removals: none})
	send(device.FeedbackReportersPublishRequest{Updates: []device.FeedbackReporterUpdate{upd("FB-AAAA-0001", device.FeedbackReporterStatusConfirmed, 1790467350)},
		Removals: []device.FeedbackReporterRemoval{{Site: site(1), Reference: "FB-AAAA-0002"}}})
	got := fc.ReporterEntries()
	if len(got) != 1 || got[site(1)+"/FB-AAAA-0001"].Status != device.FeedbackReporterStatusFixed {
		t.Fatalf("entries at control: %+v", got)
	}
	if len(fc.FeedbackPublishes) != 3 || len(fc.FeedbackPublishes[0].Updates) != 2 {
		t.Fatalf("publishes at control: %+v", fc.FeedbackPublishes)
	}
	// Both lists empty is a valid request.
	if st, m := send(device.FeedbackReportersPublishRequest{Updates: []device.FeedbackReporterUpdate{}, Removals: none}); st != 200 {
		t.Fatalf("empty publish: %d %v", st, m)
	}
	// The largest request the contract allows (100 + 100, every member at its longest) goes through; the same
	// values with room to spare in whitespace too.
	full := reportersBody(device.FeedbackReportersPublishMax, device.FeedbackReportersPublishMax)
	var indented bytes.Buffer
	_ = json.Indent(&indented, []byte(full), "", " ")
	for _, body := range []string{full, indented.String()} {
		if r, m := post(t, c, local.ManagerPathFeedbackReporters, body); r.StatusCode != 200 {
			t.Fatalf("maximal publish (%d bytes): %d %v", len(body), r.StatusCode, m)
		}
	}
	if n := len(fc.FeedbackPublishes); n != 6 {
		t.Fatalf("control got %d publishes", n)
	}
	// Above the derived limit (twice the maximal compact body): 413, never forwarded.
	huge := `{"updates":[],"removals":[]` + strings.Repeat(" ", 2*len(full)) + `}`
	if r, m := post(t, c, local.ManagerPathFeedbackReporters, huge); r.StatusCode != 413 || errCode(m) != "too_large" {
		t.Fatalf("oversized publish: %d %v", r.StatusCode, m)
	}
	// Not the contract's: over 100 entries, unknown members, a bad status or reporter id, a missing list.
	for _, bad := range []string{
		reportersBody(device.FeedbackReportersPublishMax+1, 0),
		reportersBody(0, device.FeedbackReportersPublishMax+1),
		`{"updates":[],"removals":[],"extra":1}`,
		`{"updates":[]}`,
		strings.Replace(reportersBody(1, 0), `"in_progress"`, `"resolved"`, 1),
		strings.Replace(reportersBody(1, 0), `"fbr_`, `"fbx_`, 1),
		strings.Replace(reportersBody(1, 0), `4102444800`, `4102444801`, 1),
	} {
		if r, m := post(t, c, local.ManagerPathFeedbackReporters, bad); r.StatusCode != 400 || errCode(m) != "bad_request" {
			t.Fatalf("%.120s: %d %v", bad, r.StatusCode, m)
		}
	}
	if n := len(fc.FeedbackPublishes); n != 6 {
		t.Fatalf("a refused request reached control (%d publishes)", n)
	}
	// Control's answer must be the contract's, and small.
	for _, answer := range []string{`{"ok":false}`, `{}`, `{"ok":true,"pad":"` + strings.Repeat("x", 5000) + `"}`} {
		fc.Set(func(fc *fakecontrol.Control) { fc.FeedbackAnswer = []byte(answer) })
		if r, m := post(t, c, local.ManagerPathFeedbackReporters, reportersBody(1, 0)); r.StatusCode != 502 || errCode(m) != "control_refused" {
			t.Fatalf("answer %.40s: %d %v", answer, r.StatusCode, m)
		}
	}
}

// The pull passes control's answer on as sent: a drop's reporter attestation (contracts 0.25, CT-164) reaches the
// runtime, a drop without one has none, and an older control's answer (no reporter members) still parses.
func TestFeedbackPullKeepsReporter(t *testing.T) {
	t.Parallel()
	fc, sock, _ := start(t, uint32(os.Getuid()), nil)
	c := client(sock)
	who := &device.FeedbackDropReporter{ID: "fbr_" + strings.Repeat("Q", 21) + "-", EmailDigest: strings.Repeat("0f", 32)}
	fc.FeedbackDrops = []device.FeedbackDrop{
		{DropID: "fdr_" + strings.Repeat("a", 22), Site: site(1), ReceivedAt: 1790467200, Origin: "https://embed.whombat.com", Bytes: 4700, Envelope: "QUJD", Reporter: who},
		{DropID: "fdr_" + strings.Repeat("b", 22), Site: site(1), ReceivedAt: 1790467201, Origin: "https://embed.whombat.com", Bytes: 4700, Envelope: "QUJD"},
	}
	pull := func() []byte {
		resp, err := c.Post("http://manager"+local.ManagerPathFeedbackPull, "application/json", strings.NewReader(`{"max":10,"maxBytes":1048576}`))
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		raw, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != 200 {
			t.Fatalf("pull: %d %s", resp.StatusCode, raw)
		}
		return raw
	}
	raw := pull()
	out, err := local.ParseRuntimeFeedbackPullResponse(raw)
	if err != nil || len(out.Drops) != 2 {
		t.Fatalf("pull answer: %v", err)
	}
	if r := out.Drops[0].Reporter; r == nil || *r != *who {
		t.Fatalf("reporter lost: %+v", r)
	}
	if out.Drops[1].Reporter != nil || bytes.Count(raw, []byte(`"reporter"`)) != 1 {
		t.Fatalf("an anonymous drop gained a reporter: %s", raw)
	}
	// Control's bytes, unchanged (member order and spacing included), and a malformed attestation is refused.
	sent := `{"drops":[{"dropId":"fdr_` + strings.Repeat("c", 22) + `","site":"` + site(2) + `","receivedAt":1790467200,` +
		`"origin":"https://embed.whombat.com","bytes":4700,"envelope":"QUJD", "reporter":{"emailDigest":"` + strings.Repeat("ab", 32) +
		`","id":"fbr_` + strings.Repeat("z", 22) + `"}}],"pending":0,"expired":[],"nextPullS":30}`
	fc.Set(func(fc *fakecontrol.Control) { fc.FeedbackAnswer = []byte(sent) })
	if got := pull(); string(got) != sent {
		t.Fatalf("the pull answer changed on the way:\n%s\n%s", sent, got)
	}
	fc.Set(func(fc *fakecontrol.Control) {
		fc.FeedbackAnswer = []byte(strings.Replace(sent, `"fbr_`, `"fbx_`, 1))
	})
	if r, m := post(t, c, local.ManagerPathFeedbackPull, `{"max":10,"maxBytes":1048576}`); r.StatusCode != 502 || errCode(m) != "control_refused" {
		t.Fatalf("bad reporter: %d %v", r.StatusCode, m)
	}
}
