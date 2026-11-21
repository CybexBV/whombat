package web

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"testing/fstest"
)

func TestToken(t *testing.T) {
	seen := map[string]bool{}
	for range 64 {
		tok, err := NewToken()
		if err != nil {
			t.Fatal(err)
		}
		// What the page accepts from the fragment (console/ui src/lib/token.ts) and a header can carry.
		if !regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`).MatchString(tok) {
			t.Fatalf("token %q", tok)
		}
		if seen[tok] {
			t.Fatal("token repeated")
		}
		seen[tok] = true
	}
}

func TestWriteTokenFile(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "token")
	// A link planted at the temporary name is removed, never followed.
	victim := filepath.Join(dir, "victim")
	_ = os.WriteFile(victim, []byte("keep"), 0o600)
	_ = os.Symlink(victim, filepath.Join(dir, ".token.tmp"))
	old := syscallUmask(0o077)
	defer syscallUmask(old)
	if err := WriteTokenFile(p, "abc"); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(p)
	st, _ := os.Stat(p)
	if string(b) != "abc\n" || st.Mode().Perm() != 0o640 {
		t.Fatalf("%q %v", b, st.Mode())
	}
	if v, _ := os.ReadFile(victim); string(v) != "keep" {
		t.Fatal("followed the link")
	}
	if err := WriteTokenFile(p, "def"); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(p); string(b) != "def\n" {
		t.Fatalf("%q", b)
	}
}

func testHandler(t *testing.T) http.Handler {
	t.Helper()
	ui := fstest.MapFS{
		"index.html":       {Data: []byte("<!doctype html>page")},
		"assets/app.js":    {Data: []byte("js")},
		".hidden":          {Data: []byte("dot")},
		"assets/.map":      {Data: []byte("dot")},
		"assets/sub/x.css": {Data: []byte("css")},
	}
	api := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if (r.URL.Path == "/api/echo" || r.URL.Path == "/api/big") && r.Method == http.MethodPost {
			var v map[string]any
			if !DecodeJSON(w, r, &v) {
				return
			}
			JSON(w, 200, v)
			return
		}
		JSON(w, 200, map[string]string{"path": r.URL.Path})
	})
	return Handler(Options{Port: 8411, Token: "tok-123456789", UI: ui, API: api, MaxBody: 64,
		Limits: map[string]int64{"/api/big": 256}})
}

func do(h http.Handler, method, target string, hdr map[string]string, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, target, strings.NewReader(body))
	r.Host = "127.0.0.1:8411"
	for k, v := range hdr {
		if k == "Host" {
			r.Host = v
			continue
		}
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

var auth = map[string]string{"Authorization": "Bearer tok-123456789"}

func TestAPIToken(t *testing.T) {
	h := testHandler(t)
	for name, hdr := range map[string]map[string]string{
		"none":        nil,
		"wrong":       {"Authorization": "Bearer tok-123456780"},
		"prefix":      {"Authorization": "Bearer tok-12345678"},
		"no scheme":   {"Authorization": "tok-123456789"},
		"basic":       {"Authorization": "Basic tok-123456789"},
		"query token": nil,
	} {
		target := "/api/state"
		if name == "query token" {
			target += "?t=tok-123456789"
		}
		if w := do(h, "GET", target, hdr, ""); w.Code != http.StatusForbidden {
			t.Errorf("%s: %d", name, w.Code)
		}
	}
	w := do(h, "GET", "/api/state", auth, "")
	if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("%d %v", w.Code, w.Header())
	}
	// The Host must be the page's own origin (no DNS rebinding, no other port), even with the token.
	for _, host := range []string{"evil.example:8411", "127.0.0.1:8412", "127.0.0.1", "[::1]:8411", ""} {
		hdr := map[string]string{"Authorization": auth["Authorization"], "Host": host}
		if w := do(h, "GET", "/api/state", hdr, ""); w.Code != http.StatusForbidden {
			t.Errorf("host %q: %d", host, w.Code)
		}
	}
	if w := do(h, "GET", "/", map[string]string{"Host": "localhost:8411"}, ""); w.Code != 200 {
		t.Errorf("localhost: %d", w.Code)
	}
}

func TestAPIBody(t *testing.T) {
	h := testHandler(t)
	json := map[string]string{"Authorization": auth["Authorization"], "Content-Type": "application/json"}
	if w := do(h, "POST", "/api/echo", json, `{"a":1}`); w.Code != 200 || !strings.Contains(w.Body.String(), `"a":1`) {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if w := do(h, "POST", "/api/echo", json, `{"a":"`+strings.Repeat("x", 100)+`"}`); w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("large body: %d", w.Code)
	}
	if w := do(h, "POST", "/api/echo", json, `{"a":1} {"b":2}`); w.Code != http.StatusBadRequest {
		t.Errorf("two values: %d", w.Code)
	}
	if w := do(h, "POST", "/api/echo", json, `{`); w.Code != http.StatusBadRequest {
		t.Errorf("broken json: %d", w.Code)
	}
	form := map[string]string{"Authorization": auth["Authorization"], "Content-Type": "application/x-www-form-urlencoded"}
	if w := do(h, "POST", "/api/echo", form, `a=1`); w.Code != http.StatusUnsupportedMediaType {
		t.Errorf("form: %d", w.Code)
	}
	// A path with a limit of its own (the desk's recordings): larger bodies there, and only there.
	mid := `{"a":"` + strings.Repeat("x", 200) + `"}`
	if w := do(h, "POST", "/api/big", json, mid); w.Code != 200 {
		t.Errorf("own limit: %d", w.Code)
	}
	if w := do(h, "POST", "/api/big", json, `{"a":"`+strings.Repeat("x", 300)+`"}`); w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("past its own limit: %d", w.Code)
	}
	if w := do(h, "POST", "/api/echo", json, mid); w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("another path keeps MaxBody: %d", w.Code)
	}
}

func TestStatic(t *testing.T) {
	h := testHandler(t)
	for target, want := range map[string]string{
		"/":                       "<!doctype html>page",
		"/index.html":             "<!doctype html>page",
		"/assets/app.js":          "js",
		"/assets/sub/x.css":       "css",
		"/claim":                  "<!doctype html>page", // a route, not a file: the page
		"/assets":                 "<!doctype html>page", // a directory is never listed
		"/assets/":                "<!doctype html>page",
		"/a/../index.html":        "", // any `..` is refused, not resolved
		"/assets/missing.js":      "",
		"/.hidden":                "",
		"/assets/.map":            "",
		"/../../etc/passwd":       "",
		"/..%2f..%2fetc/passwd":   "",
		"/assets/..%5cindex.html": "",
		"/%00":                    "",
	} {
		// As the server parses it: httptest cleans nothing, `..` and escapes stay as sent.
		r := httptest.NewRequest("GET", "http://127.0.0.1:8411"+target, nil)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		body, _ := io.ReadAll(w.Body)
		if want == "" {
			if w.Code != http.StatusNotFound {
				t.Errorf("%s: %d %q", target, w.Code, body)
			}
			continue
		}
		if w.Code != 200 || string(body) != want {
			t.Errorf("%s: %d %q", target, w.Code, body)
		}
		if w.Header().Get("Cache-Control") != "no-store" || !strings.Contains(w.Header().Get("Content-Security-Policy"), "default-src 'self'") ||
			!strings.Contains(w.Header().Get("Content-Security-Policy"), "media-src 'self' blob:;") {
			t.Errorf("%s: headers %v", target, w.Header())
		}
	}
	for _, m := range []string{"POST", "PUT", "DELETE", "OPTIONS"} {
		if w := do(h, m, "/index.html", nil, ""); w.Code != http.StatusMethodNotAllowed {
			t.Errorf("%s: %d", m, w.Code)
		}
	}
}

// A real directory on disk: nothing outside it is served, not even through a link's name.
func TestStaticDirFS(t *testing.T) {
	root := t.TempDir()
	ui := filepath.Join(root, "ui")
	_ = os.MkdirAll(ui, 0o755)
	_ = os.WriteFile(filepath.Join(ui, "index.html"), []byte("page"), 0o644)
	_ = os.WriteFile(filepath.Join(root, "secret"), []byte("secret"), 0o644)
	h := Handler(Options{Port: 8411, Token: "tok-123456789", UI: os.DirFS(ui), API: http.NotFoundHandler()})
	srv := httptest.NewServer(h)
	defer srv.Close()
	for _, p := range []string{"/../secret", "/%2e%2e/secret", "/..%2fsecret", "//../secret"} {
		req, _ := http.NewRequest("GET", srv.URL+p, nil)
		req.Host = "127.0.0.1:8411"
		req.URL.Opaque = p // send the path as written
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if strings.Contains(string(b), "secret") {
			t.Errorf("%s served %q", p, b)
		}
	}
}

func TestListenLoopbackOnly(t *testing.T) {
	for _, a := range []string{"0.0.0.0:0", ":0", "192.0.2.1:0", "localhost"} {
		if ln, _, err := Listen(a); err == nil {
			ln.Close()
			t.Errorf("%s accepted", a)
		}
	}
	ln, port, err := Listen("127.0.0.1:0")
	if err != nil || port == 0 {
		t.Fatal(err)
	}
	ln.Close()
}
