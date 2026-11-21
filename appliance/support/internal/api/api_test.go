package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/peercred"
	"github.com/CybexBV/whombat/appliance/support/internal/events"
	"github.com/CybexBV/whombat/appliance/support/internal/grant"
	"github.com/CybexBV/whombat/appliance/support/internal/records"
	"github.com/CybexBV/whombat/appliance/support/internal/wire"
	"github.com/CybexBV/whombat/contracts/go/local"
)

const (
	runtimeUID = 951
	managerUID = 950
	intruder   = 1000
)

var hostKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOsj6Cmd/i8mZUeOzMZhnhJx/rlbtkaM0eeIBuL2yDQf"

type fixture struct {
	s   *Server
	g   *grant.Store
	r   *records.Store
	log *events.Log
}

func newFixture(t *testing.T, env string) *fixture {
	t.Helper()
	dir := t.TempDir()
	log := events.Open(filepath.Join(dir, "events.json"), time.Now, t.Logf)
	g, err := grant.Open(grant.Options{Path: filepath.Join(dir, "grant.json"), Environment: env, Events: log, Logf: t.Logf})
	if err != nil {
		t.Fatal(err)
	}
	r, err := records.Open(records.Options{Dir: filepath.Join(dir, "visits"), Logf: t.Logf})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { g.Close(); r.Close() })
	k := hostKey
	return &fixture{s: &Server{Grant: g, Records: r, Events: log, Available: true, HostKey: &k, RuntimeUID: runtimeUID,
		ManagerUID: managerUID, Peer: fakePeer}, g: g, r: r, log: log}
}

// fakePeer reads the caller's uid from a test header (the real server takes it from SO_PEERCRED).
func fakePeer(r *http.Request) (uint32, bool) {
	var uid uint32
	_, err := fmt.Sscan(r.Header.Get("X-Test-Uid"), &uid)
	return uid, err == nil
}

func (f *fixture) call(uid int, method, path, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if uid >= 0 {
		req.Header.Set("X-Test-Uid", fmt.Sprint(uid))
	}
	f.s.Handler().ServeHTTP(rec, req)
	return rec
}

func errorCode(t *testing.T, rec *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	var e struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &e); rec.Code != status || err != nil || e.Error.Code != code {
		t.Fatalf("got %d %s (%v), want %d %s", rec.Code, rec.Body.String(), err, status, code)
	}
}

// decode reads an answer, checked against the contract's schema (and its other rules where it has them).
func decode[T any](t *testing.T, rec *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &v); err != nil {
		t.Fatalf("%v: %s", err, rec.Body.String())
	}
	var err error
	switch any(v).(type) {
	case wire.State:
		_, err = local.ParseSupportState(rec.Body.Bytes())
	case wire.Visits:
		_, err = local.ParseSupportVisitsAnswer(rec.Body.Bytes())
	case wire.Events:
		var e *wire.Events
		if e, err = local.ParseSupportEventsAnswer(rec.Body.Bytes()); err == nil {
			for _, ev := range e.Events {
				if !wire.EventValid(ev) {
					t.Fatalf("not a valid event: %s", rec.Body.String())
				}
			}
		}
	}
	if err != nil {
		t.Fatalf("not the contract's: %v: %s", err, rec.Body.String())
	}
	return v
}

// stateValid checks what the schema can't (supportStateValid); the manager's copy has no help code, so it isn't.
func stateValid(t *testing.T, st wire.State) {
	t.Helper()
	if !wire.StateValid(st) {
		t.Fatalf("not a valid state: %+v", st)
	}
}

const grantBody = `{"v":1,"level":"fix","duration":"day","grantedBy":{"accountId":"acc_owner1","name":"Anna"}}`

func TestCallers(t *testing.T) {
	f := newFixture(t, wire.EnvProd)
	if rec := f.call(runtimeUID, "POST", wire.PathGrant, grantBody); rec.Code != 200 {
		t.Fatalf("grant: %d %s", rec.Code, rec.Body.String())
	}
	// The runtime and root see the help code; the manager the state without it, and nothing else.
	for _, uid := range []int{runtimeUID, 0} {
		if st := decode[wire.State](t, f.call(uid, "GET", wire.PathState, "")); st.Grant == nil || st.Grant.HelpCode == nil {
			t.Fatalf("uid %d: %+v", uid, st)
		}
	}
	rec := f.call(managerUID, "GET", wire.PathState, "")
	st := decode[wire.State](t, rec)
	if st.Grant == nil || st.Grant.HelpCode != nil || st.Grant.Level != wire.LevelFix || strings.Contains(rec.Body.String(), *f.g.Grant().HelpCode) {
		t.Fatalf("manager: %s", rec.Body.String())
	}
	for _, c := range []struct{ method, path, body string }{
		{"POST", wire.PathGrant, grantBody}, {"POST", wire.PathStop, `{"v":1,"reason":"desk"}`},
		{"GET", wire.PathVisits, ""}, {"GET", "/v1/visits/20261021T120000Z-0123abcd/transcript", ""},
		{"GET", wire.PathEvents, ""},
	} {
		errorCode(t, f.call(managerUID, c.method, c.path, c.body), 403, wire.ErrForbidden)
	}
	// Anyone else, and a caller whose credentials can't be read, nothing at all.
	for _, uid := range []int{intruder, 952, -1} {
		errorCode(t, f.call(uid, "GET", wire.PathState, ""), 403, wire.ErrForbidden)
		errorCode(t, f.call(uid, "POST", wire.PathStop, `{"v":1,"reason":"desk"}`), 403, wire.ErrForbidden)
	}
	if f.g.Level() != wire.LevelFix {
		t.Fatal("a refused caller stopped it")
	}
}

func TestPeerCredentials(t *testing.T) {
	dir, err := os.MkdirTemp("", "support-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	get := func(runtime, manager uint32) int {
		sock := filepath.Join(dir, "s.sock")
		_ = os.Remove(sock)
		l, err := net.Listen("unix", sock)
		if err != nil {
			t.Fatal(err)
		}
		f := newFixture(t, wire.EnvLocal)
		f.s.Peer, f.s.RuntimeUID, f.s.ManagerUID = nil, runtime, manager
		srv := &http.Server{Handler: f.s.Handler(), ConnContext: peercred.ConnContext}
		go func() { _ = srv.Serve(l) }()
		defer srv.Close()
		c := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", sock)
		}}}
		r, err := c.Get("http://support" + wire.PathVisits)
		if err != nil {
			t.Fatal(err)
		}
		r.Body.Close()
		return r.StatusCode
	}
	me := uint32(os.Getuid())
	if me == 0 {
		t.Skip("root may use everything")
	}
	if got := get(me, me+1); got != 200 {
		t.Fatalf("as the runtime: %d", got)
	}
	if got := get(me+1, me); got != 403 {
		t.Fatalf("as the manager: %d", got)
	}
	if got := get(me+1, me+2); got != 403 {
		t.Fatalf("as someone else: %d", got)
	}
}

func TestState(t *testing.T) {
	f := newFixture(t, wire.EnvLocal)
	rec := f.call(runtimeUID, "GET", wire.PathState, "")
	st := decode[wire.State](t, rec)
	stateValid(t, st)
	if st.V != 1 || !st.Available || !st.ForeverAllowed || st.HelpCodeRequired || st.Environment != wire.EnvLocal ||
		st.HostKey == nil || *st.HostKey != hostKey || st.Grant != nil || st.Connected == nil {
		t.Fatalf("%s", rec.Body.String())
	}
	// grant and connected are null and [] when off, never absent.
	if !strings.Contains(rec.Body.String(), `"grant":null`) || !strings.Contains(rec.Body.String(), `"connected":[]`) {
		t.Fatalf("%s", rec.Body.String())
	}
	_ = f.call(runtimeUID, "POST", wire.PathGrant, `{"v":1,"level":"look","duration":"forever","grantedBy":{"accountId":"acc_o","name":"O"}}`)
	v := f.r.Visit(7, "Claude (op_1)", "Claude", wire.LevelLook)
	v.Connected()
	st = decode[wire.State](t, f.call(managerUID, "GET", wire.PathState, ""))
	stateValid(t, st) // a local image: no help code either way
	if st.Grant == nil || st.Grant.Until != nil || len(st.Connected) != 1 || st.Connected[0].Who != "Claude" ||
		st.Connected[0].VisitID != v.ID() {
		t.Fatalf("%+v", st)
	}
	// Once the grant is over nobody is shown connected, even before the record has closed the visit.
	_ = f.g.Stop(wire.StopDesk, nil)
	if st = decode[wire.State](t, f.call(runtimeUID, "GET", wire.PathState, "")); len(st.Connected) != 0 {
		t.Fatalf("%+v", st)
	}
	errorCode(t, f.call(runtimeUID, "GET", wire.PathState+"?x=1", ""), 400, wire.ErrBadRequest)
	errorCode(t, f.call(runtimeUID, "POST", wire.PathState, ""), 405, wire.ErrBadRequest)
	errorCode(t, f.call(runtimeUID, "GET", "/v1/nothing", ""), 404, wire.ErrBadRequest)
}

func TestGrant(t *testing.T) {
	f := newFixture(t, wire.EnvProd)
	st := decode[wire.State](t, f.call(runtimeUID, "POST", wire.PathGrant, grantBody))
	stateValid(t, st)
	if st.Grant == nil || st.Grant.Level != wire.LevelFix || st.Grant.Until == nil || st.Grant.HelpCode == nil ||
		st.Grant.GrantedBy.AccountID != "acc_owner1" || st.Environment != wire.EnvProd || st.ForeverAllowed {
		t.Fatalf("%+v", st)
	}
	ev := f.log.After(t.Context(), 0, 0).Events
	if len(ev) != 1 || ev[0].Kind != wire.EventGrant || *ev[0].Duration != wire.DurationDay || ev[0].By.Name != "Anna" {
		t.Fatalf("%+v", ev)
	}
	// Forever only on test Whombats.
	forever := strings.Replace(grantBody, `"day"`, `"forever"`, 1)
	errorCode(t, f.call(runtimeUID, "POST", wire.PathGrant, forever), 403, wire.ErrForeverNotAllowed)
	if g := f.g.Grant(); g == nil || g.Until == nil {
		t.Fatal("the refused forever changed the grant")
	}
	// Without a pinned CA nothing can be granted (a stop still works).
	f.s.Available = false
	errorCode(t, f.call(runtimeUID, "POST", wire.PathGrant, grantBody), 503, wire.ErrUnavailable)
	if rec := f.call(0, "POST", wire.PathStop, `{"v":1,"reason":"desk"}`); rec.Code != 200 || f.g.Level() != "" {
		t.Fatalf("stop: %d", rec.Code)
	}
}

func TestGrantRefusesWhatIsntOne(t *testing.T) {
	f := newFixture(t, wire.EnvLocal)
	person := `"grantedBy":{"accountId":"acc_owner1","name":"Anna"}`
	for _, body := range []string{
		``, `null`, `[]`, `"x"`, `{}`,
		`{"level":"fix","duration":"day",` + person + `}`,
		`{"v":2,"level":"fix","duration":"day",` + person + `}`,
		`{"v":1,"level":"root","duration":"day",` + person + `}`,
		`{"v":1,"level":"fix","duration":"month",` + person + `}`,
		`{"v":1,"level":"fix","durationS":3600,` + person + `}`,
		`{"v":1,"level":"fix","duration":"day"}`,
		`{"v":1,"level":"fix","duration":"day","grantedBy":null}`,
		`{"v":1,"level":"fix","duration":"day","grantedBy":{"accountId":"acc_owner1"}}`,
		`{"v":1,"level":"fix","duration":"day","grantedBy":{"accountId":"owner1","name":"Anna"}}`,
		`{"v":1,"level":"fix","duration":"day","grantedBy":{"accountId":"acc_owner1","name":"An\u0000na"}}`,
		`{"v":1,"LEVEL":"fix","duration":"day",` + person + `}`,
		`{"v":1,"level":"fix","duration":"day",` + person + `,"helpCode":"KQ72MX"}`,
		`{"v":1,"level":"fix","duration":"day",` + person + `} {}`,
	} {
		errorCode(t, f.call(runtimeUID, "POST", wire.PathGrant, body), 400, wire.ErrBadRequest)
	}
	errorCode(t, f.call(runtimeUID, "POST", wire.PathGrant, `{"v":1,"pad":"`+strings.Repeat("x", 1100)+`"}`), 413,
		wire.ErrTooLarge)
	errorCode(t, f.call(runtimeUID, "POST", wire.PathGrant+"?level=fix", grantBody), 400, wire.ErrBadRequest)
	errorCode(t, f.call(runtimeUID, "GET", wire.PathGrant, ""), 405, wire.ErrBadRequest)
	if f.g.Level() != "" || f.log.Seq() != 0 {
		t.Fatal("a refused request changed something")
	}
}

func TestStop(t *testing.T) {
	f := newFixture(t, wire.EnvLocal)
	// Already off: the state, nobody told.
	st := decode[wire.State](t, f.call(runtimeUID, "POST", wire.PathStop, `{"v":1,"reason":"desk"}`))
	if st.Grant != nil || f.log.Seq() != 0 {
		t.Fatalf("%+v", st)
	}
	for _, body := range []string{
		`{"v":1,"reason":"owner"}`,
		`{"v":1,"reason":"desk","by":{"accountId":"acc_owner1","name":"Anna"}}`,
		`{"v":1,"reason":"expired"}`, `{"reason":"desk"}`, `{"v":1,"reason":"desk","now":true}`,
	} {
		errorCode(t, f.call(runtimeUID, "POST", wire.PathStop, body), 400, wire.ErrBadRequest)
	}
	_ = f.call(runtimeUID, "POST", wire.PathGrant, grantBody)
	st = decode[wire.State](t, f.call(runtimeUID, "POST", wire.PathStop,
		`{"v":1,"reason":"owner","by":{"accountId":"acc_owner2","name":"Bo"}}`))
	if st.Grant != nil || f.g.Level() != "" {
		t.Fatalf("%+v", st)
	}
	ev := f.log.After(t.Context(), 1, 0).Events
	if len(ev) != 1 || ev[0].Kind != wire.EventStop || *ev[0].Reason != wire.StopOwner || ev[0].By.AccountID != "acc_owner2" {
		t.Fatalf("%+v", ev)
	}
}

func TestVisitsAndTranscript(t *testing.T) {
	f := newFixture(t, wire.EnvLocal)
	if vs := decode[wire.Visits](t, f.call(runtimeUID, "GET", wire.PathVisits, "")); vs.V != 1 || vs.Visits == nil || len(vs.Visits) != 0 {
		t.Fatalf("%+v", vs)
	}
	v := f.r.Visit(1, "Claude (op_1)", "Claude", wire.LevelFix)
	v.Connected()
	v.Step(wire.Step{Kind: wire.StepExec, Line: wire.Ptr("systemctl status")})
	_, _ = io.WriteString(v.Transcript(), "\x1b[1mactive\x1b[0m\n")
	f.r.EndOpen()
	vs := decode[wire.Visits](t, f.call(runtimeUID, "GET", wire.PathVisits+"?limit=5", ""))
	if len(vs.Visits) != 1 || vs.Visits[0].ID != v.ID() || vs.Visits[0].EndedAt == nil {
		t.Fatalf("%+v", vs)
	}
	if vs = decode[wire.Visits](t, f.call(runtimeUID, "GET", wire.PathVisits+"?before="+v.ID(), "")); len(vs.Visits) != 0 {
		t.Fatalf("before: %+v", vs)
	}
	// A well-formed id the record can't have: nothing older.
	if vs = decode[wire.Visits](t, f.call(runtimeUID, "GET", wire.PathVisits+"?before=abc", "")); len(vs.Visits) != 0 {
		t.Fatalf("before abc: %+v", vs)
	}
	for _, q := range []string{"?limit=0", "?limit=21", "?limit=05", "?limit=x", "?before=a/b", "?before=" + strings.Repeat("a", 65),
		"?limit=1&limit=2", "?page=2", "?%zz"} {
		errorCode(t, f.call(runtimeUID, "GET", wire.PathVisits+q, ""), 400, wire.ErrBadRequest)
	}

	rec := f.call(0, "GET", "/v1/visits/"+v.ID()+"/transcript", "")
	if rec.Code != 200 || rec.Header().Get("Content-Type") != "text/plain; charset=utf-8" || rec.Body.String() != "\x1b[1mactive\x1b[0m\n" {
		t.Fatalf("%d %q %q", rec.Code, rec.Header().Get("Content-Type"), rec.Body.String())
	}
	errorCode(t, f.call(runtimeUID, "GET", "/v1/visits/20261021T120000Z-0123abcd/transcript", ""), 404, wire.ErrNotFound)
	errorCode(t, f.call(runtimeUID, "GET", "/v1/visits/a.b/transcript", ""), 400, wire.ErrBadRequest)
	errorCode(t, f.call(runtimeUID, "GET", "/v1/visits/"+v.ID()+"/transcript?x", ""), 400, wire.ErrBadRequest)
	errorCode(t, f.call(runtimeUID, "DELETE", "/v1/visits/"+v.ID()+"/transcript", ""), 405, wire.ErrBadRequest)
}

func TestEventsLongPoll(t *testing.T) {
	f := newFixture(t, wire.EnvLocal)
	// Nothing yet: waitS 0 answers at once.
	if e := decode[wire.Events](t, f.call(runtimeUID, "GET", wire.PathEvents, "")); e.V != 1 || len(e.Events) != 0 || e.Next != 0 {
		t.Fatalf("%+v", e)
	}
	// A waiting poll answers when something happens (whether the grant comes before its first look or after).
	got := make(chan *httptest.ResponseRecorder)
	go func() { got <- f.call(runtimeUID, "GET", wire.PathEvents+"?after=0&waitS=25", "") }()
	_ = f.call(runtimeUID, "POST", wire.PathGrant, grantBody)
	select {
	case rec := <-got:
		e := decode[wire.Events](t, rec)
		if len(e.Events) != 1 || e.Events[0].Kind != wire.EventGrant || e.Next != 1 {
			t.Fatalf("%+v", e)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the long poll didn't answer")
	}
	// A caller that goes away ends its poll.
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan struct{})
	go func() {
		req := httptest.NewRequestWithContext(ctx, "GET", wire.PathEvents+"?after=1&waitS=25", nil)
		req.Header.Set("X-Test-Uid", "0")
		f.s.Handler().ServeHTTP(httptest.NewRecorder(), req)
		close(done)
	}()
	cancel()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("a cancelled poll kept waiting")
	}
	for _, q := range []string{"?waitS=26", "?waitS=-1", "?after=-1", "?after=x", "?after=01", "?since=0", "?after=1&after=2"} {
		errorCode(t, f.call(runtimeUID, "GET", wire.PathEvents+q, ""), 400, wire.ErrBadRequest)
	}
}

func TestEventsAnswerAtMostAHundred(t *testing.T) {
	f := newFixture(t, wire.EnvLocal)
	for range 150 {
		f.log.Add(wire.Event{Kind: wire.EventExpired})
	}
	e := decode[wire.Events](t, f.call(runtimeUID, "GET", wire.PathEvents+"?after=10", ""))
	if len(e.Events) != wire.EventsMax || e.Events[0].Seq != 11 || e.Next != 110 {
		t.Fatalf("%d events, first %d, next %d", len(e.Events), e.Events[0].Seq, e.Next)
	}
	e = decode[wire.Events](t, f.call(runtimeUID, "GET", fmt.Sprintf("%s?after=%d", wire.PathEvents, e.Next), ""))
	if len(e.Events) != 40 || e.Events[0].Seq != 111 || e.Next != 150 {
		t.Fatalf("%d events, next %d", len(e.Events), e.Next)
	}
	// A cursor ahead of the log (its state was reset) shows itself at once.
	if e = decode[wire.Events](t, f.call(runtimeUID, "GET", wire.PathEvents+"?after=999&waitS=25", "")); e.Next != 150 || len(e.Events) != 0 {
		t.Fatalf("%+v", e)
	}
}
