package hub

import (
	"bufio"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"rackoon/internal/proto"
	"rackoon/internal/wire"
)

// svcTransport adds the service token and the X-Whombat-* headers.
type svcTransport struct {
	token, actor, role, ip string
}

func (s *svcTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+s.token)
	for k, v := range map[string]string{HeaderActor: s.actor, HeaderRole: s.role, HeaderClientIP: s.ip} {
		if v != "" && r.Header.Get(k) == "" { // the request's own header wins
			r.Header.Set(k, v)
		}
	}
	return http.DefaultTransport.RoundTrip(r)
}

// service is a client of the Whombat server: the service token, acting for
// actor ("<id>|<name>").
func (e *env) service(actor string) *client {
	return &client{t: e.t, e: e, c: &http.Client{Timeout: 30 * time.Second,
		Transport: &svcTransport{token: e.serviceToken(), actor: actor}}}
}

func (e *env) serviceToken() string {
	e.t.Helper()
	b, err := os.ReadFile(e.h.cfg.ServiceTokenFile)
	if err != nil {
		e.t.Fatal(err)
	}
	return strings.TrimSpace(string(b))
}

func headlessEnv(t *testing.T, tweak func(*Config)) *env {
	return newEnv(t, func(c *Config) {
		c.Headless = true
		c.ServiceTokenFile = filepath.Join(c.DataDir, "service-token")
		if tweak != nil {
			tweak(c)
		}
	})
}

func TestHeadlessRoutesAndServiceToken(t *testing.T) {
	e := headlessEnv(t, nil)
	if e.setupOut != "" {
		t.Errorf("headless printed a setup URL: %q", e.setupOut)
	}
	fi, err := os.Stat(e.h.cfg.ServiceTokenFile)
	if err != nil || fi.Mode().Perm() != 0o640 {
		t.Fatalf("token file %v %v", fi, err)
	}
	tok := e.serviceToken()
	if !strings.HasPrefix(tok, ServiceTokenPrefix) || len(tok) < 40 {
		t.Fatalf("token %q", tok)
	}
	if strings.Contains(e.logs.String(), tok) {
		t.Error("service token in the log")
	}
	anon := e.client()
	for _, path := range []string{"/api/v1/auth/state", "/api/v1/users", "/api/v1/tokens", "/api/v1/channels",
		"/api/v1/assistant", "/", "/index.html", "/install.sh", "/download/whombat-agent-linux-amd64"} {
		if code, b, _ := anon.req(http.MethodGet, path, nil, nil); code != 404 {
			t.Errorf("GET %s: %d %s", path, code, b)
		}
	}
	if code, _, _ := anon.req(http.MethodGet, "/api/v1/fleet", nil, nil); code != 401 {
		t.Errorf("anonymous fleet: %d", code)
	}
	if code, _, _ := anon.req(http.MethodGet, "/healthz", nil, nil); code != 200 {
		t.Errorf("healthz: %d", code)
	}
	wrong := &client{t: t, e: e, c: &http.Client{Transport: &svcTransport{token: tok + "x", actor: "pe_1|John"}}}
	if code, _, _ := wrong.req(http.MethodGet, "/api/v1/fleet", nil, nil); code != 401 {
		t.Errorf("wrong token: %d", code)
	}
	svc := e.service("pe_1|John Doe")
	svc.json(http.MethodGet, "/api/v1/fleet", nil, 200, nil)
	// The routes the Whombat server uses need no CSRF token, and a
	// browser's Origin forwarded by mistake is ignored.
	code, b, _ := svc.req(http.MethodPost, "/api/v1/maintenance", map[string]any{"scope": "all", "duration_min": 60, "note": "move"},
		map[string]string{"Origin": "https://evil.example", HeaderClientIP: "10.100.1.30"})
	if code != 201 {
		t.Fatalf("maintenance: %d %s", code, b)
	}
	var hub map[string]any
	svc.json(http.MethodGet, "/api/v1/hub", nil, 200, &hub)
	if hub["headless"] != true || hub["ca_sha256"] != e.h.ca.Pin || !strings.HasPrefix(hub["tls_pin"].(string), "sha256//") {
		t.Fatalf("hub = %v", hub)
	}
	// Prometheus takes the service token too.
	if code, b, _ := svc.req(http.MethodGet, "/metrics", nil, nil); code != 200 || !strings.Contains(string(b), "rackoon_") {
		t.Errorf("metrics: %d %.80s", code, b)
	}

	// Headers: a bad actor or role is refused; a lower role applies.
	for hdr, want := range map[[2]string]string{
		{HeaderActor, "pe 1|John"}:              "bad_actor",
		{HeaderActor, "|John"}:                  "bad_actor",
		{HeaderRole, "root"}:                    "bad_role",
		{HeaderRole, "viewer,admin"}:            "bad_role",
		{HeaderActor, strings.Repeat("a", 129)}: "bad_actor",
	} {
		code, b, _ := svc.req(http.MethodGet, "/api/v1/fleet", nil, map[string]string{hdr[0]: hdr[1]})
		if code != 400 || !strings.Contains(string(b), want) {
			t.Errorf("%s: %s: %d %s", hdr[0], hdr[1], code, b)
		}
	}
	if code, _, _ := svc.req(http.MethodGet, "/api/v1/audit", nil, map[string]string{HeaderRole: "viewer"}); code != 403 {
		t.Errorf("viewer audit: %d", code)
	}
	if code, _, _ := svc.req(http.MethodGet, "/api/v1/fleet", nil, map[string]string{HeaderRole: "viewer"}); code != 200 {
		t.Errorf("viewer fleet: %d", code)
	}

	// The audit log names the actor and the person's address.
	recs := e.audit("maintenance.created")
	if len(recs) != 1 || recs[0].User != "John Doe (pe_1)" || recs[0].Role != "admin" || recs[0].ClientIP != "10.100.1.30" {
		t.Fatalf("audit = %+v", recs)
	}
	// Without the header: Whombat itself.
	noActor := &client{t: t, e: e, c: &http.Client{Transport: &svcTransport{token: tok}}}
	noActor.json(http.MethodPost, "/api/v1/enrollments", map[string]any{}, 201, nil)
	if recs := e.audit("enrollment.created"); len(recs) != 1 || recs[0].User != "Whombat (whombat)" {
		t.Fatalf("default actor audit = %+v", recs)
	}
}

func TestParseActor(t *testing.T) {
	for in, want := range map[string]string{
		"pe_1|John Doe":                    "John Doe (pe_1)",
		"ag_7:whombat@burrow-1":            "ag_7:whombat@burrow-1",
		" pe_1 | John\x07 | Doe ":          "John Doe (pe_1)",
		"":                                 "Whombat (whombat)",
		"pe_2|" + strings.Repeat("é", 100): strings.Repeat("é", 64) + " (pe_2)",
	} {
		a, err := parseActor(in)
		if err != nil || a.auditName() != want {
			t.Errorf("parseActor(%q) = %v %v, want %q", in, a, err, want)
		}
	}
	for _, in := range []string{"pe 1|x", "|x", "pe/1", "pé|x"} {
		if _, err := parseActor(in); err == nil {
			t.Errorf("parseActor(%q) accepted", in)
		}
	}
	if a, b := actorUserID("pe_1"), actorUserID("pe_2"); a >= 0 || b >= 0 || a == b || a != actorUserID("pe_1") {
		t.Errorf("actor ids %d %d", a, b)
	}
}

func TestServiceTokenFile(t *testing.T) {
	dir := t.TempDir()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	short := filepath.Join(dir, "short")
	os.WriteFile(short, []byte("too-short\n"), 0o640)
	if _, err := loadServiceToken(short, log); err == nil {
		t.Error("a short token was accepted")
	}
	two := filepath.Join(dir, "two")
	os.WriteFile(two, []byte(strings.Repeat("a", 40)+" "+strings.Repeat("b", 40)), 0o640)
	if _, err := loadServiceToken(two, log); err == nil {
		t.Error("two tokens were accepted")
	}
	own := filepath.Join(dir, "own")
	secret := strings.Repeat("s", 48)
	os.WriteFile(own, []byte(secret+"\n"), 0o600)
	st, err := loadServiceToken(own, log)
	if err != nil || st.match(secret) == nil || st.match(secret+"x") != nil {
		t.Fatalf("own token: %v", err)
	}
	h := st.match(secret)
	// Rotation: a new token replaces the old one; a missing file refuses all.
	os.WriteFile(own+".new", []byte(strings.Repeat("n", 48)), 0o600)
	os.Rename(own+".new", own)
	st.refresh()
	if st.current(h) || st.match(strings.Repeat("n", 48)) == nil {
		t.Fatal("rotation not picked up")
	}
	os.Remove(own)
	st.refresh()
	if st.match(strings.Repeat("n", 48)) != nil {
		t.Fatal("a deleted token file still authenticates")
	}
}

func TestHeadlessEnrollmentAndInstaller(t *testing.T) {
	lanAddress = func() (string, error) { return "127.0.0.1", nil }
	t.Cleanup(func() { lanAddress = defaultRouteAddr })
	dist := t.TempDir()
	os.WriteFile(filepath.Join(dist, agentBinaryName("amd64")), []byte("amd64 build"), 0o644)
	os.WriteFile(filepath.Join(dist, agentBinaryName("arm64")), []byte("arm64 build"), 0o644)
	e := headlessEnv(t, func(c *Config) { c.AgentURLAuto, c.AgentListen, c.AgentDist = true, "0.0.0.0:4743", dist })
	svc := e.service("pe_1|John")
	var en map[string]any
	svc.json(http.MethodPost, "/api/v1/enrollments", nil, 201, &en)
	pin := e.h.listenerPin()
	want := " curl -fsSL --insecure --pinnedpubkey '" + pin + "' https://127.0.0.1:4743/install.sh | sudo sh -s -- --token " + en["token"].(string)
	if en["install_command"] != want || en["agent_url"] != "wss://127.0.0.1:4743" || en["ca_sha256"] != e.h.ca.Pin ||
		en["install_url"] != "https://127.0.0.1:4743/install.sh" || en["tls_pin"] != pin {
		t.Fatalf("enrollment = %v\nwant command %q", en, want)
	}

	// install.sh and the downloads on the agent listener; the pin is the
	// key of the certificate the listener presents.
	hc := e.agentHTTP(nil)
	resp, err := hc.Get(e.agent.URL + "/install.sh")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	der, _ := x509.MarshalPKIXPublicKey(resp.TLS.PeerCertificates[0].PublicKey)
	sum := sha256.Sum256(der)
	if got := "sha256//" + base64.StdEncoding.EncodeToString(sum[:]); got != pin {
		t.Fatalf("pin %s, the listener presents %s", pin, got)
	}
	script := string(b)
	host := strings.TrimPrefix(e.agent.URL, "https://")
	for _, s := range []string{"HUB_URL='wss://127.0.0.1:4743'", "TLS_PIN='" + pin + "'", "DOWNLOAD_BASE='https://" + host + "/download'",
		"CA_SHA256='" + e.h.ca.Pin + "'", `curl -fsSL --insecure --pinnedpubkey "$TLS_PIN"`, "SHA256_AMD64='" + fileSHA256(filepath.Join(dist, agentBinaryName("amd64")))} {
		if !strings.Contains(script, s) {
			t.Errorf("install.sh lacks %q", s)
		}
	}
	resp, err = hc.Get(e.agent.URL + "/download/" + agentBinaryName("arm64"))
	if err != nil {
		t.Fatal(err)
	}
	b, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || string(b) != "arm64 build" {
		t.Fatalf("download: %d %q", resp.StatusCode, b)
	}

	// The whole flow with the service token: enroll, approve, connect.
	fa := e.enroll(svc, "basalt", "Lab")
	if _, err := fa.dial(proto.Hello{}); err != nil {
		t.Fatal(err)
	}
	var list []map[string]any
	svc.json(http.MethodGet, "/api/v1/enrollments?state=approved", nil, 200, &list)
	if len(list) != 1 {
		t.Fatalf("enrollments %v", list)
	}
	// A heartbeat check's ping URL is on the agent listener.
	var ck map[string]any
	svc.json(http.MethodPost, "/api/v1/checks", map[string]any{"name": "backup", "kind": "heartbeat", "interval_s": 3600, "grace_s": 600}, 201, &ck)
	if u, _ := ck["ping_url"].(string); !strings.HasPrefix(u, "https://127.0.0.1:4743/ping/") {
		t.Fatalf("ping url %v", ck["ping_url"])
	}
	tokenPath := strings.TrimPrefix(ck["ping_url"].(string), "https://127.0.0.1:4743")
	resp, err = hc.Get(e.agent.URL + tokenPath)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("ping on the agent listener: %d", resp.StatusCode)
	}
}

// dialServiceConsole opens a console WebSocket as the Whombat server does:
// the service token and the actor, the two subprotocols, no Origin.
func dialServiceConsole(e *env, url, token, actor, secret string) (*websocket.Conn, *http.Response, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return websocket.Dial(ctx, strings.Replace(e.ui.URL, "http://", "ws://", 1)+url, &websocket.DialOptions{
		Subprotocols: []string{ConsoleSubprotocol, TokenSubprotoPfx + token},
		HTTPHeader:   http.Header{"Authorization": {"Bearer " + secret}, HeaderActor: {actor}},
	})
}

func TestHeadlessConsoleAndTokenRotation(t *testing.T) {
	e := headlessEnv(t, nil)
	svc := e.service("pe_1|John")
	fa := setupConsoleHost(t, e, svc)
	_ = fa
	var cr consoleResp
	svc.json(http.MethodPost, "/api/v1/servers/basalt/guests/incus:dev-shell/console-sessions", map[string]any{}, 201, &cr)
	// Another actor cannot use it.
	if _, resp, err := dialServiceConsole(e, cr.URL, cr.Token, "pe_2|Olivia", e.serviceToken()); err == nil || resp == nil || resp.StatusCode != 403 {
		t.Fatalf("other actor: %v %v", resp, err)
	}
	svc.json(http.MethodPost, "/api/v1/servers/basalt/guests/incus:dev-shell/console-sessions", map[string]any{}, 201, &cr)
	ws, resp, err := dialServiceConsole(e, cr.URL, cr.Token, "pe_1|John", e.serviceToken())
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer ws.CloseNow()
	if resp.Header.Get("Sec-WebSocket-Protocol") != ConsoleSubprotocol {
		t.Errorf("subprotocol %q", resp.Header.Get("Sec-WebSocket-Protocol"))
	}
	if st := control(t, readFrame(t, ws)); st.Type != "status" || st.State != "connected" {
		t.Fatalf("status %+v", st)
	}
	sendWS(t, ws, wire.Frame{Kind: wire.FrameData, Payload: []byte("id\r")})
	if f := readFrame(t, ws); string(f.Payload) != "echo:id\r" {
		t.Fatalf("echo %q", f.Payload)
	}
	// Per-person limits: 5 consoles for John (the unused first one counts
	// until it expires); Olivia still gets hers.
	for i := 0; i < 3; i++ {
		svc.json(http.MethodPost, "/api/v1/servers/basalt/guests/incus:dev-shell/console-sessions", map[string]any{}, 201, nil)
	}
	if code, b, _ := svc.req(http.MethodPost, "/api/v1/servers/basalt/guests/incus:dev-shell/console-sessions", map[string]any{}, nil); code != 429 {
		t.Fatalf("sixth console: %d %s", code, b)
	}
	e.service("pe_2|Olivia").json(http.MethodPost, "/api/v1/servers/basalt/guests/incus:dev-shell/console-sessions", map[string]any{}, 201, nil)

	// Rotating the token ends the live console and refuses the old token.
	old := e.serviceToken()
	os.WriteFile(e.h.cfg.ServiceTokenFile+".new", []byte(ServiceTokenPrefix+strings.Repeat("r", 43)+"\n"), 0o640)
	os.Rename(e.h.cfg.ServiceTokenFile+".new", e.h.cfg.ServiceTokenFile)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var closed wire.ConsoleControl
	for {
		_, b, err := ws.Read(ctx)
		if err != nil {
			break
		}
		if f, err := wire.DecodeWS(b); err == nil && f.Kind == wire.FrameControl {
			json.Unmarshal(f.Payload, &closed)
		}
	}
	if closed.Type != "closed" || closed.Reason != reasonRevoked {
		t.Fatalf("after rotation: %+v", closed)
	}
	stale := &client{t: t, e: e, c: &http.Client{Transport: &svcTransport{token: old, actor: "pe_1|John"}}}
	if code, _, _ := stale.req(http.MethodGet, "/api/v1/fleet", nil, nil); code != 401 {
		t.Fatalf("old token after rotation: %d", code)
	}
	e.service("pe_1|John").json(http.MethodGet, "/api/v1/fleet", nil, 200, nil)
}

func TestHeadlessDiagnoseExecAndMigrate(t *testing.T) {
	e := headlessEnv(t, nil)
	svc := e.service("ag_1|Whombat")
	fa := e.enroll(svc, "basalt", "Lab")
	fa.policy = proto.Policy{Console: true, Power: true, Diagnose: true, Manage: true}
	if _, err := fa.dial(proto.Hello{}); err != nil {
		t.Fatal(err)
	}
	fa.send(proto.MsgReport, fa.report("basalt"))
	waitFor(t, "report", 3*time.Second, func() bool { st, _ := e.h.snapshotOne("basalt"); return st != nil && st.Report != nil })

	var cat map[string]any
	svc.json(http.MethodGet, "/api/v1/servers/basalt/diagnose", nil, 200, &cat)
	if checks := cat["checks"].([]any); len(checks) != 1 || checks[0].(map[string]any)["name"] != "unraid" {
		t.Fatalf("catalog %v", cat)
	}
	var out map[string]any
	svc.json(http.MethodPost, "/api/v1/servers/basalt/diagnose", map[string]any{"check": "unraid", "args": map[string]any{"lines": 50}}, 200, &out)
	if out["ok"] != true || !strings.Contains(out["output"].(string), "DISK_DSBL") || out["commands"].([]any)[0] != "cat /proc/mdstat" {
		t.Fatalf("diagnose %v", out)
	}
	fa.mu.Lock()
	got := fa.diagnoses[len(fa.diagnoses)-1]
	fa.mu.Unlock()
	if got.Check != "unraid" || got.Args["lines"] != "50" {
		t.Fatalf("agent got %+v", got)
	}
	if recs := e.audit("diagnose.ran"); len(recs) != 1 || recs[0].Details["check"] != "unraid" || recs[0].Details["args"] != "lines=50" {
		t.Fatalf("diagnose audit %+v", recs)
	}
	if code, _, _ := svc.req(http.MethodPost, "/api/v1/servers/basalt/diagnose", map[string]any{"check": "list"}, nil); code != 400 {
		t.Errorf("POST list: %d", code)
	}
	if code, _, _ := svc.req(http.MethodPost, "/api/v1/servers/basalt/diagnose", map[string]any{"check": "smart"}, map[string]string{HeaderRole: "viewer"}); code != 403 {
		t.Errorf("viewer diagnose: %d", code)
	}
	// The hub's diagnose switch.
	svc.json(http.MethodPatch, "/api/v1/servers/basalt", map[string]any{"remote_control": map[string]bool{"diagnose": false}}, 200, nil)
	if code, b, _ := svc.req(http.MethodPost, "/api/v1/servers/basalt/diagnose", map[string]any{"check": "unraid"}, nil); code != 403 || !strings.Contains(string(b), "diagnose_disabled") {
		t.Errorf("switched off: %d %s", code, b)
	}

	// exec needs the host shell switches on both sides.
	cmd := map[string]any{"command": "smartctl -t short /dev/sdc", "timeout_s": 60}
	if code, b, _ := svc.req(http.MethodPost, "/api/v1/servers/basalt/exec", cmd, nil); code != 403 || !strings.Contains(string(b), "host_shell_disabled") {
		t.Fatalf("exec without the switch: %d %s", code, b)
	}
	svc.json(http.MethodPatch, "/api/v1/servers/basalt", map[string]any{"remote_control": map[string]bool{"host_shell": true, "manage": true}}, 200, nil)
	fa.policy.HostShell = true
	fa.send(proto.MsgReport, fa.report("basalt"))
	waitFor(t, "policy", 3*time.Second, func() bool { st, _ := e.h.snapshotOne("basalt"); return st.Report.Policy.HostShell })
	if code, _, _ := svc.req(http.MethodPost, "/api/v1/servers/basalt/exec", cmd, map[string]string{HeaderRole: "operator"}); code != 403 {
		t.Errorf("operator exec: %d", code)
	}
	for _, bad := range []map[string]any{{"command": ""}, {"command": "x\x00y"}, {"command": "ls", "timeout_s": 4000}} {
		if code, _, _ := svc.req(http.MethodPost, "/api/v1/servers/basalt/exec", bad, nil); code != 400 {
			t.Errorf("exec %v: %d", bad, code)
		}
	}
	svc.json(http.MethodPost, "/api/v1/servers/basalt/exec", cmd, 200, &out)
	if out["exit_code"] != float64(0) || out["output"] != "SMART self-test started\n" || out["audit_id"] == "" {
		t.Fatalf("exec %v", out)
	}
	fa.mu.Lock()
	ex := fa.execs[len(fa.execs)-1]
	fa.mu.Unlock()
	if ex.Command != "smartctl -t short /dev/sdc" || ex.TimeoutS != 60 {
		t.Fatalf("agent got %+v", ex)
	}
	if req, fin := e.audit("exec.requested"), e.audit("exec.finished"); len(req) != 1 || len(fin) != 1 ||
		req[0].Details["command"] != "smartctl -t short /dev/sdc" || req[0].User != "Whombat (ag_1)" || fin[0].Details["exit_code"] != "0" {
		t.Fatalf("exec audit %+v %+v", req, fin)
	}

	// Migrating a guest: admin, confirm, a task the hub follows.
	fa.mu.Lock()
	fa.manage = func(req proto.ManageRequest) proto.ManageResponse {
		if req.Op == proto.OpMigrate {
			return proto.ManageResponse{OK: true, Task: &proto.TaskRef{ID: "UPID:basalt:0000A1B2:00C0FFEE:6710A000:qmigrate:" + req.GuestID + ":whombat-manage@pve!agent-basalt:"}}
		}
		return fakeManage(req)
	}
	fa.mu.Unlock()
	path := "/api/v1/servers/basalt/guests/incus:nixbuild/migrate"
	if code, b, _ := svc.req(http.MethodPost, path, map[string]any{"target": "pve-02"}, nil); code != 400 || !strings.Contains(string(b), "confirm_required") {
		t.Fatalf("migrate without confirm: %d %s", code, b)
	}
	if code, b, _ := svc.req(http.MethodPost, path, map[string]any{"target": "pve 02", "confirm": true}, nil); code != 400 {
		t.Fatalf("bad target: %d %s", code, b)
	}
	if code, _, _ := svc.req(http.MethodPost, path, map[string]any{"target": "pve-02", "confirm": true}, map[string]string{HeaderRole: "operator"}); code != 403 {
		t.Fatalf("operator migrate: %d", code)
	}
	var mr map[string]any
	svc.json(http.MethodPost, path, map[string]any{"target": "pve-02", "storage": "local-zfs", "digest": "d1", "confirm": true}, 202, &mr)
	if mr["task"] == nil {
		t.Fatalf("migrate answer %v", mr)
	}
	fa.mu.Lock()
	mreq := fa.manages[len(fa.manages)-1]
	fa.mu.Unlock()
	if mreq.Op != proto.OpMigrate || mreq.Target != "pve-02" || mreq.Storage != "local-zfs" || mreq.Digest != "d1" || mreq.GuestID != "nixbuild" {
		t.Fatalf("agent got %+v", mreq)
	}
	waitFor(t, "task finished", 5*time.Second, func() bool { return len(e.audit("manage.finished")) == 1 })
}

// TestHeadlessUnixSocket runs the hub on a Unix socket as the appliance
// does, replacing a stale socket file, with mode 0660.
func TestHeadlessUnixSocket(t *testing.T) {
	dir, err := os.MkdirTemp(os.Getenv("TMPDIR"), "wbh") // short: socket paths are at most 107 bytes
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	sock := filepath.Join(dir, "api.sock")
	stale, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	stale.(*net.UnixListener).SetUnlinkOnClose(false)
	stale.Close()
	cfg := Config{DataDir: filepath.Join(dir, "data"), Listen: "unix:" + sock, AgentListen: "127.0.0.1:0", Headless: true,
		ServiceTokenFile: filepath.Join(dir, "token")}
	h, err := New(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- h.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		<-done
		h.Close()
	})
	hc := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", sock)
		},
		TLSClientConfig: &tls.Config{},
	}}
	var resp *http.Response
	waitFor(t, "socket", 5*time.Second, func() bool {
		resp, err = hc.Get("http://hosts/healthz")
		return err == nil
	})
	resp.Body.Close()
	if fi, err := os.Stat(sock); err != nil || fi.Mode().Perm() != 0o660 || fi.Mode()&os.ModeSocket == 0 {
		t.Fatalf("socket %v %v", fi.Mode(), err)
	}
	tok, _ := os.ReadFile(cfg.ServiceTokenFile)
	req, _ := http.NewRequest(http.MethodGet, "http://hosts/api/v1/events", nil)
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(tok)))
	req.Header.Set(HeaderActor, "whombat-server|Whombat")
	resp, err = hc.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("events: %d %s", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	line, _ := bufio.NewReader(resp.Body).ReadString('\n')
	if line != "retry: 5000\n" {
		t.Fatalf("first line %q", line)
	}
	// Consoles count as secure over the socket (no insecure_transport).
	req, _ = http.NewRequest(http.MethodPost, "http://hosts/api/v1/servers/none/guests/incus:x/console-sessions", nil)
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(tok)))
	r2, err := hc.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(r2.Body)
	r2.Body.Close()
	if r2.StatusCode != 404 || !strings.Contains(string(b), "server_not_found") {
		t.Fatalf("console over the socket: %d %s", r2.StatusCode, b)
	}
}

func TestDefaultRouteIface(t *testing.T) {
	p := filepath.Join(t.TempDir(), "route")
	os.WriteFile(p, []byte(`Iface	Destination	Gateway 	Flags	RefCnt	Use	Metric	Mask		MTU	Window	IRTT
wlan0	00000000	0101A8C0	0003	0	0	600	00000000	0	0	0
eth0	00000000	0101010A	0003	0	0	100	00000000	0	0	0
eth0	0001010A	00000000	0001	0	0	100	00FFFFFF	0	0	0
down0	00000000	0101010A	0002	0	0	1	00000000	0	0	0
`), 0o644)
	if got := defaultRouteIface(p); got != "eth0" {
		t.Fatalf("default route interface %q", got)
	}
	if got := defaultRouteIface(filepath.Join(t.TempDir(), "none")); got != "" {
		t.Fatalf("missing table: %q", got)
	}
	// This machine: the per-process table answers like /proc/net/route.
	if a, b := defaultRouteIface("/proc/self/net/route"), defaultRouteIface("/proc/net/route"); a != b {
		t.Fatalf("/proc/self/net/route %q, /proc/net/route %q", a, b)
	}
	if routeTables[0] != "/proc/self/net/route" {
		t.Fatal("the sandbox-visible table must come first")
	}
}

func TestHeadlessConfigChecks(t *testing.T) {
	for name, c := range map[string]Config{
		"no token":      {DataDir: "x", Headless: true},
		"oidc":          {DataDir: "x", Headless: true, ServiceTokenFile: "t", OIDC: OIDCConfig{Issuer: "https://a", ClientID: "c"}},
		"relative sock": {DataDir: "x", Listen: "unix:api.sock"},
		"tls on sock":   {DataDir: "x", Listen: "unix:/run/x.sock", TLSCert: "a", TLSKey: "b"},
		"bad mode":      {DataDir: "x", SocketMode: 0o4777},
	} {
		c.Defaults()
		if err := c.Validate(); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	c := Config{DataDir: "x", AgentURL: "auto"}
	c.Defaults()
	if err := c.Validate(); err != nil || !c.AgentURLAuto || c.AgentURL != "" {
		t.Errorf("auto: %v %+v", err, c)
	}
}

// TestRackoonAgentsConnect: an agent offering Rackoon's subprotocol, with a
// certificate naming Rackoon's URI prefix, is accepted.
func TestRackoonAgentsConnect(t *testing.T) {
	e := headlessEnv(t, nil)
	fa := e.enroll(e.service("pe_1|John"), "granite", "Lab")
	fa.subprotocol = LegacyAgentSubprotocol
	if _, err := fa.dial(proto.Hello{}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "connected", 3*time.Second, func() bool { return e.h.conn("granite") != nil })
}
