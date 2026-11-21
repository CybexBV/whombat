package model

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"rackoon/internal/proto"
)

// Whombat's own containers carry whombat.service=1 through to Whombat, which
// leaves them out of what people see; other containers carry no labels.
func TestGuestWhombatServiceLabel(t *testing.T) {
	own := BuildGuest(proto.PlatformGuest{Platform: proto.PlatformDocker, Guest: &proto.Guest{ID: "wb-db", Name: "wb-db", State: proto.StateRunning, WhombatService: true}}, time.Now())
	b, _ := json.Marshal(own)
	if !strings.Contains(string(b), `"labels":{"whombat.service":"1"}`) {
		t.Errorf("own container json = %s", b)
	}
	other := BuildGuest(proto.PlatformGuest{Platform: proto.PlatformDocker, Guest: &proto.Guest{ID: "web", Name: "web", State: proto.StateRunning}}, time.Now())
	if b, _ := json.Marshal(other); strings.Contains(string(b), `"labels"`) {
		t.Errorf("other container json = %s", b)
	}
}
