package rules

import (
	"slices"
	"strings"
	"testing"
	"time"

	"rackoon/internal/proto"
)

func TestGuestStoppedNeedsEvidence(t *testing.T) {
	autostart, code, finished := true, 137, time.Now()
	guest := proto.Guest{
		ID: "photos", State: proto.StateStopped, Autostart: &autostart, OOMKilled: true, ExitCode: &code, FinishedAt: &finished,
	}
	if c, ok := GuestStoppedCondition(proto.PlatformGuest{Platform: proto.PlatformDocker, Guest: &guest}, false); !ok ||
		c.Entity != "docker/photos" || c.Severity != SevCritical || c.ClearAfter != 0 {
		t.Fatalf("proved exit condition: %+v %v", c, ok)
	}
	for _, tc := range []struct {
		name, platform string
		change         func(*proto.Guest)
	}{
		{"manual stop", proto.PlatformDocker, func(g *proto.Guest) { g.OOMKilled = false }},
		{"normal exit", proto.PlatformDocker, func(g *proto.Guest) { zero := 0; g.ExitCode = &zero }},
		{"autostart unknown", proto.PlatformDocker, func(g *proto.Guest) { g.Autostart = nil }},
		{"autostart off", proto.PlatformDocker, func(g *proto.Guest) { off := false; g.Autostart = &off }},
		{"running again", proto.PlatformDocker, func(g *proto.Guest) { g.State = proto.StateRunning }},
		{"virtual machine", proto.PlatformLibvirt, func(_ *proto.Guest) {}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			g := guest
			tc.change(&g)
			if c, ok := GuestStoppedCondition(proto.PlatformGuest{Platform: tc.platform, Guest: &g}, false); ok {
				t.Fatalf("unexpected stop condition: %+v", c)
			}
		})
	}
}

func TestCustomAlertLimits(t *testing.T) {
	report := &proto.Report{Filesystems: []proto.Filesystem{
		{Mount: "/srv", SizeBytes: 100, UsedBytes: 93, InodesTotal: 100, InodesUsed: 96},
	}}
	has := func(conditions []Condition, rule string) bool {
		return slices.ContainsFunc(conditions, func(c Condition) bool { return c.Rule == rule })
	}
	if !has(HostConditions(report), RuleSpaceHigh) || !has(HostConditions(report), RuleInodesHigh) {
		t.Fatal("default thresholds should fire")
	}
	limits := func(rule, entity string) (float64, bool) { return 95, entity == "fs:/srv" }
	conditions := HostConditionsWithLimits(report, limits)
	if has(conditions, RuleSpaceHigh) || !has(conditions, RuleInodesHigh) {
		t.Fatal("the same custom limit should suppress space, but leave inodes")
	}
	for _, c := range conditions {
		if c.Rule == RuleInodesHigh && !strings.Contains(c.Render(0).Detail, "above your limit of 95 %") {
			t.Fatalf("inodes detail: %s", c.Render(0).Detail)
		}
	}
}
