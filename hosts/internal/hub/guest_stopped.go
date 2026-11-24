package hub

import (
	"strings"
	"time"

	"rackoon/internal/proto"
	"rackoon/internal/rules"
)

func (h *Hub) notePlannedStop(server, guest, action string) {
	switch action {
	case proto.ActionHostShutdown, proto.ActionHostReboot:
		h.mu.Lock()
		defer h.mu.Unlock()
		if s := h.servers[server]; s != nil {
			s.hostStop = h.now()
		}
	case proto.ActionStop, proto.ActionForceStop, proto.ActionShutdown, proto.ActionRestart, proto.ActionReboot, proto.ActionSnapshotRestore:
		platform, _, _ := strings.Cut(guest, ":")
		if platform != proto.PlatformDocker && platform != proto.PlatformLibvirt {
			return
		}
		h.mu.Lock()
		defer h.mu.Unlock()
		if s := h.servers[server]; s != nil {
			if s.guestStops == nil {
				s.guestStops = map[string]time.Time{}
			}
			s.guestStops[guest] = h.now()
		}
	}
}

// plannedStop compares the exit itself with the action, in the hub's
// clock. Later reports of the same exit reach the same result.
func (s *srvState) plannedStop(guest string, finished time.Time) bool {
	if s.skew != nil {
		finished = finished.Add(-time.Duration(*s.skew * float64(time.Second)))
	}
	for _, t := range [...]time.Time{s.guestStops[guest], s.hostStop} {
		if !t.IsZero() && finished.After(t.Add(-5*time.Second)) && finished.Before(t.Add(2*time.Minute)) {
			return true
		}
	}
	return false
}

// Missing exit or autostart data leaves an open alert alone.
func guestStopUnread(g proto.PlatformGuest) bool {
	if g.State != proto.StateStopped || (g.Platform != proto.PlatformDocker && g.Platform != proto.PlatformLibvirt) {
		return false
	}
	if g.Autostart == nil {
		return true
	}
	return *g.Autostart && g.Platform == proto.PlatformDocker && (g.ExitCode == nil || g.FinishedAt == nil)
}

// A crash event can arrive before the collector refreshes its guest list.
type libvirtCrash struct {
	at         time.Time
	sawStopped bool
}

func (s *srvState) rememberLibvirtCrash(guest string, crash libvirtCrash) {
	if s.libvirtCrashes == nil {
		s.libvirtCrashes = map[string]libvirtCrash{}
	}
	s.libvirtCrashes[guest] = crash
}

func (s *srvState) noteLibvirtGuestEvent(guest string, ev proto.Event, now time.Time) {
	switch {
	case ev.State == proto.StateRunning || ev.Message == "removed":
		delete(s.libvirtCrashes, guest)
	case ev.State == proto.StateStopped && ev.Message == "crashed" && !ev.At.IsZero() && !s.plannedStop(guest, ev.At):
		s.rememberLibvirtCrash(guest, libvirtCrash{at: now})
	}
}

func (s *srvState) libvirtStoppedCondition(g proto.PlatformGuest, id string, now time.Time) (rules.Condition, bool) {
	crash, known := s.libvirtCrashes[id]
	if !known {
		return rules.Condition{}, false
	}
	if (g.Autostart != nil && !*g.Autostart) ||
		(g.State != proto.StateStopped && (crash.sawStopped || now.Sub(crash.at) >= 2*time.Minute)) {
		delete(s.libvirtCrashes, id)
		return rules.Condition{}, false
	}
	c, ok := rules.GuestStoppedCondition(g, true)
	if ok && !crash.sawStopped {
		crash.sawStopped = true
		s.libvirtCrashes[id] = crash
	}
	return c, ok
}
