package agent

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"rackoon/internal/agentver"
	"rackoon/internal/proto"
	"rackoon/internal/wire"
)

// Whombat Helper updates (docs/AGENT-PROTOCOL.md "Self-update"): the hub
// sends the helper's signed zip on the update stream with Component
// "helper"; the agent checks it like its own update and hands it to the
// Mac's installer (the screen part), then keeps running.

// MaxHelperSize bounds the helper's zip (a few MiB in practice).
const MaxHelperSize = 64 << 20

// CodeNoAnswer: the new helper didn't answer in the session at the screen,
// so the previous one was put back.
const CodeNoAnswer = "no_answer"

// helperZipName is the received zip in the state folder (root's, 0600).
const helperZipName = "helper-update.zip"

// HelperUpdater installs Whombat Helper on a Mac (the screen part; nil
// elsewhere). Its presence makes the agent report proto.CapHelperUpdate.
type HelperUpdater interface {
	// HelperVersion is the installed helper's version ("" = none, or it
	// can't be read).
	HelperVersion() string
	// InstallHelper installs the app in zip, a file whose signature the
	// agent verified; version is the app's, team the Apple team id the
	// hub's build names ("" = none).
	InstallHelper(ctx context.Context, zip, version, team string) proto.UpdateResponse
}

var teamIDRe = regexp.MustCompile(`^[A-Z0-9]{10}$`)

// CheckHelper validates a helper update before any byte of it is read:
// the key, the version against the installed one (never the same, never
// older: as the agent's own updates), the architecture, the size, the team
// and the signature over the announced digest.
func CheckHelper(req proto.UpdateRequest, key ed25519.PublicKey, installed string) *proto.UpdateResponse {
	switch {
	case len(key) != ed25519.PublicKeySize:
		return fail(CodeUpdateDisabled, "this agent was built without an update key")
	case !versionRe.MatchString(req.Version):
		return fail(CodeInstallFailed, "invalid helper version %q", req.Version)
	case installed != "" && installed == req.Version:
		return fail(CodeSameVersion, "Whombat Helper %s is already installed", req.Version)
	case installed != "" && !agentver.Older(installed, req.Version):
		if c, ok := agentver.Compare(req.Version, installed); ok && c == 0 {
			return fail(CodeSameVersion, "Whombat Helper %s is already installed", req.Version)
		}
		return fail(CodeOlderVersion, "Whombat Helper %s is not newer than the installed %s", req.Version, installed)
	case req.Arch != proto.HelperArch:
		return fail(CodeWrongArch, "the helper update is for %q, Whombat Helper is %s", req.Arch, proto.HelperArch)
	case req.Size <= 0 || req.Size > MaxHelperSize:
		return fail(CodeInstallFailed, "invalid size %d (at most %d MiB)", req.Size, MaxHelperSize>>20)
	case req.Team != "" && !teamIDRe.MatchString(req.Team):
		return fail(CodeInstallFailed, "invalid team id %q", req.Team)
	case len(req.SHA256) != sha256.Size || len(req.Signature) != ed25519.SignatureSize:
		return fail(CodeBadSignature, "missing or malformed digest or signature")
	case !ed25519.Verify(key, req.SHA256, req.Signature):
		return fail(CodeBadSignature, "the signature does not verify with this agent's update key %s", KeyFingerprint(key))
	}
	return nil
}

// receiveHelperUpdate answers one helper update: the agent's update and
// host shell switches, one update at a time (shared with the agent's own),
// the checks, the zip received into the state folder and verified, then
// the installer.
func (rt *Runtime) receiveHelperUpdate(ctx context.Context, st streamConn, req proto.UpdateRequest) proto.UpdateResponse {
	pol := rt.Policy()
	key := updateKey()
	if rt.Updater != nil {
		key = rt.Updater.Key
	}
	switch {
	case rt.Helper == nil:
		return proto.UpdateResponse{Code: CodeUnsupported, Message: "this agent doesn't install Whombat Helper (not a Mac)"}
	case len(key) != ed25519.PublicKeySize:
		return proto.UpdateResponse{Code: CodeUpdateDisabled, Message: "this agent was built without an update key"}
	case !pol.Update:
		return proto.UpdateResponse{Code: CodeUpdateDisabled, Message: "updates are turned off in this host's agent.toml ([update] allow)"}
	case !pol.HostShell:
		return proto.UpdateResponse{Code: CodeUpdateDisabled, Message: "Whombat Helper is updated only while the host shell is on in this host's agent.toml"}
	}
	rt.upd.mu.Lock()
	busy := rt.upd.updating || rt.upd.pending != nil
	if !busy {
		rt.upd.updating = true
	}
	rt.upd.mu.Unlock()
	if busy {
		return proto.UpdateResponse{Code: CodeInstallFailed, Message: "another update is in progress"}
	}
	defer func() {
		rt.upd.mu.Lock()
		rt.upd.updating = false
		rt.upd.mu.Unlock()
	}()
	if r := CheckHelper(req, key, rt.Helper.HelperVersion()); r != nil {
		return *r
	}
	stateDir := rt.Config().StateDir
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return *fail(CodeInstallFailed, "cannot write the helper's zip: %v", err)
	}
	path := filepath.Join(stateDir, helperZipName)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return *fail(CodeInstallFailed, "cannot write the helper's zip: %v", err)
	}
	defer os.Remove(path)
	if r := receiveInto(f, "the helper's zip", req, key, func() ([]byte, error) {
		st.SetReadDeadline(time.Now().Add(60 * time.Second))
		var c proto.UpdateChunk
		if err := wire.ReadMsg(st, &c); err != nil {
			return nil, err
		}
		return c.Data, nil
	}); r != nil {
		return *r
	}
	return rt.Helper.InstallHelper(ctx, path, req.Version, req.Team)
}
