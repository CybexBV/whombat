package diagnose

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"rackoon/internal/agent/services"
	"rackoon/internal/proto"
)

// unraidLogs is a host without journald: logs come from /var/log/syslog.
func unraidLogs(t *testing.T) *Diagnostics {
	d, _ := testDiag(t, "testdata/unraid")
	d.initSystem = services.Unraid
	return d
}

func logLines(t *testing.T, d *Diagnostics, a map[string]string) (proto.DiagnoseResponse, []string) {
	t.Helper()
	r := d.Run(context.Background(), proto.DiagnoseRequest{Check: "logs", Args: a})
	if r.Code != "" {
		t.Fatalf("logs %v: %+v", a, r)
	}
	return r, strings.Split(strings.TrimRight(r.Output, "\n"), "\n")
}

func TestSyslogFallback(t *testing.T) {
	d := unraidLogs(t)
	r, lines := logLines(t, d, map[string]string{"grep": "error", "lines": "2"})
	if len(lines) != 2 || !strings.Contains(lines[0], "09:30:00 BlackBox nginx") || !strings.Contains(lines[1], "*91 connect() failed") {
		t.Fatalf("grep error, 2 lines:\n%s", r.Output)
	}
	if r.Commands[0] != `read /var/log/syslog: the last 2 lines matching "error"` {
		t.Fatalf("commands %q", r.Commands)
	}
	// Capitals make it case-sensitive, like journalctl.
	if _, lines := logLines(t, d, map[string]string{"grep": "SMART|READ DMA"}); len(lines) != 2 {
		t.Fatalf("case-sensitive grep: %q", lines)
	}
	if _, lines := logLines(t, d, map[string]string{"unit": "nginx.service"}); len(lines) != 2 || !strings.Contains(lines[0], "nginx:") {
		t.Fatalf("unit nginx: %q", lines)
	}
	if _, lines := logLines(t, d, map[string]string{"unit": "sshd"}); len(lines) != 1 || !strings.Contains(lines[0], "sshd[20011]") {
		t.Fatalf("unit sshd: %q", lines)
	}
	if _, lines := logLines(t, d, map[string]string{"kernel": "yes", "grep": "md"}); len(lines) != 3 || !strings.Contains(lines[0], "md: disk2") {
		t.Fatalf("kernel md: %q", lines)
	}
	// since: today at 10:00 (the test's clock is 12:00 UTC).
	if _, lines := logLines(t, d, map[string]string{"since": "10:00", "grep": "error"}); len(lines) != 1 || !strings.Contains(lines[0], "10:07:30") {
		t.Fatalf("since 10:00: %q", lines)
	}
	if _, lines := logLines(t, d, map[string]string{"since": "1h", "lines": "200"}); len(lines) != 0+1 || lines[0] != "-- No entries --" {
		t.Fatalf("since 1h: %q", lines)
	}
	r, lines = logLines(t, d, map[string]string{"priority": "err", "lines": "1"})
	if len(lines) != 2 || !strings.Contains(lines[0], "priority filter was not applied") {
		t.Fatalf("priority note: %q", lines)
	}
	// Invalid regular expressions are refused for syslog files.
	if r := d.Run(context.Background(), proto.DiagnoseRequest{Check: "logs", Args: map[string]string{"grep": "(unclosed"}}); r.Code != CodeInvalid || !strings.Contains(r.Message, "regular expression") {
		t.Fatalf("invalid regexp: %+v", r)
	}
}

func TestSyslogTail(t *testing.T) {
	root := t.TempDir()
	f := filepath.Join(root, "var/log/messages")
	os.MkdirAll(filepath.Dir(f), 0o755)
	var b strings.Builder
	for i := 0; i < 5000; i++ {
		b.WriteString("2026-10-17T10:00:00.000000+00:00 host app[1]: message ")
		b.WriteString(strings.Repeat("x", i%7))
		b.WriteString("\n")
	}
	os.WriteFile(f, []byte(b.String()), 0o644)
	d, _ := testDiag(t, root)
	lines, partial, err := d.readSyslog("/var/log/messages", nil, 3)
	if err != nil || partial || len(lines) != 3 || !strings.HasSuffix(lines[2], "message "+strings.Repeat("x", 4999%7)) {
		t.Fatalf("tail: %q %v %v", lines, partial, err)
	}
	// RFC 3339 timestamps work for since.
	_, got := logLines(t, d, map[string]string{"since": "11:00"})
	if len(got) != 1 || got[0] != "-- No entries --" {
		t.Fatalf("since 11:00: %q", got)
	}
	_, got = logLines(t, d, map[string]string{"since": "2026-10-17 09:59", "lines": "7"})
	if len(got) != 7 {
		t.Fatalf("since 09:59: %d lines", len(got))
	}
}

func TestSyslogTime(t *testing.T) {
	now := time.Date(2027, 1, 2, 10, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		line string
		want time.Time
	}{
		{"Jan  2 09:00:00 host x: y", time.Date(2027, 1, 2, 9, 0, 0, 0, time.UTC)},
		{"Dec 31 23:59:59 host x: y", time.Date(2026, 12, 31, 23, 59, 59, 0, time.UTC)},
		{"2027-01-02T08:00:00.123+02:00 host x: y", time.Date(2027, 1, 2, 6, 0, 0, 123e6, time.UTC)},
	} {
		got, ok := syslogTime(tc.line, now)
		if !ok || !got.Equal(tc.want) {
			t.Errorf("%q: %v %v", tc.line, got, ok)
		}
	}
	if _, ok := syslogTime("    continuation", now); ok {
		t.Error("continuation line has a time")
	}
}

func TestParseSince(t *testing.T) {
	now := time.Date(2026, 10, 17, 12, 30, 0, 0, time.UTC)
	for in, want := range map[string]time.Time{
		"2h":                        now.Add(-2 * time.Hour),
		"-30m":                      now.Add(-30 * time.Minute),
		"90 min":                    now.Add(-90 * time.Minute),
		"1d":                        now.Add(-24 * time.Hour),
		"2 hours ago":               now.Add(-2 * time.Hour),
		"1w":                        now.Add(-7 * 24 * time.Hour),
		"today":                     time.Date(2026, 10, 17, 0, 0, 0, 0, time.UTC),
		"Yesterday":                 time.Date(2026, 10, 16, 0, 0, 0, 0, time.UTC),
		"2026-10-17 10:00":          time.Date(2026, 10, 17, 10, 0, 0, 0, time.UTC),
		"2026-10-16":                time.Date(2026, 10, 16, 0, 0, 0, 0, time.UTC),
		"2026-10-17T10:00:05+02:00": time.Date(2026, 10, 17, 8, 0, 5, 0, time.UTC),
		"08:15":                     time.Date(2026, 10, 17, 8, 15, 0, 0, time.UTC),
	} {
		got, err := parseSince(in, now)
		if err != nil || !got.Equal(want) {
			t.Errorf("%q: %v %v (want %v)", in, got, err, want)
		}
	}
	for _, in := range []string{"soon", "2 fortnights", "2026-13-01", "25:00"} {
		if _, err := parseSince(in, now); err == nil {
			t.Errorf("%q accepted", in)
		}
	}
}

func TestJournalKernelAndNoMatches(t *testing.T) {
	d, f := testDiag(t, t.TempDir(), "journalctl")
	d.initSystem = services.Systemd
	f.prefix["journalctl "] = runResult{out: []byte("-- No entries --\n"), exit: 1}
	r := d.Run(context.Background(), proto.DiagnoseRequest{Check: "logs", Args: map[string]string{"kernel": "true", "grep": "oom"}})
	if r.Code != "" {
		t.Fatalf("no entries is an answer: %+v", r)
	}
	if got := f.called()[0]; got != "journalctl --no-pager --no-hostname -o short-iso -n 200 --grep=oom _TRANSPORT=kernel" {
		t.Fatalf("argv %q", got)
	}
	// The journal is case-insensitive PCRE: Go's syntax is not imposed.
	if r := d.Run(context.Background(), proto.DiagnoseRequest{Check: "logs", Args: map[string]string{"grep": "(?<=foo)bar"}}); r.Code == CodeInvalid {
		t.Fatalf("PCRE refused for journalctl: %+v", r)
	}
}
