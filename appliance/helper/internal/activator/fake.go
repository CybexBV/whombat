package activator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/atomicfile"
	"github.com/CybexBV/whombat/appliance/helper/pkg/netconfig"
	"github.com/CybexBV/whombat/appliance/helper/pkg/proto"
)

// Fake is a directory-based activator for tests and development. Layout under Root:
//
//	store/<basename(storePath)>            imported artifact bytes
//	refs/<basename(storePath)>             the references of a path imported from its NAR (one per line)
//	profiles/whombat-runtime               symlink -> runtime store path
//	profiles/whombat-runtime-<n>-link      symlink -> runtime store path (one per generation, as nix-env --set)
//	profiles/whombat-provider-<name>       symlink -> provider store path (and its -<n>-link generations)
//	profiles/system                        symlink -> boot default system
//	profiles/system-<n>-link               symlink -> system of generation n
//	current-system                         symlink -> booted system
//	boot_id                                fake kernel boot id
//	boot-good                              booted system blessed ("good")
//	runtime-restarts                       restart counter
//	network/{active,previous}.network, network/deadman
//	events.log                             one line per effect
type Fake struct {
	Root string
	// Fail injects errors: key is an effect name ("import", "set-runtime", "restart", "set-boot",
	// "reboot", "bless", "network-apply", ...).
	mu   sync.Mutex
	Fail map[string]error
	// StoreQuota, if > 0, bounds the total bytes in store/ (simulates a full disk).
	StoreQuota int64
	// DBDir holds the fake database schema version (file "schema"), shared with the fake runtime.
	DBDir string
}

// NewFake creates the directory layout with an initial booted system (may be "").
func NewFake(root, bootedSystem string) (*Fake, error) {
	for _, d := range []string{"store", "refs", "profiles", "network"} {
		if err := os.MkdirAll(filepath.Join(root, d), 0o755); err != nil {
			return nil, err
		}
	}
	f := &Fake{Root: root, Fail: map[string]error{}}
	if bootedSystem != "" {
		if _, err := os.Lstat(filepath.Join(root, "current-system")); os.IsNotExist(err) {
			if err := f.symlink("current-system", bootedSystem); err != nil {
				return nil, err
			}
			if err := f.symlink("profiles/system", bootedSystem); err != nil {
				return nil, err
			}
			if err := f.symlink("profiles/system-1-link", bootedSystem); err != nil {
				return nil, err
			}
			_ = os.WriteFile(filepath.Join(root, "boot-good"), []byte(bootedSystem), 0o644)
		}
	}
	if _, err := os.Stat(filepath.Join(root, "boot_id")); os.IsNotExist(err) {
		_ = os.WriteFile(filepath.Join(root, "boot_id"), []byte("boot-1\n"), 0o644)
	}
	return f, nil
}

// SetFail injects (or clears with nil) a failure for an effect.
func (f *Fake) SetFail(effect string, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err == nil {
		delete(f.Fail, effect)
	} else {
		f.Fail[effect] = err
	}
}

func (f *Fake) fail(effect string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.Fail[effect]
}

func (f *Fake) event(format string, a ...any) {
	fh, err := os.OpenFile(filepath.Join(f.Root, "events.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err == nil {
		fmt.Fprintf(fh, format+"\n", a...)
		fh.Sync()
		fh.Close()
	}
}

// Events returns the effect log.
func (f *Fake) Events() []string {
	b, _ := os.ReadFile(filepath.Join(f.Root, "events.log"))
	s := strings.TrimSpace(string(b))
	if s == "" {
		return nil
	}
	return strings.Split(s, "\n")
}

func (f *Fake) symlink(rel, target string) error {
	p := filepath.Join(f.Root, rel)
	tmp := p + ".new"
	_ = os.Remove(tmp)
	if err := os.Symlink(target, tmp); err != nil {
		return err
	}
	if err := os.Rename(tmp, p); err != nil {
		return err
	}
	return atomicfile.SyncDir(filepath.Dir(p))
}

// Readlink returns a profile/system symlink target ("" if absent).
func (f *Fake) Readlink(rel string) string {
	t, _ := os.Readlink(filepath.Join(f.Root, rel))
	return t
}

func (f *Fake) storeFile(storePath string) string {
	return filepath.Join(f.Root, "store", filepath.Base(storePath))
}

// StoreContent returns the imported bytes for a store path.
func (f *Fake) StoreContent(storePath string) ([]byte, error) {
	return os.ReadFile(f.storeFile(storePath))
}

func (f *Fake) HasStorePath(_ context.Context, storePath string) (bool, error) {
	_, err := os.Stat(f.storeFile(storePath))
	return err == nil, nil
}

func (f *Fake) storeUsage() int64 {
	var n int64
	entries, _ := os.ReadDir(filepath.Join(f.Root, "store"))
	for _, e := range entries {
		if info, err := e.Info(); err == nil {
			n += info.Size()
		}
	}
	return n
}

// Seed puts a store path with its content and references into the store, as an image build does (no import).
func (f *Fake) Seed(storePath string, content []byte, references []string) error {
	if err := atomicfile.WriteFile(f.storeFile(storePath), content, 0o444); err != nil {
		return err
	}
	if err := f.writeRefs(storePath, references); err != nil {
		return err
	}
	f.event("seed %s", storePath)
	return nil
}

// fakeNarPrefix starts fixture NARs (devtuf.FakeNarPrefix; the helper does not import the release tools).
const fakeNarPrefix = "nar:"

// InvalidPaths implements Activator: the paths without a store file.
func (f *Fake) InvalidPaths(ctx context.Context, storePaths []string) ([]string, error) {
	if err := f.fail("missing-paths"); err != nil {
		return nil, err
	}
	out := []string{}
	for _, p := range storePaths {
		if ok, _ := f.HasStorePath(ctx, p); !ok {
			out = append(out, p)
		}
	}
	return out, nil
}

// ImportNar implements Activator: the store file of the path becomes the NAR's bytes without the fixture prefix
// "nar:" (fixture NARs are "nar:" + the fake content, devtuf.FakeNar). Like `nix-store --import` of a frame, nothing
// is added unless the whole NAR was read and the reader ended cleanly; references must be valid.
func (f *Fake) ImportNar(ctx context.Context, p NarPath, nar io.Reader) error {
	if err := f.fail("import"); err != nil {
		return err
	}
	for _, r := range p.References {
		if ok, _ := f.HasStorePath(ctx, r); !ok && r != p.StorePath {
			return fmt.Errorf("import %s: reference %s is not valid", p.StorePath, r)
		}
	}
	if f.StoreQuota > 0 && f.storeUsage()+p.NarSize > f.StoreQuota {
		return fmt.Errorf("%w: %v", ErrNoSpace, syscall.ENOSPC)
	}
	err := atomicfile.Write(f.storeFile(p.StorePath), 0o444, func(w io.Writer) error {
		var prefix [len(fakeNarPrefix)]byte
		if p.NarSize < int64(len(prefix)) {
			return errors.New("not a fixture NAR")
		}
		if _, err := io.ReadFull(nar, prefix[:]); err != nil || string(prefix[:]) != fakeNarPrefix {
			return fmt.Errorf("not a fixture NAR: %v", err)
		}
		if _, err := io.CopyN(w, nar, p.NarSize-int64(len(prefix))); err != nil {
			return err
		}
		var probe [1]byte
		if k, err := nar.Read(probe[:]); k != 0 || !errors.Is(err, io.EOF) {
			if err != nil && !errors.Is(err, io.EOF) {
				return err
			}
			return errors.New("NAR longer than announced")
		}
		return nil
	})
	if err != nil {
		if errors.Is(err, syscall.ENOSPC) {
			return fmt.Errorf("%w: %v", ErrNoSpace, err)
		}
		return fmt.Errorf("import %s: %w", p.StorePath, err)
	}
	if err := f.writeRefs(p.StorePath, p.References); err != nil {
		return err
	}
	f.event("import-nar %s", p.StorePath)
	return nil
}

// writeRefs records a path's references: they keep what it needs alive in CollectGarbage, as the store's database does.
func (f *Fake) writeRefs(storePath string, references []string) error {
	var refs []string
	for _, r := range references {
		if r != storePath {
			refs = append(refs, r)
		}
	}
	if err := os.MkdirAll(filepath.Join(f.Root, "refs"), 0o755); err != nil {
		return err
	}
	return atomicfile.WriteFile(filepath.Join(f.Root, "refs", filepath.Base(storePath)), []byte(strings.Join(refs, "\n")), 0o644)
}

// runtimeProfile is the runtime profile's name (NixConfig.RuntimeProfileName's default).
const runtimeProfile = "whombat-runtime"

// setProfile points profiles/<name> at target and, like `nix-env --profile … --set`, adds a generation link
// (<name>-<n>-link) unless the newest generation already names target.
func (f *Fake) setProfile(name, target string) error {
	gens, err := f.generations(name)
	if err != nil {
		return err
	}
	if cur := f.Readlink("profiles/" + name); len(gens) == 0 && cur != "" && cur != target {
		// A layout seeded without generation links (the dev stack's harness writes the profile link only): the seeded
		// path becomes generation 1, as nix-env recorded it on a real box, so it stays a root of CollectGarbage.
		if err := f.symlink(fmt.Sprintf("profiles/%s-1-link", name), cur); err != nil {
			return err
		}
		gens = []Generation{{Number: 1, StorePath: cur}}
	}
	if len(gens) == 0 || gens[len(gens)-1].StorePath != target {
		n := 1
		if len(gens) > 0 {
			n = gens[len(gens)-1].Number + 1
		}
		if err := f.symlink(fmt.Sprintf("profiles/%s-%d-link", name, n), target); err != nil {
			return err
		}
	}
	return f.symlink("profiles/"+name, target)
}

func (f *Fake) SetRuntime(_ context.Context, set RuntimeSet) error {
	if err := f.fail("set-runtime"); err != nil {
		return err
	}
	if err := f.setProfile(runtimeProfile, set.Runtime); err != nil {
		return err
	}
	names := make([]string, 0, len(set.Providers))
	for n := range set.Providers {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		if err := f.setProfile("whombat-provider-"+n, set.Providers[n]); err != nil {
			return err
		}
	}
	f.event("set-runtime %s", set.Runtime)
	return nil
}

// RuntimeRestarts returns how many times the runtime was restarted.
func (f *Fake) RuntimeRestarts() int {
	b, _ := os.ReadFile(filepath.Join(f.Root, "runtime-restarts"))
	n, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	return n
}

// StartBackupRestore records the restore it would start.
func (f *Fake) StartBackupRestore(_ context.Context, checkpoint string) error {
	if err := f.fail("backup-restore"); err != nil {
		return err
	}
	f.event("backup-restore %s", checkpoint)
	return nil
}

// RestartAfterRestore records it and restarts the runtime as RestartRuntime does.
func (f *Fake) RestartAfterRestore(ctx context.Context) error {
	f.event("backup-restored")
	return f.RestartRuntime(ctx)
}

func (f *Fake) RestartRuntime(context.Context) error {
	if err := f.fail("restart"); err != nil {
		return err
	}
	n := f.RuntimeRestarts() + 1
	if err := atomicfile.WriteFile(filepath.Join(f.Root, "runtime-restarts"), []byte(strconv.Itoa(n)), 0o644); err != nil {
		return err
	}
	f.event("restart-runtime %s", f.Readlink("profiles/whombat-runtime"))
	return nil
}

func (f *Fake) SetBootSystem(_ context.Context, host string) error {
	if err := f.fail("set-boot"); err != nil {
		return err
	}
	gens, _ := f.HostGenerations(context.Background())
	n := 1
	for _, g := range gens {
		n = max(n, g.Number+1)
	}
	if len(gens) == 0 || gens[len(gens)-1].StorePath != host {
		if err := f.symlink(fmt.Sprintf("profiles/system-%d-link", n), host); err != nil {
			return err
		}
	}
	if err := f.symlink("profiles/system", host); err != nil {
		return err
	}
	f.event("set-boot %s", host)
	return nil
}

// HostGenerations lists profiles/system-<n>-link (the factory system is generation 1).
func (f *Fake) HostGenerations(context.Context) ([]Generation, error) {
	return f.generations("system")
}

// generations lists profiles/<name>-<n>-link in order. The profile link names a store path here (nix-env's names a
// generation link), so the current generation is the newest one with the profile's store path.
func (f *Fake) generations(name string) ([]Generation, error) {
	entries, err := os.ReadDir(filepath.Join(f.Root, "profiles"))
	if err != nil {
		return nil, err
	}
	var out []Generation
	for _, e := range entries {
		rest, ok := strings.CutPrefix(e.Name(), name+"-")
		num, ok2 := strings.CutSuffix(rest, "-link")
		n, err := strconv.Atoi(num)
		if !ok || !ok2 || err != nil || n <= 0 || strconv.Itoa(n) != num {
			continue
		}
		out = append(out, Generation{Number: n, StorePath: f.Readlink("profiles/" + e.Name())})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Number < out[j].Number })
	cur := f.Readlink("profiles/" + name)
	for i := len(out) - 1; i >= 0; i-- {
		if out[i].StorePath == cur {
			out[i].Current = true
			break
		}
	}
	return out, nil
}

// RuntimeGenerations lists profiles/whombat-runtime-<n>-link (UP-X18).
func (f *Fake) RuntimeGenerations(context.Context) ([]Generation, error) {
	if err := f.fail("list-runtime-generations"); err != nil {
		return nil, err
	}
	return f.generations(runtimeProfile)
}

// DeleteRuntimeGenerations removes runtime generation links; like nix-env it refuses the current generation before it
// deletes anything.
func (f *Fake) DeleteRuntimeGenerations(_ context.Context, numbers []int) error {
	if err := f.fail("delete-runtime-generations"); err != nil {
		return err
	}
	gens, err := f.generations(runtimeProfile)
	if err != nil {
		return err
	}
	for _, g := range gens {
		if g.Current && slices.Contains(numbers, g.Number) {
			return fmt.Errorf("cannot delete the current generation %d of profile %s", g.Number, runtimeProfile)
		}
	}
	for _, n := range numbers {
		if err := os.Remove(filepath.Join(f.Root, "profiles", fmt.Sprintf("%s-%d-link", runtimeProfile, n))); err != nil && !os.IsNotExist(err) {
			return err
		}
		f.event("delete-runtime-generation %d", n)
	}
	return atomicfile.SyncDir(filepath.Join(f.Root, "profiles"))
}

// CollectGarbage implements Activator like `nix-store --gc` (UP-X19): every store file no root reaches goes. The roots
// are the profiles' links (each profile and each of its generations) and the booted system; a path reaches the
// references ImportNar recorded for it.
func (f *Fake) CollectGarbage(context.Context) (GCResult, error) {
	if err := f.fail("collect-garbage"); err != nil {
		return GCResult{}, err
	}
	live := map[string]bool{}
	var queue []string
	mark := func(storePath string) {
		if b := filepath.Base(storePath); storePath != "" && !live[b] {
			live[b] = true
			queue = append(queue, b)
		}
	}
	profiles, err := os.ReadDir(filepath.Join(f.Root, "profiles"))
	if err != nil {
		return GCResult{}, err
	}
	for _, e := range profiles {
		if e.Type()&os.ModeSymlink != 0 {
			mark(f.Readlink("profiles/" + e.Name()))
		}
	}
	mark(f.Readlink("current-system"))
	for len(queue) > 0 {
		b := queue[0]
		queue = queue[1:]
		refs, _ := os.ReadFile(filepath.Join(f.Root, "refs", b))
		for _, r := range strings.Fields(string(refs)) {
			mark(r)
		}
	}
	store, err := os.ReadDir(filepath.Join(f.Root, "store"))
	if err != nil {
		return GCResult{}, err
	}
	r := GCResult{FreeBytes: -1}
	for _, e := range store {
		if live[e.Name()] || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if err := os.Remove(filepath.Join(f.Root, "store", e.Name())); err != nil {
			return r, err
		}
		_ = os.Remove(filepath.Join(f.Root, "refs", e.Name()))
		r.Paths++
		r.FreedBytes += info.Size()
		f.event("gc-delete /nix/store/%s", e.Name())
	}
	if f.StoreQuota > 0 {
		r.FreeBytes = f.StoreQuota - f.storeUsage()
	}
	f.event("collect-garbage paths=%d bytes=%d", r.Paths, r.FreedBytes)
	return r, atomicfile.SyncDir(filepath.Join(f.Root, "store"))
}

// DeleteHostGenerations removes generation links (and records the boot-entry rewrite).
func (f *Fake) DeleteHostGenerations(_ context.Context, numbers []int) error {
	if err := f.fail("delete-generations"); err != nil {
		return err
	}
	for _, n := range numbers {
		if err := os.Remove(filepath.Join(f.Root, "profiles", fmt.Sprintf("system-%d-link", n))); err != nil && !os.IsNotExist(err) {
			return err
		}
		f.event("delete-generation %d", n)
	}
	return atomicfile.SyncDir(filepath.Join(f.Root, "profiles"))
}

func (f *Fake) ScheduleReboot(context.Context) error {
	if err := f.fail("reboot"); err != nil {
		return err
	}
	if err := atomicfile.WriteFile(filepath.Join(f.Root, "reboot-requested"), []byte("1"), 0o644); err != nil {
		return err
	}
	f.event("reboot-scheduled")
	return nil
}

// RebootRequested reports whether a reboot was scheduled and not yet simulated.
func (f *Fake) RebootRequested() bool {
	_, err := os.Stat(filepath.Join(f.Root, "reboot-requested"))
	return err == nil
}

// SimulateReboot "reboots": the boot default boots unless its artifact says hostBoots=false, in
// which case boot counting falls back to the last blessed ("good") system. The boot id changes and
// the runtime restarts from the profiles.
func (f *Fake) SimulateReboot() (booted string) {
	def := f.Readlink("profiles/system")
	booted = def
	if content, err := f.StoreContent(def); err == nil {
		var a struct {
			HostBoots *bool `json:"hostBoots"`
		}
		if json.Unmarshal(content, &a) == nil && a.HostBoots != nil && !*a.HostBoots {
			good, _ := os.ReadFile(filepath.Join(f.Root, "boot-good"))
			booted = strings.TrimSpace(string(good))
		}
	}
	_ = f.symlink("current-system", booted)
	b, _ := os.ReadFile(filepath.Join(f.Root, "boot_id"))
	n, _ := strconv.Atoi(strings.TrimPrefix(strings.TrimSpace(string(b)), "boot-"))
	_ = atomicfile.WriteFile(filepath.Join(f.Root, "boot_id"), []byte(fmt.Sprintf("boot-%d\n", n+1)), 0o644)
	_ = os.Remove(filepath.Join(f.Root, "reboot-requested"))
	f.event("rebooted %s", booted)
	return booted
}

func (f *Fake) BlessBoot(context.Context) error {
	if err := f.fail("bless"); err != nil {
		return err
	}
	cur := f.Readlink("current-system")
	if err := atomicfile.WriteFile(filepath.Join(f.Root, "boot-good"), []byte(cur), 0o644); err != nil {
		return err
	}
	f.event("bless %s", cur)
	return nil
}

func (f *Fake) CurrentSystem(context.Context) (string, error) {
	t, err := os.Readlink(filepath.Join(f.Root, "current-system"))
	if err != nil {
		return "", err
	}
	return t, nil
}

func (f *Fake) netPath(n string) string { return filepath.Join(f.Root, "network", n) }

func (f *Fake) ApplyNetwork(_ context.Context, c *netconfig.Candidate) error {
	if err := f.fail("network-apply"); err != nil {
		return err
	}
	if _, err := os.Stat(f.netPath("previous.network")); os.IsNotExist(err) {
		cur, _ := os.ReadFile(f.netPath("active.network"))
		if err := atomicfile.WriteFile(f.netPath("previous.network"), cur, 0o644); err != nil {
			return err
		}
	}
	if err := atomicfile.WriteFile(f.netPath("active.network"), []byte(c.RenderNetworkd()), 0o644); err != nil {
		return err
	}
	f.event("network-apply %s", c.ID)
	return nil
}

func (f *Fake) ArmNetworkRevert(_ context.Context, seconds int) error {
	dl := time.Now().Add(time.Duration(seconds) * time.Second).Unix()
	f.event("network-arm %d", seconds)
	return atomicfile.WriteFile(f.netPath("deadman"), []byte(strconv.FormatInt(dl, 10)), 0o644)
}

// DeadmanArmed reports whether the network dead-man timer is armed.
func (f *Fake) DeadmanArmed() bool {
	_, err := os.Stat(f.netPath("deadman"))
	return err == nil
}

func (f *Fake) DisarmNetworkRevert(context.Context) error {
	_ = os.Remove(f.netPath("deadman"))
	_ = os.Remove(f.netPath("previous.network"))
	f.event("network-commit")
	return atomicfile.SyncDir(filepath.Join(f.Root, "network"))
}

func (f *Fake) RevertNetwork(context.Context) error {
	if err := f.fail("network-revert"); err != nil {
		return err
	}
	prev, err := os.ReadFile(f.netPath("previous.network"))
	if err == nil {
		if err := atomicfile.WriteFile(f.netPath("active.network"), prev, 0o644); err != nil {
			return err
		}
		_ = os.Remove(f.netPath("previous.network"))
	}
	_ = os.Remove(f.netPath("deadman"))
	f.event("network-revert")
	return atomicfile.SyncDir(filepath.Join(f.Root, "network"))
}

// ArmWifiRevert implements Activator: the dead-man's deadline in network/wifi-deadman.
func (f *Fake) ArmWifiRevert(_ context.Context, seconds int) error {
	if err := f.fail("wifi-arm"); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(f.Root, "network"), 0o755); err != nil {
		return err
	}
	dl := time.Now().Add(time.Duration(seconds) * time.Second).Unix()
	f.event("wifi-arm %d", seconds)
	return atomicfile.WriteFile(f.netPath("wifi-deadman"), []byte(strconv.FormatInt(dl, 10)), 0o644)
}

// DisarmWifiRevert implements Activator.
func (f *Fake) DisarmWifiRevert(context.Context) error {
	if err := os.Remove(f.netPath("wifi-deadman")); err == nil {
		f.event("wifi-disarm")
	}
	return nil
}

// WifiDeadmanArmed reports whether the Wi-Fi dead-man is armed.
func (f *Fake) WifiDeadmanArmed() bool {
	_, err := os.Stat(f.netPath("wifi-deadman"))
	return err == nil
}

// ActiveNetwork returns the active rendered network unit.
func (f *Fake) ActiveNetwork() string {
	b, _ := os.ReadFile(f.netPath("active.network"))
	return string(b)
}

// DBSchema returns the fake database schema version.
func (f *Fake) DBSchema() int64 {
	b, _ := os.ReadFile(filepath.Join(f.DBDir, "schema"))
	n, _ := strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64)
	return n
}

func (f *Fake) setDBSchema(n int64) error {
	if err := os.MkdirAll(f.DBDir, 0o755); err != nil {
		return err
	}
	return atomicfile.WriteFile(filepath.Join(f.DBDir, "schema"), []byte(strconv.FormatInt(n, 10)), 0o644)
}

type fakeRuntimeArtifact struct {
	SchemaWrites      int64 `json:"schemaWrites"`
	SchemaReadMax     int64 `json:"schemaReadMax"`
	SchemaReadOnlyMax int64 `json:"schemaReadOnlyMax"`
	ContractMigration bool  `json:"contractMigration"`
	// ReaderFloor/WriterFloor: the floors of SchemaWrites this runtime declares and reports as its schema check's
	// target (Whombat MD-12), and its migration records in the database. 0: a runtime before MD-12.
	ReaderFloor int64 `json:"readerFloor"`
	WriterFloor int64 `json:"writerFloor"`
}

// FakeFloors are the floors the fake migration authority recorded for the database's schema (what
// whombat_meta.schema_versions gives an older binary).
type FakeFloors struct {
	Readers int64 `json:"readers"`
	Writers int64 `json:"writers"`
}

// FakeDBFloors reads the floors recorded in a fake database directory (nil: none recorded).
func FakeDBFloors(dbDir string) *FakeFloors {
	b, err := os.ReadFile(filepath.Join(dbDir, "floors.json"))
	if err != nil {
		return nil
	}
	var f FakeFloors
	if json.Unmarshal(b, &f) != nil || f.Writers == 0 {
		return nil
	}
	return &f
}

// FakeSchemaVerdict evaluates the fake runtime binary against a database schema like
// evaluateSchema (MD-04), for the fake activator and the fake runtime, with no recorded floors.
func FakeSchemaVerdict(content []byte, db int64) *proto.Schema {
	return FakeSchemaVerdictWith(content, db, nil)
}

// FakeSchemaVerdictWith is FakeSchemaVerdict on a database whose schema carries recorded floors: a binary older than
// the database then judges it by them (as evaluateSchema does), not by its own SchemaReadMax/SchemaReadOnlyMax.
func FakeSchemaVerdictWith(content []byte, db int64, recorded *FakeFloors) *proto.Schema {
	var a fakeRuntimeArtifact
	_ = json.Unmarshal(content, &a)
	s := &proto.Schema{DatabaseVersion: int(db), BinaryVersion: int(a.SchemaWrites)}
	if db <= a.SchemaWrites && a.WriterFloor > 0 {
		s.Target = &proto.SchemaTarget{Version: int(a.SchemaWrites), Readers: int(a.ReaderFloor), Writers: int(a.WriterFloor)}
	}
	readMax, readOnlyMax := a.SchemaReadMax, a.SchemaReadOnlyMax
	if recorded != nil && db > a.SchemaWrites {
		readMax, readOnlyMax = 0, 0
		if a.SchemaWrites >= recorded.Writers {
			readMax = db
		} else if a.SchemaWrites >= recorded.Readers {
			readOnlyMax = db
		}
		s.Target = &proto.SchemaTarget{Version: int(db), Readers: int(recorded.Readers), Writers: int(recorded.Writers)}
	}
	switch {
	case db < a.SchemaWrites:
		s.Exit, s.Verdict, s.Access = proto.SchemaExitMigrationRequired, "migration_required", "none"
		for v := db + 1; v <= a.SchemaWrites; v++ {
			s.Pending = append(s.Pending, fmt.Sprintf("m%04d", v))
		}
		if a.ContractMigration && db > 0 {
			s.NeedsCheckpoint = []string{fmt.Sprintf("m%04d", a.SchemaWrites)}
		}
		s.Reason = "the database is behind this binary"
	case db == a.SchemaWrites:
		s.Exit, s.Verdict, s.Access = proto.SchemaExitOK, "current", "read-write"
	case db <= readMax:
		s.Exit, s.Verdict, s.Access = proto.SchemaExitOK, "newer_compatible", "read-write"
	case db <= readOnlyMax:
		s.Exit, s.Verdict, s.Access = proto.SchemaExitReadOnly, "newer_read_only", "read-only"
		s.Reason = "a newer release migrated the database; this one may only read it"
	default:
		s.Exit, s.Verdict, s.Access = proto.SchemaExitRefused, "newer_incompatible", "none"
		s.Reason = "a newer release migrated the database past what this one can read"
	}
	s.OK = s.Exit == proto.SchemaExitOK
	return s
}

// verdict evaluates a runtime in the store against the fake database (schema and recorded floors).
func (f *Fake) verdict(content []byte) *proto.Schema {
	return FakeSchemaVerdictWith(content, f.DBSchema(), FakeDBFloors(f.DBDir))
}

// recordFloors is what the migration authority records for the schema it left (MD-02): the migrating runtime's
// declared floors, or none (a runtime before MD-12 in this fake).
func (f *Fake) recordFloors(content []byte) error {
	var a fakeRuntimeArtifact
	_ = json.Unmarshal(content, &a)
	p := filepath.Join(f.DBDir, "floors.json")
	if a.WriterFloor == 0 {
		if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	b, _ := json.Marshal(FakeFloors{Readers: a.ReaderFloor, Writers: a.WriterFloor})
	return atomicfile.WriteFile(p, b, 0o644)
}

func (f *Fake) SchemaCheck(_ context.Context, runtime string) (*proto.Schema, error) {
	if err := f.fail("schema-check"); err != nil {
		return nil, err
	}
	content, err := f.StoreContent(runtime)
	if err != nil {
		return nil, fmt.Errorf("runtime %s not in store", runtime)
	}
	return f.verdict(content), nil
}

func (f *Fake) Migrate(_ context.Context, runtime, checkpoint string) (*proto.Schema, error) {
	if err := f.fail("migrate"); err != nil {
		return nil, err
	}
	content, err := f.StoreContent(runtime)
	if err != nil {
		return nil, fmt.Errorf("runtime %s not in store", runtime)
	}
	s := f.verdict(content)
	if s.Exit != proto.SchemaExitMigrationRequired {
		return s, nil
	}
	if len(s.NeedsCheckpoint) > 0 && checkpoint == "" {
		s.Exit, s.OK, s.ErrorKind = proto.SchemaExitCheckpointRequired, false, "checkpoint_required"
		s.Reason = "contract migrations need a verified checkpoint"
		return s, nil
	}
	applied := s.Pending
	if err := f.setDBSchema(int64(s.BinaryVersion)); err != nil {
		return nil, err
	}
	if err := f.recordFloors(content); err != nil {
		return nil, err
	}
	if err := f.fail("migrate-after"); err != nil {
		// The schema changed, then the migration failed (e.g. a later backfill): exit 1.
		return &proto.Schema{Exit: 1, OK: false, ErrorKind: "failed", Reason: err.Error(), DatabaseVersion: int(f.DBSchema())}, nil
	}
	f.event("migrate %s -> %d checkpoint=%q", runtime, s.BinaryVersion, checkpoint)
	out := f.verdict(content)
	out.Applied = applied
	return out, nil
}
