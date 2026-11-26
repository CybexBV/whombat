package local

import (
	"errors"
	"io"
	"regexp"
	"strings"

	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// Remote help (0.120, CT-930…CT-942; Whombat docs/decisions/remote-help.md): the help code, who visits, durations and
// the checks one schema can't make, like the helpers of @whombat/core/domain and @whombat/control-contracts/local.

var helpCodeRe = regexp.MustCompile(`^[0-9A-HJKMNP-TV-Z]{6}$`)

// isHelpCodeSeparator reports the characters a help code may be typed with that aren't part of it: space, tab,
// no-break space, "·", ".", "-", the Unicode hyphens and dashes (U+2010…U+2015) and the minus sign.
func isHelpCodeSeparator(r rune) bool {
	switch r {
	case ' ', '\t', ' ', '·', '.', '-', '−':
		return true
	}
	return r >= '‐' && r <= '―'
}

// NormalizeHelpCode reads what someone typed as a help code (CT-930), like normalizeHelpCode in @whombat/core/domain:
// the separators dropped, ASCII letters upper-cased, O read as 0 and I and L as 1. ok is false when that isn't six
// characters of HelpCodeAlphabet. Compare the result with the grant's code in constant time
// (crypto/subtle.ConstantTimeCompare), and never log either.
func NormalizeHelpCode(input string) (code string, ok bool) {
	var b strings.Builder
	for _, r := range input {
		if isHelpCodeSeparator(r) {
			continue
		}
		if r >= 'a' && r <= 'z' {
			r -= 'a' - 'A'
		}
		switch r {
		case 'O':
			r = '0'
		case 'I', 'L':
			r = '1'
		}
		b.WriteRune(r)
		if b.Len() > HelpCodeLength {
			return "", false
		}
	}
	code = b.String()
	if !helpCodeRe.MatchString(code) {
		return "", false
	}
	return code, true
}

// FormatHelpCode shows a help code as people read it, "KQ72MX" → "KQ7·2MX", like formatHelpCode. Anything that isn't
// a help code stays as it is.
func FormatHelpCode(code string) string {
	if !helpCodeRe.MatchString(code) {
		return code
	}
	return code[:3] + "·" + code[3:]
}

// HelpCodeFromBytes makes a help code from six random bytes, each by its low 5 bits (unbiased: the alphabet has 32
// characters), like helpCodeFromBytes.
func HelpCodeFromBytes(b []byte) (string, error) {
	if len(b) < HelpCodeLength {
		return "", errors.New("help code: need 6 bytes")
	}
	out := make([]byte, HelpCodeLength)
	for i := range out {
		out[i] = HelpCodeAlphabet[b[i]&31]
	}
	return string(out), nil
}

// GenerateHelpCode makes a new help code from r (crypto/rand.Reader).
func GenerateHelpCode(r io.Reader) (string, error) {
	b := make([]byte, HelpCodeLength)
	if _, err := io.ReadFull(r, b); err != nil {
		return "", err
	}
	return HelpCodeFromBytes(b)
}

// RemoteHelpWho names a visitor from their certificate's key id (CT-931), like remoteHelpWho: the name before a
// trailing " (…)" — control writes "Claude (op_7Hq2 via john)" — as display text of at most RemoteHelpNameChars code
// points, "Someone" when nothing is left. Show and record only this, never the ids.
func RemoteHelpWho(keyID string) string {
	name := keyID
	if strings.HasSuffix(keyID, ")") {
		if i := strings.LastIndex(keyID, " ("); i >= 0 {
			name = keyID[:i]
		}
	}
	if who := HostText(name, RemoteHelpNameChars); who != "" {
		return who
	}
	return "Someone"
}

// RemoteHelpDurationSeconds gives a duration's seconds (CT-930), like remoteHelpDurationSeconds: nil for forever. ok is
// false for a value this package doesn't know.
func RemoteHelpDurationSeconds(d protocol.RemoteHelpDuration) (seconds *int64, ok bool) {
	var s int64
	switch d {
	case protocol.RemoteHelpDurationHour:
		s = RemoteHelpDurationHourS
	case protocol.RemoteHelpDurationDay:
		s = RemoteHelpDurationDayS
	case protocol.RemoteHelpDurationWeek:
		s = RemoteHelpDurationWeekS
	case protocol.RemoteHelpDurationForever:
		return nil, true
	default:
		return nil, false
	}
	return &s, true
}

// RemoteHelpStepValid reports whether a step is consistent (CT-932), like remoteHelpStepValid in
// @whombat/protocol/session: a look names its command and only logs names units; an exec has its line, a shell its
// seconds, a restart exactly one unit, a forward its target, a refused its reason; bytes only on a forward. Validate
// the JSON first.
func RemoteHelpStepValid(s protocol.RemoteHelpStep) bool {
	if s.Bytes != nil && s.Kind != protocol.RemoteHelpStepKindForward {
		return false
	}
	switch s.Kind {
	case protocol.RemoteHelpStepKindLook:
		return s.Command != nil && (len(s.Units) == 0 || *s.Command == protocol.LookCommandLogs)
	case protocol.RemoteHelpStepKindExec:
		return s.Line != nil
	case protocol.RemoteHelpStepKindShell:
		return s.Seconds != nil
	case protocol.RemoteHelpStepKindRestart:
		return len(s.Units) == 1
	case protocol.RemoteHelpStepKindForward:
		return s.Target != nil
	case protocol.RemoteHelpStepKindRefused:
		return s.Reason != nil
	}
	return true
}

// SupportStateValid reports whether the support socket's state is consistent (CT-939), like supportStateValid: on prod
// exactly a help code required, otherwise none and Forever allowed (a prod box root marked as a maintainer's test
// Whombat allows Forever too, RH-17); nobody connected without a grant; a grant only where
// available; a help code exactly when required; Forever only where allowed; each visit connected once. Validate the
// JSON first.
func SupportStateValid(s SupportState) bool {
	prod := s.Environment == SupportEnvironmentProd
	if s.HelpCodeRequired != prod || (!prod && !s.ForeverAllowed) {
		return false
	}
	seen := make(map[string]bool, len(s.Connected))
	for _, c := range s.Connected {
		if seen[c.VisitID] {
			return false
		}
		seen[c.VisitID] = true
	}
	if s.Grant == nil {
		return len(s.Connected) == 0
	}
	if !s.Available || (s.Grant.HelpCode != nil) != s.HelpCodeRequired {
		return false
	}
	return s.Grant.Until != nil || s.ForeverAllowed
}

// SupportEventValid reports whether an event carries exactly its members (CT-941), like supportEventValid: a grant its
// level, duration and by; a stop its reason (owner with by, or desk without); a visit_start its visitId, who and level,
// a visit_end also startedAt and steps. Validate the JSON first.
func SupportEventValid(e SupportEvent) bool {
	if (e.Duration != nil) != (e.Kind == SupportEventKindGrant) {
		return false
	}
	if (e.Reason != nil) != (e.Kind == SupportEventKindStop) {
		return false
	}
	if (e.StartedAt != nil || e.Steps != nil) && e.Kind != SupportEventKindVisitEnd {
		return false
	}
	switch e.Kind {
	case SupportEventKindGrant:
		return e.Level != nil && e.By != nil
	case SupportEventKindStop:
		switch *e.Reason {
		case protocol.RemoteHelpOffReasonDesk:
			return e.By == nil
		case protocol.RemoteHelpOffReasonOwner:
			return e.By != nil
		}
		return false
	case SupportEventKindVisitStart, SupportEventKindVisitEnd:
		if e.VisitID == nil || e.Who == nil || e.Level == nil {
			return false
		}
		return e.Kind == SupportEventKindVisitStart || (e.StartedAt != nil && e.Steps != nil)
	}
	return true
}
