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

// CG-370: what the assistant found out reaches the page with the look, its words cleaned; a research the contract
// refuses is no state, as any member the schema refuses.
func TestLooksWithResearch(t *testing.T) {
	ctx := context.Background()
	f := desktest.Start(t)
	f.Set(desk.PathState, desktest.Answer{Body: withLooks(`[
		{"key":"connection:con_H1","kind":"connection","name":"Home Assistant","state":"look","reason":"2 integrations stopped loading",
		 "research":{"key":"connection:con_H1","state":"found","title":"Zigbee stopped working in Home Assistant",
		  "summary":"The Zigbee stick stopped answering at 07:12, so your lights and sensors don’t respond. ","fix":"Restart Zigbee",
		  "conversationId":"cnv_abc","threadRootId":"msg_def","at":"2026-10-27T07:15:00Z"}},
		{"key":"server:pve-02","kind":"server","name":"pve-02","state":"down","server":"pve-02",
		 "research":{"key":"server:pve-02","state":"looking","at":"2026-10-27T07:14:00Z"}}]`)})
	c, _ := newClient(t, f)
	st := c.State(ctx)
	if st == nil {
		t.Fatal("no state")
	}
	looks := st.Glance.NeedsYou.Looks
	h, p := looks[0].Research, looks[1].Research
	if h == nil || h.State != "found" || *h.Title != "Zigbee stopped working in Home Assistant" ||
		*h.Summary != "The Zigbee stick stopped answering at 07:12, so your lights and sensors don’t respond." ||
		*h.Fix != "Restart Zigbee" || *h.ConversationID != "cnv_abc" {
		t.Fatalf("%+v", h)
	}
	if p == nil || p.State != "looking" || p.Title != nil {
		t.Fatalf("%+v", p)
	}
	for _, bad := range []string{
		`{"key":"server:pve-02","state":"thinking","at":"2026-10-27T07:14:00Z"}`,
		`{"key":"server:pve-02","state":"found","fix":"` + strings.Repeat("x", 33) + `","at":"2026-10-27T07:14:00Z"}`,
		`{"key":"server:pve-02","state":"found","title":"two\nlines","at":"2026-10-27T07:14:00Z"}`,
		`{"key":"server:pve-02","state":"found"}`,
	} {
		f.Set(desk.PathState, desktest.Answer{Body: withLooks(`[{"key":"server:pve-02","kind":"server","name":"pve-02",
			"state":"down","research":` + bad + `}]`)})
		c, _ = newClient(t, f)
		if st := c.State(ctx); st != nil {
			t.Errorf("%s: %+v", bad, st.Glance.NeedsYou.Looks)
		}
	}
}

// CG-371: the step's button is one request with the look's key; what the socket wouldn't take is 400 without asking;
// the runtime's refusals pass on with their codes; the state is asked again after it.
func TestFixLook(t *testing.T) {
	ctx := context.Background()
	f := desktest.Start(t)
	c, _ := newClient(t, f)
	f.Set(desk.PathLookFix, desktest.Answer{Body: `{"v":1}`})
	c.State(ctx)
	if a, err := c.FixLook(ctx, "connection:con_H1"); err != nil || a.V != 1 {
		t.Fatal(a, err)
	}
	calls := f.Calls()
	if last := calls[len(calls)-1]; last.Method != "POST" || last.Path != "/v1/desk/look/fix" ||
		last.Body != `{"v":1,"key":"connection:con_H1"}` {
		t.Fatalf("%+v", last)
	}
	before := f.CallsTo(desk.PathState)
	if c.State(ctx); f.CallsTo(desk.PathState) != before+1 {
		t.Fatal("the cache wasn't dropped")
	}

	asked := f.CallsTo(desk.PathLookFix)
	var de *desk.Error
	for _, bad := range []string{"", strings.Repeat("k", 121), "connection:‮con", "two\nlines"} {
		if _, err := c.FixLook(ctx, bad); !errors.As(err, &de) || de.Status != 400 || de.Code != "bad_request" {
			t.Errorf("%q: %v", bad, err)
		}
	}
	if n := f.CallsTo(desk.PathLookFix); n != asked {
		t.Fatalf("a request the console refuses reached the runtime (%d)", n-asked)
	}
	// The widest key the socket takes: 120 code points of four bytes each, under DESK_REQUEST_MAX_BYTES.
	if _, err := c.FixLook(ctx, strings.Repeat("𝔘", 120)); err != nil {
		t.Fatal(err)
	}

	for _, r := range []struct {
		status int
		code   string
	}{{409, "locked"}, {403, "not_allowed"}, {404, "not_found"}, {503, "unavailable"}} {
		f.Set(desk.PathLookFix, desktest.Answer{Status: r.status, Body: `{"error":{"code":"` + r.code + `","message":"x"}}`})
		if _, err := c.FixLook(ctx, "connection:con_H1"); !errors.As(err, &de) || de.Status != r.status || de.Code != r.code {
			t.Errorf("%d %s: %v", r.status, r.code, err)
		}
	}
	f.Set(desk.PathLookFix, desktest.Answer{Body: `{"fixing":true}`})
	if _, err := c.FixLook(ctx, "connection:con_H1"); !errors.As(err, &de) || de.Status != http.StatusBadGateway || de.Code != "failed" {
		t.Fatal(err)
	}
}
