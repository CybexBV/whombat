package desk_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/CybexBV/whombat/appliance/console/internal/desk"
	"github.com/CybexBV/whombat/appliance/console/internal/desk/desktest"
)

// withHelp is the paired fixture with remote help in its state.
func withHelp(help string) string {
	return strings.Replace(desktest.Paired, `"talk":null}`, `"talk":null,"remoteHelp":`+help+`}`, 1)
}

// CG-290: the state's remote help, checked by the contract and cleaned; a state whose remote help isn't the contract's
// is no state (as any other member).
func TestRemoteHelpInState(t *testing.T) {
	ctx := context.Background()
	for _, tc := range []struct {
		name, help        string
		level, until, who string // "": absent or null
		invalid           bool
	}{
		{"look until", `{"level":"look","until":"2026-10-20T15:00:00+02:00","connected":null}`, "look", "2026-10-20T13:00:00Z", "", false},
		{"fix forever, someone connected", `{"level":"fix","until":null,"connected":"Claude"}`, "fix", "", "Claude", false},
		// The contract's display text refuses a bidi override (the console cleans what passes, as every name).
		{"a name with a bidi override", `{"level":"fix","until":null,"connected":"Clau\u202ede"}`, "", "", "", true},
		{"another level", `{"level":"root","until":null,"connected":null}`, "", "", "", true},
		{"until not a time", `{"level":"look","until":"tomorrow","connected":null}`, "", "", "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := desktest.Start(t)
			f.Set(desk.PathState, desktest.Answer{Body: withHelp(tc.help)})
			c, _ := newClient(t, f)
			st := c.State(ctx)
			if tc.invalid {
				if st != nil {
					t.Fatalf("%+v", st.RemoteHelp)
				}
				return
			}
			if st == nil || st.Paired.Person.Name != "John" {
				t.Fatalf("the state: %+v", st)
			}
			h := st.RemoteHelp
			if h == nil || string(h.Level) != tc.level || (h.Until == nil) != (tc.until == "") || (h.Until != nil && *h.Until != tc.until) ||
				(h.Connected == nil) != (tc.who == "") || (h.Connected != nil && *h.Connected != tc.who) {
				t.Fatalf("%+v", h)
			}
		})
	}
	f := desktest.Start(t)
	c, _ := newClient(t, f)
	if st := c.State(ctx); st == nil || st.RemoteHelp != nil {
		t.Fatal("remote help without it in the state")
	}
}

// CG-291: Stop is one request with {v:1}, no PIN; the runtime's new state (or an ack) is fine, anything else isn't; the
// refusals pass on; the state is asked again after it.
func TestRemoteHelpStop(t *testing.T) {
	ctx := context.Background()
	f := desktest.Start(t)
	c, _ := newClient(t, f)
	f.Set(desk.PathRemoteHelpStop, desktest.Answer{Body: desktest.Paired})
	c.State(ctx)
	if a, err := c.RemoteHelpStop(ctx); err != nil || a.V != 1 {
		t.Fatal(a, err)
	}
	calls := f.Calls()
	if last := calls[len(calls)-1]; last.Method != "POST" || last.Path != "/v1/desk/remote-help/stop" || last.Body != `{"v":1}` {
		t.Fatalf("%+v", last)
	}
	before := f.CallsTo(desk.PathState)
	if c.State(ctx); f.CallsTo(desk.PathState) != before+1 {
		t.Fatal("the cache wasn't dropped")
	}
	f.Set(desk.PathRemoteHelpStop, desktest.Answer{Body: `{"v":1}`})
	if _, err := c.RemoteHelpStop(ctx); err != nil {
		t.Fatal("an ack:", err)
	}
	var de *desk.Error
	f.Set(desk.PathRemoteHelpStop, desktest.Answer{Body: `{"stopped":true}`})
	if _, err := c.RemoteHelpStop(ctx); !errors.As(err, &de) || de.Status != 502 || de.Code != "failed" {
		t.Fatal(err)
	}
	f.Set(desk.PathRemoteHelpStop, desktest.Answer{Status: 503, Body: `{"error":{"code":"unavailable","message":"x"}}`})
	if _, err := c.RemoteHelpStop(ctx); !errors.As(err, &de) || de.Status != 503 || de.Code != "unavailable" {
		t.Fatal(err)
	}
}
