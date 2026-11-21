package desk_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/CybexBV/whombat/appliance/console/internal/desk"
	"github.com/CybexBV/whombat/appliance/console/internal/desk/desktest"
)

// Task feedback (contracts 0.116, Whombat task-feedback.md TF-14…TF-17): an ask's wider choices and who asks reach the
// page cleaned, a decision's scope passes on as the contract allows it, the conversation's working row and task rows
// are checked and cleaned, and a talk that is working passes as it is.

// unlockedAsk is desktest.Paired unlocked, with one ask the screen may approve; ask is the ask's extra members.
func unlockedAsk(ask string) string {
	return strings.NewReplacer(
		`"lock":{"state":"locked"}`, `"lock":{"state":"unlocked","until":"2026-10-20T09:43:00Z"}`,
		`"needsYou":{"count":1,"items":[]}`, `"needsYou":{"count":1,"items":[{"number":7,"kind":"approval",`+
			`"title":"Install updates on Home Assistant?","at":"2026-10-20T09:40:00Z","onDesk":true`+ask+`}]}`,
	).Replace(desktest.Paired)
}

func TestAskChoices(t *testing.T) {
	f := desktest.Start(t)
	f.Set(desk.PathState, desktest.Answer{Body: unlockedAsk(
		`,"from":"  Banjo ","choices":[{"scope":"agent","label":" Don’t ask again on Home Assistant "},{"scope":"task","label":" "}]`)})
	c, _ := newClient(t, f)
	st := c.State(context.Background())
	if st == nil {
		t.Fatal("no state")
	}
	a := st.Glance.NeedsYou.Items[0]
	// Trimmed; a choice left without its label goes.
	if a.From == nil || *a.From != "Banjo" || len(a.Choices) != 1 || a.Choices[0].Scope != "agent" ||
		a.Choices[0].Label != "Don’t ask again on Home Assistant" {
		t.Fatalf("%+v", a)
	}
	// Nothing left of them is none, not an empty list or name.
	f.Set(desk.PathState, desktest.Answer{Body: unlockedAsk(`,"from":" ","choices":[{"scope":"agent","label":" "}]`)})
	c, _ = newClient(t, f)
	m := stateJSON(t, c.State(context.Background()))
	item := m["glance"].(map[string]any)["needsYou"].(map[string]any)["items"].([]any)[0].(map[string]any)
	if _, ok := item["choices"]; ok {
		t.Fatalf("%v", item)
	}
	if _, ok := item["from"]; ok {
		t.Fatalf("%v", item)
	}
	// The contract's rules (DeskStateValid, CT-890): choices only unlocked, on an ask the screen may approve, with a PIN,
	// each scope once; anything else is no desk at all.
	for name, body := range map[string]string{
		"locked": strings.Replace(unlockedAsk(`,"choices":[{"scope":"agent","label":"Always"}]`),
			`"lock":{"state":"unlocked","until":"2026-10-20T09:43:00Z"}`, `"lock":{"state":"locked"}`, 1),
		"on the phone": strings.Replace(unlockedAsk(`,"choices":[{"scope":"agent","label":"Always"}]`),
			`"onDesk":true`, `"onDesk":false,"phoneReason":"keys"`, 1),
		"twice":      unlockedAsk(`,"choices":[{"scope":"agent","label":"Always"},{"scope":"agent","label":"Again"}]`),
		"once":       unlockedAsk(`,"choices":[{"scope":"once","label":"Once"}]`),
		"three":      unlockedAsk(`,"choices":[{"scope":"agent","label":"A"},{"scope":"task","label":"B"},{"scope":"agent","label":"C"}]`),
		"no PIN":     strings.Replace(unlockedAsk(`,"choices":[{"scope":"agent","label":"Always"}]`), `"hasPin":true`, `"hasPin":false`, 1),
		"long label": unlockedAsk(`,"choices":[{"scope":"agent","label":"` + strings.Repeat("a", 121) + `"}]`),
		"long from":  unlockedAsk(`,"from":"` + strings.Repeat("a", 41) + `"`),
	} {
		f.Set(desk.PathState, desktest.Answer{Body: body})
		c, _ := newClient(t, f)
		if st := c.State(context.Background()); st != nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// A risky ask the screen may approve with the PIN (DK-62) may offer them too.
	f.Set(desk.PathState, desktest.Answer{Body: strings.Replace(unlockedAsk(`,"choices":[{"scope":"agent","label":"Always allow Banjo to deploy"}]`),
		`"onDesk":true`, `"onDesk":false,"phoneReason":"release","approveWithPin":true`, 1)})
	c, _ = newClient(t, f)
	if st := c.State(context.Background()); st == nil || len(st.Glance.NeedsYou.Items[0].Choices) != 1 {
		t.Fatalf("%+v", st)
	}
}

func TestDecideScope(t *testing.T) {
	f := desktest.Start(t)
	c, _ := newClient(t, f)
	ctx := context.Background()
	str := func(s string) *string { return &s }
	f.Set(desk.PathDecide, desktest.Answer{Body: `{"v":1,"result":"decided"}`})
	// A wider choice with the PIN, and once (with or without it), pass on as sent.
	for _, tc := range []struct {
		pin, scope *string
		body       string
	}{
		{str("2580"), str("agent"), `{"v":1,"number":7,"decision":"approve","pin":"2580","scope":"agent"}`},
		{str("2580"), str("task"), `{"v":1,"number":7,"decision":"approve","pin":"2580","scope":"task"}`},
		{nil, str("once"), `{"v":1,"number":7,"decision":"approve","scope":"once"}`},
	} {
		if a, err := c.Decide(ctx, 7, "approve", tc.pin, tc.scope); err != nil || a.Result != "decided" {
			t.Fatal(a, err)
		}
		if got := f.Calls()[len(f.Calls())-1]; got.Body != tc.body {
			t.Fatalf("%s", got.Body)
		}
	}
	calls := f.CallsTo(desk.PathDecide)
	// A scope that isn't one, or with Deny or Not now: 400; a wider one without the PIN: 403 pin_needed. Unasked.
	for _, tc := range []struct {
		decision   string
		pin, scope *string
		status     int
		code       string
	}{
		{"approve", str("2580"), str("always"), 400, "bad_request"},
		{"approve", str("2580"), str(""), 400, "bad_request"},
		{"deny", str("2580"), str("agent"), 400, "bad_request"},
		{"decline", nil, str("once"), 400, "bad_request"},
		{"approve", nil, str("agent"), 403, "pin_needed"},
		{"approve", nil, str("task"), 403, "pin_needed"},
	} {
		if _, err := c.Decide(ctx, 7, tc.decision, tc.pin, tc.scope); !isErr(err, tc.status, tc.code) {
			t.Errorf("%+v: %v", tc, err)
		}
	}
	if n := f.CallsTo(desk.PathDecide); n != calls {
		t.Fatalf("a malformed decision reached the runtime (%d)", n-calls)
	}
	// The runtime's 403 not_offered (CT-891) reaches the page as it is.
	f.Set(desk.PathDecide, desktest.Answer{Status: 403, Body: `{"error":{"code":"not_offered","message":"x"}}`})
	if _, err := c.Decide(ctx, 7, "approve", str("2580"), str("agent")); !isErr(err, 403, "not_offered") {
		t.Fatal(err)
	}
}

// sessionWork is an open conversation with the assistant working in it, a running task and one that didn’t work.
const sessionWork = `{"v":1,"open":true,"messages":[
  {"id":"msg_Hq2v8LkP0aXz","from":"you","at":"2026-10-20T12:30:00Z","paragraphs":["Update Home Assistant"],"talk":"dtk_q3Vx9LpA0dZk"},
  {"id":"msg_Tk1a2b3c4d5e","from":"assistant","at":"2026-10-20T12:31:00Z",
   "paragraphs":["Installing 23 updates on Home Assistant · 12 s"],
   "task":{"title":"  Installing 23 updates on Home Assistant ","state":"running","startedAt":"2026-10-20T12:31:00Z"}},
  {"id":"msg_Tk9z8y7x6w5v","from":"assistant","at":"2026-10-20T12:20:00Z",
   "paragraphs":["Backing up web on pve-02 didn’t work: the storage is full · 2 min"],
   "task":{"title":"Backing up web on pve-02","state":"error","startedAt":"2026-10-20T12:18:00Z",
    "endedAt":"2026-10-20T12:20:00Z","result":" Backing up web on pve-02 didn’t work: the storage is full. "}}],
 "earlier":0,"until":"2026-10-20T13:01:00Z",
 "working":{"since":"2026-10-20T12:30:05Z","doing":" Installing updates on Home Assistant "}}`

func TestSessionWork(t *testing.T) {
	f := desktest.Start(t)
	c, _ := newClient(t, f)
	ctx := context.Background()
	f.Set(desk.PathTalkSession, desktest.Answer{Body: sessionWork})
	s, err := c.TalkSession(ctx)
	if err != nil {
		t.Fatal(err)
	}
	run, ended := s.Messages[1].Task, s.Messages[2].Task
	if s.Working == nil || *s.Working.Doing != "Installing updates on Home Assistant" ||
		run == nil || run.Title != "Installing 23 updates on Home Assistant" || run.EndedAt != nil ||
		ended == nil || *ended.Result != "Backing up web on pve-02 didn’t work: the storage is full." {
		b, _ := json.Marshal(s)
		t.Fatalf("%s", b)
	}
	// A task left without its title goes; the message stays as its line. A `doing` left empty is none.
	f.Set(desk.PathTalkSession, desktest.Answer{Body: strings.NewReplacer(
		`"title":"  Installing 23 updates on Home Assistant "`, `"title":" "`,
		`"doing":" Installing updates on Home Assistant "`, `"doing":" "`).Replace(sessionWork)})
	if s, err := c.TalkSession(ctx); err != nil || s.Messages[1].Task != nil || len(s.Messages[1].Paragraphs) != 1 ||
		s.Working == nil || s.Working.Doing != nil {
		t.Fatal(s, err)
	}
	// The contract's rules (DeskTalkSessionValid, CT-894, CT-895): a running task has no end or result, an ended one
	// its end; never a task beside an ask; nothing working in a closed conversation. Else a failure, not passed on.
	for name, body := range map[string]string{
		"running with an end": strings.Replace(sessionWork, `"state":"running","startedAt":"2026-10-20T12:31:00Z"`,
			`"state":"running","startedAt":"2026-10-20T12:31:00Z","endedAt":"2026-10-20T12:32:00Z"`, 1),
		"ended without one": strings.Replace(sessionWork, `"endedAt":"2026-10-20T12:20:00Z",`, ``, 1),
		"a task and an ask": strings.Replace(sessionWork, `"paragraphs":["Installing 23 updates on Home Assistant · 12 s"],`,
			`"paragraphs":["x"],"ask":{"number":3,"state":"waiting"},`, 1),
		"unknown state":  strings.Replace(sessionWork, `"state":"error"`, `"state":"failed"`, 1),
		"closed working": `{"v":1,"open":false,"messages":[],"earlier":0,"working":{"since":"2026-10-20T12:30:05Z"}}`,
	} {
		f.Set(desk.PathTalkSession, desktest.Answer{Body: body})
		if _, err := c.TalkSession(ctx); !isErr(err, 502, "failed") {
			t.Errorf("%s: %v", name, err)
		}
	}
}

// A talk past 90 s is `working` (CT-893, TF-16): not final, no answer and no reason; it passes as it is.
func TestTalkWorking(t *testing.T) {
	f := desktest.Start(t)
	c, _ := newClient(t, f)
	ctx := context.Background()
	f.Set(desk.PathTalkGet, desktest.Answer{Body: `{"v":1,"id":"talk-0001","state":"working","question":"update it","thing":null,"audio":false}`})
	if tk, err := c.TalkGet(ctx, "talk-0001"); err != nil || tk.State != "working" || tk.Answer != nil {
		t.Fatal(tk, err)
	}
	f.Set(desk.PathTalkGet, desktest.Answer{Body: `{"v":1,"id":"talk-0001","state":"working","answer":"x","thing":null,"audio":false}`})
	if _, err := c.TalkGet(ctx, "talk-0001"); !isErr(err, 502, "failed") {
		t.Fatal(err)
	}
}
