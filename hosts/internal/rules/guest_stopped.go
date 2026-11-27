package rules

import "rackoon/internal/proto"

// GuestStoppedCondition needs an explicit autostart flag and a known
// cause. A nonzero exit alone can also come from an intentional stop.
func GuestStoppedCondition(g proto.PlatformGuest, libvirtCrashed bool) (Condition, bool) {
	if g.WhombatService || g.State != proto.StateStopped || g.Autostart == nil || !*g.Autostart {
		return Condition{}, false
	}
	var detail, advice, cause string
	switch {
	case g.Platform == proto.PlatformDocker && g.OOMKilled && g.ExitCode != nil && *g.ExitCode != 0 &&
		g.FinishedAt != nil && !g.FinishedAt.IsZero():
		detail, advice = "It ran out of memory", "Check what was using its memory."
		cause = "oom"
	case g.Platform == proto.PlatformLibvirt && libvirtCrashed:
		detail, advice = "The virtual machine crashed", "Check its logs for what happened."
		cause = "crash"
	default:
		return Condition{}, false
	}
	name := orDefault(g.Name, g.ID)
	c := cond(RuleGuestStopped, g.Platform+"/"+g.ID, SevCritical, LinkGuests, "machine stopped",
		name+" stopped on its own", detail, advice, 0, map[string]any{"name": name, "cause": cause})
	c.ClearAfter = 0
	return c, true
}
