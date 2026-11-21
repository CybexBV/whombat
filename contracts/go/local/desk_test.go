package local

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/CybexBV/whombat/contracts/go/internal/vectors"
)

func TestDeskVectors(t *testing.T) {
	var v struct {
		DeskStates []struct {
			State json.RawMessage `json:"state"`
			Valid bool            `json:"valid"`
		} `json:"deskStates"`
		DeskTalkRequests []struct {
			Request json.RawMessage `json:"request"`
			Valid   bool            `json:"valid"`
		} `json:"deskTalkRequests"`
		DeskTalkSessions []struct {
			Session json.RawMessage `json:"session"`
			Valid   bool            `json:"valid"`
		} `json:"deskTalkSessions"`
		DeskServerPages []struct {
			Page  json.RawMessage `json:"page"`
			Valid bool            `json:"valid"`
		} `json:"deskServerPages"`
		DeskServerIDs []struct {
			ID    string `json:"id"`
			Valid bool   `json:"valid"`
		} `json:"deskServerIds"`
		DeskDecideRequests []struct {
			Request        json.RawMessage `json:"request"`
			ApproveWithPin bool            `json:"approveWithPin"`
			Valid          bool            `json:"valid"`
			NeedsPin       bool            `json:"needsPin"`
		} `json:"deskDecideRequests"`
	}
	vectors.Load(t, "local.json", &v)
	if len(v.DeskStates) == 0 || len(v.DeskTalkRequests) == 0 || len(v.DeskTalkSessions) == 0 ||
		len(v.DeskServerPages) == 0 || len(v.DeskServerIDs) == 0 || len(v.DeskDecideRequests) == 0 {
		t.Fatal("no vectors")
	}
	for _, c := range v.DeskDecideRequests {
		r, err := ParseDeskDecideRequest(c.Request)
		if err != nil {
			t.Fatalf("%s: %v", c.Request, err)
		}
		if got := DeskDecideRequestValid(*r); got != c.Valid {
			t.Errorf("DeskDecideRequestValid(%s) = %v, want %v", c.Request, got, c.Valid)
		}
		if got := DeskDecideNeedsPin(c.ApproveWithPin, *r); got != c.NeedsPin {
			t.Errorf("DeskDecideNeedsPin(%v, %s) = %v, want %v", c.ApproveWithPin, c.Request, got, c.NeedsPin)
		}
	}
	for _, c := range v.DeskStates {
		s, err := ParseDeskState(c.State)
		if err != nil {
			t.Fatalf("%s: %v", c.State, err)
		}
		if got := DeskStateValid(*s); got != c.Valid {
			t.Errorf("DeskStateValid(%s) = %v, want %v", c.State, got, c.Valid)
		}
	}
	for _, c := range v.DeskTalkRequests {
		r, err := ParseDeskTalkRequest(c.Request)
		if err != nil {
			t.Fatalf("%s: %v", c.Request, err)
		}
		if got := DeskTalkRequestValid(*r); got != c.Valid {
			t.Errorf("DeskTalkRequestValid(%s) = %v, want %v", c.Request, got, c.Valid)
		}
	}
	for _, c := range v.DeskTalkSessions {
		s, err := ParseDeskTalkSession(c.Session)
		if err != nil {
			t.Fatalf("%s: %v", c.Session, err)
		}
		if got := DeskTalkSessionValid(*s); got != c.Valid {
			t.Errorf("DeskTalkSessionValid(%s) = %v, want %v", c.Session, got, c.Valid)
		}
	}
	for _, c := range v.DeskServerPages {
		p, err := ParseDeskServerPage(c.Page)
		if err != nil {
			t.Fatalf("%s: %v", c.Page, err)
		}
		if got := DeskServerPageValid(*p); got != c.Valid {
			t.Errorf("DeskServerPageValid(%s) = %v, want %v", c.Page, got, c.Valid)
		}
	}
	for _, c := range v.DeskServerIDs {
		if got := ValidDeskServerID(c.ID); got != c.Valid {
			t.Errorf("ValidDeskServerID(%q) = %v, want %v", c.ID, got, c.Valid)
		}
	}
}

// A server's screen fits what the console server reads (0.115, CT-864): its widest, in any script.
func TestDeskServerPageWidest(t *testing.T) {
	w := func(n int) string { return strings.Repeat("🎉", n) }
	series := strings.TrimSuffix(strings.Repeat("100,", DeskServerPoints), ",")
	volume := `{"name":"` + w(40) + `","note":"` + w(40) + `","percent":100,"used":"` + w(16) + `","total":"` + w(16) +
		`","tone":"bad"}`
	guest := `{"name":"` + w(60) + `","kind":"container","state":"unhealthy","cpu":100,"memory":"` + w(16) + `"}`
	alert := `{"tone":"bad","title":"` + w(120) + `"}`
	list := func(item string, n int) string { return strings.TrimSuffix(strings.Repeat(item+",", n), ",") }
	page := `{"v":1,"now":"2026-10-21T12:34:00.123456789+02:00",` +
		`"server":{"name":"` + w(40) + `","mark":"` + strings.Repeat("x", 32) + `","state":"bad","note":"` + w(40) + `",` +
		`"cpu":{"value":100,"tone":"bad"},"memory":{"value":100,"tone":"bad"},"temp":{"value":-100,"tone":"bad"},` +
		`"id":"p` + strings.Repeat("x", 127) + `","disk":{"value":100,"tone":"bad"}},` +
		`"os":"` + w(60) + `","up":"` + w(40) + `",` +
		`"cpu":{"percent":100,"cores":4096,"load":"` + w(8) + `","tone":"bad"},` +
		`"memory":{"percent":100,"used":{"value":"` + w(8) + `","unit":"` + w(8) + `"},"total":"` + w(16) + `","tone":"bad"},` +
		`"disk":{"percent":100,"used":"` + w(16) + `","total":"` + w(16) + `","tone":"bad"},` +
		`"temp":{"value":-100,"limit":-100,"tone":"bad"},` +
		`"history":{"range":"24h","stepS":86400,"cpu":[` + series + `],"memory":[` + series + `],` +
		`"cpuPeak":{"percent":100,"at":"2026-10-21T12:34:00.123456789+02:00"},"memoryAvg":100},` +
		`"volumes":[` + list(volume, DeskServerVolumes) + `],` +
		`"guests":{"running":1000000,"off":1000000,"items":[` + list(guest, DeskServerGuests) + `]},` +
		`"network":{"down":"` + w(16) + `","up":"` + w(16) + `"},` +
		`"alerts":{"count":1000000,"items":[` + list(alert, DeskServerAlerts) + `]}}`
	p, err := ParseDeskServerPage([]byte(page))
	if err != nil {
		t.Fatal(err)
	}
	if !DeskServerPageValid(*p) {
		t.Fatal("the widest page is not valid")
	}
	if len(page) > DeskServerMaxBytes {
		t.Errorf("the widest page is %d bytes, over %d", len(page), DeskServerMaxBytes)
	}
}

// The console server validates the runtime's desk text (CT-529): any script on one line, the length in code points.
func TestDeskText(t *testing.T) {
	state := func(status string) []byte {
		return []byte(`{"v":1,"now":"2026-10-20T12:34:00Z","paired":null,"pairing":null,"lock":{"state":"locked"},` +
			`"glance":{"status":{"text":` + status + `},"needsYou":{"count":0,"items":[]},"working":null,"done":[],` +
			`"servers":[],"moreServers":0,"tiles":[]},"power":null,"talk":null}`)
	}
	ok := []string{
		`"Everything’s fine. I’m updating your server agents."`,
		`"Alles goed 🎉 — “Plex” läuft, 日本語"`,
		`"` + strings.Repeat("🎉", 200) + `"`,
	}
	for _, in := range ok {
		if _, err := ParseDeskState(state(in)); err != nil {
			t.Errorf("refused %s: %v", in, err)
		}
	}
	bad := []string{
		`"All fine.\nReally."`,
		`"pve\u200b-02 is down."`,
		`"21.4\u00a0°C"`,
		`"a\u202eb"`,
		`""`,
		`"` + strings.Repeat("x", 201) + `"`,
	}
	for _, in := range bad {
		if _, err := ParseDeskState(state(in)); err == nil {
			t.Errorf("accepted %s", in)
		}
	}
}

// A talk's answer and the voice service's text are the longest desk texts: 600 code points cross to RE2.
func TestDeskLongText(t *testing.T) {
	answer := strings.Repeat("ä", 600)
	in := `{"v":1,"text":"` + answer + `"}`
	if _, err := ParseVoiceTtsRequest([]byte(in)); err != nil {
		t.Errorf("refused 600 code points: %v", err)
	}
	if _, err := ParseVoiceTtsRequest([]byte(`{"v":1,"text":"` + answer + `x"}`)); err == nil {
		t.Error("accepted 601 code points")
	}
}
