// Command whombat-provision creates an appliance's identities on the appliance (NX-24).
//
//	whombat-provision provision --env dev --control-url URL --token-file F --card-dir DIR [--luks DEV]...
//	whombat-provision station [--medium /run/whombat-factory]    (factory medium: station.json)
//	whombat-provision self [--config /etc/whombat/self-provision.json]   (self-installed: CC-10, NX-33; a community
//	        box, `"edition": "community"`, makes its identity without control: NX-445)
//	whombat-provision verify [--persist /persist] [--manager-uid N --root-uid N]
//
// Development / integration harness (never prod): run as an ordinary user into a directory with
//
//	whombat-provision provision --env local --unprivileged --persist ./state/persist --card-dir ./cards \
//	  --manager-uid $(id -u) --manager-gid $(id -g) --allow-unmounted --require-secure-boot=false \
//	  --serial DEV-0001 --control-url http://127.0.0.1:4600 --token-file ./token
//	whombat-provision verify --persist ./state/persist --manager-uid $(id -u) --root-uid $(id -u)
//	whombat-provision fingerprint <PeerId>
//	whombat-provision reset-keyslots --device DEV --maint-key FILE [--rotate]   (factory reset; N-7)
//	whombat-provision recovery-key check [--persist /persist] < KEY   (exit 0: the disk recovery key; PI-04)
//	whombat-provision recovery-key drop-pending [--persist /persist]  (root: the key an earlier image left for the console)
//	whombat-provision card-key                       (station: new card key pair; keep the private key)
//	whombat-provision open-card --key FILE CARD.sealed > CARD   (station: decrypt a sealed card to print)
package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"github.com/CybexBV/whombat/appliance/internal/environment"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"os/user"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/CybexBV/whombat/appliance/provisioning/internal/cardseal"
	"github.com/CybexBV/whombat/appliance/provisioning/internal/control"
	"github.com/CybexBV/whombat/appliance/provisioning/internal/ident"
	"github.com/CybexBV/whombat/appliance/provisioning/internal/keyslots"
	"github.com/CybexBV/whombat/appliance/provisioning/internal/provision"
)

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	var err error
	switch os.Args[1] {
	case "provision":
		err = cmdProvision(ctx, os.Args[2:])
	case "station":
		err = cmdStation(ctx, os.Args[2:])
	case "self":
		err = cmdSelf(ctx, os.Args[2:])
	case "verify":
		err = cmdVerify(os.Args[2:])
	case "card-key":
		var priv, pub string
		if priv, pub, err = cardseal.GenerateKey(nil); err == nil {
			fmt.Printf("private (station only, keep secret): %s\npublic (station.json cardRecipient): %s\n", priv, pub)
		}
	case "open-card":
		err = cmdOpenCard(os.Args[2:])
	case "reset-keyslots":
		err = cmdResetKeyslots(ctx, os.Args[2:])
	case "recovery-key":
		err = cmdRecoveryKey(os.Args[2:])
	case "fingerprint":
		if len(os.Args) != 3 {
			usage()
		}
		var fp string
		if fp, err = ident.Fingerprint(os.Args[2]); err == nil {
			fmt.Println(fp)
		}
	default:
		usage()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "whombat-provision:", err)
		if errors.Is(err, ErrRefused) {
			os.Exit(3)
		}
		if errors.Is(err, ErrWrongKey) {
			os.Exit(4)
		}
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: whombat-provision provision|station|self|verify|recovery-key|fingerprint ...")
	os.Exit(2)
}

type multi []string

func (m *multi) String() string     { return strings.Join(*m, ",") }
func (m *multi) Set(s string) error { *m = append(*m, s); return nil }

// Settings are the station-provided parameters (flags or station.json).
type Settings struct {
	V                 int      `json:"v"`
	Environment       string   `json:"environment"`
	ControlURL        string   `json:"controlUrl"`
	TokenFile         string   `json:"tokenFile"` // relative to the medium for station.json
	Model             string   `json:"model"`
	Serial            string   `json:"serial"` // override; default from firmware (DMI)
	ClaimURLBase      string   `json:"claimUrlBase"`
	LUKSDevices       []string `json:"luksDevices"`
	RequireSecureBoot *bool    `json:"requireSecureBoot"`
	AllowUnmounted    bool     `json:"allowUnmounted"`
	ManagerUser       string   `json:"managerUser"` // default whombat-manager
	// CardRecipient is the station's card key (base64 X25519): the secret cards reach the medium only
	// encrypted to it (I-3). Required for prod.
	CardRecipient string `json:"cardRecipient"`
	// Used by the factory unit after identity provisioning (MG-20), not by this tool:
	FactoryRelease string `json:"factoryRelease"` // release id of the installed tuple
	SeedHelper     *bool  `json:"seedHelper"`     // run `whombat-update-helper seed-factory` (default true)
	// Platform (self-provisioning only): "factory" (default) or "self-installed" (PI-02, PI-22; no Secure Boot, no
	// LUKS).
	Platform string `json:"platform"`
	// Edition (self-provisioning only): "" or "commercial" registers with control; "community" makes the identity on
	// the box without control (Whombat HE-58, NX-445: provision.LocalRegistrar), and needs no controlUrl.
	Edition string `json:"edition"`
	// EnvironmentDir (self-provisioning only) is the resolved environment's folder (/run/whombat/environment, LNK-01a):
	// when it holds one, the identity gets that environment's device env instead of the image's, so a box the
	// installer's developer option put on the development stack registers there when it turns Link on.
	EnvironmentDir string `json:"environmentDir"`
	ManagerUID     *int   `json:"-"`
	ManagerGID     *int   `json:"-"`
	Unprivileged   bool   `json:"-"`
}

func cmdProvision(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("provision", flag.ExitOnError)
	var s Settings
	var luks multi
	persist := fs.String("persist", "/persist", "persistent-state mount point")
	cardDir := fs.String("card-dir", "", "where to write the cards and the public record")
	requireSB := fs.Bool("require-secure-boot", true, "refuse unless Secure Boot is enforced")
	fs.StringVar(&s.Environment, "env", "", "local | dev | prod")
	fs.StringVar(&s.ControlURL, "control-url", "", "control base URL")
	fs.StringVar(&s.TokenFile, "token-file", "", "file with the station's provisioning token")
	fs.StringVar(&s.Model, "model", "whombat-one", "hardware model id (contracts HardwareModel)")
	fs.StringVar(&s.Serial, "serial", "", "hardware serial (default: firmware DMI serial)")
	fs.StringVar(&s.ClaimURLBase, "claim-url-base", "", "claim page (default per environment)")
	fs.BoolVar(&s.AllowUnmounted, "allow-unmounted", false, "development: allow a /persist that isn't its own filesystem")
	fs.Var(&luks, "luks", "LUKS2 device to enrol the disk recovery key on (repeat)")
	fs.StringVar(&s.ManagerUser, "manager-user", "whombat-manager", "owner of management.key")
	muid := fs.Int("manager-uid", -1, "owner uid of management.key (instead of --manager-user)")
	mgid := fs.Int("manager-gid", -1, "owner gid of management.key (with --manager-uid)")
	fs.BoolVar(&s.Unprivileged, "unprivileged", false, "development: allow running as a non-root user (local/dev only)")
	_ = fs.Parse(args)
	if *muid >= 0 {
		s.ManagerUID, s.ManagerGID = muid, mgid
		if *mgid < 0 {
			s.ManagerGID = muid
		}
	}
	s.LUKSDevices = luks
	s.RequireSecureBoot = requireSB
	if *cardDir == "" {
		return errors.New("--card-dir is required")
	}
	return run(ctx, s, *persist, *cardDir)
}

// cmdStation reads station.json from a factory medium (mounted by whombat-factory-provision.service),
// provisions, and writes the cards back onto the medium.
func cmdStation(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("station", flag.ExitOnError)
	medium := fs.String("medium", "/run/whombat-factory", "mounted factory medium")
	persist := fs.String("persist", "/persist", "persistent-state mount point")
	_ = fs.Parse(args)
	b, err := os.ReadFile(filepath.Join(*medium, "station.json"))
	if err != nil {
		return err
	}
	var s Settings
	dec := json.NewDecoder(strings.NewReader(string(b)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&s); err != nil || s.V != 1 {
		return fmt.Errorf("station.json: invalid (%v)", err)
	}
	if s.TokenFile != "" && !filepath.IsAbs(s.TokenFile) {
		s.TokenFile = filepath.Join(*medium, s.TokenFile)
	}
	cardDir := filepath.Join(*medium, "cards")
	if _, err := os.Stat(filepath.Join(*persist, "identity", provision.DeviceFile)); err == nil {
		fmt.Println("already provisioned; nothing to do")
		return nil
	}
	return run(ctx, s, *persist, cardDir)
}

// base checks the settings both modes share and builds the common options (serial, owners, Secure Boot).
func base(s Settings, persist string) (o *provision.Options, uid, rootUID int, err error) {
	switch s.Environment {
	case "local", "dev", "prod":
	default:
		return nil, 0, 0, errors.New("environment must be local, dev or prod")
	}
	if s.Unprivileged && s.Environment == "prod" {
		return nil, 0, 0, errors.New("--unprivileged is for local/dev only")
	}
	var gid int
	if s.ManagerUID != nil {
		uid, gid = *s.ManagerUID, *s.ManagerGID
	} else {
		name := s.ManagerUser
		if name == "" {
			name = "whombat-manager"
		}
		if uid, gid, err = lookup(name); err != nil {
			return nil, 0, 0, err
		}
	}
	requireSB := s.RequireSecureBoot == nil || *s.RequireSecureBoot
	// prod requires Secure Boot, except on the self-installed platform, which has none by design (PI-02: its keys
	// are generated but not enrolled; encryption at rest is the owner's, PI-20).
	if s.Environment == "prod" && s.Platform != provision.PlatformSelfInstalled {
		requireSB = true
	}
	o = &provision.Options{
		PersistDir: persist, Environment: s.Environment, Model: s.Model, Platform: s.Platform,
		ManagerUID: uid, ManagerGID: gid,
		RequireMount: !s.AllowUnmounted, RequireSecureBoot: requireSB, SecureBootEnabled: secureBootEnabled,
		Log: func(f string, a ...any) { fmt.Printf(f+"\n", a...) },
	}
	if s.Unprivileged {
		o.Euid = func() int { return 0 }
		rootUID = os.Geteuid()
	}
	return o, uid, rootUID, nil
}

func run(ctx context.Context, s Settings, persist, cardDir string) error {
	o, uid, rootUID, err := base(s, persist)
	if err != nil {
		return err
	}
	serial := s.Serial
	if serial == "" {
		serial = firmwareSerial()
	}
	// Contracts HardwareSerial: upper-case letters, digits and dashes.
	o.Serial = strings.ToUpper(strings.TrimSpace(serial))
	if s.Environment == "prod" && s.CardRecipient == "" {
		return errors.New("prod needs cardRecipient: secret cards are never written to the medium in the clear")
	}
	if s.Platform != "" && s.Platform != provision.PlatformFactory {
		return errors.New("factory provisioning is for the factory platform; a self-installed appliance provisions itself (self)")
	}
	o.CardDir, o.ClaimURLBase = cardDir, s.ClaimURLBase
	o.LUKSDevices, o.Enroller, o.PDF = s.LUKSDevices, cryptenroll{}, rsvgPDF
	if s.CardRecipient != "" {
		k, err := cardseal.ParsePublicKey(s.CardRecipient)
		if err != nil {
			return err
		}
		o.CardRecipient = k
		if st, err := os.Stat("/run"); err == nil && st.IsDir() && !s.Unprivileged {
			o.ScratchDir = "/run" // tmpfs: the clear cards never touch a persistent medium
		}
	}
	if s.ControlURL == "" || s.TokenFile == "" {
		return errors.New("control URL and token file are required")
	}
	tok, err := os.ReadFile(s.TokenFile)
	if err != nil {
		return fmt.Errorf("token file: %w", err)
	}
	o.Registrar = &control.Client{BaseURL: s.ControlURL, Token: strings.TrimSpace(string(tok))}
	rec, err := provision.Provision(ctx, o)
	if err != nil {
		return err
	}
	if _, err := provision.VerifyOwned(persist, uid, rootUID); err != nil {
		return fmt.Errorf("provisioned, but verification failed: %w", err)
	}
	fmt.Printf("provisioned %s (%s), cards in %s\n", rec.DeviceID, rec.Fingerprint, cardDir)
	return nil
}

// cmdSelf provisions a self-installed appliance (CC-10, NX-33): the same identities and on-disk layout as
// the factory, registered through control's credential-free self-register endpoint. Settings come from
// the NixOS-generated /etc/whombat/self-provision.json (station.json's format without token, cards or
// release); flags override them for development runs.
func cmdSelf(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("self", flag.ExitOnError)
	config := fs.String("config", "/etc/whombat/self-provision.json", "settings (station.json format; empty: flags only)")
	persist := fs.String("persist", "/persist", "persistent-state mount point")
	env := fs.String("env", "", "local | dev | prod (overrides the config)")
	controlURL := fs.String("control-url", "", "control base URL (overrides the config)")
	serial := fs.String("serial", "", "hardware serial (default: firmware DMI serial, else derived from the machine id)")
	allowUnmounted := fs.Bool("allow-unmounted", false, "development: allow a /persist that isn't its own filesystem")
	requireSB := fs.String("require-secure-boot", "", "true|false (overrides the config; prod always requires it)")
	managerUser := fs.String("manager-user", "", "owner of management.key (default whombat-manager)")
	muid := fs.Int("manager-uid", -1, "owner uid of management.key (instead of --manager-user)")
	mgid := fs.Int("manager-gid", -1, "owner gid of management.key (with --manager-uid)")
	unprivileged := fs.Bool("unprivileged", false, "development: allow running as a non-root user (local/dev only)")
	reregister := fs.String("reregister", "", "the manager's re-registration request (MG-30): new keys for a retired, never-claimed appliance")
	claimState := fs.String("manager-claim-state", "", "with --reregister: the manager's claim-state.json (refuse when it says claimed)")
	platform := fs.String("platform", "", "factory | self-installed (overrides the config)")
	_ = fs.Parse(args)
	var s Settings
	if *config != "" {
		b, err := os.ReadFile(*config)
		if err != nil && !(os.IsNotExist(err) && *env != "" && *controlURL != "") {
			return err
		}
		if err == nil {
			if s, err = parseSelfSettings(b); err != nil {
				return fmt.Errorf("%s: %w", *config, err)
			}
		}
	}
	if *env != "" {
		s.Environment = *env
	}
	if *controlURL != "" {
		s.ControlURL = *controlURL
	}
	if *serial != "" {
		s.Serial = *serial
	}
	if *managerUser != "" {
		s.ManagerUser = *managerUser
	}
	s.AllowUnmounted = s.AllowUnmounted || *allowUnmounted
	if *requireSB != "" {
		v, err := strconv.ParseBool(*requireSB)
		if err != nil {
			return fmt.Errorf("--require-secure-boot: %w", err)
		}
		s.RequireSecureBoot = &v
	}
	if *muid >= 0 {
		s.ManagerUID, s.ManagerGID = muid, mgid
		if *mgid < 0 {
			s.ManagerGID = muid
		}
	}
	s.Unprivileged = *unprivileged
	if *platform != "" {
		s.Platform = *platform
	}
	if *reregister != "" {
		return reregisterSelf(ctx, s, *persist, *reregister, *claimState)
	}
	if _, err := os.Stat(filepath.Join(*persist, "identity", provision.DeviceFile)); err == nil {
		fmt.Println("already provisioned; nothing to do")
		return nil
	}
	return runSelf(ctx, s, *persist)
}

// parseSelfSettings reads the self-provisioning settings: station.json's format, but nothing that belongs
// to a factory (token, cards, recovery key volumes, factory release). A self-installed appliance has no disk
// recovery key (PI-19), so no LUKS volumes to enrol one on.
func parseSelfSettings(b []byte) (Settings, error) {
	var s Settings
	dec := json.NewDecoder(strings.NewReader(string(b)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&s); err != nil || s.V != 1 {
		return Settings{}, fmt.Errorf("invalid settings (%v)", err)
	}
	if s.TokenFile != "" || s.CardRecipient != "" || s.ClaimURLBase != "" || s.FactoryRelease != "" || s.SeedHelper != nil || len(s.LUKSDevices) > 0 {
		return Settings{}, errors.New("tokenFile, cardRecipient, claimUrlBase, factoryRelease, seedHelper and luksDevices are factory settings")
	}
	switch s.Platform {
	case "", provision.PlatformFactory, provision.PlatformSelfInstalled:
	default:
		return Settings{}, fmt.Errorf("unknown platform %q", s.Platform)
	}
	switch {
	case s.Edition != "" && s.Edition != "commercial" && s.Edition != "community":
		return Settings{}, fmt.Errorf("unknown edition %q", s.Edition)
	case s.Edition == "community" && s.ControlURL != "":
		return Settings{}, errors.New("a community box has no control: no controlUrl")
	}
	if s.Model != "" && s.Model != provision.SelfInstalledModel {
		return Settings{}, fmt.Errorf("a self-installed appliance registers as model %q", provision.SelfInstalledModel)
	}
	return s, nil
}

// ErrRefused: a re-registration request that must not be acted on (exit status 3; the unit drops it).
var ErrRefused = errors.New("re-registration refused")

// reregisterSelf gives a retired, never-claimed self-installed appliance new keys and registers it again
// (MG-30, NX-35; control takes the same serial with new keys, CL-34). The request comes from the manager, a
// less privileged user: it is read without following links and only names the device; everything that
// decides is checked here again (the caller has already asked the runtime whether it is claimed, and
// stopped it).
func reregisterSelf(ctx context.Context, s Settings, persist, reqPath, claimStatePath string) error {
	var req struct {
		V        int    `json:"v"`
		DeviceID string `json:"deviceId"`
		Reason   string `json:"reason"`
	}
	b, err := readNoFollow(reqPath, 4096)
	if err != nil {
		return err
	}
	if json.Unmarshal(b, &req) != nil || req.V != 1 || req.Reason != "device_retired" {
		return fmt.Errorf("%w: malformed request", ErrRefused)
	}
	var rec provision.Record
	db, err := os.ReadFile(filepath.Join(persist, "identity", provision.DeviceFile))
	if err != nil || json.Unmarshal(db, &rec) != nil {
		return fmt.Errorf("%w: no readable device.json", ErrRefused)
	}
	if rec.Model != provision.SelfInstalledModel || rec.DeviceID != req.DeviceID {
		return fmt.Errorf("%w: device %s (%s) is not the self-installed device of the request", ErrRefused, rec.DeviceID, rec.Model)
	}
	if claimStatePath != "" {
		if cb, err := readNoFollow(claimStatePath, 4096); err == nil {
			var cs struct {
				Claimed bool `json:"claimed"`
			}
			if json.Unmarshal(cb, &cs) != nil || cs.Claimed {
				return fmt.Errorf("%w: the manager has seen this device claimed", ErrRefused)
			}
		} else if !os.IsNotExist(err) {
			return err
		}
	}
	if s.Edition == "community" || s.ControlURL == "" {
		// Every image makes its identity on the box (Whombat LNK-01): control registered nothing for it, so there is
		// nothing to register again. The request is dropped (exit 3) and the box keeps its identity; failing instead made
		// the unit retry for ever, stopping the manager and the runtime at every try.
		return fmt.Errorf("%w: %s made its own identity and has nothing to register again", ErrRefused, rec.DeviceID)
	}
	if s.Serial == "" {
		s.Serial = rec.Serial
	}
	fmt.Printf("control retired %s while it was never claimed: new keys and a new self-registration\n", rec.DeviceID)
	return runSelfOpts(ctx, s, persist, true)
}

func readNoFollow(path string, limit int64) ([]byte, error) {
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if st, err := f.Stat(); err != nil || !st.Mode().IsRegular() {
		return nil, fmt.Errorf("%s: not a regular file", path)
	}
	return io.ReadAll(io.LimitReader(f, limit))
}

func runSelf(ctx context.Context, s Settings, persist string) error {
	return runSelfOpts(ctx, s, persist, false)
}

func runSelfOpts(ctx context.Context, s Settings, persist string, replace bool) error {
	s.Model = provision.SelfInstalledModel
	if s.EnvironmentDir != "" {
		r, err := environment.Load(s.EnvironmentDir)
		switch {
		case err == nil:
			s.Environment = r.DeviceEnv
		case !errors.Is(err, os.ErrNotExist):
			// A box file that doesn't resolve must not give the box an identity for the wrong environment.
			return fmt.Errorf("the environment: %w", err)
		}
	}
	o, uid, rootUID, err := base(s, persist)
	if err != nil {
		return err
	}
	o.SelfInstalled, o.Replace = true, replace
	if o.Serial, err = selfSerial(s.Serial); err != nil {
		return err
	}
	switch {
	case s.Edition == "community" || s.ControlURL == "":
		// Every image makes its identity on the box (Whombat LNK-01): control first hears of a box when its owner turns
		// Whombat Link on (link.begin carries this registration).
		if replace {
			return fmt.Errorf("%w: a box that made its own identity has nothing to register again", ErrRefused)
		}
		o.Registrar = provision.LocalRegistrar{}
	default:
		o.Registrar = &control.SelfClient{BaseURL: s.ControlURL}
	}
	rec, err := provision.Provision(ctx, o)
	if err != nil {
		return err
	}
	if _, err := provision.VerifyOwned(persist, uid, rootUID); err != nil {
		return fmt.Errorf("provisioned, but verification failed: %w", err)
	}
	if s.Edition == "community" || s.ControlURL == "" {
		fmt.Printf("provisioned %s (its own identity, serial %s)\n", rec.DeviceID, rec.Serial)
		fmt.Println("Claim it with the code on its screen, from its own page on your network.")
		return nil
	}
	fmt.Printf("provisioned %s (self-installed, serial %s)\n", rec.DeviceID, rec.Serial)
	fmt.Println("Claim it with the code on its console. There is no claim card: control holds no card verifier and")
	fmt.Println("claim.json has no card secret (CC-10).")
	return nil
}

// selfSerial is the hardware serial of a self-installed appliance: the given one, the firmware (DMI)
// serial when it fits the contracts' HardwareSerial (upper-case letters, digits, dashes; 4–64), else one
// derived from the machine id (keyed, so the machine id itself never leaves the box).
func selfSerial(given string) (string, error) {
	if given != "" {
		return validSerial(strings.ToUpper(strings.TrimSpace(given)))
	}
	if s, err := validSerial(strings.ToUpper(strings.TrimSpace(firmwareSerial()))); err == nil {
		return s, nil
	}
	b, err := os.ReadFile("/etc/machine-id")
	if err != nil {
		return "", fmt.Errorf("no usable firmware serial and no machine id: %w", err)
	}
	return machineSerial(strings.TrimSpace(string(b)))
}

var serialRe = regexp.MustCompile(`^[A-Z0-9-]{4,64}$`)

func validSerial(s string) (string, error) {
	if !serialRe.MatchString(s) {
		return "", fmt.Errorf("hardware serial %q is not upper-case letters, digits and dashes (4–64)", s)
	}
	return s, nil
}

// machineSerial derives "MID-" + 20 hex digits from the machine id (systemd's app-specific id idea: an
// HMAC keyed by the machine id over a fixed application tag).
func machineSerial(machineID string) (string, error) {
	if len(machineID) != 32 {
		return "", errors.New("machine id is not 32 hex digits")
	}
	if _, err := hex.DecodeString(machineID); err != nil {
		return "", errors.New("machine id is not 32 hex digits")
	}
	m := hmac.New(sha256.New, []byte(machineID))
	m.Write([]byte("whombat-hardware-serial/1"))
	return "MID-" + strings.ToUpper(hex.EncodeToString(m.Sum(nil))[:20]), nil
}

func cmdOpenCard(args []string) error {
	fs := flag.NewFlagSet("open-card", flag.ExitOnError)
	keyFile := fs.String("key", "", "file with the station's private card key")
	_ = fs.Parse(args)
	if *keyFile == "" || fs.NArg() != 1 {
		return errors.New("open-card --key FILE CARD.sealed")
	}
	kb, err := os.ReadFile(*keyFile)
	if err != nil {
		return err
	}
	priv, err := cardseal.ParsePrivateKey(string(kb))
	if err != nil {
		return err
	}
	sealed, err := os.ReadFile(fs.Arg(0))
	if err != nil {
		return err
	}
	plain, err := cardseal.Open(priv, sealed)
	if err != nil {
		return err
	}
	_, err = os.Stdout.Write(plain)
	return err
}

func cmdVerify(args []string) error {
	fs := flag.NewFlagSet("verify", flag.ExitOnError)
	persist := fs.String("persist", "/persist", "persistent-state mount point")
	muid := fs.Int("manager-uid", -1, "expected owner of management.key (default: the whombat-manager user)")
	ruid := fs.Int("root-uid", 0, "expected owner of the root-owned files (development runs)")
	_ = fs.Parse(args)
	uid := *muid
	if uid < 0 {
		var err error
		if uid, _, err = lookup("whombat-manager"); err != nil {
			return err
		}
	}
	rec, err := provision.VerifyOwned(*persist, uid, *ruid)
	if err != nil {
		return err
	}
	b, _ := json.MarshalIndent(rec, "", "  ")
	fmt.Println(string(b))
	return nil
}

func lookup(name string) (int, int, error) {
	u, err := user.Lookup(name)
	if err != nil {
		return 0, 0, err
	}
	uid, _ := strconv.Atoi(u.Uid)
	gid, _ := strconv.Atoi(u.Gid)
	return uid, gid, nil
}

func firmwareSerial() string {
	for _, f := range []string{"product_serial", "board_serial", "chassis_serial"} {
		b, err := os.ReadFile("/sys/class/dmi/id/" + f)
		if err != nil {
			continue
		}
		s := strings.TrimSpace(string(b))
		switch strings.ToLower(s) {
		case "", "none", "0", "not specified", "to be filled by o.e.m.", "default string", "system serial number":
			continue
		}
		return s
	}
	return ""
}

func secureBootEnabled() (bool, error) {
	b, err := os.ReadFile("/sys/firmware/efi/efivars/SecureBoot-8be4df61-93ca-11d2-aa0d-00e098032b8c")
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	return len(b) == 5 && b[4] == 1, nil
}

// cryptenroll adds the recovery key as a passphrase keyslot. It unlocks with the volume's maintenance key
// (/var/lib/whombat-storage/maint-<volume>.key): the TPM only unseals in the initrd (NX-12). Without a
// maintenance key (a device not sealed yet) it unlocks with the TPM2 slot.
type cryptenroll struct{}

// MaintKeyDir holds the maintenance keys.
const MaintKeyDir = "/var/lib/whombat-storage"

func unlockArg(dev string) string {
	if strings.HasPrefix(dev, "/dev/disk/by-partlabel/") {
		k := filepath.Join(MaintKeyDir, "maint-"+filepath.Base(dev)+".key")
		if st, err := os.Stat(k); err == nil && st.Mode().IsRegular() && st.Size() > 0 {
			return "--unlock-key-file=" + k
		}
	}
	return "--unlock-tpm2-device=auto"
}

func (cryptenroll) EnrollRecovery(ctx context.Context, dev, key string) error {
	cmd := exec.CommandContext(ctx, "systemd-cryptenroll", unlockArg(dev), "--password", dev)
	cmd.Env = append(os.Environ(), "NEWPASSWORD="+key)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%v: %s", err, strings.TrimSpace(string(out)))
	}
	// The new owner's key is the only passphrase besides the maintenance key: a previous owner's
	// recovery key (left on the system volume by a factory reset) goes (N-7).
	if a := unlockArg(dev); strings.HasPrefix(a, "--unlock-key-file=") {
		res, err := keyslots.Reset(ctx, runCryptsetup, keyslots.Options{Device: dev,
			MaintKey: strings.TrimPrefix(a, "--unlock-key-file="), Keep: []string{key}})
		if err != nil {
			return fmt.Errorf("remove other keys from %s: %w", dev, err)
		}
		if len(res.Killed) > 0 {
			fmt.Printf("%s: removed key slot(s) %v of a previous owner\n", dev, res.Killed)
		}
	}
	return nil
}

func runCryptsetup(ctx context.Context, stdin string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "cryptsetup", args...)
	cmd.Stdin = strings.NewReader(stdin)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func cmdResetKeyslots(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("reset-keyslots", flag.ExitOnError)
	dev := fs.String("device", "", "LUKS2 volume")
	maint := fs.String("maint-key", "", "maintenance key file of the volume")
	rotate := fs.Bool("rotate", false, "replace the maintenance key too")
	_ = fs.Parse(args)
	if *dev == "" || *maint == "" {
		return errors.New("reset-keyslots --device DEV --maint-key FILE [--rotate]")
	}
	res, err := keyslots.Reset(ctx, runCryptsetup, keyslots.Options{Device: *dev, MaintKey: *maint, Rotate: *rotate})
	if err != nil {
		return err
	}
	fmt.Printf("%s: removed key slot(s) %v; maintenance key rotated: %v\n", *dev, res.Killed, res.Rotated)
	return nil
}

func (cryptenroll) WipeRecovery(ctx context.Context, dev, key string) error {
	cmd := exec.CommandContext(ctx, "cryptsetup", "luksRemoveKey", "--batch-mode", "--key-file=-", dev)
	cmd.Stdin = strings.NewReader(key)
	return cmd.Run()
}

func rsvgPDF(svg, pdf string) error {
	bin, err := exec.LookPath("rsvg-convert")
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, "-f", "pdf", "-o", pdf, svg).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%v: %s", err, out)
	}
	return nil
}
