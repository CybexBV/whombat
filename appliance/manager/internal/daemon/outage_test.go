package daemon_test

import (
	"context"
	"log/slog"
	"strings"
	"sync"
	"testing"
)

// levelLog keeps every record's level and message.
type levelLog struct {
	mu    sync.Mutex
	lines []string
}

func (l *levelLog) Enabled(context.Context, slog.Level) bool { return true }
func (l *levelLog) Handle(_ context.Context, r slog.Record) error {
	l.mu.Lock()
	l.lines = append(l.lines, r.Level.String()+" "+r.Message)
	l.mu.Unlock()
	return nil
}
func (l *levelLog) WithAttrs([]slog.Attr) slog.Handler { return l }
func (l *levelLog) WithGroup(string) slog.Handler      { return l }

func (l *levelLog) has(level, prefix string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, s := range l.lines {
		if strings.HasPrefix(s, level+" "+prefix) {
			return true
		}
	}
	return false
}

func (l *levelLog) dump() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return strings.Join(l.lines, "\n")
}

// MG-62: control answering 503 for a few seconds (its plane restarting) is logged at INFO, not as a warning, and its
// end with how long it lasted.
func TestShortControlOutageIsInfo(t *testing.T) {
	t.Parallel()
	logs := &levelLog{}
	h := newHarness(t, nil, nil)
	h.log = slog.New(logs)
	h.run()
	t.Cleanup(func() { h.stop() })
	fc := h.fc
	h.eventually("a status.report at control", func() bool { return len(fc.StatusReports()) > 0 }, logs.dump)
	fc.SetDown(true)
	refused := fc.RefusedCount()
	h.eventually("polls refused during the outage", func() bool { return fc.RefusedCount() >= refused+3 }, logs.dump)
	fc.SetDown(false)
	h.eventually("control answering again", func() bool { return logs.has("INFO", "control answers again") }, logs.dump)
	if !logs.has("INFO", "control poll failed; the installed release keeps running") {
		t.Fatalf("the outage wasn't logged:\n%s", logs.dump())
	}
	for _, m := range []string{"control poll failed", "status.report failed", "update.progress report failed"} {
		if logs.has("WARN", m) {
			t.Fatalf("a short outage was a warning (%s):\n%s", m, logs.dump())
		}
	}
}
