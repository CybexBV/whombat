// Package helpertest runs a real update helper (the production ops and socket server) with the
// directory-based fake activator, for manager integration tests. It is never linked into binaries.
package helpertest

import (
	"context"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/internal/activator"
	"github.com/CybexBV/whombat/appliance/helper/internal/ops"
	"github.com/CybexBV/whombat/appliance/helper/internal/server"
	"github.com/CybexBV/whombat/appliance/helper/pkg/proto"
	"github.com/CybexBV/whombat/appliance/helper/pkg/wifi"
)

// Config locates the manager-written inputs and the helper's own state.
type Config struct {
	DeviceID, Env string
	// Edition is ops.EditionCommunity for a community box (UP-X27); "" is commercial.
	Edition string
	// DefaultChannel turns update channels on (LNK-21, ops.Config.DefaultChannel).
	DefaultChannel       string
	PinnedRootPath       string
	MirrorDir            string
	StagingDir           string
	AssignmentPath       string
	NetworkCandidatesDir string
	StateDir             string
	FakeRoot             string
	FakeDBDir            string
	BootedSystem         string
	Socket               string
	ManagerUID           uint32
	Now                  func() time.Time
	// Wi-Fi (NX-244): the client (wifi.Fake in tests), its profile directory, the interfaces' addresses and how long a
	// join waits for one. Nil Wifi: the helper has no Wi-Fi.
	Wifi         wifi.Client
	WifiDir      string
	WifiAddr     func(iface string) string
	WifiAddrWait time.Duration
}

// Helper is a running helper.
type Helper struct {
	H      *ops.Helper
	fake   *activator.Fake
	cancel context.CancelFunc
	done   chan struct{}
	Socket string
}

// Start starts the helper server on cfg.Socket.
func Start(cfg Config) (*Helper, error) {
	fake, err := activator.NewFake(cfg.FakeRoot, cfg.BootedSystem)
	if err != nil {
		return nil, err
	}
	fake.DBDir = cfg.FakeDBDir
	h, err := ops.New(ops.Config{DeviceID: cfg.DeviceID, Env: cfg.Env, Edition: cfg.Edition, DefaultChannel: cfg.DefaultChannel, PinnedRootPath: cfg.PinnedRootPath,
		MirrorDir: cfg.MirrorDir, StagingDir: cfg.StagingDir, AssignmentPath: cfg.AssignmentPath,
		NetworkCandidatesDir: cfg.NetworkCandidatesDir, StateDir: cfg.StateDir, Now: cfg.Now,
		Wifi: cfg.Wifi, WifiDir: cfg.WifiDir, WifiAddr: cfg.WifiAddr, WifiAddrWait: cfg.WifiAddrWait}, fake)
	if err != nil {
		return nil, err
	}
	_ = os.Remove(cfg.Socket)
	if err := os.MkdirAll(filepath.Dir(cfg.Socket), 0o755); err != nil {
		return nil, err
	}
	a, _ := net.ResolveUnixAddr("unix", cfg.Socket)
	ln, err := net.ListenUnix("unix", a)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &server.Server{H: h, ManagerUID: cfg.ManagerUID, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	out := &Helper{H: h, fake: fake, cancel: cancel, done: make(chan struct{}), Socket: cfg.Socket}
	go func() { _ = s.Serve(ctx, ln); ln.Close(); close(out.done) }()
	return out, nil
}

// Stop stops the server.
func (h *Helper) Stop() { h.cancel(); <-h.done }

// SeedFactory records the factory tuple.
func (h *Helper) SeedFactory(id string) error { return h.H.SeedFactory(context.Background(), id) }

// StorePath is a store path's content and references.
type StorePath struct {
	Content    []byte
	References []string
}

// FactoryInstall puts the factory tuple's store paths into the store and sets profiles (what the image build does).
func (h *Helper) FactoryInstall(store map[string]StorePath, runtime string, providers map[string]string) error {
	for sp, p := range store {
		if err := h.fake.Seed(sp, p.Content, p.References); err != nil {
			return err
		}
	}
	return h.fake.SetRuntime(context.Background(), activator.RuntimeSet{Runtime: runtime, Providers: providers})
}

// SimulateReboot reboots the fake host (boot counting fallback included).
func (h *Helper) SimulateReboot() string { return h.fake.SimulateReboot() }

// RebootRequested reports a scheduled reboot.
func (h *Helper) RebootRequested() bool { return h.fake.RebootRequested() }

// Readlink reads a fake profile/system link.
func (h *Helper) Readlink(rel string) string { return h.fake.Readlink(rel) }

// SetFail injects an activator failure (nil clears).
func (h *Helper) SetFail(effect string, err error) { h.fake.SetFail(effect, err) }

// SetStoreQuota bounds the fake store (0 = unlimited).
func (h *Helper) SetStoreQuota(n int64) { h.fake.StoreQuota = n }

// Events returns the activator effect log.
func (h *Helper) Events() []string { return h.fake.Events() }

// RuntimeRestarts returns the runtime restart count.
func (h *Helper) RuntimeRestarts() int { return h.fake.RuntimeRestarts() }

// DeadmanArmed reports whether the network dead-man is armed.
func (h *Helper) DeadmanArmed() bool { return h.fake.DeadmanArmed() }

// WifiDeadmanArmed reports whether the Wi-Fi dead-man is armed.
func (h *Helper) WifiDeadmanArmed() bool { return h.fake.WifiDeadmanArmed() }

// FireWifiDeadman runs the Wi-Fi dead-man (what its systemd timer would do).
func (h *Helper) FireWifiDeadman() error { return h.H.RevertWifiDeadman(context.Background()) }

// CableDeadmanArmed reports whether the cable's dead-man is armed.
func (h *Helper) CableDeadmanArmed() bool { return h.fake.CableDeadmanArmed() }

// FireCableDeadman runs the cable's dead-man (what its systemd timer would do).
func (h *Helper) FireCableDeadman() error { return h.H.RevertCableDeadman(context.Background()) }

// CableState reports whether the cable is switched off now and in the setting kept across restarts.
func (h *Helper) CableState() (live, committed bool) {
	live, committed, _ = h.fake.CableState(context.Background())
	return
}

// SimulateCableRestart puts the kept cable setting back and drops the cable's dead-man, as a restart of the host does.
func (h *Helper) SimulateCableRestart() { h.fake.SimulateCableRestart() }

// ActiveNetwork returns the active network unit.
func (h *Helper) ActiveNetwork() string { return h.fake.ActiveNetwork() }

// FireNetworkDeadman runs the dead-man revert (what the systemd timer would do).
func (h *Helper) FireNetworkDeadman() error { return h.H.RevertNetworkDeadman(context.Background()) }

// DBSchema returns the fake database schema.
func (h *Helper) DBSchema() int64 { return h.fake.DBSchema() }

// FakeSchemaVerdict evaluates a fake runtime artifact against a fake database schema (MD-04 model).
func FakeSchemaVerdict(content []byte, db int64) *proto.Schema {
	return activator.FakeSchemaVerdict(content, db)
}

// FakeSchemaVerdictIn evaluates a fake runtime artifact against the fake database in dbDir: its schema db and the
// floors its migrations recorded (Whombat MD-02, MD-12).
func FakeSchemaVerdictIn(content []byte, db int64, dbDir string) *proto.Schema {
	return activator.FakeSchemaVerdictWith(content, db, activator.FakeDBFloors(dbDir))
}

// SetBooted makes the fake host "boot" the given system (a new boot id), e.g. a boot-menu choice.
func (h *Helper) SetBooted(system string) {
	_ = os.Remove(filepath.Join(h.fake.Root, "current-system"))
	_ = os.Symlink(system, filepath.Join(h.fake.Root, "current-system"))
	_ = os.WriteFile(filepath.Join(h.fake.Root, "boot_id"), []byte("boot-manual-"+system[11:19]+"\n"), 0o644)
}

// HostGenerations lists the fake system profile generations (store paths).
func (h *Helper) HostGenerations() []string {
	gens, _ := h.fake.HostGenerations(context.Background())
	var out []string
	for _, g := range gens {
		out = append(out, g.StorePath)
	}
	return out
}

// RuntimeGenerations lists the fake runtime profile's generations (store paths, oldest first; UP-X18).
func (h *Helper) RuntimeGenerations() []string {
	gens, _ := h.fake.RuntimeGenerations(context.Background())
	var out []string
	for _, g := range gens {
		out = append(out, g.StorePath)
	}
	return out
}

// HasStorePath reports whether the fake store holds a path (UP-X19: what a collection left).
func (h *Helper) HasStorePath(p string) bool {
	ok, _ := h.fake.HasStorePath(context.Background(), p)
	return ok
}
