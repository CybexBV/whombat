package hub

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"rackoon/internal/hub/store"
)

// apiError is an error rendered as application/problem+json.
type apiError struct {
	Status int
	Code   string
	Title  string
	Detail string
	Header http.Header
	// Fields: form field -> message, written as "field_errors" (manage
	// requests that failed validation).
	Fields map[string]string
	// Extra: more members of the problem (a refusal's "reason").
	Extra map[string]any
}

func (e *apiError) Error() string { return e.Code + ": " + e.Detail }

func apiErr(status int, code, detail string) *apiError {
	return &apiError{Status: status, Code: code, Title: http.StatusText(status), Detail: detail}
}

var (
	errUnauthenticated = apiErr(http.StatusUnauthorized, "unauthenticated", "Sign in to continue.")
	errForbidden       = apiErr(http.StatusForbidden, "forbidden", "Your role does not allow this.")
	errCSRF            = apiErr(http.StatusForbidden, "csrf", "Missing or invalid CSRF token.")
	errNotFound        = apiErr(http.StatusNotFound, "not_found", "Not found.")
	errKioskReadOnly   = apiErr(http.StatusForbidden, "kiosk_read_only", "This is a read-only kiosk session.")
	errPasswordChange  = apiErr(http.StatusForbidden, "password_change_required", "Choose a new password first.")
)

func writeProblem(w http.ResponseWriter, e *apiError) {
	for k, v := range e.Header {
		w.Header()[k] = v
	}
	w.Header().Set("Content-Type", "application/problem+json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(e.Status)
	body := map[string]any{
		"type": "https://rackoon.dev/problems/" + e.Code, "title": e.Title, "status": e.Status,
		"detail": e.Detail, "code": e.Code,
	}
	for k, v := range e.Extra {
		if _, taken := body[k]; !taken {
			body[k] = v
		}
	}
	if len(e.Fields) > 0 {
		body["field_errors"] = e.Fields
	}
	_ = json.NewEncoder(w).Encode(body)
}

// writeJSON writes a JSON body. GET responses get an ETag (honoring
// If-None-Match) and Cache-Control: private, no-cache (always revalidate, so
// guest state is never stale after an action; the ETag keeps it cheap).
func writeJSON(w http.ResponseWriter, r *http.Request, status int, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		writeProblem(w, apiErr(500, "internal", "Could not encode the response."))
		return
	}
	b = append(b, '\n')
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if r.Method == http.MethodGet && status == http.StatusOK {
		sum := sha256.Sum256(b)
		etag := `W/"` + hex.EncodeToString(sum[:12]) + `"`
		w.Header().Set("ETag", etag)
		w.Header().Set("Cache-Control", "private, no-cache")
		w.Header().Set("Vary", "Cookie")
		if match := r.Header.Get("If-None-Match"); match != "" {
			for _, m := range strings.Split(match, ",") {
				if m = strings.TrimSpace(m); m == etag || m == "*" || strings.TrimPrefix(m, "W/") == strings.TrimPrefix(etag, "W/") {
					w.WriteHeader(http.StatusNotModified)
					return
				}
			}
		}
	} else {
		w.Header().Set("Cache-Control", "no-store")
	}
	if len(b) >= gzipMinSize && acceptsGzip(r) {
		if z := gzipBytes(b); z != nil {
			w.Header().Set("Content-Encoding", "gzip")
			w.Header().Add("Vary", "Accept-Encoding")
			b = z
		}
	}
	w.WriteHeader(status)
	_, _ = w.Write(b)
}

// gzipMinSize is the smallest body worth compressing.
const gzipMinSize = 1024

func acceptsGzip(r *http.Request) bool {
	for _, part := range strings.Split(r.Header.Get("Accept-Encoding"), ",") {
		enc, q, _ := strings.Cut(strings.TrimSpace(part), ";")
		if strings.EqualFold(strings.TrimSpace(enc), "gzip") && strings.TrimSpace(q) != "q=0" {
			return true
		}
	}
	return false
}

var gzipPool = sync.Pool{New: func() any { w, _ := gzip.NewWriterLevel(io.Discard, gzip.BestSpeed); return w }}

// gzipBytes compresses b (nil on failure).
func gzipBytes(b []byte) []byte {
	var buf bytes.Buffer
	zw := gzipPool.Get().(*gzip.Writer)
	defer gzipPool.Put(zw)
	zw.Reset(&buf)
	if _, err := zw.Write(b); err != nil {
		return nil
	}
	if err := zw.Close(); err != nil {
		return nil
	}
	return buf.Bytes()
}

func decodeJSON(r *http.Request, v any) error {
	if r.Body == nil {
		return apiErr(400, "bad_request", "A JSON body is required.")
	}
	dec := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		if errors.Is(err, io.EOF) {
			return apiErr(400, "bad_request", "A JSON body is required.")
		}
		return apiErr(400, "bad_request", "Invalid JSON body: "+err.Error())
	}
	return nil
}

// remoteIP is the peer address.
func remoteIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// trustedProxyFn is the hub's --trusted-proxies check (set by New; atomic
// because tests start several hubs in one process).
var trustedProxyFn atomic.Pointer[func(net.IP) bool]

// trustedProxies reports whether ip may set X-Forwarded-* (default:
// loopback only).
func trustedProxies(ip net.IP) bool {
	if f := trustedProxyFn.Load(); f != nil {
		return (*f)(ip)
	}
	return ip.IsLoopback()
}

// clientIP is the browser's address. X-Forwarded-For is believed only from
// a trusted proxy (--trusted-proxies, default loopback such as `tailscale
// serve`); the right-most address that is not itself a trusted proxy is the
// client (a client cannot forge its way past the proxy chain).
func clientIP(r *http.Request) string {
	ip := remoteIP(r)
	p := net.ParseIP(ip)
	if p == nil || !trustedProxies(p) {
		return ip
	}
	xff := r.Header.Values("X-Forwarded-For")
	var hops []string
	for _, v := range xff {
		for _, a := range strings.Split(v, ",") {
			if a = strings.TrimSpace(a); a != "" {
				hops = append(hops, a)
			}
		}
	}
	for i := len(hops) - 1; i >= 0; i-- {
		hp := net.ParseIP(hops[i])
		if hp == nil {
			break
		}
		if !trustedProxies(hp) || i == 0 {
			return hp.String()
		}
	}
	return ip
}

// forwardedHTTPS reports whether a trusted proxy says the browser used HTTPS.
func forwardedHTTPS(r *http.Request) bool {
	p := net.ParseIP(remoteIP(r))
	return p != nil && trustedProxies(p) && strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

// unixConnKey marks the context of connections on a Unix socket listener.
type unixConnKey struct{}

// overUnixSocket reports whether the request came over the Unix socket
// (this machine; the Whombat server, which serves its browsers over HTTPS).
func overUnixSocket(r *http.Request) bool { return r.Context().Value(unixConnKey{}) != nil }

// requestOrigin is the scheme://host the request was made to.
func (h *Hub) requestOrigin(r *http.Request) string {
	if h.cfg.PublicURL != "" {
		return h.cfg.PublicURL
	}
	scheme := "http"
	if r.TLS != nil || forwardedHTTPS(r) {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}

// secureTransport reports whether the browser reaches the hub over HTTPS
// (directly, through a trusted TLS proxy, or a public URL that is https),
// or from this machine (localhost development).
func (h *Hub) secureTransport(r *http.Request) bool {
	if r.TLS != nil || forwardedHTTPS(r) || strings.HasPrefix(h.cfg.PublicURL, "https://") || overUnixSocket(r) {
		return true
	}
	host := r.Host
	if hh, _, err := net.SplitHostPort(host); err == nil {
		host = hh
	}
	if host == "localhost" {
		return true
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		return true
	}
	return false
}

// originAllowed checks a browser Origin: the public URL, an allowed origin,
// or the same host the request was sent to.
func (h *Hub) originAllowed(r *http.Request, origin string) bool {
	if origin == "" {
		return false
	}
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return false
	}
	o := strings.ToLower(u.Scheme + "://" + u.Host)
	if h.cfg.PublicURL != "" && o == strings.ToLower(h.cfg.PublicURL) {
		return true
	}
	for _, a := range h.cfg.AllowedOrigins {
		if o == strings.ToLower(a) {
			return true
		}
	}
	return strings.EqualFold(u.Host, r.Host)
}

// securityHeaders sets the headers every UI/API response carries.
func (h *Hub) securityHeaders(next http.Handler) http.Handler {
	csp := h.csp()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hd := w.Header()
		hd.Set("Content-Security-Policy", csp)
		hd.Set("X-Frame-Options", "DENY")
		hd.Set("X-Content-Type-Options", "nosniff")
		hd.Set("Referrer-Policy", "no-referrer")
		hd.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=(self), clipboard-write=(self), fullscreen=(self), publickey-credentials-get=(self), publickey-credentials-create=(self)")
		hd.Set("Cross-Origin-Opener-Policy", "same-origin")
		hd.Set("Cross-Origin-Resource-Policy", "same-origin")
		if r.TLS != nil || strings.HasPrefix(h.cfg.PublicURL, "https://") {
			hd.Set("Strict-Transport-Security", "max-age=31536000")
		}
		next.ServeHTTP(w, r)
	})
}

// csp is the Content-Security-Policy for the Vite SPA: scripts and styles
// from the hub only (inline style attributes allowed for the charts),
// images also from blob: (thumbnails) and data:, WebSockets to the hub.
func (h *Hub) csp() string {
	connect := "'self'"
	if h.cfg.PublicURL != "" {
		if u, err := url.Parse(h.cfg.PublicURL); err == nil {
			if u.Scheme == "https" {
				connect += " wss://" + u.Host
			} else {
				connect += " ws://" + u.Host + " wss://" + u.Host
			}
		}
	}
	return strings.Join([]string{
		"default-src 'self'",
		"script-src 'self'",
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' blob: data:",
		"font-src 'self' data:",
		"connect-src " + connect,
		"worker-src 'self' blob:",
		"media-src 'self' blob:",
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'self'",
		"frame-ancestors 'none'",
		"manifest-src 'self'",
	}, "; ")
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	if s.status == 0 {
		s.status = code
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	if s.status == 0 {
		s.status = 200
	}
	return s.ResponseWriter.Write(b)
}

func (s *statusRecorder) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (s *statusRecorder) Unwrap() http.ResponseWriter { return s.ResponseWriter }

// logRequests logs method, path (never the query), status and duration.
func (h *Hub) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w}
		next.ServeHTTP(rec, r)
		if r.URL.Path == "/api/v1/events" && rec.status == 200 {
			return
		}
		lvl := h.log.Debug
		if rec.status >= 500 {
			lvl = h.log.Warn
		} else if strings.HasPrefix(r.URL.Path, "/api/") && r.Method != http.MethodGet {
			lvl = h.log.Info
		}
		lvl("http", "method", r.Method, "path", r.URL.Path, "status", rec.status,
			"ms", time.Since(start).Milliseconds(), "client_ip", clientIP(r))
	})
}

// principal is the authenticated user of a request: a browser session, an
// API token (token set, session empty) or the Whombat server's service
// token (service set: the person it acts for, no user row; tokenHsh is the
// service token's hash).
type principal struct {
	user     store.User
	session  store.Session
	tokenHsh []byte
	token    *store.APIToken
	service  *serviceActor
}

// bearer reports whether the request authenticated with a bearer token
// (an API token or the service token): no cookies, so no CSRF.
func (p *principal) bearer() bool { return p != nil && (p.token != nil || p.service != nil) }

// key is the principal's key for per-person limits: the service actor's
// id, else the user name.
func (p *principal) key() string {
	if p.service != nil {
		return "actor:" + p.service.id
	}
	return p.user.Username
}

func (p *principal) rank() int {
	if p == nil {
		return -1
	}
	return store.RoleRank(p.user.Role)
}

type handlerFunc func(w http.ResponseWriter, r *http.Request, p *principal) error

// route wraps a handler with authentication, CSRF and a minimum role
// ("" = anonymous allowed).
func (h *Hub) route(minRole string, f handlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, perr := h.authenticateService(r)
		if perr != nil {
			writeProblem(w, perr)
			return
		}
		switch {
		case p != nil:
			applyClientIP(r)
		case !h.cfg.Headless: // headless: the service token is the only credential
			if p = h.authenticateToken(r); p == nil {
				p = h.authenticate(w, r)
			}
		}
		unsafe := r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions
		// The Origin check protects browser cookies; the Whombat server
		// checks its own browsers' origins before it proxies.
		if unsafe && (p == nil || p.service == nil) {
			if o := r.Header.Get("Origin"); o != "" && !h.originAllowed(r, o) {
				writeProblem(w, apiErr(http.StatusForbidden, "bad_origin", "Cross-origin request refused."))
				return
			}
		}
		if minRole != "" && p == nil {
			writeProblem(w, errUnauthenticated)
			return
		}
		// Bearer tokens carry no cookies, so CSRF does not apply to them.
		if unsafe && !p.bearer() && !h.checkCSRF(r, p) {
			writeProblem(w, errCSRF)
			return
		}
		// Browser sessions: kiosk sessions change nothing, and a temporary
		// password must be replaced before anything else. The auth
		// endpoints check these themselves (sign out, the password change).
		if p != nil && !p.bearer() && !strings.HasPrefix(r.URL.Path, "/api/v1/auth/") {
			if p.session.Kiosk && unsafe {
				writeProblem(w, errKioskReadOnly)
				return
			}
			if !p.session.Kiosk && p.user.MustChangePassword {
				writeProblem(w, errPasswordChange)
				return
			}
		}
		if minRole != "" && p.rank() < store.RoleRank(minRole) {
			writeProblem(w, errForbidden)
			return
		}
		if err := f(w, r, p); err != nil {
			var ae *apiError
			if !errors.As(err, &ae) && r.Context().Err() != nil {
				// The client went away (navigation, aborted fetch): nothing to report.
				h.log.Debug("api: request cancelled", "path", r.URL.Path)
				return
			}
			if !errors.As(err, &ae) {
				h.log.Error("api", "path", r.URL.Path, "err", err)
				ae = apiErr(http.StatusInternalServerError, "internal", "Internal error.")
			}
			writeProblem(w, ae)
		}
	})
}

// ---- rate limiting --------------------------------------------------------------

// window is a fixed-window counter per key.
type window struct {
	mu    sync.Mutex
	limit int
	per   time.Duration
	m     map[string]*wcount
}

type wcount struct {
	n     int
	start time.Time
}

func newWindow(limit int, per time.Duration) *window {
	return &window{limit: limit, per: per, m: map[string]*wcount{}}
}

// allow reports whether key is under its limit (without counting).
func (w *window) allow(key string) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	c := w.m[key]
	return c == nil || time.Since(c.start) >= w.per || c.n < w.limit
}

// fail counts one event for key.
func (w *window) fail(key string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	c := w.m[key]
	if c == nil || time.Since(c.start) >= w.per {
		c = &wcount{start: time.Now()}
		w.m[key] = c
	}
	c.n++
}

// take counts and checks in one step.
func (w *window) take(key string) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	c := w.m[key]
	if c == nil || time.Since(c.start) >= w.per {
		c = &wcount{start: time.Now()}
		w.m[key] = c
	}
	c.n++
	return c.n <= w.limit
}

// refund gives back one counted event for key.
func (w *window) refund(key string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if c := w.m[key]; c != nil && c.n > 0 {
		c.n--
	}
}

type keyCount struct {
	key string
	n   int
}

// over lists the keys with at least n events in their current window.
func (w *window) over(n int) []keyCount {
	w.mu.Lock()
	defer w.mu.Unlock()
	var out []keyCount
	for k, c := range w.m {
		if time.Since(c.start) < w.per && c.n >= n {
			out = append(out, keyCount{k, c.n})
		}
	}
	return out
}

func (w *window) prune() {
	w.mu.Lock()
	defer w.mu.Unlock()
	for k, c := range w.m {
		if time.Since(c.start) >= w.per {
			delete(w.m, k)
		}
	}
}

type limiters struct {
	login        *window // failed logins per IP
	loginUser    *window // failed logins per user name
	passkeyBegin *window // anonymous passkey ceremonies per IP
	pings        *window // heartbeat pings per IP
	enroll       *window // invalid enrollment tokens per IP
	denied       *window // denied console/action requests per user
	thumbs       *window // thumbnail requests per user
	auditThr     *window // throttles repeated denial audit records
	screens      *window // screens.viewed once per user/server per 10 min
}

func newLimiters() *limiters {
	return &limiters{
		login:        newWindow(10, 5*time.Minute),
		loginUser:    newWindow(20, 15*time.Minute),
		passkeyBegin: newWindow(30, 5*time.Minute),
		pings:        newWindow(120, time.Minute),
		enroll:       newWindow(20, 5*time.Minute),
		denied:       newWindow(30, 10*time.Minute),
		thumbs:       newWindow(240, time.Minute),
		auditThr:     newWindow(1, 10*time.Minute),
		screens:      newWindow(1, 10*time.Minute),
	}
}

func (l *limiters) prune() {
	for _, w := range []*window{l.login, l.loginUser, l.passkeyBegin, l.pings, l.enroll, l.denied, l.thumbs, l.auditThr, l.screens} {
		w.prune()
	}
}

func rateLimited(retry time.Duration) *apiError {
	e := apiErr(http.StatusTooManyRequests, "rate_limited", "Too many requests. Try again later.")
	e.Header = http.Header{"Retry-After": []string{fmt.Sprint(int(retry.Seconds()))}}
	return e
}
