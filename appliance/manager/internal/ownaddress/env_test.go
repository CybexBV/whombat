package ownaddress

import (
	"strings"
	"testing"
)

func envOf(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func TestResolve(t *testing.T) {
	cases := []struct {
		name      string
		community bool
		env       string
		envZone   string
		vars      map[string]string
		on        bool
		zone, dir string
		ct        string
		err       string
	}{
		{name: "prod", env: "prod", on: true, zone: "whombat.app", dir: DirectoryProduction, ct: CertSpotterURL},
		{name: "dev", env: "dev", on: true, zone: "dev.whombat.app", dir: DirectoryProduction, ct: CertSpotterURL},
		{name: "local is off by default", env: "local"},
		{name: "community is always off", community: true, env: "prod", vars: map[string]string{EnvMode: "on"}},
		{name: "off", env: "prod", vars: map[string]string{EnvMode: "off"}},
		{name: "on for local takes the dev zone", env: "local", vars: map[string]string{EnvMode: "on"}, on: true, zone: "dev.whombat.app", dir: DirectoryProduction, ct: CertSpotterURL},
		{name: "staging", env: "dev", vars: map[string]string{EnvMode: "staging"}, on: true, zone: "dev.whombat.app", dir: DirectoryStaging, ct: CertSpotterURL},
		{name: "staging on prod keeps the prod zone", env: "prod", vars: map[string]string{EnvMode: " staging "}, on: true, zone: "whombat.app", dir: DirectoryStaging, ct: CertSpotterURL},
		{name: "pebble", env: "local", vars: map[string]string{EnvMode: "pebble:https://127.0.0.1:14000/dir", EnvProbe: "127.0.0.1:5001"},
			on: true, zone: "dev.whombat.app", dir: "https://127.0.0.1:14000/dir"},
		{name: "pebble with a fake cert spotter", env: "dev", vars: map[string]string{EnvMode: "pebble:https://127.0.0.1:14000/dir", EnvCT: "http://127.0.0.1:9"},
			on: true, zone: "dev.whombat.app", dir: "https://127.0.0.1:14000/dir", ct: "http://127.0.0.1:9"},
		{name: "pebble never on prod", env: "prod", vars: map[string]string{EnvMode: "pebble:https://127.0.0.1:14000/dir"}, err: "never on a prod box"},
		{name: "pebble needs https", env: "local", vars: map[string]string{EnvMode: "pebble:http://127.0.0.1:14000/dir"}, err: "https directory"},
		{name: "unknown", env: "dev", vars: map[string]string{EnvMode: "yes"}, err: "want off, on"},
		// The environment's zone (LNK-01a): a development-stack box of env local is on by itself, in its zone.
		{name: "the environment's zone", env: "local", envZone: "dev.whombat.app", on: true, zone: "dev.whombat.app", dir: DirectoryProduction, ct: CertSpotterURL},
		{name: "the environment's zone is off when said", env: "local", envZone: "dev.whombat.app", vars: map[string]string{EnvMode: "off"}},
		{name: "prod's zone from the environment", env: "prod", envZone: "whombat.app", on: true, zone: "whombat.app", dir: DirectoryProduction, ct: CertSpotterURL},
		{name: "an environment's zone that is none of Whombat's", env: "prod", envZone: "box.example.com", err: "none of Whombat's"},
		{name: "the environment's zone with staging", env: "prod", envZone: "box.whombat.app", vars: map[string]string{EnvMode: "staging"}, on: true, zone: "box.whombat.app", dir: DirectoryStaging, ct: CertSpotterURL},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m, err := Resolve(c.community, c.env, c.envZone, envOf(c.vars))
			if c.err != "" {
				if err == nil || !strings.Contains(err.Error(), c.err) {
					t.Fatalf("err = %v, want %q", err, c.err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if m.Enabled != c.on || m.Zone != c.zone || m.Directory != c.dir || m.CTURL != c.ct {
				t.Fatalf("got %+v", m)
			}
			if !m.Enabled && m.Why == "" {
				t.Fatal("off without a reason")
			}
		})
	}
	// The test stand-ins are honoured only in pebble mode.
	m, _ := Resolve(false, "dev", "", envOf(map[string]string{EnvProbe: "127.0.0.1:1", EnvCA: "/x", EnvCT: "http://x"}))
	if m.ProbeAddr != "" || m.CAFile != "" || m.CTURL != CertSpotterURL {
		t.Fatalf("stand-ins outside pebble: %+v", m)
	}
}

func TestZones(t *testing.T) {
	if z := ZonesOf("whombat.app"); len(z) != 2 || z[0] != "whombat.app" || z[1] != "box.whombat.app" {
		t.Fatal(z)
	}
	if z := ZonesOf("box.whombat.app"); len(z) != 2 {
		t.Fatal("an image that still names prod's earlier zone keeps both", z)
	}
	if z := ZonesOf("dev.whombat.app"); len(z) != 1 || z[0] != "dev.whombat.app" {
		t.Fatal(z)
	}
	if ZonesOf("example.com") != nil {
		t.Fatal("a foreign zone")
	}
	for host, want := range map[string]string{
		"home.whombat.app":                  "whombat.app",
		"maple-otter-river.box.whombat.app": "box.whombat.app",
		"maple-otter-river.dev.whombat.app": "dev.whombat.app",
		"box.whombat.app":                   "",
		"dev.whombat.app":                   "",
		"a.b.whombat.app":                   "",
		"ab.whombat.app":                    "",
		"home.example.com":                  "",
	} {
		if got := ZoneOf(host); got != want {
			t.Errorf("ZoneOf(%s) = %q, want %q", host, got, want)
		}
	}
}
