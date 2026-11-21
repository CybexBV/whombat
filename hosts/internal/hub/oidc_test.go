package hub

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"

	"rackoon/internal/hub/store"
)

// fakeIdP is a minimal OpenID Connect provider: discovery, JWKS, an
// authorize endpoint that signs the user in at once, and a token endpoint
// that checks the code, the PKCE verifier and the client secret.
type fakeIdP struct {
	t   *testing.T
	srv *httptest.Server
	key *rsa.PrivateKey

	mu       sync.Mutex
	codes    map[string]idpGrant
	claims   map[string]any // claims of the next sign-in (sub, preferred_username, groups…)
	authTime time.Time      // zero: now
	badNonce bool
	expired  bool
	deny     bool
	lastAuth url.Values // the last authorize request
}

type idpGrant struct {
	challenge, nonce, redirect string
	claims                     map[string]any
	authTime                   time.Time
}

const idpSecret = "client secret 42"

func newFakeIdP(t *testing.T) *fakeIdP {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeIdP{t: t, key: key, codes: map[string]idpGrant{}}
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"issuer": f.srv.URL, "authorization_endpoint": f.srv.URL + "/authorize",
			"token_endpoint": f.srv.URL + "/token", "jwks_uri": f.srv.URL + "/jwks",
			"id_token_signing_alg_values_supported": []string{"RS256"}, "response_types_supported": []string{"code"}})
	})
	mux.HandleFunc("/jwks", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: &f.key.PublicKey, KeyID: "k1", Algorithm: "RS256", Use: "sig"}}})
	})
	mux.HandleFunc("/authorize", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		f.mu.Lock()
		defer f.mu.Unlock()
		f.lastAuth = q
		ret, _ := url.Parse(q.Get("redirect_uri"))
		rq := ret.Query()
		rq.Set("state", q.Get("state"))
		if f.deny {
			rq.Set("error", "access_denied")
		} else {
			if q.Get("code_challenge_method") != "S256" || q.Get("client_id") != "rackoon" || q.Get("response_type") != "code" {
				t.Errorf("authorize request %v", q)
			}
			code := randToken(16)
			at := f.authTime
			if at.IsZero() {
				at = time.Now()
			}
			f.codes[code] = idpGrant{challenge: q.Get("code_challenge"), nonce: q.Get("nonce"), redirect: q.Get("redirect_uri"),
				claims: f.claims, authTime: at}
			rq.Set("code", code)
		}
		ret.RawQuery = rq.Encode()
		http.Redirect(w, r, ret.String(), http.StatusFound)
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		id, secret, ok := r.BasicAuth()
		if ok { // RFC 6749 2.3.1: form-encoded inside Basic
			id, _ = url.QueryUnescape(id)
			secret, _ = url.QueryUnescape(secret)
		} else {
			id, secret = r.PostForm.Get("client_id"), r.PostForm.Get("client_secret")
		}
		f.mu.Lock()
		g, found := f.codes[r.PostForm.Get("code")]
		delete(f.codes, r.PostForm.Get("code"))
		badNonce, expired := f.badNonce, f.expired
		f.mu.Unlock()
		sum := sha256.Sum256([]byte(r.PostForm.Get("code_verifier")))
		if id != "rackoon" || secret != idpSecret || !found || g.redirect != r.PostForm.Get("redirect_uri") ||
			base64.RawURLEncoding.EncodeToString(sum[:]) != g.challenge {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(400)
			w.Write([]byte(`{"error":"invalid_grant"}`))
			return
		}
		now := time.Now()
		claims := map[string]any{"iss": f.srv.URL, "aud": "rackoon", "iat": now.Unix(), "exp": now.Add(5 * time.Minute).Unix(),
			"nonce": g.nonce, "auth_time": g.authTime.Unix()}
		if badNonce {
			claims["nonce"] = "something else"
		}
		if expired {
			claims["exp"] = now.Add(-time.Hour).Unix()
		}
		for k, v := range g.claims {
			claims[k] = v
		}
		payload, _ := json.Marshal(claims)
		signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: f.key},
			(&jose.SignerOptions{}).WithType("JWT").WithHeader("kid", "k1"))
		if err != nil {
			t.Fatal(err)
		}
		obj, err := signer.Sign(payload)
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := obj.CompactSerialize()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"access_token": "at", "token_type": "Bearer", "expires_in": 300, "id_token": raw})
	})
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeIdP) set(fn func(f *fakeIdP)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	fn(f)
}

func ssoEnv(t *testing.T, tweak func(*OIDCConfig)) (*env, *client, *fakeIdP) {
	idp := newFakeIdP(t)
	secret := filepath.Join(t.TempDir(), "oidc-secret")
	if err := os.WriteFile(secret, []byte(idpSecret+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	e, admin := adminEnv(t, func(c *Config) {
		c.OIDC = OIDCConfig{Issuer: idp.srv.URL, ClientID: "rackoon", ClientSecretFile: secret, Name: "Authentik",
			Scopes: []string{"openid", "profile"}, RoleClaim: "groups",
			RoleMap: []OIDCRole{{"admins", "admin"}, {"ops", "operator"}, {"*", "viewer"}}}
		if tweak != nil {
			tweak(&c.OIDC)
		}
	})
	return e, admin, idp
}

// sso runs a sign-in (or a re-authentication) through the fake provider and
// returns where the hub finally sends the browser.
func (c *client) sso(query string) string {
	c.t.Helper()
	nc := &http.Client{Jar: c.c.Jar, Timeout: 30 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	next := c.e.ui.URL + "/api/v1/auth/oidc/start?" + query
	for i := 0; i < 3; i++ {
		resp, err := nc.Get(next)
		if err != nil {
			c.t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusFound {
			c.t.Fatalf("GET %s: %d", next, resp.StatusCode)
		}
		next = resp.Header.Get("Location")
		if i == 0 && strings.HasPrefix(next, "/") { // refused before reaching the provider
			return next
		}
	}
	return next
}

func TestOIDCDisabled(t *testing.T) {
	e, admin := adminEnv(t, nil)
	if st := admin.state(); st["oidc"] != nil {
		t.Fatalf("state %v", st)
	}
	if code, _, _ := e.client().req(http.MethodGet, "/api/v1/auth/oidc/start", nil, nil); code != 404 {
		t.Fatalf("start without sso: %d", code)
	}
}

func TestOIDCSignIn(t *testing.T) {
	e, admin, idp := ssoEnv(t, nil)
	anon := e.client()
	if st := anon.state(); st["oidc"] == nil || st["oidc"].(map[string]any)["name"] != "Authentik" {
		t.Fatalf("anonymous state %v", st)
	}

	// Unknown users are refused (no auto-create).
	idp.set(func(f *fakeIdP) {
		f.claims = map[string]any{"sub": "u-sam", "preferred_username": "sam", "groups": []string{"staff"}}
	})
	if loc := anon.sso("next=/guests"); loc != "/login?oidc_error=not_registered" {
		t.Fatalf("unknown user: %s", loc)
	}
	// A local account of the same name is never taken over.
	idp.set(func(f *fakeIdP) { f.claims = map[string]any{"sub": "u-john", "preferred_username": "john"} })
	if loc := anon.sso(""); loc != "/login?oidc_error=not_registered" {
		t.Fatalf("local account linked: %s", loc)
	}

	// An admin adds sam for single sign-on: linked at the first sign-in,
	// the role follows the provider's groups.
	admin.json(http.MethodPost, "/api/v1/auth/reauth", map[string]string{"password": adminPW}, 204, nil)
	var created map[string]any
	admin.json(http.MethodPost, "/api/v1/users", map[string]string{"name": "sam", "role": "operator", "source": "oidc"}, 201, &created)
	if _, ok := created["temporary_password"]; ok {
		t.Fatalf("sso user got a password: %v", created)
	}
	sam := e.client()
	idp.set(func(f *fakeIdP) {
		f.claims = map[string]any{"sub": "u-sam", "preferred_username": "sam", "groups": []string{"staff"}}
	})
	if loc := sam.sso("next=" + url.QueryEscape("/servers/granite?tab=guests")); loc != "/servers/granite?tab=guests" {
		t.Fatalf("sign-in went to %s", loc)
	}
	st := sam.state()
	if st["authenticated"] != true || st["source"] != "oidc" || st["has_password"] != false ||
		st["user"].(map[string]any)["role"] != "viewer" {
		t.Fatalf("sso session %v", st)
	}
	u, _ := e.h.store.GetUserByName(t.Context(), "sam")
	if u.OIDCSubject != idp.srv.URL+"|u-sam" || u.LastLoginAt.IsZero() {
		t.Fatalf("account %+v", u)
	}
	// The role is the provider's: admins cannot change it here.
	admin.json(http.MethodPost, "/api/v1/auth/reauth", map[string]string{"password": adminPW}, 204, nil)
	if code, b, _ := admin.req(http.MethodPatch, usersPath(u.ID), map[string]string{"role": "admin"}, nil); code != 409 || !strings.Contains(string(b), "role_managed") {
		t.Fatalf("changed a managed role: %d %s", code, b)
	}
	if code, b, _ := admin.req(http.MethodPatch, usersPath(u.ID), map[string]any{"reset_password": true}, nil); code != 409 || !strings.Contains(string(b), "no_password") {
		t.Fatalf("reset an sso password: %d %s", code, b)
	}
	idp.set(func(f *fakeIdP) {
		f.claims = map[string]any{"sub": "u-sam", "preferred_username": "sam", "groups": []string{"staff", "admins"}}
	})
	sam = e.client()
	if loc := sam.sso(""); loc != "/" {
		t.Fatalf("second sign-in: %s", loc)
	}
	if st := sam.state(); st["user"].(map[string]any)["role"] != "admin" {
		t.Fatalf("role not from groups: %v", st)
	}
	// The next target stays on this site.
	if loc := e.client().sso("next=" + url.QueryEscape("//evil.example/x")); loc != "/" {
		t.Fatalf("open redirect: %s", loc)
	}

	// Refusals: the provider says no, a forged or replayed state, a wrong
	// nonce, an expired ID token, no role.
	idp.set(func(f *fakeIdP) { f.deny = true })
	if loc := e.client().sso(""); loc != "/login?oidc_error=denied" {
		t.Fatalf("denied: %s", loc)
	}
	idp.set(func(f *fakeIdP) { f.deny = false })
	c := e.client()
	resp, err := c.c.Get(e.ui.URL + "/api/v1/auth/oidc/callback?code=x&state=forged")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.Request.URL.Path != "/login" || resp.Request.URL.Query().Get("oidc_error") != "expired" {
		t.Fatalf("forged state ended at %s", resp.Request.URL)
	}
	idp.set(func(f *fakeIdP) { f.badNonce = true })
	if loc := e.client().sso(""); loc != "/login?oidc_error=invalid_nonce" {
		t.Fatalf("bad nonce: %s", loc)
	}
	idp.set(func(f *fakeIdP) { f.badNonce, f.expired = false, true })
	if loc := e.client().sso(""); loc != "/login?oidc_error=invalid_token" {
		t.Fatalf("expired token: %s", loc)
	}
	idp.set(func(f *fakeIdP) { f.expired = false })
	e.h.oidc.cfg.RoleMap = []OIDCRole{{"admins", "admin"}}
	idp.set(func(f *fakeIdP) {
		f.claims = map[string]any{"sub": "u-sam", "preferred_username": "sam", "groups": []string{"staff"}}
	})
	if loc := e.client().sso(""); loc != "/login?oidc_error=no_role" {
		t.Fatalf("no role: %s", loc)
	}
	e.h.oidc.cfg.RoleMap = []OIDCRole{{"admins", "admin"}, {"*", "viewer"}}
	if n := len(e.audit("auth.login")); n < 8 {
		t.Errorf("sign-ins audited: %d", n)
	}
	if len(e.audit("user.oidc_linked")) != 1 {
		t.Error("link not audited")
	}

	// Replaying a callback: the state is single use.
	nc := &http.Client{Jar: c.c.Jar, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	r1, _ := nc.Get(e.ui.URL + "/api/v1/auth/oidc/start")
	r1.Body.Close()
	r2, _ := nc.Get(r1.Header.Get("Location"))
	r2.Body.Close()
	cb := r2.Header.Get("Location")
	r3, _ := nc.Get(cb)
	r3.Body.Close()
	if r3.Header.Get("Location") != "/" {
		t.Fatalf("callback: %s", r3.Header.Get("Location"))
	}
	r4, _ := nc.Get(cb)
	r4.Body.Close()
	if r4.Header.Get("Location") != "/login?oidc_error=expired" {
		t.Fatalf("replayed callback: %s", r4.Header.Get("Location"))
	}
}

func TestOIDCReauth(t *testing.T) {
	e, admin, idp := ssoEnv(t, nil)
	admin.json(http.MethodPost, "/api/v1/auth/reauth", map[string]string{"password": adminPW}, 204, nil)
	admin.json(http.MethodPost, "/api/v1/users", map[string]string{"name": "sam", "role": "viewer", "source": "oidc"}, 201, nil)
	idp.set(func(f *fakeIdP) {
		f.claims = map[string]any{"sub": "u-sam", "preferred_username": "sam", "groups": []string{"admins"}}
	})
	sam := e.client()
	sam.sso("")
	sam.state()
	sam.staleSignIn()
	add := map[string]string{"name": "newbie", "role": "viewer"}
	if code, b, _ := sam.req(http.MethodPost, "/api/v1/users", add, nil); code != 403 || !strings.Contains(string(b), "reauth_required") {
		t.Fatalf("stale sso session: %d %s", code, b)
	}
	// No password to confirm with.
	if code, _, _ := sam.req(http.MethodPost, "/api/v1/auth/reauth", map[string]string{"password": ""}, nil); code != 403 {
		t.Fatalf("password reauth without a password: %d", code)
	}
	// A sign-in older than 5 minutes does not confirm.
	idp.set(func(f *fakeIdP) { f.authTime = time.Now().Add(-10 * time.Minute) })
	if loc := sam.sso("reauth=1&next=" + url.QueryEscape("/settings/users")); loc != "/settings/users?reauth=stale" {
		t.Fatalf("stale reauth: %s", loc)
	}
	if q := idp.lastAuth; q.Get("prompt") != "login" || q.Get("max_age") != "0" {
		t.Fatalf("reauth did not ask for a fresh sign-in: %v", q)
	}
	idp.set(func(f *fakeIdP) { f.authTime = time.Time{} })
	if loc := sam.sso("reauth=1&next=" + url.QueryEscape("/settings/users")); loc != "/settings/users?reauth=ok" {
		t.Fatalf("reauth: %s", loc)
	}
	sam.json(http.MethodPost, "/api/v1/users", add, 201, nil)
	// Another account at the provider cannot confirm sam.
	idp.set(func(f *fakeIdP) { f.claims = map[string]any{"sub": "u-other", "preferred_username": "other"} })
	if loc := sam.sso("reauth=1&next=/"); loc != "/?reauth=wrong_account" {
		t.Fatalf("other account confirmed: %s", loc)
	}
	// Password accounts are not confirmed through the provider.
	if loc := admin.sso("reauth=1&next=/"); loc != "/login?oidc_error=not_sso" {
		t.Fatalf("local reauth: %s", loc)
	}
	if n := len(e.audit("auth.reauth")); n < 4 {
		t.Errorf("reauth audited %d times", n)
	}
}

func TestOIDCAutoCreate(t *testing.T) {
	e, _, idp := ssoEnv(t, func(o *OIDCConfig) { o.AutoCreate = true; o.RoleClaim, o.RoleMap = "", nil })
	idp.set(func(f *fakeIdP) { f.claims = map[string]any{"sub": "u-new", "preferred_username": "newbie"} })
	c := e.client()
	if loc := c.sso(""); loc != "/" {
		t.Fatalf("auto-create: %s", loc)
	}
	u, err := e.h.store.GetUserByName(t.Context(), "newbie")
	if err != nil || u.Role != store.RoleViewer || u.Source != store.SourceOIDC || u.PasswordHash != "" {
		t.Fatalf("created %+v %v", u, err)
	}
	// A name taken by a local account is refused, not merged.
	idp.set(func(f *fakeIdP) { f.claims = map[string]any{"sub": "u-x", "preferred_username": "john"} })
	if loc := e.client().sso(""); loc != "/login?oidc_error=username_taken" {
		t.Fatalf("taken name: %s", loc)
	}
	// Names Rackoon cannot use are refused.
	idp.set(func(f *fakeIdP) { f.claims = map[string]any{"sub": "u-y", "preferred_username": "John Doe"} })
	if loc := e.client().sso(""); loc != "/login?oidc_error=invalid_username" {
		t.Fatalf("bad name: %s", loc)
	}
}

func TestOIDCRoleMap(t *testing.T) {
	m, err := ParseOIDCRoleMap("rackoon-admins=admin, ops = operator ,*=viewer")
	if err != nil || len(m) != 3 || m[1] != (OIDCRole{"ops", "operator"}) {
		t.Fatalf("%v %v", m, err)
	}
	if _, err := ParseOIDCRoleMap("x=root"); err == nil {
		t.Fatal("bad role accepted")
	}
	o := &oidcAuth{cfg: OIDCConfig{RoleMap: m}}
	for _, c := range []struct {
		v    any
		want string
	}{
		{[]any{"ops", "rackoon-admins"}, "admin"},
		{"ops", "operator"},
		{nil, "viewer"},
	} {
		if got := o.role(c.v); got != c.want {
			t.Errorf("role(%v) = %s, want %s", c.v, got, c.want)
		}
	}
	for in, want := range map[string]string{"/x?y=1": "/x?y=1", "//evil": "/", "https://evil": "/", "/\\evil": "/", "/api/v1/fleet": "/", "": "/"} {
		if got := safeNext(in); got != want {
			t.Errorf("safeNext(%q) = %q", in, got)
		}
	}
}
