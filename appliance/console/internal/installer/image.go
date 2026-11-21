// Package installer is whombat-installer-ui (CG-11…CG-14): the installer ISO's root daemon behind the graphical
// installer. It knows the system the ISO installs (its image.json), runs the pre-flight checks of CG-13, lists the
// disks, runs `whombat-install` for the chosen one and follows its progress (`@@progress`, CG-12), and restarts the
// machine at the end. The page shows what it says; every decision (which disk may be erased, whether a check
// blocks) is made here.
package installer

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
)

// Image is what the installer knows about the system it puts on the disk: `<system>/etc/whombat/image.json`,
// written by the appliance's own configuration (nix/modules/image-info.nix, NX-80).
type Image struct {
	Platform    string // factory | self-installed (PI-22)
	Storage     string // luks-tpm2 | host-encrypted
	Environment string // prod | dev (every non-prod environment of the image is "dev" to the page)
	Release     *string
	AppURL      string // without the scheme, e.g. app.whombat.com
	Hosts       Hosts
	// Edition is "commercial" or "community" (Whombat HE-58, NX-445): a community box has no control or relay to reach.
	Edition string
}

// Hosts are the image's own service hosts, reached with a TLS handshake on 443 before the install (CG-13).
type Hosts struct {
	API     string `json:"api"`
	Updates string `json:"updates"`
	Relay   string `json:"relay"`
}

var (
	hostRe    = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$`)
	releaseRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
	appURLRe  = regexp.MustCompile(`^https?://([A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::[0-9]{1,5})?)/?$`)
)

// ParseImage validates image.json. A host that isn't a plain name is dropped (its check then warns without a
// value); anything else wrong refuses the file: the installer can't say what it installs.
func ParseImage(data []byte) (Image, error) {
	var raw struct {
		V           int     `json:"v"`
		Platform    string  `json:"platform"`
		Storage     string  `json:"storage"`
		Environment string  `json:"environment"`
		Release     *string `json:"release"`
		AppURL      string  `json:"appUrl"`
		Hosts       Hosts   `json:"hosts"`
		Edition     string  `json:"edition"`
	}
	if len(data) > 4096 {
		return Image{}, errors.New("image.json too large")
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return Image{}, fmt.Errorf("image.json: %w", err)
	}
	if raw.V != 1 {
		return Image{}, fmt.Errorf("image.json: version %d", raw.V)
	}
	im := Image{Platform: raw.Platform, Storage: raw.Storage, Environment: "dev", Edition: "commercial"}
	switch raw.Edition {
	case "", "commercial":
	case "community":
		im.Edition = "community"
	default:
		return Image{}, fmt.Errorf("image.json: edition %q", raw.Edition)
	}
	switch raw.Platform {
	case "factory", "self-installed":
	default:
		return Image{}, fmt.Errorf("image.json: platform %q", raw.Platform)
	}
	switch raw.Storage {
	case "luks-tpm2", "host-encrypted":
	default:
		return Image{}, fmt.Errorf("image.json: storage %q is not installed on a disk", raw.Storage)
	}
	switch raw.Environment {
	case "prod":
		im.Environment = "prod"
	case "dev", "local":
	default:
		return Image{}, fmt.Errorf("image.json: environment %q", raw.Environment)
	}
	if raw.Release != nil {
		if !releaseRe.MatchString(*raw.Release) {
			return Image{}, errors.New("image.json: invalid release")
		}
		r := *raw.Release
		im.Release = &r
	}
	// A community image has no hosted UI (NX-445): its appUrl is empty.
	if m := appURLRe.FindStringSubmatch(raw.AppURL); m != nil {
		im.AppURL = m[1]
	} else if raw.AppURL != "" || im.Edition != "community" {
		return Image{}, errors.New("image.json: invalid appUrl")
	}
	im.Hosts = Hosts{API: plainHost(raw.Hosts.API), Updates: plainHost(raw.Hosts.Updates), Relay: plainHost(raw.Hosts.Relay)}
	return im, nil
}
