// Package ownaddress is the manager's side of each Whombat's own address (Whombat own-address.md, MG-161…MG-166): the
// label control registered for this box, the certificate it orders by ACME TLS-ALPN-01 through the door, the ACME
// socket the runtime pipes the door's `acme` streams into, the probe of that whole path before every order, and the
// certificate watch on Cert Spotter. The runtime reads all of it through the broker's /v1/own-address/* routes.
package ownaddress

import (
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// The ACME directories. Both zones use Let's Encrypt production: DEV boxes are real boxes with trusted pages.
const (
	DirectoryProduction = "https://acme-v02.api.letsencrypt.org/directory"
	DirectoryStaging    = "https://acme-staging-v02.api.letsencrypt.org/directory"
)

// CertSpotterURL is the certificate watch's source (design §6): keyless, called by the box itself, never through Cybex.
const CertSpotterURL = "https://api.certspotter.com"

// The environment variables (MG-161). The manager's configuration has no field for any of this: it refuses unknown
// fields, so a field set by a newer image would break a rollback to an older known-good manager.
const (
	// EnvMode: "" (the device's env decides), "off", "on", "staging", or "pebble:<directory URL>" (tests).
	EnvMode = "WHOMBAT_OWN_ADDRESS"
	// EnvCA: pebble only, a PEM file of roots for the test directory's own HTTPS.
	EnvCA = "WHOMBAT_OWN_ADDRESS_CA"
	// EnvProbe: pebble only, the host:port the probe dials instead of <host>:443 (the tests' DNS stand-in).
	EnvProbe = "WHOMBAT_OWN_ADDRESS_PROBE"
	// EnvCT: pebble only, the certificate watch's base URL (a fake Cert Spotter); unset: no watch, so a test label is
	// never sent to the real one.
	EnvCT = "WHOMBAT_OWN_ADDRESS_CT"
)

// Mode is what this box does about its own address.
type Mode struct {
	// Enabled: the box has an own address (the broker's routes answer, the loops run).
	Enabled bool
	// Why is a short reason for the log (off: why it is off).
	Why string
	// Zone is the environment's zone: whombat.app or dev.whombat.app (an older image may name box.whombat.app). Control
	// says which host the box has; Zones is where that host may be.
	Zone string
	// Directory is the ACME directory URL.
	Directory string
	// CAFile, ProbeAddr and CTURL are the pebble mode's test stand-ins (empty otherwise).
	CAFile    string
	ProbeAddr string
	// CTURL is the certificate watch's base URL; empty: no watch (pebble without EnvCT).
	CTURL string
}

// Resolve decides the mode from the edition, the device's env (`/persist/identity/device.json`), the environment's zone
// (internal/environment, LNK-01a: "" for none) and the environment variables (MG-161, plan D2). On by default where the
// box has a real zone: the environment names one, or the device's env is dev or prod. `on` and `staging` also switch it
// on for env local (the dev stack's own appliance, plan D3), with the dev zone there. A community box never has one: it
// has no control to register a label with.
func Resolve(community bool, deviceEnv, envZone string, getenv func(string) string) (Mode, error) {
	if community {
		return Mode{Why: "a community box has no control to register its name with"}, nil
	}
	zone := protocol.OwnAddressZoneDev
	if deviceEnv == "prod" {
		zone = protocol.OwnAddressZoneProd
	}
	if envZone != "" {
		if ZonesOf(envZone) == nil {
			// The hosts' shape knows only Whombat's zones: a box elsewhere could never accept a host from control.
			return Mode{}, fmt.Errorf("the environment's own-address zone %q is none of Whombat's", envZone)
		}
		zone = envZone
	}
	v := strings.TrimSpace(getenv(EnvMode))
	switch {
	case v == "" && envZone != "":
		return Mode{Enabled: true, Why: "the environment's zone", Zone: zone, Directory: DirectoryProduction, CTURL: CertSpotterURL}, nil
	case v == "":
		if deviceEnv != "dev" && deviceEnv != "prod" {
			return Mode{Why: "env " + deviceEnv + " has no zone; " + EnvMode + "=on switches it on"}, nil
		}
		return Mode{Enabled: true, Why: "env " + deviceEnv, Zone: zone, Directory: DirectoryProduction, CTURL: CertSpotterURL}, nil
	case v == "off":
		return Mode{Why: EnvMode + "=off"}, nil
	case v == "on":
		return Mode{Enabled: true, Why: EnvMode + "=on", Zone: zone, Directory: DirectoryProduction, CTURL: CertSpotterURL}, nil
	case v == "staging":
		return Mode{Enabled: true, Why: EnvMode + "=staging", Zone: zone, Directory: DirectoryStaging, CTURL: CertSpotterURL}, nil
	case strings.HasPrefix(v, "pebble:"):
		dir := strings.TrimPrefix(v, "pebble:")
		if u, err := url.Parse(dir); err != nil || u.Scheme != "https" || u.Host == "" {
			return Mode{}, fmt.Errorf("%s=pebble: needs an https directory URL, got %q", EnvMode, dir)
		}
		if deviceEnv == "prod" {
			return Mode{}, errors.New(EnvMode + "=pebble: is for tests and never on a prod box")
		}
		// The host's schema knows only the two real zones, so tests use the dev one with a DNS stand-in.
		return Mode{Enabled: true, Why: EnvMode + "=pebble", Zone: protocol.OwnAddressZoneDev, Directory: dir,
			CAFile: strings.TrimSpace(getenv(EnvCA)), ProbeAddr: strings.TrimSpace(getenv(EnvProbe)),
			CTURL: strings.TrimSpace(getenv(EnvCT))}, nil
	default:
		return Mode{}, fmt.Errorf("%s=%q: want off, on, staging or pebble:<directory URL>", EnvMode, v)
	}
}

// ZonesOf is every zone a box of an environment with this zone may have its host under: prod's (whombat.app) together
// with prod's earlier one (box.whombat.app), where boxes stay until they move; dev's alone. nil for a zone that is none
// of Whombat's.
func ZonesOf(zone string) []string {
	switch zone {
	case protocol.OwnAddressZoneProd, protocol.OwnAddressZoneOldProd:
		return []string{protocol.OwnAddressZoneProd, protocol.OwnAddressZoneOldProd}
	case protocol.OwnAddressZoneDev:
		return []string{protocol.OwnAddressZoneDev}
	}
	return nil
}

// Zones is ZonesOf the mode's zone.
func (m Mode) Zones() []string { return ZonesOf(m.Zone) }

// OldZone: boxes under this zone move to their environment's newer one once control names it.
func OldZone(zone string) bool { return zone == protocol.OwnAddressZoneOldProd }

// ZoneOf is the longest of Whombat's zones host is directly under ("" for none): `x.box.whombat.app` is under
// box.whombat.app, not whombat.app. A zone itself is never a box's host.
func ZoneOf(host string) string {
	if host == protocol.OwnAddressZoneOldProd || host == protocol.OwnAddressZoneDev {
		return ""
	}
	for _, z := range []string{protocol.OwnAddressZoneOldProd, protocol.OwnAddressZoneDev, protocol.OwnAddressZoneProd} {
		if label, ok := strings.CutSuffix(host, "."+z); ok {
			if !strings.Contains(label, ".") && validLabel(label) {
				return z
			}
			return ""
		}
	}
	return ""
}

// validLabel is the label's shape and length (the pattern alone doesn't bound it).
func validLabel(label string) bool {
	return len(label) >= protocol.OwnAddressLabelMin && len(label) <= protocol.OwnAddressLabelMax && labelRe.MatchString(label)
}
