// Package web is what the graphical console's server (whombat-console --serve, CG-03/CG-06) and the installer's
// server (whombat-installer-ui, CG-11) share: a per-start API token handed to the kiosk through a file only the
// kiosk's group can read (NX-78), the static UI files, and a small, strict HTTP front: loopback only, the
// expected Host only, GET/HEAD for files, the API's own methods behind `Authorization: Bearer <token>`, bounded
// bodies and tight timeouts, `Cache-Control: no-store` everywhere.
package web

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// NewToken is 32 random bytes, base64url without padding (43 visible ASCII characters: a valid header value, and
// what the page accepts from the URL fragment, console/ui src/lib/token.ts).
func NewToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// WriteTokenFile replaces path with the token, mode 0640 whatever the umask: a new file next to it (never
// following a link, never reusing one), synced, then renamed over the old one. The directory decides who reads it:
// the appliance's and the installer's are setgid to the kiosk's group (NX-78).
func WriteTokenFile(path, token string) error {
	tmp := filepath.Join(filepath.Dir(path), "."+filepath.Base(path)+".tmp")
	_ = os.Remove(tmp)
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0o600)
	if err != nil {
		return err
	}
	if err = f.Chmod(0o640); err == nil {
		if _, err = f.WriteString(token + "\n"); err == nil {
			err = f.Sync()
		}
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, path)
}

// Options configure a Handler.
type Options struct {
	Port    int          // the port the page is served on: only Host 127.0.0.1:<port> and localhost:<port> are answered
	Token   string       // the API token (required)
	UI      fs.FS        // the static UI files (index.html at the root)
	API     http.Handler // serves /api/…; sees only requests that carried the token
	MaxBody int64        // request body limit for the API
	// Limits are the API paths with another body limit than MaxBody (the desk's recordings, NX-160).
	Limits map[string]int64
}

// Content-Security-Policy of every response: the page loads only its own files and talks only to its own server. Media
// only from itself or a blob it made (the desk's spoken answers, fetched with the token, NX-160).
const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
	"media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; " +
	"form-action 'none'; frame-ancestors 'none'"

// Handler is the whole HTTP front.
func Handler(o Options) http.Handler {
	if o.Token == "" {
		panic("web: no token")
	}
	if o.MaxBody <= 0 {
		o.MaxBody = 1024
	}
	hosts := map[string]bool{fmt.Sprintf("127.0.0.1:%d", o.Port): true, fmt.Sprintf("localhost:%d", o.Port): true}
	want := []byte("Bearer " + o.Token)
	static := staticHandler(o.UI)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Cache-Control", "no-store")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		h.Set("Content-Security-Policy", csp)
		// Only the page's own origin: anything else (a rebound name, a crafted Host) is not this server.
		if !hosts[r.Host] {
			Error(w, http.StatusForbidden, "forbidden")
			return
		}
		if r.URL.Path == "/api" || strings.HasPrefix(r.URL.Path, "/api/") {
			if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), want) != 1 {
				Error(w, http.StatusForbidden, "forbidden")
				return
			}
			if r.Body != nil {
				limit := o.MaxBody
				if l, ok := o.Limits[r.URL.Path]; ok {
					limit = l
				}
				r.Body = http.MaxBytesReader(w, r.Body, limit)
			}
			o.API.ServeHTTP(w, r)
			return
		}
		static.ServeHTTP(w, r)
	})
}

// staticHandler serves the UI files: GET and HEAD only, no directory listings, no dot files, nothing outside the
// directory (os.DirFS refuses `..` and absolute names; the path is checked before it gets there as well). A path
// without an extension that names no file is the page itself (index.html), so a reload on any route works.
func staticHandler(ui fs.FS) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			Error(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		p := r.URL.Path
		if !strings.HasPrefix(p, "/") || strings.ContainsAny(p, "\\\x00") {
			Error(w, http.StatusNotFound, "not found")
			return
		}
		for _, seg := range strings.Split(p[1:], "/") {
			if seg == ".." || (strings.HasPrefix(seg, ".") && seg != "") {
				Error(w, http.StatusNotFound, "not found")
				return
			}
		}
		name := strings.TrimPrefix(path.Clean(p), "/")
		if name == "" {
			name = "index.html"
		}
		if !serveFile(w, r, ui, name) {
			if path.Ext(name) == "" && serveFile(w, r, ui, "index.html") {
				return
			}
			Error(w, http.StatusNotFound, "not found")
		}
	})
}

func serveFile(w http.ResponseWriter, r *http.Request, ui fs.FS, name string) bool {
	if !fs.ValidPath(name) {
		return false
	}
	f, err := ui.Open(name)
	if err != nil {
		return false
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() {
		return false
	}
	rs, ok := f.(interface {
		Read([]byte) (int, error)
		Seek(int64, int) (int64, error)
	})
	if !ok {
		return false
	}
	// The store's timestamps are all 1970: no Last-Modified, no conditional requests (no-store anyway).
	http.ServeContent(w, r, name, time.Time{}, rs)
	return true
}

// JSON writes v with status.
func JSON(w http.ResponseWriter, status int, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		status, b = http.StatusInternalServerError, []byte(`{"message":"internal"}`)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(append(b, '\n'))
}

// Error writes {"message": msg} with status.
func Error(w http.ResponseWriter, status int, msg string) {
	JSON(w, status, map[string]string{"message": msg})
}

// Method answers 405 unless r uses method; true when it does.
func Method(w http.ResponseWriter, r *http.Request, method string) bool {
	if r.Method == method || (method == http.MethodGet && r.Method == http.MethodHead) {
		return true
	}
	allow := method
	if method == http.MethodGet {
		allow = "GET, HEAD"
	}
	w.Header().Set("Allow", allow)
	Error(w, http.StatusMethodNotAllowed, "method not allowed")
	return false
}

// DecodeJSON reads a small JSON body into v: application/json only (a cross-origin form can't send it without a
// preflight), one value, nothing after it.
func DecodeJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	ct := r.Header.Get("Content-Type")
	if mt, _, _ := strings.Cut(ct, ";"); strings.TrimSpace(strings.ToLower(mt)) != "application/json" {
		Error(w, http.StatusUnsupportedMediaType, "application/json only")
		return false
	}
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(v); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			Error(w, http.StatusRequestEntityTooLarge, "too large")
			return false
		}
		Error(w, http.StatusBadRequest, "invalid json")
		return false
	}
	if dec.More() {
		Error(w, http.StatusBadRequest, "invalid json")
		return false
	}
	return true
}

// Listen opens addr, which must be a loopback address with an explicit port (the servers are never reachable from
// another machine; on the appliance the loopback itself is a private one, shared with the kiosk only).
func Listen(addr string) (net.Listener, int, error) {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, 0, err
	}
	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		return nil, 0, fmt.Errorf("%s: only a loopback address is served", addr)
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, 0, err
	}
	return ln, ln.Addr().(*net.TCPAddr).Port, nil
}

// Serve serves h on ln until ctx ends.
func Serve(ctx context.Context, ln net.Listener, h http.Handler) error {
	srv := &http.Server{
		Handler:           h,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    8 << 10,
		ErrorLog:          nil,
	}
	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(ln) }()
	select {
	case <-ctx.Done():
		sctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
		return nil
	case err := <-errc:
		return err
	}
}

// Notify sends a state to systemd (sd_notify) when the unit is Type=notify; without NOTIFY_SOCKET it does nothing.
func Notify(state string) error {
	sock := os.Getenv("NOTIFY_SOCKET")
	if sock == "" {
		return nil
	}
	if strings.HasPrefix(sock, "@") {
		sock = "\x00" + sock[1:]
	}
	c, err := net.DialUnix("unixgram", nil, &net.UnixAddr{Name: sock, Net: "unixgram"})
	if err != nil {
		return err
	}
	defer c.Close()
	_, err = c.Write([]byte(state))
	return err
}
