package agent

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"rackoon/internal/agentver"
	"rackoon/internal/proto"
	"rackoon/internal/wire"
)

// UpdatePublicKey is the base64 Ed25519 public key that signs agent
// updates. `make agents` sets it from the build's signing key:
//
//	-ldflags "-X rackoon/internal/agent.UpdatePublicKey=<base64>"
//
// A binary built without it (go build by hand) refuses every update.
var UpdatePublicKey string

// Self-update limits and files.
const (
	MaxUpdateSize  = 128 << 20
	maxUpdateChunk = 1 << 20
	// UpdateConfirmWindow is how long a new version has to connect to the
	// hub before it is rolled back.
	UpdateConfirmWindow = 5 * time.Minute
	// maxUpdateStarts is how often a new version may start without
	// connecting (crash loop) before it is rolled back.
	maxUpdateStarts  = 3
	updateMarkerName = "update-pending.json"
	rollbackNoteName = "update-rolled-back.json"
	// UnraidConfigDir is the agent's configuration directory on Unraid; the
	// boot script installs the executable from this directory on the flash.
	UnraidConfigDir = "/boot/config/plugins/whombat-agent"
)

// Codes in UpdateResponse.
const (
	CodeUpdateDisabled = "update_disabled"
	CodeBadSignature   = "bad_signature"
	CodeSameVersion    = "same_version"
	CodeOlderVersion   = "older_version"
	CodeWrongArch      = "wrong_arch"
	CodeInstallFailed  = "install_failed"
)

// updateKey parses UpdatePublicKey (nil when unset or malformed).
func updateKey() ed25519.PublicKey {
	s := strings.TrimSpace(UpdatePublicKey)
	if s == "" {
		return nil
	}
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		b, err = base64.RawStdEncoding.DecodeString(s)
	}
	if err != nil || len(b) != ed25519.PublicKeySize {
		return nil
	}
	return ed25519.PublicKey(b)
}

// KeyFingerprint is the first 16 hex digits of the SHA-256 of a public key.
func KeyFingerprint(pub ed25519.PublicKey) string {
	sum := sha256.Sum256(pub)
	return hex.EncodeToString(sum[:])[:16]
}

// UpdateKeyFingerprint identifies the key this binary verifies updates
// with ("" = built without one: no self-update).
func UpdateKeyFingerprint() string {
	if k := updateKey(); k != nil {
		return KeyFingerprint(k)
	}
	return ""
}

// ExecutablePath returns the running executable with symlinks resolved.
// Call it at startup: once the file is replaced, /proc/self/exe names the
// deleted original.
func ExecutablePath() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(exe)
}

// ReExec replaces the process with exe, keeping the arguments and the
// environment (the PID stays, so systemd, supervise-daemon and `whombat-agent
// supervise` keep tracking it).
func ReExec(exe string) error {
	return syscall.Exec(exe, os.Args, os.Environ())
}

// PendingUpdate is the rollback marker (<state dir>/update-pending.json)
// written before a new executable is moved in place and removed after the
// new version's first hub connection.
type PendingUpdate struct {
	Version  string    `json:"version"`  // the new version
	Previous string    `json:"previous"` // the version it replaced
	Exe      string    `json:"exe"`      // the executable
	Prev     string    `json:"prev"`     // the previous executable, kept for the rollback
	Flash    string    `json:"flash,omitempty"`
	Attempts int       `json:"attempts"` // starts of the new version so far
	Deadline time.Time `json:"deadline"` // connect by then or roll back
}

func markerPath(stateDir string) string { return filepath.Join(stateDir, updateMarkerName) }

func readMarker(stateDir string) (*PendingUpdate, error) {
	b, err := os.ReadFile(markerPath(stateDir))
	if err != nil {
		return nil, err
	}
	var m PendingUpdate
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, fmt.Errorf("%s: %w", updateMarkerName, err)
	}
	return &m, nil
}

func writeMarker(stateDir string, m *PendingUpdate) error {
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return err
	}
	return WriteFileAtomic(markerPath(stateDir), append(b, '\n'), 0o600)
}

// startDecision is what a starting agent does about a pending update.
type startDecision int

const (
	startNormal   startDecision = iota // no update pending
	startWatch                         // new version: run, roll back unless it connects in time
	startRollback                      // restore the previous version
	startStale                         // the marker is not about this binary: remove it
)

// decideStart is the rollback rule: the marker's version must be ours
// (else it is stale: a rollback already happened, or someone installed
// another binary); this start is counted; more than maxUpdateStarts starts,
// or a start after the deadline, roll back.
func decideStart(m *PendingUpdate, version string, now time.Time) (startDecision, string) {
	switch {
	case m == nil:
		return startNormal, ""
	case m.Version != version:
		return startStale, "the pending update is for version " + m.Version
	case m.Attempts > maxUpdateStarts:
		return startRollback, fmt.Sprintf("version %s started %d times without connecting to the hub", m.Version, m.Attempts)
	case now.After(m.Deadline):
		return startRollback, fmt.Sprintf("version %s did not connect to the hub within %s", m.Version, UpdateConfirmWindow)
	}
	return startWatch, ""
}

// CheckPendingUpdate is the first thing `whombat-agent run` does. It
// counts this start of a freshly updated binary and decides: nil, nil when
// nothing is pending; the marker when the update awaits its first hub
// connection (pass it to Runtime.WatchUpdate); or, when the new version
// keeps failing, it restores the previous executable and re-executes it
// (and returns only if that fails).
func CheckPendingUpdate(stateDir, version string, log *slog.Logger) (*PendingUpdate, error) {
	m, err := readMarker(stateDir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		os.Remove(markerPath(stateDir))
		return nil, err
	}
	if m.Version == version {
		m.Attempts++
		if err := writeMarker(stateDir, m); err != nil {
			log.Warn("cannot update the update marker", "err", err)
		}
	}
	d, reason := decideStart(m, version, time.Now())
	switch d {
	case startStale:
		log.Info("removing a stale update marker", "reason", reason)
		os.Remove(markerPath(stateDir))
		return nil, nil
	case startWatch:
		return m, nil
	case startRollback:
		log.Error("UPDATE FAILED: rolling back to the previous version", "reason", reason, "previous", m.Previous, "executable", m.Exe)
		if err := RollBack(m, stateDir, reason, log); err != nil {
			log.Error("rollback failed; keeping the new version", "err", err)
			return nil, nil
		}
		log.Warn("restarting into the previous version", "version", m.Previous)
		return nil, ReExec(m.Exe)
	}
	return nil, nil
}

// RollBack restores the previous executable (and the Unraid flash copy)
// and removes the marker. The note is reported to the hub after the next
// connection.
func RollBack(m *PendingUpdate, stateDir, reason string, log *slog.Logger) error {
	defer os.Remove(markerPath(stateDir))
	if m.Prev == "" || m.Exe == "" {
		return errors.New("the update marker names no previous executable")
	}
	if _, err := os.Stat(m.Prev); err != nil {
		return err
	}
	// The previous binary is known to work: it runs the install helper
	// when the executable's directory is read-only for us.
	if err := installWithHelper(m.Prev, m.Prev, m.Exe, ""); err != nil {
		return err
	}
	if m.Flash != "" {
		if err := copyFileAtomic(m.Prev, m.Flash, 0o755); err != nil {
			log.Warn("cannot restore the agent on the boot flash", "path", m.Flash, "err", err)
		}
	}
	note, _ := json.Marshal(map[string]any{"version": m.Version, "previous": m.Previous, "reason": reason, "at": time.Now().UTC()})
	_ = WriteFileAtomic(filepath.Join(stateDir, rollbackNoteName), note, 0o600)
	return nil
}

// ---- receiving and installing --------------------------------------------------

// Updater verifies and installs a new agent executable.
type Updater struct {
	Exe      string // the running executable (resolved); replaced by the update
	StateDir string // rollback marker, staging fallback
	Flash    string // Unraid: the persistent copy on the boot flash ("" = none)
	Version  string // this binary's version
	Arch     string // runtime.GOARCH
	Key      ed25519.PublicKey
	Log      *slog.Logger

	// Replaceable in tests.
	now       func() time.Time
	versionOf func(ctx context.Context, path string) (string, error)
	install   func(helper, src, dst, backup string) error
}

// NewUpdater returns the updater for the running agent (nil key: updates
// are refused).
func NewUpdater(exe string, cfg *Config, version string, log *slog.Logger) *Updater {
	if log == nil {
		log = slog.Default()
	}
	u := &Updater{
		Exe:      exe,
		StateDir: cfg.StateDir,
		Version:  version,
		Arch:     runtime.GOARCH,
		Key:      updateKey(),
		Log:      log,
	}
	if filepath.Clean(cfg.Dir) == UnraidConfigDir {
		u.Flash = filepath.Join(UnraidConfigDir, "whombat-agent")
	}
	return u
}

func (u *Updater) clock() time.Time {
	if u.now != nil {
		return u.now()
	}
	return time.Now()
}

var versionRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+~-]{0,63}$`)

func fail(code, format string, a ...any) *proto.UpdateResponse {
	return &proto.UpdateResponse{Code: code, Message: fmt.Sprintf(format, a...)}
}

// Check validates a request before any byte of the executable is read:
// version, architecture, size and the signature over the announced digest.
func (u *Updater) Check(req proto.UpdateRequest) *proto.UpdateResponse {
	switch {
	case len(u.Key) != ed25519.PublicKeySize:
		return fail(CodeUpdateDisabled, "this agent was built without an update key")
	case !versionRe.MatchString(req.Version):
		return fail(CodeInstallFailed, "invalid version %q", req.Version)
	case req.Version == u.Version:
		return fail(CodeSameVersion, "version %s is already running", req.Version)
	case !agentver.Older(u.Version, req.Version):
		// Never back (AU-03): an older version, or one whose order is unknown.
		if c, ok := agentver.Compare(req.Version, u.Version); ok && c == 0 {
			return fail(CodeSameVersion, "version %s is already running", req.Version)
		}
		return fail(CodeOlderVersion, "version %s is not newer than the running %s", req.Version, u.Version)
	case req.Arch != u.Arch:
		return fail(CodeWrongArch, "the update is for %s, this agent runs on %s", req.Arch, u.Arch)
	case req.Size <= 0 || req.Size > MaxUpdateSize:
		return fail(CodeInstallFailed, "invalid size %d (at most %d MiB)", req.Size, MaxUpdateSize>>20)
	case len(req.SHA256) != sha256.Size || len(req.Signature) != ed25519.SignatureSize:
		return fail(CodeBadSignature, "missing or malformed digest or signature")
	case !ed25519.Verify(u.Key, req.SHA256, req.Signature):
		return fail(CodeBadSignature, "the signature does not verify with this agent's update key %s", KeyFingerprint(u.Key))
	}
	return nil
}

// isPermission reports errors from a read-only or protected location.
func isPermission(err error) bool {
	return errors.Is(err, syscall.EROFS) || errors.Is(err, os.ErrPermission)
}

// createStaging creates <exe>.new next to the executable, or, when that
// directory is read-only for us (systemd sandbox), in the state dir.
func (u *Updater) createStaging() (*os.File, string, error) {
	path := u.Exe + ".new"
	f, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o700)
	if err == nil {
		return f, path, nil
	}
	if !isPermission(err) {
		return nil, "", err
	}
	if err := os.MkdirAll(u.StateDir, 0o700); err != nil {
		return nil, "", err
	}
	path = filepath.Join(u.StateDir, "whombat-agent.new")
	f, err = os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o700)
	return f, path, err
}

// Receive writes the executable from next() (UpdateChunk payloads) to a
// staging file while hashing it, then checks size, digest and signature.
// It returns the staged file, or a response with the error.
func (u *Updater) Receive(req proto.UpdateRequest, next func() ([]byte, error)) (string, *proto.UpdateResponse) {
	f, path, err := u.createStaging()
	if err != nil {
		return "", fail(CodeInstallFailed, "cannot write the new executable: %v", err)
	}
	if r := receiveInto(f, "the new executable", req, u.Key, next); r != nil {
		os.Remove(path)
		return "", r
	}
	if err := os.Chmod(path, 0o755); err != nil {
		os.Remove(path)
		return "", fail(CodeInstallFailed, "chmod: %v", err)
	}
	return path, nil
}

// receiveInto writes req.Size bytes from next() (UpdateChunk payloads) to
// f while hashing them, closes f, and checks the digest and the signature
// with key. what names the file in messages.
func receiveInto(f *os.File, what string, req proto.UpdateRequest, key ed25519.PublicKey, next func() ([]byte, error)) *proto.UpdateResponse {
	closed := false
	defer func() {
		if !closed {
			f.Close()
		}
	}()
	h := sha256.New()
	w := io.MultiWriter(f, h)
	var n int64
	for n < req.Size {
		data, err := next()
		if err != nil {
			return fail(CodeInstallFailed, "the update stream ended after %d of %d bytes: %v", n, req.Size, err)
		}
		if len(data) == 0 || len(data) > maxUpdateChunk {
			return fail(CodeInstallFailed, "invalid chunk of %d bytes", len(data))
		}
		if n+int64(len(data)) > req.Size {
			return fail(CodeInstallFailed, "more data than the announced %d bytes", req.Size)
		}
		if _, err := w.Write(data); err != nil {
			return fail(CodeInstallFailed, "cannot write %s: %v", what, err)
		}
		n += int64(len(data))
	}
	if err := f.Sync(); err != nil {
		return fail(CodeInstallFailed, "cannot write %s: %v", what, err)
	}
	closed = true
	if err := f.Close(); err != nil {
		return fail(CodeInstallFailed, "cannot write %s: %v", what, err)
	}
	sum := h.Sum(nil)
	if !bytes.Equal(sum, req.SHA256) {
		return fail(CodeBadSignature, "the received file's SHA-256 does not match the signed digest")
	}
	if !ed25519.Verify(key, sum, req.Signature) {
		return fail(CodeBadSignature, "the signature does not verify with this agent's update key")
	}
	return nil
}

// runVersion runs `<path> version` and returns its output.
func runVersion(ctx context.Context, path string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "version")
	cmd.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin"}
	cmd.Dir = "/"
	out, err := cmd.Output()
	return string(out), err
}

// reportedVersion parses "whombat-agent <version>", or Rackoon's
// "rackoon-agent <version>" (an update may come from either build).
func reportedVersion(out string) string {
	line, _, _ := strings.Cut(strings.TrimSpace(out), "\n")
	f := strings.Fields(line)
	if len(f) >= 2 && (f[0] == "whombat-agent" || f[0] == "rackoon-agent") {
		return f[1]
	}
	return ""
}

// Install checks that the staged executable runs and reports the requested
// version, writes the rollback marker, keeps the current executable as
// <exe>.prev, moves the new one in place (and onto the Unraid flash). The
// caller then restarts the agent (ReExec).
func (u *Updater) Install(ctx context.Context, staged, version string) *proto.UpdateResponse {
	defer func() {
		if staged != u.Exe+".new" {
			os.Remove(staged) // copied from the state dir
		}
	}()
	versionOf := u.versionOf
	if versionOf == nil {
		versionOf = runVersion
	}
	out, err := versionOf(ctx, staged)
	if got := reportedVersion(out); err != nil || got != version {
		os.Remove(staged)
		if err != nil {
			return fail(CodeInstallFailed, "the new executable does not run here: %v", err)
		}
		return fail(CodeInstallFailed, "the new executable reports version %q, expected %q", got, version)
	}
	m := &PendingUpdate{
		Version:  version,
		Previous: u.Version,
		Exe:      u.Exe,
		Prev:     u.Exe + ".prev",
		Flash:    u.Flash,
		Deadline: u.clock().Add(UpdateConfirmWindow).UTC(),
	}
	// The marker first: a crash between here and the rename leaves a stale
	// marker (removed at the next start), never an unguarded new binary.
	if err := writeMarker(u.StateDir, m); err != nil {
		os.Remove(staged)
		return fail(CodeInstallFailed, "cannot write the rollback marker: %v", err)
	}
	install := u.install
	if install == nil {
		install = installWithHelper
	}
	if err := install(u.Exe, staged, u.Exe, m.Prev); err != nil {
		os.Remove(markerPath(u.StateDir))
		os.Remove(staged)
		return fail(CodeInstallFailed, "cannot install the new executable: %v", err)
	}
	if u.Flash != "" {
		if err := copyFileAtomic(u.Exe, u.Flash, 0o755); err != nil {
			u.Log.Warn("cannot copy the new agent to the boot flash; the previous version returns after a reboot", "path", u.Flash, "err", err)
		}
	}
	u.Log.Warn("agent update installed", "version", version, "previous", u.Version, "executable", u.Exe, "rollback_deadline", m.Deadline)
	return &proto.UpdateResponse{OK: true}
}

// ---- file operations -------------------------------------------------------------

// InstallExecutable replaces dst with a copy of src (via dst.new and a
// rename, so dst is never partial), after keeping dst as backup (when
// set). src may be dst.new itself.
func InstallExecutable(src, dst, backup string) error {
	if backup != "" {
		if _, err := os.Stat(dst); err == nil {
			os.Remove(backup)
			if err := os.Link(dst, backup); err != nil {
				if err := copyFileAtomic(dst, backup, 0o755); err != nil {
					return fmt.Errorf("keeping the previous executable: %w", err)
				}
			}
		}
	}
	tmp := dst + ".new"
	if filepath.Clean(src) != filepath.Clean(tmp) {
		if err := copyFile(src, tmp, 0o755); err != nil {
			os.Remove(tmp)
			return err
		}
	} else if err := os.Chmod(tmp, 0o755); err != nil {
		return err
	}
	if err := os.Rename(tmp, dst); err != nil {
		os.Remove(tmp)
		return err
	}
	syncDir(filepath.Dir(dst))
	return nil
}

// installWithHelper runs InstallExecutable here, or, when the systemd
// sandbox keeps the executable's directory read-only, through `helper
// update-install` in a transient systemd unit outside the sandbox.
func installWithHelper(helper, src, dst, backup string) error {
	err := InstallExecutable(src, dst, backup)
	if err == nil || !isPermission(err) || !underSystemd() {
		return err
	}
	argv := []string{"/usr/bin/systemd-run", "--quiet", "--wait", "--collect", "--pipe",
		"--service-type=exec", "--description=Whombat agent update",
		"--", helper, "update-install", "--from", src, "--to", dst}
	if backup != "" {
		argv = append(argv, "--backup", backup)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin"}
	out, herr := cmd.CombinedOutput()
	if herr != nil {
		return fmt.Errorf("%v (install helper: %v: %s)", err, herr, strings.TrimSpace(string(out)))
	}
	return nil
}

// underSystemd reports whether the agent runs as a systemd service (whose
// sandbox may make the executable's directory read-only).
func underSystemd() bool {
	if os.Getenv("INVOCATION_ID") == "" {
		return false
	}
	_, err := os.Stat("/usr/bin/systemd-run")
	return err == nil
}

func copyFile(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Sync(); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Chmod(dst, mode)
}

// copyFileAtomic copies src to dst through dst.tmp and a rename (on vfat,
// the Unraid flash, rename replaces the target too).
func copyFileAtomic(src, dst string, mode os.FileMode) error {
	tmp := dst + ".tmp"
	if err := copyFile(src, tmp, mode); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, dst); err != nil {
		os.Remove(tmp)
		return err
	}
	syncDir(filepath.Dir(dst))
	return nil
}

func syncDir(dir string) {
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		d.Close()
	}
}

// ---- runtime -------------------------------------------------------------------

// selfUpdate is the runtime's update state.
type selfUpdate struct {
	mu       sync.Mutex
	pending  *PendingUpdate
	timer    *time.Timer
	updating bool
}

// WatchUpdate arms the rollback deadline of a new version that has not
// connected to the hub yet (from CheckPendingUpdate).
func (rt *Runtime) WatchUpdate(m *PendingUpdate) {
	if m == nil {
		return
	}
	rt.upd.mu.Lock()
	defer rt.upd.mu.Unlock()
	rt.upd.pending = m
	rt.upd.timer = time.AfterFunc(time.Until(m.Deadline), rt.updateDeadline)
	rt.Log.Info("running a new agent version; it is rolled back unless it connects to the hub in time",
		"version", m.Version, "previous", m.Previous, "deadline", m.Deadline, "start", m.Attempts)
}

// updateConnected confirms a pending update after a successful HelloAck
// and reports an earlier rollback to the hub.
func (rt *Runtime) updateConnected() {
	stateDir := rt.Config().StateDir
	rt.upd.mu.Lock()
	m := rt.upd.pending
	rt.upd.pending = nil
	if rt.upd.timer != nil {
		rt.upd.timer.Stop()
		rt.upd.timer = nil
	}
	rt.upd.mu.Unlock()
	if m != nil {
		if err := os.Remove(markerPath(stateDir)); err != nil && !errors.Is(err, os.ErrNotExist) {
			rt.Log.Warn("cannot remove the update marker", "err", err)
		}
		rt.Log.Info("agent update confirmed", "version", m.Version, "previous", m.Previous)
	}
	notePath := filepath.Join(stateDir, rollbackNoteName)
	b, err := os.ReadFile(notePath)
	if err != nil {
		return
	}
	var note struct {
		Version string `json:"version"`
		Reason  string `json:"reason"`
	}
	_ = json.Unmarshal(b, &note)
	go func() {
		// Events are forwarded once the connection has finished its backfill.
		for i := 0; i < 120; i++ {
			rt.connMu.Lock()
			up := rt.conn != nil
			rt.connMu.Unlock()
			if up {
				rt.forwardEvent(proto.Event{Kind: "agent.update_rolled_back", Message: "Update to " + note.Version + " was rolled back: " + note.Reason})
				os.Remove(notePath)
				return
			}
			time.Sleep(500 * time.Millisecond)
		}
	}()
}

// updateDeadline rolls back a new version that never reached the hub.
func (rt *Runtime) updateDeadline() {
	rt.upd.mu.Lock()
	m := rt.upd.pending
	rt.upd.pending = nil
	rt.upd.mu.Unlock()
	if m == nil {
		return
	}
	reason := fmt.Sprintf("version %s did not connect to the hub within %s", m.Version, UpdateConfirmWindow)
	rt.Log.Error("UPDATE FAILED: rolling back to the previous version", "reason", reason, "previous", m.Previous)
	if err := RollBack(m, rt.Config().StateDir, reason, rt.Log); err != nil {
		rt.Log.Error("rollback failed; keeping the new version", "err", err)
		return
	}
	rt.restart("rollback to " + m.Previous)
}

// restart asks the caller of Run to end it and re-execute the agent.
func (rt *Runtime) restart(why string) {
	if rt.Restart == nil {
		rt.Log.Warn("restart needed but not supported here", "reason", why)
		return
	}
	rt.Log.Warn("restarting the agent", "reason", why)
	rt.Restart()
}

// serveUpdate handles a StreamUpdate: UpdateRequest, then UpdateChunk
// messages until Size bytes, answered by one UpdateResponse. After an OK
// answer the agent restarts into the new executable.
func (rt *Runtime) serveUpdate(ctx context.Context, st streamConn) {
	var req proto.UpdateRequest
	if err := wire.ReadMsg(st, &req); err != nil {
		return
	}
	switch req.Component {
	case "":
	case proto.UpdateComponentHelper:
		// Whombat Helper: installed beside the agent, which keeps running.
		resp := rt.receiveHelperUpdate(ctx, st, req)
		rt.Log.Info("helper update request", "version", req.Version, "size", req.Size,
			"ok", resp.OK, "code", resp.Code, "msg", resp.Message)
		_ = writeReply(st, resp)
		return
	default:
		_ = writeReply(st, proto.UpdateResponse{Code: CodeUnsupported, Message: fmt.Sprintf("unknown update component %q", req.Component)})
		return
	}
	resp := rt.receiveUpdate(ctx, st, req)
	rt.Log.Info("update request", "version", req.Version, "arch", req.Arch, "size", req.Size,
		"ok", resp.OK, "code", resp.Code, "msg", resp.Message)
	if err := writeReply(st, resp); err != nil || !resp.OK {
		return
	}
	// Let the hub read the answer and close the stream, then restart.
	st.SetReadDeadline(time.Now().Add(5 * time.Second))
	var discard proto.UpdateChunk
	_ = wire.ReadMsg(st, &discard)
	rt.restart("update installed")
}

func (rt *Runtime) receiveUpdate(ctx context.Context, st streamConn, req proto.UpdateRequest) proto.UpdateResponse {
	pol := rt.Policy()
	switch {
	case !pol.Update && UpdateKeyFingerprint() == "":
		return proto.UpdateResponse{Code: CodeUpdateDisabled, Message: "this agent was built without an update key"}
	case !pol.Update:
		return proto.UpdateResponse{Code: CodeUpdateDisabled, Message: "updates are turned off in this host's agent.toml ([update] allow)"}
	case rt.Updater == nil || rt.Restart == nil:
		return proto.UpdateResponse{Code: CodeUpdateDisabled, Message: "this agent cannot update itself"}
	}
	rt.upd.mu.Lock()
	busy := rt.upd.updating
	rt.upd.updating = true
	rt.upd.mu.Unlock()
	if busy {
		return proto.UpdateResponse{Code: CodeInstallFailed, Message: "another update is in progress"}
	}
	ok := false
	defer func() {
		if !ok { // after a successful install the agent restarts: no second update
			rt.upd.mu.Lock()
			rt.upd.updating = false
			rt.upd.mu.Unlock()
		}
	}()
	u := rt.Updater
	if r := u.Check(req); r != nil {
		return *r
	}
	staged, r := u.Receive(req, func() ([]byte, error) {
		st.SetReadDeadline(time.Now().Add(60 * time.Second))
		var c proto.UpdateChunk
		if err := wire.ReadMsg(st, &c); err != nil {
			return nil, err
		}
		return c.Data, nil
	})
	if r != nil {
		return *r
	}
	if r := u.Install(ctx, staged, req.Version); !r.OK {
		return *r
	}
	ok = true
	return proto.UpdateResponse{OK: true}
}
