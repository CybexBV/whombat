// Package speech holds the text rules of the voice service (NX-177): what may be spoken, and what a transcript may say.
package speech

import (
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/CybexBV/whombat/contracts/go/local"
)

// MaxTranscript is the longest transcript, in code points (VoiceSttAnswer.text, the desk's question).
const MaxTranscript = local.DeskQuestionMax

// Line makes s one line of plain text: line breaks, tabs and other spaces become one space; control and format
// characters (C0, DEL, C1, bidi overrides, zero-width joiners) and invalid UTF-8 go; the ends are trimmed. The same
// rule the console uses for what it shows (console/internal/screen.CleanName), plus the spaces folded.
func Line(s string) string {
	var b strings.Builder
	space := false
	for _, r := range s {
		switch {
		case unicode.IsSpace(r) || unicode.In(r, unicode.Zl, unicode.Zp):
			space = b.Len() > 0
			continue
		case r == utf8.RuneError || unicode.IsControl(r) || unicode.Is(unicode.Cf, r):
			continue
		}
		if space {
			b.WriteByte(' ')
			space = false
		}
		b.WriteRune(r)
	}
	return b.String()
}

// Cut shortens s to at most n code points, at the last space when there is one in the second half.
func Cut(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	r = r[:n]
	if i := strings.LastIndexByte(string(r), ' '); i >= len(string(r))/2 {
		return strings.TrimSpace(string(r)[:i])
	}
	return strings.TrimSpace(string(r))
}

// whisper.cpp marks what isn't speech in brackets or parentheses, as a whole segment: “[BLANK_AUDIO]”, “[ Silence ]”,
// “(upbeat music)”, “*coughs*”, “♪”.
var (
	bracketed = regexp.MustCompile(`\[[^\]]*\]`)
	nonSpeech = regexp.MustCompile(`^(?:\([^)]*\)|\*[^*]*\*|[♪♫\s.…-]*)$`)
)

// Transcript is whisper-cli's output (one segment per line, no timestamps) as the desk's answer: Clean, at most
// MaxTranscript code points.
func Transcript(out string) string { return Cut(Clean(out), MaxTranscript) }

// Clean is a program's output (one segment per line, no timestamps) as one line of text: the non-speech marks gone.
// Empty when nothing was said.
func Clean(out string) string {
	var parts []string
	for _, seg := range strings.Split(bracketed.ReplaceAllString(out, " "), "\n") {
		seg = Line(seg)
		if seg == "" || nonSpeech.MatchString(seg) {
			continue
		}
		parts = append(parts, seg)
	}
	return strings.Join(parts, " ")
}

// Parts cuts one line of text into at most count parts of at most n code points each, at spaces where it can (a word
// longer than n is cut where it must): joined with a space they are the text, up to what count parts hold
// (VoiceTranscribeAnswer.parts).
func Parts(text string, n, count int) []string {
	var out []string
	for text = strings.TrimSpace(text); text != "" && len(out) < count; {
		part := Cut(text, n)
		if part == "" {
			part = string([]rune(text)[:n])
		}
		out = append(out, part)
		text = strings.TrimSpace(text[len(part):])
	}
	return out
}
