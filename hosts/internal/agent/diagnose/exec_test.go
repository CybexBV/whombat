package diagnose

import (
	"context"
	"os"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"rackoon/internal/proto"
)

// The direct path (no systemd) with the real /bin/sh.
func execDiag(t *testing.T) *Diagnostics {
	d, _ := testDiag(t, "")
	d.sandboxed = false
	return d
}

func TestExecRunsAShell(t *testing.T) {
	t.Setenv("RACKOON_LEAK", "agent-env")
	d := execDiag(t)
	r := d.Exec(context.Background(), proto.ExecRequest{Command: "echo out; echo err >&2; echo \"$HOME $LANG ${RACKOON_LEAK:-clean}\"; read x || echo stdin-closed; pwd; exit 3"})
	if r.Code != "" || r.ExitCode != 3 || r.TimedOut || r.Truncated {
		t.Fatalf("exec: %+v", r)
	}
	lines := strings.Split(strings.TrimSpace(r.Output), "\n")
	if len(lines) != 5 || lines[0] != "out" || lines[1] != "err" || lines[2] != "/root C.UTF-8 clean" || lines[3] != "stdin-closed" ||
		(lines[4] != "/root" && lines[4] != "/") {
		t.Fatalf("output %q", lines)
	}
	if r := d.Exec(context.Background(), proto.ExecRequest{Command: "true"}); r.ExitCode != 0 || r.Code != "" {
		t.Fatalf("true: %+v", r)
	}
	if r := d.Exec(context.Background(), proto.ExecRequest{Command: "kill -TERM $$"}); r.ExitCode != 128+15 {
		t.Fatalf("killed by a signal: %+v", r)
	}
}

func TestExecTimeoutKillsTheGroup(t *testing.T) {
	d := execDiag(t)
	start := time.Now()
	r := d.Exec(context.Background(), proto.ExecRequest{Command: "echo started; sleep 30; echo never", TimeoutS: 1})
	if !r.TimedOut || r.Code != "" || strings.Contains(r.Output, "never") || !strings.Contains(r.Output, "started") ||
		!strings.Contains(r.Output, "[stopped after 1 s: the time limit]") {
		t.Fatalf("timeout: %+v", r)
	}
	if el := time.Since(start); el > 5*time.Second || r.DurationMs < 900 {
		t.Fatalf("took %v (reported %d ms)", el, r.DurationMs)
	}

	// What the command leaves in the background ends with it.
	r = d.Exec(context.Background(), proto.ExecRequest{Command: "sleep 30 & echo $!"})
	pid, err := strconv.Atoi(strings.TrimSpace(r.Output))
	if err != nil || r.ExitCode != 0 {
		t.Fatalf("background: %+v", r)
	}
	deadline := time.Now().Add(5 * time.Second)
	for syscall.Kill(pid, 0) == nil {
		if b, _ := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat"); strings.Contains(string(b), ") Z ") {
			break // killed, waiting for its reaper
		}
		if time.Now().After(deadline) {
			syscall.Kill(pid, syscall.SIGKILL)
			t.Fatal("the background sleep survived the command")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestExecOutputAndRefusals(t *testing.T) {
	d := execDiag(t)
	r := d.Exec(context.Background(), proto.ExecRequest{Command: "i=0; while [ $i -lt 20000 ]; do echo line $i of the output; i=$((i+1)); done"})
	if !r.Truncated || len(r.Output) > MaxOutput || !strings.HasSuffix(r.Output, "line 19999 of the output\n") ||
		!strings.HasPrefix(r.Output, "[output cut: only the last 256 KiB are shown]\nline ") {
		t.Fatalf("long output: truncated=%v len=%d", r.Truncated, len(r.Output))
	}
	for _, tc := range []struct{ cmd, msg string }{
		{"  \n", "empty"},
		{strings.Repeat("x", ExecMaxCommand+1), "longer than 16 KiB"},
		{"echo a\x00b", "NUL"},
	} {
		if r := d.Exec(context.Background(), proto.ExecRequest{Command: tc.cmd}); r.Code != CodeInvalid || !strings.Contains(r.Message, tc.msg) {
			t.Errorf("%.20q: %+v", tc.cmd, r)
		}
	}
	d.shell = "/nonexistent/sh"
	if r := d.Exec(context.Background(), proto.ExecRequest{Command: "true"}); r.Code != CodeFailed || r.ExitCode != -1 {
		t.Fatalf("no shell: %+v", r)
	}
}

func TestExecTimeouts(t *testing.T) {
	for in, want := range map[int]time.Duration{0: 120 * time.Second, -5: 120 * time.Second, 30: 30 * time.Second, 1800: 1800 * time.Second, 99999: 1800 * time.Second} {
		if got := ExecTimeout(in); got != want {
			t.Errorf("%d: %v", in, got)
		}
	}
}

func TestExecUnitArgv(t *testing.T) {
	argv := execUnitArgv("/bin/sh", "df -h | sort", 300*time.Second)
	for _, want := range []string{"--quiet", "--wait", "--collect", "--pipe", "--service-type=exec", "--property=KillMode=mixed",
		"--property=RuntimeMaxSec=300s", "--description=Whombat assistant command", "--working-directory=/root",
		"--setenv=HOME=/root", "--setenv=LANG=C.UTF-8", "--setenv=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"} {
		if !slices.Contains(argv, want) {
			t.Errorf("argv lacks %s: %q", want, argv)
		}
	}
	if argv[0] != "/usr/bin/systemd-run" || !slices.Equal(argv[len(argv)-4:], []string{"--", "/bin/sh", "-c", "df -h | sort"}) {
		t.Fatalf("argv %q", argv)
	}
	// systemd would read "${f}" and "$$" in the command itself: each "$" goes doubled.
	argv = execUnitArgv("/bin/sh", `for f in a b; do echo "[${f}] $$"; done`, time.Minute)
	if got := argv[len(argv)-1]; got != `for f in a b; do echo "[$${f}] $$$$"; done` {
		t.Fatalf("command %q", got)
	}
}
