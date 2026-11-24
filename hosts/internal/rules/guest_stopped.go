package rules

import "rackoon/internal/proto"

// GuestStoppedCondition needs an explicit autostart flag and an OOM exit.
// A nonzero exit alone can also come from an intentional stop.
func GuestStoppedCondition(g proto.PlatformGuest) (Condition, bool) {
	if g.Platform != proto.PlatformDocker || g.WhombatService || g.State != proto.StateStopped ||
		g.Autostart == nil || !*g.Autostart || !g.OOMKilled || g.ExitCode == nil || *g.ExitCode == 0 ||
		g.FinishedAt == nil || g.FinishedAt.IsZero() {
		return Condition{}, false
	}
	name := orDefault(g.Name, g.ID)
	c := cond(RuleGuestStopped, g.Platform+"/"+g.ID, SevCritical, LinkGuests, "machine stopped",
		name+" stopped on its own", "It ran out of memory", "Check what was using its memory.", 0)
	c.ClearAfter = 0
	return c, true
}
