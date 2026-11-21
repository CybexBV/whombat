package screen

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// X11 keysyms, as RFB key events carry them.
const (
	ksBackSpace = 0xff08
	ksTab       = 0xff09
	ksReturn    = 0xff0d
	ksEscape    = 0xff1b
	ksHome      = 0xff50
	ksLeft      = 0xff51
	ksUp        = 0xff52
	ksRight     = 0xff53
	ksDown      = 0xff54
	ksPageUp    = 0xff55
	ksPageDown  = 0xff56
	ksEnd       = 0xff57
	ksF1        = 0xffbe
	ksShiftL    = 0xffe1
	ksControlL  = 0xffe3
	ksAltL      = 0xffe9
	ksSuperL    = 0xffeb
	ksDelete    = 0xffff
)

// commandSym is the keysym macOS Screen Sharing turns into the Command key:
// Super_L (Meta_L types the plain letter).
const commandSym = ksSuperL

// keyEvent is one RFB key press or release.
type keyEvent struct {
	sym  uint32
	down bool
}

var namedKeys = map[string]uint32{
	"return": ksReturn, "enter": ksReturn,
	"tab": ksTab,
	"esc": ksEscape, "escape": ksEscape,
	"space":  ' ',
	"delete": ksBackSpace, "backspace": ksBackSpace,
	"forwarddelete": ksDelete, "fwddelete": ksDelete, "del": ksDelete,
	"up": ksUp, "down": ksDown, "left": ksLeft, "right": ksRight,
	"home": ksHome, "end": ksEnd, "pageup": ksPageUp, "pagedown": ksPageDown,
	"plus": '+', "minus": '-',
}

// modifierSym is the keysym of a modifier's name.
func modifierSym(name string) (uint32, bool) {
	switch name {
	case "cmd", "command":
		return commandSym, true
	case "opt", "option", "alt":
		return ksAltL, true
	case "ctrl", "control":
		return ksControlL, true
	case "shift":
		return ksShiftL, true
	}
	return 0, false
}

// maxChords bounds one keys request ("tab tab tab …").
const maxChords = 50

// parseKeys turns "cmd+q", "cmd+shift+4", "tab tab space" into key events:
// each chord presses its modifiers in order, the key, and releases them in
// reverse.
func parseKeys(s string) ([][]keyEvent, error) {
	fields := strings.Fields(s)
	if len(fields) == 0 {
		return nil, errors.New("name the keys, for example cmd+q or return")
	}
	if len(fields) > maxChords {
		return nil, fmt.Errorf("at most %d key presses at once", maxChords)
	}
	var out [][]keyEvent
	for _, f := range fields {
		parts := strings.Split(strings.ToLower(f), "+")
		var mods []uint32
		for _, p := range parts[:len(parts)-1] {
			if p == "fn" {
				return nil, errors.New("fn can't be pressed through Screen Sharing")
			}
			m, ok := modifierSym(p)
			if !ok {
				return nil, fmt.Errorf("%q is not a modifier (cmd, opt, ctrl, shift)", p)
			}
			mods = append(mods, m)
		}
		last := parts[len(parts)-1]
		sym, err := keySym(last)
		if err != nil {
			return nil, err
		}
		var ev []keyEvent
		for _, m := range mods {
			ev = append(ev, keyEvent{m, true})
		}
		ev = append(ev, keyEvent{sym, true}, keyEvent{sym, false})
		for i := len(mods) - 1; i >= 0; i-- {
			ev = append(ev, keyEvent{mods[i], false})
		}
		out = append(out, ev)
	}
	return out, nil
}

// keySym is one key of a chord: a name, f1…f20, a modifier pressed alone,
// or one character.
func keySym(k string) (uint32, error) {
	if k == "" {
		return 0, errors.New("a key is missing after +")
	}
	if s, ok := namedKeys[k]; ok {
		return s, nil
	}
	if m, ok := modifierSym(k); ok {
		return m, nil
	}
	if len(k) >= 2 && k[0] == 'f' {
		if n, err := strconv.Atoi(k[1:]); err == nil && n >= 1 && n <= 20 {
			return ksF1 + uint32(n-1), nil
		}
	}
	if utf8.RuneCountInString(k) == 1 {
		r, _ := utf8.DecodeRuneInString(k)
		if unicode.IsPrint(r) {
			return runeSym(r), nil
		}
	}
	return 0, fmt.Errorf("%q is not a key (return, tab, esc, space, delete, arrows, f1…f12, home, end, pageup, pagedown, or one character)", k)
}

// runeSym is the keysym of a printable character: ASCII and Latin-1 are
// their own keysyms, everything else a Unicode keysym. Screen Sharing types
// them as they are with any input source (tried with Dutch: ä, é, Ä, €, ✓,
// 日本, curly quotes).
func runeSym(r rune) uint32 {
	if (r >= 0x20 && r <= 0x7e) || (r >= 0xa0 && r <= 0xff) {
		return uint32(r)
	}
	return 0x01000000 | uint32(r)
}

// usShifted are the characters a US keyboard types with Shift; Screen
// Sharing wants Shift held for them, as a viewer would send it.
const usShifted = `~!@#$%^&*()_+{}|:"<>?`

// maxTypeRunes bounds one type request (the step's 25 s).
const maxTypeRunes = 2000

// textEvents turns text into key events: Return for a line break, Tab, and
// Shift held for capitals and shifted symbols. Other control characters are
// left out.
func textEvents(text string) ([][]keyEvent, error) {
	if utf8.RuneCountInString(text) > maxTypeRunes {
		return nil, fmt.Errorf("at most %d characters at once", maxTypeRunes)
	}
	if !utf8.ValidString(text) {
		return nil, errors.New("the text is not valid UTF-8")
	}
	text = strings.ReplaceAll(text, "\r\n", "\n")
	var out [][]keyEvent
	for _, r := range text {
		var sym uint32
		switch {
		case r == '\n' || r == '\r':
			sym = ksReturn
		case r == '\t':
			sym = ksTab
		case unicode.IsControl(r) || !unicode.IsPrint(r) && r != ' ':
			continue
		default:
			sym = runeSym(r)
		}
		shift := r < 0x80 && (r >= 'A' && r <= 'Z' || strings.ContainsRune(usShifted, r))
		var ev []keyEvent
		if shift {
			ev = append(ev, keyEvent{ksShiftL, true})
		}
		ev = append(ev, keyEvent{sym, true}, keyEvent{sym, false})
		if shift {
			ev = append(ev, keyEvent{ksShiftL, false})
		}
		out = append(out, ev)
	}
	return out, nil
}
