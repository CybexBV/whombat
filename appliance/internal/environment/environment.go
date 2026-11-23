// Package environment is which Whombat environment a box belongs to (Whombat LNK-01a, NX-520): production or the
// maintainers' development stack. The environment is not the update channel: it says which control, app, zone and
// trust documents the box uses; the channel only says which releases it takes.
//
// Every image carries both environments (the image file, written by Nix):
//
//	/etc/whombat/environments.json   {v: 1, default: "prod", environments: {prod: {…}, dev: {…}}}
//
// A box picks one with a root-owned file of its own on /persist (absent: the image's default, production):
//
//	/persist/whombat/environment.json   0644 root   {v: 1, env: "dev"}
//
// The box file only names an environment the image knows. It carries no address or key, so a file written by mistake
// can only move a box between the two environments the image was built with, never point it somewhere else. Only root
// writes it: the installer's developer option and the bridge release (`whombat-manager environment set dev
// --if-absent`). At boot whombat-environment.service resolves both into /run/whombat/environment/ (Resolved, the
// runtime's environment file and the chosen trust documents), which the services read.
package environment

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/CybexBV/whombat/appliance/helper/pkg/atomicfile"
)

// The files.
const (
	// ImageFile is the image's environments (Nix, environment.nix).
	ImageFile = "/etc/whombat/environments.json"
	// BoxFile is the box's choice, root-owned on /persist.
	BoxFile = "/persist/whombat/environment.json"
	// RunDir is where whombat-environment.service puts the resolved environment at every boot.
	RunDir = "/run/whombat/environment"
	// ResolvedName, RuntimeEnvName: the resolved settings and the runtime's systemd environment file in RunDir.
	ResolvedName   = "environment.json"
	RuntimeEnvName = "runtime.env"
)

// The environments. Names, not the device's env: the development stack's control runs as env `local`.
const (
	Production  = "prod"
	Development = "dev"
)

// The trust documents an environment may name, by their file name in RunDir.
const (
	SupportCAName   = "support-ca.pub"
	ClientsKeysName = "client-channel-keys.json"
	LicenceKeysName = "licence-keys.json"
)

// Settings are one environment's: everything that differs between production and the development stack.
type Settings struct {
	// DeviceEnv is the env a box made here gets in its identity (device.json, the registration): local, dev or prod.
	DeviceEnv string `json:"deviceEnv"`
	// ControlURL is control's base URL; "" means no Whombat Link in this environment (a test image, LNK-03).
	ControlURL string `json:"controlUrl"`
	// AppURL is the hosted app's origin (WHOMBAT_APP_URL); "" for none.
	AppURL string `json:"appUrl"`
	// EmbedURL is the feedback widget's origin (WHOMBAT_EMBED_URL); "" for the app's.
	EmbedURL string `json:"embedUrl,omitempty"`
	// RelayHost is the relay's host name, for the record (the tickets name the relay).
	RelayHost string `json:"relayHost,omitempty"`
	// OwnAddressZone is where the boxes' own addresses live (whombat.app, dev.whombat.app); "" for none. A prod box may
	// still have its address under prod's earlier zone (box.whombat.app) until it moves: the manager allows both.
	OwnAddressZone string `json:"ownAddressZone,omitempty"`
	// Files are the environment's trust documents in the image, by their name in RunDir (SupportCAName…).
	Files map[string]string `json:"files,omitempty"`
	// Runtime is extra runtime environment of this environment only (e.g. WHOMBAT_MERGE_RERUN on the dev stack).
	Runtime map[string]string `json:"runtime,omitempty"`
}

// Image is the image file.
type Image struct {
	V            int                 `json:"v"`
	Default      string              `json:"default"`
	Environments map[string]Settings `json:"environments"`
}

// Box is the box file.
type Box struct {
	V   int    `json:"v"`
	Env string `json:"env"`
}

// Resolved is the environment a box runs in: RunDir/environment.json.
type Resolved struct {
	V    int    `json:"v"`
	Name string `json:"name"`
	// Chosen: the box file chose it (false: the image's default).
	Chosen bool `json:"chosen"`
	Settings
}

// LinkAvailable reports whether this environment has Whombat Link (a control to talk to).
func (r *Resolved) LinkAvailable() bool { return r != nil && r.ControlURL != "" }

var (
	nameRe     = regexp.MustCompile(`^[a-z][a-z0-9-]{0,15}$`)
	originRe   = regexp.MustCompile(`^https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?$`)
	zoneRe     = regexp.MustCompile(`^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$`)
	envKeyRe   = regexp.MustCompile(`^WHOMBAT_[A-Z0-9_]{1,64}$`)
	envValueRe = regexp.MustCompile(`^[\x21-\x7e]{0,512}$`)
)

// ErrUnknown: the box file names an environment this image doesn't have.
var ErrUnknown = errors.New("this image has no such environment")

func (s *Settings) validate() error {
	switch s.DeviceEnv {
	case "local", "dev", "prod":
	default:
		return fmt.Errorf("deviceEnv %q", s.DeviceEnv)
	}
	for name, v := range map[string]string{"controlUrl": s.ControlURL, "appUrl": s.AppURL, "embedUrl": s.EmbedURL} {
		if v != "" && !originRe.MatchString(strings.TrimSuffix(v, "/")) {
			return fmt.Errorf("%s %q is not an https origin", name, v)
		}
	}
	if s.OwnAddressZone != "" && !zoneRe.MatchString(s.OwnAddressZone) {
		return fmt.Errorf("ownAddressZone %q", s.OwnAddressZone)
	}
	for name, p := range s.Files {
		switch name {
		case SupportCAName, ClientsKeysName, LicenceKeysName:
		default:
			return fmt.Errorf("unknown file %q", name)
		}
		if !filepath.IsAbs(p) {
			return fmt.Errorf("file %s: %q is not an absolute path", name, p)
		}
	}
	for k, v := range s.Runtime {
		if !envKeyRe.MatchString(k) || !envValueRe.MatchString(v) {
			return fmt.Errorf("runtime %s: not a plain WHOMBAT_ variable", k)
		}
	}
	return nil
}

// ParseImage reads and checks an image file.
func ParseImage(b []byte) (*Image, error) {
	var im Image
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&im); err != nil {
		return nil, fmt.Errorf("the image's environments: %w", err)
	}
	if im.V != 1 {
		return nil, fmt.Errorf("the image's environments: version %d", im.V)
	}
	if _, ok := im.Environments[im.Default]; !ok {
		return nil, fmt.Errorf("the image's environments: no default %q", im.Default)
	}
	for name, s := range im.Environments {
		if !nameRe.MatchString(name) {
			return nil, fmt.Errorf("the image's environments: name %q", name)
		}
		if err := s.validate(); err != nil {
			return nil, fmt.Errorf("the image's environment %s: %w", name, err)
		}
	}
	return &im, nil
}

// ParseBox reads and checks a box file.
func ParseBox(b []byte) (*Box, error) {
	var bx Box
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&bx); err != nil {
		return nil, fmt.Errorf("the box's environment file: %w", err)
	}
	if bx.V != 1 || !nameRe.MatchString(bx.Env) {
		return nil, errors.New("the box's environment file: needs {v: 1, env}")
	}
	return &bx, nil
}

// Resolve is the environment of a box with this image and box file. A missing box file is the image's default; a
// broken one, or one naming an environment the image lacks, is an error: the box must not quietly fall back to
// production when its owner chose the development stack (or the other way round).
func Resolve(imagePath, boxPath string) (*Resolved, error) {
	ib, err := os.ReadFile(imagePath)
	if err != nil {
		return nil, err
	}
	im, err := ParseImage(ib)
	if err != nil {
		return nil, err
	}
	name, chosen := im.Default, false
	bb, err := os.ReadFile(boxPath)
	switch {
	case errors.Is(err, os.ErrNotExist):
	case err != nil:
		return nil, err
	default:
		bx, err := ParseBox(bb)
		if err != nil {
			return nil, err
		}
		name, chosen = bx.Env, true
	}
	s, ok := im.Environments[name]
	if !ok {
		return nil, fmt.Errorf("%w: %q (it has %s)", ErrUnknown, name, strings.Join(names(im), ", "))
	}
	return &Resolved{V: 1, Name: name, Chosen: chosen, Settings: s}, nil
}

func names(im *Image) []string {
	var out []string
	for n := range im.Environments {
		out = append(out, n)
	}
	sort.Strings(out)
	return out
}

// Load reads RunDir's resolved environment, as whombat-environment.service wrote it at boot.
func Load(runDir string) (*Resolved, error) {
	b, err := os.ReadFile(filepath.Join(runDir, ResolvedName))
	if err != nil {
		return nil, err
	}
	var r Resolved
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, fmt.Errorf("the resolved environment: %w", err)
	}
	var marker struct {
		Problem string `json:"problem"`
	}
	if json.Unmarshal(b, &marker) == nil && marker.Problem != "" {
		return nil, fmt.Errorf("the box's environment didn't resolve at boot: %s", marker.Problem)
	}
	if r.V != 1 || r.Name == "" {
		return nil, errors.New("the resolved environment: needs {v: 1, name}")
	}
	if err := r.Settings.validate(); err != nil {
		return nil, fmt.Errorf("the resolved environment: %w", err)
	}
	return &r, nil
}

// Set writes the box file naming env, after checking the image has it. With ifAbsent an existing box file is kept
// whatever it says (the bridge release: never over an owner's or the installer's choice). It answers whether it wrote.
// The file is root's, 0644, in a root-owned folder.
func Set(imagePath, boxPath, env string, ifAbsent bool) (bool, error) {
	ib, err := os.ReadFile(imagePath)
	if err != nil {
		return false, err
	}
	im, err := ParseImage(ib)
	if err != nil {
		return false, err
	}
	if _, ok := im.Environments[env]; !ok {
		return false, fmt.Errorf("%w: %q (it has %s)", ErrUnknown, env, strings.Join(names(im), ", "))
	}
	if b, err := os.ReadFile(boxPath); err == nil {
		if ifAbsent {
			return false, nil
		}
		if bx, err := ParseBox(b); err == nil && bx.Env == env {
			return false, nil
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	b, _ := json.Marshal(Box{V: 1, Env: env})
	if err := atomicfile.WriteFile(boxPath, append(b, '\n'), 0o644); err != nil {
		return false, err
	}
	return true, nil
}

// WriteRun puts the resolved environment into runDir: environment.json, the runtime's environment file (appUrl,
// embedUrl, the environment's own runtime variables) and a link to each trust document it names. Everything is
// replaced, so a document the new environment lacks is gone.
func WriteRun(r *Resolved, runDir string) error {
	if err := os.MkdirAll(runDir, 0o755); err != nil {
		return err
	}
	if err := os.Chmod(runDir, 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	if err := atomicfile.WriteFile(filepath.Join(runDir, ResolvedName), append(b, '\n'), 0o644); err != nil {
		return err
	}
	if err := atomicfile.WriteFile(filepath.Join(runDir, RuntimeEnvName), []byte(RuntimeEnv(r)), 0o644); err != nil {
		return err
	}
	for _, name := range []string{SupportCAName, ClientsKeysName, LicenceKeysName} {
		p := filepath.Join(runDir, name)
		if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if src := r.Files[name]; src != "" {
			if err := os.Symlink(src, p); err != nil {
				return err
			}
		}
	}
	return nil
}

// WriteProblem puts a marker in runDir instead of a resolved environment: the box file names nothing this image has, or
// can't be read. Every reader then refuses it (Load), so the box runs without Link rather than quietly in the image's
// default environment; the runtime and the support service keep the image's defaults (no runtime.env, no documents).
func WriteProblem(runDir string, problem error) error {
	if err := os.MkdirAll(runDir, 0o755); err != nil {
		return err
	}
	for _, name := range []string{RuntimeEnvName, SupportCAName, ClientsKeysName, LicenceKeysName} {
		if err := os.Remove(filepath.Join(runDir, name)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	b, _ := json.Marshal(map[string]any{"v": 1, "problem": problem.Error()})
	return atomicfile.WriteFile(filepath.Join(runDir, ResolvedName), append(b, '\n'), 0o644)
}

// RuntimeEnv is the runtime's systemd environment file for r (it overrides the image's defaults in Environment=).
func RuntimeEnv(r *Resolved) string {
	// WHOMBAT_ENV is the device's env, as the image's default set it; WHOMBAT_ENVIRONMENT names the environment.
	vars := map[string]string{"WHOMBAT_ENVIRONMENT": r.Name, "WHOMBAT_ENV": r.DeviceEnv}
	if r.AppURL != "" {
		vars["WHOMBAT_APP_URL"] = r.AppURL
	}
	if r.EmbedURL != "" {
		vars["WHOMBAT_EMBED_URL"] = r.EmbedURL
	}
	for k, v := range r.Runtime {
		vars[k] = v
	}
	keys := make([]string, 0, len(vars))
	for k := range vars {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var sb strings.Builder
	for _, k := range keys {
		fmt.Fprintf(&sb, "%s=%s\n", k, vars[k])
	}
	return sb.String()
}
