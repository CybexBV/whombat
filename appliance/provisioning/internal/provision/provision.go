// Package provision is the factory provisioning flow (MA-04 §1, NX-24). It runs on the appliance itself
// (never on the station), so private keys, the claim secret and the disk recovery key are generated from
// the device's own kernel RNG and never exist anywhere else except on the printed cards.
//
// Order (each step is undone if a later one fails, so a failed run leaves an unprovisioned device):
//  1. preflight (root, /persist is its own mounted filesystem, no identity yet, Secure Boot if required)
//  2. generate management key, content identity, claim secret, master key, disk recovery key
//  3. sign the registration with both keys (contracts binding) and stage key files on /persist (fsynced)
//  4. enrol the disk recovery key on the LUKS volumes
//  5. register with control (commit point at control; 409 = duplicate serial/key → abort). Control
//     assigns the device id. Then register the claim verifier (protocol.ClaimVerifier(deviceId,
//     normalized secret), CT-43); if control does not accept it, provisioning fails before any
//     claim.json or card exists (a card whose claim control could never open must not be printed).
//  6. write the id-bound files (device.json, claim.json) and the cards, then move everything into place.
//
// If step 6 fails after control accepted the registration, control holds an orphan unclaimed entry whose
// keys were destroyed; nobody can claim or operate it and an operator retires it (runbook).
//
// Self-installed appliances (Options.SelfInstalled, CC-10, NX-33) run the same flow without a factory:
// registration through control's credential-free self-register endpoint, model "self-installed", no claim
// secret (claim.json secretHash null: only the console code can claim it), no claim verifier and no cards.
// They get no disk recovery key (PI-19, CG-31; PI-04's console hand-over is gone): no keyslot, no hash. Their
// disk is not encrypted in the machine (host-encrypted), so physical access already is data access; the
// recovery menu asks for a typed confirmation instead. A hash left by an earlier image is kept and still
// checked (internal/recoverykey).
package provision

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/CybexBV/whombat/contracts/go/device"
	"github.com/CybexBV/whombat/contracts/go/release"

	"github.com/CybexBV/whombat/appliance/provisioning/internal/card"
	"github.com/CybexBV/whombat/appliance/provisioning/internal/cardseal"
	"github.com/CybexBV/whombat/appliance/provisioning/internal/claim"
	"github.com/CybexBV/whombat/appliance/provisioning/internal/ident"
)

// Registrar registers public identities (control.Client in the factory, control.SelfClient for a
// self-installed appliance).
type Registrar interface {
	Register(ctx context.Context, reg *device.DeviceRegistration) (*device.DeviceRegistrationResponse, error)
}

// ClaimVerifierRegistrar also registers the card's claim verifier (CT-43); factory provisioning needs it.
type ClaimVerifierRegistrar interface {
	Registrar
	RegisterClaimVerifier(ctx context.Context, deviceID, verifier string) error
}

// SelfInstalledModel is the model of every self-registered appliance (CC-10).
const SelfInstalledModel = device.SelfInstalledModel

// ClaimAlgorithm names claim.json's secretHash (NX-24).
const ClaimAlgorithm = "sha256-b64url(whombat-claim-secret/1)"

// Enroller adds and removes the recovery passphrase keyslot on a LUKS volume.
type Enroller interface {
	EnrollRecovery(ctx context.Context, device, key string) error
	// WipeRecovery removes exactly the slot this key opens (never the maintenance or TPM slots).
	WipeRecovery(ctx context.Context, device, key string) error
}

// Options configure a run.
type Options struct {
	PersistDir        string
	CardDir           string
	Environment       string
	Model             string
	Serial            string
	ClaimURLBase      string
	ManagerUID        int // owner of management.key
	ManagerGID        int
	RequireMount      bool
	RequireSecureBoot bool
	SecureBootEnabled func() (bool, error)
	LUKSDevices       []string
	Enroller          Enroller
	Registrar         Registrar
	PDF               func(svg, pdf string) error
	// CardRecipient: the factory station's X25519 key. When set, the secret cards (claim, disk recovery)
	// reach the medium only encrypted (<name>.svg.sealed, .pdf.sealed); they are rendered in ScratchDir
	// (a tmpfs) and never written there in the clear (I-3). Required for prod.
	CardRecipient *ecdh.PublicKey
	ScratchDir    string // default os.TempDir(); on the device /run (tmpfs)
	Rand          io.Reader
	Now           func() time.Time
	Log           func(format string, a ...any)
	Euid          func() int // default os.Geteuid (tests)
	// SelfInstalled: self-registration without a factory (CC-10): no claim secret, no cards and no disk
	// recovery key (PI-19).
	SelfInstalled bool
	// Platform of a self-installed appliance: "factory" (default) or "self-installed" (PI-02, PI-22; the only
	// platform for self-installation in prod).
	Platform string
	// Replace (self-installed only, MG-30/NX-35): the device was retired by control while never claimed; give
	// it new keys and register it again, replacing the identity files and keeping secrets/ (master key, runner
	// token), so the runtime's never-claimed database stays readable.
	Replace bool
}

// Record is the public provisioning record (also device.json, read by helper, manager and runtime).
type Record struct {
	V                   int    `json:"v"`
	DeviceID            string `json:"deviceId"`
	Env                 string `json:"env"`
	ApplianceRoute      string `json:"applianceRoute"`
	Model               string `json:"model"`
	Serial              string `json:"serial"`
	ContentPeerID       string `json:"contentPeerId"`
	ContentPublicKey    string `json:"contentPublicKey"`
	ManagementPublicKey string `json:"managementPublicKey"`
	Fingerprint         string `json:"fingerprint"`
	ProvisionedAt       int64  `json:"provisionedAt"`
	RecoveryKeyEnrolled bool   `json:"recoveryKeyEnrolled"`
}

// ClaimFile is /persist/identity/claim.json, given to the runtime as a credential. SecretHash is null for
// a self-installed appliance (CC-10): it has no card secret, so only a console-code claim can succeed.
type ClaimFile struct {
	V          int     `json:"v"`
	DeviceID   string  `json:"deviceId"`
	SecretHash *string `json:"secretHash"` // claim.SecretHash, or null
	Algorithm  string  `json:"algorithm"`
}

// Files under <persist>/identity.
const (
	DeviceFile     = "device.json"
	ManagementKey  = "management.key"
	ManagementPub  = "management.pub"
	ContentKey     = "content.key"
	ContentPeerID  = "content.peerid"
	ClaimSecretRef = "claim.json"
	// RegistrationFile is the box's signed registration (0644 root, public: two signatures over public facts). The
	// manager sends it with link.begin when the owner turns Whombat Link on (LNK-03): the content key's proof is made
	// here, where that key is at hand, so the manager never needs the content key.
	RegistrationFile = "registration.json"
	// RunnerToken is in /persist/secrets (like master.key).
	RunnerToken = "runner-token"
)

var identityFiles = []string{DeviceFile, ManagementKey, ManagementPub, ContentKey, ContentPeerID, ClaimSecretRef}

// ErrAlreadyProvisioned is returned when any identity file exists.
var ErrAlreadyProvisioned = errors.New("this appliance already has an identity (factory-reset it first)")

func (o *Options) logf(format string, a ...any) {
	if o.Log != nil {
		o.Log(format, a...)
	}
}

// Preflight checks the device before anything is generated.
// ErrClearCardsInProd: prod provisioning needs a card recipient (the secret cards are only written sealed).
var ErrClearCardsInProd = errors.New("prod provisioning needs a card recipient (station card key): secret cards are never written in the clear")

// ErrSelfInstalledProd: in prod, self-installation runs only on the ISO image's platform (self-installed:
// host-encrypted storage, no TPM or Secure Boot needed; PI-02, PI-18). The factory platform (LUKS + TPM) is
// provisioned by the factory.
var ErrSelfInstalledProd = errors.New("self-provisioning in prod runs only on the self-installed platform (PI-02, PI-18)")

// The platforms (PI-02, PI-22). PlatformSelfInstalled: a dedicated x86_64 UEFI machine or a VM on any KVM
// hypervisor, installed from the ISO (PI-18, PI-21; was "proxmox-vm"). PlatformFactory: the Whombat device the
// factory installs and provisions (LUKS + TPM; was "hardware"), the default.
const (
	PlatformSelfInstalled = "self-installed"
	PlatformFactory       = "factory"
)

func Preflight(o *Options) error {
	switch o.Platform {
	case "", PlatformFactory, PlatformSelfInstalled:
	default:
		return fmt.Errorf("unknown platform %q", o.Platform)
	}
	if o.SelfInstalled {
		if o.Environment == "prod" && o.Platform != PlatformSelfInstalled {
			return ErrSelfInstalledProd
		}
		if len(o.LUKSDevices) > 0 {
			return errors.New("a self-installed appliance has no disk recovery key to enrol on LUKS volumes (PI-19)")
		}
		if o.Model != SelfInstalledModel {
			return fmt.Errorf("a self-installed appliance registers as model %q", SelfInstalledModel)
		}
	} else if o.Platform == PlatformSelfInstalled {
		return errors.New("factory provisioning is for the factory platform; a self-installed appliance provisions itself")
	} else if o.Environment == "prod" && o.CardRecipient == nil {
		// Whatever calls the library (station, `provision --env prod`): no clear secret cards (I-3, N-4).
		return ErrClearCardsInProd
	}
	euid := os.Geteuid
	if o.Euid != nil {
		euid = o.Euid
	}
	if euid() != 0 {
		return errors.New("provisioning must run as root on the appliance")
	}
	idDir := filepath.Join(o.PersistDir, "identity")
	if o.Replace {
		if !o.SelfInstalled {
			return errors.New("only a self-installed appliance is registered again with new keys")
		}
		for _, f := range []string{filepath.Join(idDir, DeviceFile), filepath.Join(o.PersistDir, "secrets", "master.key"),
			filepath.Join(o.PersistDir, "secrets", RunnerToken)} {
			if _, err := os.Lstat(f); err != nil {
				return fmt.Errorf("re-registration needs the existing %s: %w", f, err)
			}
		}
	} else {
		for _, f := range identityFiles {
			if _, err := os.Lstat(filepath.Join(idDir, f)); err == nil {
				return fmt.Errorf("%w: %s exists", ErrAlreadyProvisioned, f)
			}
		}
		if _, err := os.Lstat(filepath.Join(o.PersistDir, "secrets", "master.key")); err == nil {
			return fmt.Errorf("%w: secrets/master.key exists", ErrAlreadyProvisioned)
		}
	}
	if o.RequireMount {
		ok, err := isMountPoint(o.PersistDir)
		if err != nil {
			return err
		}
		if !ok {
			return fmt.Errorf("%s is not a mounted filesystem (identity would land on the root filesystem)", o.PersistDir)
		}
	} else if o.Environment == "prod" {
		return errors.New("prod provisioning requires /persist to be mounted")
	}
	if o.RequireSecureBoot {
		if o.SecureBootEnabled == nil {
			return errors.New("secure boot state unknown")
		}
		on, err := o.SecureBootEnabled()
		if err != nil {
			return fmt.Errorf("secure boot state: %w", err)
		}
		if !on {
			return errors.New("Secure Boot is not enforced; provisioning refuses (the TPM seal needs it)")
		}
	}
	if len(o.LUKSDevices) > 0 && o.Enroller == nil {
		return errors.New("LUKS devices given without an enroller")
	}
	// A factory appliance in prod never runs without a disk recovery key keyslot (its card). A self-installed
	// one has none (PI-19): its disk is not encrypted in the machine.
	if len(o.LUKSDevices) == 0 && o.Environment == "prod" && !o.SelfInstalled {
		return errors.New("prod provisioning must enrol the disk recovery key")
	}
	if o.Registrar == nil {
		return errors.New("no control registrar")
	}
	if _, ok := o.Registrar.(ClaimVerifierRegistrar); !ok && !o.SelfInstalled {
		return errors.New("factory provisioning needs a registrar that takes the claim verifier")
	}
	return nil
}

func isMountPoint(dir string) (bool, error) {
	var a, b syscall.Stat_t
	if err := syscall.Stat(dir, &a); err != nil {
		return false, err
	}
	if err := syscall.Stat(filepath.Dir(filepath.Clean(dir)), &b); err != nil {
		return false, err
	}
	return a.Dev != b.Dev, nil
}

type staged struct {
	path  string
	data  []byte
	mode  os.FileMode
	uid   int
	gid   int
	final string
}

func writeSync(path string, data []byte, mode os.FileMode, uid, gid int) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, mode)
	if err != nil {
		return err
	}
	_, err = f.Write(data)
	if err == nil {
		err = f.Chmod(mode)
	}
	if err == nil {
		err = f.Chown(uid, gid)
	}
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}

func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

// Provision runs the whole flow.
func Provision(ctx context.Context, o *Options) (rec *Record, err error) {
	if o.Rand == nil {
		o.Rand = rand.Reader
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if err := Preflight(o); err != nil {
		return nil, err
	}
	if o.ClaimURLBase == "" {
		if o.ClaimURLBase, err = claim.URLBase(o.Environment); err != nil {
			return nil, err
		}
	}
	if o.Serial == "" {
		return nil, errors.New("hardware serial is empty (set it in firmware or pass --serial)")
	}

	// 2. generate
	mgmt, err := ident.Generate(o.Rand)
	if err != nil {
		return nil, err
	}
	content, err := ident.Generate(o.Rand)
	if err != nil {
		return nil, err
	}
	if string(mgmt.Public) == string(content.Public) {
		return nil, errors.New("RNG failure: identical keys")
	}
	var secret string
	if !o.SelfInstalled {
		if secret, err = claim.NewSecret(o.Rand); err != nil {
			return nil, err
		}
	}
	// The runner token (runtime MR-37): authenticates the runner to the server; 32 random bytes as 64 hex
	// characters, root-only, passed to both units as a credential.
	var runnerToken [32]byte
	if _, err := io.ReadFull(o.Rand, runnerToken[:]); err != nil {
		return nil, err
	}
	var master [32]byte
	if _, err := io.ReadFull(o.Rand, master[:]); err != nil {
		return nil, err
	}
	// The disk recovery key: the factory's, printed on its card and enrolled on the LUKS volumes (a
	// self-installed appliance has none, PI-19).
	var recoveryKey string
	if len(o.LUKSDevices) > 0 {
		if recoveryKey, err = claim.NewRecoveryKey(o.Rand); err != nil {
			return nil, err
		}
	}
	peerID := content.PeerID()
	fp, err := ident.Fingerprint(peerID)
	if err != nil {
		return nil, err
	}

	// 3. sign and stage the key files
	reg := &device.DeviceRegistration{
		Env: release.Environment(o.Environment), HardwareSerial: o.Serial, Model: o.Model,
		ManagementPublicKey: mgmt.PublicHex(), ContentPeerID: peerID, ContentPublicKey: content.PublicHex(),
		ProvisionedAt: o.Now().Unix(),
	}
	if err := device.SignRegistration(reg, mgmt.Private, content.Private); err != nil {
		return nil, fmt.Errorf("signing the registration: %w", err)
	}
	if !device.VerifyRegistration(reg) {
		return nil, errors.New("registration does not verify")
	}
	o.logf("content identity %s (fingerprint %s)", peerID, fp)

	idDir := filepath.Join(o.PersistDir, "identity")
	secDir := filepath.Join(o.PersistDir, "secrets")
	for _, d := range []string{idDir, secDir} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return nil, err
		}
	}
	// One staging directory per target directory: /persist/identity and /persist/secrets may be
	// different filesystems (btrfs subvolumes), and rename(2) does not cross them.
	var cleanups []func()
	defer func() {
		if err != nil {
			for i := len(cleanups) - 1; i >= 0; i-- {
				cleanups[i]()
			}
		}
	}()
	stages := map[string]string{}
	stageFor := func(dir string) (string, error) {
		if st, ok := stages[dir]; ok {
			return st, nil
		}
		st, err := os.MkdirTemp(dir, ".staging-")
		if err != nil {
			return "", err
		}
		stages[dir] = st
		cleanups = append(cleanups, func() { os.RemoveAll(st) })
		return st, nil
	}

	mgmtPEM, err := mgmt.PKCS8PEM()
	if err != nil {
		return nil, err
	}
	var files []staged
	add := func(data []byte, mode os.FileMode, uid, gid int, final string) error {
		stage, err := stageFor(filepath.Dir(final))
		if err != nil {
			return err
		}
		s := staged{data: data, mode: mode, uid: uid, gid: gid, final: final,
			path: filepath.Join(stage, fmt.Sprintf("%d-%s", len(files), filepath.Base(final)))}
		if err := writeSync(s.path, s.data, s.mode, s.uid, s.gid); err != nil {
			return err
		}
		files = append(files, s)
		return nil
	}
	for _, f := range []struct {
		data  []byte
		mode  os.FileMode
		owner bool
		final string
	}{
		{mgmtPEM, 0o600, true, filepath.Join(idDir, ManagementKey)},
		{[]byte(mgmt.PublicHex() + "\n"), 0o644, false, filepath.Join(idDir, ManagementPub)},
		{content.Libp2pPrivateKey(), 0o600, false, filepath.Join(idDir, ContentKey)},
		{[]byte(peerID + "\n"), 0o644, false, filepath.Join(idDir, ContentPeerID)},
		{[]byte(base64.StdEncoding.EncodeToString(master[:]) + "\n"), 0o600, false, filepath.Join(secDir, "master.key")},
		{[]byte(hex.EncodeToString(runnerToken[:]) + "\n"), 0o600, false, filepath.Join(secDir, RunnerToken)},
	} {
		if o.Replace && filepath.Dir(f.final) == secDir {
			continue // re-registration keeps the secrets
		}
		uid, gid := -1, -1 // root-owned: created by the (root) process itself
		if f.owner {
			uid, gid = o.ManagerUID, o.ManagerGID
		}
		if err := add(f.data, f.mode, uid, gid, f.final); err != nil {
			return nil, err
		}
	}

	// 4. disk recovery key: its keyslots (LUKS)
	for _, dev := range o.LUKSDevices {
		o.logf("enrolling the disk recovery key on %s", dev)
		if err := o.Enroller.EnrollRecovery(ctx, dev, recoveryKey); err != nil {
			return nil, fmt.Errorf("recovery key on %s: %w", dev, err)
		}
		cleanups = append(cleanups, func() { _ = o.Enroller.WipeRecovery(context.Background(), dev, recoveryKey) })
	}

	// 5. register (control assigns the device id)
	o.logf("registering with control")
	resp, err := o.Registrar.Register(ctx, reg)
	if err != nil {
		return nil, err
	}
	deviceID := resp.Device
	rec = &Record{
		V: 1, DeviceID: deviceID, Env: o.Environment, ApplianceRoute: resp.ApplianceRoute, Model: o.Model,
		Serial: o.Serial, ContentPeerID: peerID, ContentPublicKey: content.PublicHex(),
		ManagementPublicKey: mgmt.PublicHex(), Fingerprint: fp, ProvisionedAt: reg.ProvisionedAt,
		RecoveryKeyEnrolled: recoveryKey != "",
	}
	o.logf("control registered appliance %s", deviceID)
	cf := ClaimFile{V: 1, DeviceID: deviceID, Algorithm: ClaimAlgorithm}
	if !o.SelfInstalled {
		verifier, err := claim.Verifier(deviceID, secret)
		if err != nil {
			return nil, fmt.Errorf("claim verifier: %w", err)
		}
		if err := o.Registrar.(ClaimVerifierRegistrar).RegisterClaimVerifier(ctx, deviceID, verifier); err != nil {
			return nil, fmt.Errorf("registering the claim verifier (no claim.json or card written): %w", err)
		}
		o.logf("control holds the claim verifier for %s", deviceID)
		h := claim.SecretHash(deviceID, secret)
		cf.SecretHash = &h
	}

	// 6. id-bound files and cards, then commit
	devJSON, _ := json.MarshalIndent(rec, "", "  ")
	claimJSON, _ := json.MarshalIndent(cf, "", "  ")
	if err := add(append(claimJSON, '\n'), 0o600, -1, -1, filepath.Join(idDir, ClaimSecretRef)); err != nil {
		return nil, err
	}
	regJSON, _ := json.Marshal(reg)
	if err := add(append(regJSON, '\n'), 0o644, -1, -1, filepath.Join(idDir, RegistrationFile)); err != nil {
		return nil, err
	}
	// device.json last: its presence means "provisioned".
	if err := add(append(devJSON, '\n'), 0o644, -1, -1, filepath.Join(idDir, DeviceFile)); err != nil {
		return nil, err
	}
	for _, st := range stages {
		if err := syncDir(st); err != nil {
			return nil, err
		}
	}
	if o.SelfInstalled {
		if err := commit(files, idDir, secDir, stages, &cleanups, o.Replace); err != nil {
			return nil, err
		}
		return rec, nil
	}

	if err := os.MkdirAll(o.CardDir, 0o700); err != nil {
		return nil, err
	}
	claimSVG, err := card.ClaimSVG(card.Claim{
		DeviceID: deviceID, Secret: claim.Display(secret),
		URL: claim.URL(o.ClaimURLBase, deviceID, peerID, secret), Environment: o.Environment,
		Model: o.Model, Serial: o.Serial,
	})
	if err != nil {
		return nil, err
	}
	outputs := []struct {
		name string
		data []byte
	}{
		{"claim-" + deviceID + ".svg", []byte(claimSVG)},
		{"record-" + deviceID + ".json", append(devJSON, '\n')},
	}
	if recoveryKey != "" {
		outputs = append(outputs, struct {
			name string
			data []byte
		}{"disk-recovery-" + deviceID + ".svg", []byte(card.RecoverySVG(card.Recovery{DeviceID: deviceID, Key: recoveryKey, Serial: o.Serial}))})
	}
	var written []string
	isSecret := func(name string) bool { return !strings.HasPrefix(name, "record-") }
	var scratch string
	if o.CardRecipient != nil {
		base := o.ScratchDir
		if base == "" {
			base = os.TempDir()
		}
		if scratch, err = os.MkdirTemp(base, "whombat-cards-"); err != nil {
			return nil, err
		}
		defer os.RemoveAll(scratch)
	}
	for _, out := range outputs {
		if o.CardRecipient != nil && isSecret(out.name) {
			// Render in the scratch tmpfs, write only ciphertext to the medium.
			svg := filepath.Join(scratch, out.name)
			if err := writeSync(svg, out.data, 0o600, -1, -1); err != nil {
				return nil, err
			}
			plain := map[string][]byte{out.name: out.data}
			if o.PDF != nil {
				pdf := svg[:len(svg)-4] + ".pdf"
				if perr := o.PDF(svg, pdf); perr != nil {
					o.logf("PDF rendering failed (SVG kept): %v", perr)
				} else if b, err := os.ReadFile(pdf); err == nil {
					plain[filepath.Base(pdf)] = b
				}
			}
			for name, b := range plain {
				sealed, err := cardseal.Seal(o.Rand, o.CardRecipient, b)
				if err != nil {
					return nil, err
				}
				p := filepath.Join(o.CardDir, name+cardseal.Suffix)
				if err := writeSync(p, sealed, 0o600, -1, -1); err != nil {
					return nil, fmt.Errorf("writing %s: %w", name, err)
				}
				cleanups = append(cleanups, func() { os.Remove(p) })
			}
			continue
		}
		p := filepath.Join(o.CardDir, out.name)
		if err := writeSync(p, out.data, 0o600, -1, -1); err != nil {
			return nil, fmt.Errorf("writing %s: %w", out.name, err)
		}
		written = append(written, p)
		cleanups = append(cleanups, func() { os.Remove(p) })
	}
	if err := syncDir(o.CardDir); err != nil {
		return nil, err
	}

	if err := commit(files, idDir, secDir, stages, &cleanups, o.Replace); err != nil {
		return nil, err
	}
	for _, p := range written {
		if o.PDF != nil && filepath.Ext(p) == ".svg" {
			if perr := o.PDF(p, p[:len(p)-4]+".pdf"); perr != nil {
				o.logf("PDF rendering failed (SVG kept): %v", perr)
			}
		}
	}
	return rec, nil
}

// commit moves the staged files into place (device.json last) and removes the staging directories.
// A replacement (Options.Replace) keeps what it already renamed: removing it would leave no identity at all.
func commit(files []staged, idDir, secDir string, stages map[string]string, cleanups *[]func(), replace bool) error {
	for _, f := range files {
		if err := os.Rename(f.path, f.final); err != nil {
			return fmt.Errorf("committing %s: %w", f.final, err)
		}
		if !replace {
			*cleanups = append(*cleanups, func() { os.Remove(f.final) })
		}
	}
	for _, st := range stages {
		if err := syncDir(filepath.Dir(st)); err != nil {
			return err
		}
	}
	for _, st := range stages {
		_ = os.Remove(st)
	}
	return nil
}
