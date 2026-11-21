package look

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/support/internal/wire"
)

func TestParseAcceptsTheGrammar(t *testing.T) {
	for _, tc := range []struct {
		line  string
		name  string
		units []string
		argv  []string
		line2 string
	}{
		{"help", "help", nil, nil, ""},
		{"  status ", "status", nil, nil, ""},
		{"status whombat-server.service postgresql", "status", []string{"whombat-server.service", "postgresql"}, nil,
			"whombat-server.service postgresql"},
		{"status getty@tty1.service", "status", []string{"getty@tty1.service"}, nil, "getty@tty1.service"},
		{"units --failed", "units", nil, nil, "--failed"},
		{"logs", "logs", nil, []string{"--no-pager", "-o", "short-iso", "--lines=200"}, ""},
		{"logs whombat-server -n 50", "logs", []string{"whombat-server"},
			[]string{"--no-pager", "-o", "short-iso", "--lines=50", "--unit=whombat-server"}, "whombat-server -n 50"},
		{`logs -u whombat-manager --since "2026-10-21 14:00" --until=now -p err..warning`, "logs", []string{"whombat-manager"},
			[]string{"--no-pager", "-o", "short-iso", "--lines=10000", "--since=2026-10-21 14:00", "--until=now",
				"--priority=err..warning", "--unit=whombat-manager"},
			`-u whombat-manager --since "2026-10-21 14:00" --until=now -p err..warning`},
		{"logs --since -2h -k -b -1 -g 'oom|killed' -f", "logs", nil,
			[]string{"--no-pager", "-o", "short-iso", "--lines=10000", "--since=-2h", "--dmesg", "--boot=-1",
				"--grep=oom|killed", "--follow"}, "--since -2h -k -b -1 -g 'oom|killed' -f"},
		{"logs -b whombat-server", "logs", []string{"whombat-server"},
			[]string{"--no-pager", "-o", "short-iso", "--lines=10000", "--boot", "--unit=whombat-server"}, "-b whombat-server"},
		{"logs --since=2026-10-21T08:00:00 -S x", "", nil, nil, ""}, // -S twice: refused below
		{`logs --since "1 hour ago" --lines=7`, "logs", nil,
			[]string{"--no-pager", "-o", "short-iso", "--lines=7", "--since=1 hour ago"}, `--since "1 hour ago" --lines=7`},
		{"logs --since=@1792000000 --boot=0123456789abcdef0123456789abcdef", "logs", nil,
			[]string{"--no-pager", "-o", "short-iso", "--lines=10000", "--since=@1792000000",
				"--boot=0123456789abcdef0123456789abcdef"}, "--since=@1792000000 --boot=0123456789abcdef0123456789abcdef"},
		{"processes", "processes", nil, nil, ""},
		{"report", "report", nil, nil, ""},
	} {
		c, err := Parse(tc.line)
		if tc.name == "" {
			if err == nil {
				t.Errorf("%q: accepted", tc.line)
			}
			continue
		}
		if err != nil {
			t.Errorf("%q: %v", tc.line, err)
			continue
		}
		if c.Name != tc.name || !slices.Equal(c.Units, tc.units) || !slices.Equal(c.argv, tc.argv) || c.Line != tc.line2 {
			t.Errorf("%q: %+v", tc.line, c)
		}
	}
}

func TestParseRefuses(t *testing.T) {
	for _, tc := range []struct {
		line, reason string
	}{
		{"", wire.ReasonUnknownCommand},
		{"rm -rf /", wire.ReasonUnknownCommand},
		{"restart whombat-server", wire.ReasonUnknownCommand},
		{"STATUS", wire.ReasonUnknownCommand},
		{"status -Hroot@evil", wire.ReasonBadArguments}, // never an option in a unit's place
		{"status --host=evil", wire.ReasonBadArguments},
		{"status a b c d e f g h i", wire.ReasonBadArguments},
		{"status " + strings.Repeat("a", 81), wire.ReasonBadArguments},
		{"status foo/bar", wire.ReasonBadArguments},
		{"status 'foo bar'", wire.ReasonBadArguments},
		{"status $(id)", wire.ReasonBadArguments},
		{"status `id`", wire.ReasonBadArguments},
		{"status a;id", wire.ReasonBadArguments},
		{"units --all", wire.ReasonBadArguments},
		{"hardware --raw", wire.ReasonBadArguments},
		{"logs -n 0", wire.ReasonBadArguments},
		{"logs -n 10001", wire.ReasonBadArguments},
		{"logs -n 1e3", wire.ReasonBadArguments},
		{"logs -n 05", wire.ReasonBadArguments},
		{"logs -n", wire.ReasonBadArguments},
		{"logs -n 5 -n 6", wire.ReasonBadArguments},
		{"logs --since 'last tuesday'", wire.ReasonBadArguments},
		{"logs --since '2026-10-21 14:00; id'", wire.ReasonBadArguments},
		{"logs -p loud", wire.ReasonBadArguments},
		{"logs -g " + strings.Repeat("x", 101), wire.ReasonBadArguments},
		{"logs -g ''", wire.ReasonBadArguments},
		{"logs -o json", wire.ReasonBadArguments},
		{"logs --output=json", wire.ReasonBadArguments},
		{"logs -D /persist", wire.ReasonBadArguments},
		{"logs --directory=/persist", wire.ReasonBadArguments},
		{"logs --file=/persist/x", wire.ReasonBadArguments},
		{"logs -fk", wire.ReasonBadArguments},
		{"logs -f=1", wire.ReasonBadArguments},
		{"logs --follow=yes", wire.ReasonBadArguments},
		{"logs -b x1", wire.ReasonBadArguments}, // a unit: "x1" is fine; this checks the next case's contrast
		{"logs --boot=x1", wire.ReasonBadArguments},
		{"logs -u -x", wire.ReasonBadArguments},
		{"logs 'unfinished", wire.ReasonBadArguments},
		{"logs a\x1b[2J", wire.ReasonBadArguments},
		{"logs \xff", wire.ReasonBadArguments},
	} {
		_, err := Parse(tc.line)
		var r *Refusal
		if tc.line == "logs -b x1" { // x1 is a unit name, so this one is accepted
			if err != nil {
				t.Errorf("%q: %v", tc.line, err)
			}
			continue
		}
		if !errors.As(err, &r) || r.Reason != tc.reason || r.Message == "" {
			t.Errorf("%q: %v (want %s)", tc.line, err, tc.reason)
		}
	}
}

func TestUnknownCommandListsTheCommands(t *testing.T) {
	_, err := Parse("dmesg")
	if err == nil || !strings.Contains(err.Error(), "logs") || !strings.Contains(err.Error(), "report") {
		t.Fatalf("%v", err)
	}
}

func TestStepCarriesTheCommandAndUnitsNotOutput(t *testing.T) {
	c, err := Parse("logs whombat-voice -n 5")
	if err != nil {
		t.Fatal(err)
	}
	s := c.Step()
	if s.Kind != wire.StepLook || *s.Command != "logs" || !slices.Equal(s.Units, []string{"whombat-voice"}) ||
		*s.Line != "whombat-voice -n 5" || !wire.StepValid(s) {
		t.Fatalf("%+v", s)
	}
	st, _ := Parse("status whombat-voice")
	if s := st.Step(); len(s.Units) != 0 || *s.Line != "whombat-voice" || !wire.StepValid(s) {
		t.Fatalf("%+v", s)
	}
	if s := (Command{Name: "help"}).Step(); s.Line != nil || !wire.StepValid(s) {
		t.Fatalf("%+v", s)
	}
	long, _ := Parse("logs -g " + strings.Repeat("x", 100) + " " + strings.Repeat("-n 5 ", 1))
	if n := len([]rune(long.Line)); n > wire.CommandLineChars {
		t.Fatalf("line of %d", n)
	}
}

func TestSplit(t *testing.T) {
	for line, want := range map[string][]string{
		`a  b	c`:               {"a", "b", "c"},
		`'a b' "c \"d\"" e\ f`: {"a b", `c "d"`, "e f"},
		`--since="1 hour ago"`: {"--since=1 hour ago"},
		`''`:                   {""},
		`$HOME *`:              {"$HOME", "*"},
	} {
		got, err := Split(line)
		if err != nil || !slices.Equal(got, want) {
			t.Errorf("%q: %q %v", line, got, err)
		}
	}
	for _, bad := range []string{`"a`, `a\`, "a\nb", "a\x00", strings.Repeat("a ", 65), strings.Repeat("a", 2001)} {
		if _, err := Split(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestValidTime(t *testing.T) {
	for _, ok := range []string{"2026-10-21", "2026-10-21 14:00", "2026-10-21 14:00:05", "2026-10-21T14:00", "14:00",
		"14:00:01 UTC", "@1792000000", "yesterday", "now", "-2h", "+5min", "-30 minutes", "1 hour ago", "3days ago"} {
		if !ValidTime(ok) {
			t.Errorf("%q refused", ok)
		}
	}
	for _, bad := range []string{"", "soon", "2026-10-21 14", "-2", "2h", "-2 fortnights", "1 hour", "@", "now;id",
		"2026-10-21 14:00 CEST", "-1234567h"} {
		if ValidTime(bad) {
			t.Errorf("%q accepted", bad)
		}
	}
}

// fakeBins writes scripts that print their name and arguments one per line (a script, only in tests).
func fakeBins(t *testing.T, extra map[string]string) Bins {
	t.Helper()
	dir := t.TempDir()
	b := DefaultBins(dir)
	for _, p := range b.all() {
		script := "#!/bin/sh\nprintf '%s\\n' \"$(basename \"$0\")\" \"$@\"\n"
		if s, ok := extra[filepath.Base(p)]; ok {
			script = "#!/bin/sh\n" + s + "\n"
		}
		if err := os.WriteFile(p, []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return b
}

type fakeManager struct{ fail bool }

func (f fakeManager) read(what string) (json.RawMessage, error) {
	if f.fail {
		return nil, errors.New("manager: unavailable")
	}
	return json.RawMessage(`{"v":1,"what":"` + what + `","metrics":{"now":{"cpu":0.25}}}`), nil
}
func (f fakeManager) Hardware(context.Context) (json.RawMessage, error)     { return f.read("hardware") }
func (f fakeManager) NetworkState(context.Context) (json.RawMessage, error) { return f.read("network") }
func (f fakeManager) UpdateStatus(context.Context) (json.RawMessage, error) { return f.read("updates") }
func (f fakeManager) HostMetrics(context.Context) (json.RawMessage, error)  { return f.read("metrics") }

func runner(t *testing.T, bins Bins, m Manager) *Runner {
	t.Helper()
	r, err := New(Config{Bins: bins, UID: uint32(os.Getuid()), GID: uint32(os.Getgid()), KeepGroups: true,
		Manager: m, Timeout: 10 * time.Second, Path: "/usr/bin:/bin"})
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func run(t *testing.T, r *Runner, line string) (string, string, int) {
	t.Helper()
	c, err := Parse(line)
	if err != nil {
		t.Fatalf("%q: %v", line, err)
	}
	var out, errb bytes.Buffer
	code := r.Run(context.Background(), c, &out, &errb)
	return out.String(), errb.String(), code
}

func TestRunsFixedBinariesWithTheGrammarsArguments(t *testing.T) {
	r := runner(t, fakeBins(t, nil), fakeManager{})
	out, _, code := run(t, r, `logs whombat-server --since "2026-10-21 14:00" -n 20`)
	want := "journalctl\n--no-pager\n-o\nshort-iso\n--lines=20\n--since=2026-10-21 14:00\n--unit=whombat-server\n"
	if code != 0 || out != want {
		t.Fatalf("%d %q", code, out)
	}
	out, _, _ = run(t, r, "status whombat-voice")
	if out != "systemctl\n--no-pager\nshow\n--property="+unitProperties+"\n--\nwhombat-voice\n"+
		"journalctl\n--no-pager\n-o\nshort-iso\n--lines=20\n--unit=whombat-voice\n" {
		t.Fatalf("%q", out)
	}
	out, _, _ = run(t, r, "processes")
	if !strings.Contains(out, "comm") || strings.Contains(out, "args") || strings.Contains(out, "cmd") ||
		strings.Contains(out, "command") {
		t.Fatalf("processes asks for more than names: %q", out)
	}
	out, _, _ = run(t, r, "units --failed")
	if out != "systemctl\n--no-pager\nlist-units\n--failed\n" {
		t.Fatalf("%q", out)
	}
}

func TestReportIsTheDiagSetWithoutIncus(t *testing.T) {
	r := runner(t, fakeBins(t, nil), fakeManager{})
	out, _, code := run(t, r, "report")
	if code != 0 {
		t.Fatalf("%d", code)
	}
	for _, want := range []string{"== units ==", "whombat-*", "== system ==", "uname", "--since=-2h", "--unit=whombat-*",
		"--priority=warning", "--list-boots", "== network ==", "== DNS ==", "resolvectl\n--no-pager\nstatus", "/proc/pressure/memory"} {
		if !strings.Contains(out, want) {
			t.Errorf("report lacks %q", want)
		}
	}
	if strings.Contains(out, "incus") {
		t.Fatal("report reaches into incus")
	}
}

func TestManagerReadsAreIndentedJSON(t *testing.T) {
	r := runner(t, fakeBins(t, nil), fakeManager{})
	out, _, code := run(t, r, "hardware")
	if code != 0 || !strings.Contains(out, "\n  \"what\": \"hardware\"") {
		t.Fatalf("%d %q", code, out)
	}
	out, _, _ = run(t, r, "status")
	if !strings.Contains(out, "== measurements ==\n{\n  \"cpu\": 0.25\n}") {
		t.Fatalf("%q", out)
	}
	_, errs, code := run(t, runner(t, fakeBins(t, nil), fakeManager{fail: true}), "updates")
	if code == 0 || !strings.Contains(errs, "unavailable") {
		t.Fatalf("%d %q", code, errs)
	}
	_, errs, code = run(t, runner(t, fakeBins(t, nil), nil), "network")
	if code == 0 || !strings.Contains(errs, "isn't reachable") {
		t.Fatalf("%d %q", code, errs)
	}
}

func TestCommandsGetAFixedEnvironmentAndNoInput(t *testing.T) {
	t.Setenv("WHOMBAT_SECRET_FOR_TEST", "s3cret")
	r := runner(t, fakeBins(t, map[string]string{"uptime": "/usr/bin/env; read x && echo got-input"}), nil)
	c, _ := Parse("status")
	var out bytes.Buffer
	r.Run(context.Background(), c, &out, io.Discard)
	if strings.Contains(out.String(), "s3cret") || !strings.Contains(out.String(), "LC_ALL=C.UTF-8") ||
		strings.Contains(out.String(), "got-input") {
		t.Fatalf("%q", out.String())
	}
}

func TestOutputCannotDriveTheTerminal(t *testing.T) {
	r := runner(t, fakeBins(t, map[string]string{"journalctl": `printf 'a\033[2Jb\tc\rd\n'`}), nil)
	out, _, _ := run(t, r, "logs")
	if out != "a?[2Jb\tc?d\n" {
		t.Fatalf("%q", out)
	}
}

func TestExitStatusAndMissingBinaries(t *testing.T) {
	bins := fakeBins(t, map[string]string{"systemctl": "exit 3"})
	r := runner(t, bins, nil)
	if _, _, code := run(t, r, "status whombat-x"); code != 3 {
		t.Fatalf("status of an inactive unit: %d", code)
	}
	bins.Journalctl = filepath.Join(t.TempDir(), "nope")
	r = runner(t, bins, nil)
	if _, errs, code := run(t, r, "boots"); code != 127 || !strings.Contains(errs, "can't run nope") {
		t.Fatalf("%d %q", code, errs)
	}
}

func TestFollowRunsUntilTheChannelCloses(t *testing.T) {
	r := runner(t, fakeBins(t, map[string]string{"journalctl": "echo started; exec /bin/sleep 600"}), nil)
	c, err := Parse("logs -f")
	if err != nil || !c.Follow {
		t.Fatalf("%+v %v", c, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	pr, pw := io.Pipe()
	done := make(chan int, 1)
	go func() { done <- r.Run(ctx, c, pw, io.Discard); pw.Close() }()
	line, err := bufio.NewReader(pr).ReadString('\n')
	if err != nil || line != "started\n" {
		t.Fatalf("%q %v", line, err)
	}
	go io.Copy(io.Discard, pr)
	cancel()
	select {
	case code := <-done:
		if code == 0 {
			t.Fatal("a stopped follow says it succeeded")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("follow didn't stop with its channel")
	}
}

func TestTimeoutStopsACommand(t *testing.T) {
	bins := fakeBins(t, map[string]string{"journalctl": "exec /bin/sleep 600"})
	r, err := New(Config{Bins: bins, UID: uint32(os.Getuid()), GID: uint32(os.Getgid()), KeepGroups: true,
		Timeout: 50 * time.Millisecond, Path: "/usr/bin:/bin"})
	if err != nil {
		t.Fatal(err)
	}
	if _, errs, code := run(t, r, "boots"); code != 124 || !strings.Contains(errs, "too long") {
		t.Fatalf("%d %q", code, errs)
	}
}

func TestNewRefusesRootAndRelativeBinaries(t *testing.T) {
	if _, err := New(Config{Bins: DefaultBins(SystemBin), UID: 0, GID: 5}); err == nil {
		t.Fatal("root accepted")
	}
	if _, err := New(Config{Bins: DefaultBins(SystemBin), UID: 5, GID: 0}); err == nil {
		t.Fatal("gid 0 accepted")
	}
	if _, err := New(Config{Bins: DefaultBins("bin"), UID: 5, GID: 5}); err == nil {
		t.Fatal("relative binaries accepted")
	}
}

func TestHelpListsEveryCommand(t *testing.T) {
	h := Help()
	for _, c := range wire.LookCommands {
		if !strings.Contains(h, "\n  "+c+" ") {
			t.Errorf("help lacks %s", c)
		}
	}
}
