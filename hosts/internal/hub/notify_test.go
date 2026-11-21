package hub

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"rackoon/internal/hub/model"
	"rackoon/internal/hub/store"
	"rackoon/internal/proto"
	"rackoon/internal/rules"
)

type sentNotice struct {
	channel string
	kind    string
	ids     []string
}

func captureSends(e *env) (*[]sentNotice, *sync.Mutex) {
	var mu sync.Mutex
	var sent []sentNotice
	e.h.notify.send = func(ctx context.Context, ch store.Channel, n notice) error {
		mu.Lock()
		defer mu.Unlock()
		var ids []string
		for _, a := range n.alerts {
			ids = append(ids, a.ID)
		}
		sent = append(sent, sentNotice{ch.ID, n.kind, ids})
		return nil
	}
	return &sent, &mu
}

func wearConds(disks ...string) []rules.Condition {
	r := &proto.Report{}
	for _, d := range disks {
		w := 80.0
		r.Disks = append(r.Disks, proto.Disk{Device: d, Type: "nvme", WearPct: &w})
	}
	return rules.HostConditions(r)
}

func (e *env) flush() {
	e.h.notify.sending.Wait()
}

func TestNotificationGroupWaitAndResolve(t *testing.T) {
	e, admin := adminEnv(t, nil)
	e.enroll(admin, "granite", "Production")
	ctx := context.Background()
	if err := e.h.store.PutChannel(ctx, store.Channel{ID: "ch_1", Name: "ops", Kind: store.ChannelNtfy, URL: "https://ntfy.example/t",
		MinSeverity: rules.SevWarning, SendResolved: true, ReminderMin: 60, Enabled: true, CreatedBy: "john", CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	sent, mu := captureSends(e)
	n := e.h.notify
	t0 := time.Now()
	// Two alerts of a burst arrive in one message after the group wait.
	e.h.applyAlerts(ctx, e.h.alerts.Evaluate("granite", wearConds("nvme0n1", "nvme1n1"), notHeartbeat, t0))
	n.tick(ctx, t0)
	n.tick(ctx, t0.Add(10*time.Second))
	e.flush()
	if len(*sent) != 0 {
		t.Fatalf("sent before the group wait: %v", *sent)
	}
	n.tick(ctx, t0.Add(31*time.Second))
	e.flush()
	mu.Lock()
	if len(*sent) != 1 || (*sent)[0].kind != noticeOpened || len((*sent)[0].ids) != 2 {
		t.Fatalf("opened notice: %+v", *sent)
	}
	mu.Unlock()
	// No repeat; a reminder after the channel's interval.
	n.tick(ctx, t0.Add(40*time.Second))
	n.tick(ctx, t0.Add(31*time.Second+61*time.Minute))
	e.flush()
	mu.Lock()
	if len(*sent) != 2 || (*sent)[1].kind != noticeReminder {
		t.Fatalf("reminder: %+v", *sent)
	}
	mu.Unlock()
	// Resolving tells the channel.
	e.h.applyAlerts(ctx, e.h.alerts.Evaluate("granite", nil, notHeartbeat, t0.Add(2*time.Hour)))
	n.tick(ctx, t0.Add(2*time.Hour))
	e.flush()
	mu.Lock()
	defer mu.Unlock()
	if len(*sent) != 3 || (*sent)[2].kind != noticeResolved || len((*sent)[2].ids) != 2 {
		t.Fatalf("resolved: %+v", *sent)
	}
	if got, _ := e.h.store.ListDeliveries(ctx, "ch_1", 10); len(got) != 3 || !got[0].OK || got[0].Kind != noticeResolved {
		t.Fatalf("delivery log: %+v", got)
	}
}

func TestNotificationSkipsBlipsAcksAndMutes(t *testing.T) {
	e, admin := adminEnv(t, nil)
	e.enroll(admin, "granite", "Production")
	ctx := context.Background()
	e.h.store.PutChannel(ctx, store.Channel{ID: "ch_1", Name: "ops", Kind: store.ChannelNtfy, URL: "https://ntfy.example/t",
		MinSeverity: rules.SevWarning, SendResolved: true, Enabled: true, CreatedBy: "john", CreatedAt: time.Now()})
	sent, mu := captureSends(e)
	n := e.h.notify
	t0 := time.Now()
	// A blip: opens and resolves within the group wait.
	e.h.applyAlerts(ctx, e.h.alerts.Evaluate("granite", wearConds("sda"), notHeartbeat, t0))
	n.tick(ctx, t0)
	e.h.applyAlerts(ctx, e.h.alerts.Evaluate("granite", nil, notHeartbeat, t0.Add(ClearAfterForTest)))
	n.tick(ctx, t0.Add(40*time.Second+ClearAfterForTest))
	e.flush()
	mu.Lock()
	if len(*sent) != 0 {
		t.Fatalf("blip notified: %v", *sent)
	}
	mu.Unlock()
	// Acknowledged before the wait: never notified.
	ch := e.h.alerts.Evaluate("granite", wearConds("sdb"), notHeartbeat, t0)
	e.h.applyAlerts(ctx, ch)
	a := ch.Opened[0]
	e.h.alerts.SetAck("granite", a.ID, &rules.Ack{At: t0, By: "john"})
	n.tick(ctx, t0)
	n.tick(ctx, t0.Add(time.Minute))
	e.flush()
	mu.Lock()
	if len(*sent) != 0 {
		t.Fatalf("acknowledged alert notified: %v", *sent)
	}
	mu.Unlock()
	// Muted host: not notified until the mute ends.
	e.h.alerts.SetAck("granite", a.ID, nil)
	e.h.store.PutMaintenance(ctx, store.Maintenance{ID: "mw_1", Scope: store.ScopeServer, Target: "granite", StartsAt: t0.Add(-time.Minute),
		EndsAt: time.Now().Add(time.Hour), CreatedBy: "john", CreatedAt: t0})
	e.h.reloadMaintenance(ctx)
	n.tick(ctx, t0.Add(2*time.Minute))
	e.flush()
	mu.Lock()
	if len(*sent) != 0 {
		t.Fatalf("muted alert notified: %v", *sent)
	}
	mu.Unlock()
	e.h.store.DeleteMaintenance(ctx, "mw_1")
	e.h.reloadMaintenance(ctx)
	n.tick(ctx, t0.Add(3*time.Minute))
	n.tick(ctx, t0.Add(4*time.Minute))
	e.flush()
	mu.Lock()
	defer mu.Unlock()
	if len(*sent) != 1 || (*sent)[0].ids[0] != a.ID {
		t.Fatalf("after unmute: %+v", *sent)
	}
}

// ClearAfterForTest resolves the wear alert (its hysteresis).
const ClearAfterForTest = rules.ClearAfter + time.Second

func TestNtfyAndWebhookRendering(t *testing.T) {
	e, admin := adminEnv(t, func(c *Config) { c.PublicURL = "https://hub.example" })
	e.enroll(admin, "granite", "Production")
	var got []map[string]any
	var hdr []http.Header
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var m map[string]any
		json.Unmarshal(b, &m)
		mu.Lock()
		got = append(got, m)
		hdr = append(hdr, r.Header.Clone())
		mu.Unlock()
	}))
	defer srv.Close()
	ctx := context.Background()
	ch := e.h.alerts.Evaluate("granite", wearConds("nvme0n1"), notHeartbeat, time.Now())
	a := e.h.buildAlert(ch.Opened[0])
	n := e.h.notify
	if err := n.deliver(ctx, store.Channel{Kind: store.ChannelNtfy, URL: srv.URL + "/rackoon", Options: `{"token":"tk_secret"}`},
		notice{kind: noticeOpened, alerts: []model.Alert{a}}); err != nil {
		t.Fatal(err)
	}
	if err := n.deliver(ctx, store.Channel{Name: "am", Kind: store.ChannelWebhook, URL: srv.URL + "/hook", Options: `{"format":"alertmanager","headers":{"X-Key":"k"}}`},
		notice{kind: noticeOpened, alerts: []model.Alert{a}, hosts: map[string]string{"granite": "Production"}}); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	ntfy := got[0]
	if ntfy["topic"] != "rackoon" || ntfy["priority"].(float64) != 3 || !strings.Contains(ntfy["title"].(string), "granite: Disk nvme0n1 is 80% worn out") ||
		ntfy["click"] != "https://hub.example/servers/granite?tab=storage" || hdr[0].Get("Authorization") != "Bearer tk_secret" {
		t.Fatalf("ntfy %v %v", ntfy, hdr[0])
	}
	actions := ntfy["actions"].([]any)
	if len(actions) != 2 || !strings.Contains(actions[1].(map[string]any)["url"].(string), "/api/v1/alerts/"+a.ID+"/ack-link?e=") {
		t.Fatalf("actions %v", actions)
	}
	am := got[1]
	al := am["alerts"].([]any)[0].(map[string]any)
	if am["version"] != "4" || al["labels"].(map[string]any)["group"] != "Production" || hdr[1].Get("X-Key") != "k" {
		t.Fatalf("alertmanager %v", am)
	}
	// The Acknowledge button's link works once, for that alert.
	link := actions[1].(map[string]any)["url"].(string)
	path := strings.TrimPrefix(link, "https://hub.example")
	resp, err := http.Post(e.ui.URL+path, "text/plain", nil)
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("ack link: %v %v", err, resp)
	}
	if cur, _ := e.h.alerts.Find(a.ID); cur.Ack == nil || cur.Ack.By != "notification link" {
		t.Fatalf("not acknowledged: %+v", cur.Ack)
	}
	bad := strings.Replace(path, "t=", "t=x", 1)
	if resp, _ := http.Post(e.ui.URL+bad, "text/plain", nil); resp.StatusCode != 403 {
		t.Fatalf("forged link accepted: %d", resp.StatusCode)
	}
}

func TestChannelAPIRedactsSecrets(t *testing.T) {
	_, admin := adminEnv(t, nil)
	var c map[string]any
	admin.json(http.MethodPost, "/api/v1/channels", map[string]any{"name": "phone", "kind": "ntfy", "url": "https://ntfy.sh/secret-topic", "token": "tk_abc"}, 201, &c)
	if c["has_token"] != true || strings.Contains(c["target"].(string), "tk_abc") {
		t.Fatalf("channel %v", c)
	}
	admin.json(http.MethodPost, "/api/v1/channels", map[string]any{"name": "discord", "kind": "shoutrrr", "url": "discord://token123@channel456"}, 201, &c)
	if strings.Contains(c["target"].(string), "token123") {
		t.Fatalf("token in target %v", c)
	}
	if code, b, _ := admin.req(http.MethodPost, "/api/v1/channels", map[string]any{"name": "x", "kind": "shoutrrr", "url": "nope://x"}, nil); code != 400 {
		t.Fatalf("bad URL accepted: %d %s", code, b)
	}
	var list []map[string]any
	admin.json(http.MethodGet, "/api/v1/channels", nil, 200, &list)
	raw, _ := json.Marshal(list)
	if len(list) != 2 || strings.Contains(string(raw), "token123") || strings.Contains(string(raw), "tk_abc") {
		t.Fatalf("list leaks secrets: %s", raw)
	}
}
