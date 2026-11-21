package macos

import (
	"context"
	"errors"
	"regexp"
	"sort"
	"strings"
	"time"

	"rackoon/internal/proto"
)

// SoftwareUpdatePlist is where macOS's own background check keeps what it
// found. The agent reads it and never asks Apple itself: like the Linux
// agent, which never refreshes package lists on a timer.
const SoftwareUpdatePlist = "/Library/Preferences/com.apple.SoftwareUpdate.plist"

// Pending is the updates macOS's own check found.
type Pending struct {
	Updates   []proto.PackageUpdate
	Security  int
	CheckedAt time.Time // the last successful check
}

// ParseSoftwareUpdatePlist reads the Software Update preferences (XML
// form): RecommendedUpdates and LastSuccessfulDate.
func ParseSoftwareUpdatePlist(b []byte) (*Pending, error) {
	v, err := ParsePlist(b)
	if err != nil {
		return nil, err
	}
	d := asDict(v)
	if d == nil {
		return nil, errors.New("the Software Update preferences are not a dictionary")
	}
	p := &Pending{Updates: []proto.PackageUpdate{}, CheckedAt: d.time("LastSuccessfulDate")}
	for _, it := range d.list("RecommendedUpdates") {
		u := asDict(it)
		if u == nil {
			continue
		}
		name := strings.TrimSpace(u.str("Display Name"))
		if name == "" {
			name = strings.TrimSpace(u.str("Identifier"))
		}
		if name == "" {
			continue
		}
		pu := proto.PackageUpdate{Name: clip(name, 200), New: clip(strings.TrimSpace(u.str("Display Version")), 64), Source: "Apple"}
		pu.Security = isSecurityTitle(name)
		if pu.Security {
			p.Security++
		}
		p.Updates = append(p.Updates, pu)
		if len(p.Updates) >= 500 {
			break
		}
	}
	sortUpdates(p.Updates)
	return p, nil
}

// isSecurityTitle: Apple names its security-only releases so ("Security
// Update 2026-001", "Background Security Improvement", "Rapid Security
// Response").
func isSecurityTitle(s string) bool {
	return strings.Contains(strings.ToLower(s), "security")
}

func sortUpdates(u []proto.PackageUpdate) {
	sort.SliceStable(u, func(i, j int) bool {
		if u[i].Security != u[j].Security {
			return u[i].Security
		}
		return u[i].Name < u[j].Name
	})
}

// ReadPending reads the Software Update preferences through plutil (the
// file is a binary property list).
func ReadPending(ctx context.Context) (*Pending, error) {
	out, err := Run(ctx, 20*time.Second, Plutil, "-convert", "xml1", "-o", "-", SoftwareUpdatePlist)
	if err != nil {
		return nil, err
	}
	return ParseSoftwareUpdatePlist(out)
}

// ListedUpdate is one update of `softwareupdate --list`.
type ListedUpdate struct {
	Label   string // what --install takes
	Title   string
	Version string
	Restart bool // Action: restart (or shut down)
}

var (
	suVersionRe = regexp.MustCompile(`(?:^|,\s*)Version:\s*([^,]+)`)
	suActionRe  = regexp.MustCompile(`(?:^|,\s*)Action:\s*([A-Za-z-]+)`)
)

// ParseSoftwareUpdateList reads `softwareupdate --list` ("* Label: …" lines,
// each followed by "Title: …, Version: …, Size: …, Recommended: YES,
// Action: restart,").
func ParseSoftwareUpdateList(b []byte) []ListedUpdate {
	var out []ListedUpdate
	for _, line := range strings.Split(string(b), "\n") {
		t := strings.TrimSpace(line)
		if l, ok := strings.CutPrefix(t, "* Label:"); ok {
			out = append(out, ListedUpdate{Label: strings.TrimSpace(l)})
			continue
		}
		rest, ok := strings.CutPrefix(t, "Title:")
		if !ok || len(out) == 0 {
			continue
		}
		u := &out[len(out)-1]
		title := rest
		if i := strings.Index(rest, ", Version:"); i >= 0 {
			title = rest[:i]
		}
		u.Title = strings.TrimSpace(title)
		if m := suVersionRe.FindStringSubmatch(t); m != nil {
			u.Version = strings.TrimSpace(m[1])
		}
		if m := suActionRe.FindStringSubmatch(t); m != nil {
			a := strings.ToLower(m[1])
			u.Restart = a == "restart" || a == "shut-down" || a == "shutdown"
		}
	}
	for i := range out {
		out[i].Label = clip(out[i].Label, 200)
		out[i].Title = clip(out[i].Title, 200)
		out[i].Version = clip(out[i].Version, 64)
	}
	return out
}

// PackageUpdates turns listed updates into the inspect view's rows: the
// name is the label packages.install takes.
func PackageUpdates(l []ListedUpdate) []proto.PackageUpdate {
	out := []proto.PackageUpdate{}
	for _, u := range l {
		if u.Label == "" {
			continue
		}
		src := "Apple"
		if u.Restart {
			src = "Apple · needs a restart"
		}
		out = append(out, proto.PackageUpdate{Name: u.Label, New: u.Version, Security: isSecurityTitle(u.Title + " " + u.Label), Source: src})
	}
	sortUpdates(out)
	return out
}

// ListUpdates asks Apple's servers what is waiting (`softwareupdate
// --list`): a network call, made only when someone asks (the inspect view,
// a check); scan false reads what the last scan found (`--no-scan`).
func ListUpdates(ctx context.Context, scan bool) ([]ListedUpdate, error) {
	argv := []string{SoftwareUpdate, "--list"}
	if !scan {
		argv = append(argv, "--no-scan")
	}
	out, err := Run(ctx, 5*time.Minute, argv...)
	if err != nil {
		return nil, err
	}
	return ParseSoftwareUpdateList(out), nil
}

// LabelRe is a softwareupdate label packages.install accepts: Apple's
// labels have spaces, dots, dashes and parentheses; never a leading "-".
var LabelRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9 +._:@~(),'-]{0,199}$`)
