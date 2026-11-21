package pkgs

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"rackoon/internal/proto"
)

func argvs(steps []Step) []string {
	var out []string
	for _, s := range steps {
		out = append(out, s.Kind+": "+strings.Join(s.Argv, " "))
	}
	return out
}

func TestPlan(t *testing.T) {
	const aptI = "apt-get -q -y -o DPkg::Lock::Timeout=120 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold"
	cases := []struct {
		manager, op string
		pkgs        []string
		host        Host
		want        []string
	}{
		{APT, OpCheck, nil, Host{}, []string{"refresh: apt-get -q -o DPkg::Lock::Timeout=120 update"}},
		{APT, OpInstall, nil, Host{}, []string{"refresh: apt-get -q -o DPkg::Lock::Timeout=120 update", "upgrade: " + aptI + " dist-upgrade"}},
		{APT, OpInstall, []string{"nginx", "libssl3:amd64"}, Host{DpkgInterrupted: true}, []string{
			"repair: dpkg --force-confdef --force-confold --configure -a",
			"refresh: apt-get -q -o DPkg::Lock::Timeout=120 update",
			"upgrade: " + aptI + " install --only-upgrade nginx libssl3:amd64"}},
		{DNF, OpCheck, nil, Host{}, []string{"refresh: dnf -y --refresh makecache"}},
		{DNF, OpInstall, []string{"kernel"}, Host{}, []string{"refresh: dnf -y --refresh makecache", "upgrade: dnf -y upgrade kernel"}},
		{YUM, OpInstall, nil, Host{}, []string{"refresh: yum -y makecache", "upgrade: yum -y update"}},
		{Zypper, OpInstall, nil, Host{}, []string{"refresh: zypper --non-interactive refresh",
			"upgrade: zypper --non-interactive update --auto-agree-with-licenses"}},
		{Zypper, OpInstall, nil, Host{Tumbleweed: true}, []string{"refresh: zypper --non-interactive refresh",
			"upgrade: zypper --non-interactive dup --auto-agree-with-licenses"}},
		{Zypper, OpInstall, []string{"curl"}, Host{Tumbleweed: true}, []string{"refresh: zypper --non-interactive refresh",
			"upgrade: zypper --non-interactive update --auto-agree-with-licenses -- curl"}},
		{APK, OpCheck, nil, Host{}, []string{"refresh: apk --wait 120 --no-progress update"}},
		{APK, OpInstall, []string{"busybox"}, Host{}, []string{"refresh: apk --wait 120 --no-progress update",
			"upgrade: apk --wait 120 --no-progress upgrade busybox"}},
		{Pacman, OpCheck, nil, Host{}, nil},
		{Pacman, OpInstall, nil, Host{}, []string{"upgrade: pacman -Syu --noconfirm --noprogressbar"}},
	}
	for _, c := range cases {
		steps, err := Plan(c.manager, c.op, c.pkgs, c.host)
		if err != nil {
			t.Errorf("%s %s: %v", c.manager, c.op, err)
			continue
		}
		if got := argvs(steps); !slices.Equal(got, c.want) {
			t.Errorf("%s %s %v:\n got %q\nwant %q", c.manager, c.op, c.pkgs, got, c.want)
		}
	}
	// Never apt upgrade, never a release upgrade.
	for _, m := range []string{APT, DNF, YUM, Zypper, APK, Pacman} {
		steps, _ := Plan(m, OpInstall, nil, Host{})
		for _, a := range argvs(steps) {
			if strings.Contains(a, " upgrade") && m == APT && !strings.Contains(a, "dist-upgrade") {
				t.Errorf("%s: %s", m, a)
			}
			if strings.Contains(a, "release") || strings.Contains(a, "sources.list") {
				t.Errorf("%s: %s", m, a)
			}
		}
	}
	if _, err := Plan(Pacman, OpInstall, []string{"linux"}, Host{}); !errors.Is(err, ErrNamedPacman) {
		t.Errorf("pacman with names: %v", err)
	}
	if _, err := Plan(APT, OpInstall, []string{"-o"}, Host{}); err == nil {
		t.Error("an option as a package name")
	}
	if _, err := Plan(APT, OpCheck, []string{"nginx"}, Host{}); err == nil {
		t.Error("a check with names")
	}
	if _, err := Plan("", OpCheck, nil, Host{}); !errors.Is(err, ErrUnsupported) {
		t.Errorf("no manager: %v", err)
	}
}

func TestEnv(t *testing.T) {
	for _, want := range []string{"DEBIAN_FRONTEND=noninteractive", "NEEDRESTART_MODE=a", "APT_LISTCHANGES_FRONTEND=none", "LC_ALL=C"} {
		if !slices.Contains(Env, want) {
			t.Errorf("Env lacks %s", want)
		}
	}
}

func TestIsTumbleweed(t *testing.T) {
	for in, want := range map[string]bool{
		"NAME=\"openSUSE Tumbleweed\"\nID=\"opensuse-tumbleweed\"\n": true,
		"ID=opensuse-slowroll\n":                         true,
		"NAME=\"openSUSE Leap\"\nID=\"opensuse-leap\"\n": false,
		"": false,
	} {
		if got := isTumbleweed(in); got != want {
			t.Errorf("%q: %v", in, got)
		}
	}
}

const aptEnterprise401 = `Hit:1 http://ftp.debian.org/debian bookworm InRelease
Hit:2 http://security.debian.org bookworm-security InRelease
Err:3 https://enterprise.proxmox.com/debian/pve bookworm InRelease
  401  Unauthorized [IP: 212.224.123.70 443]
Get:4 http://download.proxmox.com/debian/ceph-quincy bookworm InRelease [3,461 B]
Reading package lists...
E: Failed to fetch https://enterprise.proxmox.com/debian/pve/dists/bookworm/InRelease  401  Unauthorized [IP: 212.224.123.70 443]
E: The repository 'https://enterprise.proxmox.com/debian/pve bookworm InRelease' is not signed.
N: Updating from such a repository can't be done securely, and is therefore disabled by default.
N: See apt-secure(8) manpage for repository creation and user configuration details.
`

func TestRefreshOutcome(t *testing.T) {
	warn, fail := RefreshOutcome(aptEnterprise401, 100)
	if warn != EnterpriseWarning || fail != "" {
		t.Errorf("enterprise only: %q %q", warn, fail)
	}
	// apt 3 words, the ceph enterprise repository too.
	apt3 := strings.NewReplacer("E: ", "Error: ", "N: ", "Notice: ", "/pve", "/ceph-squid").Replace(aptEnterprise401) +
		"Error: Some index files failed to download. They have been ignored, or old ones used instead.\n"
	if warn, fail := RefreshOutcome(apt3, 100); warn != EnterpriseWarning || fail != "" {
		t.Errorf("apt 3: %q %q", warn, fail)
	}
	// Another repository failing too stops with apt's line.
	other := aptEnterprise401 + "E: Failed to fetch http://deb.example.com/dists/bookworm/InRelease  Could not resolve 'deb.example.com'\n"
	warn, fail = RefreshOutcome(other, 100)
	if warn != EnterpriseWarning || !strings.Contains(fail, "deb.example.com") {
		t.Errorf("two failures: %q %q", warn, fail)
	}
	// A 401 as a warning only (exit 0).
	if warn, fail := RefreshOutcome("W: Failed to fetch https://enterprise.proxmox.com/debian/pbs/dists/bookworm/InRelease  401  Unauthorized\n", 0); warn == "" || fail != "" {
		t.Errorf("warning: %q %q", warn, fail)
	}
	// Plain success and plain failure.
	if warn, fail := RefreshOutcome("Hit:1 http://deb.debian.org/debian bookworm InRelease\nReading package lists...\n", 0); warn != "" || fail != "" {
		t.Errorf("ok: %q %q", warn, fail)
	}
	if _, fail := RefreshOutcome("Reading package lists...\nE: Could not get lock /var/lib/apt/lists/lock. It is held by process 42 (apt-get)\n", 100); !strings.HasPrefix(fail, "E: Could not get lock") {
		t.Errorf("failure: %q", fail)
	}
	if _, fail := RefreshOutcome("something odd\n", 1); fail != "something odd" {
		t.Errorf("no error line: %q", fail)
	}
}

func TestLastLineAndLock(t *testing.T) {
	out := "Reading package lists...\nE: Unable to locate package nosuch\nDone\n"
	if got := LastLine(out); got != "E: Unable to locate package nosuch" {
		t.Errorf("error line: %q", got)
	}
	if got := LastLine("a\nb\n\n"); got != "b" {
		t.Errorf("last line: %q", got)
	}
	if !IsLockError("E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 1234 (apt-get)") ||
		!IsLockError("error: failed to init transaction (unable to lock database)") ||
		!IsLockError("System management is locked by the application with pid 77 (zypper).") ||
		IsLockError("E: Unable to locate package nosuch") {
		t.Error("lock errors")
	}
}

func TestKeptBackFromOutput(t *testing.T) {
	out := "Calculating upgrade...\nThe following packages have been kept back:\n  libpng16-16 zfs-dkms\n  pve-kernel-6.8\nThe following packages will be upgraded:\n  tzdata\n1 upgraded, 0 newly installed, 0 to remove and 3 not upgraded.\n"
	if got := KeptBackFromOutput(APT, out); !slices.Equal(got, []string{"libpng16-16", "zfs-dkms", "pve-kernel-6.8"}) {
		t.Errorf("apt: %q", got)
	}
	apt3 := "Not upgrading:\n  libpng16-16\n\nSummary:\n  Upgrading: 3, Installing: 0, Removing: 0, Not Upgrading: 1\n"
	if got := KeptBackFromOutput(APT, apt3); !slices.Equal(got, []string{"libpng16-16"}) {
		t.Errorf("apt 3: %q", got)
	}
	if got := KeptBackFromOutput(DNF, out); got != nil {
		t.Errorf("dnf: %q", got)
	}
}

func TestInstalledFromOutput(t *testing.T) {
	out := "resolving dependencies...\n\nPackages (3) linux-6.6.2.arch1-1  linux-headers-6.6.2.arch1-1  openssl-3.2.0-1\n\nTotal Installed Size:  150.00 MiB\n"
	if n, ok := InstalledFromOutput(Pacman, out); !ok || n != 3 {
		t.Errorf("pacman: %d %v", n, ok)
	}
	if _, ok := InstalledFromOutput(APT, out); ok {
		t.Error("apt reads the lists")
	}
}

// ---- the runner -----------------------------------------------------------------------

type fakeHost struct {
	waiting  []string
	execs    [][]string
	outputs  map[string]string // step kind -> output
	exits    map[string]int
	onExec   func(argv []string)
	checkErr error
}

func (f *fakeHost) runner(t *testing.T, spec *TaskSpec) *Runner {
	t.Helper()
	dir := t.TempDir()
	if err := WriteSpec(dir, spec); err != nil {
		t.Fatal(err)
	}
	return &Runner{Dir: dir, Host: &Host{},
		Check: func(ctx context.Context) (*Pending, error) {
			if f.checkErr != nil {
				return nil, f.checkErr
			}
			return &Pending{Names: slices.Clone(f.waiting), SecKnown: true, Security: min(1, len(f.waiting))}, nil
		},
		Exec: func(ctx context.Context, argv []string, w io.Writer) (int, error) {
			f.execs = append(f.execs, argv)
			kind := StepRefresh
			if slices.ContainsFunc(argv, func(a string) bool {
				return a == "dist-upgrade" || a == "upgrade" || a == "install" || a == "-Syu"
			}) && argv[len(argv)-1] != "update" {
				kind = StepUpgrade
			}
			io.WriteString(w, f.outputs[kind])
			if f.onExec != nil {
				f.onExec(argv)
			}
			return f.exits[kind], nil
		},
		LockHeld: func() (bool, string) { return false, "" }, LockPoll: time.Millisecond, LockWait: 20 * time.Millisecond}
}

func runTask(t *testing.T, r *Runner) *TaskResult {
	t.Helper()
	if err := r.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	res, err := ReadResult(r.Dir)
	if err != nil || res == nil {
		t.Fatalf("result: %v %v", res, err)
	}
	return res
}

func TestRunnerInstall(t *testing.T) {
	f := &fakeHost{waiting: []string{"curl", "libcurl4", "openssl", "zfs-dkms"}, outputs: map[string]string{
		StepRefresh: aptEnterprise401, StepUpgrade: "The following packages have been kept back:\n  zfs-dkms\n"},
		exits: map[string]int{StepRefresh: 100}}
	f.onExec = func(argv []string) {
		if slices.Contains(argv, "dist-upgrade") {
			f.waiting = []string{"zfs-dkms"}
		}
	}
	r := f.runner(t, &TaskSpec{ID: "pkg:0123456789abcdef", Op: OpInstall, Manager: APT, Started: time.Now()})
	res := runTask(t, r)
	if res.Status != StatusOK || res.Installed == nil || *res.Installed != 3 || !slices.Equal(res.KeptBack, []string{"zfs-dkms"}) ||
		res.Warning != EnterpriseWarning || res.Message != "Installed 3 updates." || res.Waiting == nil || *res.Waiting != 1 {
		t.Errorf("result: %+v", res)
	}
	if len(f.execs) != 2 || !slices.Contains(f.execs[1], "dist-upgrade") {
		t.Errorf("steps: %q", f.execs)
	}
	log, _ := os.ReadFile(filepath.Join(r.Dir, LogFile))
	if !strings.Contains(string(log), "$ apt-get -q -y") || !strings.Contains(string(log), "kept back") {
		t.Errorf("log: %s", log)
	}
	// The result is written once.
	if err := WriteResult(r.Dir, &TaskResult{Status: StatusFailed}); err != nil {
		t.Fatal(err)
	}
	if again, _ := ReadResult(r.Dir); again.Status != StatusOK {
		t.Error("result overwritten")
	}
}

func TestRunnerNamedAndNothing(t *testing.T) {
	f := &fakeHost{waiting: []string{"curl", "nginx", "openssl"}}
	f.onExec = func(argv []string) {
		if slices.Contains(argv, "--only-upgrade") {
			f.waiting = []string{"curl", "nginx"} // nginx was held
		}
	}
	res := runTask(t, f.runner(t, &TaskSpec{Op: OpInstall, Manager: APT, Packages: []string{"nginx", "openssl"}}))
	if *res.Installed != 1 || !slices.Equal(res.KeptBack, []string{"nginx"}) || res.Message != "Installed 1 update." {
		t.Errorf("named: %+v", res)
	}
	f = &fakeHost{}
	res = runTask(t, f.runner(t, &TaskSpec{Op: OpInstall, Manager: DNF}))
	if res.Status != StatusOK || *res.Installed != 0 || res.Message != "Nothing to install." {
		t.Errorf("nothing: %+v", res)
	}
}

func TestRunnerCheck(t *testing.T) {
	f := &fakeHost{waiting: []string{"a", "b"}}
	res := runTask(t, f.runner(t, &TaskSpec{Op: OpCheck, Manager: APT}))
	if res.Status != StatusOK || res.Installed != nil || res.Message != "2 updates waiting, 1 for security." || len(f.execs) != 1 {
		t.Errorf("check: %+v %q", res, f.execs)
	}
	// pacman: no refresh, the cache read again.
	f = &fakeHost{}
	res = runTask(t, f.runner(t, &TaskSpec{Op: OpCheck, Manager: Pacman}))
	if res.Status != StatusOK || len(f.execs) != 0 || res.Message != "No updates waiting." {
		t.Errorf("pacman check: %+v", res)
	}
}

func TestRunnerFailures(t *testing.T) {
	// A refresh failure that isn't the enterprise repository stops with
	// apt's own line.
	f := &fakeHost{outputs: map[string]string{StepRefresh: "E: Failed to fetch http://deb.example.com/x  404  Not Found\n"},
		exits: map[string]int{StepRefresh: 100}}
	res := runTask(t, f.runner(t, &TaskSpec{Op: OpInstall, Manager: APT}))
	if res.Status != StatusFailed || !strings.Contains(res.Message, "404") || len(f.execs) != 1 {
		t.Errorf("refresh failure: %+v", res)
	}
	// With the enterprise repository refusing too: no warning (it stopped).
	f = &fakeHost{outputs: map[string]string{StepRefresh: aptEnterprise401 + "E: Failed to fetch http://deb.example.com/x  404  Not Found\n"},
		exits: map[string]int{StepRefresh: 100}}
	res = runTask(t, f.runner(t, &TaskSpec{Op: OpInstall, Manager: APT}))
	if res.Status != StatusFailed || !strings.Contains(res.Message, "deb.example.com") || res.Warning != "" {
		t.Errorf("refresh failure with the enterprise refusal: %+v", res)
	}
	// The upgrade fails: its line, and what got in.
	f = &fakeHost{waiting: []string{"a", "b"}, outputs: map[string]string{StepUpgrade: "E: Sub-process /usr/bin/dpkg returned an error code (1)\n"},
		exits: map[string]int{StepUpgrade: 100}}
	f.onExec = func(argv []string) {
		if slices.Contains(argv, "dist-upgrade") {
			f.waiting = []string{"b"}
		}
	}
	res = runTask(t, f.runner(t, &TaskSpec{Op: OpInstall, Manager: APT}))
	if res.Status != StatusFailed || res.Message != "E: Sub-process /usr/bin/dpkg returned an error code (1)" || *res.Installed != 1 {
		t.Errorf("upgrade failure: %+v", res)
	}
	// Another program's lock: busy, with the server's name.
	f = &fakeHost{outputs: map[string]string{StepRefresh: "E: Could not get lock /var/lib/apt/lists/lock. It is held by process 9 (apt-get)\n"},
		exits: map[string]int{StepRefresh: 100}}
	res = runTask(t, f.runner(t, &TaskSpec{Op: OpCheck, Manager: APT, Server: "pve-02"}))
	if res.Code != proto.TaskCodeBusy || !strings.Contains(res.Message, "pve-02") {
		t.Errorf("lock error: %+v", res)
	}
	// The lock stays held: the task gives up without running anything.
	f = &fakeHost{}
	r := f.runner(t, &TaskSpec{Op: OpInstall, Manager: APT})
	r.LockHeld = func() (bool, string) { return true, "/var/lib/dpkg/lock-frontend" }
	res = runTask(t, r)
	if res.Code != proto.TaskCodeBusy || len(f.execs) != 0 {
		t.Errorf("held lock: %+v %q", res, f.execs)
	}
	log, _ := os.ReadFile(filepath.Join(r.Dir, LogFile))
	if !strings.Contains(string(log), "Waiting for another program") {
		t.Errorf("log: %s", log)
	}
}

func TestRunnerLimitAndStop(t *testing.T) {
	block := func(f *fakeHost, r *Runner) {
		r.Exec = func(ctx context.Context, argv []string, w io.Writer) (int, error) {
			f.execs = append(f.execs, argv)
			<-ctx.Done()
			return -1, ctx.Err()
		}
	}
	// Past its limit (the task started long ago): timeout.
	f := &fakeHost{}
	r := f.runner(t, &TaskSpec{Op: OpCheck, Manager: APT, Started: time.Now().Add(-CheckLimit + 50*time.Millisecond)})
	block(f, r)
	res := runTask(t, r)
	if res.Code != proto.TaskCodeTimeout || !strings.Contains(res.Message, "10 minutes") {
		t.Errorf("limit: %+v", res)
	}
	// A check stops when asked.
	f = &fakeHost{}
	r = f.runner(t, &TaskSpec{Op: OpCheck, Manager: APT, Started: time.Now()})
	block(f, r)
	stop := make(chan struct{})
	r.Stop = stop
	time.AfterFunc(20*time.Millisecond, func() { close(stop) })
	res = runTask(t, r)
	if res.Status != StatusFailed || res.Code != "" || res.Message != "Checking for updates was stopped." {
		t.Errorf("stopped: %+v", res)
	}
	// An install carries on.
	f = &fakeHost{waiting: []string{"a"}}
	r = f.runner(t, &TaskSpec{Op: OpInstall, Manager: APT, Started: time.Now()})
	stop = make(chan struct{})
	r.Stop = stop
	close(stop)
	f.onExec = func(argv []string) {
		time.Sleep(10 * time.Millisecond) // the stop arrives meanwhile
		if slices.Contains(argv, "dist-upgrade") {
			f.waiting = nil
		}
	}
	res = runTask(t, r)
	if res.Status != StatusOK || *res.Installed != 1 {
		t.Errorf("install asked to stop: %+v", res)
	}
}

func TestLimitWords(t *testing.T) {
	if limitWords(InstallLimit) != "2 hours" || limitWords(CheckLimit) != "10 minutes" || Limit(OpInstall) != InstallLimit {
		t.Error("limits")
	}
}

// ---- locks ----------------------------------------------------------------------------

// TestMain doubles as a helper process holding a lock (locks of this
// process don't count as another program's).
func TestMain(m *testing.M) {
	if p := os.Getenv("PKGS_HOLD_LOCK"); p != "" {
		f, err := os.OpenFile(p, os.O_RDWR|os.O_CREATE, 0o600)
		if err != nil {
			os.Exit(2)
		}
		if os.Getenv("PKGS_LOCK_KIND") == "flock" {
			err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX)
		} else {
			lk := syscall.Flock_t{Type: syscall.F_WRLCK}
			err = syscall.FcntlFlock(f.Fd(), syscall.F_SETLKW, &lk)
		}
		if err != nil {
			os.Exit(3)
		}
		os.Stdout.WriteString("locked\n")
		io.Copy(io.Discard, os.Stdin) // until the test closes stdin
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func holdLock(t *testing.T, path, kind string) {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	cmd.Env = append(os.Environ(), "PKGS_HOLD_LOCK="+path, "PKGS_LOCK_KIND="+kind)
	in, _ := cmd.StdinPipe()
	out, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 7)
	if _, err := io.ReadFull(out, buf); err != nil {
		t.Fatalf("helper: %v", err)
	}
	t.Cleanup(func() { in.Close(); cmd.Wait() })
}

func TestLockHeld(t *testing.T) {
	root := t.TempDir()
	old := lockRoot
	lockRoot = root
	t.Cleanup(func() { lockRoot = old })
	mk := func(p string) string {
		full := filepath.Join(root, p)
		os.MkdirAll(filepath.Dir(full), 0o755)
		os.WriteFile(full, nil, 0o600)
		return full
	}
	for _, m := range []string{APT, DNF, Zypper, APK, Pacman} {
		if held, _ := LockHeld(m); held {
			t.Errorf("%s: held without files", m)
		}
	}
	mk("/var/lib/dpkg/lock-frontend")
	if held, _ := LockHeld(APT); held {
		t.Error("an unlocked file")
	}
	holdLock(t, filepath.Join(root, "/var/lib/dpkg/lock-frontend"), "fcntl")
	if held, file := LockHeld(APT); !held || file != "/var/lib/dpkg/lock-frontend" {
		t.Errorf("apt: %v %s", held, file)
	}
	holdLock(t, mk("/lib/apk/db/lock"), "flock")
	if held, _ := LockHeld(APK); !held {
		t.Error("apk")
	}
	mk("/var/lib/pacman/db.lck")
	if held, _ := LockHeld(Pacman); !held {
		t.Error("pacman")
	}
	// A pid file names a live process (this one doesn't count).
	os.WriteFile(mk("/run/zypp.pid"), []byte(strconv.Itoa(os.Getpid())), 0o600)
	if held, _ := LockHeld(Zypper); held {
		t.Error("own pid")
	}
	os.WriteFile(mk("/run/zypp.pid"), []byte(strconv.Itoa(os.Getppid())), 0o600)
	if held, _ := LockHeld(Zypper); !held {
		t.Error("zypper")
	}
}
