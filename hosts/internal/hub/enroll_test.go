package hub

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"rackoon/internal/hub/store"
)

// agentClaim is what an agent sends with its token (POST
// /agent/v1/enroll): the hub's 202 answer.
type agentClaim struct {
	ID       string `json:"enrollment_id"`
	Secret   string `json:"poll_secret"`
	State    string `json:"state"`
	ServerID string `json:"server_id"`
}

func (e *env) claim(token, hostname string) agentClaim {
	e.t.Helper()
	_, csr := newKey(e.t)
	body, _ := json.Marshal(map[string]string{"token": token, "csr": string(csr), "hostname": hostname,
		"machine_id": "m-" + hostname, "os": "Debian GNU/Linux 13 (trixie)", "address": "10.99.0.9", "agent_version": "0.2.0"})
	resp, err := e.agentHTTP(nil).Post(e.agent.URL+"/agent/v1/enroll", "application/json", bytes.NewReader(body))
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	var c agentClaim
	json.NewDecoder(resp.Body).Decode(&c)
	if resp.StatusCode != 202 {
		e.t.Fatalf("claim: %d %+v", resp.StatusCode, c)
	}
	return c
}

// poll is the agent's GET /agent/v1/enroll/{id}.
func (e *env) poll(c agentClaim) (int, map[string]string) {
	e.t.Helper()
	req, _ := http.NewRequest(http.MethodGet, e.agent.URL+"/agent/v1/enroll/"+c.ID, nil)
	req.Header.Set("Authorization", "Bearer "+c.Secret)
	resp, err := e.agentHTTP(nil).Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]string
	json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

// nextEvent waits for the named event on sub.
func nextEvent(t *testing.T, sub *Sub, name string) map[string]any {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case m := <-sub.C:
			if m.Name == name {
				var v map[string]any
				json.Unmarshal(m.Data, &v)
				return v
			}
		case <-deadline:
			t.Fatalf("no %s event", name)
			return nil
		}
	}
}

func TestPreApprovedEnrollment(t *testing.T) {
	e := headlessEnv(t, nil)
	svc := e.service("pe_1|John")
	sub, _, _ := e.h.bus.Subscribe(0, store.RoleRank(store.RoleAdmin), 0)
	defer e.h.bus.Unsubscribe(sub)

	// An empty body is exactly the old enrollment.
	var plain map[string]any
	svc.json(http.MethodPost, "/api/v1/enrollments", nil, 201, &plain)
	if plain["approve"] != false || plain["control"] != nil || plain["name"] != nil ||
		!strings.HasSuffix(plain["install_command"].(string), "--token "+plain["token"].(string)) {
		t.Fatalf("plain = %v", plain)
	}

	// Pre-approved with full control and a name.
	var en map[string]any
	svc.json(http.MethodPost, "/api/v1/enrollments", map[string]any{"approve": true, "control": "full", "name": "pve-03"}, 201, &en)
	if en["approve"] != true || en["control"] != "full" || en["name"] != "pve-03" ||
		!strings.HasSuffix(en["install_command"].(string), " | sudo sh -s -- --token "+en["token"].(string)+" --control full") {
		t.Fatalf("pre-approved = %v", en)
	}
	c := e.claim(en["token"].(string), "pve")
	if c.State != "approved" || c.ServerID != "pve-03" {
		t.Fatalf("claim = %+v", c)
	}
	// The first poll gets the certificate.
	if code, st := e.poll(c); code != 200 || st["state"] != "approved" || st["server_id"] != "pve-03" || st["certificate"] == "" {
		t.Fatalf("poll = %d %v", code, st)
	}
	if ev := nextEvent(t, sub, "enrollment.approved"); ev["id"] != en["id"] || ev["server_id"] != "pve-03" || ev["hostname"] != "pve" {
		t.Fatalf("enrollment.approved = %v", ev)
	}
	if ev := nextEvent(t, sub, "server.settings_changed"); ev["id"] != "pve-03" {
		t.Fatalf("server.settings_changed = %v", ev)
	}
	var set settingsJSON
	svc.json(http.MethodGet, "/api/v1/servers/pve-03/settings", nil, 200, &set)
	if rc := set.RemoteControl; !rc.Console || !rc.Power || !rc.HostShell || !rc.HostPower || !rc.Manage || !rc.Diagnose || set.Group != "Ungrouped" {
		t.Fatalf("settings = %+v", set)
	}
	recs := e.audit("enrollment.approved")
	if len(recs) != 1 || recs[0].User != "John (pe_1)" || recs[0].Role != "admin" || recs[0].Server != "pve-03" ||
		recs[0].Details["auto"] != "true" || recs[0].Details["control"] != "full" || recs[0].ClientIP == "" {
		t.Fatalf("audit = %s", fmtRecs(recs))
	}
	if recs := e.audit("enrollment.created"); len(recs) != 2 || recs[0].Details["approve"] != "true" || recs[0].Details["control"] != "full" ||
		recs[0].Details["name"] != "pve-03" || len(recs[1].Details) != 1 {
		t.Fatalf("created audit (newest first) = %s", fmtRecs(recs))
	}

	// A taken name gets -2, -3: never a takeover. Without a name, the host
	// name; the group as given.
	for i, want := range []string{"pve-03-2", "pve-03-3"} {
		var more map[string]any
		svc.json(http.MethodPost, "/api/v1/enrollments", map[string]any{"approve": true, "control": "watch", "name": "PVE 03"}, 201, &more)
		if c := e.claim(more["token"].(string), "pve"); c.ServerID != want {
			t.Fatalf("claim %d = %+v", i, c)
		}
	}
	svc.json(http.MethodGet, "/api/v1/servers/pve-03-2/settings", nil, 200, &set)
	if rc := set.RemoteControl; rc.Console || rc.Power || rc.HostShell || rc.HostPower || rc.Manage || !rc.Diagnose {
		t.Fatalf("watch = %+v", set)
	}
	var grouped map[string]any
	svc.json(http.MethodPost, "/api/v1/enrollments", map[string]any{"approve": true, "group": "Rack", "name": nil, "control": nil}, 201, &grouped)
	if c := e.claim(grouped["token"].(string), "Basalt.lan"); c.ServerID != "basalt-lan" {
		t.Fatalf("by host name = %+v", c)
	}
	svc.json(http.MethodGet, "/api/v1/servers/basalt-lan/settings", nil, 200, &set)
	if rc := set.RemoteControl; set.Group != "Rack" || rc.Console || !rc.Diagnose {
		t.Fatalf("no level = %+v", set)
	}
	// Taking the name of an existing server never happens: the old one is
	// untouched.
	if st, ok := e.h.snapshotOne("pve-03"); !ok || st.Hostname != "pve" {
		t.Fatal("pve-03 changed")
	}

	// Without approve, the stored level applies when an admin approves.
	var manual map[string]any
	svc.json(http.MethodPost, "/api/v1/enrollments", map[string]any{"control": "operate", "name": "shale"}, 201, &manual)
	mc := e.claim(manual["token"].(string), "shale-host")
	if mc.State != "pending" || mc.ServerID != "" {
		t.Fatalf("manual claim = %+v", mc)
	}
	if ev := nextEvent(t, sub, "enrollment.pending"); ev["id"] != mc.ID {
		t.Fatalf("enrollment.pending = %v", ev)
	}
	if code, _ := e.poll(mc); code != 202 {
		t.Fatalf("pending poll = %d", code)
	}
	var list []map[string]any
	svc.json(http.MethodGet, "/api/v1/enrollments", nil, 200, &list)
	if len(list) != 1 || list[0]["control"] != "operate" || list[0]["approve"] != false || list[0]["name"] != "shale" {
		t.Fatalf("pending list = %v", list)
	}
	var ap map[string]string
	svc.json(http.MethodPost, "/api/v1/enrollments/"+mc.ID+"/approve", nil, 200, &ap)
	if ap["server_id"] != "shale" {
		t.Fatalf("approve = %v", ap)
	}
	if ev := nextEvent(t, sub, "enrollment.approved"); ev["server_id"] != "shale" {
		t.Fatalf("manual enrollment.approved = %v", ev)
	}
	svc.json(http.MethodGet, "/api/v1/servers/shale/settings", nil, 200, &set)
	if rc := set.RemoteControl; !rc.Console || !rc.Power || rc.HostShell || rc.HostPower || rc.Manage || !rc.Diagnose {
		t.Fatalf("operate = %+v", set)
	}
	if recs := e.audit("enrollment.approved"); recs[0].Server != "shale" || recs[0].Details["auto"] != "" ||
		recs[0].Details["control"] != "operate" || recs[0].User != "John (pe_1)" {
		t.Fatalf("manual audit (newest first) = %s", fmtRecs(recs))
	}
	svc.json(http.MethodGet, "/api/v1/enrollments?state=all", nil, 200, &list)
	if len(list) != 6 {
		t.Fatalf("all = %v", list)
	}
	for _, it := range list {
		if _, ok := it["approve"]; !ok {
			t.Fatalf("item without approve: %v", it)
		}
	}

	// Refusals.
	for body, code := range map[string]string{
		`{"control": "root"}`:      "invalid_control",
		`{"control": ""}`:          "invalid_control",
		`{"name": "!!!"}`:          "invalid_name",
		`{"group": "all"}`:         "invalid_group",
		`{"approve": true, "x":1}`: "bad_request",
	} {
		if p := svc.problem(http.MethodPost, "/api/v1/enrollments", json.RawMessage(body), 400); p.Code != code {
			t.Errorf("%s: %+v", body, p)
		}
	}
	if code, b, _ := svc.req(http.MethodPost, "/api/v1/enrollments", nil, map[string]string{HeaderRole: "operator"}); code != 403 {
		t.Errorf("operator: %d %s", code, b)
	}
}

// A pre-approved token whose names are all taken waits for an admin.
func TestPreApprovedNamesExhausted(t *testing.T) {
	e := headlessEnv(t, nil)
	svc := e.service("pe_1|John")
	e.h.mu.Lock()
	e.h.servers["web"] = &srvState{}
	for n := 2; n <= maxNameSuffix; n++ {
		e.h.servers["web-"+strconv.Itoa(n)] = &srvState{}
	}
	e.h.mu.Unlock()
	var en map[string]any
	svc.json(http.MethodPost, "/api/v1/enrollments", map[string]any{"approve": true, "name": "web"}, 201, &en)
	if c := e.claim(en["token"].(string), "web"); c.State != "pending" {
		t.Fatalf("claim = %+v", c)
	}
}

// GET /api/v1/agent-install.sh is the agent listener's install.sh, for the
// Whombat server: downloads from the agents' address, its key pinned,
// whatever Host the request named.
func TestAgentInstallScriptOnSocket(t *testing.T) {
	lanAddress = func() (string, error) { return "10.100.1.5", nil }
	t.Cleanup(func() { lanAddress = defaultRouteAddr })
	e := headlessEnv(t, func(c *Config) { c.AgentURLAuto, c.AgentListen = true, "0.0.0.0:4744" })
	svc := e.service("pe_1|John")
	code, b, hdr := svc.req(http.MethodGet, "/api/v1/agent-install.sh", nil, nil)
	if code != 200 || !strings.HasPrefix(hdr.Get("Content-Type"), "text/x-shellscript") {
		t.Fatalf("script: %d %s", code, b)
	}
	script := string(b)
	for _, s := range []string{"HUB_URL='wss://10.100.1.5:4744'", "DOWNLOAD_BASE='https://10.100.1.5:4744/download'",
		"TLS_PIN='" + e.h.listenerPin() + "'", "CA_SHA256='" + e.h.ca.Pin + "'", "--control"} {
		if !strings.Contains(script, s) {
			t.Errorf("script lacks %q", s)
		}
	}
	if strings.Contains(script, "127.0.0.1") { // the request's Host
		t.Error("the script follows the request's Host")
	}
	// The same script the agent listener serves.
	resp, err := e.agentHTTP(nil).Get(e.agent.URL + "/install.sh")
	if err != nil {
		t.Fatal(err)
	}
	listener, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	host := strings.TrimPrefix(e.agent.URL, "https://")
	if strings.ReplaceAll(string(listener), host, "10.100.1.5:4744") != script {
		t.Error("the socket's script differs from the listener's")
	}
	if code, _, _ := svc.req(http.MethodGet, "/api/v1/agent-install.sh", nil, map[string]string{HeaderRole: "operator"}); code != 403 {
		t.Errorf("operator: %d", code)
	}
	if code, _, _ := e.client().req(http.MethodGet, "/api/v1/agent-install.sh", nil, nil); code != 401 {
		t.Errorf("anonymous: %d", code)
	}

	// Without an agents' address: 503 no_agent_url.
	e2 := headlessEnv(t, func(c *Config) { c.AgentListen = "0.0.0.0:4745" })
	if p := e2.service("pe_1|John").problem(http.MethodGet, "/api/v1/agent-install.sh", nil, 503); p.Code != "no_agent_url" {
		t.Errorf("no agent url: %+v", p)
	}
}

// Asking for consoles from a browser session needs a recent sign-in, like
// switching them on.
func TestEnrollmentControlNeedsReauth(t *testing.T) {
	e, admin := adminEnv(t, nil)
	admin.staleSignIn()
	if p := admin.problem(http.MethodPost, "/api/v1/enrollments", map[string]any{"control": "full"}, 403); p.Code != "reauth_required" {
		t.Fatalf("stale session: %+v", p)
	}
	admin.json(http.MethodPost, "/api/v1/enrollments", map[string]any{"control": "watch", "approve": true}, 201, nil)
	admin.json(http.MethodPost, "/api/v1/auth/reauth", map[string]string{"password": adminPW}, 204, nil)
	var en map[string]any
	admin.json(http.MethodPost, "/api/v1/enrollments", map[string]any{"control": "full"}, 201, &en)
	if !strings.HasSuffix(en["install_command"].(string), " --control full") || !strings.HasPrefix(en["install_command"].(string), " curl -fsSL http") {
		t.Fatalf("command = %v", en["install_command"])
	}
	if recs := e.audit("enrollment.created"); len(recs) != 2 {
		t.Fatalf("created = %s", fmtRecs(recs))
	}
}
