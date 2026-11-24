package hub

import (
	"time"

	"rackoon/internal/proto"
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
