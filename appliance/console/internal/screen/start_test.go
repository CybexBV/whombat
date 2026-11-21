package screen

import (
	"strings"
	"testing"
)

func TestParseStart(t *testing.T) {
	for _, c := range []struct {
		in   string
		want *Start
	}{
		{`{"v":1,"problem":"release-missing","release":"whombat-20261120.15"}`, &Start{StartReleaseMissing, "whombat-20261120.15"}},
		{`{"v":1,"problem":"offline","release":""}`, &Start{StartOffline, ""}},
		{`{"v":1,"problem":"failed"}`, &Start{StartFailed, ""}},
		// A release the screen wouldn't show is dropped, the problem stays.
		{`{"v":1,"problem":"release-missing","release":"\u001b[2Jx"}`, &Start{StartReleaseMissing, ""}},
		{`{"v":1,"problem":"release-missing","release":"Whombat 1"}`, &Start{StartReleaseMissing, ""}},
		{`{"v":1,"problem":"melted"}`, nil},
		{`{"v":2,"problem":"offline"}`, nil},
		{`not json`, nil},
		{`{"v":1,"problem":"offline","release":"` + strings.Repeat("a", 2000) + `"}`, nil},
	} {
		got, err := ParseStart([]byte(c.in))
		if c.want == nil {
			if err == nil {
				t.Errorf("%.60s: accepted %+v", c.in, got)
			}
			continue
		}
		if err != nil || *got != *c.want {
			t.Errorf("%.60s: %+v %v, want %+v", c.in, got, err, c.want)
		}
	}
}

// The starting screen says why the first start can't finish, in place of “Starting Whombat…”; every other screen
// (a runtime that writes its state has started) leaves it out.
func TestRenderStart(t *testing.T) {
	for _, c := range []struct {
		p    Start
		want string
	}{
		{Start{StartReleaseMissing, "whombat-20261120.15"}, "This Whombat can’t find its version, whombat-20261120.15, on the update server. Install it again with the newest Whombat installer."},
		{Start{StartReleaseMissing, ""}, wordStartReleaseMissingNoID},
		{Start{StartOffline, ""}, "This Whombat can’t reach the update server. Check the network cable."},
		{Start{StartFailed, "whombat-20261120.15"}, "Something went wrong while this Whombat set itself up."},
	} {
		p := c.p
		f := Render(Screen{State: Starting, Start: &p}, now, 200, 0, nil)
		for _, w := range []string{"Whombat can’t start yet", c.want, "It tries again by itself. To try now, restart it."} {
			if !strings.Contains(f, w) {
				t.Errorf("%+v: %q missing from\n%s", p, w, f)
			}
		}
		if strings.Contains(f, "Starting Whombat") {
			t.Errorf("%+v: still says it is starting:\n%s", p, f)
		}
		claimed := Render(Screen{State: Claimed, URL: "a.b/claim", Openable: true, Start: &p}, now, 200, 0, nil)
		if strings.Contains(claimed, "can’t start") {
			t.Errorf("a started box shows the start problem:\n%s", claimed)
		}
	}
}
