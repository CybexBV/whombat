package hub

import (
	"context"
	"io"
	"log/slog"
	"regexp"
	"strings"
)

// Redacted replaces secret values in logs.
const Redacted = "[REDACTED]"

// secretKey matches attribute keys that carry secrets.
var secretKey = regexp.MustCompile(`(?i)(token|secret|password|passwd|cookie|authorization|csrf|csr|private|ticket|session_id_hash|credential)`)

// secretValue matches secret-looking substrings in free text.
var secretValue = regexp.MustCompile(`(?i)(rackoon\.token\.)[A-Za-z0-9_\-]+|(bearer\s+)[A-Za-z0-9._\-]+|(token=)[^&\s]+|(rackoon_session=)[^;\s]+`)

// RedactString removes secret-looking substrings.
func RedactString(s string) string {
	return secretValue.ReplaceAllStringFunc(s, func(m string) string {
		sub := secretValue.FindStringSubmatch(m)
		for _, p := range sub[1:] {
			if p != "" {
				return p + Redacted
			}
		}
		return Redacted
	})
}

func redactAttr(groups []string, a slog.Attr) slog.Attr {
	if secretKey.MatchString(a.Key) {
		return slog.String(a.Key, Redacted)
	}
	switch a.Value.Kind() {
	case slog.KindString:
		if s := a.Value.String(); strings.ContainsAny(s, "=.") || strings.Contains(strings.ToLower(s), "bearer") {
			return slog.String(a.Key, RedactString(s))
		}
	case slog.KindAny:
		if err, ok := a.Value.Any().(error); ok {
			return slog.String(a.Key, RedactString(err.Error()))
		}
	}
	return a
}

// NewLogger returns a structured logger (text or JSON) that redacts secrets
// by attribute key and by value pattern.
func NewLogger(w io.Writer, level slog.Level, json bool) *slog.Logger {
	opts := &slog.HandlerOptions{Level: level, ReplaceAttr: redactAttr}
	var h slog.Handler
	if json {
		h = slog.NewJSONHandler(w, opts)
	} else {
		h = slog.NewTextHandler(w, opts)
	}
	return slog.New(&msgRedactor{h})
}

// msgRedactor also redacts the log message itself.
type msgRedactor struct{ slog.Handler }

func (m *msgRedactor) Handle(ctx context.Context, r slog.Record) error {
	if strings.ContainsAny(r.Message, "=.") {
		nr := slog.NewRecord(r.Time, r.Level, RedactString(r.Message), r.PC)
		r.Attrs(func(a slog.Attr) bool { nr.AddAttrs(a); return true })
		r = nr
	}
	return m.Handler.Handle(ctx, r)
}

func (m *msgRedactor) WithAttrs(as []slog.Attr) slog.Handler {
	return &msgRedactor{m.Handler.WithAttrs(as)}
}

func (m *msgRedactor) WithGroup(name string) slog.Handler {
	return &msgRedactor{m.Handler.WithGroup(name)}
}
