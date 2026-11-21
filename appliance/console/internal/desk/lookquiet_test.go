package desk_test

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/CybexBV/whombat/appliance/console/internal/desk"
	"github.com/CybexBV/whombat/appliance/console/internal/desk/desktest"
)

// withLooks is the paired fixture with looks in Needs you.
func withLooks(looks string) string {
	return strings.Replace(desktest.Paired, `"needsYou":{"count":1,"items":[]}`, `"needsYou":{"count":1,"items":[],"looks":`+looks+`}`, 1)
}

// CG-331: a look's line, kind, Ignore's words and question reach the page; the line exactly as sent (the runtime finds
// it by it), the words cleaned as the reason; a heads-up is no look.
func TestLooksWithTheirLines(t *testing.T) {
	ctx := context.Background()
	f := desktest.Start(t)
	f.Set(desk.PathState, desktest.Answer{Body: withLooks(`[
		{"key":"connection:con_U1","kind":"connection","name":"UniFi","state":"look","reason":"Hallway AP is offline",
		 "notice":{"check":"unifi.device_offline","subject":"device:64a1 b2"},"nature":"problem",
		 "ignoreWords":"Until it’s back online. ","question":"Why is Hallway AP offline in UniFi?"},
		{"key":"connection:con_G1","kind":"connection","name":"Google","state":"look","notice":{"check":"conn.signin"},"nature":"you"},
		{"key":"connection:con_F1","kind":"connection","name":"Fusebox","state":"look","notice":{"check":"fusebox.week_early"},"nature":"fyi"},
		{"key":"server:pve-02","kind":"server","name":"pve-02","state":"down","server":"pve-02"}]`)})
	c, _ := newClient(t, f)
	st := c.State(ctx)
	if st == nil {
		t.Fatal("no state")
	}
	looks := st.Glance.NeedsYou.Looks
	if len(looks) != 3 {
		t.Fatalf("%+v", looks)
	}
	u := looks[0]
	if u.Notice == nil || u.Notice.Check != "unifi.device_offline" || u.Notice.Subject == nil || *u.Notice.Subject != "device:64a1 b2" ||
		u.Nature == nil || *u.Nature != "problem" || *u.IgnoreWords != "Until it’s back online." ||
		*u.Question != "Why is Hallway AP offline in UniFi?" {
		t.Fatalf("%+v", u)
	}
	if g := looks[1]; g.Notice == nil || g.Notice.Subject != nil || *g.Nature != "you" || g.IgnoreWords != nil {
		t.Fatalf("%+v", g)
	}
	if s := looks[2]; s.Notice != nil || s.Nature != nil || s.Name != "pve-02" {
		t.Fatalf("an older runtime's look: %+v", s)
	}
	// A check that isn't one is no state, as any member the schema refuses.
	f.Set(desk.PathState, desktest.Answer{Body: withLooks(`[{"key":"connection:con_U1","kind":"connection","name":"UniFi",
		"state":"look","notice":{"check":"UniFi Offline"}}]`)})
	c, _ = newClient(t, f)
	if st := c.State(ctx); st != nil {
		t.Fatalf("%+v", st.Glance.NeedsYou.Looks)
	}
}

// CG-331: Ignore and Not now are one request with the look's key, its line and how; what the socket wouldn't take is
// 400 without asking; the runtime's refusals pass on with their codes; the state is asked again after it.
func TestQuietLook(t *testing.T) {
	ctx := context.Background()
	f := desktest.Start(t)
	c, _ := newClient(t, f)
	f.Set(desk.PathLookQuiet, desktest.Answer{Body: `{"v":1}`})
	c.State(ctx)
	sub := "device:64a1 b2"
	if a, err := c.QuietLook(ctx, "connection:con_U1", "unifi.device_offline", &sub, "ignore"); err != nil || a.V != 1 {
		t.Fatal(a, err)
	}
	calls := f.Calls()
	if last := calls[len(calls)-1]; last.Method != "POST" || last.Path != "/v1/desk/look/quiet" ||
		last.Body != `{"v":1,"key":"connection:con_U1","notice":{"check":"unifi.device_offline","subject":"device:64a1 b2"},"how":"ignore"}` {
		t.Fatalf("%+v", last)
	}
	before := f.CallsTo(desk.PathState)
	if c.State(ctx); f.CallsTo(desk.PathState) != before+1 {
		t.Fatal("the cache wasn't dropped")
	}
	if _, err := c.QuietLook(ctx, "connection:con_G1", "conn.signin", nil, "snooze"); err != nil {
		t.Fatal(err)
	}
	if last := f.Calls()[len(f.Calls())-1]; last.Body != `{"v":1,"key":"connection:con_G1","notice":{"check":"conn.signin"},"how":"snooze"}` {
		t.Fatalf("%+v", last)
	}

	asked := f.CallsTo(desk.PathLookQuiet)
	long := strings.Repeat("𝔘", 161)
	empty := ""
	var de *desk.Error
	for _, bad := range []struct {
		key, check string
		subject    *string
		how        string
	}{
		{"connection:con_U1", "unifi.device_offline", nil, "undo"},
		{"connection:con_U1", "unifi.device_offline", nil, ""},
		{"", "unifi.device_offline", nil, "ignore"},
		{strings.Repeat("k", 121), "unifi.device_offline", nil, "ignore"},
		{"connection:con_U1", "UniFi offline", nil, "ignore"},
		{"connection:con_U1", "unifi", nil, "ignore"},
		{"connection:con_U1", "unifi.device_offline", &empty, "ignore"},
		{"connection:con_U1", "unifi.device_offline", &long, "ignore"},
		{"connection:‮con", "unifi.device_offline", nil, "ignore"},
	} {
		if _, err := c.QuietLook(ctx, bad.key, bad.check, bad.subject, bad.how); !errors.As(err, &de) || de.Status != 400 || de.Code != "bad_request" {
			t.Errorf("%+v: %v", bad, err)
		}
	}
	if n := f.CallsTo(desk.PathLookQuiet); n != asked {
		t.Fatalf("a request the console refuses reached the runtime (%d)", n-asked)
	}
	// The widest the socket takes: 120 and 160 code points of four bytes each, under DESK_REQUEST_MAX_BYTES.
	wideKey, wideSubject := strings.Repeat("𝔘", 120), strings.Repeat("𝔘", 160)
	if _, err := c.QuietLook(ctx, wideKey, "unifi.device_offline", &wideSubject, "ignore"); err != nil {
		t.Fatal(err)
	}

	for _, r := range []struct {
		status int
		code   string
	}{{409, "locked"}, {403, "not_allowed"}, {404, "not_found"}, {503, "unavailable"}} {
		f.Set(desk.PathLookQuiet, desktest.Answer{Status: r.status, Body: `{"error":{"code":"` + r.code + `","message":"x"}}`})
		if _, err := c.QuietLook(ctx, "connection:con_U1", "unifi.device_offline", nil, "ignore"); !errors.As(err, &de) ||
			de.Status != r.status || de.Code != r.code {
			t.Errorf("%d %s: %v", r.status, r.code, err)
		}
	}
	f.Set(desk.PathLookQuiet, desktest.Answer{Body: `{"quiet":true}`})
	if _, err := c.QuietLook(ctx, "connection:con_U1", "unifi.device_offline", nil, "ignore"); !errors.As(err, &de) ||
		de.Status != http.StatusBadGateway || de.Code != "failed" {
		t.Fatal(err)
	}
}
