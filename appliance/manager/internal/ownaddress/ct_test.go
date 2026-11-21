package ownaddress

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeSpotter is a stand-in for Cert Spotter's issuance search.
type fakeSpotter struct {
	mu       sync.Mutex
	pages    [][]map[string]any // pages[i] is what after=<last id of page i-1> returns; past the end: []
	status   int                // non-zero: answer this instead
	retry    string
	requests []string
	agents   []string
}

func (f *fakeSpotter) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.requests = append(f.requests, r.URL.RequestURI())
	f.agents = append(f.agents, r.UserAgent())
	if f.status != 0 {
		if f.retry != "" {
			w.Header().Set("Retry-After", f.retry)
		}
		w.WriteHeader(f.status)
		return
	}
	i := 0
	if after := r.URL.Query().Get("after"); after != "" {
		for j, p := range f.pages {
			if len(p) > 0 && p[len(p)-1]["id"] == after {
				i = j + 1
			}
		}
	}
	page := []map[string]any{}
	if i < len(f.pages) {
		page = f.pages[i]
	}
	_ = json.NewEncoder(w).Encode(page)
}

func issuanceOf(id string, names ...string) map[string]any {
	return map[string]any{
		"id": id, "dns_names": names, "pubkey_sha256": strings.Repeat("ab", 32),
		"issuer":     map[string]any{"name": "C=US, O=Let's Encrypt, CN=E7", "friendly_name": "Let's Encrypt"},
		"not_before": "2026-11-18T07:11:24Z", "not_after": "2027-02-16T08:09:15Z",
	}
}

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time      { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) add(d time.Duration) { c.mu.Lock(); c.t = c.t.Add(d); c.mu.Unlock() }

func newWatch(t *testing.T, f *fakeSpotter, c *clock) (*Watch, *Store) {
	t.Helper()
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	st, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return &Watch{BaseURL: srv.URL, Store: st, Zone: "dev.whombat.app", Now: c.now}, st
}

func TestCTKeepsOnlyNamesThatConcernTheBox(t *testing.T) {
	f := &fakeSpotter{pages: [][]map[string]any{{
		issuanceOf("1", testHost),
		issuanceOf("2", "x."+testHost, "unrelated.example.com"),
		issuanceOf("3", "*.dev.whombat.app"),
		issuanceOf("4", "*.whombat.app", "whombat.app"),
		issuanceOf("5", "*."+strings.ToUpper(testHost)+"."),
		issuanceOf("6", "other-name-here.dev.whombat.app"),
	}}}
	c := &clock{t: time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)}
	w, _ := newWatch(t, f, c)
	if err := w.Check(context.Background(), testHost); err != nil {
		t.Fatal(err)
	}
	r := w.Response(c.now())
	var got []string
	for _, cert := range r.Certs {
		got = append(got, cert.ID+":"+strings.Join(cert.DnsNames, ","))
	}
	want := []string{"1:" + testHost, "2:x." + testHost, "3:*.dev.whombat.app", "5:*." + testHost}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("certs %v, want %v", got, want)
	}
	if r.Certs[0].Issuer != "C=US, O=Let's Encrypt, CN=E7" || r.LastFreshAt == nil || *r.LastFreshAt != "2026-11-18T12:00:00Z" {
		t.Fatalf("record %+v", r)
	}
	if err := r.Validate(); err != nil {
		t.Fatalf("not the contract's: %v", err)
	}
	q := f.requests[0]
	for _, part := range []string{"domain=" + testHost, "include_subdomains=true", "match_wildcards=true", "expand=dns_names", "expand=issuer"} {
		if !strings.Contains(q, part) {
			t.Fatalf("query %s lacks %s", q, part)
		}
	}
	if f.agents[0] != "whombat-box" {
		t.Fatalf("User-Agent %q", f.agents[0])
	}
}

func TestCTFollowsPages(t *testing.T) {
	f := &fakeSpotter{pages: [][]map[string]any{
		{issuanceOf("10", testHost), issuanceOf("11", testHost)},
		{issuanceOf("12", "a."+testHost)},
	}}
	c := &clock{t: time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)}
	w, _ := newWatch(t, f, c)
	if err := w.Check(context.Background(), testHost); err != nil {
		t.Fatal(err)
	}
	if len(f.requests) != 3 || !strings.Contains(f.requests[1], "after=11") || !strings.Contains(f.requests[2], "after=12") {
		t.Fatalf("requests %v", f.requests)
	}
	if n := len(w.Response(c.now()).Certs); n != 3 {
		t.Fatalf("%d certs, want 3", n)
	}
}

func TestCTNeverCountsAnErrorAsACheck(t *testing.T) {
	c := &clock{t: time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)}
	f := &fakeSpotter{pages: [][]map[string]any{{issuanceOf("1", testHost)}}}
	w, _ := newWatch(t, f, c)
	if err := w.Check(context.Background(), testHost); err != nil {
		t.Fatal(err)
	}
	c.add(time.Hour)
	f.status = http.StatusBadGateway
	if err := w.Check(context.Background(), testHost); err == nil {
		t.Fatal("a 502 was a check")
	}
	f.status = http.StatusTooManyRequests
	f.retry = "1800"
	err := w.Check(context.Background(), testHost)
	var rl *RateLimited
	if !errors.As(err, &rl) || rl.Wait != 30*time.Minute {
		t.Fatalf("429: %v", err)
	}
	// An issuance the box can't read spoils the whole answer.
	f.status = 0
	bad := issuanceOf("2", testHost)
	bad["pubkey_sha256"] = "XYZ"
	f.pages = [][]map[string]any{{bad}}
	if err := w.Check(context.Background(), testHost); err == nil {
		t.Fatal("an unreadable issuance was a check")
	}
	if r := w.Response(c.now()); *r.LastFreshAt != "2026-11-18T12:00:00Z" || len(r.Certs) != 1 {
		t.Fatalf("a failure changed the record: %+v", r)
	}
}

func TestCTRecordsMissedWindows(t *testing.T) {
	start := time.Date(2026, 11, 18, 0, 0, 0, 0, time.UTC)
	c := &clock{t: start}
	f := &fakeSpotter{}
	w, st := newWatch(t, f, c)
	if err := w.Start(testHost); err != nil {
		t.Fatal(err)
	}
	// 13 hours from the start with the source failing: an open window, then a closed one at the first fresh check.
	c.add(13 * time.Hour)
	r := w.Response(c.now())
	if r.LastFreshAt != nil || len(r.Missed) != 1 || r.Missed[0].From != "2026-11-18T00:00:00Z" || r.Missed[0].To != "2026-11-18T13:00:00Z" {
		t.Fatalf("open window %+v", r.Missed)
	}
	if err := w.Check(context.Background(), testHost); err != nil {
		t.Fatal(err)
	}
	// Six hours later: a regular check, no window.
	c.add(6 * time.Hour)
	if err := w.Check(context.Background(), testHost); err != nil {
		t.Fatal(err)
	}
	if r := w.Response(c.now()); len(r.Missed) != 1 {
		t.Fatalf("missed %+v", r.Missed)
	}
	// The box is off for two days: the next start keeps the record, and the first check closes the gap.
	c.add(48 * time.Hour)
	w2 := &Watch{BaseURL: w.BaseURL, Store: st, Zone: w.Zone, Now: c.now}
	if err := w2.Start(testHost); err != nil {
		t.Fatal(err)
	}
	if r := w2.Response(c.now()); len(r.Missed) != 2 || r.Missed[1].From != "2026-11-18T19:00:00Z" {
		t.Fatalf("after downtime %+v", r.Missed)
	}
	if err := w2.Check(context.Background(), testHost); err != nil {
		t.Fatal(err)
	}
	r = w2.Response(c.now())
	if len(r.Missed) != 2 || r.Missed[1].To != "2026-11-20T19:00:00Z" || r.CheckingSince != "2026-11-18T00:00:00Z" {
		t.Fatalf("closed %+v since %s", r.Missed, r.CheckingSince)
	}
	// Another name starts over.
	w3 := &Watch{BaseURL: w.BaseURL, Store: st, Zone: w.Zone, Now: c.now}
	if err := w3.Start("other-name-here.dev.whombat.app"); err != nil {
		t.Fatal(err)
	}
	if r := w3.Response(c.now()); len(r.Missed) != 0 || r.LastFreshAt != nil {
		t.Fatalf("another name kept %+v", r)
	}
}

func TestCTRunWaitsOutRestartsAndBacksOff(t *testing.T) {
	c := &clock{t: time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)}
	f := &fakeSpotter{}
	w, _ := newWatch(t, f, c)
	if err := w.Check(context.Background(), testHost); err != nil {
		t.Fatal(err)
	}
	f.requests = nil
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var waits []time.Duration
	w.Jitter = time.Nanosecond // keep the arithmetic exact enough to compare
	w.Sleep = func(ctx context.Context, d time.Duration) bool {
		waits = append(waits, d)
		switch len(waits) {
		case 1: // after the restart: the next regular check is 6 h after the last, not now
			c.add(d)
			f.status = http.StatusInternalServerError
		case 2: // the 5xx: an hour, then two
			c.add(d)
		case 3:
			c.add(d)
			f.status, f.retry = http.StatusTooManyRequests, "7200"
		case 4: // the 429 waits as told
			c.add(d)
			f.status, f.retry = 0, ""
		case 5: // a fresh check: 6 h ± jitter; then a failure starts the backoff at an hour again
			c.add(d)
			f.status = http.StatusInternalServerError
		default:
			cancel()
			return false
		}
		return true
	}
	c.add(2 * time.Hour) // restarted two hours after the last check
	w.Run(ctx, testHost)
	approx := func(got, want time.Duration) bool { return got > want-time.Second && got < want+time.Second }
	if len(waits) != 6 || !approx(waits[0], 4*time.Hour) || waits[1] != time.Hour || waits[2] != 2*time.Hour ||
		waits[3] != 2*time.Hour || !approx(waits[4], 6*time.Hour) || waits[5] != time.Hour {
		t.Fatalf("waits %v", waits)
	}
}
