package activator

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/CybexBV/whombat/appliance/helper/pkg/netconfig"
	"github.com/CybexBV/whombat/appliance/helper/pkg/proto"
	"github.com/CybexBV/whombat/appliance/release-tools/nixexport"
)

type recRunner struct {
	calls  []string
	stdin  []string
	envs   [][]string
	out    []byte
	exit   int
	asUIDs []uint32
	runOut []byte
}

func (r *recRunner) RunAs(_ context.Context, uid, gid uint32, env []string, argv ...string) ([]byte, int, error) {
	r.calls = append(r.calls, strings.Join(argv, " "))
	r.envs = append(r.envs, env)
	r.asUIDs = append(r.asUIDs, uid)
	return r.out, r.exit, nil
}

func (r *recRunner) Run(_ context.Context, stdin io.Reader, argv ...string) ([]byte, error) {
	r.calls = append(r.calls, strings.Join(argv, " "))
	if stdin != nil {
		b, _ := io.ReadAll(stdin)
		r.stdin = append(r.stdin, string(b))
	}
	return r.runOut, nil
}

const sp = "/nix/store/0123456789abcdfghijklmnpqrsvwxyz-whombat-runtime-1.0.0"
const hp = "/nix/store/0123456789abcdfghijklmnpqrsvwxya-nixos-system-whombat"

func newNix(t *testing.T) (*Nix, *recRunner) {
	r := &recRunner{}
	d := t.TempDir()
	return NewNix(NixConfig{
		NixStore: "/bin/nix-store", NixEnv: "/bin/nix-env", Systemctl: "/bin/systemctl", SystemdRun: "/bin/systemd-run",
		Networkctl: "/bin/networkctl", HelperBinary: "/bin/whombat-update-helper", RuntimeUnits: []string{"whombat-runtime.target"},
		BlessBootCommand: []string{"/lib/systemd/systemd-bless-boot", "good"}, NetworkRuntimeFile: filepath.Join(d, "run", "10-whombat.network"),
		NetworkStateDir: filepath.Join(d, "state"), RuntimeUID: 990, RuntimeGID: 990, RuntimeEnvFile: "/persist/whombat/runtime.env",
	}, r), r
}

func TestNixCommands(t *testing.T) {
	n, r := newNix(t)
	ctx := context.Background()
	n.SetRuntime(ctx, RuntimeSet{Runtime: sp, Providers: map[string]string{"codex": hp}})
	n.RestartRuntime(ctx)
	n.SetBootSystem(ctx, hp)
	n.ScheduleReboot(ctx)
	n.BlessBoot(ctx)
	want := []string{
		"/bin/nix-env --profile /nix/var/nix/profiles/whombat-runtime --set " + sp,
		"/bin/nix-env --profile /nix/var/nix/profiles/whombat-provider-codex --set " + hp,
		"/bin/systemctl restart -- whombat-runtime.target",
		"/bin/nix-env --profile /nix/var/nix/profiles/system --set " + hp,
		hp + "/bin/switch-to-configuration boot",
		"/bin/systemd-run --unit=whombat-reboot --collect --on-active=10 /bin/systemctl reboot",
		"/lib/systemd/systemd-bless-boot good",
	}
	if strings.Join(r.calls, "\n") != strings.Join(want, "\n") {
		t.Fatalf("calls:\n%s", strings.Join(r.calls, "\n"))
	}
}

func TestNixRefusesUnverifiedValues(t *testing.T) {
	n, r := newNix(t)
	ctx := context.Background()
	for _, bad := range []string{"/tmp/x", "/nix/store/short-x", sp + "/../../etc", "$(reboot)"} {
		if err := n.SetBootSystem(ctx, bad); err == nil {
			t.Errorf("accepted %q", bad)
		}
		if err := n.SetRuntime(ctx, RuntimeSet{Runtime: bad}); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
	if err := n.SetRuntime(ctx, RuntimeSet{Runtime: sp, Providers: map[string]string{"../x": sp}}); err == nil {
		t.Error("accepted provider name")
	}
	if len(r.calls) > 1 { // only the valid runtime profile set may have run
		t.Fatalf("calls %v", r.calls)
	}
}

func TestNixNetwork(t *testing.T) {
	n, r := newNix(t)
	ctx := context.Background()
	c, err := netconfig.Parse([]byte(`{"v":1,"id":"n-1","interface":"enp1s0","ipv4":{"mode":"dhcp"},"ipv6":{"mode":"auto"},"dns":[],"confirmTimeoutSec":60}`))
	if err != nil {
		t.Fatal(err)
	}
	if err := n.ApplyNetwork(ctx, c); err != nil {
		t.Fatal(err)
	}
	n.ArmNetworkRevert(ctx, 90)
	if err := n.RevertNetwork(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(n.C.NetworkRuntimeFile); !os.IsNotExist(err) {
		t.Fatal("revert must remove a runtime file that did not exist before")
	}
	joined := strings.Join(r.calls, "\n")
	if !strings.Contains(joined, "/bin/systemd-run --unit=whombat-network-revert --collect --on-active=90 /bin/whombat-update-helper revert-network-deadman") {
		t.Fatal(joined)
	}
}

func TestNixWifiDeadman(t *testing.T) {
	n, r := newNix(t)
	ctx := context.Background()
	if err := n.ArmWifiRevert(ctx, 150); err != nil {
		t.Fatal(err)
	}
	if err := n.DisarmWifiRevert(ctx); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"/bin/systemctl stop -- whombat-wifi-revert.timer",
		"/bin/systemd-run --unit=whombat-wifi-revert --collect --on-active=150 /bin/whombat-update-helper wifi-revert-deadman",
		"/bin/systemctl stop -- whombat-wifi-revert.timer",
	}
	if strings.Join(r.calls, "\n") != strings.Join(want, "\n") {
		t.Fatalf("calls:\n%s", strings.Join(r.calls, "\n"))
	}
}

func TestNixSchemaCommands(t *testing.T) {
	n, r := newNix(t)
	ctx := context.Background()
	r.out = []byte(`{"format":"whombat.schema-check/1","verdict":"migration_required","access":"none","binary":{"version":30},"database":{"version":28},"pending":["0028_a","0029_b"],"needsCheckpoint":["0029_b"],"reason":"behind","action":"migrate"}`)
	r.exit = 10
	s, err := n.SchemaCheck(ctx, sp)
	if err != nil || s.Exit != 10 || s.Verdict != "migration_required" || len(s.NeedsCheckpoint) != 1 || s.DatabaseVersion != 28 {
		t.Fatalf("%+v %v", s, err)
	}
	r.out = []byte(`{"format":"whombat.migrate/1","ok":false,"applied":[],"error":{"kind":"checkpoint_required","message":"x","migrations":["0029_b"]}}`)
	r.exit = 13
	s, err = n.Migrate(ctx, sp, "ckpt-1")
	if err != nil || s.Exit != 13 || s.ErrorKind != "checkpoint_required" {
		t.Fatalf("%+v %v", s, err)
	}
	if _, err := n.Migrate(ctx, sp, "--home=/tmp"); err == nil {
		t.Fatal("bad checkpoint accepted")
	}
	want := []string{sp + "/bin/whombat schema-check --json --env", sp + "/bin/whombat migrate --json --env --checkpoint ckpt-1"}
	if strings.Join(r.calls, "\n") != strings.Join(want, "\n") {
		t.Fatalf("calls %v", r.calls)
	}
	if r.asUIDs[0] != 990 || !strings.Contains(strings.Join(r.envs[0], " "), "WHOMBAT_ENV_FILE=/persist/whombat/runtime.env") {
		t.Fatal("not run as runtime user with env file")
	}
	if _, err := ParseSchemaCheck([]byte("garbage"), 1); err == nil {
		t.Fatal("garbage parsed")
	}
}

// The schema the migration authority leaves and its floors (Whombat MD-12) reach the manager; a runtime before it
// (no target) or an inconsistent target leaves Target nil.
func TestParseSchemaTarget(t *testing.T) {
	const head = `{"format":"whombat.schema-check/1","verdict":"migration_required","access":"none","binary":{"version":49},"database":{"version":48},"pending":["0048_capabilities"],"needsCheckpoint":[]`
	s, err := ParseSchemaCheck([]byte(head+`,"target":{"version":49,"tag":"0048_capabilities","readers":48,"writers":48}}`), 10)
	if err != nil || s.Target == nil || *s.Target != (proto.SchemaTarget{Version: 49, Readers: 48, Writers: 48}) {
		t.Fatalf("%+v %v", s, err)
	}
	for _, tail := range []string{`}`, `,"target":null}`, `,"target":{"version":49,"readers":48}}`,
		`,"target":{"version":49,"readers":49,"writers":48}}`, `,"target":{"version":49,"readers":48,"writers":50}}`,
		`,"target":{"version":49,"readers":-1,"writers":48}}`} {
		s, err := ParseSchemaCheck([]byte(head+tail), 10)
		if err != nil || s.Target != nil || s.Exit != 10 || s.DatabaseVersion != 48 {
			t.Fatalf("%s: %+v %v", tail, s, err)
		}
	}
	m, err := ParseMigrate([]byte(`{"format":"whombat.migrate/1","ok":true,"applied":["0048_capabilities"],"check":{"format":"whombat.schema-check/1","verdict":"current","access":"read-write","binary":{"version":49},"database":{"version":49},"pending":[],"needsCheckpoint":[],"target":{"version":49,"tag":"0048_capabilities","readers":48,"writers":48}}}`), 0)
	if err != nil || m.Target == nil || m.Target.Writers != 48 || m.DatabaseVersion != 49 {
		t.Fatalf("%+v %v", m, err)
	}
}

func TestNixHostGenerations(t *testing.T) {
	n, r := newNix(t)
	n.C.ProfilesDir = t.TempDir()
	os.Symlink(hp, filepath.Join(n.C.ProfilesDir, "system-3-link"))
	os.Symlink(sp, filepath.Join(n.C.ProfilesDir, "system-4-link"))
	os.Symlink("system-4-link", filepath.Join(n.C.ProfilesDir, "system"))
	r.runOut = []byte("   3   2026-09-20 10:00:00   \n   4   2026-09-25 12:00:00   (current)\n")
	gens, err := n.HostGenerations(context.Background())
	if err != nil || len(gens) != 2 || gens[0].Number != 3 || gens[0].StorePath != hp || gens[1].StorePath != sp {
		t.Fatalf("%+v %v", gens, err)
	}
	r.calls = nil
	if err := n.DeleteHostGenerations(context.Background(), []int{3}); err != nil {
		t.Fatal(err)
	}
	want := "/bin/nix-env --profile " + filepath.Join(n.C.ProfilesDir, "system") + " --delete-generations 3\n" + sp + "/bin/switch-to-configuration boot"
	if strings.Join(r.calls, "\n") != want {
		t.Fatalf("calls:\n%s", strings.Join(r.calls, "\n"))
	}
}

func TestNixInvalidPathsBatches(t *testing.T) {
	n, r := newNix(t)
	var paths []string
	for i := 0; i < 600; i++ {
		paths = append(paths, fmt.Sprintf("/nix/store/0123456789abcdfghijklmnpqrsvwxyz-p%03d", i))
	}
	r.runOut = []byte(paths[3] + "\nwarning: something\n" + paths[599] + "\n/nix/store/0123456789abcdfghijklmnpqrsvwxyz-unasked\n")
	got, err := n.InvalidPaths(context.Background(), paths)
	if err != nil || len(got) != 2 || got[0] != paths[3] || got[1] != paths[599] {
		t.Fatalf("%v %v", got, err)
	}
	if len(r.calls) != 3 || !strings.HasPrefix(r.calls[0], "/bin/nix-store --check-validity --print-invalid "+paths[0]) {
		t.Fatalf("calls %d: %.100v", len(r.calls), r.calls)
	}
	if _, err := n.InvalidPaths(context.Background(), []string{"/etc/passwd"}); err == nil {
		t.Fatal("invalid store path passed to nix-store")
	}
}

func TestNixImportNarFrame(t *testing.T) {
	n, r := newNix(t)
	ref := "/nix/store/1123456789abcdfghijklmnpqrsvwxyz-lib"
	src, nars, err := nixexport.ReadNARs(bytes.NewReader(nixexport.Synthetic(nixexport.SyntheticPath{StorePath: sp, Files: map[string]string{"a": "b"}})))
	if err != nil {
		t.Fatal(err)
	}
	nar := nars[sp]
	if err := n.ImportNar(context.Background(), NarPath{StorePath: sp, NarSize: int64(len(nar)), References: []string{ref}}, bytes.NewReader(nar)); err != nil {
		t.Fatal(err)
	}
	if len(r.stdin) != 1 || r.calls[0] != "/bin/nix-store --import" || r.calls[1] != "/bin/nix-store --check-validity "+sp {
		t.Fatalf("calls %v", r.calls)
	}
	got, err := nixexport.Read(strings.NewReader(r.stdin[0]))
	if err != nil || len(got.Paths) != 1 || got.Paths[0].NarHash != src.Paths[0].NarHash || got.Paths[0].References[0] != ref {
		t.Fatalf("frame %+v %v", got, err)
	}
	// A NAR that is not the announced size never completes the frame.
	if err := n.ImportNar(context.Background(), NarPath{StorePath: sp, NarSize: int64(len(nar)) + 1}, bytes.NewReader(nar)); err == nil {
		t.Fatal("short NAR imported")
	}
	if err := n.ImportNar(context.Background(), NarPath{StorePath: sp, NarSize: 8, References: []string{"/tmp/x"}}, bytes.NewReader(nar)); err == nil {
		t.Fatal("bad reference passed")
	}
}

// UP-X18: the runtime profile's generations, listed and deleted like the system profile's (no boot entries to rewrite).
func TestNixRuntimeGenerations(t *testing.T) {
	n, r := newNix(t)
	n.C.ProfilesDir = t.TempDir()
	old := "/nix/store/0123456789abcdfghijklmnpqrsvwxyb-whombat-runtime-0.9.0"
	os.Symlink(old, filepath.Join(n.C.ProfilesDir, "whombat-runtime-2-link"))
	os.Symlink(sp, filepath.Join(n.C.ProfilesDir, "whombat-runtime-3-link"))
	os.Symlink("/tmp/not-a-store-path", filepath.Join(n.C.ProfilesDir, "whombat-runtime-4-link"))
	os.Symlink("whombat-runtime-3-link", filepath.Join(n.C.ProfilesDir, "whombat-runtime"))
	r.runOut = []byte("   2   2026-10-05 10:00:00   \n   3   2026-10-06 12:00:00   (current)\n   4   2026-10-07 09:00:00   \n")
	gens, err := n.RuntimeGenerations(context.Background())
	// Generation 4 names no store path: left out, so it is never deleted.
	if err != nil || len(gens) != 2 || gens[0] != (Generation{Number: 2, StorePath: old}) ||
		gens[1] != (Generation{Number: 3, StorePath: sp, Current: true}) {
		t.Fatalf("%+v %v", gens, err)
	}
	if r.calls[0] != "/bin/nix-env --profile "+filepath.Join(n.C.ProfilesDir, "whombat-runtime")+" --list-generations" {
		t.Fatalf("calls %v", r.calls)
	}
	r.calls = nil
	if err := n.DeleteRuntimeGenerations(context.Background(), []int{2, 7}); err != nil {
		t.Fatal(err)
	}
	if err := n.DeleteRuntimeGenerations(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if err := n.DeleteRuntimeGenerations(context.Background(), []int{0}); err == nil {
		t.Fatal("generation 0 accepted")
	}
	// Numbers only, and nothing else runs: the runtime keeps running from the current generation.
	want := "/bin/nix-env --profile " + filepath.Join(n.C.ProfilesDir, "whombat-runtime") + " --delete-generations 2 7"
	if strings.Join(r.calls, "\n") != want {
		t.Fatalf("calls:\n%s", strings.Join(r.calls, "\n"))
	}
}

// UP-X19: `nix-store --gc` (never -d: no generation goes) in a transient scope with low CPU/IO weights and nice 19; the
// summary line is parsed and the store's file system's free space read.
func TestNixCollectGarbage(t *testing.T) {
	n, r := newNix(t)
	n.C.StoreDir = t.TempDir()
	r.runOut = []byte("finding garbage collector roots...\n" +
		"removing stale link from '/nix/var/nix/gcroots/auto/0p4dlv' to '/nix/var/nix/profiles/whombat-runtime-2-link'\n" +
		"deleting garbage...\n" +
		"deleting '/nix/store/0123456789abcdfghijklmnpqrsvwxyb-whombat-runtime-0.9.0'\n" +
		"deleting '/nix/store/trash'\n" +
		"deleting unused links...\n" +
		"note: currently hard linking saves 0.00 MiB\n" +
		"2 store paths deleted, 31.25 MiB freed\n")
	res, err := n.CollectGarbage(context.Background())
	if err != nil || res.Paths != 2 || res.FreedBytes != 32768000 || res.FreeBytes <= 0 {
		t.Fatalf("%+v %v", res, err)
	}
	want := "/bin/systemd-run --scope --quiet --collect --unit=whombat-store-gc --nice=19 --property=CPUWeight=10 " +
		"--property=IOWeight=10 /bin/nix-store --gc"
	if len(r.calls) != 1 || r.calls[0] != want {
		t.Fatalf("calls %v", r.calls)
	}
}

func TestParseGCSummary(t *testing.T) {
	for _, c := range []struct {
		out   string
		paths int
		freed int64
	}{
		{"1441 store paths deleted, 1934.50 MiB freed\n", 1441, 2028470272},                    // Nix up to 2.31: "%.2f MiB"
		{"deleting '/nix/store/x'\n812 store paths deleted, 1.5 GiB freed\n", 812, 1610612736}, // newer: "%.1f <unit>iB"
		{"1 store paths deleted, 0.5 KiB freed", 1, 512},
		{"0 store paths deleted, 0.00 MiB freed\n", 0, 0},
		{"0 store paths deleted, 0.0 KiB freed\r\n", 0, 0},
		// No summary (a Nix that prints none): the "deleting" lines, size unknown.
		{"deleting '/nix/store/0123456789abcdfghijklmnpqrsvwxyb-a'\n  deleting '/nix/store/0123456789abcdfghijklmnpqrsvwxyc-b'\ndone\n", 2, -1},
		{"", 0, -1},
	} {
		got := ParseGCSummary([]byte(c.out))
		if got.Paths != c.paths || got.FreedBytes != c.freed || got.FreeBytes != -1 {
			t.Errorf("%q: %+v", c.out, got)
		}
	}
}

func TestNixCable(t *testing.T) {
	n, r := newNix(t)
	ctx := context.Background()
	d := t.TempDir()
	n.C.CableOffFile = filepath.Join(d, "run", "05-whombat-cable-off.network")
	n.C.SysDir = filepath.Join(d, "sys")
	for _, i := range []string{"eth1", "enp3s0", "wlan0", "lo"} {
		os.MkdirAll(filepath.Join(n.C.SysDir, "class", "net", i), 0o755)
	}
	if err := n.ArmCableRevert(ctx, 180); err != nil {
		t.Fatal(err)
	}
	if err := n.SetCable(ctx, true, []string{"enx001122"}); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(n.C.CableOffFile)
	if err != nil || !strings.Contains(string(b), "Name=en* eth* enx001122\n") || !strings.Contains(string(b), "LinkLocalAddressing=no") {
		t.Fatal(string(b), err)
	}
	if live, committed, _ := n.CableState(ctx); !live || committed {
		t.Fatal(live, committed)
	}
	if err := n.CommitCable(ctx, true, nil); err != nil {
		t.Fatal(err)
	}
	if err := n.DisarmCableRevert(ctx); err != nil {
		t.Fatal(err)
	}
	if err := n.SetCable(ctx, false, nil); err != nil {
		t.Fatal(err)
	}
	if err := n.CommitCable(ctx, false, nil); err != nil {
		t.Fatal(err)
	}
	if live, committed, _ := n.CableState(ctx); live || committed {
		t.Fatal(live, committed)
	}
	want := []string{
		"/bin/systemctl stop -- whombat-cable-revert.timer",
		"/bin/systemd-run --unit=whombat-cable-revert --collect --on-active=180 /bin/whombat-update-helper cable-revert-deadman",
		"/bin/networkctl reload",
		"/bin/networkctl reconfigure enp3s0 eth1",
		"/bin/systemctl stop -- whombat-cable-revert.timer",
		"/bin/networkctl reload",
		"/bin/networkctl reconfigure enp3s0 eth1",
	}
	if strings.Join(r.calls, "\n") != strings.Join(want, "\n") {
		t.Fatalf("calls:\n%s", strings.Join(r.calls, "\n"))
	}
}
