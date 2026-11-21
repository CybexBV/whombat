package checks

import (
	"context"
	"crypto/x509"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"

	"rackoon/internal/proto"
)

func spec(kind, target string) proto.CheckSpec {
	return proto.CheckSpec{ID: "c1", Kind: kind, Target: target, IntervalS: 60, TimeoutS: 5}
}

func TestValidate(t *testing.T) {
	good := []proto.CheckSpec{
		spec(proto.CheckHTTP, "https://example.com/health?x=1"),
		spec(proto.CheckTCP, "db.lan:5432"),
		spec(proto.CheckTCP, "[::1]:22"),
		spec(proto.CheckPing, "10.0.0.1"),
		spec(proto.CheckPing, "router.lan"),
		spec(proto.CheckDNS, "example.com."),
	}
	for _, s := range good {
		if err := Validate(s); err != nil {
			t.Errorf("%s %s: %v", s.Kind, s.Target, err)
		}
	}
	bad := map[string]proto.CheckSpec{
		"kind":      spec("smtp", "x"),
		"scheme":    spec(proto.CheckHTTP, "ftp://example.com"),
		"no host":   spec(proto.CheckHTTP, "http:///x"),
		"no port":   spec(proto.CheckTCP, "db.lan"),
		"port 0":    spec(proto.CheckTCP, "db.lan:0"),
		"ping port": spec(proto.CheckPing, "host:22"),
		"spaces":    spec(proto.CheckPing, "a b"),
		"dash":      spec(proto.CheckDNS, "-x.example"),
		"no id":     {Kind: proto.CheckPing, Target: "x", IntervalS: 60, TimeoutS: 5},
	}
	s := spec(proto.CheckPing, "x")
	s.IntervalS = 10
	bad["interval"] = s
	s = spec(proto.CheckPing, "x")
	s.TimeoutS = 61
	bad["timeout"] = s
	s = spec(proto.CheckHTTP, "http://x")
	s.ExpectStatus = "200-100"
	bad["status"] = s
	s = spec(proto.CheckDNS, "x.example")
	s.DNSType = "SRV"
	bad["dns type"] = s
	s = spec(proto.CheckDNS, "x.example")
	s.DNSServer = "a b"
	bad["dns server"] = s
	for name, s := range bad {
		if err := Validate(s); err == nil {
			t.Errorf("%s: accepted %+v", name, s)
		}
	}
	if r, _ := parseStatusRanges("200-299, 301"); !statusOK(r, 301) || statusOK(r, 302) || !statusOK(r, 204) {
		t.Fatal("status ranges")
	}
}

func TestHTTP(t *testing.T) {
	var gotUA atomic.Value
	mux := http.NewServeMux()
	mux.HandleFunc("/ok", func(w http.ResponseWriter, r *http.Request) {
		gotUA.Store(r.UserAgent())
		fmt.Fprint(w, strings.Repeat("x", 300<<10)+"all systems nominal")
	})
	mux.HandleFunc("/down", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) })
	mux.HandleFunc("/big", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, strings.Repeat("y", 2<<20)+"needle")
	})
	mux.HandleFunc("/r/", func(w http.ResponseWriter, r *http.Request) {
		var n int
		fmt.Sscanf(strings.TrimPrefix(r.URL.Path, "/r/"), "%d", &n)
		if n == 0 {
			fmt.Fprint(w, "landed")
			return
		}
		http.Redirect(w, r, fmt.Sprintf("/r/%d", n-1), http.StatusFound)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	ctx := context.Background()

	s := spec(proto.CheckHTTP, srv.URL+"/ok")
	s.Keyword = "nominal"
	r := Run(ctx, s)
	if !r.OK || r.StatusCode != 200 || r.LatencyMs == nil || r.CertNotAfter != nil || r.ID != "c1" || r.At.IsZero() {
		t.Fatalf("ok: %+v", r)
	}
	if ua, _ := gotUA.Load().(string); ua != "Whombat-Check/1" {
		t.Fatalf("user agent %q", ua)
	}
	s.Keyword = "missing"
	if r := Run(ctx, s); r.OK || r.Error != "keyword not found" {
		t.Fatalf("keyword: %+v", r)
	}
	s = spec(proto.CheckHTTP, srv.URL+"/big")
	s.Keyword = "needle" // beyond the first MiB
	if r := Run(ctx, s); r.OK {
		t.Fatalf("keyword past 1 MiB: %+v", r)
	}
	s = spec(proto.CheckHTTP, srv.URL+"/down")
	if r := Run(ctx, s); r.OK || r.StatusCode != 503 || r.Error != "status 503" {
		t.Fatalf("503: %+v", r)
	}
	s.ExpectStatus = "500-503"
	if r := Run(ctx, s); !r.OK {
		t.Fatalf("503 expected: %+v", r)
	}
	if r := Run(ctx, spec(proto.CheckHTTP, srv.URL+"/r/5")); !r.OK || r.StatusCode != 200 {
		t.Fatalf("5 redirects: %+v", r)
	}
	if r := Run(ctx, spec(proto.CheckHTTP, srv.URL+"/r/6")); r.OK || !strings.Contains(r.Error, "redirects") {
		t.Fatalf("6 redirects: %+v", r)
	}
	srv2 := httptest.NewServer(http.NotFoundHandler())
	addr := srv2.Listener.Addr().String()
	srv2.Close()
	if r := Run(ctx, spec(proto.CheckHTTP, "http://"+addr+"/")); r.OK || r.Error != "connection refused" {
		t.Fatalf("refused: %+v", r)
	}
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(5 * time.Second):
		}
	}))
	defer slow.Close()
	s = spec(proto.CheckHTTP, slow.URL)
	s.TimeoutS = 1
	start := time.Now()
	if r := Run(ctx, s); r.OK || r.Error != "timeout" || time.Since(start) > 3*time.Second {
		t.Fatalf("timeout: %+v after %v", r, time.Since(start))
	}
}

func TestHTTPS(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "hi") }))
	defer srv.Close()
	ctx := context.Background()
	notAfter := srv.Certificate().NotAfter.UTC()

	s := spec(proto.CheckHTTP, srv.URL)
	r := Run(ctx, s)
	if r.OK || !strings.Contains(r.Error, "certificate") || r.CertNotAfter == nil || !r.CertNotAfter.Equal(notAfter) {
		t.Fatalf("untrusted certificate: %+v", r)
	}
	s.InsecureTLS = true
	r = Run(ctx, s)
	if !r.OK || r.CertNotAfter == nil || !r.CertNotAfter.Equal(notAfter) {
		t.Fatalf("insecure: %+v", r)
	}
	pool := x509.NewCertPool()
	pool.AddCert(srv.Certificate())
	rootPool = pool
	defer func() { rootPool = nil }()
	s.InsecureTLS = false
	// httptest's certificate is for 127.0.0.1 / example.com.
	if r := Run(ctx, s); !r.OK || r.CertNotAfter == nil {
		t.Fatalf("trusted: %+v", r)
	}

	// TCP with TLS.
	ts := spec(proto.CheckTCP, srv.Listener.Addr().String())
	ts.TLS = true
	if r := Run(ctx, ts); !r.OK || r.CertNotAfter == nil || !r.CertNotAfter.Equal(notAfter) {
		t.Fatalf("tcp tls: %+v", r)
	}
}

func TestTCP(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()
	addr := ln.Addr().String()
	ctx := context.Background()
	if r := Run(ctx, spec(proto.CheckTCP, addr)); !r.OK || r.LatencyMs == nil {
		t.Fatalf("open: %+v", r)
	}
	s := spec(proto.CheckTCP, addr)
	s.TLS = true // the listener closes without a handshake
	if r := Run(ctx, s); r.OK || !strings.HasPrefix(r.Error, "TLS") {
		t.Fatalf("no TLS: %+v", r)
	}
	ln.Close()
	if r := Run(ctx, spec(proto.CheckTCP, addr)); r.OK || r.Error != "connection refused" {
		t.Fatalf("closed: %+v", r)
	}
}

// dnsServer answers A, AAAA, CNAME, MX and TXT queries for test.example.
func dnsServer(t *testing.T) string {
	t.Helper()
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pc.Close() })
	go func() {
		buf := make([]byte, 1500)
		for {
			n, addr, err := pc.ReadFrom(buf)
			if err != nil {
				return
			}
			var p dnsmessage.Parser
			hdr, err := p.Start(buf[:n])
			if err != nil {
				continue
			}
			q, err := p.Question()
			if err != nil {
				continue
			}
			b := dnsmessage.NewBuilder(nil, dnsmessage.Header{ID: hdr.ID, Response: true, Authoritative: true})
			b.EnableCompression()
			name := q.Name.String()
			known := name == "test.example." || name == "alias.example."
			if !known {
				b = dnsmessage.NewBuilder(nil, dnsmessage.Header{ID: hdr.ID, Response: true, RCode: dnsmessage.RCodeNameError})
			}
			b.StartQuestions()
			b.Question(q)
			b.StartAnswers()
			rh := dnsmessage.ResourceHeader{Name: q.Name, Class: dnsmessage.ClassINET, TTL: 60}
			if name == "alias.example." {
				// Like a real server: the CNAME, then the target's records.
				b.CNAMEResource(rh, dnsmessage.CNAMEResource{CNAME: dnsmessage.MustNewName("test.example.")})
				rh.Name = dnsmessage.MustNewName("test.example.")
				if q.Type == dnsmessage.TypeA {
					b.AResource(rh, dnsmessage.AResource{A: [4]byte{192, 0, 2, 7}})
				}
			} else if known {
				switch q.Type {
				case dnsmessage.TypeA:
					b.AResource(rh, dnsmessage.AResource{A: [4]byte{192, 0, 2, 7}})
					b.AResource(rh, dnsmessage.AResource{A: [4]byte{192, 0, 2, 8}})
				case dnsmessage.TypeAAAA:
					b.AAAAResource(rh, dnsmessage.AAAAResource{AAAA: [16]byte{0x20, 0x01, 0x0d, 0xb8, 15: 1}})
				case dnsmessage.TypeMX:
					b.MXResource(rh, dnsmessage.MXResource{Pref: 10, MX: dnsmessage.MustNewName("mail.test.example.")})
				case dnsmessage.TypeTXT:
					b.TXTResource(rh, dnsmessage.TXTResource{TXT: []string{"v=spf1 -all"}})
				}
			}
			out, err := b.Finish()
			if err == nil {
				pc.WriteTo(out, addr)
			}
		}
	}()
	return pc.LocalAddr().String()
}

func TestDNS(t *testing.T) {
	server := dnsServer(t)
	ctx := context.Background()
	q := func(typ, name, expect string) proto.CheckResult {
		s := spec(proto.CheckDNS, name)
		s.DNSType, s.DNSServer, s.Expect = typ, server, expect
		return Run(ctx, s)
	}
	if r := q("", "test.example.", "192.0.2.8"); !r.OK || strings.Join(r.Answer, ",") != "192.0.2.7,192.0.2.8" {
		t.Fatalf("A: %+v", r)
	}
	if r := q("A", "test.example.", "198.51"); r.OK || !strings.Contains(r.Error, "no record contains") {
		t.Fatalf("A expect mismatch: %+v", r)
	}
	if r := q("AAAA", "test.example.", ""); !r.OK || strings.Join(r.Answer, ",") != "2001:db8::1" {
		t.Fatalf("AAAA: %+v", r)
	}
	if r := q("MX", "test.example.", "mail."); !r.OK || r.Answer[0] != "10 mail.test.example." {
		t.Fatalf("MX: %+v", r)
	}
	if r := q("TXT", "test.example.", "SPF1"); !r.OK || r.Answer[0] != "v=spf1 -all" {
		t.Fatalf("TXT: %+v", r)
	}
	if r := q("CNAME", "alias.example.", "test.example"); !r.OK || r.Answer[0] != "test.example." {
		t.Fatalf("CNAME: %+v", r)
	}
	if r := q("A", "nope.example.", ""); r.OK || !strings.Contains(r.Error, "not found") {
		t.Fatalf("NXDOMAIN: %+v", r)
	}
}

func TestPing(t *testing.T) {
	r := Run(context.Background(), spec(proto.CheckPing, "127.0.0.1"))
	if !r.OK && strings.Contains(r.Error, ErrPingNotPermitted.Error()) {
		t.Skip("ICMP not permitted here:", r.Error)
	}
	if !r.OK || r.LatencyMs == nil {
		t.Fatalf("ping 127.0.0.1: %+v", r)
	}
	// TEST-NET-1 does not answer: three attempts within the timeout.
	s := spec(proto.CheckPing, "192.0.2.1")
	s.TimeoutS = 1
	start := time.Now()
	if r := Run(context.Background(), s); r.OK || time.Since(start) > 2500*time.Millisecond {
		t.Fatalf("unreachable: %+v after %v", r, time.Since(start))
	}
}

func TestRunner(t *testing.T) {
	r := NewRunner()
	r.unit = 10 * time.Millisecond
	var mu sync.Mutex
	calls := map[string]int{}
	var cur, peak atomic.Int32
	release := make(chan struct{})
	r.run = func(ctx context.Context, s proto.CheckSpec) proto.CheckResult {
		n := cur.Add(1)
		for {
			p := peak.Load()
			if n <= p || peak.CompareAndSwap(p, n) {
				break
			}
		}
		if strings.HasPrefix(s.ID, "slow") {
			select {
			case <-release:
			case <-ctx.Done():
			}
		}
		cur.Add(-1)
		mu.Lock()
		calls[s.ID]++
		mu.Unlock()
		return proto.CheckResult{ID: s.ID, OK: true, At: time.Now()}
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { r.Run(ctx); close(done) }()

	mk := func(id string, interval int) proto.CheckSpec {
		s := spec(proto.CheckTCP, "127.0.0.1:1")
		s.ID, s.IntervalS = id, interval
		return s
	}
	var specs []proto.CheckSpec
	for i := 0; i < 20; i++ {
		specs = append(specs, mk(fmt.Sprintf("slow%02d", i), 30))
	}
	bad := mk("bad", 5)
	specs = append(specs, bad)
	if errs := r.SetSpecs(specs); len(errs) != 1 {
		t.Fatalf("errors %v", errs)
	}
	waitFor(t, func() bool { return cur.Load() == DefaultConcurrency })
	time.Sleep(50 * time.Millisecond)
	if p := peak.Load(); p != DefaultConcurrency {
		t.Fatalf("peak concurrency %d", p)
	}
	close(release)
	waitFor(t, func() bool { return len(r.Results()) == 21 })
	res := r.Results()
	if res[0].ID != "bad" || res[0].OK || !strings.Contains(res[0].Error, "interval") {
		t.Fatalf("invalid spec result: %+v", res[0])
	}

	// Replace the set: one kept, one new, the rest dropped.
	r.SetSpecs([]proto.CheckSpec{mk("slow00", 30), mk("fast", 30)})
	waitFor(t, func() bool {
		rs := r.Results()
		return len(rs) == 2 && rs[0].ID == "fast" && rs[1].ID == "slow00"
	})
	// fast runs again after its interval (300 ms here).
	waitFor(t, func() bool { mu.Lock(); defer mu.Unlock(); return calls["fast"] >= 3 })
	mu.Lock()
	if calls["slow05"] > 2 {
		t.Errorf("removed check kept running: %d", calls["slow05"])
	}
	mu.Unlock()
	if n := len(r.SetSpecs(make([]proto.CheckSpec, MaxChecks+1))); n == 0 {
		t.Fatal("over the limit accepted silently")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("runner did not stop")
	}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not reached")
		}
		time.Sleep(5 * time.Millisecond)
	}
}
