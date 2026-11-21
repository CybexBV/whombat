package collect

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"math"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// fsRoot prefixes absolute paths so tests can point collectors at a fake
// /proc and /sys tree. The zero value means the real root.
type fsRoot string

func (r fsRoot) path(p string) string {
	if r == "" {
		return p
	}
	return filepath.Join(string(r), p)
}

func (r fsRoot) read(p string) ([]byte, error) { return os.ReadFile(r.path(p)) }

func (r fsRoot) readString(p string) string {
	b, err := os.ReadFile(r.path(p))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func (r fsRoot) readInt(p string) (int64, bool) {
	s := r.readString(p)
	if s == "" {
		return 0, false
	}
	v, err := strconv.ParseInt(s, 10, 64)
	return v, err == nil
}

func (r fsRoot) exists(p string) bool {
	_, err := os.Stat(r.path(p))
	return err == nil
}

// ---- small value helpers ----------------------------------------------------

func ptr[T any](v T) *T { return &v }

func round1(f float64) float64 { return math.Round(f*10) / 10 }
func round2(f float64) float64 { return math.Round(f*100) / 100 }

func clamp(f, lo, hi float64) float64 {
	if f < lo {
		return lo
	}
	if f > hi {
		return hi
	}
	return f
}

// rate converts a counter delta into a per-second rate. Counter resets
// (cur < prev) yield nil so the UI shows a dash instead of a spike.
func rate(cur, prev uint64, dt float64) *float64 {
	if dt <= 0 || cur < prev {
		return nil
	}
	return ptr(round1(float64(cur-prev) / dt))
}

// truncate shortens s to at most n runes, appending an ellipsis.
func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}

// ---- external commands -------------------------------------------------------

var extraBinDirs = []string{"/usr/sbin", "/sbin", "/usr/bin", "/bin", "/usr/local/sbin", "/usr/local/bin"}

// lookPath finds a binary in $PATH or the usual sbin directories (the
// agent's PATH under sudo or a minimal unit may lack /usr/sbin).
func lookPath(name string) (string, error) {
	if p, err := exec.LookPath(name); err == nil {
		return p, nil
	}
	for _, d := range extraBinDirs {
		p := filepath.Join(d, name)
		if st, err := os.Stat(p); err == nil && !st.IsDir() && st.Mode()&0o111 != 0 {
			return p, nil
		}
	}
	return "", fmt.Errorf("%s: not found", name)
}

// errNotFound marks a missing external tool.
var errNotFound = errors.New("not found")

// runCmd runs a command with a timeout and returns stdout. A non-zero exit
// status is returned as an error together with the output (smartctl uses
// its exit status as a bit mask, so callers may still use the output).
func runCmd(ctx context.Context, timeout time.Duration, name string, args ...string) ([]byte, error) {
	p, err := lookPath(name)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", name, errNotFound)
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, p, args...)
	cmd.Env = []string{"LC_ALL=C", "PATH=/usr/sbin:/usr/bin:/sbin:/bin"}
	// Kill the whole process group on timeout (helpers smartctl or zpool
	// start), and stop waiting for pipes a stray child keeps open.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = 5 * time.Second
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err = cmd.Run()
	if err != nil {
		if ctx.Err() != nil {
			return stdout.Bytes(), fmt.Errorf("%s: timed out after %s", name, timeout)
		}
		msg := strings.TrimSpace(stderr.String())
		if msg != "" {
			return stdout.Bytes(), fmt.Errorf("%s: %w: %s", name, err, truncate(firstLine(msg), 200))
		}
		return stdout.Bytes(), fmt.Errorf("%s: %w", name, err)
	}
	return stdout.Bytes(), nil
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

// ---- unix-socket HTTP ---------------------------------------------------------

// unixHTTPClient returns an HTTP client that dials the given Unix socket for
// every request (the URL host is ignored).
func unixHTTPClient(socket string, timeout time.Duration) *http.Client {
	tr := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", socket)
		},
		MaxIdleConns:        8,
		MaxIdleConnsPerHost: 8,
		IdleConnTimeout:     60 * time.Second,
		DisableCompression:  true,
	}
	return &http.Client{Transport: tr, Timeout: timeout}
}

// socketExists reports whether path exists and is a Unix socket.
func socketExists(path string) bool {
	st, err := os.Stat(path)
	return err == nil && st.Mode()&os.ModeSocket != 0
}

// ---- line scanning ------------------------------------------------------------

func scanLines(b []byte, fn func(line string)) {
	sc := bufio.NewScanner(bytes.NewReader(b))
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		fn(sc.Text())
	}
}

// parseCPUList parses a Linux CPU list like "0-3,8,10-11" and returns the
// number of CPUs in it.
func parseCPUList(s string) int {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}
	n := 0
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if a, b, ok := strings.Cut(part, "-"); ok {
			lo, err1 := strconv.Atoi(a)
			hi, err2 := strconv.Atoi(b)
			if err1 == nil && err2 == nil && hi >= lo {
				n += hi - lo + 1
			}
			continue
		}
		if _, err := strconv.Atoi(part); err == nil {
			n++
		}
	}
	return n
}

func errorf(format string, a ...any) error { return fmt.Errorf(format, a...) }

// ---- files inside another root -------------------------------------------------

// resolveInRoot resolves rel inside root component by component, treating
// root as "/": absolute symlinks restart at root, ".." never leaves it.
func resolveInRoot(root, rel string) (string, error) {
	parts := strings.Split(rel, "/")
	var cur []string
	links := 0
	for len(parts) > 0 {
		p := parts[0]
		parts = parts[1:]
		switch p {
		case "", ".":
			continue
		case "..":
			if len(cur) > 0 {
				cur = cur[:len(cur)-1]
			}
			continue
		}
		full := filepath.Join(append([]string{root}, append(cur, p)...)...)
		st, err := os.Lstat(full)
		if err != nil {
			return "", err
		}
		if st.Mode()&os.ModeSymlink == 0 {
			cur = append(cur, p)
			continue
		}
		if links++; links > 40 {
			return "", &os.PathError{Op: "resolve", Path: full, Err: unix.ELOOP}
		}
		target, err := os.Readlink(full)
		if err != nil {
			return "", err
		}
		if strings.HasPrefix(target, "/") {
			cur = nil
		}
		parts = append(strings.Split(target, "/"), parts...)
	}
	return filepath.Join(append([]string{root}, cur...)...), nil
}
