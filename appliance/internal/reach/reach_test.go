package reach

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestTheInstallersChoice(t *testing.T) {
	// What whombat-install writes (installer-base.nix), byte for byte in shape.
	c, err := Parse([]byte(`{"v":1,"seq":1,"link":false,"tailscale":true,"loginServer":"https://hs.example.com","by":"installer","at":"2026-11-18T12:00:00Z"}`))
	if err != nil || c.Link || !c.Tailscale || c.LoginServer != "https://hs.example.com" || c.Seq != 1 {
		t.Fatalf("%+v %v", c, err)
	}
	for _, bad := range []string{
		`{"v":1,"seq":1,"link":false,"tailscale":false,"by":"installer","at":"2026-11-18T12:00:00Z"}`,
		`{"v":1,"seq":1,"link":true,"tailscale":false,"loginServer":"https://hs.example.com","by":"installer","at":"2026-11-18T12:00:00Z"}`,
		`{"v":1,"seq":1,"link":false,"tailscale":true,"loginServer":"http://hs.example.com","by":"installer","at":"2026-11-18T12:00:00Z"}`,
		`{"v":1,"seq":1,"link":true,"tailscale":false,"by":"someone","at":"2026-11-18T12:00:00Z"}`,
		`{"v":1,"seq":1,"link":true,"tailscale":false,"by":"installer","at":"yesterday"}`,
		`{"v":1,"seq":1,"link":true,"tailscale":false,"by":"installer","at":"2026-11-18T12:00:00Z","extra":1}`,
	} {
		if _, err := Parse([]byte(bad)); err == nil {
			t.Errorf("accepted %s", bad)
		}
	}
	if !errors.Is((&Choice{V: 1, By: ByInstaller, At: "2026-11-18T12:00:00Z"}).Validate(), ErrNothing) {
		t.Fatal("nothing chosen")
	}
}

func TestLoginServers(t *testing.T) {
	for u, ok := range map[string]bool{"https://hs.example.com": true, "https://hs.example.com:8443/": true,
		"https://hs.example.com/path_x": true, "http://hs.example.com": false, "https://user@hs.example.com": false,
		"https://hs.example.com/?q=1": false, "https://hs.example.com/\"x": false, "https://-x.example.com": false} {
		if ValidLoginServer(u) != ok {
			t.Errorf("%s: %v", u, !ok)
		}
	}
}

// The recovery menu's changes: each writes the next seq, also when the file already says so.
func TestChange(t *testing.T) {
	path := filepath.Join(t.TempDir(), "reach.json")
	now := time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)
	if c, err := Read(path); c != nil || err != nil {
		t.Fatal(c, err)
	}
	c, err := Change(path, TailscaleOn, now)
	if err != nil || c.Seq != 1 || c.Link || !c.Tailscale || c.By != ByRecovery {
		t.Fatalf("%+v %v", c, err)
	}
	c, err = Change(path, UseLink, now)
	if err != nil || c.Seq != 2 || !c.Link || !c.Tailscale {
		t.Fatalf("%+v %v", c, err)
	}
	c, err = Change(path, UseLink, now)
	if err != nil || c.Seq != 3 || !c.Link {
		t.Fatalf("again: %+v %v", c, err)
	}
	c, err = Change(path, UseTailscale, now)
	if err != nil || c.Seq != 4 || c.Link || !c.Tailscale {
		t.Fatalf("%+v %v", c, err)
	}
	if _, err := Change(path, "off", now); err == nil {
		t.Fatal("unknown change")
	}
	got, err := Read(path)
	if err != nil || *got != *c {
		t.Fatalf("%+v %v", got, err)
	}
	if fi, _ := os.Stat(path); fi.Mode().Perm() != 0o644 {
		t.Fatal(fi.Mode())
	}
}
