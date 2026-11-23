package ownaddress

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/runtimeapi"
	"github.com/CybexBV/whombat/contracts/go/local"
)

// Watch is the certificate watch (MG-165, design §6): Cert Spotter's issuance search, keyless, called by the box
// itself every 6 hours ± 30 minutes for every host it answers at (its address, and an earlier one while it still
// answers there). It keeps, per host, the last fresh, complete answer and every window of more than 12 hours without
// one; silence and errors never count as a check. There is no catch-up source in phase 1 (plan D14).
type Watch struct {
	// BaseURL is Cert Spotter's (CertSpotterURL; tests: a fake).
	BaseURL string
	HTTP    *http.Client
	Store   *Store
	Now     func() time.Time
	Log     *slog.Logger
	// The schedule; zero: the design's.
	Every, Jitter, Gap, RetryMin, RetryMax time.Duration
	// Sleep waits d or until ctx ends (false); nil: a timer (tests replace it).
	Sleep func(ctx context.Context, d time.Duration) bool

	mu sync.Mutex
	// recs are the records of the hosts started, order the hosts in the order the answer names them.
	recs  map[string]*CTState
	order []string
	// runs are the hosts Follow watches now.
	runs map[string]*ctRun
	wg   sync.WaitGroup
}

type ctRun struct {
	cancel context.CancelFunc
	done   chan struct{}
}

// The design's schedule and bounds.
const (
	ctEvery    = 6 * time.Hour
	ctJitter   = 30 * time.Minute
	ctGap      = 12 * time.Hour
	ctRetryMin = time.Hour
	ctRetryMax = 6 * time.Hour
	// ctPagesMax bounds one check's pages (each answer is a box's few certificates; more is not a box's list).
	ctPagesMax = 10
	// ctPageBytes bounds one page's body.
	ctPageBytes = 2 << 20
	ctMissedMax = 64
	ctCertsMax  = 256
	ctNamesMax  = 100
)

func (w *Watch) now() time.Time {
	if w.Now != nil {
		return w.Now()
	}
	return time.Now()
}

func (w *Watch) log() *slog.Logger {
	if w.Log != nil {
		return w.Log
	}
	return slog.Default()
}

func or(d, def time.Duration) time.Duration {
	if d > 0 {
		return d
	}
	return def
}

func (w *Watch) sleep(ctx context.Context, d time.Duration) bool {
	if w.Sleep != nil {
		return w.Sleep(ctx, d)
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

// RateLimited is Cert Spotter's 429, with how long it said to wait.
type RateLimited struct{ Wait time.Duration }

func (e *RateLimited) Error() string { return fmt.Sprintf("cert spotter: rate limited for %s", e.Wait) }

// Start loads (or starts) the record for host: a host without one starts from now.
func (w *Watch) Start(host string) error {
	st, err := w.Store.CT(host)
	if err != nil {
		w.log().Warn("own address: the watch's record is unreadable; it starts over", "host", host, "err", err)
		st = nil
	}
	if st == nil {
		st = &CTState{Host: host, CheckingSince: w.now().UTC(), Missed: []Window{}, Certs: []local.OwnAddressCtCert{}}
		if err := w.Store.SaveCT(st); err != nil {
			return err
		}
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.recs == nil {
		w.recs = map[string]*CTState{}
	}
	w.recs[host] = st
	if !slices.Contains(w.order, host) {
		w.order = append(w.order, host)
	}
	return nil
}

// Follow watches exactly hosts from now on: a new host starts at once (no restart needed), a host no longer served
// stops and its record is forgotten. Its loops end with ctx; Wait waits for them.
func (w *Watch) Follow(ctx context.Context, hosts []string) {
	w.mu.Lock()
	if w.runs == nil {
		w.runs = map[string]*ctRun{}
	}
	var stop []string
	for h := range w.runs {
		if !slices.Contains(hosts, h) {
			stop = append(stop, h)
		}
	}
	stopped := make([]*ctRun, 0, len(stop))
	for _, h := range stop {
		stopped = append(stopped, w.runs[h])
		delete(w.runs, h)
	}
	var start []string
	for _, h := range hosts {
		if _, ok := w.runs[h]; !ok {
			start = append(start, h)
		}
	}
	for _, h := range start {
		c, cancel := context.WithCancel(ctx)
		r := &ctRun{cancel: cancel, done: make(chan struct{})}
		w.runs[h] = r
		w.wg.Add(1)
		go func() {
			defer w.wg.Done()
			defer close(r.done)
			w.Run(c, h)
			w.mu.Lock()
			if w.runs[h] == r {
				delete(w.runs, h)
			}
			w.mu.Unlock()
		}()
	}
	// The answer names the hosts as given (the current one first); a host not started yet has no record to show.
	w.order = slices.Clone(hosts)
	w.mu.Unlock()
	for i, r := range stopped {
		r.cancel()
		<-r.done
		w.forget(stop[i])
	}
}

// forget drops host's record, in memory and on disk.
func (w *Watch) forget(host string) {
	w.mu.Lock()
	delete(w.recs, host)
	w.order = slices.DeleteFunc(w.order, func(h string) bool { return h == host })
	w.mu.Unlock()
	if err := w.Store.DropCT(host); err != nil {
		w.log().Warn("own address: the watch's record of an earlier host stays", "host", host, "err", err)
	}
}

// Wait waits for the loops Follow started.
func (w *Watch) Wait() { w.wg.Wait() }

func (w *Watch) record(host string) *CTState {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.recs[host]
}

// Run watches host until ctx ends. After a restart it waits for the next regular check rather than asking at once,
// so restarts don't spend the keyless quota.
func (w *Watch) Run(ctx context.Context, host string) {
	if err := w.Start(host); err != nil {
		w.log().Error("own address: the certificate watch can't keep its record", "host", host, "err", err)
		return
	}
	every, jitter := or(w.Every, ctEvery), or(w.Jitter, ctJitter)
	last := w.record(host).LastFresh
	wait := time.Duration(rand.Int64N(int64(time.Minute)))
	if !last.IsZero() {
		if due := last.Add(every).Sub(w.now()); due > wait {
			wait = due + spread(jitter)
		}
	}
	retry := or(w.RetryMin, ctRetryMin)
	for {
		if !w.sleep(ctx, wait) {
			return
		}
		err := w.Check(ctx, host)
		var rl *RateLimited
		switch {
		case err == nil:
			wait = every + spread(jitter)
			retry = or(w.RetryMin, ctRetryMin)
		case ctx.Err() != nil:
			return
		case errors.As(err, &rl):
			w.log().Warn("own address: cert spotter asked to wait", "wait", rl.Wait)
			wait = max(rl.Wait, time.Minute)
		default:
			w.log().Warn("own address: certificate check failed", "host", host, "err", err, "retry", retry)
			wait = retry
			retry = min(retry*2, or(w.RetryMax, ctRetryMax))
		}
	}
}

// spread is uniform in [-j, +j].
func spread(j time.Duration) time.Duration {
	if j <= 0 {
		return 0
	}
	return time.Duration(rand.Int64N(int64(2*j)+1)) - j
}

// issuance is the part of Cert Spotter's answer the box reads.
type issuance struct {
	ID           string   `json:"id"`
	DNSNames     []string `json:"dns_names"`
	PubkeySHA256 string   `json:"pubkey_sha256"`
	Issuer       *struct {
		Name         string `json:"name"`
		FriendlyName string `json:"friendly_name"`
	} `json:"issuer"`
	NotBefore string `json:"not_before"`
	NotAfter  string `json:"not_after"`
}

var (
	ctIDRe   = regexp.MustCompile(`^[0-9]{1,20}$`)
	ctSPKIRe = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// Check runs one complete check of host and records it. An answer it can't read in full is no check at all.
func (w *Watch) Check(ctx context.Context, host string) error {
	if w.record(host) == nil {
		if err := w.Start(host); err != nil {
			return err
		}
	}
	var all []issuance
	after := ""
	complete := false
	for range ctPagesMax {
		page, err := w.page(ctx, host, after)
		if err != nil {
			return err
		}
		if len(page) == 0 {
			complete = true
			break
		}
		all = append(all, page...)
		after = page[len(page)-1].ID
	}
	if !complete {
		return fmt.Errorf("cert spotter: more than %d pages", ctPagesMax)
	}
	certs := []local.OwnAddressCtCert{}
	for _, is := range all {
		c, keep, err := w.cert(is, host)
		if err != nil {
			return err
		}
		if keep && len(certs) < ctCertsMax {
			certs = append(certs, c)
		}
	}
	now := w.now().UTC()
	w.mu.Lock()
	defer w.mu.Unlock()
	cur := w.recs[host]
	if cur == nil {
		// Forgotten while it checked: the box no longer answers there.
		return nil
	}
	st := *cur
	from := st.LastFresh
	if from.IsZero() {
		from = st.CheckingSince
	}
	if now.Sub(from) > or(w.Gap, ctGap) {
		st.Missed = append(slices.Clone(st.Missed), Window{From: from, To: now})
		if len(st.Missed) > ctMissedMax {
			st.Missed = st.Missed[len(st.Missed)-ctMissedMax:]
		}
	}
	st.LastFresh, st.Certs = now, certs
	if err := w.Store.SaveCT(&st); err != nil {
		return err
	}
	w.recs[host] = &st
	return nil
}

func (w *Watch) page(ctx context.Context, host, after string) ([]issuance, error) {
	q := url.Values{}
	q.Set("domain", host)
	q.Set("include_subdomains", "true")
	q.Set("match_wildcards", "true")
	q.Add("expand", "dns_names")
	q.Add("expand", "issuer")
	if after != "" {
		q.Set("after", after)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimSuffix(w.BaseURL, "/")+"/v1/issuances?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "whombat-box")
	req.Header.Set("Accept", "application/json")
	hc := w.HTTP
	if hc == nil {
		hc = &http.Client{Timeout: 60 * time.Second}
	}
	resp, err := hc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("cert spotter: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusTooManyRequests {
		return nil, &RateLimited{Wait: retryAfterOf(resp.Header.Get("Retry-After"), w.now())}
	}
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return nil, fmt.Errorf("cert spotter: HTTP %d", resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, ctPageBytes+1))
	if err != nil {
		return nil, fmt.Errorf("cert spotter: %w", err)
	}
	if len(b) > ctPageBytes {
		return nil, errors.New("cert spotter: a page above its bound")
	}
	var page []issuance
	if err := json.Unmarshal(b, &page); err != nil {
		return nil, fmt.Errorf("cert spotter: %w", err)
	}
	return page, nil
}

// retryAfterOf reads a Retry-After header (seconds or a date); without one, an hour.
func retryAfterOf(v string, now time.Time) time.Duration {
	if s, err := strconv.Atoi(strings.TrimSpace(v)); err == nil && s >= 0 {
		return time.Duration(s) * time.Second
	}
	if t, err := http.ParseTime(v); err == nil {
		return t.Sub(now)
	}
	return time.Hour
}

// cert reads one issuance. keep is false when none of its names concern host. Cert Spotter's wildcard match also
// returns wildcards higher up: `*.whombat.app` covers a host directly under whombat.app and is kept for it (the runtime
// decides whether it is foreign), but covers no `<label>.box.whombat.app`, so it isn't kept for such a host.
func (w *Watch) cert(is issuance, host string) (local.OwnAddressCtCert, bool, error) {
	if !ctIDRe.MatchString(is.ID) || !ctSPKIRe.MatchString(is.PubkeySHA256) {
		return local.OwnAddressCtCert{}, false, fmt.Errorf("cert spotter: an issuance out of shape (id %q)", is.ID)
	}
	nb, err1 := time.Parse(time.RFC3339, is.NotBefore)
	na, err2 := time.Parse(time.RFC3339, is.NotAfter)
	if err := errors.Join(err1, err2); err != nil {
		return local.OwnAddressCtCert{}, false, fmt.Errorf("cert spotter: issuance %s: %w", is.ID, err)
	}
	names := RelevantNames(is.DNSNames, host, ZoneOf(host))
	if len(names) == 0 {
		return local.OwnAddressCtCert{}, false, nil
	}
	issuer := "unknown"
	if is.Issuer != nil {
		if n := runtimeapi.ASCII(is.Issuer.Name, 200); n != "" {
			issuer = n
		} else if n := runtimeapi.ASCII(is.Issuer.FriendlyName, 200); n != "" {
			issuer = n
		}
	}
	return local.OwnAddressCtCert{ID: is.ID, SpkiSHA256: is.PubkeySHA256, DnsNames: names,
		NotBefore: nb.UTC().Format(time.RFC3339), NotAfter: na.UTC().Format(time.RFC3339), Issuer: issuer}, true, nil
}

var ctNameRe = regexp.MustCompile(`^[*a-z0-9.-]{1,253}$`)

// RelevantNames keeps the names that concern host (OWA-09): host itself, any name under it, and exactly `*.<zone>`
// of host's own zone, which covers it. Lower case, without a trailing dot, each once.
func RelevantNames(names []string, host, zone string) []string {
	out := []string{}
	for _, n := range names {
		n = strings.TrimSuffix(strings.ToLower(n), ".")
		if n != host && !strings.HasSuffix(n, "."+host) && (zone == "" || n != "*."+zone) {
			continue
		}
		if !ctNameRe.MatchString(n) || slices.Contains(out, n) {
			continue
		}
		if len(out) == ctNamesMax {
			break
		}
		out = append(out, n)
	}
	return out
}

// Response is the records as the runtime reads them (/v1/own-address/ct): every watched host, with an open window up to
// now when more than 12 hours passed since a host's last fresh check. nil before the watch started.
//
// One answer covers every host, so it claims no more than each of them: checkingSince is the latest host's start,
// lastFreshAt the oldest host's last fresh check (none while any host has none), missed every host's windows, and the
// certificates every host's, each once.
func (w *Watch) Response(now time.Time) *local.OwnAddressCtResponse {
	w.mu.Lock()
	defer w.mu.Unlock()
	var out *local.OwnAddressCtResponse
	gap := or(w.Gap, ctGap)
	fresh := true
	var since, last time.Time
	for _, h := range w.order {
		st := w.recs[h]
		if st == nil {
			continue
		}
		r := ctResponse(st, now, gap)
		if out == nil {
			out = r
			out.Hosts = []string{}
		} else {
			out.Missed = append(out.Missed, r.Missed...)
			for _, c := range r.Certs {
				if len(out.Certs) < ctCertsMax && !slices.ContainsFunc(out.Certs, func(o local.OwnAddressCtCert) bool { return o.ID == c.ID }) {
					out.Certs = append(out.Certs, c)
				}
			}
		}
		out.Hosts = append(out.Hosts, h)
		if st.CheckingSince.After(since) {
			since = st.CheckingSince
		}
		if st.LastFresh.IsZero() {
			fresh = false
		} else if last.IsZero() || st.LastFresh.Before(last) {
			last = st.LastFresh
		}
	}
	if out == nil {
		return nil
	}
	out.CheckingSince = since.UTC().Format(time.RFC3339)
	out.LastFreshAt = nil
	if fresh && !last.IsZero() {
		s := last.UTC().Format(time.RFC3339)
		out.LastFreshAt = &s
	}
	slices.SortStableFunc(out.Missed, func(a, b local.OwnAddressCtResponseMissedItem) int { return strings.Compare(a.From, b.From) })
	if len(out.Missed) > ctMissedMax {
		out.Missed = out.Missed[len(out.Missed)-ctMissedMax:]
	}
	return out
}

func ctResponse(st *CTState, now time.Time, gap time.Duration) *local.OwnAddressCtResponse {
	r := &local.OwnAddressCtResponse{V: 1, Source: "certspotter", CheckingSince: st.CheckingSince.UTC().Format(time.RFC3339),
		Missed: []local.OwnAddressCtResponseMissedItem{}, Certs: slices.Clone(st.Certs), Ordered: []local.OwnAddressCertMeta{}}
	if r.Certs == nil {
		r.Certs = []local.OwnAddressCtCert{}
	}
	from := st.CheckingSince
	if !st.LastFresh.IsZero() {
		s := st.LastFresh.UTC().Format(time.RFC3339)
		r.LastFreshAt = &s
		from = st.LastFresh
	}
	missed := slices.Clone(st.Missed)
	if now.Sub(from) > gap {
		missed = append(missed, Window{From: from, To: now})
	}
	if len(missed) > ctMissedMax {
		missed = missed[len(missed)-ctMissedMax:]
	}
	for _, m := range missed {
		r.Missed = append(r.Missed, local.OwnAddressCtResponseMissedItem{From: m.From.UTC().Format(time.RFC3339), To: m.To.UTC().Format(time.RFC3339)})
	}
	return r
}
