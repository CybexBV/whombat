package screen

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func flat(chords [][]keyEvent) []keyEvent {
	var out []keyEvent
	for _, c := range chords {
		out = append(out, c...)
	}
	return out
}

func TestParseKeys(t *testing.T) {
	cases := map[string][]keyEvent{
		"return":              {{ksReturn, true}, {ksReturn, false}},
		"cmd+q":               {{commandSym, true}, {'q', true}, {'q', false}, {commandSym, false}},
		"Command+Option+Esc":  {{commandSym, true}, {ksAltL, true}, {ksEscape, true}, {ksEscape, false}, {ksAltL, false}, {commandSym, false}},
		"ctrl+f2":             {{ksControlL, true}, {ksF1 + 1, true}, {ksF1 + 1, false}, {ksControlL, false}},
		"tab space":           {{ksTab, true}, {ksTab, false}, {' ', true}, {' ', false}},
		"cmd+plus":            {{commandSym, true}, {'+', true}, {'+', false}, {commandSym, false}},
		"shift":               {{ksShiftL, true}, {ksShiftL, false}},
		"pagedown f12 delete": {{ksPageDown, true}, {ksPageDown, false}, {ksF1 + 11, true}, {ksF1 + 11, false}, {ksBackSpace, true}, {ksBackSpace, false}},
		"cmd+é":               {{commandSym, true}, {0xe9, true}, {0xe9, false}, {commandSym, false}},
	}
	for in, want := range cases {
		got, err := parseKeys(in)
		if err != nil || !slices.Equal(flat(got), want) {
			t.Errorf("%q: %v %v", in, flat(got), err)
		}
	}
	for _, bad := range []string{"", "  ", "fn+q", "cmd+", "hyper+q", "f21", "cmd+qq", strings.Repeat("tab ", maxChords+1)} {
		if _, err := parseKeys(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestTextEvents(t *testing.T) {
	got, err := textEvents("aB\r\n\t~€\x07")
	if err != nil {
		t.Fatal(err)
	}
	want := []keyEvent{{'a', true}, {'a', false},
		{ksShiftL, true}, {'B', true}, {'B', false}, {ksShiftL, false},
		{ksReturn, true}, {ksReturn, false}, {ksTab, true}, {ksTab, false},
		{ksShiftL, true}, {'~', true}, {'~', false}, {ksShiftL, false},
		{0x010020ac, true}, {0x010020ac, false}}
	if !slices.Equal(flat(got), want) {
		t.Fatalf("%v", flat(got))
	}
	if _, err := textEvents("\xff"); err == nil {
		t.Fatal("invalid UTF-8 accepted")
	}
}

func TestAccountFile(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "etc")
	if _, err := ReadAccount(dir); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("none stored: %v", err)
	}
	a := Account{User: "alex", Password: `quote " and \ and = and #`}
	if err := writeAccount(dir, a); err != nil {
		t.Fatal(err)
	}
	got, err := ReadAccount(dir)
	if err != nil || got != a {
		t.Fatalf("%+v %v", got, err)
	}
	b, _ := os.ReadFile(filepath.Join(dir, AccountFileName))
	if !strings.Contains(string(b), "user = 'alex'") && !strings.Contains(string(b), `user = "alex"`) {
		t.Fatalf("file %s", b)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("temporary files left: %v", entries)
	}
	os.WriteFile(filepath.Join(dir, AccountFileName), []byte("user = 'alex'\n"), 0o600)
	if _, err := ReadAccount(dir); err == nil {
		t.Fatal("an account without a password must be refused")
	}
	if err := clearAccount(dir); err != nil {
		t.Fatal(err)
	}
	if err := clearAccount(dir); err != nil {
		t.Fatal("clearing twice is fine")
	}
}
