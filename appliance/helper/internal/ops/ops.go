// Package ops implements the update helper's typed operations. Every operation re-derives what it
// acts on from the helper's own TUF verification (or from its own records of previously verified
// activations, for rollbacks); nothing in a request is used except the op name and an id.
package ops

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/internal/activator"
	"github.com/CybexBV/whombat/appliance/helper/pkg/kernlog"
	"github.com/CybexBV/whombat/appliance/helper/pkg/netconfig"
	"github.com/CybexBV/whombat/appliance/helper/pkg/proto"
	"github.com/CybexBV/whombat/appliance/helper/pkg/safeopen"
	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/helper/pkg/wifi"
)

// MirrorURL is the pseudo-URL under which the helper reads the manager's TUF mirror.
const MirrorURL = "mirror://whombat-tuf"

// Editions of the image (Whombat HE-58): commercial (control assigns every release) and community (no control: the
// newest release of the box's own repository, UP-X27).
const (
	EditionCommercial = "commercial"
	EditionCommunity  = "community"
)

// Config is fixed by the helper's systemd unit.
type Config struct {
	DeviceID string
	Env      string
	// Edition is EditionCommercial ("" too) or EditionCommunity, from the image's own configuration (root-owned): on a
	// community box an activation needs no assignment, only that the release is the newest of the helper's own
	// verified view (UP-X27).
	Edition string
	// DefaultChannel turns update channels on (Whombat LNK-20, LNK-21, UP-X29): the box takes the newest release of
	// its channel's delegated role, forward only, with no assignment (as a community box takes its repository's), and
	// this is the channel until set-channel records another. "": no channels (the edition decides, as before).
	DefaultChannel       string
	PinnedRootPath       string // root-owned trusted root from provisioning / host generation
	MirrorDir            string // manager-written TUF metadata mirror (untrusted input)
	StagingDir           string // manager-written artifacts named by sha256 (untrusted input)
	AssignmentPath       string // manager-written current assignment (untrusted input)
	NetworkCandidatesDir string // manager-written candidates (untrusted input)
	StateDir             string // helper-owned (0700): state.json, tuf/, work/
	// MetadataDir is the helper's own verified TUF cache; "" is StateDir/tuf. A box on the GitHub repository keeps it in
	// a folder of its own (Whombat LNK-26): its continued root rotates the timestamp and snapshot keys, so after a bridge
	// that rolled back the earlier helper must still find the old repository's chain in StateDir/tuf.
	MetadataDir  string
	MaxClockSkew time.Duration
	// RollbackWindow bounds how long after an activation the helper undoes it without an assignment
	// (rollback-runtime, activate-host-on-reboot of a recorded release; L-2). Default 6h.
	RollbackWindow time.Duration
	// CollectTimeout bounds a store collection (collect-garbage, UP-X19). Default proto.CollectTimeout.
	CollectTimeout time.Duration
	Now            func() time.Time
	// KernelMessages reads this boot's kernel messages for hardware-log (MG-114); nil: journalctl.
	KernelMessages func(ctx context.Context) ([]kernlog.Entry, error)
	// Wifi is iwd (NX-244); nil: no Wi-Fi, every Wi-Fi operation answers no_wifi. WifiDir is its profile directory
	// (/var/lib/iwd). WifiAddr returns an interface's address (default InterfaceAddress); WifiAddrWait bounds the wait
	// for one after a join (default 30 s), WifiJoinTimeout the join itself (default 45 s).
	Wifi            wifi.Client
	WifiDir         string
	WifiAddr        func(iface string) string
	WifiAddrWait    time.Duration
	WifiJoinTimeout time.Duration
}

// Helper executes operations one at a time.
type Helper struct {
	cfg Config
	act activator.Activator
	mu  sync.Mutex
}

// New creates a Helper.
func New(cfg Config, act activator.Activator) (*Helper, error) {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.MaxClockSkew == 0 {
		cfg.MaxClockSkew = 5 * time.Minute
	}
	if cfg.RollbackWindow == 0 {
		cfg.RollbackWindow = 6 * time.Hour
	}
	if cfg.CollectTimeout == 0 {
		cfg.CollectTimeout = proto.CollectTimeout
	}
	if cfg.MetadataDir == "" {
		cfg.MetadataDir = filepath.Join(cfg.StateDir, "tuf")
	}
	for _, d := range []string{cfg.StateDir, cfg.MetadataDir, filepath.Join(cfg.StateDir, "work")} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return nil, err
		}
	}
	return &Helper{cfg: cfg, act: act}, nil
}

func fail(code string, format string, a ...any) *proto.Error {
	return &proto.Error{Code: code, Message: fmt.Sprintf(format, a...)}
}

func trustErr(err error) *proto.Error {
	switch {
	case errors.Is(err, trust.ErrIncompatible):
		return fail(proto.CodeIncompatible, "%v", err)
	case errors.Is(err, trust.ErrExpired), errors.Is(err, trust.ErrUnavailable):
		return fail(proto.CodeMetadataStale, "%v", err)
	case errors.Is(err, trust.ErrDevelopmentRoot):
		return fail(proto.CodeVerificationFailed, "%v", err)
	case errors.Is(err, trust.ErrDowngrade):
		return fail(proto.CodeDowngrade, "%v", err)
	case errors.Is(err, trust.ErrAssignmentMismatch), errors.Is(err, trust.ErrAssignmentScope),
		errors.Is(err, trust.ErrAssignmentReplay), errors.Is(err, trust.ErrAssignmentTime),
		errors.Is(err, trust.ErrAssignmentSignature):
		return fail(proto.CodeNotAssigned, "%v", err)
	default:
		return fail(proto.CodeVerificationFailed, "%v", err)
	}
}

// Handle runs one validated request. post, if non-nil, must run after the reply was sent (reboot).
func (h *Helper) Handle(ctx context.Context, req proto.Request) (res *proto.Result, perr *proto.Error, post func()) {
	if err := req.Validate(); err != nil {
		return nil, fail(proto.CodeBadRequest, "%v", err), nil
	}
	// Read-only operations don't wait for the lock: hardware-log touches no state (MG-114); a Wi-Fi join may take a
	// minute, and the manager asks for the Wi-Fi state (and the cable's) every few seconds meanwhile.
	switch req.Op {
	case proto.OpHardwareLog:
		res, perr = h.hardwareLog(ctx)
		return res, perr, nil
	case proto.OpWifiStatus:
		res, perr = h.wifiStatus(ctx)
		return res, perr, nil
	case proto.OpWifiScan:
		res, perr = h.wifiScan(ctx)
		return res, perr, nil
	case proto.OpCableStatus:
		res, perr = h.cableStatus(ctx)
		return res, perr, nil
	case proto.OpChannel:
		// State is replaced atomically, so reading it beside a long operation (a store collection) is safe.
		st, err := loadState(h.cfg.StateDir)
		if err != nil {
			return nil, fail(proto.CodeInternal, "%v", err), nil
		}
		return &proto.Result{Channel: h.channel(st)}, nil, nil
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	st, err := loadState(h.cfg.StateDir)
	if err != nil {
		return nil, fail(proto.CodeInternal, "%v", err), nil
	}
	switch req.Op {
	case proto.OpStageRuntime:
		res, perr = h.stage(ctx, st, req.ReleaseID, false)
	case proto.OpStageHost:
		res, perr = h.stage(ctx, st, req.ReleaseID, true)
	case proto.OpActivateRuntime:
		res, perr = h.activateRuntime(ctx, st, req.ReleaseID)
	case proto.OpRollbackRuntime:
		res, perr = h.rollbackRuntime(ctx, st, req.ReleaseID)
	case proto.OpActivateHostOnReboot:
		res, perr, post = h.activateHost(ctx, st, req.ReleaseID)
	case proto.OpBlessBoot:
		res, perr = h.blessBoot(ctx, st)
	case proto.OpApplyNetwork:
		res, perr = h.applyNetwork(ctx, st, req.CandidateID)
	case proto.OpConfirmNetwork:
		res, perr = h.confirmNetwork(ctx, st, req.CandidateID)
	case proto.OpRevertNetwork:
		res, perr = h.revertNetwork(ctx, st)
	case proto.OpPruneHostGenerations:
		res, perr = h.pruneHostGenerations(ctx, st)
	case proto.OpPruneRuntimeGenerations:
		res, perr = h.pruneRuntimeGenerations(ctx, st)
	case proto.OpCollectGarbage:
		res, perr = h.collectGarbage(ctx)
	case proto.OpCheckSchema:
		res, perr = h.checkSchema(ctx, st, req.ReleaseID)
	case proto.OpMigrateRuntime:
		res, perr = h.migrateRuntime(ctx, st, req.ReleaseID, req.CheckpointID)
	case proto.OpKnownGoodManager:
		res, perr = h.knownGoodManager(st)
	case proto.OpMissingPaths:
		res, perr = h.missingPaths(ctx, req.StorePaths)
	case proto.OpWifiJoin:
		res, perr = h.wifiJoin(ctx, st, req)
	case proto.OpWifiForget:
		res, perr = h.wifiForget(ctx, st, req)
	case proto.OpWifiConfirm:
		res, perr = h.wifiConfirm(ctx, st, req.ChangeID)
	case proto.OpWifiRevert:
		res, perr = h.wifiRevert(ctx, st, req.ChangeID)
	case proto.OpCableSet:
		res, perr = h.cableSet(ctx, st, req)
	case proto.OpCableConfirm:
		res, perr = h.cableConfirm(ctx, st, req.ChangeID)
	case proto.OpCableRevert:
		res, perr = h.cableRevert(ctx, st, req.ChangeID)
	case proto.OpBackupRestore:
		if err := h.act.StartBackupRestore(ctx, req.CheckpointID); err != nil {
			perr = fail(proto.CodeActivationFailed, "start the restore: %v", err)
		} else {
			res = &proto.Result{}
		}
	case proto.OpSetChannel:
		res, perr = h.setChannel(st, req.Channel)
	case proto.OpBackupRestored:
		if err := h.act.RestartAfterRestore(ctx); err != nil {
			perr = fail(proto.CodeActivationFailed, "restart after the restore: %v", err)
		} else {
			res = &proto.Result{}
		}
	default:
		perr = fail(proto.CodeBadRequest, "unknown operation")
	}
	return res, perr, post
}

func (h *Helper) refNow(st *State) time.Time {
	now := h.cfg.Now()
	if floor := time.Unix(st.TimeFloor, 0); floor.After(now) {
		return floor
	}
	return now
}

// verified refreshes the helper's own TUF view from the mirror and resolves the release.
func (h *Helper) verified(st *State, id string) (*trust.Repo, *trust.Release, *proto.Error) {
	pinned, err := os.ReadFile(h.cfg.PinnedRootPath)
	if err != nil {
		return nil, nil, fail(proto.CodeInternal, "pinned root: %v", err)
	}
	repo, err := trust.Refresh(trust.Config{
		PinnedRoot: pinned, MetadataDir: h.cfg.MetadataDir, MetadataURL: MirrorURL,
		Fetcher: trust.DirFetcher{BaseURL: MirrorURL, Dir: h.cfg.MirrorDir}, Now: h.refNow(st), Production: h.cfg.Env == "prod",
		Channel: h.channel(st),
	})
	if err != nil {
		return nil, nil, trustErr(err)
	}
	// Raise the time floor from signed data (I-1): the timestamp was signed at most
	// MaxTimestampLifetime before it expires, so the time is at least expires − that lifetime. A clock
	// set back (e.g. by an unauthenticated time source) then can't make older metadata fresh again.
	if f := repo.TimestampExpires.Add(-MaxTimestampLifetime).Unix(); f > st.TimeFloor {
		st.TimeFloor = f
		if err := saveState(h.cfg.StateDir, st); err != nil {
			return nil, nil, fail(proto.CodeInternal, "%v", err)
		}
	}
	rel, err := repo.Release(id)
	if err != nil {
		return nil, nil, trustErr(err)
	}
	return repo, rel, nil
}

// MaxTimestampLifetime bounds how long before its expiry release custody signs timestamp.json (the
// release-signing runbook uses one day; this leaves a wide margin).
const MaxTimestampLifetime = 7 * 24 * time.Hour

// assigned verifies that the current control assignment names exactly this release; on a community box, that the
// release is the newest one (newest).
func (h *Helper) assigned(st *State, repo *trust.Repo, rel *trust.Release) *proto.Error {
	if h.cfg.Edition == EditionCommunity || h.channel(st) != "" {
		return h.newest(st, repo, rel)
	}
	data, err := readSmall(h.cfg.AssignmentPath, 16*1024)
	if err != nil {
		return fail(proto.CodeNotAssigned, "no assignment: %v", err)
	}
	ks, err := repo.AssignmentKeys(h.cfg.Env, h.refNow(st))
	if err != nil {
		return trustErr(err)
	}
	// The same assignment is presented for several operations (and again after a crash), so the
	// helper accepts its own highest sequence again but nothing older.
	sa, err := trust.VerifyAssignment(data, ks, trust.VerifyParams{DeviceID: h.cfg.DeviceID, Env: h.cfg.Env,
		Now: h.refNow(st), LastSequence: max(st.MaxAssignmentSeq-1, 0), MaxClockSkew: h.cfg.MaxClockSkew})
	if err != nil {
		return trustErr(err)
	}
	if err := trust.CheckAgainst(&sa.Payload, rel); err != nil {
		return trustErr(err)
	}
	st.MaxAssignmentSeq = sa.Payload.Sequence
	if sa.Payload.IssuedAt > st.TimeFloor {
		st.TimeFloor = sa.Payload.IssuedAt
	}
	return nil
}

// newest is assigned on a community box (Whombat HE-58, UP-X27): no control signs assignments there, so the helper
// takes no file from the manager and requires that rel is exactly the newest release its own verified view offers
// over the installed one (trust.NewestRelease, the manager's own choice), or the installed release itself (an
// activation or migration repeated after a crash). The assignment file and MaxAssignmentSeq are not read or changed.
func (h *Helper) newest(st *State, repo *trust.Repo, rel *trust.Release) *proto.Error {
	cur := st.Runtime.Current
	if cur == nil {
		cur = st.Host.Current
	}
	var curID, curDigest string
	var v *trust.Versions
	if cur != nil {
		curID, curDigest, v = cur.ReleaseID, cur.Digest, cur.Versions
		if cur.ReleaseID == rel.Tuple.ReleaseID && cur.Digest == rel.Digest {
			return nil
		}
	}
	if repo.ChannelPaused {
		return fail(proto.CodeNotAssigned, "the %s channel is paused", repo.Channel)
	}
	n, err := repo.NewestRelease(curID, v, curDigest)
	if err != nil {
		return trustErr(err)
	}
	if n == nil || n.Tuple.ReleaseID != rel.Tuple.ReleaseID || n.Digest != rel.Digest {
		want := "none (nothing newer than " + curID + ")"
		if n != nil {
			want = n.Tuple.ReleaseID
		}
		where := "this box's repository"
		if repo.Channel != "" {
			where = "the " + repo.Channel + " channel"
		}
		return fail(proto.CodeNotAssigned, "%s is not the newest release of %s (the newest is %s)", rel.Tuple.ReleaseID, where, want)
	}
	return nil
}

// channel is the box's update channel: the one set-channel recorded, else the image's default; "" without channels.
func (h *Helper) channel(st *State) string {
	if h.cfg.DefaultChannel == "" {
		return ""
	}
	if c := h.recordedChannel(st); c != "" {
		return c
	}
	return h.cfg.DefaultChannel
}

// recordedChannel is the channel the owner set (channelFile; state.json's channel from before it), "" none.
func (h *Helper) recordedChannel(st *State) string {
	if c := loadChannel(h.cfg.StateDir); trust.ValidChannel(c) {
		return c
	}
	if trust.ValidChannel(st.Channel) {
		return st.Channel
	}
	return ""
}

// setChannel records the box's update channel (LNK-21). Nothing else changes: the next activation must be the newest
// release of the new channel over the installed one, so a box moved from development to production stays where it is
// until production passes its versions.
func (h *Helper) setChannel(st *State, channel string) (*proto.Result, *proto.Error) {
	if h.cfg.DefaultChannel == "" {
		return nil, fail(proto.CodeBadRequest, "this box's image has no update channels")
	}
	if loadChannel(h.cfg.StateDir) == channel {
		return &proto.Result{Channel: channel, AlreadyDone: true}, nil
	}
	if err := saveChannel(h.cfg.StateDir, channel); err != nil {
		return nil, fail(proto.CodeInternal, "%v", err)
	}
	return &proto.Result{Channel: channel}, nil
}

// SetChannel records the channel from root's command line (whombat-update-helper set-channel: a bridge release, the
// recovery menu).
func (h *Helper) SetChannel(channel string) error {
	_, err := h.setChannelFromRoot(channel, false)
	return err
}

// SetChannelIfUnset records the channel only when the box has none recorded (`set-channel <c> --if-unset`), and
// answers whether it wrote. The one image's channel bridge (ONE-03): a box that took development as its image's
// default, never as its owner's choice, keeps it when the next image's default is production; a choice the owner made
// is never overwritten.
func (h *Helper) SetChannelIfUnset(channel string) (bool, error) {
	return h.setChannelFromRoot(channel, true)
}

func (h *Helper) setChannelFromRoot(channel string, ifUnset bool) (bool, error) {
	if !trust.ValidChannel(channel) {
		return false, fmt.Errorf("unknown channel %q (%v)", channel, trust.Channels)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	st, err := loadState(h.cfg.StateDir)
	if err != nil {
		return false, err
	}
	if ifUnset && h.cfg.DefaultChannel != "" && h.recordedChannel(st) != "" {
		return false, nil
	}
	res, perr := h.setChannel(st, channel)
	if perr != nil {
		return false, errors.New(perr.Message)
	}
	return !res.AlreadyDone, nil
}

// readSmall reads a manager-written file (assignment, network candidate) without following symlinks
// anywhere in the path or blocking on a FIFO (safeopen, L-6).
func readSmall(p string, max int64) ([]byte, error) { return safeopen.ReadSmall(p, max) }

// copyErr maps a CopyVerified failure of a staged file.
func copyErr(what string, err error) *proto.Error {
	if errors.Is(err, os.ErrNotExist) {
		return fail(proto.CodeNotStaged, "%s not downloaded", what)
	}
	if errors.Is(err, syscall.ENOSPC) {
		return fail(proto.CodeNoSpace, "copy %s: %v", what, err)
	}
	return fail(proto.CodeVerificationFailed, "%s: %v", what, err)
}

func importErr(what string, err error) *proto.Error {
	if errors.Is(err, activator.ErrNoSpace) || errors.Is(err, syscall.ENOSPC) {
		return fail(proto.CodeNoSpace, "import %s: %v", what, err)
	}
	if errors.Is(err, trust.ErrNarMismatch) {
		return fail(proto.CodeVerificationFailed, "import %s: %v", what, err)
	}
	return fail(proto.CodeActivationFailed, "import %s: %v", what, err)
}

// stageIndex imports the paths of a component's closure index the store lacks, in the index's order (UP-X14). The
// index comes from the helper's own verified view (ia); each blob is copied (root-owned, fileSize/fileHash of the
// index), decompressed once to check the NAR's hash and size, and decompressed again into `nix-store --import`
// (whose frame is completed only if the NAR checks out again), then the copy is removed.
func (h *Helper) stageIndex(ctx context.Context, ia trust.Artifact) *proto.Error {
	if ok, _ := h.act.HasStorePath(ctx, ia.Meta.StorePath); ok {
		return nil // its closure is valid with it
	}
	work := filepath.Join(h.cfg.StateDir, "work")
	tmp := filepath.Join(work, ia.SHA256())
	_ = os.Remove(tmp)
	if err := trust.CopyVerified(filepath.Join(h.cfg.StagingDir, ia.SHA256()), tmp, ia); err != nil {
		return copyErr(ia.Target, err)
	}
	b, err := readSmall(tmp, ia.Length)
	_ = os.Remove(tmp)
	if err != nil {
		return fail(proto.CodeInternal, "read %s: %v", ia.Target, err)
	}
	ci, err := trust.ParseClosureIndex(b, ia)
	if err != nil {
		return fail(proto.CodeVerificationFailed, "%v", err)
	}
	invalid, err := h.act.InvalidPaths(ctx, ci.StorePaths())
	if err != nil {
		return fail(proto.CodeInternal, "check validity: %v", err)
	}
	missing := make(map[string]bool, len(invalid))
	for _, p := range invalid {
		missing[p] = true
	}
	for i, p := range ci.Paths {
		if !missing[p.StorePath] {
			continue
		}
		if perr := h.importBlob(ctx, ci.Blob(i), p, work); perr != nil {
			return perr
		}
	}
	if ok, _ := h.act.HasStorePath(ctx, ia.Meta.StorePath); !ok {
		return fail(proto.CodeActivationFailed, "the index of %s was imported but the path is not valid", ia.Meta.StorePath)
	}
	return nil
}

func (h *Helper) importBlob(ctx context.Context, blob trust.Artifact, p trust.IndexPath, work string) *proto.Error {
	tmp := filepath.Join(work, blob.SHA256())
	_ = os.Remove(tmp)
	defer os.Remove(tmp)
	if err := trust.CopyVerified(filepath.Join(h.cfg.StagingDir, blob.SHA256()), tmp, blob); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return fail(proto.CodeNotStaged, "the blob of %s is not downloaded", p.StorePath)
		}
		return copyErr("the blob of "+p.StorePath, err)
	}
	// Pass 1: the whole NAR checks out before anything reaches the store.
	f, err := safeopen.OpenRegular(tmp)
	if err != nil {
		return fail(proto.CodeInternal, "%v", err)
	}
	err = trust.VerifyNar(trust.IOReader(f), p.NarHash, p.NarSize)
	f.Close()
	if err != nil {
		if errors.Is(err, trust.ErrNarMismatch) {
			return fail(proto.CodeVerificationFailed, "%s: %v", p.StorePath, err)
		}
		return fail(proto.CodeInternal, "%s: %v", p.StorePath, err)
	}
	// Pass 2: decompress into the import, checking the hash again at the NAR's end.
	f, err = safeopen.OpenRegular(tmp)
	if err != nil {
		return fail(proto.CodeInternal, "%v", err)
	}
	defer f.Close()
	nr, err := trust.NewNarReader(f, p.NarSize)
	if err != nil {
		return fail(proto.CodeInternal, "%v", err)
	}
	defer nr.Close()
	err = h.act.ImportNar(ctx, activator.NarPath{StorePath: p.StorePath, NarSize: p.NarSize, References: p.References, Deriver: p.Deriver},
		trust.CheckingNarReader(nr, p.NarHash, p.NarSize))
	if err != nil {
		return importErr(p.StorePath, err)
	}
	if ok, _ := h.act.HasStorePath(ctx, p.StorePath); !ok {
		return fail(proto.CodeActivationFailed, "import did not provide %s", p.StorePath)
	}
	return nil
}

// stageUnits stages the release's components (host first when host is set) through their closure indexes.
func (h *Helper) stageUnits(ctx context.Context, rel *trust.Release, host bool) ([]string, *proto.Error) {
	var paths []string
	for _, ix := range rel.Indexes(host) {
		paths = append(paths, ix.Meta.StorePath)
		if perr := h.stageIndex(ctx, ix); perr != nil {
			return nil, perr
		}
	}
	return paths, nil
}

func (h *Helper) stage(ctx context.Context, st *State, id string, host bool) (*proto.Result, *proto.Error) {
	_, rel, perr := h.verified(st, id)
	if perr != nil {
		return nil, perr
	}
	paths, perr := h.stageUnits(ctx, rel, host)
	if perr != nil {
		return nil, perr
	}
	return &proto.Result{ReleaseID: id, StorePaths: paths}, nil
}

// missingPaths answers which of the given (validated) store paths are not valid. Read-only: the answer only lets the
// manager skip downloads; staging decides from its own verified index.
func (h *Helper) missingPaths(ctx context.Context, storePaths []string) (*proto.Result, *proto.Error) {
	invalid, err := h.act.InvalidPaths(ctx, storePaths)
	if err != nil {
		return nil, fail(proto.CodeInternal, "check validity: %v", err)
	}
	return &proto.Result{Missing: invalid}, nil
}

func runtimeSet(rel *trust.Release) activator.RuntimeSet {
	set := activator.RuntimeSet{Runtime: rel.Tuple.Runtime.StorePath, Providers: map[string]string{}}
	for _, p := range rel.Tuple.Providers {
		set.Providers[p.Provider] = p.StorePath
	}
	return set
}

func (h *Helper) activated(rel *trust.Release) *Activated {
	v := rel.VersionsOf()
	return &Activated{ReleaseID: rel.Tuple.ReleaseID, Digest: rel.Digest, Host: rel.Tuple.Host.StorePath,
		Runtime: runtimeSet(rel), At: h.cfg.Now().Unix(), Manager: rel.Tuple.Manager.StorePath, Versions: &v}
}

// forward refuses a tuple older than the recorded one unless release custody allowed moving back from
// it (TUF-signed allowDowngradeFrom; MA-21c, M-2). The manager checks the same; the helper does not rely
// on it. A record without versions has unknown installed versions: the helper refuses unless custody names
// the installed release in allowDowngradeFrom (N-5). Every helper since 0.5.2 records them (UP-X25: the
// backfill of older records went).
func (h *Helper) forward(cur *Activated, rel *trust.Release) *proto.Error {
	if cur == nil || cur.Digest == rel.Digest {
		return nil
	}
	if cur.Versions == nil {
		for _, from := range rel.AllowDowngradeFrom {
			if from == cur.ReleaseID {
				return nil
			}
		}
		return fail(proto.CodeDowngrade, "%v: the installed release %s has no recorded versions; "+
			"release custody must name it in allowDowngradeFrom of %s", trust.ErrDowngrade, cur.ReleaseID, rel.Tuple.ReleaseID)
	}
	if err := trust.CheckForward(cur.ReleaseID, *cur.Versions, rel); err != nil {
		return trustErr(err)
	}
	return nil
}

// withdrawn reports whether fresh, verified metadata no longer approves id (release custody withdrew it).
// Stale or unavailable metadata is not a verdict: rollbacks must work offline.
func (h *Helper) withdrawn(st *State, id string) bool {
	pinned, err := os.ReadFile(h.cfg.PinnedRootPath)
	if err != nil {
		return false
	}
	// With channels a release is withdrawn when no channel lists it any more: a box that just changed channel can
	// still go back to the release it ran, which only the other channel lists.
	channels := []string{h.channel(st)}
	if channels[0] != "" {
		for _, c := range trust.Channels {
			if c != channels[0] {
				channels = append(channels, c)
			}
		}
	}
	for _, c := range channels {
		repo, err := trust.Refresh(trust.Config{
			PinnedRoot: pinned, MetadataDir: h.cfg.MetadataDir, MetadataURL: MirrorURL,
			Fetcher: trust.DirFetcher{BaseURL: MirrorURL, Dir: h.cfg.MirrorDir}, Now: h.refNow(st), Production: h.cfg.Env == "prod",
			Channel: c,
		})
		if err != nil {
			return false
		}
		if _, err = repo.Release(id); !errors.Is(err, trust.ErrNotApproved) {
			return false
		}
	}
	return true
}

// undoAllowed decides whether the helper may switch to a recorded release without an assignment (L-2):
// only to undo an activation that is not finished (a host activation waiting for its blessing, or a
// runtime activated within RollbackWindow), or to align profiles with the host that is already booted,
// and never to a release that fresh metadata shows as withdrawn.
func (h *Helper) undoAllowed(st *State, target *Activated, booted string, align bool) *proto.Error {
	aligned := align && target.Host == booted
	unfinished := st.Host.Pending != nil
	if cur := st.Runtime.Current; cur != nil && h.cfg.Now().Sub(time.Unix(cur.At, 0)) < h.cfg.RollbackWindow {
		unfinished = true
	}
	if !unfinished && !aligned {
		return fail(proto.CodeRollbackRefused, "no unfinished activation to undo; moving to %s needs an assignment", target.ReleaseID)
	}
	if !aligned && h.withdrawn(st, target.ReleaseID) {
		return fail(proto.CodeRollbackRefused, "%s was withdrawn by release custody; not rolling back to it (needs a forward fix)", target.ReleaseID)
	}
	return nil
}

// knownGoodManager returns the whombat-manager store paths of the recorded known-good hosts (current,
// then previous), all resolved from TUF-verified tuples at activation. whombat-manager-recovery execs
// one of them from the read-only store; nothing manager-writable is ever executed (M-3, MA-21d).
func (h *Helper) knownGoodManager(st *State) (*proto.Result, *proto.Error) {
	var paths []string
	for _, a := range []*Activated{st.Host.Current, st.Host.Previous} {
		if a != nil && a.Manager != "" && trust.ValidStorePath(a.Manager) {
			paths = append(paths, a.Manager)
		}
	}
	if len(paths) == 0 {
		return nil, fail(proto.CodeNothingToRollBack, "no recorded known-good manager")
	}
	return &proto.Result{StorePaths: paths}, nil
}

func (h *Helper) allPresent(ctx context.Context, a *Activated) *proto.Error {
	paths := []string{a.Runtime.Runtime}
	for _, p := range a.Runtime.Providers {
		paths = append(paths, p)
	}
	if a.Host != "" {
		paths = append(paths, a.Host)
	}
	for _, p := range paths {
		if ok, _ := h.act.HasStorePath(ctx, p); !ok {
			return fail(proto.CodeNotStaged, "%s is not in the store", p)
		}
	}
	return nil
}

func (h *Helper) activateRuntime(ctx context.Context, st *State, id string) (*proto.Result, *proto.Error) {
	repo, rel, perr := h.verified(st, id)
	if perr != nil {
		return nil, perr
	}
	if perr := h.assigned(st, repo, rel); perr != nil {
		return nil, perr
	}
	if perr := h.forward(st.Runtime.Current, rel); perr != nil {
		return nil, perr
	}
	booted, err := h.act.CurrentSystem(ctx)
	if err != nil {
		return nil, fail(proto.CodeInternal, "current system: %v", err)
	}
	if booted != rel.Tuple.Host.StorePath {
		return nil, fail(proto.CodeIncompatible, "tuple %s is for host %s but %s is booted; a host update is required", id, rel.Tuple.Host.StorePath, booted)
	}
	next := h.activated(rel)
	if perr := h.allPresent(ctx, &Activated{Runtime: next.Runtime}); perr != nil {
		return nil, perr
	}
	// Intent first: once recorded, rollback-runtime restores the previous runtime from any partial
	// state (profiles switched but restart failed, crash in between, ...). Re-activating the same
	// release re-applies profiles and restarts (idempotent; the runtime is drained).
	already := false
	if cur := st.Runtime.Current; cur != nil && cur.ReleaseID == id && cur.Digest == rel.Digest {
		already = true
	} else {
		st.Runtime.Previous = st.Runtime.Current
		st.Runtime.Current = next
		st.Runtime.LastRollbackFrom = ""
	}
	if err := saveState(h.cfg.StateDir, st); err != nil {
		return nil, fail(proto.CodeInternal, "%v", err)
	}
	if err := h.act.SetRuntime(ctx, next.Runtime); err != nil {
		return nil, fail(proto.CodeActivationFailed, "%v", err)
	}
	if err := h.act.RestartRuntime(ctx); err != nil {
		return nil, fail(proto.CodeActivationFailed, "%v", err)
	}
	return &proto.Result{ReleaseID: id, AlreadyDone: already}, nil
}

// rollbackRuntime restores the previous runtime. With `from` (the manager always sends its
// candidate) it only rolls back when `from` is the recorded current runtime; otherwise the
// activation never took effect here and there is nothing to undo (no rollback past known-good).
func (h *Helper) rollbackRuntime(ctx context.Context, st *State, from string) (*proto.Result, *proto.Error) {
	if cur := st.Runtime.Current; from != "" && (cur == nil || cur.ReleaseID != from) {
		cid := ""
		if cur != nil {
			cid = cur.ReleaseID
		}
		rbFrom := ""
		if st.Runtime.LastRollbackFrom == from {
			rbFrom = from
		}
		return &proto.Result{ReleaseID: cid, RolledBackFrom: rbFrom, AlreadyDone: true}, nil
	}
	prev := st.Runtime.Previous
	if prev == nil {
		if st.Runtime.LastRollbackFrom != "" && st.Runtime.Current != nil {
			return &proto.Result{ReleaseID: st.Runtime.Current.ReleaseID, RolledBackFrom: st.Runtime.LastRollbackFrom, AlreadyDone: true}, nil
		}
		return nil, fail(proto.CodeNothingToRollBack, "no previous runtime recorded")
	}
	booted, err := h.act.CurrentSystem(ctx)
	if err != nil {
		return nil, fail(proto.CodeInternal, "current system: %v", err)
	}
	// A runtime rollback is always the undo of a recent activation.
	if perr := h.undoAllowed(st, prev, booted, false); perr != nil {
		return nil, perr
	}
	if perr := h.allPresent(ctx, &Activated{Runtime: prev.Runtime}); perr != nil {
		return nil, perr
	}
	if err := h.act.SetRuntime(ctx, prev.Runtime); err != nil {
		return nil, fail(proto.CodeActivationFailed, "%v", err)
	}
	if err := h.act.RestartRuntime(ctx); err != nil {
		return nil, fail(proto.CodeActivationFailed, "%v", err)
	}
	was := ""
	if st.Runtime.Current != nil {
		was = st.Runtime.Current.ReleaseID
	}
	st.Runtime.Current, st.Runtime.Previous, st.Runtime.LastRollbackFrom = prev, nil, was
	if err := saveState(h.cfg.StateDir, st); err != nil {
		return nil, fail(proto.CodeInternal, "%v", err)
	}
	return &proto.Result{ReleaseID: prev.ReleaseID, RolledBackFrom: was}, nil
}

// recordedHostTarget finds the release id among the tuples the helper activated itself, for a host activation without
// an assignment (a rollback or an alignment, MG-57): a recorded host (Host.Current/Previous), or a runtime-only release
// (Runtime.Current/Previous: activated on the host its tuple names, which the helper had booted and verified then)
// whose host is a recorded host or the booted system. The known-good of a box on a runtime-only release is such a
// release: its host generation is the one the host release before it installed, and the rollback boots that
// generation with the known-good runtime. Nil: not a recorded release (it needs a verified assignment).
func recordedHostTarget(st *State, id, booted string) *Activated {
	for _, rec := range []*Activated{st.Host.Current, st.Host.Previous} {
		if rec != nil && rec.ReleaseID == id {
			c := *rec
			return &c
		}
	}
	hosts := map[string]bool{booted: booted != ""}
	for _, h := range []*Activated{st.Host.Current, st.Host.Previous} {
		if h != nil && h.Host != "" {
			hosts[h.Host] = true
		}
	}
	for _, rec := range []*Activated{st.Runtime.Current, st.Runtime.Previous} {
		if rec != nil && rec.ReleaseID == id && rec.Digest != "" && hosts[rec.Host] {
			c := *rec
			return &c
		}
	}
	return nil
}

// activateHost makes a tuple the boot default (host generation + runtime profiles). Targets are
// either the assigned, TUF-verified candidate or a release the helper itself recorded as activated
// before (rollback, which must work even when metadata cannot be refreshed; recordedHostTarget): a
// host release, or a runtime-only release on a recorded host. It reboots only when the booted system
// differs; otherwise it restarts the runtime on the switched profiles.
func (h *Helper) activateHost(ctx context.Context, st *State, id string) (*proto.Result, *proto.Error, func()) {
	booted, err := h.act.CurrentSystem(ctx)
	if err != nil {
		return nil, fail(proto.CodeInternal, "current system: %v", err), nil
	}
	next := recordedHostTarget(st, id, booted)
	if next != nil {
		// A recorded release without an assignment: only undoing an unfinished activation or aligning
		// with the booted host, never a withdrawn release (L-2).
		if perr := h.undoAllowed(st, next, booted, true); perr != nil {
			return nil, perr, nil
		}
	} else {
		repo, rel, perr := h.verified(st, id)
		if perr != nil {
			return nil, perr, nil
		}
		if perr := h.assigned(st, repo, rel); perr != nil {
			return nil, perr, nil
		}
		cur := st.Host.Current
		if cur == nil {
			cur = st.Runtime.Current
		}
		if perr := h.forward(cur, rel); perr != nil {
			return nil, perr, nil
		}
		next = h.activated(rel)
	}
	if perr := h.allPresent(ctx, next); perr != nil {
		return nil, perr, nil
	}
	if cur := st.Runtime.Current; cur == nil || cur.ReleaseID != next.ReleaseID {
		st.Runtime.Previous = st.Runtime.Current
		st.Runtime.Current = next
		st.Runtime.LastRollbackFrom = ""
	}
	if booted != next.Host {
		st.Host.Pending = next
	}
	if err := saveState(h.cfg.StateDir, st); err != nil {
		return nil, fail(proto.CodeInternal, "%v", err), nil
	}
	if err := h.act.SetRuntime(ctx, next.Runtime); err != nil {
		return nil, fail(proto.CodeActivationFailed, "%v", err), nil
	}
	if err := h.act.SetBootSystem(ctx, next.Host); err != nil {
		return nil, fail(proto.CodeActivationFailed, "%v", err), nil
	}
	if booted == next.Host {
		// Already running this host (e.g. boot counting fell back): no reboot, restart the runtime.
		if err := h.act.RestartRuntime(ctx); err != nil {
			return nil, fail(proto.CodeActivationFailed, "%v", err), nil
		}
		if st.Host.Current == nil || st.Host.Current.ReleaseID != next.ReleaseID {
			st.Host.Previous = st.Host.Current
		}
		st.Host.Current, st.Host.Pending = next, nil
		if err := saveState(h.cfg.StateDir, st); err != nil {
			return nil, fail(proto.CodeInternal, "%v", err), nil
		}
		return &proto.Result{ReleaseID: id}, nil, nil
	}
	post := func() { _ = h.act.ScheduleReboot(context.Background()) }
	return &proto.Result{ReleaseID: id, RebootPending: true}, nil, post
}

func (h *Helper) blessBoot(ctx context.Context, st *State) (*proto.Result, *proto.Error) {
	booted, err := h.act.CurrentSystem(ctx)
	if err != nil {
		return nil, fail(proto.CodeInternal, "current system: %v", err)
	}
	p := st.Host.Pending
	if p == nil {
		if st.Host.Current != nil && st.Host.Current.Host == booted {
			if err := h.act.BlessBoot(ctx); err != nil {
				return nil, fail(proto.CodeActivationFailed, "%v", err)
			}
			return &proto.Result{ReleaseID: st.Host.Current.ReleaseID, AlreadyDone: true}, nil
		}
		return nil, fail(proto.CodeBootMismatch, "no pending host activation for booted %s", booted)
	}
	if booted != p.Host {
		return nil, fail(proto.CodeBootMismatch, "booted %s, pending %s (boot fell back)", booted, p.Host)
	}
	if err := h.act.BlessBoot(ctx); err != nil {
		return nil, fail(proto.CodeActivationFailed, "%v", err)
	}
	if st.Host.Current == nil || st.Host.Current.ReleaseID != p.ReleaseID {
		st.Host.Previous = st.Host.Current
	}
	st.Host.Current, st.Host.Pending = p, nil
	if err := saveState(h.cfg.StateDir, st); err != nil {
		return nil, fail(proto.CodeInternal, "%v", err)
	}
	return &proto.Result{ReleaseID: p.ReleaseID}, nil
}

func (h *Helper) applyNetwork(ctx context.Context, st *State, id string) (*proto.Result, *proto.Error) {
	if st.Network.Pending == id {
		return &proto.Result{CandidateID: id, AlreadyDone: true}, nil
	}
	if st.Network.Pending != "" {
		return nil, fail(proto.CodeBadRequest, "candidate %s is still pending; confirm or revert it first", st.Network.Pending)
	}
	data, err := readSmall(filepath.Join(h.cfg.NetworkCandidatesDir, id+".json"), netconfig.MaxBytes)
	if err != nil {
		return nil, fail(proto.CodeBadRequest, "candidate: %v", err)
	}
	c, err := netconfig.Parse(data)
	if err != nil || c.ID != id {
		return nil, fail(proto.CodeBadRequest, "candidate invalid: %v", err)
	}
	// Arm the dead-man first: if anything below (or the manager) dies, the network reverts.
	if err := h.act.ArmNetworkRevert(ctx, c.ConfirmTimeoutSec+30); err != nil {
		return nil, fail(proto.CodeActivationFailed, "%v", err)
	}
	st.Network.Pending = id
	if err := saveState(h.cfg.StateDir, st); err != nil {
		return nil, fail(proto.CodeInternal, "%v", err)
	}
	if err := h.act.ApplyNetwork(ctx, c); err != nil {
		_ = h.act.RevertNetwork(ctx)
		st.Network.Pending = ""
		_ = saveState(h.cfg.StateDir, st)
		return nil, fail(proto.CodeActivationFailed, "%v", err)
	}
	return &proto.Result{CandidateID: id}, nil
}

func (h *Helper) confirmNetwork(ctx context.Context, st *State, id string) (*proto.Result, *proto.Error) {
	if st.Network.Pending != id {
		if st.Network.Committed == id {
			return &proto.Result{CandidateID: id, AlreadyDone: true}, nil
		}
		return nil, fail(proto.CodeBadRequest, "candidate %s is not pending", id)
	}
	if err := h.act.DisarmNetworkRevert(ctx); err != nil {
		return nil, fail(proto.CodeActivationFailed, "%v", err)
	}
	st.Network.Pending, st.Network.Committed = "", id
	if err := saveState(h.cfg.StateDir, st); err != nil {
		return nil, fail(proto.CodeInternal, "%v", err)
	}
	return &proto.Result{CandidateID: id}, nil
}

func (h *Helper) revertNetwork(ctx context.Context, st *State) (*proto.Result, *proto.Error) {
	if err := h.act.RevertNetwork(ctx); err != nil {
		return nil, fail(proto.CodeActivationFailed, "%v", err)
	}
	id := st.Network.Pending
	st.Network.Pending = ""
	if err := saveState(h.cfg.StateDir, st); err != nil {
		return nil, fail(proto.CodeInternal, "%v", err)
	}
	return &proto.Result{CandidateID: id, AlreadyDone: id == ""}, nil
}

// pruneHostGenerations deletes system generations whose store path is none of: the booted system,
// the profile's current default, the helper's recorded current host, previous (known-good) host and
// pending host. Everything kept is derived from the helper's own records, never from the request.
func (h *Helper) pruneHostGenerations(ctx context.Context, st *State) (*proto.Result, *proto.Error) {
	booted, err := h.act.CurrentSystem(ctx)
	if err != nil {
		return nil, fail(proto.CodeInternal, "current system: %v", err)
	}
	gens, err := h.act.HostGenerations(ctx)
	if err != nil {
		return nil, fail(proto.CodeActivationFailed, "list generations: %v", err)
	}
	keep := map[string]bool{booted: true}
	for _, a := range []*Activated{st.Host.Current, st.Host.Previous, st.Host.Pending} {
		if a != nil {
			keep[a.Host] = true
		}
	}
	// The newest generation is the profile's default; never delete it either.
	newest := 0
	for _, g := range gens {
		newest = max(newest, g.Number)
	}
	var del []int
	for _, g := range gens {
		if !keep[g.StorePath] && g.Number != newest {
			del = append(del, g.Number)
		}
	}
	if len(del) == 0 {
		return &proto.Result{AlreadyDone: true}, nil
	}
	if err := h.act.DeleteHostGenerations(ctx, del); err != nil {
		return nil, fail(proto.CodeActivationFailed, "delete generations: %v", err)
	}
	return &proto.Result{Deleted: del}, nil
}

// pruneRuntimeGenerations deletes runtime-profile generations whose store path is none of: the runtimes of the
// helper's records (current and previous runtime; current, previous and pending host: every runtime the helper can
// still activate without an assignment, MG-57), the profile's current generation and its newest (UP-X18). As in
// pruneHostGenerations, everything kept is derived from the helper's own records, never from the request; without a
// recorded runtime nothing is deleted. The deleted generations' closures stay in the store until collect-garbage.
func (h *Helper) pruneRuntimeGenerations(ctx context.Context, st *State) (*proto.Result, *proto.Error) {
	if st.Runtime.Current == nil {
		return nil, fail(proto.CodeNothingToRollBack, "no recorded runtime; keeping every runtime generation")
	}
	gens, err := h.act.RuntimeGenerations(ctx)
	if err != nil {
		return nil, fail(proto.CodeActivationFailed, "list runtime generations: %v", err)
	}
	keep := map[string]bool{}
	for _, a := range []*Activated{st.Runtime.Current, st.Runtime.Previous, st.Host.Current, st.Host.Previous, st.Host.Pending} {
		if a != nil && a.Runtime.Runtime != "" {
			keep[a.Runtime.Runtime] = true
		}
	}
	// The newest generation and the one the profile points to (the same, unless something but the helper set it)
	// stay: the runtime units run from it, and nix-env refuses to delete it.
	newest := 0
	for _, g := range gens {
		newest = max(newest, g.Number)
		if g.Current {
			keep[g.StorePath] = true
		}
	}
	var del []int
	for _, g := range gens {
		if !keep[g.StorePath] && g.Number != newest {
			del = append(del, g.Number)
		}
	}
	if len(del) == 0 {
		return &proto.Result{AlreadyDone: true}, nil
	}
	if err := h.act.DeleteRuntimeGenerations(ctx, del); err != nil {
		return nil, fail(proto.CodeActivationFailed, "delete runtime generations: %v", err)
	}
	return &proto.Result{Deleted: del}, nil
}

// collectGarbage deletes the store paths no GC root reaches (UP-X19): `nix-store --gc` at low priority, bounded by
// CollectTimeout (an interrupted collection is safe; the rest goes the next time). The roots are the profiles' generations
// (what prune-host-generations and prune-runtime-generations kept), the booted and current systems and what running
// processes use, so nothing a kept generation references goes. It deletes no generation itself. A closure staged for an
// activation that hasn't happened yet is not rooted, so the manager runs it only right after an update became Healthy
// (never between Downloading and Verifying); like every operation it holds the helper's lock, so no staging or
// activation runs meanwhile.
func (h *Helper) collectGarbage(ctx context.Context) (*proto.Result, *proto.Error) {
	ctx, cancel := context.WithTimeout(ctx, h.cfg.CollectTimeout)
	defer cancel()
	r, err := h.act.CollectGarbage(ctx)
	if err != nil {
		return nil, fail(proto.CodeActivationFailed, "collect garbage: %v", err)
	}
	c := &proto.Collected{Paths: r.Paths, FreedBytes: r.FreedBytes, FreeBytes: r.FreeBytes}
	return &proto.Result{AlreadyDone: r.Paths == 0, Collected: c}, nil
}

// runtimeFor resolves the runtime store path of a release for a read-only schema check: a release
// the helper itself recorded (works without fresh TUF metadata, e.g. deciding a rollback) or a
// TUF-approved release.
func (h *Helper) runtimeFor(st *State, id string) (string, *proto.Error) {
	for _, rec := range []*Activated{st.Runtime.Current, st.Runtime.Previous, st.Host.Current, st.Host.Previous, st.Host.Pending} {
		if rec != nil && rec.ReleaseID == id {
			return rec.Runtime.Runtime, nil
		}
	}
	_, rel, perr := h.verified(st, id)
	if perr != nil {
		return "", perr
	}
	return rel.Tuple.Runtime.StorePath, nil
}

func (h *Helper) checkSchema(ctx context.Context, st *State, id string) (*proto.Result, *proto.Error) {
	rt, perr := h.runtimeFor(st, id)
	if perr != nil {
		return nil, perr
	}
	if ok, _ := h.act.HasStorePath(ctx, rt); !ok {
		return nil, fail(proto.CodeNotStaged, "runtime of %s is not in the store", id)
	}
	s, err := h.act.SchemaCheck(ctx, rt)
	if err != nil {
		return nil, fail(proto.CodeSchema, "schema-check: %v", err)
	}
	return &proto.Result{ReleaseID: id, Schema: s}, nil
}

// migrateRuntime runs the candidate's migration authority. It changes the database, so it needs the
// same authorization as an activation: TUF-approved and assigned.
func (h *Helper) migrateRuntime(ctx context.Context, st *State, id, checkpoint string) (*proto.Result, *proto.Error) {
	repo, rel, perr := h.verified(st, id)
	if perr != nil {
		return nil, perr
	}
	if perr := h.assigned(st, repo, rel); perr != nil {
		return nil, perr
	}
	if perr := h.forward(st.Runtime.Current, rel); perr != nil {
		return nil, perr
	}
	rt := rel.Tuple.Runtime.StorePath
	if ok, _ := h.act.HasStorePath(ctx, rt); !ok {
		return nil, fail(proto.CodeNotStaged, "runtime of %s is not in the store", id)
	}
	if err := saveState(h.cfg.StateDir, st); err != nil {
		return nil, fail(proto.CodeInternal, "%v", err)
	}
	s, err := h.act.Migrate(ctx, rt, checkpoint)
	if err != nil {
		return nil, fail(proto.CodeSchema, "migrate: %v", err)
	}
	return &proto.Result{ReleaseID: id, Schema: s}, nil
}

// RevertNetworkDeadman is run by the dead-man timer (root, no socket).
func (h *Helper) RevertNetworkDeadman(ctx context.Context) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	st, err := loadState(h.cfg.StateDir)
	if err != nil {
		return err
	}
	if st.Network.Pending == "" {
		return nil
	}
	_, perr := h.revertNetwork(ctx, st)
	if perr != nil {
		return perr
	}
	return nil
}

// SeedFactory records the factory-installed tuple as the current host and runtime (provisioning,
// run once as root from the image's first boot). It verifies the tuple through TUF like any other
// release and requires that it is the booted host. It refuses to overwrite existing records.
func (h *Helper) SeedFactory(ctx context.Context, id string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	st, err := loadState(h.cfg.StateDir)
	if err != nil {
		return err
	}
	if st.DeviceID != h.cfg.DeviceID && (st.DeviceID != "" || st.Host.Current != nil || st.Runtime.Current != nil || st.MaxAssignmentSeq != 0) {
		// Records of another identity (factory reset + re-provisioning, L-5): the new identity starts
		// fresh — its assignment sequence, activations and network state are unrelated to the old ones.
		st = &State{V: 1}
	}
	if st.Host.Current != nil || st.Runtime.Current != nil {
		return errors.New("helper state already seeded")
	}
	st.DeviceID = h.cfg.DeviceID
	_, rel, perr := h.verified(st, id)
	if perr != nil {
		return perr
	}
	booted, err := h.act.CurrentSystem(ctx)
	if err != nil {
		return err
	}
	if booted != rel.Tuple.Host.StorePath {
		return fmt.Errorf("factory tuple host %s is not the booted system %s", rel.Tuple.Host.StorePath, booted)
	}
	a := h.activated(rel)
	st.Host.Current, st.Runtime.Current = a, a
	return saveState(h.cfg.StateDir, st)
}
