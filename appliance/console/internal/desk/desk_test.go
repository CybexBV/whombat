package desk_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/console/internal/desk"
	"github.com/CybexBV/whombat/appliance/console/internal/desk/desktest"
	"github.com/CybexBV/whombat/contracts/go/local"
)

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

func newClient(t *testing.T, f *desktest.Fake) (*desk.Client, *clock) {
	t.Helper()
	ck := &clock{t: time.Date(2026, 10, 20, 9, 41, 0, 0, time.UTC)}
	return desk.New(f.Socket, os.Getuid(), ck.now, t.Logf), ck
}

func stateJSON(t *testing.T, st *desk.State) map[string]any {
	t.Helper()
	b, err := json.Marshal(st)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	return m
}

// The state is the runtime's, checked, and asked at most once a second; a request that changes it drops the cache.
func TestStateCache(t *testing.T) {
	f := desktest.Start(t)
	c, ck := newClient(t, f)
	ctx := context.Background()
	st := c.State(ctx)
	if st == nil || st.Paired == nil || st.Paired.Person.Name != "John" || st.Lock.State != "locked" || st.Power.Source != "battery" ||
		*st.Power.MinutesLeft != 185 || st.Glance.Servers[0].Cpu.Value != 41 {
		t.Fatalf("%+v", st)
	}
	c.State(ctx)
	ck.add(999 * time.Millisecond)
	c.State(ctx)
	if n := f.CallsTo(desk.PathState); n != 1 {
		t.Fatalf("asked %d times within a second", n)
	}
	ck.add(time.Millisecond)
	c.State(ctx)
	if n := f.CallsTo(desk.PathState); n != 2 {
		t.Fatalf("not asked again after a second: %d", n)
	}
	f.Set(desk.PathLock, desktest.Answer{Body: `{"v":1}`})
	if _, err := c.Lock(ctx); err != nil {
		t.Fatal(err)
	}
	c.State(ctx)
	if n := f.CallsTo(desk.PathState); n != 3 {
		t.Fatalf("the cache outlived a lock: %d", n)
	}
	// The JSON the page gets keeps the contract's member names, null where the runtime sent null.
	m := stateJSON(t, c.State(ctx))
	if m["pairing"] != nil || m["talk"] != nil || m["glance"].(map[string]any)["working"] != nil ||
		m["glance"].(map[string]any)["moreServers"] != float64(0) || m["paired"].(map[string]any)["lockedView"] != "summary" {
		t.Fatalf("%v", m)
	}
	if _, ok := m["lock"].(map[string]any)["until"]; ok {
		t.Fatalf("an absent optional member is sent: %v", m["lock"])
	}
}

// The contract refuses control and format characters in display texts (the whole state goes); what it lets through is
// trimmed (and cleaned again by the console, clean_test.go).
func TestStateCleaned(t *testing.T) {
	f := desktest.Start(t)
	c, _ := newClient(t, f)
	f.Set(desk.PathState, desktest.Answer{Body: strings.Replace(desktest.Paired, `"label":"Living room"`, `"label":"  Living room  "`, 1)})
	st := c.State(context.Background())
	if st == nil || st.Glance.Tiles[0].Label != "Living room" {
		t.Fatalf("%+v", st)
	}
	for _, evil := range []string{`"name":"Jo‮hn"`, `"name":"John\u0007"`, `"name":"Jo hn"`, `"name":"Jo​hn"`} {
		f := desktest.Start(t)
		f.Set(desk.PathState, desktest.Answer{Body: strings.Replace(desktest.Paired, `"name":"John"`, evil, 1)})
		c, _ := newClient(t, f)
		if st := c.State(context.Background()); st != nil {
			t.Errorf("%s: accepted", evil)
		}
	}
}

// A new box (DK-22, CG-57): This Whombat and a screen without a PIN reach the page, the box's words trimmed; the
// box's rules are the contract's (DeskStateValid).
func TestNewBox(t *testing.T) {
	f := desktest.Start(t)
	f.Set(desk.PathState, desktest.Answer{Body: strings.Replace(desktest.NewBox, `"up":"up 2 h 14 min"`, `"up":"  up 2 h 14 min "`, 1)})
	c, _ := newClient(t, f)
	st := c.State(context.Background())
	if st == nil || st.Glance.Box == nil || st.Paired.HasPin {
		t.Fatalf("%+v", st)
	}
	b := st.Glance.Box
	if b.Up != "up 2 h 14 min" || b.Memory.Used.Value != "11.2" || b.Storage.Free.Unit != "GB" || len(b.Storage.Parts) != 2 ||
		b.Temp == nil || b.Temp.Value != 46 || b.Network == nil || b.Network.Up != "310 kB/s" {
		t.Fatalf("%+v", b)
	}
	if h := b.History; len(h.Cpu) != 4 || h.Cpu[1] != nil || *h.Cpu[2] != 9 {
		t.Fatalf("%+v", h)
	}
	for name, edit := range map[string][2]string{
		"a box beside a server":    {`"servers":[]`, `"servers":[{"name":"pve-01","state":"ok","note":"up 41 d"}]`},
		"a box beside a tile":      {`"tiles":[]`, `"tiles":[{"icon":"sun","value":"3.2 kW","label":"Solar"}]`},
		"a box in Only the time":   {`"lockedView":"summary"`, `"lockedView":"time"`},
		"two lengths of history":   {`"memory":[17,null,18,18]`, `"memory":[17,18,18]`},
		"a percentage over 100":    {`"percent":13`, `"percent":113`},
		"a part nobody knows":      {`"key":"agent"`, `"key":"photos"`},
		"the agents part of 0.122": {`"key":"agent"`, `"key":"agents"`},
		"a figure that is a word":  {`"value":"812"`, `"value":"eight hundred"`},
		"control characters":       {`"up":"up 2 h 14 min"`, `"up":"up 2 h"`},
	} {
		if !strings.Contains(desktest.NewBox, edit[0]) {
			t.Fatalf("%s: the fixture changed", name)
		}
		f := desktest.Start(t)
		f.Set(desk.PathState, desktest.Answer{Body: strings.Replace(desktest.NewBox, edit[0], edit[1], 1)})
		c, _ := newClient(t, f)
		if st := c.State(context.Background()); st != nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// Unlocked, a box may show in *Only the time* too (what shows unlocked is everything); without a sensor and a
	// rate the panel has neither.
	f = desktest.Start(t)
	body := strings.NewReplacer(`"lockedView":"summary"`, `"lockedView":"time"`, `"lock":{"state":"locked"}`,
		`"lock":{"state":"unlocked","until":"2026-10-20T12:36:20Z"}`, `"temp":{"value":46,"tone":"ok"},`, ``,
		`"network":{"down":"2.4 MB/s","up":"310 kB/s"}`, `"network":null`).Replace(desktest.NewBox)
	f.Set(desk.PathState, desktest.Answer{Body: body})
	c, _ = newClient(t, f)
	if st := c.State(context.Background()); st == nil || st.Glance.Box == nil || st.Glance.Box.Temp != nil || st.Glance.Box.Network != nil {
		t.Fatalf("%+v", st)
	}
}

// This Whombat beside servers and the next four of each (0.104, DK-39, DK-41; CG-141): passed to the page as sent,
// their words cleaned as the first ones', and only where the contract allows them.
func TestFit(t *testing.T) {
	f := desktest.Start(t)
	body := strings.NewReplacer(`"name":"media"`, `"name":" media "`, `"up":"up 2 h 14 min"`, `"up":"up 2 h 14 min  "`,
		`"label":"Water today"`, `"label":" Water today "`).Replace(desktest.Fit)
	f.Set(desk.PathState, desktest.Answer{Body: body})
	c, _ := newClient(t, f)
	st := c.State(context.Background())
	if st == nil || st.Glance.Self == nil || st.Glance.Box != nil || len(st.Glance.ExtraServers) != 4 ||
		len(st.Glance.ExtraTiles) != 2 || st.Glance.MoreServers != 6 {
		t.Fatalf("%+v", st)
	}
	g := stateJSON(t, st)["glance"].(map[string]any)
	extra := g["extraServers"].([]any)
	if extra[0].(map[string]any)["mark"] != "truenas" || extra[3].(map[string]any)["name"] != "media" ||
		g["extraTiles"].([]any)[1].(map[string]any)["label"] != "Water today" ||
		g["self"].(map[string]any)["up"] != "up 2 h 14 min" || g["self"].(map[string]any)["storage"].(map[string]any)["percent"] != 13.0 {
		t.Fatalf("%v", g)
	}
	if _, ok := g["box"]; ok {
		t.Error("a box beside servers")
	}
	// A runtime from before 0.104 sends none of them; the page gets none (empty lists are left out too).
	f = desktest.Start(t)
	f.Set(desk.PathState, desktest.Answer{Body: desktest.Paired})
	c, _ = newClient(t, f)
	g = stateJSON(t, c.State(context.Background()))["glance"].(map[string]any)
	for _, k := range []string{"self", "extraServers", "extraTiles", "box"} {
		if _, ok := g[k]; ok {
			t.Errorf("%s from a runtime before 0.104", k)
		}
	}
	// Each edit below breaks one rule; the fixture through the same JSON round trip is accepted.
	f = desktest.Start(t)
	f.Set(desk.PathState, desktest.Answer{Body: editFit(t, func(map[string]any) {})})
	if c, _ = newClient(t, f); c.State(context.Background()) == nil {
		t.Fatal("the round trip broke the fixture")
	}
	for name, edit := range map[string]func(g map[string]any){
		"self beside nothing": func(g map[string]any) {
			g["servers"], g["tiles"], g["moreServers"] = []any{}, []any{}, 0
			delete(g, "extraServers")
			delete(g, "extraTiles")
		},
		"self beside a box":          func(g map[string]any) { g["box"] = g["self"] },
		"extra servers beside three": func(g map[string]any) { g["servers"] = g["servers"].([]any)[:3]; g["moreServers"] = 7 },
		"more extra than counted":    func(g map[string]any) { g["moreServers"] = 3 },
		"extra tiles beside three":   func(g map[string]any) { g["tiles"] = g["tiles"].([]any)[:3] },
		"five extra servers": func(g map[string]any) {
			g["extraServers"] = append(g["extraServers"].([]any), g["servers"].([]any)[0])
		},
		"self in Only the time": nil,
	} {
		body := editFit(t, edit)
		if edit == nil {
			body = strings.Replace(desktest.Fit, `"lockedView":"summary"`, `"lockedView":"time"`, 1)
		}
		f := desktest.Start(t)
		f.Set(desk.PathState, desktest.Answer{Body: body})
		c, _ := newClient(t, f)
		if st := c.State(context.Background()); st != nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

// Found on your network (0.110, DF-01…DF-07; CG-238): passed to the page as sent, its words cleaned as every display
// string, and only where the contract allows it (not in *Only the time*, consistent: DeskFoundValid).
func TestFound(t *testing.T) {
	f := desktest.Start(t)
	f.Set(desk.PathState, desktest.Answer{Body: strings.NewReplacer(`"name":"Proxmox VE"`, `"name":"  Proxmox VE "`,
		`"address":"10.100.0.5"`, `"address":"10.100.0.5  "`).Replace(desktest.Found)})
	c, _ := newClient(t, f)
	st := c.State(context.Background())
	if st == nil || st.Glance.Found == nil || st.Glance.Box == nil {
		t.Fatalf("%+v", st)
	}
	g := stateJSON(t, st)["glance"].(map[string]any)
	found := g["found"].(map[string]any)
	items := found["items"].([]any)
	first, second := items[0].(map[string]any), items[1].(map[string]any)
	if len(items) != 3 || found["count"] != 4.0 || found["progress"] != nil || found["finishedAt"] != "2026-10-20T12:33:50Z" ||
		first["address"] != "10.100.0.5" || second["name"] != "Proxmox VE" || items[2].(map[string]any)["catalogId"] != "synology" {
		t.Fatalf("%v", found)
	}
	// The first scan looking (DF-07): the progress, nothing finished yet, nothing found yet.
	f = desktest.Start(t)
	f.Set(desk.PathState, desktest.Answer{Body: editFound(t, func(f map[string]any) {
		f["scanning"], f["progress"], f["count"], f["finishedAt"], f["items"] = true, map[string]any{"done": 412, "total": 1022}, 0, nil, []any{}
	})})
	c, _ = newClient(t, f)
	if st := c.State(context.Background()); st == nil || st.Glance.Found == nil || st.Glance.Found.Progress == nil ||
		st.Glance.Found.Progress.Done != 412 || len(st.Glance.Found.Items) != 0 {
		t.Fatalf("%+v", st)
	}
	// A runtime from before 0.110 sends none; the page gets none.
	f = desktest.Start(t)
	f.Set(desk.PathState, desktest.Answer{Body: desktest.NewBox})
	c, _ = newClient(t, f)
	if _, ok := stateJSON(t, c.State(context.Background()))["glance"].(map[string]any)["found"]; ok {
		t.Error("found from a runtime before 0.110")
	}
	for name, edit := range map[string][2]string{
		"found in Only the time":   {`"lockedView":"summary"`, `"lockedView":"time"`},
		"more named than counted":  {`"count":4`, `"count":2`},
		"done, without its time":   {`"finishedAt":"2026-10-20T12:33:50Z"`, `"finishedAt":null`},
		"progress after the scan":  {`"progress":null`, `"progress":{"done":1,"total":2}`},
		"a catalog id that isn't":  {`"catalogId":"synology"`, `"catalogId":"Synology DSM"`},
		"a name with a line break": {`"name":"Home Assistant"`, `"name":"Home\nAssistant"`},
		"a short line over 40":     {`"tagline":"Files, backups and photos"`, `"tagline":"` + strings.Repeat("x", 41) + `"`},
		"an address that is empty": {`"address":"10.100.0.240"`, `"address":""`},
		"nothing found, scan done": {`"count":4`, `"count":0`},
		"the count isn't a number": {`"count":4`, `"count":"4"`},
	} {
		if !strings.Contains(desktest.Found, edit[0]) {
			t.Fatalf("%s: the fixture changed", name)
		}
		f := desktest.Start(t)
		f.Set(desk.PathState, desktest.Answer{Body: strings.Replace(desktest.Found, edit[0], edit[1], 1)})
		c, _ := newClient(t, f)
		if st := c.State(context.Background()); st != nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// Nothing found once the scan is done: nothing to show, so no found (DeskFoundValid).
	f = desktest.Start(t)
	f.Set(desk.PathState, desktest.Answer{Body: editFound(t, func(f map[string]any) { f["count"], f["items"] = 0, []any{} })})
	if c, _ = newClient(t, f); c.State(context.Background()) != nil {
		t.Error("nothing found, scan done: accepted")
	}
	// Unlocked, *Only the time* shows everything: found too.
	f = desktest.Start(t)
	f.Set(desk.PathState, desktest.Answer{Body: strings.NewReplacer(`"lockedView":"summary"`, `"lockedView":"time"`,
		`"lock":{"state":"locked"}`, `"lock":{"state":"unlocked","until":"2026-10-20T12:36:20Z"}`).Replace(desktest.Found)})
	c, _ = newClient(t, f)
	if st := c.State(context.Background()); st == nil || st.Glance.Found == nil {
		t.Fatalf("%+v", st)
	}
}

// editFound is desktest.Found with its found edited.
func editFound(t *testing.T, edit func(f map[string]any)) string {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(desktest.Found), &m); err != nil {
		t.Fatal(err)
	}
	edit(m["glance"].(map[string]any)["found"].(map[string]any))
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// editFit is desktest.Fit with its glance edited.
func editFit(t *testing.T, edit func(g map[string]any)) string {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(desktest.Fit), &m); err != nil {
		t.Fatal(err)
	}
	if edit != nil {
		edit(m["glance"].(map[string]any))
	}
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// The PIN's length and the camera (DK-26, DK-28, DK-30; CG-130): passed to the page as sent, and only where the
// contract allows them (the camera only while unlocked, someone seen only with the camera on).
func TestPresence(t *testing.T) {
	unlocked := `"lock":{"state":"unlocked","until":"2026-10-20T09:41:30Z","camera":true,"present":true}`
	body := strings.NewReplacer(`"voice":true,"hasPin":true}`, `"voice":true,"hasPin":true,"pinDigits":4}`, `"lock":{"state":"locked"}`, unlocked).
		Replace(desktest.Paired)
	f := desktest.Start(t)
	f.Set(desk.PathState, desktest.Answer{Body: body})
	c, _ := newClient(t, f)
	st := c.State(context.Background())
	if st == nil || st.Paired.PinDigits == nil || *st.Paired.PinDigits != 4 || st.Lock.Camera == nil || !*st.Lock.Camera ||
		st.Lock.Present == nil || !*st.Lock.Present {
		t.Fatalf("%+v", st)
	}
	m := stateJSON(t, st)
	if l := m["lock"].(map[string]any); m["paired"].(map[string]any)["pinDigits"] != float64(4) || l["camera"] != true ||
		l["present"] != true || l["until"] != "2026-10-20T09:41:30Z" || m["paired"].(map[string]any)["person"] == nil {
		t.Fatalf("%v", m)
	}
	// From an older runtime: none of them, and none sent on.
	f.Set(desk.PathState, desktest.Answer{Body: desktest.Paired})
	c, _ = newClient(t, f)
	m = stateJSON(t, c.State(context.Background()))
	if _, ok := m["paired"].(map[string]any)["pinDigits"]; ok {
		t.Fatalf("%v", m["paired"])
	}
	if l := m["lock"].(map[string]any); len(l) != 1 {
		t.Fatalf("%v", l)
	}
	for name, edit := range map[string][2]string{
		"three digits":            {`"pinDigits":4`, `"pinDigits":3`},
		"seven digits":            {`"pinDigits":4`, `"pinDigits":7`},
		"half a digit":            {`"pinDigits":4`, `"pinDigits":4.5`},
		"digits as a word":        {`"pinDigits":4`, `"pinDigits":"4"`},
		"a camera that is a word": {`"camera":true`, `"camera":"on"`},
		"someone without camera":  {`"camera":true,`, ``},
		"someone, camera off":     {`"camera":true`, `"camera":false`},
		"the camera while locked": {unlocked, `"lock":{"state":"locked","camera":true}`},
		"someone while locked":    {unlocked, `"lock":{"state":"phone","expiresAt":"2026-10-20T09:43:00Z","camera":true,"present":true}`},
	} {
		if !strings.Contains(body, edit[0]) {
			t.Fatalf("%s: the fixture changed", name)
		}
		f := desktest.Start(t)
		f.Set(desk.PathState, desktest.Answer{Body: strings.Replace(body, edit[0], edit[1], 1)})
		c, _ := newClient(t, f)
		if st := c.State(context.Background()); st != nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// The camera on before it has seen anyone.
	f.Set(desk.PathState, desktest.Answer{Body: strings.Replace(body, `"camera":true,"present":true`, `"camera":true`, 1)})
	c, _ = newClient(t, f)
	if st := c.State(context.Background()); st == nil || !*st.Lock.Camera || st.Lock.Present != nil {
		t.Fatalf("%+v", st)
	}
}

// Unlocked until Lock and the camera looking for someone (0.107, DK-72, DK-74; CG-170): passed to the page as sent,
// and only where the contract allows them (`stays` only while unlocked, a presence only while paired, all three of its
// members booleans). An older contracts-go would have dropped both.
func TestIdle(t *testing.T) {
	f := desktest.Start(t)
	f.Set(desk.PathState, desktest.Answer{Body: desktest.Idle})
	c, _ := newClient(t, f)
	st := c.State(context.Background())
	if st == nil || st.Lock.Stays == nil || !*st.Lock.Stays || st.Presence == nil || !st.Presence.Camera ||
		!st.Presence.Watching || !st.Presence.Here {
		t.Fatalf("%+v", st)
	}
	m := stateJSON(t, st)
	p, _ := m["presence"].(map[string]any)
	if l := m["lock"].(map[string]any); l["stays"] != true || l["until"] != "2026-10-20T12:36:20Z" ||
		p["camera"] != true || p["watching"] != true || p["here"] != true || len(p) != 3 {
		t.Fatalf("%v", m)
	}
	// The camera on but nobody seen, and it can't tell yet: false members are sent, not left out.
	f.Set(desk.PathState, desktest.Answer{Body: strings.Replace(desktest.Idle,
		`"watching":true,"here":true`, `"watching":false,"here":false`, 1)})
	c, _ = newClient(t, f)
	if p := stateJSON(t, c.State(context.Background()))["presence"].(map[string]any); p["camera"] != true ||
		p["watching"] != false || p["here"] != false {
		t.Fatalf("%v", p)
	}
	// From an older runtime: neither, and none sent on.
	f.Set(desk.PathState, desktest.Answer{Body: desktest.Paired})
	c, _ = newClient(t, f)
	m = stateJSON(t, c.State(context.Background()))
	if _, ok := m["presence"]; ok {
		t.Fatalf("%v", m)
	}
	if _, ok := m["lock"].(map[string]any)["stays"]; ok {
		t.Fatalf("%v", m["lock"])
	}
	unlocked := `"lock":{"state":"unlocked","until":"2026-10-20T12:36:20Z","stays":true}`
	presence := `"presence":{"camera":true,"watching":true,"here":true}`
	for name, edit := range map[string][2]string{
		"stays while locked":        {unlocked, `"lock":{"state":"locked","stays":true}`},
		"stays while phone":         {unlocked, `"lock":{"state":"phone","expiresAt":"2026-10-20T12:36:20Z","stays":true}`},
		"stays while backoff":       {unlocked, `"lock":{"state":"backoff","retryAt":"2026-10-20T12:36:20Z","stays":true}`},
		"stays as a word":           {`"stays":true`, `"stays":"yes"`},
		"a presence without here":   {presence, `"presence":{"camera":true,"watching":true}`},
		"here as a word":            {`"here":true`, `"here":"yes"`},
		"a presence that is a list": {presence, `"presence":[true,true,true]`},
	} {
		if !strings.Contains(desktest.Idle, edit[0]) {
			t.Fatalf("%s: the fixture changed", name)
		}
		f := desktest.Start(t)
		f.Set(desk.PathState, desktest.Answer{Body: strings.Replace(desktest.Idle, edit[0], edit[1], 1)})
		c, _ := newClient(t, f)
		if st := c.State(context.Background()); st != nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// Nobody paired: no desk to show, and no camera to say so; a presence there is a broken state.
	nobody := `{"v":1,"now":"2026-10-20T12:34:20Z","paired":null,"pairing":null,"lock":{"state":"locked"},` +
		`"glance":null,"power":null,"talk":null`
	f.Set(desk.PathState, desktest.Answer{Body: nobody + `}`})
	c, _ = newClient(t, f)
	if st := c.State(context.Background()); st == nil || st.Paired != nil || st.Presence != nil {
		t.Fatalf("%+v", st)
	}
	f.Set(desk.PathState, desktest.Answer{Body: nobody + `,` + presence + `}`})
	c, _ = newClient(t, f)
	if st := c.State(context.Background()); st != nil {
		t.Fatalf("a presence for nobody: accepted %+v", st)
	}
}

// The contracts' desk state vectors (contracts-go testdata, 0.107.0) through the console's own path: every valid one
// reaches the page with its `stays` and `presence` as sent, every invalid one is no desk.
func TestVectors(t *testing.T) {
	raw, err := os.ReadFile("../../../../contracts/go/testdata/vectors/local.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		DeskStates []struct {
			State json.RawMessage `json:"state"`
			Valid bool            `json:"valid"`
		} `json:"deskStates"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	f := desktest.Start(t)
	stays, presence := 0, 0
	for i, c := range v.DeskStates {
		f.Set(desk.PathState, desktest.Answer{Body: string(c.State)})
		cl, _ := newClient(t, f)
		st := cl.State(context.Background())
		if (st != nil) != c.Valid {
			t.Errorf("vector %d (valid %v): got %+v from %s", i, c.Valid, st, c.State)
			continue
		}
		if st == nil {
			continue
		}
		var sent map[string]any
		_ = json.Unmarshal(c.State, &sent)
		m := stateJSON(t, st)
		if s, ok := sent["lock"].(map[string]any)["stays"]; ok {
			stays++
			if m["lock"].(map[string]any)["stays"] != s {
				t.Errorf("vector %d: stays %v, sent %v", i, m["lock"], s)
			}
		}
		if p, ok := sent["presence"]; ok {
			presence++
			if fmt.Sprint(m["presence"]) != fmt.Sprint(p) {
				t.Errorf("vector %d: presence %v, sent %v", i, m["presence"], p)
			}
		}
	}
	if len(v.DeskStates) < 60 || stays == 0 || presence == 0 {
		t.Fatalf("%d vectors, %d with stays, %d with a presence", len(v.DeskStates), stays, presence)
	}
}

// A state that breaks the contract is no state at all: the page shows the console as before.
func TestStateRefused(t *testing.T) {
	for name, edit := range map[string][2]string{
		"lock state":      {`"lock":{"state":"locked"}`, `"lock":{"state":"open"}`},
		"version":         {`{"v":1,`, `{"v":2,`},
		"tone":            {`"tone":2`, `"tone":9`},
		"long name":       {`"name":"John"`, `"name":"` + strings.Repeat("J", 41) + `"`},
		"server state":    {`"state":"warn"`, `"state":"meh"`},
		"percent":         {`"percent":64`, `"percent":164`},
		"pairing letters": {`"pairing":null`, `"pairing":{"code":"KXQS","expiresAt":"2026-10-20T09:50:00Z"}`},
		"timestamp":       {`"now":"2026-10-20T09:41:00Z"`, `"now":"yesterday"`},
		"too many tiles":  {`"tiles":[`, `"tiles":[{"icon":"sun","value":"1","label":"a"},{"icon":"sun","value":"1","label":"a"},{"icon":"sun","value":"1","label":"a"},{"icon":"sun","value":"1","label":"a"},`},
		"not json":        {`{"v":1,`, `<html>`},
		// Consistency (DeskStateValid): an unlocked screen has its time; a phone unlock its expiry.
		"unlocked without until": {`"lock":{"state":"locked"}`, `"lock":{"state":"unlocked"}`},
		"phone without expiry":   {`"lock":{"state":"locked"}`, `"lock":{"state":"phone"}`},
		"an ask's words while locked": {`"needsYou":{"count":1,"items":[]}`, `"needsYou":{"count":1,"items":[{"number":3,` +
			`"kind":"approval","title":"Restart Plex","at":"2026-10-20T09:40:00Z","detail":"Plex stops for a minute.","onDesk":true}]}`},
	} {
		if !strings.Contains(desktest.Paired, edit[0]) {
			t.Fatalf("%s: the fixture changed", name)
		}
		f := desktest.Start(t)
		f.Set(desk.PathState, desktest.Answer{Body: strings.Replace(desktest.Paired, edit[0], edit[1], 1)})
		c, _ := newClient(t, f)
		if st := c.State(context.Background()); st != nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// Valid pairing letters are shown.
	f := desktest.Start(t)
	f.Set(desk.PathState, desktest.Answer{Body: strings.Replace(desktest.Paired, `"pairing":null`,
		`"pairing":{"code":"KXQM","expiresAt":"2026-10-20T09:50:00Z"}`, 1)})
	c, _ := newClient(t, f)
	if st := c.State(context.Background()); st == nil || st.Pairing.Code != "KXQM" {
		t.Fatalf("%+v", st)
	}
}

// No socket, the wrong peer, or no answer within the timeout: no desk, and no error on the page.
func TestUnavailable(t *testing.T) {
	ctx := context.Background()
	c := desk.New("/nonexistent/desk.sock", os.Getuid(), nil, t.Logf)
	if c.State(ctx) != nil {
		t.Fatal("a state without a socket")
	}
	if _, err := c.Lock(ctx); !errors.Is(err, desk.ErrUnavailable) {
		t.Fatalf("%v", err)
	}
	f := desktest.Start(t)
	f.Set(desk.PathLock, desktest.Answer{Body: `{"v":1}`})
	// The wrong peer is logged even after the socket was away (one line per change otherwise).
	var logged []string
	dir, _ := os.MkdirTemp("", "desk")
	defer os.RemoveAll(dir)
	path := dir + "/desk.sock"
	away := desk.New(path, os.Getuid()+1, nil, func(f string, a ...any) { logged = append(logged, fmt.Sprintf(f, a...)) })
	away.State(ctx)
	away.Invalidate()
	away.State(ctx)
	if len(logged) != 1 {
		t.Fatalf("the same failure logged again: %q", logged)
	}
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	away.Invalidate()
	if away.State(ctx) != nil || len(logged) != 2 || !strings.Contains(logged[1], "isn't the runtime's") {
		t.Fatalf("%q", logged)
	}
	other := desk.New(f.Socket, os.Getuid()+1, nil, t.Logf)
	if other.State(ctx) != nil {
		t.Fatal("a socket of another uid was believed")
	}
	if _, err := other.Lock(ctx); !errors.Is(err, desk.ErrUnavailable) || f.CallsTo(desk.PathLock) != 0 {
		t.Fatalf("%v %d", err, f.CallsTo(desk.PathLock))
	}
	f.Hold()
	c = desk.NewForTest(f.Socket, os.Getuid(), 50*time.Millisecond)
	start := time.Now()
	if c.State(ctx) != nil || time.Since(start) > 2*time.Second {
		t.Fatal("a held answer was waited for")
	}
}

// The page's requests: checked before they reach the runtime, rebuilt with only the contract's members, and the
// runtime's refusals passed on with their status and code.
func TestRequests(t *testing.T) {
	f := desktest.Start(t)
	c, _ := newClient(t, f)
	ctx := context.Background()
	f.Set(desk.PathUnlock, desktest.Answer{Body: `{"v":1,"result":"wrong","triesLeft":4}`})
	for _, pin := range []string{"123", "1234567", "12a4", "", "١٢٣٤", " 1234"} {
		if _, err := c.Unlock(ctx, pin); !isErr(err, 400, "bad_request") {
			t.Errorf("pin %q: %v", pin, err)
		}
	}
	if n := f.CallsTo(desk.PathUnlock); n != 0 {
		t.Fatalf("a malformed PIN reached the runtime (%d)", n)
	}
	// 4 to 6 digits (DK-26), sent as typed.
	for _, pin := range []string{"2580", "25803"} {
		if _, err := c.Unlock(ctx, pin); err != nil {
			t.Fatal(pin, err)
		}
		if got := f.Calls()[len(f.Calls())-1]; got.Body != `{"v":1,"pin":"`+pin+`"}` {
			t.Fatalf("%+v", got)
		}
	}
	// A screen without a PIN (DK-18): the runtime's 409 `no_pin` reaches the page as it is (CG-56), no tries counted.
	f.Set(desk.PathUnlock, desktest.Answer{Status: 409, Body: `{"error":{"code":"` + local.DeskErrorNoPin + `","message":"x"}}`})
	if _, err := c.Unlock(ctx, "123456"); !isErr(err, 409, "no_pin") {
		t.Fatal(err)
	}
	f.Set(desk.PathUnlock, desktest.Answer{Body: `{"v":1,"result":"wrong","triesLeft":4}`})
	a, err := c.Unlock(ctx, "123456")
	if err != nil || a.Result != "wrong" || *a.TriesLeft != 4 {
		t.Fatal(a, err)
	}
	if got := f.Calls()[len(f.Calls())-1]; got.Method != "POST" || got.Body != `{"v":1,"pin":"123456"}` {
		t.Fatalf("%+v", got)
	}
	// Refusals keep the runtime's status and code; unknown statuses and odd codes don't reach the page as they are.
	for status, tc := range map[int]struct {
		body   string
		status int
		code   string
	}{
		409: {`{"error":{"code":"locked","message":"The screen is locked."}}`, 409, "locked"},
		403: {`{"error":{"code":"on_phone","message":"x"}}`, 403, "on_phone"},
		404: {``, 404, "not_found"},
		418: {`{"error":{"code":"teapot"}}`, 400, "teapot"},
		500: {`{"error":{"code":"Boom <b>"}}`, 502, "failed"},
		503: {`{"error":{"code":"voice_unavailable"}}`, 503, "voice_unavailable"},
	} {
		f.Set(desk.PathDecide, desktest.Answer{Status: status, Body: tc.body})
		if _, err := c.Decide(ctx, 7, "approve", nil, nil); !isErr(err, tc.status, tc.code) {
			t.Errorf("%d: %v", status, err)
		}
	}
	// Deny (DK-61) and a risky ask's Approve with the PIN (DK-62, 0.108): sent as typed, the runtime's answer passed on.
	f.Set(desk.PathDecide, desktest.Answer{Body: `{"v":1,"result":"decided","talk":"dtk_follow0001"}`})
	if a, err := c.Decide(ctx, 7, "deny", nil, nil); err != nil || a.Result != "decided" || *a.Talk != "dtk_follow0001" {
		t.Fatal(a, err)
	}
	if got := f.Calls()[len(f.Calls())-1]; got.Body != `{"v":1,"number":7,"decision":"deny"}` {
		t.Fatalf("%+v", got)
	}
	f.Set(desk.PathDecide, desktest.Answer{Body: `{"v":1,"result":"wrong","triesLeft":3}`})
	pin := "2580"
	if a, err := c.Decide(ctx, 7, "approve", &pin, nil); err != nil || a.Result != "wrong" || *a.TriesLeft != 3 {
		t.Fatal(a, err)
	}
	if got := f.Calls()[len(f.Calls())-1]; got.Body != `{"v":1,"number":7,"decision":"approve","pin":"2580"}` {
		t.Fatalf("%+v", got)
	}
	f.Set(desk.PathDecide, desktest.Answer{Status: 403, Body: `{"error":{"code":"pin_needed","message":"x"}}`})
	if _, err := c.Decide(ctx, 7, "approve", nil, nil); !isErr(err, 403, "pin_needed") {
		t.Fatal(err)
	}
	f.Set(desk.PathDecide, desktest.Answer{Body: `{"v":1,"result":"maybe"}`})
	if _, err := c.Decide(ctx, 7, "approve", nil, nil); !isErr(err, 502, "failed") {
		t.Fatal(err)
	}
	calls := f.CallsTo(desk.PathDecide)
	for _, bad := range []struct {
		n   int64
		d   string
		pin string
	}{{0, "approve", ""}, {-1, "decline", ""}, {7, "always", ""}, {7, "", ""}, {7, "approve", "123"}, {7, "approve", "12a4"}} {
		var p *string
		if bad.pin != "" {
			p = &bad.pin
		}
		if _, err := c.Decide(ctx, bad.n, bad.d, p, nil); !isErr(err, 400, "bad_request") {
			t.Errorf("%v: %v", bad, err)
		}
	}
	if n := f.CallsTo(desk.PathDecide); n != calls {
		t.Fatalf("a malformed decision reached the runtime (%d)", n-calls)
	}
	// An answer that isn't the contract's is a failure, not passed on.
	f.Set(desk.PathTouch, desktest.Answer{Body: `{"v":1,"until":"soon"}`})
	if _, err := c.Touch(ctx); !isErr(err, 502, "failed") {
		t.Fatal(err)
	}
	f.Set(desk.PathTouch, desktest.Answer{Body: `{"v":1,"until":"2026-10-20T09:43:00Z"}`})
	if a, err := c.Touch(ctx); err != nil || a.Until != "2026-10-20T09:43:00Z" {
		t.Fatal(a, err)
	}
	// Not now (0.110, DF-04): nothing but the request, the runtime's ack or refusal passed on.
	f.Set(desk.PathFoundDismiss, desktest.Answer{Body: `{"v":1}`})
	if a, err := c.FoundDismiss(ctx); err != nil || a.V != 1 {
		t.Fatal(a, err)
	}
	if got := f.Calls()[len(f.Calls())-1]; got.Method != "POST" || got.Path != "/v1/desk/found/dismiss" || got.Body != `{"v":1}` {
		t.Fatalf("%+v", got)
	}
	f.Set(desk.PathFoundDismiss, desktest.Answer{Status: 404, Body: ``})
	if _, err := c.FoundDismiss(ctx); !isErr(err, 404, "not_found") {
		t.Fatal(err)
	}
	f.Set(desk.PathPhone, desktest.Answer{Body: `{"v":1,"expiresAt":"2026-10-20T09:43:00Z"}`})
	if a, err := c.Phone(ctx); err != nil || a.ExpiresAt == "" {
		t.Fatal(a, err)
	}
}

func isErr(err error, status int, code string) bool {
	var de *desk.Error
	return errors.As(err, &de) && de.Status == status && de.Code == code
}

// wav is a 16 kHz mono 16-bit recording of n samples (fmt and data chunks as a browser's encoder writes them).
func wav(rate uint32, channels, bits uint16, n int) []byte {
	var b bytes.Buffer
	data := n * int(channels) * int(bits) / 8
	b.WriteString("RIFF")
	_ = binary.Write(&b, binary.LittleEndian, uint32(36+data))
	b.WriteString("WAVEfmt ")
	for _, v := range []any{uint32(16), uint16(1), channels, rate, rate * uint32(channels) * uint32(bits) / 8,
		channels * bits / 8, bits} {
		_ = binary.Write(&b, binary.LittleEndian, v)
	}
	b.WriteString("data")
	_ = binary.Write(&b, binary.LittleEndian, uint32(data))
	b.Write(make([]byte, data))
	return b.Bytes()
}

func TestCheckTalkWav(t *testing.T) {
	if err := desk.CheckTalkWav(wav(16000, 1, 16, 16000)); err != nil {
		t.Fatal(err)
	}
	if err := desk.CheckTalkWav(wav(16000, 1, 16, 30*16000)); err != nil {
		t.Fatal("30 s refused:", err)
	}
	for name, b := range map[string][]byte{
		"stereo":   wav(16000, 2, 16, 16000),
		"44.1 kHz": wav(44100, 1, 16, 16000),
		"8 bits":   wav(16000, 1, 8, 16000),
		"31 s":     wav(16000, 1, 16, 31*16000),
		"empty":    wav(16000, 1, 16, 0),
		"not wav":  []byte("RIFF\x00\x00\x00\x00AVI "),
		"short":    []byte("RIFF"),
		"no fmt":   append([]byte("RIFF\x10\x00\x00\x00WAVEdata\x04\x00\x00\x00"), 0, 0, 0, 0),
	} {
		if desk.CheckTalkWav(b) == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// A streamed recording whose data size was never filled in counts what is there.
	b := wav(16000, 1, 16, 1600)
	binary.LittleEndian.PutUint32(b[40:], 0xFFFFFFFF)
	if err := desk.CheckTalkWav(b); err != nil {
		t.Fatal(err)
	}
}

func TestTalk(t *testing.T) {
	f := desktest.Start(t)
	c, _ := newClient(t, f)
	ctx := context.Background()
	f.Set(desk.PathTalk, desktest.Answer{Body: `{"v":1,"id":"talk-0001"}`})
	str := func(s string) *string { return &s }
	audio := base64.StdEncoding.EncodeToString(wav(16000, 1, 16, 8000))
	for name, tc := range map[string]struct {
		text, audio *string
		code        string
	}{
		"neither":    {nil, nil, "bad_request"},
		"both":       {str("hi"), &audio, "bad_request"},
		"blank":      {str(" ​\n "), nil, "bad_request"},
		"too long":   {str(strings.Repeat("a", 1001)), nil, "bad_request"},
		"not base64": {nil, str("RIFF!!"), "bad_request"},
		"not 16 kHz": {nil, str(base64.StdEncoding.EncodeToString(wav(48000, 1, 16, 8000))), "bad_audio"},
	} {
		if _, err := c.Talk(ctx, tc.text, tc.audio, false, nil, false); !isErr(err, 400, tc.code) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if n := f.CallsTo(desk.PathTalk); n != 0 {
		t.Fatalf("a bad talk reached the runtime (%d)", n)
	}
	if a, err := c.Talk(ctx, str(" is pve-02\nokay? "), nil, true, nil, false); err != nil || a.ID != "talk-0001" {
		t.Fatal(a, err)
	}
	if got := f.Calls()[len(f.Calls())-1]; got.Body != `{"v":1,"text":"is pve-02 okay?","continue":true}` {
		t.Fatalf("%s", got.Body)
	}
	// The words Talk's mic heard (3.3, CG-361): a question of up to 1000 characters that came by voice.
	long := strings.Repeat("a", 1000)
	if _, err := c.Talk(ctx, &long, nil, true, nil, true); err != nil {
		t.Fatal(err)
	}
	if got := f.Calls()[len(f.Calls())-1]; got.Body != `{"v":1,"text":"`+long+`","continue":true,"spoken":true}` {
		t.Fatalf("%s", got.Body)
	}
	if _, err := c.Talk(ctx, nil, &audio, false, nil, true); err != nil {
		t.Fatal(err)
	}
	if got := f.Calls()[len(f.Calls())-1]; strings.Contains(got.Body, "spoken") {
		t.Fatalf("a recording says spoken itself: %s", got.Body)
	}
	if _, err := c.Talk(ctx, nil, &audio, false, nil, false); err != nil {
		t.Fatal(err)
	}
	var sent desk.TalkRequest
	_ = json.Unmarshal([]byte(f.Calls()[len(f.Calls())-1].Body), &sent)
	if sent.AudioWav == nil || *sent.AudioWav != audio || sent.Text != nil || sent.Server != nil {
		t.Fatal("the recording wasn't passed on as it was")
	}
	// Ask about this server (0.115, DK-85): a server id passes on, short slugs too; anything else is 400 unasked.
	if _, err := c.Talk(ctx, str("why is it busy?"), nil, true, str("nas"), false); err != nil {
		t.Fatal(err)
	}
	if got := f.Calls()[len(f.Calls())-1]; got.Body != `{"v":1,"text":"why is it busy?","continue":true,"server":"nas"}` {
		t.Fatalf("%s", got.Body)
	}
	calls := f.CallsTo(desk.PathTalk)
	for _, bad := range []string{"", "../etc", "a/b", ".x", strings.Repeat("a", 129)} {
		if _, err := c.Talk(ctx, str("hi"), nil, true, &bad, false); !isErr(err, 400, "bad_request") {
			t.Errorf("%q: %v", bad, err)
		}
	}
	if n := f.CallsTo(desk.PathTalk); n != calls {
		t.Fatalf("a bad server id reached the runtime (%d)", n-calls)
	}
	// The talk's state, cleaned; its audio, only when it is a WAV file.
	f.Set(desk.PathTalkGet, desktest.Answer{Body: `{"v":1,"id":"talk-0001","state":"answered","question":"is pve-02 okay?",` +
		`"answer":"It’s fine. ","thing":{"name":"pve-02","mark":"proxmox","state":"ok","note":"up 41 d"},"audio":true}`})
	if tk, err := c.TalkGet(ctx, "talk-0001"); err != nil || *tk.Answer != "It’s fine." || tk.Thing.Name != "pve-02" {
		t.Fatal(tk, err)
	}
	f.Set(desk.PathTalkGet, desktest.Answer{Body: `{"v":1,"id":"talk-0001","state":"answered","answer":"It’s fine.‮",` +
		`"thing":null,"audio":false}`})
	if _, err := c.TalkGet(ctx, "talk-0001"); !isErr(err, 502, "failed") {
		t.Fatal("a format character in an answer:", err)
	}
	if _, err := c.TalkGet(ctx, "t-1"); !isErr(err, 400, "bad_request") {
		t.Fatal("a short id:", err)
	}
	if _, err := c.TalkGet(ctx, "../x"); !isErr(err, 400, "bad_request") {
		t.Fatal(err)
	}
	f.Set(desk.PathTalkAudio, desktest.Answer{ContentType: "audio/wav", Body: string(wav(22050, 1, 16, 100))})
	if b, err := c.TalkAudio(ctx, "talk-0001"); err != nil || !bytes.HasPrefix(b, []byte("RIFF")) {
		t.Fatal(err)
	}
	f.Set(desk.PathTalkAudio, desktest.Answer{ContentType: "text/html", Body: string(wav(22050, 1, 16, 100))})
	if _, err := c.TalkAudio(ctx, "talk-0001"); !isErr(err, 502, "failed") {
		t.Fatal(err)
	}
	f.Set(desk.PathTalkAudio, desktest.Answer{ContentType: "audio/wav", Body: "<html>"})
	if _, err := c.TalkAudio(ctx, "talk-0001"); !isErr(err, 502, "failed") {
		t.Fatal(err)
	}
	f.Set(desk.PathTalkAudio, desktest.Answer{Status: http.StatusNotFound})
	if _, err := c.TalkAudio(ctx, "talk-0001"); !isErr(err, 404, "not_found") {
		t.Fatal(err)
	}
}

// The open conversation (0.108, DK-63, DK-64): checked, cleaned, a closed one empty; Close passed on.
func TestSession(t *testing.T) {
	f := desktest.Start(t)
	c, _ := newClient(t, f)
	ctx := context.Background()
	f.Set(desk.PathTalkSession, desktest.Answer{Body: desktest.Session})
	s, err := c.TalkSession(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !s.Open || s.Until == nil || len(s.Messages) != 3 || s.Messages[1].Thing == nil ||
		s.Messages[2].Ask == nil || s.Messages[2].Ask.State != "waiting" {
		t.Fatalf("%+v", s)
	}
	// Trimmed; a paragraph left empty goes, and a message left without one.
	if got := s.Messages[1].Paragraphs; len(got) != 2 || got[0] != "Plex on blackbox stopped answering." {
		t.Fatalf("%q", got)
	}
	if got := f.Calls()[len(f.Calls())-1]; got.Method != "POST" || got.Body != `{"v":1}` {
		t.Fatalf("%+v", got)
	}
	// Inconsistent (open without until) or not the contract's: a failure, not passed on.
	for _, body := range []string{
		`{"v":1,"open":true,"messages":[],"earlier":0}`,
		`{"v":1,"open":false,"messages":[],"earlier":2}`,
		`{"v":1,"open":true,"messages":[{"id":"msg_abcdefgh","from":"someone","at":"2026-10-20T12:30:00Z","paragraphs":["x"]}],"earlier":0,"until":"2026-10-20T13:00:00Z"}`,
	} {
		f.Set(desk.PathTalkSession, desktest.Answer{Body: body})
		if _, err := c.TalkSession(ctx); !isErr(err, 502, "failed") {
			t.Errorf("%s: %v", body, err)
		}
	}
	f.Set(desk.PathTalkSession, desktest.Answer{Status: 409, Body: `{"error":{"code":"locked","message":"x"}}`})
	if _, err := c.TalkSession(ctx); !isErr(err, 409, "locked") {
		t.Fatal(err)
	}
	// A runtime from before 0.108 has no such path: 404, the page keeps its own last talk.
	f.Set(desk.PathTalkSession, desktest.Answer{Status: 404})
	if _, err := c.TalkSession(ctx); !isErr(err, 404, "not_found") {
		t.Fatal(err)
	}
	f.Set(desk.PathTalkClose, desktest.Answer{Body: `{"v":1}`})
	if _, err := c.TalkClose(ctx); err != nil {
		t.Fatal(err)
	}
	if got := f.Calls()[len(f.Calls())-1]; got.Path != desk.PathTalkClose || got.Body != `{"v":1}` {
		t.Fatalf("%+v", got)
	}
}

// Every server and a server's own screen (0.115, DK-83, DK-86): the requests checked before they reach the runtime, the
// answers checked (the server asked for, consistent) and cleaned, the runtime's refusals passed on.
func TestServers(t *testing.T) {
	f := desktest.Start(t)
	c, _ := newClient(t, f)
	ctx := context.Background()
	f.Set(desk.PathServers, desktest.Answer{Body: desktest.Servers})
	a, err := c.Servers(ctx)
	if err != nil || len(a.Servers) != 2 || a.More != 3 || *a.Servers[0].ID != "pve-01" || a.Servers[1].Disk.Value != 88 {
		t.Fatal(a, err)
	}
	if a.Servers[0].Name != "pve-01" || a.Servers[0].Note != "up 41 d" {
		t.Fatalf("not cleaned: %+v", a.Servers[0])
	}
	if got := f.Calls()[len(f.Calls())-1]; got.Method != "POST" || got.Path != "/v1/desk/servers" || got.Body != `{"v":1}` {
		t.Fatalf("%+v", got)
	}

	f.Set(desk.PathServer, desktest.Answer{Body: desktest.ServerPage})
	p, err := c.Server(ctx, "pve-01", "24h")
	if err != nil {
		t.Fatal(err)
	}
	if got := f.Calls()[len(f.Calls())-1]; got.Path != "/v1/desk/server" || got.Body != `{"v":1,"id":"pve-01","range":"24h"}` {
		t.Fatalf("%+v", got)
	}
	// Cleaned: trimmed, the volume left without a name gone, the alert titles kept.
	if p.Os != "Proxmox VE 9.0.10" || len(p.Volumes) != 1 || p.Volumes[0].Name != "local-zfs" || p.Memory.Used.Value != "69" ||
		len(p.Guests.Items) != 2 || p.Alerts.Count != 1 || len(p.Alerts.Items) != 1 || *p.History.MemoryAvg != 52 {
		t.Fatalf("%+v", p)
	}
	// Another server's page, or one that isn't consistent, is no page.
	for name, body := range map[string]string{
		"another server": strings.Replace(desktest.ServerPage, `"id":"pve-01"`, `"id":"pve-02"`, 1),
		"no id":          strings.Replace(desktest.ServerPage, `"id":"pve-01",`, ``, 1),
		"two lengths":    strings.Replace(desktest.ServerPage, `"memory":[50,52,54]`, `"memory":[50,52]`, 1),
		"more titles":    strings.Replace(desktest.ServerPage, `"count":1`, `"count":0`, 1),
		"an odd range":   strings.Replace(desktest.ServerPage, `"range":"24h"`, `"range":"2d"`, 1),
	} {
		f.Set(desk.PathServer, desktest.Answer{Body: body})
		if _, err := c.Server(ctx, "pve-01", "24h"); !isErr(err, 502, "failed") {
			t.Errorf("%s: %v", name, err)
		}
	}
	// Short slugs are ids too; malformed ids and ranges don't reach the runtime.
	f.Set(desk.PathServer, desktest.Answer{Body: strings.ReplaceAll(desktest.ServerPage, `"pve-01"`, `"nas"`)})
	if p, err := c.Server(ctx, "nas", "7d"); err != nil || *p.Server.ID != "nas" {
		t.Fatal(p, err)
	}
	calls := f.CallsTo(desk.PathServer)
	for _, bad := range []struct{ id, rng string }{{"", "24h"}, {"../x", "24h"}, {"a/b", "1h"}, {"pve-01", ""}, {"pve-01", "1d"}} {
		if _, err := c.Server(ctx, bad.id, bad.rng); !isErr(err, 400, "bad_request") {
			t.Errorf("%v: %v", bad, err)
		}
	}
	if n := f.CallsTo(desk.PathServer); n != calls {
		t.Fatalf("a malformed request reached the runtime (%d)", n-calls)
	}
	// The runtime's refusals: locked in *Only the time* (DK-84), no such server, the hosts service away.
	for status, code := range map[int]string{409: "locked", 404: "not_found", 503: "unavailable"} {
		f.Set(desk.PathServer, desktest.Answer{Status: status, Body: `{"error":{"code":"` + code + `","message":"x"}}`})
		f.Set(desk.PathServers, desktest.Answer{Status: status, Body: `{"error":{"code":"` + code + `","message":"x"}}`})
		if _, err := c.Server(ctx, "pve-01", "1h"); !isErr(err, status, code) {
			t.Errorf("%d: %v", status, err)
		}
		if _, err := c.Servers(ctx); !isErr(err, status, code) {
			t.Errorf("servers %d: %v", status, err)
		}
	}
	// No more than DESK_SERVER_MAX_BYTES of an answer.
	f.Set(desk.PathServer, desktest.Answer{Body: `{"v":1,"os":"` + strings.Repeat("x", local.DeskServerMaxBytes) + `"}`})
	if _, err := c.Server(ctx, "pve-01", "24h"); !errors.Is(err, desk.ErrUnavailable) {
		t.Fatal(err)
	}
}

// The contracts' server page and server id vectors (0.115, CT-866, CT-862) through the console's own client: a valid
// page is shown for the server it names and no other, an invalid one never; a valid id reaches the runtime, an invalid
// one is 400 unasked.
func TestServerVectors(t *testing.T) {
	raw, err := os.ReadFile("../../../../contracts/go/testdata/vectors/local.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Pages []struct {
			Page  json.RawMessage `json:"page"`
			Valid bool            `json:"valid"`
		} `json:"deskServerPages"`
		IDs []struct {
			ID    string `json:"id"`
			Valid bool   `json:"valid"`
		} `json:"deskServerIds"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	if len(v.Pages) < 10 || len(v.IDs) < 10 {
		t.Fatalf("%d pages, %d ids", len(v.Pages), len(v.IDs))
	}
	f := desktest.Start(t)
	c, _ := newClient(t, f)
	ctx := context.Background()
	for i, tc := range v.Pages {
		var head struct {
			Server struct {
				ID string `json:"id"`
			} `json:"server"`
		}
		_ = json.Unmarshal(tc.Page, &head)
		id := head.Server.ID
		if id == "" {
			id = "pve-01"
		}
		f.Set(desk.PathServer, desktest.Answer{Body: string(tc.Page)})
		if p, err := c.Server(ctx, id, "24h"); (err == nil) != tc.Valid || (err == nil && *p.Server.ID != id) {
			t.Errorf("page %d (valid %v): %v", i, tc.Valid, err)
		}
		if tc.Valid {
			if _, err := c.Server(ctx, id+"x", "24h"); !isErr(err, 502, "failed") {
				t.Errorf("page %d for another server: %v", i, err)
			}
		}
	}
	text := "why?"
	for _, tc := range v.IDs {
		id := tc.ID
		if _, err := desk.TalkRequestFor(&text, nil, true, &id, false); (err == nil) != tc.Valid {
			t.Errorf("id %q (valid %v): %v", tc.ID, tc.Valid, err)
		}
	}
}
