package hub

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/tls"
	"crypto/x509"
	"database/sql"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"image"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"rackoon/internal/hub/ca"
	"rackoon/internal/hub/model"
	"rackoon/internal/hub/store"
	"rackoon/internal/proto"
	"rackoon/internal/rules"
	"rackoon/internal/wire"
)

const adminPW = "admin password 123"

func adminEnv(t *testing.T, tweak func(*Config)) (*env, *client) {
	e := newEnv(t, tweak)
	e.addUser("john", store.RoleAdmin, adminPW)
	c := e.client()
	c.login("john", adminPW)
	return e, c
}

func TestSetupFlow(t *testing.T) {
	e := newEnv(t, nil)
	i := strings.Index(e.setupOut, "Setup token")
	if i < 0 {
		t.Fatalf("no setup token printed: %q", e.setupOut)
	}
	// The token is on the line after "Setup token ...".
	lines := strings.Split(e.setupOut[i:], "\n")
	token := strings.TrimSpace(lines[1])
	c := e.client()
	st := c.state()
	if st["setup_required"] != true || st["authenticated"] != false {
		t.Fatalf("state = %v", st)
	}
	// CSRF is required even before login.
	saved := c.csrf
	c.csrf = ""
	c.json(http.MethodPost, "/api/v1/auth/setup", map[string]string{"setup_token": token, "username": "john", "password": "long enough pw"}, 403, nil)
	c.csrf = saved
	c.json(http.MethodPost, "/api/v1/auth/setup", map[string]string{"setup_token": "wrong", "username": "john", "password": "long enough pw"}, 403, nil)
	c.json(http.MethodPost, "/api/v1/auth/setup", map[string]string{"setup_token": token, "username": "john", "password": "short"}, 400, nil)
	c.json(http.MethodPost, "/api/v1/auth/setup", map[string]string{"setup_token": token, "username": "john", "password": "long enough pw"}, 204, nil)
	st = c.state()
	if st["authenticated"] != true || st["setup_required"] != false {
		t.Fatalf("state after setup = %v", st)
	}
	if u := st["user"].(map[string]any); u["role"] != "admin" || u["name"] != "john" {
		t.Errorf("user = %v", u)
	}
	c.json(http.MethodPost, "/api/v1/auth/setup", map[string]string{"setup_token": token, "username": "x", "password": "long enough pw"}, 409, nil)
	// The setup token never reaches the log.
	if strings.Contains(e.logs.String(), token) {
		t.Error("setup token in the log")
	}
	// Logout, then the API is 401.
	c.json(http.MethodPost, "/api/v1/auth/logout", nil, 204, nil)
	c.json(http.MethodGet, "/api/v1/fleet", nil, 401, nil)
	c.state()
	c.json(http.MethodPost, "/api/v1/auth/login", map[string]string{"username": "john", "password": "nope nope nope"}, 401, nil)
	if recs := e.audit("auth.login"); len(recs) != 1 || recs[0].Outcome != "denied" {
		t.Errorf("login audit = %s", fmtRecs(recs))
	}
}

// An account created outside the UI (`whombat-hosts user add`) while the hub
// runs ends first-run setup: the UI shows the login page, not /setup.
func TestSetupEndsWhenAccountAddedFromCLI(t *testing.T) {
	e := newEnv(t, nil)
	c := e.client()
	if st := c.state(); st["setup_required"] != true {
		t.Fatalf("state = %v", st)
	}
	e.addUser("john", store.RoleAdmin, "long enough pw")
	if st := c.state(); st["setup_required"] != false {
		t.Fatalf("state after user add = %v", st)
	}
	c.json(http.MethodPost, "/api/v1/auth/setup", map[string]string{"setup_token": "anything", "username": "x", "password": "long enough pw"}, 409, nil)
	c.login("john", "long enough pw")
}

func TestCSRF(t *testing.T) {
	e, c := adminEnv(t, nil)
	good := c.csrf
	c.csrf = ""
	code, b, _ := c.req(http.MethodPost, "/api/v1/enrollments", map[string]any{}, nil)
	if code != 403 || !strings.Contains(string(b), `"csrf"`) {
		t.Errorf("no token: %d %s", code, b)
	}
	c.csrf = "wrong"
	if code, _, _ := c.req(http.MethodPost, "/api/v1/enrollments", map[string]any{}, nil); code != 403 {
		t.Errorf("wrong token: %d", code)
	}
	// A token from another session does not work either.
	other := e.client()
	other.login("john", adminPW)
	c.csrf = other.csrf
	if code, _, _ := c.req(http.MethodPost, "/api/v1/enrollments", map[string]any{}, nil); code != 403 {
		t.Errorf("other session's token: %d", code)
	}
	c.csrf = good
	if code, _, _ := c.req(http.MethodPost, "/api/v1/enrollments", map[string]any{}, map[string]string{"Origin": "https://evil.example"}); code != 403 {
		t.Errorf("foreign origin with a valid token: %d", code)
	}
	if code, b, _ := c.req(http.MethodPost, "/api/v1/enrollments", map[string]any{}, nil); code != 201 {
		t.Errorf("valid token: %d %s", code, b)
	}
}

func TestEnrollmentFlowAndRevocation(t *testing.T) {
	e, admin := adminEnv(t, nil)
	var en struct {
		ID             string `json:"id"`
		Token          string `json:"token"`
		InstallCommand string `json:"install_command"`
	}
	admin.json(http.MethodPost, "/api/v1/enrollments", map[string]any{}, 201, &en)
	if !strings.Contains(en.InstallCommand, "/install.sh | sudo sh -s -- --token "+en.Token) {
		t.Errorf("install command = %q", en.InstallCommand)
	}
	// The install script has the agent URL and CA pin baked in.
	code, script, hdr := admin.req(http.MethodGet, "/install.sh", nil, nil)
	if code != 200 || !strings.Contains(string(script), "CA_SHA256='"+e.h.ca.Pin+"'") ||
		!strings.Contains(string(script), "\"$AGENT\" enroll --hub \"$HUB_URL\" --ca-sha256 \"$CA_SHA256\" --token -") ||
		!strings.Contains(string(script), "ExecStart=/usr/local/bin/whombat-agent run") || hdr.Get("Cache-Control") != "no-store" {
		t.Errorf("install.sh = %d\n%s", code, script)
	}

	hc := e.agentHTTP(nil)
	_, csr := newKey(t)
	post := func(token string) (*http.Response, map[string]string) {
		body, _ := json.Marshal(map[string]string{"token": token, "csr": string(csr), "hostname": "thetitan", "os": "Debian 13"})
		resp, err := hc.Post(e.agent.URL+"/agent/v1/enroll", "application/json", bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var m map[string]string
		json.NewDecoder(resp.Body).Decode(&m)
		return resp, m
	}
	if resp, m := post("bogus"); resp.StatusCode != 401 || m["code"] != "invalid_token" {
		t.Fatalf("bogus token: %d %v", resp.StatusCode, m)
	}
	resp, m := post(en.Token)
	if resp.StatusCode != 202 || m["enrollment_id"] != en.ID || m["poll_secret"] == "" {
		t.Fatalf("enroll: %d %v", resp.StatusCode, m)
	}
	if resp, _ := post(en.Token); resp.StatusCode != 401 {
		t.Errorf("token reuse: %d", resp.StatusCode)
	}
	poll := func(secret string) (int, map[string]string) {
		req, _ := http.NewRequest(http.MethodGet, e.agent.URL+"/agent/v1/enroll/"+en.ID, nil)
		req.Header.Set("Authorization", "Bearer "+secret)
		resp, err := hc.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var m map[string]string
		json.NewDecoder(resp.Body).Decode(&m)
		return resp.StatusCode, m
	}
	if code, m := poll(m["poll_secret"]); code != 202 || m["state"] != "pending" {
		t.Errorf("poll pending: %d %v", code, m)
	}
	if code, _ := poll("wrong"); code != 404 {
		t.Errorf("poll with a wrong secret: %d", code)
	}
	var pending []map[string]any
	admin.json(http.MethodGet, "/api/v1/enrollments?state=pending", nil, 200, &pending)
	if len(pending) != 1 || pending[0]["hostname"] != "thetitan" {
		t.Fatalf("pending = %v", pending)
	}
	var ap map[string]string
	admin.json(http.MethodPost, "/api/v1/enrollments/"+en.ID+"/approve", map[string]string{"group": "Lab", "name": "The Titan"}, 200, &ap)
	if ap["server_id"] != "the-titan" {
		t.Errorf("server id = %q", ap["server_id"])
	}
	code, pm := poll(m["poll_secret"])
	if code != 200 || pm["state"] != "approved" || pm["server_id"] != "the-titan" {
		t.Fatalf("poll approved: %d %v", code, pm)
	}
	b, _ := pem.Decode([]byte(pm["certificate"]))
	cert, _ := x509.ParseCertificate(b.Bytes)
	if cert.Subject.CommonName != "the-titan" || len(cert.URIs) != 1 || cert.URIs[0].String() != "whombat:server:the-titan" ||
		cert.NotAfter.Sub(time.Now()) < 29*24*time.Hour || cert.NotAfter.Sub(time.Now()) > 31*24*time.Hour {
		t.Errorf("certificate: CN=%s URIs=%v NotAfter=%v", cert.Subject.CommonName, cert.URIs, cert.NotAfter)
	}
	if pin, _ := ca.PinOf([]byte(pm["ca"])); pin != e.h.ca.Pin {
		t.Error("CA in the poll answer does not match the pin")
	}
	var settings map[string]any
	admin.json(http.MethodGet, "/api/v1/servers/the-titan/settings", nil, 200, &settings)
	rc := settings["remote_control"].(map[string]any)
	if rc["console"] != false || rc["power"] != false || settings["group"] != "Lab" {
		t.Errorf("new server settings = %v (remote control must be off)", settings)
	}

	// Connect with the issued certificate, then revoke by deleting the server.
	fa := e.enroll(admin, "basalt", "Production")
	if code, err := fa.dial(proto.Hello{}); err != nil {
		t.Fatalf("connect: %d %v", code, err)
	}
	waitFor(t, "connected", 2*time.Second, func() bool { return e.h.conn("basalt") != nil })
	admin.json(http.MethodDelete, "/api/v1/servers/basalt", nil, 204, nil)
	waitFor(t, "disconnect", 3*time.Second, func() bool { return fa.sess.IsClosed() })
	if code, err := fa.dial(proto.Hello{}); err == nil || code != 403 {
		t.Errorf("revoked certificate accepted: %d %v", code, err)
	}
	if recs := e.audit("server.deleted"); len(recs) != 1 {
		t.Errorf("audit = %s", fmtRecs(recs))
	}
}

func TestCertificateRenewalRevokesOldSerial(t *testing.T) {
	e, admin := adminEnv(t, nil)
	fa := e.enroll(admin, "granite", "Production")
	_, csr := newKey(t)
	if _, err := fa.dial(proto.Hello{CSR: csr}); err != nil {
		t.Fatal(err)
	}
	if len(fa.ack.Certificate) == 0 {
		t.Fatal("no renewed certificate in hello_ack")
	}
	b, _ := pem.Decode(fa.ack.Certificate)
	nc, _ := x509.ParseCertificate(b.Bytes)
	srv, _ := e.h.store.GetServer(context.Background(), "granite")
	if srv.CertSerial != ca.SerialHex(nc.SerialNumber) {
		t.Fatal("store does not have the renewed serial")
	}
	fa.sess.Close()
	// Lost HelloAck: the old certificate keeps working until the renewed one
	// is used.
	if _, err := fa.dial(proto.Hello{}); err != nil {
		t.Fatalf("old certificate refused before the renewed one was used: %v", err)
	}
	fa.sess.Close()
	kb, _ := x509.MarshalPKCS8PrivateKey(fa.key)
	oldCert := fa.cert
	// (The renewal CSR used a new key; build the renewed certificate with it.)
	newKey := csrKeys[string(csr)]
	nkb, _ := x509.MarshalPKCS8PrivateKey(newKey)
	renewed, err := tls.X509KeyPair(fa.ack.Certificate, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: nkb}))
	if err != nil {
		t.Fatal(err)
	}
	_ = kb
	fa.cert = renewed
	waitFor(t, "detach", 2*time.Second, func() bool { return e.h.conn("granite") == nil })
	if _, err := fa.dial(proto.Hello{}); err != nil {
		t.Fatalf("renewed certificate refused: %v", err)
	}
	fa.sess.Close()
	waitFor(t, "detach", 2*time.Second, func() bool { return e.h.conn("granite") == nil })
	// Now the old serial is refused.
	fa.cert = oldCert
	if code, err := fa.dial(proto.Hello{}); err == nil || code != 403 {
		t.Errorf("old serial accepted after the renewed one was used: %d %v", code, err)
	}
}

func TestProtocolVersionRejected(t *testing.T) {
	e, admin := adminEnv(t, nil)
	fa := e.enroll(admin, "flint", "Edge")
	if _, err := fa.dial(proto.Hello{ProtocolVersion: 99}); err == nil || !strings.Contains(err.Error(), "unsupported protocol version") {
		t.Errorf("err = %v", err)
	}
}

// setupConsoleHost enrolls basalt, connects, reports and enables remote control.
func setupConsoleHost(t *testing.T, e *env, admin *client) *fakeAgent {
	fa := e.enroll(admin, "basalt", "Production")
	if _, err := fa.dial(proto.Hello{}); err != nil {
		t.Fatal(err)
	}
	fa.send(proto.MsgReport, fa.report("basalt"))
	waitFor(t, "report", 3*time.Second, func() bool {
		st, ok := e.h.snapshotOne("basalt")
		return ok && st.Report != nil
	})
	admin.json(http.MethodPatch, "/api/v1/servers/basalt", map[string]any{"remote_control": map[string]bool{"console": true, "power": true}}, 200, nil)
	return fa
}

type consoleResp struct {
	SessionID string `json:"session_id"`
	URL       string `json:"url"`
	Token     string `json:"token"`
	Protocol  string `json:"protocol"`
	ExpiresAt string `json:"expires_at"`
	IdleS     int    `json:"idle_timeout_s"`
}

func (c *client) dialConsole(url, token, origin string) (*websocket.Conn, *http.Response, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if origin == "" {
		origin = c.e.ui.URL
	}
	protos := []string{ConsoleSubprotocol}
	if token != "" {
		protos = append(protos, TokenSubprotoPfx+token)
	}
	return websocket.Dial(ctx, strings.Replace(c.e.ui.URL, "http://", "ws://", 1)+url, &websocket.DialOptions{
		HTTPClient: c.c, Subprotocols: protos, HTTPHeader: http.Header{"Origin": []string{origin}},
	})
}

func readFrame(t *testing.T, c *websocket.Conn) wire.Frame {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	typ, b, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if typ != websocket.MessageBinary {
		t.Fatalf("message type %v", typ)
	}
	f, err := wire.DecodeWS(b)
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func control(t *testing.T, f wire.Frame) wire.ConsoleControl {
	t.Helper()
	if f.Kind != wire.FrameControl {
		t.Fatalf("expected a control frame, got kind %d %q", f.Kind, f.Payload)
	}
	var cc wire.ConsoleControl
	json.Unmarshal(f.Payload, &cc)
	return cc
}

func sendWS(t *testing.T, c *websocket.Conn, f wire.Frame) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := c.Write(ctx, websocket.MessageBinary, wire.EncodeWS(f)); err != nil {
		t.Fatal(err)
	}
}

// TestEndToEndConsole: fake agent (yamux client) reports, then a browser
// opens a console through a real WebSocket.
func TestEndToEndConsole(t *testing.T) {
	e, admin := adminEnv(t, nil)
	fa := setupConsoleHost(t, e, admin)

	var fleet struct {
		Servers []struct {
			ID, Status string
		}
		AgentsConnected int `json:"agents_connected"`
	}
	admin.json(http.MethodGet, "/api/v1/fleet", nil, 200, &fleet)
	if len(fleet.Servers) != 1 || fleet.Servers[0].Status != "warning" || fleet.AgentsConnected != 1 {
		t.Fatalf("fleet = %+v", fleet)
	}
	var detail map[string]any
	admin.json(http.MethodGet, "/api/v1/servers/basalt?range=1h", nil, 200, &detail)
	if rc := detail["server"].(map[string]any)["remote_control"].(map[string]any); rc["console"] != true {
		t.Fatalf("remote control = %v", rc)
	}

	var cr consoleResp
	admin.json(http.MethodPost, "/api/v1/servers/basalt/guests/incus:dev-shell/console-sessions", map[string]any{}, 201, &cr)
	if cr.Protocol != "shell" || !strings.HasPrefix(cr.SessionID, "cs_") || cr.URL != "/api/v1/console/"+cr.SessionID ||
		len(cr.Token) < 43 || cr.IdleS != 900 {
		t.Fatalf("session = %+v", cr)
	}
	ws, resp, err := admin.dialConsole(cr.URL, cr.Token, "")
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer ws.CloseNow()
	if resp.Header.Get("Sec-WebSocket-Protocol") != ConsoleSubprotocol {
		t.Errorf("negotiated subprotocol %q", resp.Header.Get("Sec-WebSocket-Protocol"))
	}
	st := control(t, readFrame(t, ws))
	if st.Type != "status" || st.State != "connected" || st.Protocol != "shell" || st.Resolution != "80x24" {
		t.Errorf("status = %+v", st)
	}
	sendWS(t, ws, wire.Frame{Kind: wire.FrameData, Payload: []byte("ls\r")})
	if f := readFrame(t, ws); f.Kind != wire.FrameData || string(f.Payload) != "echo:ls\r" {
		t.Errorf("echo = %d %q", f.Kind, f.Payload)
	}
	// activity is consumed by the hub; resize and ping reach the agent.
	b, _ := json.Marshal(wire.ConsoleControl{Type: "activity"})
	sendWS(t, ws, wire.Frame{Kind: wire.FrameControl, Payload: b})
	b, _ = json.Marshal(wire.ConsoleControl{Type: "resize", Cols: 120, Rows: 40})
	sendWS(t, ws, wire.Frame{Kind: wire.FrameControl, Payload: b})
	b, _ = json.Marshal(wire.ConsoleControl{Type: "ping", ID: 7})
	sendWS(t, ws, wire.Frame{Kind: wire.FrameControl, Payload: b})
	if pong := control(t, readFrame(t, ws)); pong.Type != "pong" || pong.ID != 7 {
		t.Errorf("pong = %+v", pong)
	}
	fa.mu.Lock()
	var types []string
	for _, cc := range fa.controls {
		types = append(types, cc.Type)
	}
	fa.mu.Unlock()
	if strings.Join(types, ",") != "resize,ping" {
		t.Errorf("controls at the agent = %v (activity must not be forwarded)", types)
	}
	ws.Close(websocket.StatusNormalClosure, "")
	waitFor(t, "console.closed audit", 5*time.Second, func() bool { return len(e.audit("console.closed")) == 1 })
	closed := e.audit("console.closed")[0]
	if closed.BytesIn == nil || *closed.BytesIn != 3 || closed.BytesOut == nil || *closed.BytesOut != 8 || closed.DurationS == nil ||
		closed.User != "john" || closed.Protocol != "shell" || closed.Guest != "incus:dev-shell" {
		t.Errorf("console.closed = %+v", closed)
	}
	for _, ev := range []string{"console.requested", "console.opened"} {
		if recs := e.audit(ev); len(recs) != 1 || recs[0].Outcome != "ok" {
			t.Errorf("%s audit = %s", ev, fmtRecs(recs))
		}
	}
	// No token anywhere in the logs or the audit log.
	if strings.Contains(e.logs.String(), cr.Token) {
		t.Error("console token in the hub log")
	}
	all, _, _ := e.h.store.ListAudit(context.Background(), 1000, 0, store.AuditFilter{})
	ab, _ := json.Marshal(all)
	if strings.Contains(string(ab), cr.Token) {
		t.Error("console token in the audit log")
	}
}

func TestConsoleTokenRules(t *testing.T) {
	e, admin := adminEnv(t, func(c *Config) { c.ConsoleTokenTTL = 1500 * time.Millisecond })
	setupConsoleHost(t, e, admin)
	e.addUser("olivia", store.RoleOperator, "operator password")
	op := e.client()
	op.login("olivia", "operator password")
	newSession := func(c *client, guest string) consoleResp {
		var cr consoleResp
		c.json(http.MethodPost, "/api/v1/servers/basalt/guests/"+guest+"/console-sessions", map[string]any{}, 201, &cr)
		return cr
	}
	expectRefused := func(c *client, url, token, origin string, want int, code string) {
		t.Helper()
		ws, resp, err := c.dialConsole(url, token, origin)
		if err == nil {
			ws.CloseNow()
			t.Fatalf("upgrade accepted (want %d %s)", want, code)
		}
		if resp == nil || resp.StatusCode != want {
			t.Fatalf("status = %v, want %d", resp, want)
		}
	}
	// Foreign Origin.
	a := newSession(admin, "incus:dev-shell")
	expectRefused(admin, a.URL, a.Token, "https://evil.example", 403, "bad_origin")
	// Missing token subprotocol.
	expectRefused(admin, a.URL, "", "", 400, "subprotocol")
	// Bound to the user: another user cannot use it.
	expectRefused(op, a.URL, a.Token, "", 403, "invalid_token")
	// Bound to the browser session: the same user's other session cannot use it.
	admin2 := e.client()
	admin2.login("john", adminPW)
	expectRefused(admin2, a.URL, a.Token, "", 403, "invalid_token")
	// Bound to the session/guest: the token of A does not open session B.
	b := newSession(admin, "incus:git-mirror")
	expectRefused(admin, b.URL, a.Token, "", 403, "invalid_token")
	// Single use.
	ws, _, err := admin.dialConsole(a.URL, a.Token, "")
	if err != nil {
		t.Fatal(err)
	}
	readFrame(t, ws)
	expectRefused(admin, a.URL, a.Token, "", 403, "token_used")
	ws.CloseNow()
	// Expiry (TTL 1.5 s in this test; 30 s by default).
	time.Sleep(1600 * time.Millisecond)
	expectRefused(admin, b.URL, b.Token, "", 403, "token_expired")
	denied := e.audit("console.denied")
	if len(denied) < 5 {
		t.Errorf("denied upgrades must be audited: %s", fmtRecs(denied))
	}
}

func TestRoleChecksAndDeniedAudit(t *testing.T) {
	e, admin := adminEnv(t, nil)
	setupConsoleHost(t, e, admin)
	e.addUser("vera", store.RoleViewer, "viewer password")
	v := e.client()
	v.login("vera", "viewer password")
	v.json(http.MethodGet, "/api/v1/fleet", nil, 200, nil)
	v.json(http.MethodGet, "/api/v1/servers/basalt", nil, 200, nil)
	var found struct {
		Guests []struct{ Server, ID string }
		Total  int
	}
	v.json(http.MethodGet, "/api/v1/guests?q=dev-sh", nil, 200, &found)
	if found.Total != 1 || found.Guests[0].Server != "basalt" || found.Guests[0].ID != "incus:dev-shell" {
		t.Errorf("guest search = %+v", found)
	}
	for _, p := range []string{"/api/v1/audit", "/api/v1/agents", "/api/v1/enrollments", "/api/v1/servers/basalt/settings"} {
		v.json(http.MethodGet, p, nil, 403, nil)
	}
	v.json(http.MethodPost, "/api/v1/enrollments", map[string]any{}, 403, nil)
	v.json(http.MethodPatch, "/api/v1/servers/basalt", map[string]any{"group": "x"}, 403, nil)
	v.json(http.MethodDelete, "/api/v1/servers/basalt", nil, 403, nil)

	code, b, _ := v.req(http.MethodPost, "/api/v1/servers/basalt/guests/incus:dev-shell/console-sessions", map[string]any{}, nil)
	if code != 403 || !strings.Contains(string(b), "insufficient_role") {
		t.Errorf("viewer console: %d %s", code, b)
	}
	code, _, _ = v.req(http.MethodPost, "/api/v1/servers/basalt/guests/libvirt:haos/actions", map[string]any{"action": "start"}, nil)
	if code != 403 {
		t.Errorf("viewer action: %d", code)
	}
	code, _, _ = v.req(http.MethodGet, "/api/v1/servers/basalt/guests/libvirt:haos/thumbnail", nil, nil)
	if code != 403 {
		t.Errorf("viewer thumbnail: %d", code)
	}
	for ev, n := range map[string]int{"console.denied": 1, "action.requested": 1, "screens.viewed": 1} {
		recs := e.audit(ev)
		if len(recs) != n || recs[0].Outcome != "denied" || recs[0].User != "vera" || recs[0].Code != "insufficient_role" {
			t.Errorf("%s audit = %s", ev, fmtRecs(recs))
		}
	}
	// Detail shows why the buttons are disabled.
	var d map[string]any
	v.json(http.MethodGet, "/api/v1/servers/basalt", nil, 200, &d)
	rc := d["server"].(map[string]any)["remote_control"].(map[string]any)
	if rc["console"] != false || rc["console_reason"] != "Requires operator access" {
		t.Errorf("viewer remote_control = %v", rc)
	}
}

func TestConsoleAndPowerToggles(t *testing.T) {
	e, admin := adminEnv(t, nil)
	fa := setupConsoleHost(t, e, admin)
	// Console on, power off: console works, actions refused.
	admin.json(http.MethodPatch, "/api/v1/servers/basalt", map[string]any{"remote_control": map[string]bool{"power": false}}, 200, nil)
	code, b, _ := admin.req(http.MethodPost, "/api/v1/servers/basalt/guests/libvirt:haos/actions", map[string]any{"action": "shutdown", "confirm": true}, nil)
	if code != 403 || !strings.Contains(string(b), "power_disabled") {
		t.Errorf("power off: %d %s", code, b)
	}
	var cr consoleResp
	admin.json(http.MethodPost, "/api/v1/servers/basalt/guests/incus:dev-shell/console-sessions", map[string]any{}, 201, &cr)
	// The agent's local flag wins even when the hub allows.
	fa.policy.Console = false
	fa.send(proto.MsgReport, fa.report("basalt"))
	waitFor(t, "policy", 3*time.Second, func() bool {
		st, _ := e.h.snapshotOne("basalt")
		return !st.Report.Policy.Console
	})
	code, b, _ = admin.req(http.MethodPost, "/api/v1/servers/basalt/guests/incus:dev-shell/console-sessions", map[string]any{}, nil)
	if code != 403 || !strings.Contains(string(b), "agent") {
		t.Errorf("agent flag off: %d %s", code, b)
	}
}

func TestDisablingRemoteControlClosesSessions(t *testing.T) {
	e, admin := adminEnv(t, nil)
	setupConsoleHost(t, e, admin)
	var cr consoleResp
	admin.json(http.MethodPost, "/api/v1/servers/basalt/guests/libvirt:opnsense/console-sessions", map[string]any{"protocol": "serial"}, 201, &cr)
	ws, _, err := admin.dialConsole(cr.URL, cr.Token, "")
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	readFrame(t, ws) // status
	start := time.Now()
	admin.json(http.MethodPatch, "/api/v1/servers/basalt", map[string]any{"remote_control": map[string]bool{"console": false}}, 200, nil)
	cc := control(t, readFrame(t, ws))
	if cc.Type != "closed" || cc.Reason != "remote_control_disabled" {
		t.Errorf("close = %+v", cc)
	}
	if time.Since(start) > 10*time.Second {
		t.Error("session not closed within 10 s")
	}
	// Like a browser, answer the close handshake.
	if _, _, err := ws.Read(context.Background()); websocket.CloseStatus(err) != websocket.StatusNormalClosure {
		t.Errorf("close status = %v", err)
	}
	waitFor(t, "audit", 3*time.Second, func() bool {
		r := e.audit("console.closed")
		return len(r) == 1 && r[0].Code == "remote_control_disabled"
	})
	if recs := e.audit("remote_control.disabled"); len(recs) != 1 {
		t.Errorf("remote_control.disabled audit = %s", fmtRecs(recs))
	}
}

func TestActionsRequireConfirmAndFinish(t *testing.T) {
	e, admin := adminEnv(t, nil)
	fa := setupConsoleHost(t, e, admin)
	code, b, _ := admin.req(http.MethodPost, "/api/v1/servers/basalt/guests/libvirt:haos/actions", map[string]any{"action": "force_stop"}, nil)
	if code != 400 || !strings.Contains(string(b), "confirm_required") {
		t.Fatalf("no confirm: %d %s", code, b)
	}
	code, b, _ = admin.req(http.MethodPost, "/api/v1/servers/basalt/guests/libvirt:haos/actions", map[string]any{"action": "restart", "confirm": true}, nil)
	if code != 400 || !strings.Contains(string(b), "invalid_action") {
		t.Errorf("container action on a VM: %d %s", code, b)
	}
	var ar map[string]string
	admin.json(http.MethodPost, "/api/v1/servers/basalt/guests/libvirt:haos/actions", map[string]any{"action": "shutdown", "confirm": true}, 202, &ar)
	if !strings.HasPrefix(ar["action_id"], "act_") || !strings.HasPrefix(ar["audit_id"], "au_") {
		t.Errorf("response = %v", ar)
	}
	waitFor(t, "action.finished", 5*time.Second, func() bool { return len(e.audit("action.finished")) == 1 })
	fin := e.audit("action.finished")[0]
	if fin.Outcome != "ok" || fin.Details["action"] != "shutdown" || fin.Details["action_id"] != ar["action_id"] {
		t.Errorf("finished = %+v", fin)
	}
	fa.mu.Lock()
	defer fa.mu.Unlock()
	if len(fa.actions) != 1 || fa.actions[0].Platform != "libvirt" || fa.actions[0].GuestID != "haos" || fa.actions[0].Action != "shutdown" {
		t.Errorf("agent got %+v", fa.actions)
	}
}

func TestThumbnailIsSmallJPEGAndNoStore(t *testing.T) {
	e, admin := adminEnv(t, nil)
	setupConsoleHost(t, e, admin)
	code, b, hdr := admin.req(http.MethodGet, "/api/v1/servers/basalt/guests/libvirt:haos/thumbnail", nil, nil)
	if code != 200 || hdr.Get("Content-Type") != "image/jpeg" || hdr.Get("Cache-Control") != "no-store" {
		t.Fatalf("thumbnail: %d %v", code, hdr)
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(b))
	if err != nil || format != "jpeg" || cfg.Width > 320 {
		t.Errorf("image: %v %s %dx%d", err, format, cfg.Width, cfg.Height)
	}
	if code, _, _ := admin.req(http.MethodGet, "/api/v1/servers/basalt/guests/incus:dev-shell/thumbnail", nil, nil); code != 404 {
		t.Errorf("container thumbnail: %d", code)
	}
	if code, _, _ := admin.req(http.MethodGet, "/api/v1/servers/basalt/guests/libvirt:truenas-lab/thumbnail", nil, nil); code != 409 {
		t.Errorf("stopped guest thumbnail: %d", code)
	}
	admin.req(http.MethodGet, "/api/v1/servers/basalt/guests/libvirt:haos/thumbnail", nil, nil)
	if recs := e.audit("screens.viewed"); len(recs) != 1 || recs[0].Outcome != "ok" {
		t.Errorf("screens.viewed must be recorded once per view: %s", fmtRecs(recs))
	}
}

func TestBackfillDedupeThroughAgent(t *testing.T) {
	e, admin := adminEnv(t, nil)
	fa := e.enroll(admin, "quartz", "Lab")
	if _, err := fa.dial(proto.Hello{BufferedSamples: 3}); err != nil {
		t.Fatal(err)
	}
	now := time.Now().Truncate(10 * time.Second)
	var s []proto.Sample
	for i := 0; i < 30; i++ {
		s = append(s, proto.Sample{At: now.Add(time.Duration(i-30) * 10 * time.Second), Values: map[string]float64{"cpu_pct": float64(i)}})
	}
	fa.send(proto.MsgBackfill, proto.Backfill{Samples: s})
	fa.send(proto.MsgBackfill, proto.Backfill{Samples: s[20:]}) // duplicates
	var m struct {
		Series  map[string][]*float64 `json:"series"`
		Summary map[string]*struct {
			Max float64 `json:"max"`
		} `json:"summary"`
	}
	waitFor(t, "samples", 3*time.Second, func() bool {
		admin.json(http.MethodGet, "/api/v1/servers/quartz/metrics?range=1h&series=cpu_pct", nil, 200, &m)
		n := 0
		for _, v := range m.Series["cpu_pct"] {
			if v != nil {
				n++
			}
		}
		return n >= 5 && m.Summary["cpu_pct"] != nil && m.Summary["cpu_pct"].Max == 29
	})
	var cnt int
	ids, _ := e.h.store.SeriesNames(context.Background(), "quartz")
	recs, _ := e.h.store.Buckets(context.Background(), store.TierRaw, []int64{ids["cpu_pct"]}, now.Unix()-3600, 3600, 1)
	cnt = int(recs[ids["cpu_pct"]][0].Count)
	if cnt != 30 {
		t.Errorf("stored %d samples, want 30 (duplicates ignored)", cnt)
	}
}

func TestOfflineAfterHeartbeatTimeout(t *testing.T) {
	e, admin := adminEnv(t, func(c *Config) { c.HeartbeatTimeout = 1500 * time.Millisecond })
	fa := e.enroll(admin, "marble", "Edge")
	if _, err := fa.dial(proto.Hello{}); err != nil {
		t.Fatal(err)
	}
	fa.send(proto.MsgReport, fa.report("marble"))
	var f struct {
		Servers []struct {
			Status     string  `json:"status"`
			StatusNote *string `json:"status_note"`
			Current    any     `json:"current"`
			LastKnown  any     `json:"last_known"`
		}
		Alerts []struct {
			Rule, Title string
		}
	}
	admin.json(http.MethodGet, "/api/v1/fleet", nil, 200, &f)
	if f.Servers[0].Status != "online" {
		t.Fatalf("status = %s", f.Servers[0].Status)
	}
	// No more frames: offline after the timeout, with the heartbeat alert.
	waitFor(t, "offline", 6*time.Second, func() bool {
		admin.json(http.MethodGet, "/api/v1/fleet", nil, 200, &f)
		return f.Servers[0].Status == "offline" && len(f.Alerts) == 1
	})
	if *f.Servers[0].StatusNote != "not checking in" || f.Servers[0].Current != nil || f.Servers[0].LastKnown == nil ||
		f.Alerts[0].Rule != "agent.heartbeat_missing" || f.Alerts[0].Title != "Whombat’s helper isn’t checking in" {
		t.Errorf("offline card = %+v alerts %+v", f.Servers[0], f.Alerts)
	}
}

func TestSecurityHeadersAndETag(t *testing.T) {
	_, admin := adminEnv(t, nil)
	code, _, hdr := admin.req(http.MethodGet, "/api/v1/fleet", nil, nil)
	if code != 200 || hdr.Get("ETag") == "" || hdr.Get("Cache-Control") != "private, no-cache" ||
		hdr.Get("X-Frame-Options") != "DENY" || hdr.Get("X-Content-Type-Options") != "nosniff" ||
		!strings.Contains(hdr.Get("Content-Security-Policy"), "frame-ancestors 'none'") ||
		!strings.Contains(hdr.Get("Content-Security-Policy"), "img-src 'self' blob:") {
		t.Fatalf("headers = %v", hdr)
	}
	code, _, _ = admin.req(http.MethodGet, "/api/v1/servers", nil, nil)
	_, _, h2 := admin.req(http.MethodGet, "/api/v1/servers", nil, nil)
	code, _, _ = admin.req(http.MethodGet, "/api/v1/servers", nil, map[string]string{"If-None-Match": h2.Get("ETag")})
	if code != http.StatusNotModified {
		t.Errorf("If-None-Match: %d", code)
	}
	code, b, hdr := admin.req(http.MethodGet, "/api/v1/servers/nope", nil, nil)
	if code != 404 || hdr.Get("Content-Type") != "application/problem+json" || !strings.Contains(string(b), `"code":"server_not_found"`) {
		t.Errorf("problem: %d %s %v", code, b, hdr.Get("Content-Type"))
	}
}

func TestLogRedaction(t *testing.T) {
	var buf syncBuffer
	log := NewLogger(&buf, 0, false)
	log.Info("x", "token", "abc123secret", "url", "/x?token=abc123secret", "hdr", "Bearer abc123secret",
		"proto", "rackoon.token.abc123secret", "password", "hunter2")
	log.Info("upgrade with rackoon.token.abc123secret")
	if s := buf.String(); strings.Contains(s, "abc123secret") || strings.Contains(s, "hunter2") {
		t.Errorf("secret in log: %s", s)
	}
}

func TestConsoleLimitsAndSwitch(t *testing.T) {
	e, admin := adminEnv(t, nil)
	setupConsoleHost(t, e, admin)
	var first consoleResp
	admin.json(http.MethodPost, "/api/v1/servers/basalt/guests/incus:dev-shell/console-sessions", map[string]any{}, 201, &first)
	for i := 0; i < 4; i++ {
		admin.json(http.MethodPost, "/api/v1/servers/basalt/guests/incus:dns/console-sessions", map[string]any{}, 201, nil)
	}
	code, b, _ := admin.req(http.MethodPost, "/api/v1/servers/basalt/guests/incus:dns/console-sessions", map[string]any{}, nil)
	if code != 429 || !strings.Contains(string(b), "session_limit") {
		t.Fatalf("6th session: %d %s", code, b)
	}
	// Switching from an existing session does not count against the limit.
	var sw consoleResp
	admin.json(http.MethodPost, "/api/v1/servers/basalt/guests/incus:git-mirror/console-sessions",
		map[string]any{"switch_from": first.SessionID}, 201, &sw)
	recs := e.audit("console.switched")
	if len(recs) != 1 || recs[0].Details["from_guest"] != "incus:dev-shell" || recs[0].Guest != "incus:git-mirror" {
		t.Errorf("switch audit = %s %+v", fmtRecs(recs), recs)
	}
	// The switched-from token is gone.
	if ws, _, err := admin.dialConsole(first.URL, first.Token, ""); err == nil {
		ws.CloseNow()
		t.Error("switched-from session still usable")
	}
}

func TestScreenshotAudited(t *testing.T) {
	e, admin := adminEnv(t, nil)
	setupConsoleHost(t, e, admin)
	code, b, hdr := admin.req(http.MethodGet, "/api/v1/servers/basalt/guests/libvirt:haos/screenshot", nil, nil)
	// The fake agent answers with a JPEG: the hub refuses non-PNG screenshots.
	if code != 502 || !strings.Contains(string(b), "agent_error") {
		t.Errorf("non-PNG screenshot: %d %s %v", code, b, hdr)
	}
	if recs := e.audit("console.screenshot"); len(recs) != 1 || recs[0].Outcome != "error" {
		t.Errorf("audit = %s", fmtRecs(recs))
	}
}

func TestEventsReplay(t *testing.T) {
	e, admin := adminEnv(t, nil)
	first := e.h.bus.LastID()
	e.h.bus.Publish("server.settings_changed", map[string]string{"id": "x"})
	e.h.bus.Publish("server.settings_changed", map[string]string{"id": "y"})
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, e.ui.URL+"/api/v1/events", nil)
	req.Header.Set("Last-Event-ID", strconv.FormatUint(first+1, 10))
	resp, err := admin.c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("content type %q", resp.Header.Get("Content-Type"))
	}
	buf := make([]byte, 4096)
	var got string
	for !strings.Contains(got, `"y"`) {
		n, err := resp.Body.Read(buf)
		if err != nil {
			break
		}
		got += string(buf[:n])
	}
	if !strings.Contains(got, "retry: 5000") || strings.Contains(got, `"x"`) || !strings.Contains(got, `{"id":"y"}`) {
		t.Errorf("stream = %q", got)
	}
	// An id from a previous run (older than the buffer) asks for a resync.
	ctx2, cancel2 := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel2()
	req, _ = http.NewRequestWithContext(ctx2, http.MethodGet, e.ui.URL+"/api/v1/events", nil)
	req.Header.Set("Last-Event-ID", "5")
	resp2, err := admin.c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	n, _ := resp2.Body.Read(buf)
	got = string(buf[:n])
	for !strings.Contains(got, "resync") {
		n, err := resp2.Body.Read(buf)
		if err != nil {
			break
		}
		got += string(buf[:n])
	}
	if !strings.Contains(got, "event: resync") {
		t.Errorf("no resync: %q", got)
	}
}

func TestFleetSeriesShape(t *testing.T) {
	e, admin := adminEnv(t, nil)
	fa := e.enroll(admin, "onyx", "Lab")
	if _, err := fa.dial(proto.Hello{}); err != nil {
		t.Fatal(err)
	}
	fa.send(proto.MsgReport, fa.report("onyx"))
	waitFor(t, "report", 3*time.Second, func() bool {
		st, _ := e.h.snapshotOne("onyx")
		return st.Report != nil
	})
	for _, rng := range []string{"1h", "6h", "24h", "7d", "30d"} {
		var fs struct {
			Range string
			Kpi   struct {
				StepS      int64      `json:"step_s"`
				Timestamps []string   `json:"timestamps"`
				CPU        []*float64 `json:"cpu_pct"`
				Mem        []*float64 `json:"mem_pct"`
			}
			Servers map[string]struct {
				CPU []*float64 `json:"cpu_pct"`
			}
			Heatmap struct {
				Buckets int                   `json:"buckets"`
				BucketS int64                 `json:"bucket_s"`
				CPU     map[string][]*float64 `json:"cpu_pct"`
			}
		}
		admin.json(http.MethodGet, "/api/v1/fleet/series?range="+rng+"&group=Lab", nil, 200, &fs)
		spec := store.Ranges[rng]
		if fs.Range != rng || len(fs.Kpi.CPU) != 60 || len(fs.Kpi.Timestamps) != 60 || fs.Kpi.StepS != int64(spec.Dur/time.Second)/60 ||
			fs.Heatmap.Buckets != 48 || len(fs.Heatmap.CPU["onyx"]) != 48 || fs.Heatmap.BucketS != int64(spec.Dur/time.Second)/48 ||
			len(fs.Servers["onyx"].CPU) != 60 {
			t.Errorf("%s: %+v", rng, fs)
		}
	}
	// 1h: the newest bucket has the report's value.
	var fs struct {
		Kpi struct {
			CPU []*float64 `json:"cpu_pct"`
		}
	}
	admin.json(http.MethodGet, "/api/v1/fleet/series?range=1h", nil, 200, &fs)
	if fs.Kpi.CPU[59] == nil {
		t.Error("1h sparkline misses the newest sample")
	}
}

func TestUntrustedReportIsSanitized(t *testing.T) {
	e, admin := adminEnv(t, nil)
	fa := e.enroll(admin, "obsidian", "Production")
	if _, err := fa.dial(proto.Hello{}); err != nil {
		t.Fatal(err)
	}
	r := fa.report("obsidian")
	nan := math.NaN()
	inf := math.Inf(1)
	r.CPU.UsagePct = nan
	r.Sensors[0].TempC = inf
	r.Incus.Guests[0].CPUPct = &nan
	r.Incus.Guests = append(r.Incus.Guests, r.Incus.Guests[0]) // duplicate id
	r.Host.CPUModel = strings.Repeat("x", 10000)
	fa.send(proto.MsgReport, r)
	waitFor(t, "report", 3*time.Second, func() bool {
		st, _ := e.h.snapshotOne("obsidian")
		return st.Report != nil
	})
	var d map[string]any
	admin.json(http.MethodGet, "/api/v1/servers/obsidian", nil, 200, &d)
	admin.json(http.MethodGet, "/api/v1/fleet", nil, 200, nil)
	if m := d["server"].(map[string]any)["cpu"].(map[string]any)["model"].(string); len(m) > 128 {
		t.Errorf("cpu model not truncated: %d", len(m))
	}
	var gl struct {
		Total int `json:"total"`
	}
	admin.json(http.MethodGet, "/api/v1/servers/obsidian/guests?platform=incus", nil, 200, &gl)
	if gl.Total != 13 {
		t.Errorf("duplicate guest kept: %d", gl.Total)
	}
}

func TestFleetGuestList(t *testing.T) {
	e, admin := adminEnv(t, nil)
	setupConsoleHost(t, e, admin) // basalt: 27 guests
	shale := e.enroll(admin, "shale", "Production")
	if _, err := shale.dial(proto.Hello{}); err != nil {
		t.Fatal(err)
	}
	shale.send(proto.MsgReport, shale.report("shale")) // 26 Proxmox guests
	waitFor(t, "shale report", 3*time.Second, func() bool {
		st, ok := e.h.snapshotOne("shale")
		return ok && st.Report != nil
	})
	type page struct {
		Guests []struct {
			Server       string `json:"server"`
			ServerOnline bool   `json:"server_online"`
			ID           string `json:"id"`
			Platform     string `json:"platform"`
			Kind         string `json:"kind"`
			State        string `json:"state"`
		} `json:"guests"`
		Total      int                                            `json:"total"`
		NextCursor *string                                        `json:"next_cursor"`
		Counts     struct{ All, Running, Stopped, Unhealthy int } `json:"counts"`
		Platforms  map[string]int                                 `json:"platforms"`
	}
	get := func(query string) page {
		t.Helper()
		var p page
		admin.json(http.MethodGet, "/api/v1/guests"+query, nil, 200, &p)
		return p
	}
	all := get("") // basalt's self guest "whombat" is the 54th (fakefleet incus.go)
	if all.Total != 54 || len(all.Guests) != 54 || all.NextCursor != nil {
		t.Fatalf("all: total %d, %d guests, cursor %v", all.Total, len(all.Guests), all.NextCursor)
	}
	if c := all.Counts; c.All != 54 || c.Running != 46 || c.Stopped != 8 || c.Unhealthy != 0 {
		t.Errorf("counts = %+v", c)
	}
	if p := all.Platforms; len(p) != 4 || p["docker"] != 16 || p["incus"] != 8 || p["libvirt"] != 4 || p["pve"] != 26 {
		t.Errorf("platforms = %v", p)
	}
	for _, g := range all.Guests {
		if (g.Server != "basalt" && g.Server != "shale") || !g.ServerOnline {
			t.Errorf("guest %+v", g)
		}
	}
	stopped := get("?state=stopped")
	if stopped.Total != 8 || len(stopped.Guests) != 8 || stopped.Counts.All != 54 || stopped.Platforms["pve"] != 26 {
		t.Errorf("stopped: total %d, %d guests, counts %+v", stopped.Total, len(stopped.Guests), stopped.Counts)
	}
	for _, g := range stopped.Guests {
		if g.State != "stopped" {
			t.Errorf("stopped filter: %+v", g)
		}
	}
	srv := get("?server=shale")
	if srv.Total != 26 || srv.Counts.All != 26 || srv.Counts.Running != 22 || len(srv.Platforms) != 1 || srv.Platforms["pve"] != 26 {
		t.Errorf("shale: total %d, counts %+v, platforms %v", srv.Total, srv.Counts, srv.Platforms)
	}
	ct := get("?platform=pve&kind=container")
	if ct.Total != 4 || len(ct.Guests) != 4 || ct.Counts.All != 54 {
		t.Errorf("pve containers: total %d, counts %+v", ct.Total, ct.Counts)
	}
	for _, g := range ct.Guests {
		if g.Platform != "pve" || g.Kind != "container" || g.Server != "shale" {
			t.Errorf("pve container filter: %+v", g)
		}
	}
	for q, code := range map[string]string{"state=bogus": "invalid_state", "platform=bogus": "invalid_platform", "kind=bogus": "invalid_kind"} {
		if c, b, _ := admin.req(http.MethodGet, "/api/v1/guests?"+q, nil, nil); c != 400 || !strings.Contains(string(b), code) {
			t.Errorf("%s: %d %s", q, c, b)
		}
	}
	// Cursor paging walks the whole list exactly once.
	seen := map[string]bool{}
	cursor := ""
	for pages := 0; ; pages++ {
		p := get("?limit=2&cursor=" + cursor)
		if p.Total != 54 || len(p.Guests) > 2 || (p.NextCursor != nil && len(p.Guests) != 2) {
			t.Fatalf("page %d: total %d, %d guests", pages, p.Total, len(p.Guests))
		}
		for _, g := range p.Guests {
			if k := g.Server + "/" + g.ID; seen[k] {
				t.Errorf("%s listed twice", k)
			} else {
				seen[k] = true
			}
		}
		if p.NextCursor == nil {
			break
		}
		if pages > 30 {
			t.Fatal("paging does not end")
		}
		cursor = *p.NextCursor
	}
	if len(seen) != 54 {
		t.Errorf("paged through %d guests", len(seen))
	}
}

// A connection that was made before its certificate's renewal window opened
// is closed by the hub, so the reconnect's handshake renews the certificate
// (agents without their own renewal timer would otherwise expire).
func TestHubNudgesRenewalOnLongConnection(t *testing.T) {
	e, admin := adminEnv(t, nil)
	fa := e.enroll(admin, "granite", "Production")
	if _, err := fa.dial(proto.Hello{}); err != nil {
		t.Fatal(err)
	}
	c := e.h.conn("granite")
	if c == nil {
		t.Fatal("not connected")
	}
	// Pretend the connection is a month old and the certificate expires in
	// eight days: the watchdog must close it once.
	e.h.mu.Lock() // the watchdog reads both under h.mu
	e.h.servers["granite"].meta.CertNotAfter = time.Now().Add(8 * 24 * time.Hour)
	c.connectedAt = time.Now().Add(-30 * 24 * time.Hour)
	e.h.mu.Unlock()
	waitFor(t, "nudge", 5*time.Second, func() bool {
		select {
		case <-c.Done():
			return true
		default:
			return false
		}
	})
	// A connection made inside the window stays (it offered its renewal).
	fa.sess.Close()
	waitFor(t, "detach", 2*time.Second, func() bool { return e.h.conn("granite") == nil })
	if _, err := fa.dial(proto.Hello{}); err != nil {
		t.Fatal(err)
	}
	// The hub registers the connection just after its answer.
	waitFor(t, "attach", 2*time.Second, func() bool { return e.h.conn("granite") != nil })
	c2 := e.h.conn("granite")
	time.Sleep(2500 * time.Millisecond) // more than one watchdog tick
	select {
	case <-c2.Done():
		t.Fatal("a connection made inside the renewal window was closed")
	default:
	}
}

func TestListenerCertificateIsServedFromTheHolder(t *testing.T) {
	e, _ := adminEnv(t, nil)
	first := e.h.listenerCert.notAfter()
	if first.IsZero() || time.Until(first) < 300*24*time.Hour {
		t.Fatalf("listener certificate expires %v", first)
	}
	// Renew keeps a valid certificate (the CA only reissues near expiry).
	e.h.renewListenerCert(context.Background())
	if !e.h.listenerCert.notAfter().Equal(first) {
		t.Fatal("a fresh certificate was reissued")
	}
}

func TestHealthzChecksTheDatabase(t *testing.T) {
	e, _ := adminEnv(t, nil)
	get := func() (int, string) {
		resp, err := http.Get(e.ui.URL + "/healthz")
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(b)
	}
	if code, body := get(); code != 200 || body != "ok\n" {
		t.Fatalf("healthy hub: %d %q", code, body)
	}
	e.h.store.Close()
	if code, body := get(); code != 503 || !strings.Contains(body, "database") {
		t.Fatalf("closed database: %d %q", code, body)
	}
}

func TestBackupAndRestore(t *testing.T) {
	e, admin := adminEnv(t, nil)
	e.enroll(admin, "granite", "Production")
	var buf bytes.Buffer
	if err := e.h.Backup(context.Background(), &buf); err != nil {
		t.Fatal(err)
	}
	// A second hub on the same directory is refused while the first runs.
	if _, err := lockDataDir(e.h.cfg.DataDir); err == nil {
		t.Fatal("data directory lock not held")
	}
	dir := t.TempDir()
	m, err := Restore(context.Background(), dir, bytes.NewReader(buf.Bytes()), false)
	if err != nil {
		t.Fatal(err)
	}
	if m.Schema != store.SchemaVersion() || m.HubVersion != Version {
		t.Fatalf("manifest %+v", m)
	}
	st, err := store.Open(dir + "/hub.db")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if _, err := st.GetServer(context.Background(), "granite"); err != nil {
		t.Fatalf("restored database lacks the server: %v", err)
	}
	for _, f := range []string{"ca.crt", "ca.key"} {
		a, _ := os.ReadFile(e.h.cfg.DataDir + "/" + f)
		b, _ := os.ReadFile(dir + "/" + f)
		if len(a) == 0 || !bytes.Equal(a, b) {
			t.Fatalf("%s not restored", f)
		}
	}
	// Restoring over an existing database needs force and keeps the old one.
	if _, err := Restore(context.Background(), dir, bytes.NewReader(buf.Bytes()), false); err == nil {
		t.Fatal("restore over an existing database without force")
	}
	if _, err := Restore(context.Background(), dir, bytes.NewReader(buf.Bytes()), true); err != nil {
		t.Fatal(err)
	}
	if m, _ := filepath.Glob(dir + "/hub.db.pre-restore-*.bak"); len(m) != 1 {
		t.Fatalf("previous database not kept: %v", m)
	}
	// Garbage is refused.
	if _, err := Restore(context.Background(), t.TempDir(), strings.NewReader("not a backup"), false); err == nil {
		t.Fatal("garbage accepted")
	}
}

func TestNewerSchemaRefused(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(dir + "/hub.db")
	if err != nil {
		t.Fatal(err)
	}
	st.Close()
	db, _ := sql.Open("sqlite", dir+"/hub.db")
	db.Exec(fmt.Sprintf("PRAGMA user_version = %d", store.SchemaVersion()+1))
	db.Close()
	if _, err := store.Open(dir + "/hub.db"); !errors.Is(err, store.ErrNewerSchema) {
		t.Fatalf("expected ErrNewerSchema, got %v", err)
	}
}

func TestJSONAndAssetsAreGzipped(t *testing.T) {
	e, admin := adminEnv(t, nil)
	e.enroll(admin, "granite", "Production")
	code, body, hdr := admin.req(http.MethodGet, "/api/v1/fleet", nil, map[string]string{"Accept-Encoding": "gzip"})
	if code != 200 || hdr.Get("Content-Encoding") != "gzip" {
		t.Fatalf("fleet: %d %v", code, hdr)
	}
	zr, err := gzip.NewReader(bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	plain, _ := io.ReadAll(zr)
	var f map[string]any
	if err := json.Unmarshal(plain, &f); err != nil || f["servers"] == nil {
		t.Fatalf("decoded body: %v %.80s", err, plain)
	}
	// Without Accept-Encoding the body is plain.
	_, body, hdr = admin.req(http.MethodGet, "/api/v1/fleet", nil, map[string]string{"Accept-Encoding": "identity"})
	if hdr.Get("Content-Encoding") != "" || !json.Valid(body) {
		t.Fatalf("identity: %v", hdr)
	}
}

// Ten failed sign-ins per client address within five minutes, then 429
// with Retry-After; a success does not count.
func TestLoginThrottle(t *testing.T) {
	e, _ := adminEnv(t, nil)
	c := e.client()
	c.state()
	for i := 0; i < 10; i++ {
		code, _, _ := c.req(http.MethodPost, "/api/v1/auth/login", map[string]string{"username": "john", "password": "wrong password 1"}, nil)
		if code != 401 {
			t.Fatalf("attempt %d: %d", i+1, code)
		}
	}
	code, b, hdr := c.req(http.MethodPost, "/api/v1/auth/login", map[string]string{"username": "john", "password": adminPW}, nil)
	if code != 429 || hdr.Get("Retry-After") == "" || !strings.Contains(string(b), "rate_limited") {
		t.Fatalf("11th attempt: %d %s %v", code, b, hdr)
	}
}

// Enabling remote control needs a recent sign-in; a password confirmation
// renews it.
func TestReauthForRemoteControl(t *testing.T) {
	e, admin := adminEnv(t, nil)
	e.enroll(admin, "granite", "Production")
	admin.staleSignIn()
	on := map[string]any{"remote_control": map[string]bool{"console": true}}
	code, b, _ := admin.req(http.MethodPatch, "/api/v1/servers/granite", on, nil)
	if code != 403 || !strings.Contains(string(b), "reauth_required") {
		t.Fatalf("stale session enabled remote control: %d %s", code, b)
	}
	// Turning things off needs no confirmation.
	admin.json(http.MethodPatch, "/api/v1/servers/granite", map[string]any{"location": "Rack B"}, 200, nil)
	if code, _, _ := admin.req(http.MethodPost, "/api/v1/auth/reauth", map[string]string{"password": "wrong"}, nil); code != 403 {
		t.Fatalf("wrong password confirmed: %d", code)
	}
	admin.json(http.MethodPost, "/api/v1/auth/reauth", map[string]string{"password": adminPW}, 204, nil)
	admin.json(http.MethodPatch, "/api/v1/servers/granite", on, 200, nil)
	if len(e.audit("auth.reauth")) < 2 {
		t.Error("re-authentication not audited")
	}
}

func TestAPITokensAndKiosk(t *testing.T) {
	e, admin := adminEnv(t, nil)
	e.enroll(admin, "granite", "Production")
	var tok struct {
		ID, Token, Role string
	}
	admin.json(http.MethodPost, "/api/v1/tokens", map[string]any{"name": "prometheus", "role": "viewer"}, 201, &tok)
	if !strings.HasPrefix(tok.Token, "rk_") || tok.Role != "viewer" {
		t.Fatalf("token %+v", tok)
	}
	bearer := func(method, path string, body any) int {
		var rd io.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			rd = bytes.NewReader(b)
		}
		r, _ := http.NewRequest(method, e.ui.URL+path, rd)
		r.Header.Set("Authorization", "Bearer "+tok.Token)
		resp, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	if c := bearer(http.MethodGet, "/api/v1/fleet", nil); c != 200 {
		t.Fatalf("viewer token read fleet: %d", c)
	}
	if c := bearer(http.MethodGet, "/api/v1/agents", nil); c != 403 {
		t.Fatalf("viewer token read admin endpoint: %d", c)
	}
	if c := bearer(http.MethodPost, "/api/v1/tokens", map[string]any{"name": "x"}); c != 403 {
		t.Fatalf("token minted a token: %d", c)
	}
	// Kiosk: a read-only session from the token.
	k := e.client()
	k.state()
	k.json(http.MethodPost, "/api/v1/auth/kiosk", map[string]string{"token": tok.Token}, 204, nil)
	st := k.state()
	if u, _ := st["user"].(map[string]any); u == nil || u["role"] != "viewer" {
		t.Fatalf("kiosk state %v", st)
	}
	if code, _, _ := k.req(http.MethodPost, "/api/v1/auth/password", map[string]string{"current": adminPW, "new": "another password 1"}, nil); code != 403 {
		t.Fatalf("kiosk changed the password: %d", code)
	}
	// Deleting the token ends the kiosk session and the bearer access.
	admin.json(http.MethodDelete, "/api/v1/tokens/"+tok.ID, nil, 204, nil)
	if c := bearer(http.MethodGet, "/api/v1/fleet", nil); c != 401 {
		t.Fatalf("deleted token still works: %d", c)
	}
	if code, _, _ := k.req(http.MethodGet, "/api/v1/fleet", nil, nil); code != 401 {
		t.Fatalf("kiosk session survived its token: %d", code)
	}
	// A token never exceeds its owner's role.
	e.addUser("olive", store.RoleOperator, "operator password 1")
	op := e.client()
	op.login("olive", "operator password 1")
	if code, _, _ := op.req(http.MethodPost, "/api/v1/tokens", map[string]any{"name": "x", "role": "admin"}, nil); code != 403 {
		t.Fatalf("operator minted an admin token: %d", code)
	}
}

func TestEnrollmentEventsAreAdminOnly(t *testing.T) {
	b := NewBus()
	v, _, _ := b.Subscribe(1, store.RoleRank(store.RoleViewer), 0)
	a, _, _ := b.Subscribe(2, store.RoleRank(store.RoleAdmin), 0)
	b.PublishMinRank(store.RoleRank(store.RoleAdmin), "enrollment.pending", map[string]string{"id": "en_1"})
	select {
	case <-v.C:
		t.Fatal("viewer received an admin event")
	default:
	}
	select {
	case ev := <-a.C:
		if ev.Name != "enrollment.pending" {
			t.Fatal(ev.Name)
		}
	default:
		t.Fatal("admin did not receive the event")
	}
	// At most MaxSubsPerUser streams per user: the oldest is dropped.
	first, _, _ := b.Subscribe(3, 0, 0)
	for i := 0; i < MaxSubsPerUser; i++ {
		b.Subscribe(3, 0, 0)
	}
	select {
	case <-first.Done():
	default:
		t.Fatal("oldest stream not dropped")
	}
}

func TestAlertLifecycle(t *testing.T) {
	e, admin := adminEnv(t, nil)
	fa := e.enroll(admin, "granite", "Production")
	if _, err := fa.dial(proto.Hello{}); err != nil {
		t.Fatal(err)
	}
	// A wear alert fires at once.
	rep := fa.report("granite")
	w := 80.0
	rep.Disks = []proto.Disk{{Device: "nvme0n1", Type: "nvme", WearPct: &w}}
	fa.send(proto.MsgReport, rep)
	var open []map[string]any
	waitFor(t, "alert", 3*time.Second, func() bool {
		admin.json(http.MethodGet, "/api/v1/alerts", nil, 200, &open)
		return len(open) == 1
	})
	id := open[0]["id"].(string)
	if open[0]["attention"] != true {
		t.Fatalf("new alert does not need attention: %v", open[0])
	}
	if open[0]["entity"] != "nvme0n1" || open[0]["key"] != "disk.wear_high:nvme0n1" {
		t.Fatalf("entity and key: %v", open[0])
	}
	serverStatus := func() (string, any) {
		var list []map[string]any
		admin.json(http.MethodGet, "/api/v1/servers", nil, 200, &list)
		return list[0]["status"].(string), list[0]["status_note"]
	}
	if st, note := serverStatus(); st != "warning" || note == nil {
		t.Fatalf("open alert: status %s note %v", st, note)
	}
	sub, _, _ := e.h.bus.Subscribe(0, 0, e.h.bus.LastID())
	defer e.h.bus.Unsubscribe(sub)
	// Snooze for an hour.
	var acked map[string]any
	admin.json(http.MethodPost, "/api/v1/alerts/"+id+"/ack", map[string]any{"note": "replacing friday", "minutes": 60}, 200, &acked)
	ack, _ := acked["acknowledged"].(map[string]any)
	if ack == nil || ack["by"] != "john" || ack["note"] != "replacing friday" || ack["until"] == nil || acked["attention"] != false {
		t.Fatalf("ack %v", acked)
	}
	// An acknowledged alert no longer keeps the server at warning, and the
	// change is sent at once (HS-190).
	if st, note := serverStatus(); st != "online" || note != nil {
		t.Fatalf("acknowledged: status %s note %v", st, note)
	}
	waitFor(t, "server.updated online", 3*time.Second, func() bool {
		select {
		case ev := <-sub.C:
			return ev.Name == "server.updated" && strings.Contains(string(ev.Data), `"status":"online"`)
		default:
			return false
		}
	})
	var f map[string]any
	admin.json(http.MethodGet, "/api/v1/fleet", nil, 200, &f)
	if k := f["kpis"].(map[string]any); k["open_alerts"].(float64) != 1 || k["open_alerts_attention"].(float64) != 0 {
		t.Fatalf("kpis %v", k)
	}
	// The acknowledgement survives a restart of the engine state (store).
	stored, _ := e.h.store.QueryAlerts(context.Background(), store.AlertFilter{State: "open"})
	if len(stored) != 1 || stored[0].Ack == nil || stored[0].Ack.Note != "replacing friday" {
		t.Fatalf("stored %+v", stored)
	}
	admin.json(http.MethodDelete, "/api/v1/alerts/"+id+"/ack", nil, 200, &acked)
	if acked["acknowledged"] != nil || acked["attention"] != true {
		t.Fatalf("unack %v", acked)
	}
	if st, _ := serverStatus(); st != "warning" {
		t.Fatalf("unacknowledged: status %s", st)
	}
	// Maintenance mutes the host's alerts without hiding them.
	var mw map[string]any
	admin.json(http.MethodPost, "/api/v1/maintenance", map[string]any{"scope": "server", "target": "granite", "duration_min": 60, "note": "disk swap"}, 201, &mw)
	admin.json(http.MethodGet, "/api/v1/alerts", nil, 200, &open)
	if len(open) != 1 || open[0]["muted"] != true || open[0]["attention"] != false {
		t.Fatalf("muted %v", open)
	}
	if st, _ := serverStatus(); st != "online" {
		t.Fatalf("muted: status %s", st)
	}
	var detail map[string]any
	admin.json(http.MethodGet, "/api/v1/servers/granite", nil, 200, &detail)
	if m := detail["server"].(map[string]any)["maintenance"]; m == nil || detail["banner"] != nil {
		t.Fatalf("detail maintenance %v banner %v", m, detail["banner"])
	}
	admin.json(http.MethodDelete, "/api/v1/maintenance/"+mw["id"].(string), nil, 204, nil)
	admin.json(http.MethodGet, "/api/v1/alerts", nil, 200, &open)
	if open[0]["muted"] != false {
		t.Fatal("still muted after unmute")
	}
	// Viewers cannot acknowledge.
	e.addUser("vera", store.RoleViewer, "viewer password 1")
	v := e.client()
	v.login("vera", "viewer password 1")
	if code, _, _ := v.req(http.MethodPost, "/api/v1/alerts/"+id+"/ack", map[string]any{}, nil); code != 403 {
		t.Fatalf("viewer acknowledged: %d", code)
	}
	if len(e.audit("alert.acknowledged")) != 1 || len(e.audit("maintenance.created")) != 1 {
		t.Error("lifecycle not audited")
	}
}

func TestAlertHistoryFilters(t *testing.T) {
	e, admin := adminEnv(t, nil)
	e.enroll(admin, "granite", "Production")
	e.enroll(admin, "basalt", "Lab")
	ctx := context.Background()
	base := time.Now().Add(-48 * time.Hour)
	for i, srv := range []string{"granite", "basalt", "granite"} {
		at := base.Add(time.Duration(i) * time.Hour)
		res := at.Add(10 * time.Minute)
		sev := rules.SevWarning
		if i == 2 {
			sev = rules.SevCritical
		}
		e.h.store.InsertAlert(ctx, rules.Alert{ID: fmt.Sprintf("al_%d", i), Server: srv, Key: "k", Rule: "disk.space_high", Entity: "fs:/",
			Severity: sev, Text: rules.Text{Title: fmt.Sprintf("Disk %d full", i)}, State: rules.AlertResolved, OpenedAt: at, ResolvedAt: &res})
	}
	var got []map[string]any
	admin.json(http.MethodGet, "/api/v1/alerts?state=resolved&server=granite", nil, 200, &got)
	if len(got) != 2 || got[0]["id"] != "al_2" {
		t.Fatalf("server filter %v", got)
	}
	admin.json(http.MethodGet, "/api/v1/alerts?state=resolved&group=Lab", nil, 200, &got)
	if len(got) != 1 || got[0]["server"] != "basalt" {
		t.Fatalf("group filter %v", got)
	}
	admin.json(http.MethodGet, "/api/v1/alerts?state=resolved&severity=critical", nil, 200, &got)
	if len(got) != 1 {
		t.Fatalf("severity filter %v", got)
	}
	code, b, hdr := admin.req(http.MethodGet, "/api/v1/alerts?state=resolved&limit=2", nil, nil)
	json.Unmarshal(b, &got)
	if code != 200 || len(got) != 2 || hdr.Get("X-Next-Before") == "" {
		t.Fatalf("paging %d %v %v", code, got, hdr)
	}
	admin.json(http.MethodGet, "/api/v1/alerts?state=resolved&limit=2&before="+hdr.Get("X-Next-Before"), nil, 200, &got)
	if len(got) != 1 || got[0]["id"] != "al_0" {
		t.Fatalf("page 2 %v", got)
	}
}

func TestDeniedRequestsRaiseHubAlert(t *testing.T) {
	e, admin := adminEnv(t, nil)
	for i := 0; i < deniedAlertThreshold; i++ {
		e.h.limits.denied.fail("mallory")
	}
	e.h.evaluateHubAlerts(context.Background())
	var open []map[string]any
	admin.json(http.MethodGet, "/api/v1/alerts", nil, 200, &open)
	if len(open) != 1 || open[0]["server"] != "" || open[0]["rule"] != RuleDeniedRequests {
		t.Fatalf("hub alert %v", open)
	}
	params, _ := open[0]["params"].(map[string]any)
	if open[0]["code"] != RuleDeniedRequests || open[0]["status_note_code"] != "denied_requests" ||
		params["user"] != "mallory" || params["count"] != float64(deniedAlertThreshold) {
		t.Errorf("hub alert translation data: %v", open)
	}
	var f map[string]any
	admin.json(http.MethodGet, "/api/v1/fleet", nil, 200, &f)
	if len(f["alerts"].([]any)) != 1 {
		t.Fatal("hub alert missing from the fleet")
	}
}

// A host whose parent (the host it runs on) is offline has its alerts
// suppressed: the cause is the parent.
func TestParentSuppression(t *testing.T) {
	e, admin := adminEnv(t, nil)
	parent := e.enroll(admin, "basalt", "Production")
	e.enroll(admin, "rackoon-vm", "Lab")
	if _, err := parent.dial(proto.Hello{}); err != nil {
		t.Fatal(err)
	}
	rep := parent.report("basalt")
	rep.Incus = &proto.Platform{Guests: []proto.Guest{{ID: "rackoon-vm", Name: "rackoon-vm", Kind: "vm", State: proto.StateRunning}}}
	parent.send(proto.MsgReport, rep)
	waitFor(t, "parent detected", 3*time.Second, func() bool {
		st, _ := e.h.snapshotOne("rackoon-vm")
		return st != nil && st.Parent == "basalt"
	})
	st, _ := e.h.snapshotOne("rackoon-vm")
	if st.ParentOffline {
		t.Fatal("parent reported offline while connected")
	}
	// An explicit "-" turns detection off.
	admin.json(http.MethodPatch, "/api/v1/servers/rackoon-vm", map[string]any{"parent": "-"}, 200, nil)
	if st, _ := e.h.snapshotOne("rackoon-vm"); st.Parent != "" {
		t.Fatal("parent kept after setting none")
	}
}

func TestHostAccessAndInspect(t *testing.T) {
	e, admin := adminEnv(t, func(c *Config) { c.PublicURL = "https://hub.example" })
	fa := e.enroll(admin, "basalt", "Lab")
	fa.policy = proto.Policy{Console: true, Power: true}
	if _, err := fa.dial(proto.Hello{}); err != nil {
		t.Fatal(err)
	}
	fa.send(proto.MsgReport, fa.report("basalt"))
	waitFor(t, "report", 2*time.Second, func() bool { st, _ := e.h.snapshotOne("basalt"); return st != nil && st.Report != nil })
	admin.json(http.MethodPatch, "/api/v1/servers/basalt", map[string]any{"remote_control": map[string]bool{"console": true, "power": true, "host_shell": true}}, 200, nil)
	// The host shell needs the agent's host_shell too.
	code, b, _ := admin.req(http.MethodPost, "/api/v1/servers/basalt/console-sessions", map[string]string{"protocol": "shell"}, map[string]string{"Origin": "https://hub.example"})
	if code != 403 || !strings.Contains(string(b), "host_shell_disabled") {
		t.Fatalf("host shell without the agent's flag: %d %s", code, b)
	}
	// The host journal needs only the console permission.
	var cs map[string]any
	code, b, _ = admin.req(http.MethodPost, "/api/v1/servers/basalt/console-sessions", map[string]string{"protocol": "logs"}, map[string]string{"Origin": "https://hub.example"})
	json.Unmarshal(b, &cs)
	if code != 201 || cs["protocol"] != "logs" {
		t.Fatalf("host logs: %d %s", code, b)
	}
	// Host power needs its own switches.
	code, b, _ = admin.req(http.MethodPost, "/api/v1/servers/basalt/actions", map[string]any{"action": "host_reboot", "confirm": true}, nil)
	if code != 403 || !strings.Contains(string(b), "host_power_disabled") {
		t.Fatalf("host reboot: %d %s", code, b)
	}
	// Operators never get host access.
	e.addUser("olive", store.RoleOperator, "operator password 1")
	op := e.client()
	op.login("olive", "operator password 1")
	if code, b, _ := op.req(http.MethodPost, "/api/v1/servers/basalt/actions", map[string]any{"action": "host_reboot", "confirm": true}, nil); code != 403 {
		t.Fatalf("operator host reboot: %d %s", code, b)
	}
	// Processes come from the agent; snapshots too.
	var procs map[string]any
	admin.json(http.MethodGet, "/api/v1/servers/basalt/inspect/processes", nil, 200, &procs)
	if items := procs["items"].([]any); len(items) != 1 {
		t.Fatalf("processes %v", procs)
	}
	var snaps map[string]any
	admin.json(http.MethodGet, "/api/v1/servers/basalt/guests/incus:nixbuild/snapshots", nil, 200, &snaps)
	if items := snaps["items"].([]any); len(items) != 1 {
		t.Fatalf("snapshots %v", snaps)
	}
	if code, _, _ := admin.req(http.MethodGet, "/api/v1/servers/basalt/inspect/ports", nil, nil); code != 501 {
		t.Fatalf("unsupported view: %d", code)
	}
	// A snapshot action carries its validated name.
	admin.json(http.MethodPost, "/api/v1/servers/basalt/guests/incus:nixbuild/actions", map[string]any{"action": "snapshot_create", "snapshot": "pre-upgrade"}, 202, nil)
	if code, _, _ := admin.req(http.MethodPost, "/api/v1/servers/basalt/guests/incus:nixbuild/actions", map[string]any{"action": "snapshot_delete", "snapshot": "x;rm -rf /", "confirm": true}, nil); code != 400 {
		t.Fatalf("bad snapshot name accepted: %d", code)
	}
	waitFor(t, "snapshot action", 3*time.Second, func() bool {
		fa.mu.Lock()
		defer fa.mu.Unlock()
		for _, a := range fa.actions {
			if a.Action == proto.ActionSnapshotCreate && a.Args[proto.ArgSnapshot] == "pre-upgrade" {
				return true
			}
		}
		return false
	})
	if len(e.audit("inspect.viewed")) < 2 {
		t.Error("inspect views not audited")
	}
}

func TestAgentUpdateRollout(t *testing.T) {
	dist := t.TempDir()
	bin := bytes.Repeat([]byte("agent-binary"), 300000) // > 1 MiB: several chunks
	os.WriteFile(dist+"/whombat-agent-linux-amd64", bin, 0o644)
	man := fmt.Sprintf(`{"version":"v2","key":"k1","files":{"whombat-agent-linux-amd64":{"arch":"amd64","size":%d,"sha256":"%s","sig":"c2ln"}}}`,
		len(bin), strings.Repeat("ab", 32))
	os.WriteFile(dist+"/manifest.json", []byte(man), 0o644)
	e, admin := adminEnv(t, func(c *Config) { c.AgentDist = dist })
	fa := e.enroll(admin, "basalt", "Lab")
	fa.policy = proto.Policy{Update: true}
	if _, err := fa.dial(proto.Hello{}); err != nil {
		t.Fatal(err)
	}
	rep := fa.report("basalt")
	rep.Agent.Version, rep.Agent.UpdateKey, rep.Agent.Arch = "v1", "k1", "amd64"
	fa.send(proto.MsgReport, rep)
	var agents []map[string]any
	waitFor(t, "update available", 3*time.Second, func() bool {
		admin.json(http.MethodGet, "/api/v1/agents", nil, 200, &agents)
		u, _ := agents[0]["update"].(map[string]any)
		return u != nil && u["available"] == true
	})
	admin.json(http.MethodPost, "/api/v1/agents/update", map[string]any{}, 202, nil)
	waitFor(t, "binary streamed", 5*time.Second, func() bool {
		fa.mu.Lock()
		defer fa.mu.Unlock()
		return len(fa.updates) == 1 && fa.updates[0].Version == "v2" && fa.updates[0].Size == int64(len(bin))
	})
	// The agent comes back with the new version: the rollout finishes.
	rep.Agent.Version = "v2"
	fa.send(proto.MsgReport, rep)
	waitFor(t, "rollout done", 10*time.Second, func() bool {
		return len(e.audit("agent.updated")) == 1
	})
	if rec := e.audit("agent.updated")[0]; rec.Outcome != "ok" {
		t.Fatalf("update audit %+v", rec)
	}
}

func TestChecks(t *testing.T) {
	e, admin := adminEnv(t, func(c *Config) { c.PublicURL = "https://rk.example" })
	ctx := context.Background()
	alertOf := func(rule string) map[string]any {
		var out []map[string]any
		admin.json(http.MethodGet, "/api/v1/alerts?state=open", nil, 200, &out)
		for _, a := range out {
			if a["rule"] == rule {
				return a
			}
		}
		return nil
	}
	checkOf := func(c *client, id string) map[string]any {
		var list []map[string]any
		c.json(http.MethodGet, "/api/v1/checks", nil, 200, &list)
		for _, x := range list {
			if x["id"] == id {
				return x
			}
		}
		t.Fatalf("check %s not listed: %v", id, list)
		return nil
	}

	// A heartbeat check: the ping URL is the credential.
	var hb map[string]any
	admin.json(http.MethodPost, "/api/v1/checks", map[string]any{"name": "Nightly backup", "kind": "heartbeat", "interval_s": 3600, "grace_s": 600}, 201, &hb)
	id, _ := hb["id"].(string)
	url, _ := hb["ping_url"].(string)
	if !strings.HasPrefix(url, "https://rk.example/ping/") {
		t.Fatalf("ping url %q", url)
	}
	path := strings.TrimPrefix(url, "https://rk.example")
	anon := e.client()
	if code, _, _ := anon.req(http.MethodGet, path, nil, nil); code != 200 {
		t.Fatalf("ping: %d", code)
	}
	if st := checkOf(admin, id)["status"]; st != "up" {
		t.Fatalf("after ping: %v", st)
	}
	if code, _, _ := anon.req(http.MethodGet, "/ping/"+strings.Repeat("x", 24), nil, nil); code != 404 {
		t.Fatalf("unknown token: %d", code)
	}
	// The job reports a failure: down at once, with an alert.
	if code, _, _ := anon.req(http.MethodPost, path+"/3", nil, nil); code != 200 {
		t.Fatalf("exit code ping: %d", code)
	}
	e.h.evaluateCheckAlerts(ctx)
	a := alertOf(RuleCheckDown)
	if a == nil || a["title"] != "Nightly backup is down" || a["detail"] != "The job exited with code 3" {
		t.Fatalf("down alert %v", a)
	}
	params, _ := a["params"].(map[string]any)
	if a["code"] != "check.down.heartbeat_exit" || a["status_note_code"] != "check_down" ||
		params["name"] != "Nightly backup" || params["exitCode"] != 3.0 {
		t.Errorf("heartbeat exit translation data: %v", a)
	}
	anon.req(http.MethodGet, path, nil, nil)
	e.h.evaluateCheckAlerts(ctx)
	if a := alertOf(RuleCheckDown); a != nil {
		t.Fatalf("alert not resolved: %v", a)
	}
	// No ping for longer than the period plus the grace time.
	e.h.checks.mu.Lock()
	old := time.Now().Add(-2 * time.Hour)
	e.h.checks.state[id].LastPing = &old
	e.h.checks.mu.Unlock()
	e.h.heartbeatChecks(ctx)
	e.h.evaluateCheckAlerts(ctx)
	if a := alertOf(RuleCheckDown); a == nil || !strings.HasPrefix(a["detail"].(string), "No ping for 2") {
		t.Fatalf("overdue alert %v", a)
	} else {
		params, _ := a["params"].(map[string]any)
		held, _ := params["heldSeconds"].(float64)
		if a["code"] != "check.down.heartbeat_elapsed" || held < 7200 || held >= 7260 {
			t.Errorf("overdue translation data: %v", a)
		}
	}
	// Viewers see checks but not the ping URL, and cannot change them.
	e.addUser("vera", store.RoleViewer, adminPW)
	viewer := e.client()
	viewer.login("vera", adminPW)
	if c := checkOf(viewer, id); c["ping_url"] != nil {
		t.Fatalf("viewer sees the ping url")
	}
	viewer.json(http.MethodPost, "/api/v1/checks", map[string]any{"name": "x", "kind": "tcp", "target": "a:1"}, 403, nil)

	// A probe run by an agent: it gets its checks, two failures open the alert.
	fa := e.enroll(admin, "basalt", "Lab")
	if _, err := fa.dial(proto.Hello{}); err != nil {
		t.Fatal(err)
	}
	var tcp map[string]any
	admin.json(http.MethodPost, "/api/v1/checks", map[string]any{"name": "NAS SMB", "kind": "tcp", "target": "10.0.0.5:445", "runner": "basalt", "interval_s": 30}, 201, &tcp)
	tid := tcp["id"].(string)
	waitFor(t, "checks sent", 3*time.Second, func() bool {
		fa.mu.Lock()
		defer fa.mu.Unlock()
		n := len(fa.checks)
		return n > 0 && len(fa.checks[n-1].Checks) == 1 && fa.checks[n-1].Checks[0].Target == "10.0.0.5:445"
	})
	admin.json(http.MethodPost, "/api/v1/checks", map[string]any{"name": "Bad", "kind": "tcp", "target": "10.0.0.5:445", "runner": "nope"}, 400, nil)
	rep := fa.report("basalt")
	for i := 0; i < 2; i++ {
		rep.Checks = []proto.CheckResult{{ID: tid, At: time.Now().Add(time.Duration(i) * time.Second), Error: "connection refused"},
			{ID: id, At: time.Now(), OK: true}} // not its check: ignored
		fa.send(proto.MsgReport, rep)
		time.Sleep(200 * time.Millisecond)
	}
	waitFor(t, "tcp check down", 3*time.Second, func() bool { return checkOf(admin, tid)["status"] == "down" })
	if checkOf(admin, id)["status"] != "down" {
		t.Fatal("an agent changed a hub check")
	}
	// Deleting a check resolves its alerts and drops its series.
	if code, _, _ := admin.req(http.MethodDelete, "/api/v1/checks/"+id, nil, nil); code != 204 {
		t.Fatalf("delete: %d", code)
	}
	if a := alertOf(RuleCheckDown); a != nil && a["title"] == "Nightly backup is down" {
		t.Fatalf("alert of deleted check still open")
	}
	if n := len(e.audit("check.created")); n != 2 {
		t.Fatalf("check.created audits: %d", n)
	}
}

func TestHistoryAndAnnotations(t *testing.T) {
	e, admin := adminEnv(t, nil)
	fa := e.enroll(admin, "basalt", "Lab")
	if _, err := fa.dial(proto.Hello{}); err != nil {
		t.Fatal(err)
	}
	rep := fa.report("basalt")
	rep.Host.BootTime = time.Now().Add(-30 * time.Minute)
	var gid string
	for _, g := range rep.AllGuests() {
		if g.State == proto.StateRunning && g.CPUPct != nil {
			gid = model.GuestID(g.Platform, g.ID)
			break
		}
	}
	fa.send(proto.MsgReport, rep)
	var m struct {
		Range  string                `json:"range"`
		Guest  string                `json:"guest"`
		Points int                   `json:"points"`
		Series map[string][]*float64 `json:"series"`
	}
	waitFor(t, "guest history", 3*time.Second, func() bool {
		admin.json(http.MethodGet, "/api/v1/servers/basalt/guests/"+gid+"/metrics?range=1h", nil, 200, &m)
		for _, v := range m.Series["cpu_pct"] {
			if v != nil {
				return true
			}
		}
		return false
	})
	if m.Guest != gid || m.Series["mem_mb"] == nil {
		t.Fatalf("guest metrics %+v", m)
	}
	// The host's own series list does not include guest series.
	m.Series = nil
	admin.json(http.MethodGet, "/api/v1/servers/basalt/metrics?range=1h", nil, 200, &m)
	if _, ok := m.Series["mem_mb"]; ok {
		t.Fatal("guest series in the host's series")
	}
	// Custom window and 90 days.
	from := time.Now().Add(-3 * time.Hour).UTC().Format(time.RFC3339)
	admin.json(http.MethodGet, "/api/v1/servers/basalt/metrics?from="+from, nil, 200, &m)
	if m.Range != "custom" || m.Points < 100 || m.Points > 130 {
		t.Fatalf("custom range %s %d", m.Range, m.Points)
	}
	admin.json(http.MethodGet, "/api/v1/servers/basalt/metrics?range=90d", nil, 200, &m)
	admin.json(http.MethodGet, "/api/v1/servers/basalt/metrics?from=2020-01-01T00:00:00Z", nil, 400, nil)
	admin.json(http.MethodGet, "/api/v1/servers/basalt/metrics?from="+time.Now().Add(-time.Minute).UTC().Format(time.RFC3339), nil, 400, nil)
	// Annotations: the reboot.
	var an []map[string]any
	admin.json(http.MethodGet, "/api/v1/servers/basalt/annotations?range=1h", nil, 200, &an)
	if len(an) == 0 || an[0]["kind"] != "reboot" {
		t.Fatalf("annotations %v", an)
	}
	// Deleting the server drops the guest history.
	if code, _, _ := admin.req(http.MethodDelete, "/api/v1/servers/basalt", nil, nil); code != 204 {
		t.Fatalf("delete: %d", code)
	}
	ids, err := e.h.store.SeriesNames(context.Background(), store.GuestSeriesOwner("basalt", gid))
	if err != nil || len(ids) != 0 {
		t.Fatalf("guest series left: %v %v", ids, err)
	}
}

func TestTokensGetNoConsoleAndHeartbeatIsWriteOnly(t *testing.T) {
	e, admin := adminEnv(t, nil)
	e.enroll(admin, "granite", "Production")
	var tok struct{ Token string }
	admin.json(http.MethodPost, "/api/v1/tokens", map[string]any{"name": "script", "role": "operator"}, 201, &tok)
	r, _ := http.NewRequest(http.MethodPost, e.ui.URL+"/api/v1/servers/granite/guests/docker:web/console-sessions", strings.NewReader(`{}`))
	r.Header.Set("Authorization", "Bearer "+tok.Token)
	r.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 403 || !strings.Contains(string(b), "browser_only") {
		t.Fatalf("console with a token: %d %s", resp.StatusCode, b)
	}

	secret := "https://hc-ping.com/0f5c6a1e-secret"
	var got map[string]any
	admin.json(http.MethodPut, "/api/v1/notification-settings", map[string]any{"heartbeat_url": secret, "heartbeat_minutes": 5}, 200, &got)
	if _, leak := got["heartbeat_url"]; leak || got["heartbeat_set"] != true || got["heartbeat_target"] != "https://hc-ping.com/…" {
		t.Fatalf("settings %v", got)
	}
	// Without heartbeat_url the URL is kept; "" removes it.
	admin.json(http.MethodPut, "/api/v1/notification-settings", map[string]any{"heartbeat_minutes": 10}, 200, &got)
	if u, _, _ := e.h.store.GetMeta(context.Background(), "heartbeat_url"); u != secret || got["heartbeat_minutes"] != float64(10) {
		t.Fatalf("url not kept: %q %v", u, got)
	}
	admin.json(http.MethodPut, "/api/v1/notification-settings", map[string]any{"heartbeat_url": "", "heartbeat_minutes": 10}, 200, &got)
	if got["heartbeat_set"] != false {
		t.Fatalf("not removed: %v", got)
	}
}
