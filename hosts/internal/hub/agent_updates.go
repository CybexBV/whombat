package hub

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"rackoon/internal/agentver"
	"rackoon/internal/hub/model"
	"rackoon/internal/hub/store"
	"rackoon/internal/proto"
)

// Agent self-update (docs/WHOMBAT.md "Agent updates"; HS-140…): the signed
// build in --agent-dist, what each server's agent can take, the rollout
// (one server at a time) that the manual route and the automatic round
// share, and the one last install for agents without the update key.

// agentManifest is dist/agent/manifest.json (cmd/rackoon-sign).
type agentManifest struct {
	Version string                  `json:"version"`
	Key     string                  `json:"key"`
	Files   map[string]manifestFile `json:"files"`
}

// manifestFile is one signed file: an agent build, or Whombat Helper's zip
// (helperZip: os darwin, arch universal, its own version).
type manifestFile struct {
	OS      string `json:"os"` // "darwin" for a macOS build; "" = linux
	Arch    string `json:"arch"`
	Version string `json:"version"` // the helper's
	Size    int64  `json:"size"`
	SHA256  string `json:"sha256"`
	Sig     string `json:"sig"`
}

// build is the manifest's file for an agent's system and architecture
// (AgentInfo.OS "" is linux, Arch "" amd64): its name, or ok false when
// the hub has no such build.
func (m *agentManifest) build(r *proto.Report) (name, arch string, ok bool) {
	goos, arch := r.Agent.OS, r.Agent.Arch
	if goos == "" {
		goos = "linux"
	}
	if arch == "" {
		arch = "amd64"
	}
	name = agentFileName(goos, arch)
	f, found := m.Files[name]
	if !found {
		return name, arch, false
	}
	fos := f.OS
	if fos == "" {
		fos = "linux"
	}
	return name, arch, fos == goos
}

func (h *Hub) manifest() (*agentManifest, error) {
	if h.cfg.AgentDist == "" {
		return nil, errors.New("no --agent-dist")
	}
	b, err := os.ReadFile(filepath.Join(h.cfg.AgentDist, "manifest.json"))
	if err != nil {
		return nil, err
	}
	var m agentManifest
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, err
	}
	if m.Version == "" {
		return nil, errors.New("manifest.json names no version")
	}
	return &m, nil
}

// Why an agent can't take the build (updateInfo.ReasonCode).
const (
	updNoBuild      = "no_build"
	updNotConnected = "not_connected"
	updUpToDate     = "up_to_date"
	updNoKey        = "no_key"
	updOtherKey     = "other_key"
	updTurnedOff    = "turned_off"
	updNewer        = "newer_running"
)

// Update states (updateInfo.State and the agent.update event).
const (
	updStateUpdating = "updating"
	updStateFailed   = "failed"
	updStateWaiting  = "waiting"
	updStateHalted   = "halted"
	updStateUpdated  = "updated" // event only: the update finished
)

// What a busy server waits for (updateInfo.WaitingFor).
const (
	waitPackages = "packages"
	waitConsole  = "console"
	waitTask     = "task"
)

// updateInfo is GET /agents' update object: whether a server's agent can
// be updated to the hub's build, why not, and how its update goes.
type updateInfo struct {
	Available bool   `json:"available"`
	Version   string `json:"version,omitempty"` // the hub's agent build
	Reason    string `json:"reason,omitempty"`  // English, for the Rackoon UI
	// ReasonCode says why not (the upd* codes); empty when available.
	ReasonCode string `json:"reason_code,omitempty"`
	// Auto: the automatic round takes this server (now, or once it is no
	// longer busy).
	Auto       bool   `json:"auto"`
	State      string `json:"state,omitempty"`       // updating | failed | waiting | halted
	WaitingFor string `json:"waiting_for,omitempty"` // packages | console | task (state waiting)
	Message    string `json:"message,omitempty"`
	// FailedVersion: the build that failed on this server (state failed).
	FailedVersion string `json:"failed_version,omitempty"`
	UpdatedAt     string `json:"updated_at,omitempty"` // the last successful update (RFC 3339)
	// CanInstall: no update key, but the one last install can be done
	// through the host shell (AU-07).
	CanInstall bool `json:"can_install"`
}

// installKinds are the agents the installer can install again in update
// mode (an agent started by hand is not a service it may replace).
var installKinds = map[string]bool{"systemd": true, "openrc": true, "sysv": true, "unraid": true}

// updateReason is the first reason the agent can't take the build (code
// "" = it can).
func updateReason(st *model.ServerState, m *agentManifest) (code, reason string) {
	if m == nil {
		return updNoBuild, "The hub has no signed agent build (dist/agent/manifest.json)."
	}
	r := st.Report
	if r == nil || !st.Connected {
		return updNotConnected, "The agent is not connected."
	}
	cmp, known := agentver.Compare(r.Agent.Version, m.Version)
	switch {
	case r.Agent.UpdateKey == "":
		return updNoKey, "This agent was installed without an update key: run the installer once (it upgrades in place)."
	case r.Agent.UpdateKey != m.Key:
		return updOtherKey, "This agent trusts a different signing key: run the installer once."
	case r.Agent.Version == m.Version || known && cmp == 0:
		return updUpToDate, "Up to date."
	case !r.Policy.Update:
		return updTurnedOff, "Updates are turned off in the agent's configuration ([update] allow)."
	case !known:
		return updNewer, "This agent's version can't be ordered against the hub's build, so it is left as it is."
	case cmp > 0:
		return updNewer, "This agent is newer than the hub's build."
	}
	if r.Agent.OS == "darwin" {
		if _, _, ok := m.build(r); !ok {
			return updNoBuild, "The hub has no macOS build of the agent for this Mac."
		}
	}
	return "", ""
}

// busyReason says what a server is doing that an agent restart would
// disturb (AU-04): installing packages, an open console or shell, or a
// task the agent runs itself. "" = not busy.
func (h *Hub) busyReason(st *model.ServerState) string {
	if r := st.Report; r != nil {
		if r.System != nil && r.System.PackageTask != nil {
			return waitPackages
		}
		if r.Agent.ConsolesOpen > 0 {
			return waitConsole
		}
	}
	if h.consoles.count(h.now(), func(cs *consoleSession) bool { return cs.server == st.ID }) > 0 {
		return waitConsole
	}
	// libvirt and unRAID tasks live in the agent (or its session) and are
	// lost when it restarts; Proxmox, Incus and package tasks are not.
	busy := false
	h.tasks.mu.Lock()
	for _, w := range h.tasks.m {
		if w.server == st.ID && (strings.HasPrefix(w.task, "libvirt:") || strings.HasPrefix(w.task, "unraid:")) {
			busy = true
			break
		}
	}
	h.tasks.mu.Unlock()
	if busy {
		return waitTask
	}
	return ""
}

func (h *Hub) updateInfoFor(st *model.ServerState, m *agentManifest, mErr error) updateInfo {
	var u updateInfo
	if mErr != nil {
		m = nil
	}
	u.ReasonCode, u.Reason = updateReason(st, m)
	u.Available = u.ReasonCode == ""
	if m != nil {
		u.Version = m.Version
	}
	s := h.agentUpdates()
	s.mu.Lock()
	mark := s.marks[st.ID]
	live, hasLive := s.state[st.ID]
	auto, halted := s.auto, m != nil && s.halted == m.Version
	s.mu.Unlock()
	if mark.UpdatedAt != nil {
		u.UpdatedAt = mark.UpdatedAt.UTC().Format(time.RFC3339)
	}
	failed := m != nil && mark.FailedVersion == m.Version
	switch {
	case hasLive:
		u.State, u.Message = live.state, live.message
	case failed:
		u.State, u.FailedVersion, u.Message = updStateFailed, mark.FailedVersion, mark.FailedMessage
	}
	if u.Available && !failed && agentver.Older(st.Report.Agent.Version, m.Version) {
		switch {
		case !auto:
		case halted:
			if u.State == "" {
				u.State = updStateHalted
			}
		default:
			u.Auto = true
			if u.State == "" {
				if w := h.busyReason(st); w != "" {
					u.State, u.WaitingFor = updStateWaiting, w
				}
			}
		}
	}
	u.CanInstall = h.canInstall(st, m, u.ReasonCode)
	return u
}

// canInstall: the one last install (AU-07) is possible on this server.
func (h *Hub) canInstall(st *model.ServerState, m *agentManifest, code string) bool {
	if m == nil || (code != updNoKey && code != updOtherKey) {
		return false
	}
	r := st.Report
	if r == nil || !st.Connected || !st.RCHostShell || !r.Policy.HostShell || !installKinds[r.Agent.Install] {
		return false
	}
	if c, ok := agentver.Compare(r.Agent.Version, m.Version); ok && c > 0 {
		return false // the build would take it back
	}
	if _, _, ok := m.build(r); !ok {
		return false
	}
	_, err := h.agentInstallBase()
	return err == nil
}

// ---- state, the setting and the marks -------------------------------------------------

// Meta keys of the agent updates.
const (
	metaAgentAutoUpdate = "agent_update.auto"    // "false" = off (default on)
	metaAgentHalted     = "agent_update.halted"  // the build that didn't come back
	metaAgentMarks      = "agent_update.servers" // JSON: server -> agentMark
)

// agentMark is what the hub keeps per server across restarts.
type agentMark struct {
	FailedVersion string     `json:"failed_version,omitempty"`
	FailedMessage string     `json:"failed_message,omitempty"`
	UpdatedAt     *time.Time `json:"updated_at,omitempty"`
}

type rolloutState struct {
	state, message string
}

// rollout runs agent updates one server at a time; the manual route and
// the automatic round share running.
type rollout struct {
	mu      sync.Mutex
	running bool
	state   map[string]rolloutState // live: updating
	waiting map[string]string       // last waiting_for published per server

	loaded bool
	auto   bool
	halted string
	marks  map[string]agentMark

	next time.Time     // the next automatic round (zero: none planned)
	kick chan struct{} // wakes the round's loop

	// Whombat Helper's updates (helper_updates.go): live states, the last
	// waiting_for published, the marks and the halt, per Mac.
	hstate   map[string]rolloutState
	hwaiting map[string]string
	hmarks   map[string]agentMark
	hhalted  string
}

// agentUpdates loads the setting and the marks once.
func (h *Hub) agentUpdates() *rollout {
	s := &h.rollout
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.loaded {
		return s
	}
	s.loaded, s.auto = true, true
	s.state, s.waiting, s.marks = map[string]rolloutState{}, map[string]string{}, map[string]agentMark{}
	s.hstate, s.hwaiting, s.hmarks = map[string]rolloutState{}, map[string]string{}, map[string]agentMark{}
	ctx := context.Background()
	if v, ok, _ := h.store.GetMeta(ctx, metaAgentAutoUpdate); ok && v == "false" {
		s.auto = false
	}
	if v, ok, _ := h.store.GetMeta(ctx, metaAgentHalted); ok {
		s.halted = v
	}
	if v, ok, _ := h.store.GetMeta(ctx, metaAgentMarks); ok && v != "" {
		if err := json.Unmarshal([]byte(v), &s.marks); err != nil {
			h.log.Warn("agent update marks unreadable; starting afresh", "err", err)
			s.marks = map[string]agentMark{}
		}
	}
	if v, ok, _ := h.store.GetMeta(ctx, metaHelperHalted); ok {
		s.hhalted = v
	}
	if v, ok, _ := h.store.GetMeta(ctx, metaHelperMarks); ok && v != "" {
		if err := json.Unmarshal([]byte(v), &s.hmarks); err != nil {
			h.log.Warn("helper update marks unreadable; starting afresh", "err", err)
			s.hmarks = map[string]agentMark{}
		}
	}
	return s
}

// saveMarksLocked writes the marks (s.mu held).
func (h *Hub) saveMarksLocked(s *rollout) {
	b, _ := json.Marshal(s.marks)
	if err := h.store.SetMeta(context.Background(), metaAgentMarks, string(b)); err != nil {
		h.log.Error("agent update marks", "err", err)
	}
}

func (h *Hub) setHalted(version string) {
	s := h.agentUpdates()
	s.mu.Lock()
	s.halted = version
	s.mu.Unlock()
	if err := h.store.SetMeta(context.Background(), metaAgentHalted, version); err != nil {
		h.log.Error("agent update halt", "err", err)
	}
}

func (h *Hub) setAutoUpdate(on bool) error {
	s := h.agentUpdates()
	s.mu.Lock()
	s.auto = on
	s.mu.Unlock()
	return h.store.SetMeta(context.Background(), metaAgentAutoUpdate, fmt.Sprint(on))
}

// publishUpdate sends agent.update {server, state, message, …extra}.
func (h *Hub) publishUpdate(id, state, msg string, extra map[string]string) {
	ev := map[string]string{"server": id, "state": state, "message": msg}
	for k, v := range extra {
		ev[k] = v
	}
	h.bus.PublishMinRank(store.RoleRank(store.RoleAdmin), "agent.update", ev)
}

// setRollout sets (state "" clears) a server's live state and publishes it.
func (h *Hub) setRollout(id, state, msg string) {
	s := h.agentUpdates()
	s.mu.Lock()
	if state == "" {
		delete(s.state, id)
	} else {
		s.state[id] = rolloutState{state, msg}
		delete(s.waiting, id)
	}
	s.mu.Unlock()
	h.publishUpdate(id, state, msg, nil)
}

// rolloutBegin takes the rollout (false: one is running).
func (h *Hub) rolloutBegin() bool {
	s := h.agentUpdates()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.running {
		return false
	}
	s.running = true
	return true
}

func (h *Hub) rolloutEnd() {
	s := h.agentUpdates()
	s.mu.Lock()
	s.running = false
	s.mu.Unlock()
}

// clearFailure is a person's Try again (AU-05): the server's failed mark
// and the halt go; the servers the halt held show their state again.
func (h *Hub) clearFailure(id string) {
	s := h.agentUpdates()
	s.mu.Lock()
	if mk, ok := s.marks[id]; ok && mk.FailedVersion != "" {
		mk.FailedVersion, mk.FailedMessage = "", ""
		s.marks[id] = mk
		h.saveMarksLocked(s)
	}
	wasHalted := s.halted != ""
	s.mu.Unlock()
	if wasHalted {
		h.setHalted("")
		h.log.Info("automatic agent updates resumed", "by_server", id)
		for _, st := range h.snapshot() {
			if st.ID != id {
				h.publishUpdate(st.ID, "", "", nil)
			}
		}
	}
}

// errNotBack: the agent didn't come back on the new version (it rolls
// back on its own); the build may be bad (AU-05).
var errNotBack = errors.New("the agent did not come back with the new version (it rolls back on its own)")

// errShutdown: the hub stopped while it waited; not the build's fault.
var errShutdown = errors.New("the hub is shutting down")

// finishUpdate records one server's outcome: the mark, the audit (by
// "auto" or the person), the event; a build that didn't come back halts
// the automatic updates.
func (h *Hub) finishUpdate(id, from string, m *agentManifest, err error, by string, rec store.AuditRecord) {
	s := h.agentUpdates()
	now := h.now()
	if _, ok := h.snapshotOne(id); !ok {
		s.mu.Lock()
		delete(s.state, id)
		delete(s.marks, id)
		s.mu.Unlock()
		h.log.Info("agent update ended with the server deleted", "server", id)
		return
	}
	rec.Event, rec.Server = "agent.updated", id
	rec.Details = mergeDetails(rec.Details, map[string]string{"version": m.Version, "from": from, "by": by})
	s.mu.Lock()
	mk := s.marks[id]
	delete(s.state, id)
	if err == nil {
		mk.FailedVersion, mk.FailedMessage, mk.UpdatedAt = "", "", &now
	} else {
		mk.FailedVersion, mk.FailedMessage = m.Version, cleanText(err.Error(), 300)
	}
	s.marks[id] = mk
	h.saveMarksLocked(s)
	s.mu.Unlock()
	if err == nil {
		rec.Outcome = "ok"
		_, _ = h.audit(context.Background(), rec)
		h.publishUpdate(id, updStateUpdated, "", map[string]string{"from": from, "to": m.Version, "by": by})
		h.log.Info("agent updated", "server", id, "from", from, "version", m.Version, "by", by)
		return
	}
	rec.Outcome, rec.Code = "error", "update_failed"
	rec.Details["error"] = cleanText(err.Error(), 300)
	_, _ = h.audit(context.Background(), rec)
	h.publishUpdate(id, updStateFailed, cleanText(err.Error(), 300), map[string]string{"version": m.Version, "by": by})
	h.log.Warn("agent update failed", "server", id, "version", m.Version, "by", by, "err", err)
	if errors.Is(err, errNotBack) {
		h.setHalted(m.Version)
		h.auditSystem(context.Background(), store.AuditRecord{Event: "agent.update_halted", Outcome: "ok", User: "system",
			Server: id, Details: map[string]string{"version": m.Version}})
		h.log.Warn("automatic agent updates stopped: the new version did not come back", "server", id, "version", m.Version)
		for _, st := range h.snapshot() {
			if u := h.updateInfoFor(st, m, nil); u.State == updStateHalted {
				h.publishUpdate(st.ID, updStateHalted, "", map[string]string{"version": m.Version})
			}
		}
	}
}

// ---- one server ---------------------------------------------------------------------

// updateOne pushes the hub's agent build to one server and waits until it
// reconnects with the new version (or fails / rolls back).
func (h *Hub) updateOne(ctx context.Context, id string, m *agentManifest) error {
	st, ok := h.snapshotOne(id)
	if !ok {
		return errors.New("no such server")
	}
	if u := h.updateInfoFor(st, m, nil); !u.Available {
		return errors.New(u.Reason)
	}
	from := st.Report.Agent.Version
	name, arch, ok := m.build(st.Report)
	if !ok {
		return errors.New("no " + name + " build in the manifest")
	}
	f := m.Files[name]
	sum, err1 := hex.DecodeString(f.SHA256)
	sig, err2 := base64.StdEncoding.DecodeString(f.Sig)
	if err1 != nil || err2 != nil {
		return errors.New("bad manifest entry")
	}
	file, err := os.Open(filepath.Join(h.cfg.AgentDist, name))
	if err != nil {
		return err
	}
	defer file.Close()
	conn := h.conn(id)
	if conn == nil {
		return errors.New("the agent is not connected")
	}
	h.setRollout(id, updStateUpdating, "Sending "+m.Version)
	resp, err := conn.Update(ctx, proto.UpdateRequest{Version: m.Version, Arch: arch, Size: f.Size, SHA256: sum, Signature: sig}, file)
	if err != nil {
		return err
	}
	if !resp.OK {
		if resp.Message == "" {
			resp.Message = resp.Code
		}
		return errors.New(resp.Message)
	}
	h.setRollout(id, updStateUpdating, "Installed; waiting for the agent to come back")
	return h.waitBack(ctx, id, conn, from, m, "", h.cfg.AgentUpdateWait, nil)
}

// waitBack waits until the server's agent is connected with the build's
// version (and key, when key is set). An agent that came back on a new
// connection with its old version rolled back. ended, when not nil, is
// asked now and then while the old connection is still there; its error
// ends the wait.
func (h *Hub) waitBack(ctx context.Context, id string, before *AgentConn, from string, m *agentManifest, key string, limit time.Duration, ended func(*AgentConn) error) error {
	deadline := time.Now().Add(limit)
	var seen *AgentConn // the new connection
	var seenAt time.Time
	for n := 1; time.Now().Before(deadline); n++ {
		select {
		case <-ctx.Done():
			return errShutdown
		case <-time.After(h.cfg.AgentUpdatePoll):
		}
		if h.closing.Load() {
			return errShutdown
		}
		s, ok := h.snapshotOne(id)
		if !ok {
			return errors.New("the server was deleted")
		}
		c := h.conn(id)
		if c == nil || !s.Connected || s.Report == nil {
			continue
		}
		if ended != nil && c == before && n%5 == 0 {
			// Still the old connection: the install may have ended without
			// restarting the agent.
			if err := ended(c); err != nil {
				return err
			}
		}
		if c != before && c != seen {
			seen, seenAt = c, h.now()
		}
		v := s.Report.Agent.Version
		switch {
		case v == m.Version && (key == "" || s.Report.Agent.UpdateKey == key):
			return nil
		case key == "" && c == seen && v == from && s.ReportAt.After(seenAt):
			// The new connection's own report names the old version: the
			// agent went back.
			return fmt.Errorf("%w: it is running %s again", errNotBack, from)
		}
	}
	return errNotBack
}

// ---- the one last install (AU-07) ----------------------------------------------------

// lastInstallDir is where the detached install writes on the server
// (the agent's state directory, which every installer creates):
// last-install.log (its output) and last-install.pid (its session).
const (
	lastInstallDir = "/var/lib/whombat-agent"
	lastInstallLog = lastInstallDir + "/last-install.log"
	lastInstallOK  = "whombat-agent-install: started"
)

// shq quotes s for /bin/sh.
func shq(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

// lastInstallCommand is the exec command (as root) that starts the
// agent's update-mode install, detached from the exec session so the
// agent's own restart doesn't end it (HS-145): its own transient unit on
// systemd, its own session elsewhere. The install is the System tab's
// update command (the install command without enrollment, no sudo):
// base/install.sh, fetched to a file first so the log's last line has the
// install's own exit status. hub, when not empty, keeps the agent on the
// address it dials now (HS-162). It prints lastInstallOK once the install
// runs on its own; the install's output goes to last-install.log.
func lastInstallCommand(install, fetch, base, hub, version string, stamp int64) string {
	return lastInstallCommandIn(lastInstallDir, install, fetch, base, hub, version, stamp)
}

func lastInstallCommandIn(dir, install, fetch, base, hub, version string, stamp int64) string {
	script, log, pid, fetched := dir+"/last-install.sh", dir+"/last-install.log", dir+"/last-install.pid", dir+"/last-install-script.sh"
	run := "sh " + fetched
	if hub != "" {
		run += " --hub " + shq(hub)
	}
	// The install runs from a script file: systemd warns about the
	// semicolons of a script passed as an argument when it writes the
	// transient unit.
	body := strings.Join([]string{
		"echo $$ >" + pid,
		`trap "" HUP`,
		"exec >" + log + " 2>&1 </dev/null",
		`echo "whombat-agent: last install of ` + version + `"`,
		fetch + " " + base + "/install.sh >" + fetched + " && " + run,
		`echo "whombat-agent: install ended ($?)"`,
	}, "\n")
	cmd := `command -v curl >/dev/null 2>&1 || { echo "whombat-agent-install: curl is required"; exit 3; }` + "\n" +
		"mkdir -p " + dir + " && rm -f " + pid + " && cat >" + script + " <<'WHOMBAT_AGENT_INSTALL'\n" + body + "\nWHOMBAT_AGENT_INSTALL\n"
	if install == "systemd" {
		return cmd + fmt.Sprintf(`systemd-run --quiet --collect --unit=whombat-agent-reinstall-%d --description="Whombat agent install" /bin/sh %s && echo %s`,
			stamp, script, shq(lastInstallOK))
	}
	// setsid: a session of its own, which neither the exec's process group
	// kill nor the agent's supervisor reaches. The script writes its pid
	// first, so the file exists only once setsid has happened.
	return cmd + `command -v setsid >/dev/null 2>&1 || { echo "whombat-agent-install: setsid is required"; exit 3; }` + "\n" +
		"setsid /bin/sh " + script + " </dev/null >/dev/null 2>&1 &\n" +
		`i=0; while [ ! -s ` + pid + ` ] && [ $i -lt 50 ]; do sleep 0.2 2>/dev/null || sleep 1; i=$((i+1)); done` + "\n" +
		`[ -s ` + pid + ` ] && echo ` + shq(lastInstallOK)
}

// installOne does the last install on one server and waits until its
// agent is back with the build's version and key.
func (h *Hub) installOne(ctx context.Context, id string, m *agentManifest, rec store.AuditRecord) error {
	st, ok := h.snapshotOne(id)
	if !ok {
		return errors.New("no such server")
	}
	u := h.updateInfoFor(st, m, nil)
	if !u.CanInstall {
		return errors.New("Whombat can't run the install on this server: " + u.Reason)
	}
	conn := h.conn(id)
	if conn == nil {
		return errors.New("the agent is not connected")
	}
	base, hub, err := h.installAddr(conn)
	if err != nil {
		return err
	}
	from := st.Report.Agent.Version
	cmd := lastInstallCommand(st.Report.Agent.Install, fetchCommand(h.listenerPin()), base, hub, m.Version, h.now().Unix())
	h.setRollout(id, updStateUpdating, "Installing the agent once more")
	details := map[string]string{"command": cleanText(strings.ReplaceAll(cmd, "\n", " ⏎ "), 500), "timeout_s": "60", "purpose": "agent_install"}
	auditID, _ := h.audit(context.Background(), store.AuditRecord{Event: "exec.requested", Outcome: "ok", User: rec.User, Role: rec.Role,
		ClientIP: rec.ClientIP, UserAgent: rec.UserAgent, Server: id, Details: details})
	resp, err := conn.Exec(ctx, proto.ExecRequest{Command: cmd, TimeoutS: 60})
	fin := store.AuditRecord{Event: "exec.finished", Outcome: "ok", User: rec.User, Role: rec.Role, ClientIP: rec.ClientIP,
		UserAgent: rec.UserAgent, Server: id, Details: mergeDetails(details, map[string]string{"requested_audit_id": auditID})}
	started := err == nil && resp.Code == "" && resp.ExitCode == 0 && strings.Contains(resp.Output, lastInstallOK)
	if err == nil {
		fin.Details["exit_code"] = fmt.Sprint(resp.ExitCode)
	}
	if !started {
		fin.Outcome = "error"
	}
	_, _ = h.audit(context.Background(), fin)
	switch {
	case err != nil:
		return errors.New("the agent did not answer")
	case resp.Code != "":
		return errors.New(cmpOr(resp.Message, resp.Code))
	case !started:
		return fmt.Errorf("the install did not start: %s", cmpOr(installLogLine(resp.Output), fmt.Sprintf("exit status %d", resp.ExitCode)))
	}
	h.setRollout(id, updStateUpdating, "Installed; waiting for the agent to come back")
	ended := func(c *AgentConn) error {
		r, err := c.Exec(ctx, proto.ExecRequest{Command: "tail -n 5 " + lastInstallLog, TimeoutS: 10})
		if err != nil || r.Code != "" {
			return nil
		}
		if code := installEnded(r.Output); code != "" && code != "0" {
			return fmt.Errorf("the install stopped: %s", cmpOr(installLogLine(r.Output), "exit status "+code))
		}
		return nil
	}
	if err := h.waitBack(ctx, id, conn, from, m, m.Key, h.cfg.AgentInstallWait, ended); err != nil {
		if !errors.Is(err, errNotBack) {
			return err
		}
		// Still the old agent: its install's log says why.
		if c := h.conn(id); c != nil {
			if r, e := c.Exec(ctx, proto.ExecRequest{Command: "tail -n 5 " + lastInstallLog, TimeoutS: 10}); e == nil && r.Code == "" {
				if l := installLogLine(r.Output); l != "" {
					return fmt.Errorf("the agent did not come back with the new version: %s", l)
				}
			}
		}
		return errors.New("the agent did not come back with the new version")
	}
	return nil
}

// installAddr is where the last install fetches install.sh from and the
// hub it leaves the agent on: the host:port the agent dialed, so an agent
// that reaches the hub through a forwarded port keeps it (HS-162), else
// the agents' address with the agent's hub left as install.sh sets it.
func (h *Hub) installAddr(c *AgentConn) (base, hub string, err error) {
	if hp := c.dialed; hp != "" && safeHost.MatchString(hp) {
		if _, _, e := net.SplitHostPort(hp); e == nil {
			return "https://" + hp, "wss://" + hp, nil
		}
	}
	base, err = h.agentInstallBase()
	return base, "", err
}

var installEndedRe = regexp.MustCompile(`whombat-agent: install ended \((\d+)\)`)

// installEnded is the exit status the install's log ends with ("": it
// has not ended).
func installEnded(log string) string {
	all := installEndedRe.FindAllStringSubmatch(log, -1)
	if len(all) == 0 {
		return ""
	}
	return all[len(all)-1][1]
}

func installLogLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if l := strings.TrimSpace(lines[i]); l != "" && !strings.HasPrefix(l, "whombat-agent: install ended") {
			return cleanText(l, 300)
		}
	}
	return ""
}

func cmpOr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// ---- the routes -----------------------------------------------------------------------

// apiUpdateAgents is POST /agents/update {servers: [...]} (admin, recent
// sign-in): updates the listed agents (empty: every agent that can take a
// signed update), one at a time, stopping at the first failure. A listed
// server that needs its last install (can_install) gets it. A Mac whose
// Whombat Helper can follow the hub's gets it after its agent (also a Mac
// whose agent can take it only once updated). Pressing it clears the
// server's failed marks and the halts (AU-05).
func (h *Hub) apiUpdateAgents(w http.ResponseWriter, r *http.Request, p *principal) error {
	if err := h.requireReauth(p); err != nil {
		return err
	}
	var req struct {
		Servers []string `json:"servers"`
	}
	if r.ContentLength != 0 {
		if err := decodeJSON(r, &req); err != nil {
			return err
		}
	}
	m, err := h.manifest()
	if err != nil {
		return apiErr(http.StatusConflict, "no_build", "The hub has no signed agent build.")
	}
	var targets, installs, helpers, order []string
	var refusal error
	for _, st := range h.snapshot() {
		named := contains(req.Servers, st.ID)
		if len(req.Servers) > 0 && !named {
			continue
		}
		u := h.updateInfoFor(st, m, nil)
		hu := h.helperInfoFor(st, m, nil)
		helper := hu != nil && hu.Available
		switch {
		case u.Available:
			targets = append(targets, st.ID)
		case named && u.CanInstall:
			targets, installs = append(targets, st.ID), append(installs, st.ID)
		case helper: // only its helper
		case named && refusal == nil:
			code := "nothing_to_update"
			if u.ReasonCode == updNoKey || u.ReasonCode == updOtherKey {
				code = "needs_install" // the install command, run on the server once
			}
			refusal = apiErr(http.StatusConflict, code, u.Reason)
		}
		if helper {
			helpers = append(helpers, st.ID)
		}
		if contains(targets, st.ID) || helper {
			order = append(order, st.ID)
		}
	}
	if len(order) == 0 {
		if refusal != nil {
			return refusal
		}
		return apiErr(http.StatusConflict, "nothing_to_update", "No agent can be updated.")
	}
	if !h.rolloutBegin() {
		return apiErr(http.StatusConflict, "update_running", "An update is already running.")
	}
	for _, id := range order {
		h.clearFailure(id)
		h.clearHelperFailure(id)
	}
	hf, _ := m.helper()
	h.auditReq(r, p, store.AuditRecord{Event: "agent.update_started", Outcome: "ok",
		Details: map[string]string{"version": m.Version, "servers": joinIDs(targets), "installs": joinIDs(installs),
			"helpers": joinIDs(helpers), "helper_version": hf.Version}})
	rec := store.AuditRecord{User: p.user.Username, Role: p.user.Role, ClientIP: clientIP(r), UserAgent: cleanText(r.UserAgent(), 256)}
	by := p.user.Username
	h.bg.Add(1)
	go func() {
		defer h.bg.Done()
		defer func() {
			h.rolloutEnd()
			h.kickRound(h.cfg.AgentUpdateKick) // what waited for this rollout
		}()
		for _, id := range order {
			if h.closing.Load() {
				return
			}
			if contains(targets, id) {
				from := ""
				if st, ok := h.snapshotOne(id); ok && st.Report != nil {
					from = st.Report.Agent.Version
				}
				var err error
				if contains(installs, id) {
					err = h.installOne(context.Background(), id, m, rec)
				} else {
					err = h.updateOne(context.Background(), id, m)
				}
				if errors.Is(err, errShutdown) {
					h.setRollout(id, "", "")
					return
				}
				h.finishUpdate(id, from, m, err, by, rec)
				if err != nil {
					return // staged: the first failure stops the rollout
				}
			}
			// The helper, after the agent: a Mac listed for it, or one whose
			// agent can take it now that it was updated.
			st, ok := h.snapshotOne(id)
			if !ok {
				continue
			}
			if hu := h.helperInfoFor(st, m, nil); hu == nil || !hu.Available {
				continue
			} else {
				note, err := h.helperOne(context.Background(), id, m)
				if errors.Is(err, errShutdown) {
					h.setHelperRollout(id, "", "")
					return
				}
				h.finishHelper(id, hu.Installed, hf, note, err, by, rec)
				if err != nil {
					return
				}
			}
		}
	}()
	var helperVersion *string
	if len(helpers) > 0 {
		helperVersion = sp(hf.Version)
	}
	writeJSON(w, r, http.StatusAccepted, map[string]any{"servers": nonNil(targets), "installing": nonNil(installs), "version": m.Version,
		"helpers": nonNil(helpers), "helper_version": helperVersion})
	return nil
}

// agentSettingsJSON is GET/PATCH /agents/settings.
func (h *Hub) agentSettingsJSON() map[string]any {
	s := h.agentUpdates()
	m, _ := h.manifest()
	s.mu.Lock()
	defer s.mu.Unlock()
	var halted, helperHalted *string
	if s.halted != "" && m != nil && s.halted == m.Version {
		halted = sp(s.halted)
	}
	hf, _ := m.helper()
	if s.hhalted != "" && s.hhalted == hf.Version {
		helperHalted = sp(s.hhalted)
	}
	return map[string]any{"auto_update": s.auto, "halted_version": halted,
		"helper_version": sp(hf.Version), "helper_halted_version": helperHalted}
}

// apiAgentSettings is GET /agents/settings (admin).
func (h *Hub) apiAgentSettings(w http.ResponseWriter, r *http.Request, p *principal) error {
	writeJSON(w, r, http.StatusOK, h.agentSettingsJSON())
	return nil
}

// apiPatchAgentSettings is PATCH /agents/settings {auto_update} (admin,
// audited agent.settings_changed): “Keep server agents up to date”.
func (h *Hub) apiPatchAgentSettings(w http.ResponseWriter, r *http.Request, p *principal) error {
	var req struct {
		AutoUpdate *bool `json:"auto_update"`
	}
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	if req.AutoUpdate == nil {
		return invalidFields(map[string]string{"auto_update": "Say true or false."})
	}
	s := h.agentUpdates()
	s.mu.Lock()
	was := s.auto
	s.mu.Unlock()
	if err := h.setAutoUpdate(*req.AutoUpdate); err != nil {
		return apiErr(http.StatusServiceUnavailable, "store_unavailable", "The setting could not be saved.")
	}
	if was != *req.AutoUpdate {
		h.auditReq(r, p, store.AuditRecord{Event: "agent.settings_changed", Outcome: "ok",
			Details: map[string]string{"auto_update": fmt.Sprint(*req.AutoUpdate)}})
		if *req.AutoUpdate {
			h.kickRound(0)
		}
	}
	writeJSON(w, r, http.StatusOK, h.agentSettingsJSON())
	return nil
}

// ---- the automatic round (AU-03…AU-05) ------------------------------------------------

// kickRound plans the automatic round in d (earlier plans stay).
func (h *Hub) kickRound(d time.Duration) {
	s := h.agentUpdates()
	at := h.now().Add(d)
	s.mu.Lock()
	if s.next.IsZero() || at.Before(s.next) {
		s.next = at
	}
	k := s.kick
	s.mu.Unlock()
	if k != nil {
		select {
		case k <- struct{}{}:
		default:
		}
	}
}

// agentConnected plans a round a minute after an agent older than the
// build connected (attach).
func (h *Hub) agentConnected(version string) {
	m, err := h.manifest()
	if err != nil || !agentver.Older(version, m.Version) {
		return
	}
	s := h.agentUpdates()
	s.mu.Lock()
	on := s.auto
	s.mu.Unlock()
	if on {
		h.kickRound(h.cfg.AgentUpdateKick)
	}
}

// runAgentUpdates is the round's loop: the first round after the start
// grace, then every interval, earlier when kicked.
func (h *Hub) runAgentUpdates(ctx context.Context) {
	s := h.agentUpdates()
	s.mu.Lock()
	s.kick = make(chan struct{}, 1)
	s.mu.Unlock()
	h.kickRound(h.cfg.AgentUpdateGrace)
	t := time.NewTicker(h.cfg.AgentUpdateTick)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-s.kick:
		}
		now := h.now()
		s.mu.Lock()
		due := !s.next.IsZero() && !now.Before(s.next)
		if due {
			s.next = now.Add(h.cfg.AgentUpdateInterval)
		}
		s.mu.Unlock()
		if due && !h.closing.Load() {
			if !h.autoRound(ctx) {
				h.kickRound(h.cfg.AgentUpdateKick) // a manual rollout runs: try again soon
			}
		}
	}
}

// autoRound updates, one at a time, every server the round takes (auto)
// and that isn't busy. false: a rollout was running, nothing was done.
func (h *Hub) autoRound(ctx context.Context) bool {
	s := h.agentUpdates()
	s.mu.Lock()
	on := s.auto
	s.mu.Unlock()
	m, err := h.manifest()
	if !on || err != nil {
		return true
	}
	if !h.rolloutBegin() {
		return false
	}
	defer h.rolloutEnd()
	ids := []string{}
	for _, st := range h.snapshot() {
		ids = append(ids, st.ID)
	}
	sort.Strings(ids)
	for _, id := range ids {
		if ctx.Err() != nil || h.closing.Load() {
			return true
		}
		st, ok := h.snapshotOne(id)
		if !ok {
			continue
		}
		if u := h.updateInfoFor(st, m, nil); u.Auto {
			if u.State == updStateWaiting {
				s.mu.Lock()
				changed := s.waiting[id] != u.WaitingFor
				s.waiting[id] = u.WaitingFor
				s.mu.Unlock()
				if changed {
					h.publishUpdate(id, updStateWaiting, "", map[string]string{"waiting_for": u.WaitingFor})
				}
				continue // the helper waits with it
			}
			s.mu.Lock()
			delete(s.waiting, id)
			s.mu.Unlock()
			from := st.Report.Agent.Version
			err := h.updateOne(ctx, id, m)
			if ctx.Err() != nil || errors.Is(err, errShutdown) {
				h.setRollout(id, "", "")
				return true // shutting down: not a failure of the build
			}
			h.finishUpdate(id, from, m, err, "auto", store.AuditRecord{User: "system", Role: store.RoleAdmin})
			if errors.Is(err, errNotBack) {
				return true // halted
			}
		}
		// Whombat Helper, once the agent is done (a Mac's agent updated just
		// now may take it already).
		if !h.autoHelper(ctx, id, m) {
			return true
		}
	}
	return true
}

// ---- helpers -----------------------------------------------------------------------

func contains(l []string, s string) bool {
	for _, x := range l {
		if x == s {
			return true
		}
	}
	return false
}

func joinIDs(l []string) string {
	b, _ := json.Marshal(nonNil(l))
	return string(b)
}
