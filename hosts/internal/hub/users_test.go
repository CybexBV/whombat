package hub

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"rackoon/internal/hub/store"
	"rackoon/internal/proto"
)

type userOut struct {
	ID                 int64   `json:"id"`
	Name               string  `json:"name"`
	Role               string  `json:"role"`
	Source             string  `json:"source"`
	LastLoginAt        *string `json:"last_login_at"`
	Passkeys           int     `json:"passkeys"`
	Sessions           int     `json:"sessions"`
	HasPassword        bool    `json:"has_password"`
	MustChangePassword bool    `json:"must_change_password"`
	Self               bool    `json:"self"`
}

func (e *env) userID(name string) int64 {
	e.t.Helper()
	u, err := e.h.store.GetUserByName(context.Background(), name)
	if err != nil {
		e.t.Fatal(err)
	}
	return u.ID
}

func usersPath(id int64, rest ...string) string {
	return fmt.Sprintf("/api/v1/users/%d%s", id, strings.Join(rest, ""))
}

func TestUserManagement(t *testing.T) {
	e, admin := adminEnv(t, nil)

	// Only admins see users.
	e.addUser("vera", store.RoleViewer, "viewer password 1")
	vera := e.client()
	vera.login("vera", "viewer password 1")
	if code, _, _ := vera.req(http.MethodGet, "/api/v1/users", nil, nil); code != 403 {
		t.Fatalf("viewer listed users: %d", code)
	}

	// Adding a user needs a recent sign-in.
	sudo := func() {
		admin.json(http.MethodPost, "/api/v1/auth/reauth", map[string]string{"password": adminPW}, 204, nil)
	}
	admin.staleSignIn()
	add := map[string]string{"name": "olive", "role": "operator"}
	if code, b, _ := admin.req(http.MethodPost, "/api/v1/users", add, nil); code != 403 || !strings.Contains(string(b), "reauth_required") {
		t.Fatalf("stale session added a user: %d %s", code, b)
	}
	sudo()
	var created struct {
		User              userOut `json:"user"`
		TemporaryPassword string  `json:"temporary_password"`
	}
	admin.json(http.MethodPost, "/api/v1/users", add, 201, &created)
	if created.User.Name != "olive" || created.User.Role != "operator" || !created.User.MustChangePassword || len(created.TemporaryPassword) < 20 {
		t.Fatalf("created %+v", created)
	}
	if code, _, _ := admin.req(http.MethodPost, "/api/v1/users", add, nil); code != 409 {
		t.Fatalf("duplicate user: %d", code)
	}

	// The temporary password must be replaced before anything else.
	olive := e.client()
	olive.login("olive", created.TemporaryPassword)
	if st := olive.state(); st["password_change_required"] != true {
		t.Fatalf("state %v", st)
	}
	if code, b, _ := olive.req(http.MethodGet, "/api/v1/fleet", nil, nil); code != 403 || !strings.Contains(string(b), "password_change_required") {
		t.Fatalf("temporary password used the API: %d %s", code, b)
	}
	if code, _, _ := olive.req(http.MethodPost, "/api/v1/auth/password", map[string]string{"new": created.TemporaryPassword}, nil); code != 400 {
		t.Fatalf("kept the temporary password: %d", code)
	}
	olive.json(http.MethodPost, "/api/v1/auth/password", map[string]string{"new": "olive's own password"}, 204, nil)
	olive.json(http.MethodGet, "/api/v1/fleet", nil, 200, nil)
	if st := olive.state(); st["password_change_required"] != false {
		t.Fatalf("state after change %v", st)
	}

	// The list.
	var users []userOut
	admin.json(http.MethodGet, "/api/v1/users", nil, 200, &users)
	byName := map[string]userOut{}
	for _, u := range users {
		byName[u.Name] = u
	}
	if len(users) != 3 || !byName["john"].Self || byName["olive"].Sessions != 1 || byName["olive"].LastLoginAt == nil ||
		byName["olive"].MustChangePassword || !byName["olive"].HasPassword {
		t.Fatalf("users %+v", users)
	}

	// Demoting ends the event streams (they keep the role they opened with)
	// and the console permission.
	oid := byName["olive"].ID
	sub, _, _ := e.h.bus.Subscribe(oid, store.RoleRank(store.RoleOperator), 0)
	var patched struct {
		User userOut `json:"user"`
	}
	sudo()
	admin.json(http.MethodPatch, usersPath(oid), map[string]string{"role": "viewer"}, 200, &patched)
	if patched.User.Role != "viewer" {
		t.Fatalf("patched %+v", patched)
	}
	select {
	case <-sub.Done():
	case <-time.After(time.Second):
		t.Fatal("event stream survived the role change")
	}
	if st := olive.state(); st["user"].(map[string]any)["role"] != "viewer" {
		t.Fatalf("role not applied: %v", st)
	}

	// Your own account is changed on the Account page.
	jid := byName["john"].ID
	if code, b, _ := admin.req(http.MethodPatch, usersPath(jid), map[string]string{"role": "viewer"}, nil); code != 409 || !strings.Contains(string(b), `"self"`) {
		t.Fatalf("demoted yourself: %d %s", code, b)
	}
	if code, _, _ := admin.req(http.MethodDelete, usersPath(jid), nil, nil); code != 409 {
		t.Fatalf("deleted yourself: %d", code)
	}
	if code, _, _ := admin.req(http.MethodPatch, usersPath(oid), map[string]string{"role": "root"}, nil); code != 400 {
		t.Fatalf("bad role: %d", code)
	}

	// Reset: a new temporary password, and every session ends.
	var reset struct {
		User              userOut `json:"user"`
		TemporaryPassword string  `json:"temporary_password"`
	}
	sudo()
	admin.json(http.MethodPatch, usersPath(oid), map[string]any{"reset_password": true}, 200, &reset)
	if reset.TemporaryPassword == "" || !reset.User.MustChangePassword || reset.User.Sessions != 0 {
		t.Fatalf("reset %+v", reset)
	}
	if code, _, _ := olive.req(http.MethodGet, "/api/v1/fleet", nil, nil); code != 401 {
		t.Fatalf("session survived the reset: %d", code)
	}
	olive.login("olive", reset.TemporaryPassword)

	// Sessions: list and sign out everywhere.
	var sessions []map[string]any
	admin.json(http.MethodGet, usersPath(oid, "/sessions"), nil, 200, &sessions)
	if len(sessions) != 1 || sessions[0]["current"] != false {
		t.Fatalf("sessions %v", sessions)
	}
	if code, _, _ := admin.req(http.MethodDelete, usersPath(oid, "/sessions/nope"), nil, nil); code != 404 {
		t.Fatalf("unknown session: %d", code)
	}
	admin.json(http.MethodDelete, usersPath(oid, "/sessions/", sessions[0]["id"].(string)), nil, 204, nil)
	if code, _, _ := olive.req(http.MethodGet, "/api/v1/auth/passkeys", nil, nil); code != 401 {
		t.Fatalf("revoked session works: %d", code)
	}
	olive.login("olive", reset.TemporaryPassword)
	admin.json(http.MethodDelete, usersPath(oid, "/sessions"), nil, 204, nil)
	if code, _, _ := olive.req(http.MethodGet, "/api/v1/auth/passkeys", nil, nil); code != 401 {
		t.Fatalf("signed-out session works: %d", code)
	}
	// Signing yourself out everywhere keeps this session.
	other := e.client()
	other.login("john", adminPW)
	admin.json(http.MethodDelete, usersPath(jid, "/sessions"), nil, 204, nil)
	admin.json(http.MethodGet, "/api/v1/users", nil, 200, nil)
	if code, _, _ := other.req(http.MethodGet, "/api/v1/users", nil, nil); code != 401 {
		t.Fatalf("other own session survived: %d", code)
	}

	// API tokens and kiosk sessions do not manage users.
	var tok struct{ Token string }
	admin.json(http.MethodPost, "/api/v1/tokens", map[string]any{"name": "ci", "role": "admin"}, 201, &tok)
	r, _ := http.NewRequest(http.MethodPost, e.ui.URL+"/api/v1/users", strings.NewReader(`{"name":"x1","role":"admin"}`))
	r.Header.Set("Authorization", "Bearer "+tok.Token)
	resp, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Fatalf("token created a user: %d", resp.StatusCode)
	}

	// Delete: the account and its sessions go at once.
	olive.login("olive", reset.TemporaryPassword)
	sudo()
	admin.json(http.MethodDelete, usersPath(oid), nil, 204, nil)
	if code, _, _ := olive.req(http.MethodGet, "/api/v1/auth/state", nil, nil); code != 200 {
		t.Fatalf("state: %d", code)
	}
	if st := olive.state(); st["authenticated"] != false {
		t.Fatalf("deleted user still signed in: %v", st)
	}
	if code, _, _ := admin.req(http.MethodDelete, usersPath(oid), nil, nil); code != 404 {
		t.Fatalf("deleted twice: %d", code)
	}
	// Single sign-on needs configuring first; such accounts have no password.
	sudo()
	if code, b, _ := admin.req(http.MethodPost, "/api/v1/users", map[string]string{"name": "sso", "role": "viewer", "source": "oidc"}, nil); code != 400 || !strings.Contains(string(b), "oidc_disabled") {
		t.Fatalf("sso user without sso: %d %s", code, b)
	}

	for _, ev := range []string{"user.created", "user.role_changed", "user.password_reset", "user.signed_out", "user.deleted"} {
		if len(e.audit(ev)) == 0 {
			t.Errorf("%s not audited", ev)
		}
	}
}

func TestLastAdminGuard(t *testing.T) {
	e, _ := adminEnv(t, nil)
	ctx := context.Background()
	st := e.h.store
	jid := e.userID("john")
	if err := st.SetRole(ctx, jid, store.RoleOperator); !errors.Is(err, store.ErrLastAdmin) {
		t.Fatalf("demoted the last admin: %v", err)
	}
	if err := st.DeleteUser(ctx, jid); !errors.Is(err, store.ErrLastAdmin) {
		t.Fatalf("deleted the last admin: %v", err)
	}
	e.addUser("ada", store.RoleAdmin, "second admin pw 1")
	aid := e.userID("ada")
	if err := st.SetRole(ctx, aid, store.RoleViewer); err != nil {
		t.Fatal(err)
	}
	if err := st.SetRole(ctx, jid, store.RoleViewer); !errors.Is(err, store.ErrLastAdmin) {
		t.Fatalf("demoted the last admin after a demotion: %v", err)
	}
	if err := st.DeleteUser(ctx, aid); err != nil {
		t.Fatal(err)
	}
	if n, _ := st.CountAdmins(ctx); n != 1 {
		t.Fatalf("admins %d", n)
	}
}

func TestKioskLinksAreReadOnly(t *testing.T) {
	e, admin := adminEnv(t, nil)
	fa := e.enroll(admin, "granite", "Production")
	if _, err := fa.dial(proto.Hello{}); err != nil {
		t.Fatal(err)
	}
	rep := fa.report("granite")
	w := 80.0
	rep.Disks = []proto.Disk{{Device: "nvme0n1", Type: "nvme", WearPct: &w}}
	fa.send(proto.MsgReport, rep)
	var open []map[string]any
	waitFor(t, "alert", 3*time.Second, func() bool {
		admin.json(http.MethodGet, "/api/v1/alerts", nil, 200, &open)
		return len(open) == 1
	})

	if code, _, _ := admin.req(http.MethodPost, "/api/v1/tokens", map[string]any{"name": "x", "kind": "kiosk", "role": "admin"}, nil); code != 400 {
		t.Fatalf("admin kiosk link: %d", code)
	}
	var tok struct {
		ID, Token, Kind, Role string
	}
	admin.json(http.MethodPost, "/api/v1/tokens", map[string]any{"name": "Lobby", "kind": "kiosk"}, 201, &tok)
	if tok.Kind != "kiosk" || tok.Role != "viewer" {
		t.Fatalf("kiosk token %+v", tok)
	}
	// Not a bearer token.
	r, _ := http.NewRequest(http.MethodGet, e.ui.URL+"/api/v1/fleet", nil)
	r.Header.Set("Authorization", "Bearer "+tok.Token)
	resp, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatalf("kiosk link used as a bearer token: %d", resp.StatusCode)
	}
	var list []map[string]any
	admin.json(http.MethodGet, "/api/v1/tokens", nil, 200, &list)
	if len(list) != 1 || list[0]["kind"] != "kiosk" {
		t.Fatalf("tokens %v", list)
	}
	// A kiosk session reads but changes nothing (a viewer could ack).
	k := e.client()
	k.state()
	k.json(http.MethodPost, "/api/v1/auth/kiosk", map[string]string{"token": tok.Token}, 204, nil)
	if st := k.state(); st["kiosk"] != true {
		t.Fatalf("state %v", st)
	}
	k.json(http.MethodGet, "/api/v1/fleet", nil, 200, nil)
	code, b, _ := k.req(http.MethodPost, "/api/v1/alerts/"+open[0]["id"].(string)+"/ack", map[string]any{"minutes": 60}, nil)
	if code != 403 || !strings.Contains(string(b), "kiosk_read_only") {
		t.Fatalf("kiosk acknowledged an alert: %d %s", code, b)
	}
	// Nor does it see its owner's tokens or passkeys.
	for _, path := range []string{"/api/v1/tokens", "/api/v1/auth/passkeys"} {
		if code, _, _ := k.req(http.MethodGet, path, nil, nil); code != 403 {
			t.Fatalf("kiosk read %s: %d", path, code)
		}
	}
	// Kiosk sessions do not count as a sign-in of the owner.
	var users []userOut
	admin.json(http.MethodGet, "/api/v1/users", nil, 200, &users)
	if users[0].Sessions != 2 {
		t.Fatalf("sessions %+v", users)
	}
	k.json(http.MethodPost, "/api/v1/auth/logout", map[string]any{}, 204, nil)
}

func TestPrometheusMetrics(t *testing.T) {
	e, admin := adminEnv(t, nil)
	fa := e.enroll(admin, "granite", "Production")
	if _, err := fa.dial(proto.Hello{}); err != nil {
		t.Fatal(err)
	}
	fa.send(proto.MsgReport, fa.report("granite"))
	waitFor(t, "report", 3*time.Second, func() bool {
		st, ok := e.h.snapshotOne("granite")
		return ok && st.Report != nil
	})
	var tok struct{ Token string }
	admin.json(http.MethodPost, "/api/v1/tokens", map[string]any{"name": "prometheus"}, 201, &tok)

	get := func(hdr map[string]string) (int, string, http.Header) {
		r, _ := http.NewRequest(http.MethodGet, e.ui.URL+"/metrics", nil)
		for k, v := range hdr {
			r.Header.Set(k, v)
		}
		resp, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(b), resp.Header
	}
	// Session cookies are not accepted, only tokens.
	if code, _, _ := admin.req(http.MethodGet, "/metrics", nil, nil); code != 401 {
		t.Fatalf("session scraped metrics: %d", code)
	}
	if code, _, hdr := get(nil); code != 401 || hdr.Get("WWW-Authenticate") == "" {
		t.Fatalf("anonymous scrape: %d %v", code, hdr)
	}
	if code, _, _ := get(map[string]string{"Authorization": "Bearer rk_wrong"}); code != 401 {
		t.Fatalf("bad token: %d", code)
	}
	code, body, hdr := get(map[string]string{"Authorization": "Bearer " + tok.Token, "Accept-Encoding": "identity"})
	if code != 200 || !strings.HasPrefix(hdr.Get("Content-Type"), "text/plain; version=0.0.4") {
		t.Fatalf("scrape: %d %v", code, hdr)
	}
	for _, want := range []string{
		`rackoon_hub_info{version="` + Version + `"} 1`,
		"rackoon_hub_agents_connected 1",
		`rackoon_server_up{server="granite"} 1`,
		`rackoon_server_info{server="granite",hostname="granite",group="Production",`,
		`rackoon_server_cpu_usage_percent{server="granite"} `,
		`rackoon_server_memory_usage_percent{server="granite"} `,
		`rackoon_server_load1{server="granite"} `,
		`rackoon_server_temperature_celsius{server="granite",sensor="`,
		`rackoon_server_volume_used_percent{server="granite",volume="`,
		`rackoon_server_guests_running{server="granite",platform="`,
		`rackoon_alerts_open{severity="critical"} 0`,
		`rackoon_server_alerts_open{server="granite",severity="warning"} 0`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("missing %q", want)
		}
	}
	// Well formed: HELP and TYPE once per family, before its samples, and
	// every sample line is "name{labels} value".
	seen := map[string]bool{}
	current := ""
	for _, line := range strings.Split(strings.TrimRight(body, "\n"), "\n") {
		switch {
		case strings.HasPrefix(line, "# HELP "):
			name := strings.Fields(line)[2]
			if seen[name] {
				t.Errorf("family %s twice", name)
			}
			seen[name], current = true, name
		case strings.HasPrefix(line, "# TYPE "):
			if f := strings.Fields(line); f[2] != current || f[3] != "gauge" {
				t.Errorf("bad TYPE line %q", line)
			}
		default:
			name := line
			if i := strings.IndexAny(line, "{ "); i > 0 {
				name = line[:i]
			}
			if name != current || strings.Count(line, " ") < 1 {
				t.Errorf("sample %q outside its family %s", line, current)
			}
		}
	}

	// Label values are escaped.
	s := &promSet{idx: map[string]*promFamily{}}
	s.add("x", "help", 1.5, "a", "q\"uote\\back\nline")
	var buf bytes.Buffer
	s.write(&buf)
	if !strings.Contains(buf.String(), `x{a="q\"uote\\back\nline"} 1.5`) {
		t.Fatalf("escaping: %q", buf.String())
	}

	// Offline servers keep up=0 and drop their stale values.
	fa.sess.Close()
	e.h.mu.Lock()
	e.h.servers["granite"].lastFrame = time.Now().Add(-time.Hour)
	e.h.mu.Unlock()
	_, body, _ = get(map[string]string{"Authorization": "Bearer " + tok.Token})
	if !strings.Contains(body, `rackoon_server_up{server="granite"} 0`) || strings.Contains(body, "rackoon_server_cpu_usage_percent{") {
		t.Fatalf("offline server:\n%s", body)
	}
}
