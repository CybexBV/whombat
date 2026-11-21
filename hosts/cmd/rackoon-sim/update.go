package main

import (
	"regexp"
	"strings"
	"time"

	"github.com/hashicorp/yamux"

	"rackoon/internal/agentver"
	"rackoon/internal/proto"
	"rackoon/internal/wire"
)

// Simulated agent updates (HS-160): with --update-key the agents run
// --agent-version (by default older than a dev build) with that key, the
// --update-keyless hosts without one. A signed update is taken like the
// agent does (no key, turned off, same or older version refused; nothing
// is verified or written) and the agent "restarts" on the new version: it
// reconnects. The last install (the hub's exec command) gives a keyless
// host the key and the version it names a few seconds later.

// simRestartDelay is how long a simulated install takes before the agent
// comes back.
var simRestartDelay = 3 * time.Second

var lastInstallRe = regexp.MustCompile(`last install of ([A-Za-z0-9][A-Za-z0-9._+~-]{0,63})`)

// agentVersion and agentKey are what this agent runs now.
func (a *simAgent) agentVersion() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.version != "" {
		return a.version
	}
	if a.o.agentVersion != "" {
		return a.o.agentVersion
	}
	return simVersion
}

func (a *simAgent) agentKey() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.keyed {
		return a.o.updateKey
	}
	if a.o.keyless[a.host.ID] {
		return ""
	}
	return a.o.updateKey
}

// becomes switches the agent to version (and the key) and reconnects.
func (a *simAgent) becomes(version string, keyed bool) {
	a.mu.Lock()
	a.version = version
	if keyed {
		a.keyed = true
	}
	restart := a.restart
	a.mu.Unlock()
	log.Info("simulated agent update", "host", a.host.ID, "version", version)
	if restart != nil {
		select {
		case restart <- struct{}{}:
		default:
		}
	}
}

// update answers the update stream like the agent's checks.
func (a *simAgent) update(st *yamux.Stream) {
	var req proto.UpdateRequest
	if wire.ReadMsg(st, &req) != nil {
		return
	}
	for got := int64(0); got < req.Size; {
		_ = st.SetReadDeadline(time.Now().Add(60 * time.Second))
		var c proto.UpdateChunk
		if wire.ReadMsg(st, &c) != nil {
			return
		}
		got += int64(len(c.Data))
	}
	cur := a.agentVersion()
	resp := proto.UpdateResponse{OK: true}
	switch c, ok := agentver.Compare(req.Version, cur); {
	case a.agentKey() == "":
		resp = proto.UpdateResponse{Code: "update_disabled", Message: "this agent was built without an update key"}
	case a.o.updateOff[a.host.ID]:
		resp = proto.UpdateResponse{Code: "update_disabled", Message: "updates are turned off in this host's agent.toml ([update] allow)"}
	case ok && c == 0:
		resp = proto.UpdateResponse{Code: "same_version", Message: "version " + req.Version + " is already running"}
	case !ok || c < 0:
		resp = proto.UpdateResponse{Code: "older_version", Message: "version " + req.Version + " is not newer than the running " + cur}
	}
	_ = wire.WriteMsg(st, resp)
	if resp.OK {
		time.AfterFunc(simRestartDelay, func() { a.becomes(req.Version, false) })
	}
}

// lastInstall answers the hub's last-install command (ok false: it is
// another command).
func (a *simAgent) lastInstall(req proto.ExecRequest) (proto.ExecResponse, bool) {
	m := lastInstallRe.FindStringSubmatch(req.Command)
	if m == nil || !strings.Contains(req.Command, "/install.sh | sh") {
		return proto.ExecResponse{}, false
	}
	time.AfterFunc(simRestartDelay, func() { a.becomes(m[1], true) })
	return proto.ExecResponse{Output: "whombat-agent-install: started\n", DurationMs: 40}, true
}
