package desk

import (
	"strings"
	"testing"

	"github.com/CybexBV/whombat/contracts/go/local"
)

// The console's own cleaning, whatever a contract lets through: one line of plain text per string, within the bounds.
func TestCleanState(t *testing.T) {
	s := func(v string) *string { return &v }
	st := &State{
		Paired: &Paired{},
		Glance: &Glance{Status: local.DeskStatus{Text: "1 thing  needs you.​", More: s(" ‮ ")},
			NeedsYou: local.DeskNeedsYou{Count: 1, Items: []Ask{{Title: "Restart\u0007 Plex",
				Where: s("pve-02\u0085"), Facts: []string{"ok", "​", strings.Repeat("x", 90)}, ApproveLabel: s("Restart Plex‮")}}}},
		Talk: &Talk{Answer: s("It’s fine.‮ "), Question: s("​"), Thing: &Server{Name: "pve‍-02", Note: "up\u0000 41 d"}},
	}
	st.Paired.Person.Name, st.Paired.Person.Initial, st.Paired.Assistant.Name = "Jo‮hn\u0007", "J​K ", " Neo "
	cleanState(st)
	a := st.Glance.NeedsYou.Items[0]
	for got, want := range map[string]string{
		st.Paired.Person.Name: "John", st.Paired.Person.Initial: "JK", st.Paired.Assistant.Name: "Neo",
		st.Glance.Status.Text: "1 thing needs you.", a.Title: "Restart Plex", *a.Where: "pve-02", *a.ApproveLabel: "Restart Plex",
		*st.Talk.Answer: "It’s fine.", st.Talk.Thing.Name: "pve-02", st.Talk.Thing.Note: "up 41 d",
	} {
		if got != want {
			t.Errorf("%q, want %q", got, want)
		}
	}
	if st.Glance.Status.More != nil || st.Talk.Question != nil {
		t.Error("a string with nothing left stays")
	}
	if len(a.Facts) != 2 || a.Facts[0] != "ok" || len([]rune(a.Facts[1])) != maxFact {
		t.Errorf("%q", a.Facts)
	}
}

// This Whombat's words (DK-22) as every other display string: one line, plain, within the bounds.
func TestCleanBox(t *testing.T) {
	b := &Box{Up: " up 2 h‮ ", Memory: local.DeskBoxMemory{Used: local.DeskFigure{Value: "11.2​", Unit: "GB"}, Total: "64 GB "},
		Storage: local.DeskBoxStorage{Free: local.DeskFigure{Value: "812", Unit: "GB"}, Total: strings.Repeat("9", 20),
			Parts: []local.DeskBoxPart{{Key: "whombat", Value: "41‍ GB"}}},
		Network: &local.DeskBoxNetwork{Down: "2.4 MB/s", Up: "310 kB/s"}}
	st := &State{Glance: &Glance{Box: b}}
	cleanState(st)
	for got, want := range map[string]string{
		b.Up: "up 2 h", b.Memory.Used.Value: "11.2", b.Memory.Used.Unit: "GB", b.Memory.Total: "64 GB",
		b.Storage.Parts[0].Value: "41 GB", b.Network.Down: "2.4 MB/s", b.Storage.Total: strings.Repeat("9", maxBoxText),
	} {
		if got != want {
			t.Errorf("%q, want %q", got, want)
		}
	}
}

// What needs a look (0.118, DK-93) as every other display string; one left without its name goes, none left is none.
func TestCleanLooks(t *testing.T) {
	s := func(v string) *string { return &v }
	st := &State{Glance: &Glance{NeedsYou: local.DeskNeedsYou{Looks: []Look{
		{Key: "connection:con_7Hq2v8LkP0aX", Kind: local.DeskLookKindConnection, Name: "Home‮ Assistant",
			State: local.DeskLookStateLook, Reason: s("2 integrations\u0007 not loading")},
		{Key: "server:pve-02", Kind: local.DeskLookKindServer, Name: "​", State: local.DeskLookStateDown},
	}}}}
	cleanState(st)
	looks := st.Glance.NeedsYou.Looks
	if len(looks) != 1 || looks[0].Name != "Home Assistant" || *looks[0].Reason != "2 integrations not loading" {
		t.Fatalf("%+v", looks)
	}
	st.Glance.NeedsYou.Looks = []Look{{Key: " ", Name: "pve-02"}}
	cleanState(st)
	if st.Glance.NeedsYou.Looks != nil {
		t.Errorf("%+v", st.Glance.NeedsYou.Looks)
	}
}

// The calm glance's words (3.2, CG-350) as every other display string; what can't be drawn without its words goes.
func TestCleanCalm(t *testing.T) {
	s := func(v string) *string { return &v }
	name := " Home\u0007 "
	st := &State{Name: &name, Glance: &Glance{Calm: &local.DeskGlanceCalm{
		Headline: local.DeskGlanceCalmHeadline{Tone: "bad", Text: "1 thing​ is wrong"},
		Hero:     &local.DeskGlanceCalmHero{Kind: "look", Tone: "bad", Title: "pve-02 isn’t answering‮", Detail: s("​")},
		Also:     []local.DeskGlanceCalmAlsoItem{{Name: "nas", Text: "disk 88 %"}, {Name: "​", Text: "gone"}},
		Moments:  []local.DeskGlanceCalmMomentsItem{{Key: "work", Name: "Neo", Value: "\u0085"}},
		Strip:    []local.DeskGlanceCalmStripItem{{Name: "pve-01", Say: s("not\u0007 answering")}, {Name: " "}},
		Digest:   &local.DeskGlanceCalmDigest{ID: "dig_abcdefgh", Items: []local.DeskGlanceCalmDigestItemsItem{{Text: "​"}}},
	}}}
	cleanState(st)
	c := st.Glance.Calm
	if *st.Name != "Home" || c.Headline.Text != "1 thing is wrong" || c.Hero.Title != "pve-02 isn’t answering" {
		t.Errorf("%q %q %q", *st.Name, c.Headline.Text, c.Hero.Title)
	}
	if c.Hero.Detail != nil || len(c.Also) != 1 || len(c.Moments) != 0 || len(c.Strip) != 1 || c.Digest != nil {
		t.Errorf("left: %+v", c)
	}
	if *c.Strip[0].Say != "not answering" {
		t.Errorf("%q", *c.Strip[0].Say)
	}
}

// What the assistant found out about a look (3.5, CG-370) as every other display string; the step only while it is
// offered; research about another look goes; a hero's research and step only on a look's hero, the step once found.
func TestCleanResearch(t *testing.T) {
	s := func(v string) *string { return &v }
	key := "connection:con_7Hq2v8LkP0aX"
	st := &State{Glance: &Glance{NeedsYou: local.DeskNeedsYou{Looks: []Look{
		{Key: key, Kind: local.DeskLookKindConnection, Name: "Home Assistant", State: local.DeskLookStateLook,
			Research: &LookResearch{Key: key, State: "found", Title: s("Zigbee stopped working‮ in Home Assistant"),
				Summary: s(" " + strings.Repeat("x", 250)), Fix: s("Restart\u0007 Zigbee"), At: "2026-10-27T07:15:00Z"}},
		{Key: "server:pve-02", Kind: local.DeskLookKindServer, Name: "pve-02", State: local.DeskLookStateDown,
			Research: &LookResearch{Key: "server:pve-02", State: "fixing", Title: s("​"), Fix: s("Restart pve-02"), At: "2026-10-27T07:15:00Z"}},
		{Key: "server:nas", Kind: local.DeskLookKindServer, Name: "nas", State: local.DeskLookStateBad,
			Research: &LookResearch{Key: "server:pve-02", State: "found", At: "2026-10-27T07:15:00Z"}},
	}}, Calm: &local.DeskGlanceCalm{Hero: &local.DeskGlanceCalmHero{Kind: "look", Tone: "bad", Title: "Zigbee stopped working",
		Research: s("found"), Fix: s(" Restart Zigbee‍ ")}}}}
	cleanState(st)
	looks := st.Glance.NeedsYou.Looks
	r := looks[0].Research
	if r == nil || *r.Title != "Zigbee stopped working in Home Assistant" || len([]rune(*r.Summary)) != maxResearchSummary ||
		*r.Fix != "Restart Zigbee" || r.At != "2026-10-27T07:15:00Z" {
		t.Fatalf("%+v", r)
	}
	if r := looks[1].Research; r == nil || r.State != "fixing" || r.Title != nil || r.Fix != nil {
		t.Errorf("a step that isn't offered stays: %+v", r)
	}
	if looks[2].Research != nil {
		t.Errorf("another look's research stays: %+v", looks[2].Research)
	}
	if h := st.Glance.Calm.Hero; *h.Research != "found" || *h.Fix != "Restart Zigbee" {
		t.Errorf("%+v", h)
	}
	for _, h := range []*local.DeskGlanceCalmHero{
		{Kind: "look", Tone: "bad", Title: "Zigbee", Research: s("fixed"), Fix: s("Restart Zigbee")},
		{Kind: "look", Tone: "bad", Title: "Zigbee", Fix: s("Restart Zigbee")},
		{Kind: "ask", Tone: "bad", Title: "Restart Plex?", Research: s("found"), Fix: s("Restart Plex")},
	} {
		st := &State{Glance: &Glance{Calm: &local.DeskGlanceCalm{Hero: h}}}
		cleanState(st)
		if h := st.Glance.Calm.Hero; h.Fix != nil || (h.Kind == "ask" && h.Research != nil) {
			t.Errorf("%+v", h)
		}
	}
}
