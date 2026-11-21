package fix

import (
	"bufio"
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// buf is a goroutine-safe buffer.
type buf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (b *buf) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.Write(p)
}

func (b *buf) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.String()
}

func bin(t *testing.T, name string) string {
	for _, dir := range []string{"/bin", "/usr/bin"} {
		if p := filepath.Join(dir, name); fileExists(p) {
			return p
		}
	}
	t.Skipf("no %s", name)
	return ""
}

func fileExists(p string) bool { _, err := os.Stat(p); return err == nil }

func runner(t *testing.T, systemctl string) *Runner {
	t.Helper()
	if systemctl == "" {
		systemctl = bin(t, "true")
	}
	r, err := New(Config{Bash: bin(t, "bash"), Sh: bin(t, "sh"), Systemctl: systemctl, Path: "/usr/bin:/bin",
		Home: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestExecOutputGoesToTheChannelAndTheTranscript(t *testing.T) {
	r := runner(t, "")
	var out, errb, tr buf
	code, err := r.Exec(context.Background(), `read pw; echo "out ${#pw}"; echo err >&2; exit 3`,
		IO{In: strings.NewReader("hunter2\n"), Out: &out, Err: &errb, Transcript: &tr}, nil, nil)
	if err != nil || code != 3 {
		t.Fatalf("%d %v", code, err)
	}
	if out.String() != "out 7\n" || errb.String() != "err\n" {
		t.Fatalf("%q %q", out.String(), errb.String())
	}
	if !strings.Contains(tr.String(), "out 7\n") || !strings.Contains(tr.String(), "err\n") ||
		!strings.HasPrefix(tr.String(), "$ read pw;") {
		t.Fatalf("transcript %q", tr.String())
	}
	if strings.Contains(strings.TrimPrefix(tr.String(), "$ "), "hunter2") {
		t.Fatal("typed input is in the transcript")
	}
}

func TestExecEnvironmentIsFixed(t *testing.T) {
	t.Setenv("WHOMBAT_SECRET_FOR_TEST", "s3cret")
	r := runner(t, "")
	var out buf
	if _, err := r.Exec(context.Background(), "env", IO{In: strings.NewReader(""), Out: &out, Err: io.Discard}, nil, nil); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out.String(), "s3cret") || !strings.Contains(out.String(), "USER=root") ||
		!strings.Contains(out.String(), "TERM=dumb") {
		t.Fatalf("%q", out.String())
	}
}

// shell starts a terminal shell and answers a function that types a line once the prompt is back (readline drops
// input typed ahead of it, as on any terminal).
func shell(t *testing.T, r *Runner, tr io.Writer, winch chan Window) (typeLine func(string), lines *bufio.Reader, done chan int) {
	t.Helper()
	in, typed := io.Pipe()
	pr, pw := io.Pipe()
	done = make(chan int, 1)
	go func() {
		code, _ := r.Shell(context.Background(), IO{In: in, Out: pw, Err: pw, Transcript: tr},
			&Term{Name: "xterm", Window: Window{Cols: 100, Rows: 30}}, winch)
		pw.Close()
		done <- code
	}()
	t.Cleanup(func() { typed.Close() })
	lines = bufio.NewReader(pr)
	io.WriteString(typed, "PS1='P''S> '\n")
	waitFor(t, lines, "PS> ")
	return func(l string) { io.WriteString(typed, l+"\n") }, lines, done
}

func TestShellInATerminalKeepsHiddenInputOutOfTheTranscript(t *testing.T) {
	r := runner(t, "")
	var tr buf
	typeLine, lines, done := shell(t, r, &tr, nil)
	typeLine("stty size")
	waitFor(t, lines, "30 100")
	waitFor(t, lines, "PS> ")
	typeLine(`stty -echo; echo "pw-$((1+1))"; read -r pw; stty echo; echo "got ${#pw}"`)
	waitFor(t, lines, "pw-2")
	typeLine("hunter2")
	waitFor(t, lines, "got 7")
	waitFor(t, lines, "PS> ")
	typeLine("exit 5")
	go io.Copy(io.Discard, lines)
	select {
	case code := <-done:
		if code != 5 {
			t.Fatalf("exit %d", code)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("the shell didn't exit")
	}
	if strings.Contains(tr.String(), "hunter2") || !strings.Contains(tr.String(), "got 7") {
		t.Fatalf("transcript %q", tr.String())
	}
}

func TestWindowChangesReachTheTerminal(t *testing.T) {
	r := runner(t, "")
	winch := make(chan Window, 1)
	typeLine, lines, done := shell(t, r, nil, winch)
	typeLine("trap 'echo size $(stty size)' WINCH")
	waitFor(t, lines, "PS> ")
	winch <- Window{Cols: 101, Rows: 31}
	waitFor(t, lines, "size 31 101")
	typeLine("exit")
	go io.Copy(io.Discard, lines)
	<-done
	close(winch)
}

func waitFor(t *testing.T, r *bufio.Reader, want string) {
	t.Helper()
	var seen strings.Builder
	for !strings.Contains(seen.String(), want) {
		b, err := r.ReadByte()
		if err != nil {
			t.Fatalf("waiting for %q: %v; saw %q", want, err, seen.String())
		}
		seen.WriteByte(b)
	}
}

func TestEndingTheChannelKillsTheWholeSession(t *testing.T) {
	r := runner(t, "")
	ctx, cancel := context.WithCancel(context.Background())
	pr, pw := io.Pipe()
	done := make(chan int, 1)
	go func() {
		code, _ := r.Exec(ctx, "sleep 600 & echo $!; wait", IO{In: strings.NewReader(""), Out: pw, Err: io.Discard}, nil, nil)
		done <- code
	}()
	line, err := bufio.NewReader(pr).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	go io.Copy(io.Discard, pr)
	pid, _ := strconv.Atoi(strings.TrimSpace(line))
	sid := sessionOf(t, pid)
	cancel()
	select {
	case code := <-done:
		if code != 130 {
			t.Fatalf("exit %d", code)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the command outlived its channel")
	}
	gone(t, sid)
}

func TestBackgroundJobsDieWithTheirCommand(t *testing.T) {
	r := runner(t, "")
	var out buf
	start := time.Now()
	code, err := r.Exec(context.Background(), "sleep 600 & echo $!", IO{In: strings.NewReader(""), Out: &out, Err: io.Discard}, nil, nil)
	if err != nil || code != 0 {
		t.Fatalf("%d %v", code, err)
	}
	if d := time.Since(start); d > 5*time.Second {
		t.Fatalf("waited %v for a background job", d)
	}
	pid, _ := strconv.Atoi(strings.TrimSpace(out.String()))
	if pid <= 0 {
		t.Fatalf("%q", out.String())
	}
	waitDead(t, pid)
}

func sessionOf(t *testing.T, pid int) int {
	t.Helper()
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		t.Fatal(err)
	}
	f := strings.Fields(string(b[strings.LastIndexByte(string(b), ')')+1:]))
	sid, _ := strconv.Atoi(f[3])
	return sid
}

// gone waits (bounded) until nothing is left alive in session sid.
func gone(t *testing.T, sid int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for len(sessionMembers(sid)) > 0 {
		if time.Now().After(deadline) {
			t.Fatalf("session %d still has %v", sid, sessionMembers(sid))
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func waitDead(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
		if err != nil {
			return
		}
		f := strings.Fields(string(b[strings.LastIndexByte(string(b), ')')+1:]))
		if f[0] == "Z" || f[0] == "X" {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("pid %d is still %s", pid, f[0])
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestRestartRunsSystemctlOnTheUnitOnly(t *testing.T) {
	dir := t.TempDir()
	fake := filepath.Join(dir, "systemctl")
	os.WriteFile(fake, []byte("#!/bin/sh\nprintf '%s|' \"$@\"\n"), 0o755)
	r := runner(t, fake)
	var out, tr buf
	code, err := r.Restart(context.Background(), "whombat-voice.service", IO{In: strings.NewReader(""), Out: &out, Err: io.Discard, Transcript: &tr})
	if err != nil || code != 0 || out.String() != "restart|--|whombat-voice.service|" {
		t.Fatalf("%d %v %q", code, err, out.String())
	}
	if !strings.Contains(tr.String(), "restart|--|whombat-voice.service|") {
		t.Fatalf("transcript %q", tr.String())
	}
	for _, bad := range []string{"-H", "--host=x", "a b", "a;b", "", strings.Repeat("a", 81)} {
		if _, err := r.Restart(context.Background(), bad, IO{In: strings.NewReader(""), Out: io.Discard, Err: io.Discard}); err == nil {
			t.Errorf("restart %q accepted", bad)
		}
	}
}

func TestTermNameIsSanitised(t *testing.T) {
	r := runner(t, "")
	var out buf
	r.Exec(context.Background(), `printf '%s' "$TERM"`, IO{In: strings.NewReader(""), Out: &out, Err: io.Discard},
		&Term{Name: "xterm;rm -rf"}, nil)
	if !strings.Contains(out.String(), "xterm-256color") {
		t.Fatalf("%q", out.String())
	}
}

func TestATranscriptThatFailsNeverStopsTheOutput(t *testing.T) {
	r := runner(t, "")
	var out buf
	code, err := r.Exec(context.Background(), "seq 1 2000", IO{In: strings.NewReader(""), Out: &out, Err: io.Discard,
		Transcript: failing{}}, nil, nil)
	if err != nil || code != 0 || !strings.HasSuffix(out.String(), "2000\n") {
		t.Fatalf("%d %v %d bytes", code, err, len(out.String()))
	}
}

type failing struct{}

func (failing) Write([]byte) (int, error) { return 0, io.ErrShortWrite }
