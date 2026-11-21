package agent

import (
	"context"
	"path/filepath"
	"strings"
	"time"
)

// Moving to another of the hub's addresses (hub_move): the hub asks before
// the address the agent uses goes away (its box switches from a cable to
// Wi-Fi). The agent connects to the new address first, with the same
// checks as always (the pinned CA, its client certificate); only once the
// hub accepted its hello there does it save the address and drop the old
// connection. Anything else keeps the old connection and the saved
// address: the search finds the hub later if the old address does stop
// answering.

// moveTimeout bounds connecting and saying hello at the new address.
const moveTimeout = 10 * time.Second

// moveState is the move under way, if any.
type moveState struct {
	done  chan struct{} // closed when the move under way ends (nil: none)
	moved *hubLink      // the new connection, for the connect loop
}

// sameHub reports whether two hub addresses name the same host and port.
func sameHub(a, b string) bool {
	x, y := cleanHubAddrs([]string{a}), cleanHubAddrs([]string{b})
	return len(x) == 1 && len(y) == 1 && strings.EqualFold(x[0], y[0])
}

// startMove begins a move to url from the connection hc, unless the agent
// already uses that address or a move is under way.
func (rt *Runtime) startMove(hc *hubConn, url string) {
	target := cleanHubAddrs([]string{url})
	if len(target) != 1 {
		rt.Log.Warn("the hub asked to move to an unusable address", "url", url)
		return
	}
	to := target[0]
	if sameHub(to, rt.Config().Hub) {
		rt.Log.Debug("the hub asked to move to the address in use", "url", to)
		return
	}
	rt.moveMu.Lock()
	if rt.move.done != nil || rt.move.moved != nil {
		rt.moveMu.Unlock()
		return
	}
	done := make(chan struct{})
	rt.move.done = done
	rt.moveMu.Unlock()
	go func() {
		link := rt.moveTo(hc, to)
		rt.moveMu.Lock()
		rt.move.moved = link
		rt.move.done = nil
		close(done)
		rt.moveMu.Unlock()
		if link != nil {
			// The connect loop carries on with the new connection.
			hc.sess.Close()
		}
	}()
}

// moveTo connects and says hello at to; on success it saves to as the hub.
func (rt *Runtime) moveTo(hc *hubConn, to string) *hubLink {
	from := rt.Config().Hub
	rt.Log.Info("the hub asked to move to "+to, "hub", from)
	link, err := rt.openHub(hc.base, to, time.Now().Add(moveTimeout))
	if err != nil {
		rt.Log.Warn("could not move to the hub at "+to+"; staying at "+from, "err", err)
		return nil
	}
	rt.cfgMu.Lock()
	old := rt.cfg
	n := *old
	n.Hub = to
	rt.cfg = &n
	rt.cfgMu.Unlock()
	if err := RewriteHub(filepath.Join(old.Dir, ConfigFileName), to); err != nil {
		rt.Log.Error("the hub's new address could not be saved in "+ConfigFileName+"; it is used until the agent restarts",
			"err", err)
	}
	rt.Log.Info("moved to the hub at "+to, "hub", to, "was", from)
	return link
}

// waitMove waits for a move under way and reports whether it left a new
// connection to carry on with.
func (rt *Runtime) waitMove(ctx context.Context) bool {
	rt.moveMu.Lock()
	done := rt.move.done
	rt.moveMu.Unlock()
	if done != nil {
		select {
		case <-done:
		case <-ctx.Done():
			return false
		}
	}
	rt.moveMu.Lock()
	defer rt.moveMu.Unlock()
	return rt.move.moved != nil
}

// takeMoved returns the connection a move made (nil: none).
func (rt *Runtime) takeMoved() *hubLink {
	rt.moveMu.Lock()
	defer rt.moveMu.Unlock()
	l := rt.move.moved
	rt.move.moved = nil
	return l
}
