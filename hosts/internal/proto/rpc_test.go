package proto

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/fxamacker/cbor/v2"
)

// The inspect rows reach the browser as JSON (GET /servers/{id}/inspect/*,
// .../snapshots): snake_case keys, zero times left out. The wire keys stay
// the short CBOR ones.
func TestInspectRowsJSON(t *testing.T) {
	size := uint64(42)
	rows := []struct {
		v    any
		want []string
		not  []string
	}{
		{Process{PID: 7, User: "root", Name: "nginx", Command: "nginx -g", CPUPct: 1.5, RSSBytes: 9, State: "S"},
			[]string{`"pid":7`, `"command":"nginx -g"`, `"cpu_pct":1.5`, `"rss_bytes":9`, `"state":"S"`}, []string{"started", "PID"}},
		{ListenPort{Proto: "tcp", Address: "0.0.0.0", Port: 22, Process: "sshd"},
			[]string{`"proto":"tcp"`, `"address":"0.0.0.0"`, `"port":22`, `"process":"sshd"`}, nil},
		{Service{Name: "ssh.service", Active: "active", Since: time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)},
			[]string{`"name":"ssh.service"`, `"active":"active"`, `"since":"2026-10-01T00:00:00Z"`}, nil},
		{PackageUpdate{Name: "openssl", New: "3.0.2", Security: true},
			[]string{`"name":"openssl"`, `"new":"3.0.2"`, `"security":true`}, []string{"current"}},
		{Snapshot{Name: "pre-upgrade", WithMemory: true, SizeBytes: &size},
			[]string{`"name":"pre-upgrade"`, `"memory":true`, `"size_bytes":42`}, []string{"created"}},
	}
	for _, r := range rows {
		b, err := json.Marshal(r.v)
		if err != nil {
			t.Fatal(err)
		}
		for _, w := range r.want {
			if !strings.Contains(string(b), w) {
				t.Errorf("%T JSON %s lacks %s", r.v, b, w)
			}
		}
		for _, n := range r.not {
			if strings.Contains(string(b), n) {
				t.Errorf("%T JSON %s has %s", r.v, b, n)
			}
		}
	}
	b, err := cbor.Marshal(Process{PID: 7, CPUPct: 1.5, Command: "x"})
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := cbor.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	if _, ok := m["cmd"]; !ok {
		t.Errorf("CBOR keys changed: %v", m)
	}
	if _, ok := m["cpu"]; !ok {
		t.Errorf("CBOR keys changed: %v", m)
	}
}
