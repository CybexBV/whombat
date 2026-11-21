package activator

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"

	"github.com/CybexBV/whombat/appliance/helper/pkg/atomicfile"
	"github.com/CybexBV/whombat/appliance/helper/pkg/narframe"
	"github.com/CybexBV/whombat/appliance/helper/pkg/netconfig"
	"github.com/CybexBV/whombat/appliance/helper/pkg/proto"
	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
)

// Runner executes a fixed argv (absolute program path, no shell) with optional stdin.
type Runner interface {
	Run(ctx context.Context, stdin io.Reader, argv ...string) ([]byte, error)
	// RunAs runs argv as uid/gid with exactly env, returning stdout and the exit code; err is set
	// only when the program could not run.
	RunAs(ctx context.Context, uid, gid uint32, env []string, argv ...string) (stdout []byte, exit int, err error)
}

// ExecRunner runs commands with an empty, fixed environment.
type ExecRunner struct{}

// Run implements Runner.
func (ExecRunner) Run(ctx context.Context, stdin io.Reader, argv ...string) ([]byte, error) {
	if len(argv) == 0 || !filepath.IsAbs(argv[0]) {
		return nil, errors.New("runner: program must be an absolute path")
	}
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Env = []string{"PATH=/run/current-system/sw/bin", "LANG=C.UTF-8"}
	cmd.Stdin = stdin
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	err := cmd.Run()
	if err != nil {
		msg := out.String()
		if len(msg) > 2000 {
			msg = msg[len(msg)-2000:]
		}
		if strings.Contains(msg, "No space left on device") {
			return out.Bytes(), fmt.Errorf("%w: %s", ErrNoSpace, msg)
		}
		return out.Bytes(), fmt.Errorf("%s: %w: %s", argv[0], err, msg)
	}
	return out.Bytes(), nil
}

// RunAs implements Runner.
func (ExecRunner) RunAs(ctx context.Context, uid, gid uint32, env []string, argv ...string) ([]byte, int, error) {
	if len(argv) == 0 || !filepath.IsAbs(argv[0]) {
		return nil, 0, errors.New("runner: program must be an absolute path")
	}
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Env = env
	cmd.Dir = "/"
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uid, Gid: gid}, Setpgid: true}
	var out, errb bytes.Buffer
	cmd.Stdout = &limitedBuffer{b: &out, max: 256 * 1024}
	cmd.Stderr = &limitedBuffer{b: &errb, max: 16 * 1024}
	err := cmd.Run()
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return out.Bytes(), ee.ExitCode(), nil
	}
	if err != nil {
		return nil, 0, fmt.Errorf("%s: %w", argv[0], err)
	}
	return out.Bytes(), 0, nil
}

type limitedBuffer struct {
	b   *bytes.Buffer
	max int
}

func (l *limitedBuffer) Write(p []byte) (int, error) {
	if room := l.max - l.b.Len(); room > 0 {
		if len(p) > room {
			l.b.Write(p[:room])
		} else {
			l.b.Write(p)
		}
	}
	return len(p), nil
}

// NixConfig holds the fixed programs and paths used on the appliance. All come from the helper's
// systemd unit (Nix-generated), never from a request.
type NixConfig struct {
	NixStore            string   // /run/current-system/sw/bin/nix-store
	NixEnv              string   // /run/current-system/sw/bin/nix-env
	Systemctl           string   // /run/current-system/sw/bin/systemctl
	SystemdRun          string   // /run/current-system/sw/bin/systemd-run
	Networkctl          string   // /run/current-system/sw/bin/networkctl
	HelperBinary        string   // absolute path of whombat-update-helper (dead-man revert)
	ProfilesDir         string   // /nix/var/nix/profiles
	RuntimeUnits        []string // e.g. whombat-runtime.target
	BlessBootCommand    []string // e.g. [/run/current-system/systemd/lib/systemd/systemd-bless-boot good]
	CurrentSystemLink   string   // /run/current-system
	NetworkRuntimeFile  string   // /run/systemd/network/10-whombat.network
	NetworkStateDir     string   // /var/lib/whombat-update-helper/network (committed/previous copies)
	NetworkInterface    string   // optional: interface to reconfigure after reload
	RebootDelaySeconds  int      // default 10
	NetworkRevertUnit   string   // default whombat-network-revert
	WifiRevertUnit      string   // default whombat-wifi-revert (NX-245)
	RuntimeProfileName  string   // default whombat-runtime
	ProviderProfilePref string   // default whombat-provider-
	StoreDir            string   // default /nix/store (its file system's free space after a collection)
	// Runtime CLI for schema-check/migrate (MD-10): <runtime store path>/<RuntimeCLI>, run as the
	// runtime user with WHOMBAT_ENV_FILE (DATABASE_URL) so the manager never holds DB credentials.
	RuntimeCLI     string // default bin/whombat
	RuntimeUID     uint32
	RuntimeGID     uint32
	RuntimeEnvFile string // e.g. /persist/whombat/runtime.env (root:whombat 0640)
	// Wi-Fi only (cable.go): the live networkd file that switches the wired interfaces off (default
	// DefaultCableOffFile), its dead-man's unit (default whombat-cable-revert), the wired interfaces' patterns (default
	// en* eth*, network.nix's defaultInterfaceMatch) and the sysfs root ("" is /sys).
	CableOffFile    string
	CableRevertUnit string
	WiredMatch      []string
	SysDir          string
}

// Nix is the real activator.
type Nix struct {
	C NixConfig
	R Runner
}

// NewNix fills defaults.
func NewNix(c NixConfig, r Runner) *Nix {
	if c.RebootDelaySeconds == 0 {
		c.RebootDelaySeconds = 10
	}
	if c.NetworkRevertUnit == "" {
		c.NetworkRevertUnit = "whombat-network-revert"
	}
	if c.WifiRevertUnit == "" {
		c.WifiRevertUnit = "whombat-wifi-revert"
	}
	if c.RuntimeProfileName == "" {
		c.RuntimeProfileName = "whombat-runtime"
	}
	if c.ProviderProfilePref == "" {
		c.ProviderProfilePref = "whombat-provider-"
	}
	if c.RuntimeCLI == "" {
		c.RuntimeCLI = "bin/whombat"
	}
	if c.ProfilesDir == "" {
		c.ProfilesDir = "/nix/var/nix/profiles"
	}
	if c.StoreDir == "" {
		c.StoreDir = "/nix/store"
	}
	if c.CurrentSystemLink == "" {
		c.CurrentSystemLink = "/run/current-system"
	}
	if r == nil {
		r = ExecRunner{}
	}
	return &Nix{C: c, R: r}
}

func checkStorePath(p string) error {
	if !trust.ValidStorePath(p) {
		return fmt.Errorf("refusing invalid store path %q", p)
	}
	return nil
}

func (n *Nix) HasStorePath(ctx context.Context, storePath string) (bool, error) {
	if err := checkStorePath(storePath); err != nil {
		return false, err
	}
	_, err := n.R.Run(ctx, nil, n.C.NixStore, "--check-validity", storePath)
	return err == nil, nil
}

// validityBatch bounds the store paths of one `nix-store --check-validity` call (argument length).
const validityBatch = 256

// InvalidPaths runs `nix-store --check-validity --print-invalid` in batches and returns the paths it prints.
func (n *Nix) InvalidPaths(ctx context.Context, storePaths []string) ([]string, error) {
	for _, p := range storePaths {
		if err := checkStorePath(p); err != nil {
			return nil, err
		}
	}
	invalid := map[string]bool{}
	for start := 0; start < len(storePaths); start += validityBatch {
		batch := storePaths[start:min(start+validityBatch, len(storePaths))]
		out, err := n.R.Run(ctx, nil, append([]string{n.C.NixStore, "--check-validity", "--print-invalid"}, batch...)...)
		if err != nil {
			return nil, err
		}
		asked := make(map[string]bool, len(batch))
		for _, p := range batch {
			asked[p] = true
		}
		for _, line := range strings.Split(string(out), "\n") {
			if l := strings.TrimSpace(line); asked[l] {
				invalid[l] = true
			}
		}
	}
	out := []string{}
	for _, p := range storePaths {
		if invalid[p] {
			out = append(out, p)
			delete(invalid, p)
		}
	}
	return out, nil
}

// ImportNar pipes an export frame of one path (its verified NAR) into `nix-store --import`. The frame is completed
// only after the whole NAR was read and the reader ended (the helper's reader checks the NAR hash there), so a NAR that
// fails its check never becomes a store path.
func (n *Nix) ImportNar(ctx context.Context, p NarPath, nar io.Reader) error {
	if err := checkStorePath(p.StorePath); err != nil {
		return err
	}
	for _, r := range p.References {
		if err := checkStorePath(r); err != nil {
			return err
		}
	}
	if p.Deriver != "" {
		if err := checkStorePath(p.Deriver); err != nil {
			return err
		}
	}
	pr, pw := io.Pipe()
	done := make(chan error, 1)
	go func() {
		err := narframe.WriteFrame(pw, p.StorePath, p.References, p.Deriver, p.NarSize, nar)
		if err == nil {
			err = narframe.WriteEnd(pw)
		}
		pw.CloseWithError(err)
		done <- err
	}()
	_, runErr := n.R.Run(ctx, pr, n.C.NixStore, "--import")
	pr.CloseWithError(errors.New("nix-store --import ended"))
	if werr := <-done; werr != nil {
		return fmt.Errorf("import %s: %w", p.StorePath, werr)
	}
	if runErr != nil {
		return runErr
	}
	if ok, _ := n.HasStorePath(ctx, p.StorePath); !ok {
		return fmt.Errorf("import did not provide %s", p.StorePath)
	}
	return nil
}

func (n *Nix) profile(name string) string { return filepath.Join(n.C.ProfilesDir, name) }

func (n *Nix) SetRuntime(ctx context.Context, set RuntimeSet) error {
	if err := checkStorePath(set.Runtime); err != nil {
		return err
	}
	if _, err := n.R.Run(ctx, nil, n.C.NixEnv, "--profile", n.profile(n.C.RuntimeProfileName), "--set", set.Runtime); err != nil {
		return err
	}
	names := make([]string, 0, len(set.Providers))
	for name := range set.Providers {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		p := set.Providers[name]
		if err := checkStorePath(p); err != nil || !trust.ValidReleaseID(name) {
			return fmt.Errorf("refusing provider %q", name)
		}
		if _, err := n.R.Run(ctx, nil, n.C.NixEnv, "--profile", n.profile(n.C.ProviderProfilePref+name), "--set", p); err != nil {
			return err
		}
	}
	return nil
}

func (n *Nix) RestartRuntime(ctx context.Context) error {
	if len(n.C.RuntimeUnits) == 0 {
		return errors.New("no runtime units configured")
	}
	_, err := n.R.Run(ctx, nil, append([]string{n.C.Systemctl, "restart", "--"}, n.C.RuntimeUnits...)...)
	return err
}

// StartBackupRestore starts the root restore unit for a checkpoint and returns at once.
func (n *Nix) StartBackupRestore(ctx context.Context, checkpoint string) error {
	if !proto.ValidCheckpointID(checkpoint) {
		return errors.New("invalid checkpoint id")
	}
	_, err := n.R.Run(ctx, nil, n.C.Systemctl, "start", "--no-block", "--", "whombat-backup-restore@"+checkpoint+".service")
	return err
}

// RestartAfterRestore restarts the hosts service (when the box has one) and the runtime.
func (n *Nix) RestartAfterRestore(ctx context.Context) error {
	_, _ = n.R.Run(ctx, nil, n.C.Systemctl, "try-restart", "--", "whombat-hosts.service")
	_, _ = n.R.Run(ctx, nil, n.C.Systemctl, "start", "--no-block", "--", "whombat-hosts.service")
	return n.RestartRuntime(ctx)
}

func (n *Nix) SetBootSystem(ctx context.Context, host string) error {
	if err := checkStorePath(host); err != nil {
		return err
	}
	if _, err := n.R.Run(ctx, nil, n.C.NixEnv, "--profile", n.profile("system"), "--set", host); err != nil {
		return err
	}
	_, err := n.R.Run(ctx, nil, filepath.Join(host, "bin", "switch-to-configuration"), "boot")
	return err
}

// HostGenerations parses `nix-env --profile …/system --list-generations` and resolves each
// generation link to its store path.
func (n *Nix) HostGenerations(ctx context.Context) ([]Generation, error) {
	return n.generations(ctx, "system")
}

// RuntimeGenerations lists the runtime profile's generations the same way (UP-X18).
func (n *Nix) RuntimeGenerations(ctx context.Context) ([]Generation, error) {
	return n.generations(ctx, n.C.RuntimeProfileName)
}

// generations parses `nix-env --profile <profile> --list-generations` (`<n>   <date> <time>   [(current)]`) and
// resolves each generation link, <profile>-<n>-link, to its store path by reading the link (never following it into
// the store). A generation whose link names no store path is left out, so it is never deleted.
func (n *Nix) generations(ctx context.Context, name string) ([]Generation, error) {
	out, err := n.R.Run(ctx, nil, n.C.NixEnv, "--profile", n.profile(name), "--list-generations")
	if err != nil {
		return nil, err
	}
	var gens []Generation
	for _, line := range strings.Split(string(out), "\n") {
		f := strings.Fields(line)
		if len(f) == 0 {
			continue
		}
		num, err := strconv.Atoi(f[0])
		if err != nil || num <= 0 {
			continue
		}
		target, err := os.Readlink(n.profile(fmt.Sprintf("%s-%d-link", name, num)))
		if err != nil || !trust.ValidStorePath(target) {
			continue
		}
		gens = append(gens, Generation{Number: num, StorePath: target, Current: f[len(f)-1] == "(current)"})
	}
	return gens, nil
}

// deleteGenerations runs `nix-env --profile <profile> --delete-generations <n>…` (numbers only: never `old` or an age).
// nix-env refuses the profile's current generation before it deletes anything.
func (n *Nix) deleteGenerations(ctx context.Context, name string, numbers []int) error {
	argv := []string{n.C.NixEnv, "--profile", n.profile(name), "--delete-generations"}
	for _, num := range numbers {
		if num <= 0 {
			return fmt.Errorf("bad generation %d", num)
		}
		argv = append(argv, strconv.Itoa(num))
	}
	_, err := n.R.Run(ctx, nil, argv...)
	return err
}

// DeleteRuntimeGenerations deletes runtime-profile generations (UP-X18). Nothing restarts: the runtime units run from
// the profile's current generation, which is never among them.
func (n *Nix) DeleteRuntimeGenerations(ctx context.Context, numbers []int) error {
	if len(numbers) == 0 {
		return nil
	}
	return n.deleteGenerations(ctx, n.C.RuntimeProfileName, numbers)
}

// gcUnit names the transient scope a store collection runs in (`systemctl status whombat-store-gc.scope` while it
// runs).
const gcUnit = "whombat-store-gc"

// CollectGarbage runs `nix-store --gc` (UP-X19): never `--delete-old`/`nix-collect-garbage -d`, so no generation goes and
// the profiles stay the roots. It runs in a transient scope with low CPU and IO weights and nice 19 (the backup
// service's way of staying out of the runtime's way): `systemd-run --scope` execs nix-store in the helper's own process,
// so its output comes back here, the operation's context ends it, and it keeps the helper's namespaces, seccomp filters
// (no IP socket: AF_UNIX and AF_NETLINK only), capabilities and NoNewPrivileges; of the helper's cgroup settings only the
// IP filter stays behind, which those address families make moot. systemd refuses a second scope of the name while one
// runs. Then it reads the free space left on the store's file system.
func (n *Nix) CollectGarbage(ctx context.Context) (GCResult, error) {
	out, err := n.R.Run(ctx, nil, n.C.SystemdRun, "--scope", "--quiet", "--collect", "--unit="+gcUnit, "--nice=19",
		"--property=CPUWeight=10", "--property=IOWeight=10", n.C.NixStore, "--gc")
	if err != nil {
		return GCResult{}, err
	}
	r := ParseGCSummary(out)
	r.FreeBytes = freeBytes(n.C.StoreDir)
	return r, nil
}

// gcSummary is the line `nix-store --gc` ends with: "<n> store paths deleted, <size> freed", the size "%.2f MiB" up to
// Nix 2.31 and "%.1f <K|M|G|T>iB" after.
var gcSummary = regexp.MustCompile(`(?m)^\s*(\d+) store paths? deleted, ([0-9]+(?:\.[0-9]+)?) (bytes|[KMGTP]iB) freed\s*$`)

var sizeUnits = map[string]float64{"bytes": 1, "KiB": 1 << 10, "MiB": 1 << 20, "GiB": 1 << 30, "TiB": 1 << 40, "PiB": 1 << 50}

// ParseGCSummary reads what `nix-store --gc` deleted from its output: the last summary line, or, should a Nix print
// none, its "deleting '…'" lines with the freed size unknown (-1). FreeBytes is left -1.
func ParseGCSummary(out []byte) GCResult {
	if all := gcSummary.FindAllSubmatch(out, -1); len(all) > 0 {
		m := all[len(all)-1]
		paths, _ := strconv.Atoi(string(m[1]))
		size, _ := strconv.ParseFloat(string(m[2]), 64)
		return GCResult{Paths: paths, FreedBytes: int64(math.Round(size * sizeUnits[string(m[3])])), FreeBytes: -1}
	}
	r := GCResult{FreedBytes: -1, FreeBytes: -1}
	for _, line := range strings.Split(string(out), "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "deleting '/nix/store/") {
			r.Paths++
		}
	}
	return r
}

// freeBytes is the space left for unprivileged writers on dir's file system (as df shows it); -1 when unknown.
func freeBytes(dir string) int64 {
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err != nil {
		return -1
	}
	return int64(st.Bavail) * st.Bsize
}

// DeleteHostGenerations deletes generations and regenerates the boot entries from the profile's
// current default (switch-to-configuration boot drops entries of deleted generations).
func (n *Nix) DeleteHostGenerations(ctx context.Context, numbers []int) error {
	if len(numbers) == 0 {
		return nil
	}
	if err := n.deleteGenerations(ctx, "system", numbers); err != nil {
		return err
	}
	// Resolve system -> system-N-link -> /nix/store/… by reading links (not following into the store).
	def := n.profile("system")
	for i := 0; i < 4 && !trust.ValidStorePath(def); i++ {
		t, err := os.Readlink(def)
		if err != nil {
			return fmt.Errorf("cannot resolve the default system: %w", err)
		}
		if !filepath.IsAbs(t) {
			t = filepath.Join(filepath.Dir(def), t)
		}
		def = t
	}
	if !trust.ValidStorePath(def) {
		return fmt.Errorf("default system %q is not a store path", def)
	}
	_, err := n.R.Run(ctx, nil, filepath.Join(def, "bin", "switch-to-configuration"), "boot")
	return err
}

func (n *Nix) ScheduleReboot(ctx context.Context) error {
	_, err := n.R.Run(ctx, nil, n.C.SystemdRun, "--unit=whombat-reboot", "--collect",
		"--on-active="+strconv.Itoa(n.C.RebootDelaySeconds), n.C.Systemctl, "reboot")
	return err
}

func (n *Nix) BlessBoot(ctx context.Context) error {
	if len(n.C.BlessBootCommand) == 0 {
		return errors.New("boot blessing not configured")
	}
	_, err := n.R.Run(ctx, nil, n.C.BlessBootCommand...)
	return err
}

func (n *Nix) CurrentSystem(context.Context) (string, error) {
	return os.Readlink(n.C.CurrentSystemLink)
}

func (n *Nix) netState(name string) string { return filepath.Join(n.C.NetworkStateDir, name) }

func (n *Nix) reloadNetwork(ctx context.Context) error {
	if _, err := n.R.Run(ctx, nil, n.C.Networkctl, "reload"); err != nil {
		return err
	}
	if n.C.NetworkInterface != "" {
		_, err := n.R.Run(ctx, nil, n.C.Networkctl, "reconfigure", n.C.NetworkInterface)
		return err
	}
	return nil
}

func (n *Nix) ApplyNetwork(ctx context.Context, c *netconfig.Candidate) error {
	if err := c.Validate(); err != nil {
		return err
	}
	if err := os.MkdirAll(n.C.NetworkStateDir, 0o700); err != nil {
		return err
	}
	if _, err := os.Stat(n.netState("previous.network")); os.IsNotExist(err) {
		prev, rerr := os.ReadFile(n.C.NetworkRuntimeFile)
		if rerr != nil && !os.IsNotExist(rerr) {
			return rerr
		}
		marker := prev
		if os.IsNotExist(rerr) {
			marker = []byte("# none\n")
		}
		if err := atomicfile.WriteFile(n.netState("previous.network"), marker, 0o600); err != nil {
			return err
		}
	}
	if err := os.MkdirAll(filepath.Dir(n.C.NetworkRuntimeFile), 0o755); err != nil {
		return err
	}
	if err := atomicfile.WriteFile(n.C.NetworkRuntimeFile, []byte(c.RenderNetworkd()), 0o644); err != nil {
		return err
	}
	return n.reloadNetwork(ctx)
}

func (n *Nix) ArmNetworkRevert(ctx context.Context, seconds int) error {
	_, err := n.R.Run(ctx, nil, n.C.SystemdRun, "--unit="+n.C.NetworkRevertUnit, "--collect",
		"--on-active="+strconv.Itoa(seconds), n.C.HelperBinary, "revert-network-deadman")
	return err
}

func (n *Nix) DisarmNetworkRevert(ctx context.Context) error {
	_, _ = n.R.Run(ctx, nil, n.C.Systemctl, "stop", "--", n.C.NetworkRevertUnit+".timer")
	cur, err := os.ReadFile(n.C.NetworkRuntimeFile)
	if err != nil {
		return err
	}
	// The committed copy is restored into /run/systemd/network at boot by the Nix module.
	if err := atomicfile.WriteFile(n.netState("committed.network"), cur, 0o600); err != nil {
		return err
	}
	_ = os.Remove(n.netState("previous.network"))
	return atomicfile.SyncDir(n.C.NetworkStateDir)
}

func (n *Nix) RevertNetwork(ctx context.Context) error {
	_, _ = n.R.Run(ctx, nil, n.C.Systemctl, "stop", "--", n.C.NetworkRevertUnit+".timer")
	prev, err := os.ReadFile(n.netState("previous.network"))
	if err == nil {
		if string(prev) == "# none\n" {
			_ = os.Remove(n.C.NetworkRuntimeFile)
		} else if err := atomicfile.WriteFile(n.C.NetworkRuntimeFile, prev, 0o644); err != nil {
			return err
		}
		_ = os.Remove(n.netState("previous.network"))
	}
	return n.reloadNetwork(ctx)
}

// ArmWifiRevert implements Activator: a transient timer (systemd-run --on-active) running the helper's own
// wifi-revert-deadman, armed before a guarded Wi-Fi change. A timer left from an earlier change is stopped first.
func (n *Nix) ArmWifiRevert(ctx context.Context, seconds int) error {
	_, _ = n.R.Run(ctx, nil, n.C.Systemctl, "stop", "--", n.C.WifiRevertUnit+".timer")
	_, err := n.R.Run(ctx, nil, n.C.SystemdRun, "--unit="+n.C.WifiRevertUnit, "--collect",
		"--on-active="+strconv.Itoa(seconds), n.C.HelperBinary, "wifi-revert-deadman")
	return err
}

// DisarmWifiRevert implements Activator.
func (n *Nix) DisarmWifiRevert(ctx context.Context) error {
	_, _ = n.R.Run(ctx, nil, n.C.Systemctl, "stop", "--", n.C.WifiRevertUnit+".timer")
	return nil
}

func (n *Nix) cli(runtime string, args ...string) ([]string, []string, error) {
	if err := checkStorePath(runtime); err != nil {
		return nil, nil, err
	}
	if n.C.RuntimeUID == 0 || n.C.RuntimeEnvFile == "" {
		return nil, nil, errors.New("runtime user/env file not configured")
	}
	argv := append([]string{filepath.Join(runtime, filepath.Clean("/"+n.C.RuntimeCLI))}, args...)
	env := []string{"PATH=/run/current-system/sw/bin", "LANG=C.UTF-8", "NODE_ENV=production", "WHOMBAT_MODE=managed",
		"WHOMBAT_ENV_FILE=" + n.C.RuntimeEnvFile}
	return argv, env, nil
}

func (n *Nix) SchemaCheck(ctx context.Context, runtime string) (*proto.Schema, error) {
	argv, env, err := n.cli(runtime, "schema-check", "--json", "--env")
	if err != nil {
		return nil, err
	}
	out, exit, err := n.R.RunAs(ctx, n.C.RuntimeUID, n.C.RuntimeGID, env, argv...)
	if err != nil {
		return nil, err
	}
	return ParseSchemaCheck(out, exit)
}

func (n *Nix) Migrate(ctx context.Context, runtime, checkpoint string) (*proto.Schema, error) {
	args := []string{"migrate", "--json", "--env"}
	if checkpoint != "" {
		if !proto.ValidCheckpointID(checkpoint) {
			return nil, errors.New("invalid checkpoint id")
		}
		args = append(args, "--checkpoint", checkpoint)
	}
	argv, env, err := n.cli(runtime, args...)
	if err != nil {
		return nil, err
	}
	out, exit, err := n.R.RunAs(ctx, n.C.RuntimeUID, n.C.RuntimeGID, env, argv...)
	if err != nil {
		return nil, err
	}
	return ParseMigrate(out, exit)
}
