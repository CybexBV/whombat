// Package checks runs availability checks (HTTP, TCP, ICMP ping, DNS). The
// agent runs the checks the hub assigns to it (proto.MsgChecks) and reports
// the latest result of each in Report.Checks; the hub can use the same code
// for checks it runs itself.
package checks

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"

	"rackoon/internal/proto"
)

// Limits of a check spec.
const (
	MinInterval = 30
	MaxInterval = 3600
	MinTimeout  = 1
	MaxTimeout  = 60

	maxTarget    = 2048
	maxKeyword   = 256
	maxBody      = 1 << 20 // bytes of the body searched for Keyword
	maxRedirects = 5
	maxAnswers   = 8
	userAgent    = "Whombat-Check/1"
)

// DefaultExpectStatus is the accepted HTTP status range when none is set.
const DefaultExpectStatus = "200-399"

// Validate checks a spec's kind, limits and target syntax.
func Validate(s proto.CheckSpec) error {
	if s.ID == "" || len(s.ID) > 64 {
		return errors.New("id must be 1 to 64 characters")
	}
	if s.IntervalS < MinInterval || s.IntervalS > MaxInterval {
		return fmt.Errorf("interval must be %d to %d s", MinInterval, MaxInterval)
	}
	if s.TimeoutS < MinTimeout || s.TimeoutS > MaxTimeout {
		return fmt.Errorf("timeout must be %d to %d s", MinTimeout, MaxTimeout)
	}
	if s.Target == "" || len(s.Target) > maxTarget || strings.ContainsAny(s.Target, " \t\r\n") {
		return errors.New("target is empty, too long or contains spaces")
	}
	switch s.Kind {
	case proto.CheckHTTP:
		u, err := url.Parse(s.Target)
		if err != nil {
			return fmt.Errorf("target: %w", err)
		}
		if (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.Hostname() == "" {
			return errors.New("target must be an http:// or https:// URL")
		}
		if _, err := parseStatusRanges(s.ExpectStatus); err != nil {
			return err
		}
		if len(s.Keyword) > maxKeyword {
			return fmt.Errorf("keyword longer than %d bytes", maxKeyword)
		}
	case proto.CheckTCP:
		if _, _, err := splitHostPort(s.Target); err != nil {
			return err
		}
	case proto.CheckPing:
		if !validHost(s.Target) {
			return errors.New("target must be a host name or IP address")
		}
	case proto.CheckDNS:
		if !validHost(strings.TrimSuffix(s.Target, ".")) {
			return errors.New("target must be a DNS name")
		}
		switch strings.ToUpper(s.DNSType) {
		case "", "A", "AAAA", "CNAME", "MX", "TXT":
		default:
			return errors.New("dns_type must be A, AAAA, CNAME, MX or TXT")
		}
		if s.DNSServer != "" {
			if _, err := dnsServerAddr(s.DNSServer); err != nil {
				return err
			}
		}
		if len(s.Expect) > maxKeyword {
			return fmt.Errorf("expect longer than %d bytes", maxKeyword)
		}
	default:
		return fmt.Errorf("unknown kind %q", s.Kind)
	}
	return nil
}

// validHost accepts an IP address or a DNS name (letters, digits, '-',
// '_' and '.', labels of at most 63 characters).
func validHost(h string) bool {
	if h == "" || len(h) > 253 {
		return false
	}
	if net.ParseIP(h) != nil {
		return true
	}
	for _, label := range strings.Split(h, ".") {
		if label == "" || len(label) > 63 || strings.HasPrefix(label, "-") {
			return false
		}
		for _, c := range label {
			if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
				return false
			}
		}
	}
	return true
}

func splitHostPort(target string) (string, int, error) {
	host, port, err := net.SplitHostPort(target)
	if err != nil {
		return "", 0, errors.New("target must be host:port")
	}
	p, err := strconv.Atoi(port)
	if err != nil || p < 1 || p > 65535 {
		return "", 0, errors.New("port must be 1 to 65535")
	}
	if !validHost(host) {
		return "", 0, errors.New("target must be host:port")
	}
	return host, p, nil
}

// dnsServerAddr normalizes "host[:port]" (port 53 by default).
func dnsServerAddr(s string) (string, error) {
	if _, _, err := splitHostPort(s); err == nil {
		return s, nil
	}
	if validHost(strings.Trim(s, "[]")) {
		return net.JoinHostPort(strings.Trim(s, "[]"), "53"), nil
	}
	return "", errors.New("dns_server must be host or host:port")
}

type statusRange struct{ lo, hi int }

// parseStatusRanges parses "200-299,301" (default DefaultExpectStatus).
func parseStatusRanges(s string) ([]statusRange, error) {
	if strings.TrimSpace(s) == "" {
		s = DefaultExpectStatus
	}
	var out []statusRange
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		lo, hi, isRange := strings.Cut(part, "-")
		a, err1 := strconv.Atoi(strings.TrimSpace(lo))
		b := a
		var err2 error
		if isRange {
			b, err2 = strconv.Atoi(strings.TrimSpace(hi))
		}
		if err1 != nil || err2 != nil || a < 100 || b > 599 || a > b {
			return nil, fmt.Errorf("invalid status range %q", part)
		}
		out = append(out, statusRange{a, b})
	}
	if len(out) > 16 {
		return nil, errors.New("too many status ranges")
	}
	return out, nil
}

func statusOK(ranges []statusRange, code int) bool {
	for _, r := range ranges {
		if code >= r.lo && code <= r.hi {
			return true
		}
	}
	return false
}

// Run runs one check. It never takes longer than the spec's timeout (plus a
// little bookkeeping); errors are reported in the result.
func Run(ctx context.Context, s proto.CheckSpec) proto.CheckResult {
	res := proto.CheckResult{ID: s.ID, At: time.Now().UTC()}
	if err := Validate(s); err != nil {
		res.Error = "invalid check: " + err.Error()
		return res
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(s.TimeoutS)*time.Second)
	defer cancel()
	start := time.Now()
	var err error
	switch s.Kind {
	case proto.CheckHTTP:
		err = runHTTP(ctx, s, &res, start)
	case proto.CheckTCP:
		err = runTCP(ctx, s, &res, start)
	case proto.CheckPing:
		err = runPing(ctx, s, &res)
	case proto.CheckDNS:
		err = runDNS(ctx, s, &res, start)
	}
	if err != nil {
		res.OK = false
		res.Error = describe(ctx, err)
	} else {
		res.OK = true
	}
	return res
}

func ms(d time.Duration) *float64 {
	v := float64(d.Microseconds()) / 1000
	v = float64(int64(v*10+0.5)) / 10
	return &v
}

// describe shortens common network errors.
func describe(ctx context.Context, err error) string {
	switch {
	case errors.Is(err, context.DeadlineExceeded) || ctx.Err() == context.DeadlineExceeded:
		return "timeout"
	case errors.Is(err, syscall.ECONNREFUSED):
		return "connection refused"
	case errors.Is(err, syscall.EHOSTUNREACH):
		return "host unreachable"
	case errors.Is(err, syscall.ENETUNREACH):
		return "network unreachable"
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		if dnsErr.IsNotFound {
			return "name not found: " + dnsErr.Name
		}
		if dnsErr.IsTimeout {
			return "timeout"
		}
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return "timeout"
	}
	msg := err.Error()
	if len(msg) > 300 {
		msg = msg[:300]
	}
	return msg
}

// tlsConfig verifies like crypto/tls (unless insecure) and records the
// leaf certificate's expiry of every handshake in *notAfter, also when the
// verification fails. serverName may be an IP address: crypto/tls sends no
// SNI for it, and the verification checks the certificate's IP SANs.
func tlsConfig(serverName string, insecure bool, notAfter **time.Time) *tls.Config {
	return &tls.Config{
		ServerName:         serverName,
		MinVersion:         tls.VersionTLS10,
		InsecureSkipVerify: true, // verified below, after recording the expiry
		VerifyConnection: func(cs tls.ConnectionState) error {
			if len(cs.PeerCertificates) == 0 {
				return errors.New("no server certificate")
			}
			leaf := cs.PeerCertificates[0]
			t := leaf.NotAfter.UTC()
			*notAfter = &t
			if insecure {
				return nil
			}
			inter := x509.NewCertPool()
			for _, c := range cs.PeerCertificates[1:] {
				inter.AddCert(c)
			}
			_, err := leaf.Verify(x509.VerifyOptions{DNSName: cs.ServerName, Intermediates: inter, Roots: rootPool})
			return err
		},
	}
}

// rootPool is nil (system roots); tests replace it.
var rootPool *x509.CertPool

func runHTTP(ctx context.Context, s proto.CheckSpec, res *proto.CheckResult, start time.Time) error {
	ranges, _ := parseStatusRanges(s.ExpectStatus)
	var notAfter *time.Time
	tr := &http.Transport{
		Proxy:               nil, // checks measure the direct path
		DialContext:         (&net.Dialer{}).DialContext,
		TLSHandshakeTimeout: time.Duration(s.TimeoutS) * time.Second,
		DisableKeepAlives:   true,
	}
	tr.DialTLSContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, _, _ := net.SplitHostPort(addr)
		raw, err := (&net.Dialer{}).DialContext(ctx, network, addr)
		if err != nil {
			return nil, err
		}
		notAfter = nil // the expiry of the last hop is reported
		tc := tls.Client(raw, tlsConfig(host, s.InsecureTLS, &notAfter))
		if err := tc.HandshakeContext(ctx); err != nil {
			raw.Close()
			return nil, fmt.Errorf("TLS: %w", err)
		}
		return tc, nil
	}
	defer tr.CloseIdleConnections()
	client := &http.Client{
		Transport: tr,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) > maxRedirects {
				return fmt.Errorf("more than %d redirects", maxRedirects)
			}
			return nil
		},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.Target, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "*/*")
	resp, err := client.Do(req)
	res.CertNotAfter = notAfter
	if err != nil {
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err
		}
		return err
	}
	defer resp.Body.Close()
	res.LatencyMs = ms(time.Since(start))
	res.StatusCode = resp.StatusCode
	if resp.TLS != nil && len(resp.TLS.PeerCertificates) > 0 {
		t := resp.TLS.PeerCertificates[0].NotAfter.UTC()
		res.CertNotAfter = &t
	} else if resp.Request != nil && resp.Request.URL.Scheme == "http" {
		res.CertNotAfter = nil // the final hop is plain HTTP
	}
	if !statusOK(ranges, resp.StatusCode) {
		return fmt.Errorf("status %d", resp.StatusCode)
	}
	if s.Keyword != "" {
		found, err := containsKeyword(resp.Body, []byte(s.Keyword))
		if err != nil {
			return fmt.Errorf("reading the body: %w", err)
		}
		if !found {
			return errors.New("keyword not found")
		}
	}
	return nil
}

// containsKeyword searches the first maxBody bytes of r.
func containsKeyword(r io.Reader, kw []byte) (bool, error) {
	br := bufio.NewReaderSize(io.LimitReader(r, maxBody), 64<<10)
	var tail []byte
	buf := make([]byte, 64<<10)
	for {
		n, err := br.Read(buf)
		if n > 0 {
			chunk := append(tail, buf[:n]...)
			if bytes.Contains(chunk, kw) {
				return true, nil
			}
			if keep := len(kw) - 1; keep > 0 && len(chunk) > keep {
				tail = append([]byte(nil), chunk[len(chunk)-keep:]...)
			} else {
				tail = append([]byte(nil), chunk...)
			}
		}
		if errors.Is(err, io.EOF) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
	}
}

func runTCP(ctx context.Context, s proto.CheckSpec, res *proto.CheckResult, start time.Time) error {
	host, _, err := splitHostPort(s.Target)
	if err != nil {
		return err
	}
	var d net.Dialer
	conn, err := d.DialContext(ctx, "tcp", s.Target)
	if err != nil {
		return err
	}
	defer conn.Close()
	res.LatencyMs = ms(time.Since(start))
	if !s.TLS {
		return nil
	}
	var notAfter *time.Time
	tc := tls.Client(conn, tlsConfig(host, s.InsecureTLS, &notAfter))
	err = tc.HandshakeContext(ctx)
	res.CertNotAfter = notAfter
	if err != nil {
		return fmt.Errorf("TLS: %w", err)
	}
	res.LatencyMs = ms(time.Since(start))
	return nil
}

func runDNS(ctx context.Context, s proto.CheckSpec, res *proto.CheckResult, start time.Time) error {
	r := &net.Resolver{PreferGo: true}
	if s.DNSServer != "" {
		addr, err := dnsServerAddr(s.DNSServer)
		if err != nil {
			return err
		}
		r.Dial = func(ctx context.Context, network, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, network, addr)
		}
	} else if _, err := os.Stat("/etc/resolv.conf"); err != nil {
		r.PreferGo = false
	}
	name := s.Target
	var answers []string
	var err error
	switch strings.ToUpper(s.DNSType) {
	case "", "A":
		var ips []net.IP
		ips, err = r.LookupIP(ctx, "ip4", name)
		for _, ip := range ips {
			answers = append(answers, ip.String())
		}
	case "AAAA":
		var ips []net.IP
		ips, err = r.LookupIP(ctx, "ip6", name)
		for _, ip := range ips {
			answers = append(answers, ip.String())
		}
	case "CNAME":
		var c string
		c, err = r.LookupCNAME(ctx, name)
		if c != "" {
			answers = append(answers, c)
		}
	case "MX":
		var mxs []*net.MX
		mxs, err = r.LookupMX(ctx, name)
		for _, mx := range mxs {
			answers = append(answers, strconv.Itoa(int(mx.Pref))+" "+mx.Host)
		}
	case "TXT":
		answers, err = r.LookupTXT(ctx, name)
	}
	if err != nil {
		return err
	}
	res.LatencyMs = ms(time.Since(start))
	for i, a := range answers {
		if len(a) > 255 {
			answers[i] = a[:255]
		}
	}
	matched := s.Expect == ""
	for _, a := range answers {
		if !matched && strings.Contains(strings.ToLower(a), strings.ToLower(s.Expect)) {
			matched = true
		}
	}
	if len(answers) > maxAnswers {
		answers = answers[:maxAnswers]
	}
	res.Answer = answers
	if len(answers) == 0 {
		return errors.New("no records")
	}
	if !matched {
		return fmt.Errorf("no record contains %q", s.Expect)
	}
	return nil
}
