package hub

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"rackoon/internal/agentver"
	"rackoon/internal/hub/model"
	"rackoon/internal/hub/store"
	"rackoon/internal/proto"
)

// Whombat Helper's updates (docs/WHOMBAT.md "Agent updates"; HS-360…): the
// helper's signed zip is an entry of the agents' manifest, and the hub
// sends it to every Mac whose agent can take it (CapHelperUpdate) on the
// agent's update stream, through the agents' rollout: the same setting, one
// server at a time, never beside the agent's own update, and the manual
// route. Its live states, marks and halt are its own.

// Reason codes and a wait of the helper's besides the agents'.
const (
	updUnsupported  = "unsupported"    // the Mac's agent doesn't take helper updates (yet)
	updHostShellOff = "host_shell_off" // the host shell is off on the hub or in the agent
	waitAgent       = "agent"          // the agent's own update comes first
)

// Meta keys of the helper's updates.
const (
	metaHelperHalted = "agent_update.helper_halted" // the helper build that didn't answer
	metaHelperMarks  = "agent_update.helpers"       // JSON: server -> agentMark
)

// errHelperNoAnswer: the new helper didn't answer at the Mac's screen and
// the agent put the previous one back; the build may be bad.
var errHelperNoAnswer = errors.New("the new Whombat Helper didn't answer on the Mac")

// helper is the manifest's Whombat Helper entry (ok false: none, or one
// that isn't the helper's shape).
func (m *agentManifest) helper() (manifestFile, bool) {
	if m == nil {
		return manifestFile{}, false
	}
	f, ok := m.Files[helperZip]
	if !ok || f.OS != "darwin" || f.Arch != proto.HelperArch || !helperVersionRe.MatchString(f.Version) {
		return manifestFile{}, false
	}
	return f, true
}

var teamIDRe = regexp.MustCompile(`^[A-Z0-9]{10}$`)

// helperTeam is the Apple team the hub's helper build names for its
// Developer ID signature: whombat-helper-macos.json's "team" when that file
// describes the manifest's zip (its sha256), else "". The manifest's entry
// carries no team; the agent compares it with the new app's signature.
func (h *Hub) helperTeam(f manifestFile) string {
	b, err := os.ReadFile(filepath.Join(h.cfg.AgentDist, helperJSON))
	if err != nil || len(b) > 64<<10 {
		return ""
	}
	var d struct {
		SHA256 string `json:"sha256"`
		Team   string `json:"team"`
	}
	if json.Unmarshal(b, &d) != nil || !strings.EqualFold(strings.TrimSpace(d.SHA256), f.SHA256) || !teamIDRe.MatchString(d.Team) {
		return ""
	}
	return d.Team
}

func hasCap(r *proto.Report, c string) bool {
	for _, x := range r.Agent.Caps {
		if x == c {
			return true
		}
	}
	return false
}

// agentCan reports whether the agent of a server's latest report has a
// capability (false before its first report).
func agentCan(r *proto.Report, c string) bool { return r != nil && hasCap(r, c) }

// helperReason is the first reason a Mac can't take the hub's helper (code
// "" = it can): the build, the connection, the version, the agent's
// capability and key, its update switch, the host shell on both sides.
func helperReason(st *model.ServerState, m *agentManifest) (code, reason string) {
	f, ok := m.helper()
	if !ok {
		return updNoBuild, "The hub has no Whombat Helper build."
	}
	r := st.Report
	if r == nil || !st.Connected {
		return updNotConnected, "The agent is not connected."
	}
	if r.MacOS == nil {
		return updNotConnected, "The Mac hasn't reported its helper yet."
	}
	inst := r.MacOS.Helper
	cmp, known := 0, false
	if inst.Installed && inst.Version != "" {
		cmp, known = agentver.Compare(inst.Version, f.Version)
		if inst.Version == f.Version || known && cmp == 0 {
			return updUpToDate, "Up to date."
		}
	}
	switch {
	case !hasCap(r, proto.CapHelperUpdate):
		return updUnsupported, "This Mac's agent can't update Whombat Helper; it can once the agent itself is updated."
	case r.Agent.UpdateKey == "":
		return updNoKey, "This agent was installed without an update key: run the installer once (it upgrades in place)."
	case r.Agent.UpdateKey != m.Key:
		return updOtherKey, "This agent trusts a different signing key: run the installer once."
	case !r.Policy.Update:
		return updTurnedOff, "Updates are turned off in the agent's configuration ([update] allow)."
	case !st.RCHostShell || !r.Policy.HostShell:
		return updHostShellOff, "Whombat Helper is updated only while the host shell is on, on the hub and in the agent's configuration."
	case inst.Installed && inst.Version != "" && !known:
		return updNewer, "This Mac's helper version can't be ordered against the hub's build, so it is left as it is."
	case inst.Installed && inst.Version != "" && cmp > 0:
		return updNewer, "This Mac's helper is newer than the hub's build."
	}
	return "", ""
}

// helperInfoFor is a Mac's helper update object (nil for other servers).
func (h *Hub) helperInfoFor(st *model.ServerState, m *agentManifest, mErr error) *model.MacHelperUpdate {
	if model.OSFamily(st.Report) != model.OSFamilyMacOS {
		return nil
	}
	if mErr != nil {
		m = nil
	}
	u := &model.MacHelperUpdate{}
	u.ReasonCode, u.Reason = helperReason(st, m)
	u.Available = u.ReasonCode == ""
	f, hasBuild := m.helper()
	u.Version = f.Version
	if r := st.Report; r != nil && r.MacOS != nil && r.MacOS.Helper.Installed {
		u.Installed = r.MacOS.Helper.Version
	}
	s := h.agentUpdates()
	s.mu.Lock()
	mark := s.hmarks[st.ID]
	live, hasLive := s.hstate[st.ID]
	_, agentLive := s.state[st.ID]
	auto, halted := s.auto, hasBuild && s.hhalted == f.Version
	s.mu.Unlock()
	if mark.UpdatedAt != nil {
		u.UpdatedAt = mark.UpdatedAt.UTC().Format(time.RFC3339)
	}
	failed := hasBuild && mark.FailedVersion == f.Version
	switch {
	case hasLive:
		u.State, u.Message = live.state, live.message
	case failed:
		u.State, u.FailedVersion, u.Message = updStateFailed, mark.FailedVersion, mark.FailedMessage
	}
	if u.Available && !failed {
		switch {
		case !auto:
		case halted:
			if u.State == "" {
				u.State = updStateHalted
			}
		default:
			u.Auto = true
			if u.State == "" {
				switch {
				case agentLive || h.updateInfoFor(st, m, nil).Auto:
					// Never beside the agent's own update: that one goes first.
					u.State, u.WaitingFor = updStateWaiting, waitAgent
				default:
					if w := h.busyReason(st); w != "" {
						u.State, u.WaitingFor = updStateWaiting, w
					}
				}
			}
		}
	}
	return u
}

// ---- state ------------------------------------------------------------------------------

// publishHelperUpdate sends agent.helper_update {server, state, message,
// …extra} to admins.
func (h *Hub) publishHelperUpdate(id, state, msg string, extra map[string]string) {
	ev := map[string]string{"server": id, "state": state, "message": msg}
	for k, v := range extra {
		ev[k] = v
	}
	h.bus.PublishMinRank(store.RoleRank(store.RoleAdmin), "agent.helper_update", ev)
}

// setHelperRollout sets (state "" clears) a Mac's live helper state and
// publishes it.
func (h *Hub) setHelperRollout(id, state, msg string) {
	s := h.agentUpdates()
	s.mu.Lock()
	if state == "" {
		delete(s.hstate, id)
	} else {
		s.hstate[id] = rolloutState{state, msg}
		delete(s.hwaiting, id)
	}
	s.mu.Unlock()
	h.publishHelperUpdate(id, state, msg, nil)
}

func (h *Hub) saveHelperMarksLocked(s *rollout) {
	b, _ := json.Marshal(s.hmarks)
	if err := h.store.SetMeta(context.Background(), metaHelperMarks, string(b)); err != nil {
		h.log.Error("helper update marks", "err", err)
	}
}

func (h *Hub) setHelperHalted(version string) {
	s := h.agentUpdates()
	s.mu.Lock()
	s.hhalted = version
	s.mu.Unlock()
	if err := h.store.SetMeta(context.Background(), metaHelperHalted, version); err != nil {
		h.log.Error("helper update halt", "err", err)
	}
}

// clearHelperFailure is Try again for the helper: the Mac's failed mark
// and the helper's halt go.
func (h *Hub) clearHelperFailure(id string) {
	s := h.agentUpdates()
	s.mu.Lock()
	if mk, ok := s.hmarks[id]; ok && mk.FailedVersion != "" {
		mk.FailedVersion, mk.FailedMessage = "", ""
		s.hmarks[id] = mk
		h.saveHelperMarksLocked(s)
	}
	wasHalted := s.hhalted != ""
	s.mu.Unlock()
	if wasHalted {
		h.setHelperHalted("")
		h.log.Info("automatic helper updates resumed", "by_server", id)
		for _, st := range h.snapshot() {
			if st.ID != id && model.OSFamily(st.Report) == model.OSFamilyMacOS {
				h.publishHelperUpdate(st.ID, "", "", nil)
			}
		}
	}
}

// finishHelper records one Mac's helper outcome: the mark, the audit
// agent.helper_updated (by "auto" or the person), the event; a helper that
// didn't answer halts the automatic helper updates.
func (h *Hub) finishHelper(id, from string, f manifestFile, note string, err error, by string, rec store.AuditRecord) {
	s := h.agentUpdates()
	now := h.now()
	if _, ok := h.snapshotOne(id); !ok {
		s.mu.Lock()
		delete(s.hstate, id)
		delete(s.hmarks, id)
		s.mu.Unlock()
		return
	}
	rec.Event, rec.Server = "agent.helper_updated", id
	rec.Details = mergeDetails(rec.Details, map[string]string{"version": f.Version, "from": from, "by": by})
	s.mu.Lock()
	mk := s.hmarks[id]
	delete(s.hstate, id)
	if err == nil {
		mk.FailedVersion, mk.FailedMessage, mk.UpdatedAt = "", "", &now
	} else {
		mk.FailedVersion, mk.FailedMessage = f.Version, cleanText(err.Error(), 300)
	}
	s.hmarks[id] = mk
	h.saveHelperMarksLocked(s)
	s.mu.Unlock()
	if err == nil {
		rec.Outcome = "ok"
		if note != "" {
			rec.Details["message"] = cleanText(note, 300)
		}
		_, _ = h.audit(context.Background(), rec)
		h.publishHelperUpdate(id, updStateUpdated, cleanText(note, 300), map[string]string{"from": from, "to": f.Version, "by": by})
		h.log.Info("Whombat Helper updated", "server", id, "from", from, "version", f.Version, "by", by)
		return
	}
	rec.Outcome, rec.Code = "error", "update_failed"
	rec.Details["error"] = cleanText(err.Error(), 300)
	_, _ = h.audit(context.Background(), rec)
	h.publishHelperUpdate(id, updStateFailed, cleanText(err.Error(), 300), map[string]string{"version": f.Version, "by": by})
	h.log.Warn("Whombat Helper update failed", "server", id, "version", f.Version, "by", by, "err", err)
	if errors.Is(err, errHelperNoAnswer) {
		h.setHelperHalted(f.Version)
		h.auditSystem(context.Background(), store.AuditRecord{Event: "agent.helper_update_halted", Outcome: "ok", User: "system",
			Server: id, Details: map[string]string{"version": f.Version}})
		h.log.Warn("automatic helper updates stopped: the new helper didn't answer", "server", id, "version", f.Version)
		m, _ := h.manifest()
		for _, st := range h.snapshot() {
			if u := h.helperInfoFor(st, m, nil); u != nil && u.State == updStateHalted {
				h.publishHelperUpdate(st.ID, updStateHalted, "", map[string]string{"version": f.Version})
			}
		}
	}
}

// ---- one Mac ----------------------------------------------------------------------------

// helperOne sends the hub's helper to one Mac and waits until its report
// names the new version; note is what the agent said (e.g. that the new
// helper runs without Accessibility).
func (h *Hub) helperOne(ctx context.Context, id string, m *agentManifest) (note string, err error) {
	st, ok := h.snapshotOne(id)
	if !ok {
		return "", errors.New("no such server")
	}
	u := h.helperInfoFor(st, m, nil)
	if u == nil {
		return "", errors.New("not a Mac")
	}
	if !u.Available {
		return "", errors.New(u.Reason)
	}
	f, _ := m.helper()
	sum, err1 := hex.DecodeString(f.SHA256)
	sig, err2 := base64.StdEncoding.DecodeString(f.Sig)
	if err1 != nil || err2 != nil {
		return "", errors.New("bad manifest entry")
	}
	file, err := os.Open(filepath.Join(h.cfg.AgentDist, helperZip))
	if err != nil {
		return "", err
	}
	defer file.Close()
	conn := h.conn(id)
	if conn == nil {
		return "", errors.New("the agent is not connected")
	}
	h.setHelperRollout(id, updStateUpdating, "Sending Whombat Helper "+f.Version)
	resp, err := conn.Update(ctx, proto.UpdateRequest{Component: proto.UpdateComponentHelper, Version: f.Version,
		Arch: proto.HelperArch, Size: f.Size, SHA256: sum, Signature: sig, Team: h.helperTeam(f)}, file)
	if err != nil {
		return "", err
	}
	if !resp.OK {
		msg := cmpOr(resp.Message, resp.Code)
		if resp.Code == helperNoAnswerCode {
			return "", fmt.Errorf("%w: %s", errHelperNoAnswer, msg)
		}
		return "", errors.New(msg)
	}
	h.setHelperRollout(id, updStateUpdating, "Installed; waiting for the Mac to report it")
	return resp.Message, h.waitHelperReported(ctx, id, f.Version)
}

// helperNoAnswerCode is the agent's answer when the new helper didn't
// answer at the screen (agent.CodeNoAnswer).
const helperNoAnswerCode = "no_answer"

// waitHelperReported waits until the Mac's report names version as its
// installed helper.
func (h *Hub) waitHelperReported(ctx context.Context, id, version string) error {
	deadline := time.Now().Add(h.cfg.AgentUpdateWait)
	for time.Now().Before(deadline) {
		if s, ok := h.snapshotOne(id); !ok {
			return errors.New("the server was deleted")
		} else if r := s.Report; r != nil && r.MacOS != nil && r.MacOS.Helper.Installed && r.MacOS.Helper.Version == version {
			return nil
		}
		select {
		case <-ctx.Done():
			return errShutdown
		case <-time.After(h.cfg.AgentUpdatePoll):
		}
		if h.closing.Load() {
			return errShutdown
		}
	}
	return errors.New("the Mac doesn't report the new Whombat Helper")
}

// autoHelper is the round's helper step for one server, after its agent's
// own: false when the hub is shutting down.
func (h *Hub) autoHelper(ctx context.Context, id string, m *agentManifest) bool {
	st, ok := h.snapshotOne(id)
	if !ok {
		return true
	}
	u := h.helperInfoFor(st, m, nil)
	if u == nil || !u.Auto {
		return true
	}
	s := h.agentUpdates()
	if u.State == updStateWaiting {
		s.mu.Lock()
		changed := s.hwaiting[id] != u.WaitingFor
		s.hwaiting[id] = u.WaitingFor
		s.mu.Unlock()
		if changed {
			h.publishHelperUpdate(id, updStateWaiting, "", map[string]string{"waiting_for": u.WaitingFor})
		}
		return true
	}
	s.mu.Lock()
	delete(s.hwaiting, id)
	s.mu.Unlock()
	f, _ := m.helper()
	note, err := h.helperOne(ctx, id, m)
	if ctx.Err() != nil || errors.Is(err, errShutdown) {
		h.setHelperRollout(id, "", "")
		return false
	}
	h.finishHelper(id, u.Installed, f, note, err, "auto", store.AuditRecord{User: "system", Role: store.RoleAdmin})
	return true
}
