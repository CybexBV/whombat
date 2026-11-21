package screen

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// parsePlist reads an XML property list: dict → map[string]any, array →
// []any, string, integer (int64), real (float64), true/false, date and data
// (their text).
func parsePlist(r io.Reader) (any, error) {
	d := xml.NewDecoder(r)
	d.Strict = false
	for {
		tok, err := d.Token()
		if err != nil {
			return nil, fmt.Errorf("plist: %w", err)
		}
		if se, ok := tok.(xml.StartElement); ok && se.Name.Local != "plist" {
			return plistValue(d, se, 0)
		}
	}
}

func plistValue(d *xml.Decoder, se xml.StartElement, depth int) (any, error) {
	if depth > 32 {
		return nil, errors.New("plist: nested too deep")
	}
	switch se.Name.Local {
	case "dict":
		m := map[string]any{}
		key := ""
		for {
			tok, err := d.Token()
			if err != nil {
				return nil, err
			}
			switch t := tok.(type) {
			case xml.EndElement:
				return m, nil
			case xml.StartElement:
				if t.Name.Local == "key" {
					if key, err = plistText(d); err != nil {
						return nil, err
					}
					continue
				}
				v, err := plistValue(d, t, depth+1)
				if err != nil {
					return nil, err
				}
				m[key] = v
			}
		}
	case "array":
		var a []any
		for {
			tok, err := d.Token()
			if err != nil {
				return nil, err
			}
			switch t := tok.(type) {
			case xml.EndElement:
				return a, nil
			case xml.StartElement:
				v, err := plistValue(d, t, depth+1)
				if err != nil {
					return nil, err
				}
				a = append(a, v)
			}
		}
	case "true", "false":
		if err := d.Skip(); err != nil {
			return nil, err
		}
		return se.Name.Local == "true", nil
	case "integer":
		s, err := plistText(d)
		if err != nil {
			return nil, err
		}
		n, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
		if err != nil {
			return nil, fmt.Errorf("plist: integer %q", s)
		}
		return n, nil
	case "real":
		s, err := plistText(d)
		if err != nil {
			return nil, err
		}
		f, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
		if err != nil {
			return nil, fmt.Errorf("plist: real %q", s)
		}
		return f, nil
	default: // string, date, data
		return plistText(d)
	}
}

// plistText reads an element's text up to its end.
func plistText(d *xml.Decoder) (string, error) {
	var b strings.Builder
	for {
		tok, err := d.Token()
		if err != nil {
			return "", err
		}
		switch t := tok.(type) {
		case xml.CharData:
			b.Write(t)
		case xml.EndElement:
			return b.String(), nil
		case xml.StartElement:
			if err := d.Skip(); err != nil {
				return "", err
			}
		}
	}
}

// consoleSession is one of the Mac's login sessions (IOConsoleUsers).
type consoleSession struct {
	User      string
	UID       int
	OnConsole bool // the one at the screen
	LoggedIn  bool // past the login window
	Locked    bool
	// SecureInputPID is the process with Secure Event Input on (a password
	// field has the keyboard), 0 when none.
	SecureInputPID int
}

// parseConsoleSessions reads IOConsoleUsers from `ioreg -n Root -d1 -a`.
func parseConsoleSessions(data []byte) ([]consoleSession, error) {
	v, err := parsePlist(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	root, ok := v.(map[string]any)
	if !ok {
		return nil, errors.New("ioreg: not a dictionary")
	}
	users, _ := root["IOConsoleUsers"].([]any)
	var out []consoleSession
	for _, u := range users {
		m, ok := u.(map[string]any)
		if !ok {
			continue
		}
		s := consoleSession{}
		s.User, _ = m["kCGSSessionUserNameKey"].(string)
		if n, ok := m["kCGSSessionUserIDKey"].(int64); ok {
			s.UID = int(n)
		}
		s.OnConsole, _ = m["kCGSSessionOnConsoleKey"].(bool)
		s.LoggedIn, _ = m["kCGSessionLoginDoneKey"].(bool)
		s.Locked, _ = m["CGSSessionScreenIsLocked"].(bool)
		if n, ok := m["kCGSSessionSecureInputPID"].(int64); ok && n > 0 {
			s.SecureInputPID = int(n)
		}
		out = append(out, s)
	}
	return out, nil
}

// lockState says whether the screen waits for a password: the session at
// the screen is locked, or nobody is past the login window. known is false
// when the sessions say nothing.
func lockState(sessions []consoleSession) (locked, known bool) {
	for _, s := range sessions {
		if s.OnConsole {
			return s.Locked || !s.LoggedIn, true
		}
	}
	return true, true // the login window
}

// ioregSessions runs ioreg (macOS only).
func ioregSessions(ctx context.Context) ([]consoleSession, error) {
	if runtime.GOOS != "darwin" {
		return nil, errors.New("not a Mac")
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "/usr/sbin/ioreg", "-n", "Root", "-d1", "-a").Output()
	if err != nil {
		return nil, fmt.Errorf("ioreg: %w", err)
	}
	return parseConsoleSessions(out)
}

// bundleVersion reads CFBundleShortVersionString from an app's XML
// Info.plist ("" when it can't).
func bundleVersion(data []byte) string {
	v, err := parsePlist(bytes.NewReader(data))
	if err != nil {
		return ""
	}
	m, _ := v.(map[string]any)
	s, _ := m["CFBundleShortVersionString"].(string)
	return strings.TrimSpace(s)
}
