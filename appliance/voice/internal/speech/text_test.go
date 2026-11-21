package speech

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestLine(t *testing.T) {
	cases := map[string]string{
		"  pve-02 is fine.\n\nIts disks are healthy.\t ": "pve-02 is fine. Its disks are healthy.",
		"Restart\u202ePlex\u200d":                        "RestartPlex",
		"a\x1b[2Jb\x00c\x7f":                             "a[2Jbc",
		"one\u2028two\u00a0three":                        "one two three",
		"I’m “here” · 3 °C − 2 €":                        "I’m “here” · 3 °C − 2 €",
		"\xff\xfe":                                       "",
	}
	for in, want := range cases {
		if got := Line(in); got != want {
			t.Errorf("Line(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestCut(t *testing.T) {
	if Cut("short", 10) != "short" {
		t.Fatal("cut a short text")
	}
	if got := Cut("the quick brown fox jumps", 18); got != "the quick brown" {
		t.Fatalf("%q", got)
	}
	long := strings.Repeat("ä", 700)
	if got := Cut(long, 600); utf8.RuneCountInString(got) != 600 {
		t.Fatalf("%d code points", utf8.RuneCountInString(got))
	}
}

func TestTranscript(t *testing.T) {
	cases := map[string]string{
		" Is pve-02 okay?\n":                       "Is pve-02 okay?",
		" Restart Plex\n and the NAS.\n":           "Restart Plex and the NAS.",
		"[BLANK_AUDIO]\n":                          "",
		" [ Silence ]\n (upbeat music)\n *coughs*": "",
		" ♪ ♪\n":                                   "",
		" Is the [inaudible] server up?":           "Is the server up?",
		" (Is this a question?) maybe":             "(Is this a question?) maybe",
		"":                                         "",
	}
	for in, want := range cases {
		if got := Transcript(in); got != want {
			t.Errorf("Transcript(%q) = %q, want %q", in, got, want)
		}
	}
	if n := utf8.RuneCountInString(Transcript(strings.Repeat("word ", 200))); n > MaxTranscript {
		t.Fatalf("%d code points", n)
	}
}

func TestParts(t *testing.T) {
	text := strings.TrimSpace(strings.Repeat("één twee drie ", 200))
	// Longer than twelve parts hold: twelve, each a prefix of what is left.
	parts := Parts(text, 100, 12)
	if len(parts) != 12 || !strings.HasPrefix(text, strings.Join(parts, " ")) {
		t.Fatalf("%d parts", len(parts))
	}
	for _, p := range parts {
		if n := len([]rune(p)); n > 100 || n == 0 || strings.HasPrefix(p, " ") || strings.HasSuffix(p, " ") {
			t.Fatalf("part %q", p)
		}
	}
	short := Parts("Varkens dragen de ziekte bij zich.", 1000, 12)
	if len(short) != 1 || short[0] != "Varkens dragen de ziekte bij zich." {
		t.Fatal(short)
	}
	if got := Parts(strings.Repeat("x", 250), 100, 12); len(got) != 3 || strings.Join(got, "") != strings.Repeat("x", 250) {
		t.Fatal(got)
	}
	if got := Parts("  ", 100, 12); len(got) != 0 {
		t.Fatal(got)
	}
	whole := strings.TrimSpace(strings.Repeat("een twee ", 50))
	if got := strings.Join(Parts(whole, 100, 12), " "); got != whole {
		t.Fatalf("%q", got)
	}
}
