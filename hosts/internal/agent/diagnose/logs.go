package diagnose

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
)

// logQuery is a validated "logs" request.
type logQuery struct {
	unit     string
	since    time.Time
	lines    int
	grep     string
	priority string // journalctl's name ("err")
	kernel   bool
}

func planLogs(_ context.Context, d *Diagnostics, a args) ([]step, error) {
	q := logQuery{unit: a["unit"], lines: a.int("lines", 200), grep: a["grep"], priority: a["priority"], kernel: a.has("kernel")}
	if q.unit != "" && q.kernel {
		return nil, invalidf("unit and kernel exclude each other")
	}
	if a.has("since") {
		q.since, _ = time.Parse(time.RFC3339, a["since"])
	}
	if d.journald() {
		return []step{journalStep(q)}, nil
	}
	return []step{d.syslogStep(q)}, nil
}

// journalStep reads the journal. Kernel messages come from the journal
// too (all boots): under the agent's sandbox (ProtectKernelLogs=yes)
// dmesg cannot read the kernel's ring buffer.
func journalStep(q logQuery) step {
	argv := []string{"journalctl", "--no-pager", "--no-hostname", "-o", "short-iso", "-n", strconv.Itoa(q.lines)}
	if q.unit != "" {
		argv = append(argv, "--unit="+q.unit)
	}
	if !q.since.IsZero() {
		argv = append(argv, "--since="+q.since.UTC().Format("2006-01-02 15:04:05")+" UTC")
	}
	if q.grep != "" {
		argv = append(argv, "--grep="+q.grep)
	}
	if q.priority != "" {
		argv = append(argv, "--priority="+q.priority)
	}
	if q.kernel {
		argv = append(argv, "_TRANSPORT=kernel")
	}
	s := cmdStep(argv...)
	// No matching entries is an answer (newer journalctl exit 1 with --grep).
	s.ok = func(exit int, out []byte) bool {
		return exit == 0 || exit == 1 && (len(bytes.TrimSpace(out)) == 0 || bytes.Contains(out, []byte("-- No entries --")))
	}
	return s
}

// syslogFiles are read without journald (Unraid, SysV, OpenRC).
var syslogFiles = []string{"/var/log/syslog", "/var/log/messages"}

// syslogFile returns the most recently written syslog file ("" = none).
func (d *Diagnostics) syslogFile() string {
	best, bestT := "", time.Time{}
	for _, f := range syslogFiles {
		if st, err := os.Stat(d.path(f)); err == nil && st.Mode().IsRegular() && (best == "" || st.ModTime().After(bestT)) {
			best, bestT = f, st.ModTime()
		}
	}
	return best
}

// syslogWindow is how much of the end of a syslog file is searched.
const syslogWindow = 32 << 20

// syslogStep reads the tail of the syslog file in Go: the program's lines
// for a unit, " kernel: " lines for kernel, grep as a regular expression
// (case-insensitive without capitals, like journalctl), since by the
// lines' timestamps. Syslog files have no priorities.
func (d *Diagnostics) syslogStep(q logQuery) step {
	file := d.syslogFile()
	var what []string
	if q.unit != "" {
		what = append(what, "of "+strings.TrimSuffix(q.unit, ".service"))
	}
	if q.kernel {
		what = append(what, "of the kernel")
	}
	if q.grep != "" {
		what = append(what, fmt.Sprintf("matching %q", q.grep))
	}
	if !q.since.IsZero() {
		what = append(what, "since "+q.since.In(d.now().Location()).Format("2006-01-02 15:04:05"))
	}
	title := fmt.Sprintf("read %s: the last %d lines", file, q.lines)
	if len(what) > 0 {
		title += " " + strings.Join(what, ", ")
	}
	return step{title: title, fn: func(ctx context.Context) (string, error) {
		if file == "" {
			return "", errors.New("no syslog file")
		}
		keep, err := q.filter(d.now())
		if err != nil {
			return "", err
		}
		lines, partial, err := d.readSyslog(file, keep, q.lines)
		var notes []string
		if q.priority != "" {
			notes = append(notes, "(syslog files do not record priorities: the priority filter was not applied)")
		}
		if partial {
			notes = append(notes, fmt.Sprintf("(only the last %d MiB of %s were searched)", syslogWindow>>20, file))
		}
		if len(lines) == 0 && err == nil {
			lines = []string{"-- No entries --"}
		}
		return strings.Join(append(notes, lines...), "\n") + "\n", err
	}}
}

// filter returns the line filter of a syslog query.
func (q logQuery) filter(now time.Time) (func(string) bool, error) {
	var re *regexp.Regexp
	if q.grep != "" {
		var err error
		if re, err = compileGrep(q.grep); err != nil {
			return nil, err
		}
	}
	unit := strings.TrimSuffix(q.unit, ".service")
	var last time.Time // continuation lines carry the time of the line before
	return func(l string) bool {
		if !q.since.IsZero() {
			if t, ok := syslogTime(l, now); ok {
				last = t
			}
			if last.IsZero() || last.Before(q.since) {
				return false
			}
		}
		if unit != "" && !strings.Contains(l, " "+unit+"[") && !strings.Contains(l, " "+unit+":") {
			return false
		}
		if q.kernel && !strings.Contains(l, " kernel: ") && !strings.Contains(l, " kernel[") {
			return false
		}
		return re == nil || re.MatchString(l)
	}, nil
}

// readSyslog returns the last n lines of the file that keep accepts, from
// at most its last syslogWindow bytes (partial: the file is longer).
func (d *Diagnostics) readSyslog(file string, keep func(string) bool, n int) (lines []string, partial bool, err error) {
	f, err := os.Open(d.path(file))
	if err != nil {
		return nil, false, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, false, err
	}
	if st.Size() > syslogWindow {
		if _, err := f.Seek(st.Size()-syslogWindow, io.SeekStart); err != nil {
			return nil, false, err
		}
		partial = true
	}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	skip := partial // the first line is cut
	for sc.Scan() {
		if skip {
			skip = false
			continue
		}
		l := sc.Text()
		if keep != nil && !keep(l) {
			continue
		}
		lines = append(lines, l)
		if len(lines) >= 2*n+64 {
			lines = append(lines[:0], lines[len(lines)-n:]...)
		}
	}
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return lines, partial, sc.Err()
}

var rfc3164Re = regexp.MustCompile(`^([A-Z][a-z]{2}) {1,2}(\d{1,2}) (\d{2}:\d{2}:\d{2})\b`)

// syslogTime reads a syslog line's timestamp: RFC 3339 (rsyslog's
// precise format) or "Oct 17 10:00:01" (no year: the most recent one).
func syslogTime(l string, now time.Time) (time.Time, bool) {
	if len(l) >= 20 && l[4] == '-' && l[10] == 'T' {
		end := strings.IndexByte(l, ' ')
		if end < 0 {
			end = len(l)
		}
		if t, err := time.Parse(time.RFC3339Nano, l[:end]); err == nil {
			return t, true
		}
	}
	m := rfc3164Re.FindStringSubmatch(l)
	if m == nil {
		return time.Time{}, false
	}
	t, err := time.ParseInLocation("Jan 2 15:04:05 2006", m[1]+" "+m[2]+" "+m[3]+" "+strconv.Itoa(now.Year()), now.Location())
	if err != nil {
		return time.Time{}, false
	}
	if t.After(now.Add(48 * time.Hour)) {
		t = t.AddDate(-1, 0, 0) // December's lines read in January
	}
	return t, true
}

// ---- arguments ----------------------------------------------------------------------

var (
	sinceRe    = regexp.MustCompile(`^[0-9A-Za-z :+\-]{1,40}$`)
	relativeRe = regexp.MustCompile(`^-?\s*(\d{1,6})\s*(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?)(\s+ago)?$`)
)

const sinceHelp = `use a duration ("2h", "30m", "1d"), "today", "yesterday" or a time ("2026-10-17 10:00")`

func parseSinceArg(d *Diagnostics, v string) (string, error) {
	if !sinceRe.MatchString(v) {
		return "", errors.New(sinceHelp)
	}
	t, err := parseSince(v, d.now())
	if err != nil {
		return "", err
	}
	return t.UTC().Format(time.RFC3339), nil
}

// parseSince reads a start time: a duration back from now, today,
// yesterday, a date and time (local unless it has a zone) or a time of
// today.
func parseSince(v string, now time.Time) (time.Time, error) {
	s := strings.ToLower(strings.TrimSpace(v))
	loc := now.Location()
	midnight := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc)
	switch s {
	case "today":
		return midnight, nil
	case "yesterday":
		return midnight.AddDate(0, 0, -1), nil
	case "now":
		return now, nil
	}
	if m := relativeRe.FindStringSubmatch(s); m != nil {
		n, _ := strconv.Atoi(m[1])
		unit := time.Second
		switch m[2][0] {
		case 'm':
			unit = time.Minute
		case 'h':
			unit = time.Hour
		case 'd':
			unit = 24 * time.Hour
		case 'w':
			unit = 7 * 24 * time.Hour
		}
		return now.Add(-time.Duration(n) * unit), nil
	}
	v = strings.TrimSpace(v)
	for _, layout := range []string{time.RFC3339, "2006-01-02 15:04:05Z07:00", "2006-01-02T15:04Z07:00", "2006-01-02 15:04Z07:00"} {
		if t, err := time.Parse(layout, v); err == nil {
			return t, nil
		}
	}
	for _, layout := range []string{"2006-01-02 15:04:05", "2006-01-02 15:04", "2006-01-02T15:04:05", "2006-01-02T15:04", "2006-01-02"} {
		if t, err := time.ParseInLocation(layout, v, loc); err == nil {
			return t, nil
		}
	}
	for _, layout := range []string{"15:04:05", "15:04"} {
		if t, err := time.ParseInLocation(layout, v, loc); err == nil {
			return midnight.Add(time.Duration(t.Hour())*time.Hour + time.Duration(t.Minute())*time.Minute + time.Duration(t.Second())*time.Second), nil
		}
	}
	return time.Time{}, errors.New(sinceHelp)
}

// parseGrep accepts a pattern of at most 200 characters. journalctl gets
// it as one argument; for the syslog files it must be a valid (Go)
// regular expression.
func parseGrep(d *Diagnostics, v string) (string, error) {
	if len(v) > 200 {
		return "", errors.New("at most 200 characters")
	}
	if !d.journald() {
		if _, err := compileGrep(v); err != nil {
			return "", err
		}
	}
	return v, nil
}

// compileGrep compiles a pattern case-insensitively unless it has capitals
// (journalctl's rule).
func compileGrep(p string) (*regexp.Regexp, error) {
	expr := p
	if !strings.ContainsFunc(p, unicode.IsUpper) {
		expr = "(?i)" + p
	}
	re, err := regexp.Compile(expr)
	if err != nil {
		return nil, fmt.Errorf("not a valid regular expression: %v", strings.TrimPrefix(err.Error(), "error parsing regexp: "))
	}
	return re, nil
}

var priorities = map[string]string{
	"0": "emerg", "emerg": "emerg", "emergency": "emerg", "panic": "emerg",
	"1": "alert", "alert": "alert",
	"2": "crit", "crit": "crit", "critical": "crit",
	"3": "err", "err": "err", "error": "err",
	"4": "warning", "warning": "warning", "warn": "warning",
	"5": "notice", "notice": "notice",
	"6": "info", "info": "info",
	"7": "debug", "debug": "debug",
}

func parsePriority(_ *Diagnostics, v string) (string, error) {
	if p, ok := priorities[strings.ToLower(v)]; ok {
		return p, nil
	}
	return "", errors.New("0-7 or emerg, alert, crit, err, warning, notice, info, debug")
}
