package hub

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"rackoon/internal/proto"
	"rackoon/internal/rules"
)

// TestOOMAtALimitIsNotTheServers: a kill inside a container's own memory
// limit is a quiet note on that container, not "Out of memory" on the
// server; a kill the machine made still is (LM-04).
func TestOOMAtALimitIsNotTheServers(t *testing.T) {
	e, admin := adminEnv(t, nil)
	fa := e.enroll(admin, "granite", "Production")
	if _, err := fa.dial(proto.Hello{}); err != nil {
		t.Fatal(err)
	}
	seq := uint64(0)
	send := func(total uint64, limit *uint64, killed []proto.OOMKill) {
		t.Helper()
		seq++
		rep := fa.report("granite")
		rep.Seq = seq
		rep.System.OOMKills, rep.System.OOMLimitKills, rep.System.OOMLimited = total, limit, killed
		fa.send(proto.MsgReport, rep)
		waitFor(t, "report", 3*time.Second, func() bool {
			st, ok := e.h.snapshotOne("granite")
			return ok && st.Report != nil && st.Report.Seq == seq
		})
	}
	u := func(v uint64) *uint64 { return &v }
	hostOOM := func() []map[string]any {
		var open, out []map[string]any
		admin.json(http.MethodGet, "/api/v1/alerts", nil, 200, &open)
		for _, a := range open {
			if a["rule"] == rules.RuleOOM {
				out = append(out, a)
			}
		}
		return out
	}
	send(10, u(2), nil) // baseline
	killed := []proto.OOMKill{{At: time.Now().Add(-time.Minute), Process: "java",
		Cgroup: "/system.slice/docker-" + strings.Repeat("e", 64) + ".scope", Platform: proto.PlatformDocker, GuestID: "elasticsearch"}}
	send(11, u(3), killed)
	if a := hostOOM(); len(a) != 0 {
		t.Fatalf("a kill at the container's limit warns on the server: %v", a)
	}
	var d struct {
		Hints []struct{ Kind, Severity, Entity, Title, Detail, Link string } `json:"hints"`
	}
	admin.json(http.MethodGet, "/api/v1/servers/granite", nil, 200, &d)
	found := false
	for _, h := range d.Hints {
		if h.Kind == rules.HintMemoryLimit && h.Entity == "docker:elasticsearch" {
			found = h.Severity == "info" && h.Title == "elasticsearch ran out of its memory" && h.Link == "#guests"
		}
	}
	if !found {
		t.Fatalf("no note on the container: %+v", d.Hints)
	}
	// The machine runs out: the warning is today's, counting that kill only.
	send(12, u(3), killed)
	var a []map[string]any
	waitFor(t, "host.oom", 3*time.Second, func() bool { a = hostOOM(); return len(a) == 1 })
	if a[0]["severity"] != "warning" || a[0]["title"] != "The server ran out of memory" || a[0]["detail"] != "It had to stop 1 program in the last hour" {
		t.Fatalf("host.oom: %v", a[0])
	}
	// A limit count past the total is clamped.
	send(12, u(50), killed)
	if st, _ := e.h.snapshotOne("granite"); st.Report.System.OOMLimitKills == nil || *st.Report.System.OOMLimitKills != 12 {
		t.Fatalf("not clamped: %v", st.Report.System.OOMLimitKills)
	}
}
