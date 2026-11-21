package model

import (
	"encoding/json"
	"testing"
	"time"

	"rackoon/internal/proto"
)

// Docker containers whose agent offers shell and logs have a console like
// any container; logs stay listed while the container is stopped. Agents
// that report no protocols keep the fixture shape {"available": false}.
func TestDockerConsoleCaps(t *testing.T) {
	now := time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)
	caps := proto.ConsoleCaps{Protocols: []string{proto.ProtoShell, proto.ProtoLogs}, Default: proto.ProtoShell}
	for _, state := range []string{proto.StateRunning, proto.StateStopped} {
		g := BuildGuest(proto.PlatformGuest{Platform: proto.PlatformDocker,
			Guest: &proto.Guest{ID: "web", Kind: "container", State: state, Console: caps}}, now)
		b, _ := json.Marshal(g)
		var m struct {
			Console struct {
				Available bool     `json:"available"`
				Protocols []string `json:"protocols"`
				Default   *string  `json:"default_protocol"`
			} `json:"console"`
		}
		if err := json.Unmarshal(b, &m); err != nil {
			t.Fatal(err)
		}
		c := m.Console
		if !c.Available || len(c.Protocols) != 2 || c.Protocols[1] != proto.ProtoLogs || c.Default == nil || *c.Default != proto.ProtoShell {
			t.Errorf("%s docker console = %s", state, b)
		}
	}
	old := BuildGuest(proto.PlatformGuest{Platform: proto.PlatformDocker, Guest: &proto.Guest{ID: "web", Kind: "container",
		State: proto.StateRunning}}, now)
	if b, _ := json.Marshal(old.Console); string(b) != `{"available":false}` {
		t.Errorf("docker console without protocols = %s", b)
	}
}
