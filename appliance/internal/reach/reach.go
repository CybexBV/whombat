// Package reach is how the owner chose to reach their Whombat (Whombat LNK-12, LNK-15; NX-521): Whombat Link,
// Tailscale, or both. The choice is made in the installer and changed later in the recovery menu (hold Space at
// power-on), both as root, in a root-owned file on the installed disk:
//
//	/persist/whombat/reach.json   0644 root   {v: 1, seq, link, tailscale, loginServer?, by, at}
//
// The manager acts on each seq once, at its start: Link on (link.begin) or off (link.leave), Tailscale on (with the
// owner's own login server when named). It never turns Tailscale off because of this file: a way in is only ever
// added from the screen side. Later changes come from the owner's apps (Settings → This Whombat → Reach), which talk
// to the manager directly and don't touch this file.
package reach

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/atomicfile"
)

// File is where the choice lives on a box.
const File = "/persist/whombat/reach.json"

// Who wrote a choice.
const (
	ByInstaller = "installer"
	ByRecovery  = "recovery"
)

// Choice is the file.
type Choice struct {
	V int `json:"v"`
	// Seq grows with every change; the manager acts on each once.
	Seq uint64 `json:"seq"`
	// Link: the owner wants Whombat Link.
	Link bool `json:"link"`
	// Tailscale: the owner wants Tailscale on.
	Tailscale bool `json:"tailscale"`
	// LoginServer is the owner's own Tailscale login server (Headscale), when they named one.
	LoginServer string `json:"loginServer,omitempty"`
	By          string `json:"by"`
	At          string `json:"at"`
}

// loginServerRe is what the installer and the menu take as a login server: an https URL without userinfo, query or
// anything a shell or a terminal would read (the same shape tailscale.go's validLoginServer takes, a little stricter).
var loginServerRe = regexp.MustCompile(`^https://[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::[0-9]{1,5})?(?:/[A-Za-z0-9._~/-]{0,200})?$`)

// ValidLoginServer reports whether u can be a login server.
func ValidLoginServer(u string) bool { return loginServerRe.MatchString(u) }

// ErrNothing: the choice reaches the box in no way at all.
var ErrNothing = errors.New("choose Whombat Link, Tailscale or both")

// Validate checks c.
func (c *Choice) Validate() error {
	if c.V != 1 {
		return fmt.Errorf("reach: version %d", c.V)
	}
	if !c.Link && !c.Tailscale {
		return ErrNothing
	}
	if c.LoginServer != "" && (!c.Tailscale || !ValidLoginServer(c.LoginServer)) {
		return fmt.Errorf("reach: login server %q", c.LoginServer)
	}
	if c.By != ByInstaller && c.By != ByRecovery {
		return fmt.Errorf("reach: by %q", c.By)
	}
	if _, err := time.Parse(time.RFC3339, c.At); err != nil {
		return fmt.Errorf("reach: at: %w", err)
	}
	return nil
}

// Parse reads and checks a choice.
func Parse(b []byte) (*Choice, error) {
	var c Choice
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&c); err != nil {
		return nil, fmt.Errorf("reach: %w", err)
	}
	if err := c.Validate(); err != nil {
		return nil, err
	}
	return &c, nil
}

// Read reads the box's choice; nil without one (a box installed before the choice, or a development image).
func Read(path string) (*Choice, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return Parse(b)
}

// A change the recovery menu makes.
const (
	// UseLink: “Change how you reach this Whombat” → Whombat Link (Tailscale stays as it is).
	UseLink = "link"
	// UseTailscale: “Change how you reach this Whombat” → Tailscale (Link off).
	UseTailscale = "tailscale"
	// TailscaleOn: “Turn on Tailscale” (Link stays as it is).
	TailscaleOn = "tailscale-on"
)

// Change applies one of the menu's changes to the choice at path (none yet: as if the box had chosen neither) and
// writes it with the next seq, also when the file already said so: the owner may have turned Link off in the apps
// since, and the menu's choice is a request the manager acts on again.
func Change(path, change string, now time.Time) (*Choice, error) {
	old, err := Read(path)
	if err != nil {
		return nil, err
	}
	next := Choice{V: 1, By: ByRecovery, At: now.UTC().Format(time.RFC3339)}
	if old != nil {
		next.Seq, next.Link, next.Tailscale, next.LoginServer = old.Seq, old.Link, old.Tailscale, old.LoginServer
	}
	switch change {
	case UseLink:
		next.Link = true
	case UseTailscale:
		next.Link, next.Tailscale = false, true
	case TailscaleOn:
		next.Tailscale = true
	default:
		return nil, fmt.Errorf("reach: unknown change %q", change)
	}
	next.Seq++
	if err := Write(path, &next); err != nil {
		return nil, err
	}
	return &next, nil
}

// Write writes c (root's, 0644).
func Write(path string, c *Choice) error {
	if err := c.Validate(); err != nil {
		return err
	}
	b, err := json.Marshal(c)
	if err != nil {
		return err
	}
	return atomicfile.WriteFile(path, append(b, '\n'), 0o644)
}
