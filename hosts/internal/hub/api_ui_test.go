package hub

import (
	"net/http"
	"testing"
	"time"

	"rackoon/internal/hub/store"
	"rackoon/internal/proto"
)

// GET /servers carries the caller's remote-control permissions per server
// (the fleet-wide guest list offers power actions from it), and the
// inspect rows are snake_case JSON.
func TestServerListPermsAndInspectJSON(t *testing.T) {
	e, admin := adminEnv(t, nil)
	fa := e.enroll(admin, "basalt", "Lab")
	if _, err := fa.dial(proto.Hello{}); err != nil {
		t.Fatal(err)
	}
	fa.send(proto.MsgReport, fa.report("basalt"))
	waitFor(t, "report", 2*time.Second, func() bool { st, _ := e.h.snapshotOne("basalt"); return st != nil && st.Report != nil })

	type entry struct {
		ID            string `json:"id"`
		RemoteControl struct {
			Console     bool    `json:"console"`
			Power       bool    `json:"power"`
			PowerReason *string `json:"power_reason"`
			HostPower   bool    `json:"host_power"`
		} `json:"remote_control"`
	}
	var list []entry
	admin.json(http.MethodGet, "/api/v1/servers", nil, 200, &list)
	if len(list) != 1 || list[0].ID != "basalt" || list[0].RemoteControl.Power || list[0].RemoteControl.PowerReason == nil {
		t.Fatalf("power off by default: %+v", list)
	}
	admin.json(http.MethodPatch, "/api/v1/servers/basalt", map[string]any{"remote_control": map[string]bool{"console": true, "power": true}}, 200, nil)
	admin.json(http.MethodGet, "/api/v1/servers", nil, 200, &list)
	if rc := list[0].RemoteControl; !rc.Power || !rc.Console || rc.HostPower {
		t.Fatalf("admin after turning power on: %+v", rc)
	}
	e.addUser("vera", store.RoleViewer, "viewer password 1")
	viewer := e.client()
	viewer.login("vera", "viewer password 1")
	viewer.json(http.MethodGet, "/api/v1/servers", nil, 200, &list)
	if rc := list[0].RemoteControl; rc.Power || rc.Console {
		t.Fatalf("viewer may not act: %+v", rc)
	}

	var procs struct {
		Items []map[string]any `json:"items"`
	}
	admin.json(http.MethodGet, "/api/v1/servers/basalt/inspect/processes", nil, 200, &procs)
	if len(procs.Items) != 1 || procs.Items[0]["pid"] != float64(1) || procs.Items[0]["name"] != "init" {
		t.Fatalf("process rows: %v", procs.Items)
	}
	if _, ok := procs.Items[0]["cpu_pct"]; !ok {
		t.Fatalf("process rows: %v", procs.Items)
	}
}
