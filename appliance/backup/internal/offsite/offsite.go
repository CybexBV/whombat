// Package offsite keeps a second copy of this Whombat's backups somewhere else (Whombat docs/decisions/offsite-copy.md):
// a bucket the person owns, on top of the one place the backups go to (a NAS, a disk, a server or a bucket). A fire,
// theft or flood takes the box and the NAS together; the copy in the bucket survives them.
//
// The second place is an S3-compatible bucket, checked before it is saved (a small file written, read back and
// deleted with the person's key), its secret kept like the destination's (sealed, never in a state file, the status or
// an error). After every backup the new checkpoints are copied there with `restic copy` (copy.go), in a unit of their
// own that never holds the backup's run lock, so a long first copy never holds a backup up. The copy is a restic
// repository of its own with the same password, so the recovery kit and the passkey's envelopes open it too; the kit
// names it (`kit.Material.Offsite`) and bringing a Whombat back uses it when the main place is gone.
package offsite

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/CybexBV/whombat/appliance/backup/internal/state"
	"github.com/CybexBV/whombat/appliance/backup/pkg/kit"
	"github.com/CybexBV/whombat/appliance/backup/pkg/restic"
)

// Providers the app offers (presets of the address); "s3" is any other S3-compatible storage.
var Providers = map[string]bool{"b2": true, "r2": true, "hetzner": true, "aws": true, "s3": true}

// Place is <stateDir>/offsite.json: where the copy is. Never a secret in it (the secret is SecretOffsiteS3Key).
type Place struct {
	Provider      string    `json:"provider"`
	Repository    string    `json:"repository"` // s3:https://host/bucket/folder (a local path in tests)
	S3AccessKeyID string    `json:"s3AccessKeyId,omitempty"`
	S3Region      string    `json:"s3Region,omitempty"`
	RepositoryID  string    `json:"repositoryId"`
	ConfiguredAt  time.Time `json:"configuredAt"`
	// Generation counts the places set on this box: a new one starts the copy afresh (the status of the old one goes).
	Generation int `json:"generation"`
}

// Paths under the state directory.
func path(c *state.Config) string        { return filepath.Join(c.StateDir, "offsite.json") }
func statusPath(c *state.Config) string  { return filepath.Join(c.StateDir, "offsite-status.json") }
func requestPath(c *state.Config) string { return filepath.Join(c.StateDir, "offsite-request.json") }
func lockPath(c *state.Config) string    { return filepath.Join(c.StateDir, "offsite.lock") }

// RequestPath is where "Copy now" is asked for (the unit's path unit watches it).
func RequestPath(c *state.Config) string { return requestPath(c) }

// Load returns the second place (nil when none is set).
func Load(c *state.Config) (*Place, error) {
	var p Place
	ok, err := readJSON(path(c), &p)
	if !ok || err != nil {
		return nil, err
	}
	return &p, nil
}

// Display is the place for people: the storage's host, the bucket and the folder, never a credential.
func (p *Place) Display() string {
	if loc, err := ParseS3(p.Repository); err == nil {
		d := loc.Host + "/" + loc.Bucket
		if loc.Prefix != "" {
			d += "/" + loc.Prefix
		}
		return d
	}
	return p.Repository
}

// Repo is the copy's restic repository with its credentials (the box's own repository password: the kit opens both).
func Repo(c *state.Config, p *Place) restic.Repo {
	r := restic.Repo{Binary: c.Restic, Repository: p.Repository, PasswordFile: c.RepositoryPasswordPath(),
		CacheDir: c.CacheDir(), RetryLock: c.RetryLock}
	if c.NoCache {
		r.CacheDir, r.NoCache = "", true
	}
	if state.KindOf(p.Repository) == state.KindS3 {
		r.PackSizeMB = state.RemotePackSizeMB
		r.S3AccessKeyID, r.S3Region = p.S3AccessKeyID, p.S3Region
		r.S3SecretAccessKey, _ = c.ReadSecret(state.SecretOffsiteS3Key)
	}
	return r
}

// Request sets the second place (the runtime forwards the person's input; tests may name a local path).
type Request struct {
	Provider          string `json:"provider"`
	Repository        string `json:"repository"`
	S3AccessKeyID     string `json:"s3AccessKeyId"`
	S3SecretAccessKey string `json:"s3SecretAccessKey"`
	S3Region          string `json:"s3Region"`
	// AllowLocal accepts a local path (tests and the console; never from the person's session).
	AllowLocal bool `json:"-"`
}

// InputError is a request that can never work (the API answers 400).
type InputError struct{ Msg string }

func (e *InputError) Error() string { return e.Msg }

var (
	keyIDRe  = regexp.MustCompile(`^[\x21-\x7e]{1,200}$`)
	regionRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)
)

func (req Request) validate() error {
	if !Providers[req.Provider] {
		return &InputError{"the provider is one of b2, r2, hetzner, aws or s3"}
	}
	repo := req.Repository
	if strings.TrimSpace(repo) != repo || strings.ContainsAny(repo, "\n\r\t\x00@") || repo == "" {
		return &InputError{"the place's address has spaces, control characters or credentials in it"}
	}
	switch state.KindOf(repo) {
	case state.KindS3:
		loc, err := ParseS3(repo)
		if err != nil {
			return &InputError{err.Error()}
		}
		if loc.Scheme == "http" && !plainHTTPAllowed(loc.Host) {
			return &InputError{"use https:// for the copy: over plain http its key and the backups' traffic would cross the network unprotected"}
		}
		if !keyIDRe.MatchString(req.S3AccessKeyID) || req.S3SecretAccessKey == "" || len(req.S3SecretAccessKey) > 500 {
			return &InputError{"the bucket needs its access key and secret"}
		}
		if req.S3Region != "" && !regionRe.MatchString(req.S3Region) {
			return &InputError{"the region is a name like eu-central-1"}
		}
	case state.KindLocal:
		if !req.AllowLocal || !filepath.IsAbs(repo) {
			return &InputError{"the second place is an S3-compatible bucket (s3:https://host/bucket/folder)"}
		}
	default:
		return &InputError{"the second place is an S3-compatible bucket (s3:https://host/bucket/folder)"}
	}
	return nil
}

// plainHTTPAllowed: plain http only to a literal address on the owner's own network, where a storage at home may
// have no certificate; anywhere else the key and the backups would cross the internet unprotected (the main place's
// rule too).
func plainHTTPAllowed(host string) bool {
	h := host
	if i := strings.LastIndex(h, ":"); i >= 0 && !strings.HasSuffix(h, "]") {
		h = h[:i]
	}
	h = strings.Trim(h, "[]")
	ip := net.ParseIP(h)
	return ip != nil && (ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast())
}

// samePlace: the copy would be where the backups go already (the same storage, bucket and folder, written the same
// way; another address for it is caught by the repository's id).
func samePlace(repo string, d *state.Destination) bool {
	if d == nil {
		return false
	}
	norm := func(s string) string { return strings.TrimRight(strings.ToLower(s), "/") }
	return norm(repo) == norm(d.Repository)
}

// Probing is how a place is checked before it is saved (tests replace it).
var Probing = func(ctx context.Context, loc S3Location, keyID, secret, region string) (string, error) {
	return (&Probe{Loc: loc, KeyID: keyID, Secret: secret, Region: region}).Run(ctx)
}

// Set checks the place and keeps it: an S3 place is probed (write, read back, delete), its repository opened with
// this box's password or made with the main repository's chunker parameters, and only then are the secret and the
// place saved (a failed attempt leaves the place that worked). The first copy is asked for at once.
func Set(ctx context.Context, c *state.Config, req Request) (*Place, error) {
	if err := req.validate(); err != nil {
		return nil, err
	}
	main, err := state.LoadDestination(c)
	if err != nil {
		return nil, err
	}
	if main == nil {
		return nil, &InputError{"backups aren't set up yet: choose where they go first"}
	}
	if samePlace(req.Repository, main) {
		return nil, stepErr(StepSame, nil)
	}
	pwPath := c.RepositoryPasswordPath()
	if pwPath == "" {
		return nil, errors.New("the repository password is missing on this appliance")
	}
	region := req.S3Region
	if state.KindOf(req.Repository) == state.KindS3 {
		loc, _ := ParseS3(req.Repository)
		if region, err = Probing(ctx, loc, req.S3AccessKeyID, req.S3SecretAccessKey, req.S3Region); err != nil {
			return nil, err
		}
	}
	// The secret is staged next to the others until the place answered.
	if err := os.MkdirAll(c.SecretsDir(), 0o700); err != nil {
		return nil, err
	}
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	staged := filepath.Join(c.SecretsDir(), ".staged-offsite-"+hex.EncodeToString(b))
	defer os.Remove(staged)
	place := &Place{Provider: req.Provider, Repository: req.Repository, ConfiguredAt: time.Now().UTC(), Generation: 1}
	if old, _ := Load(c); old != nil {
		place.Generation = old.Generation + 1
	}
	target := restic.Repo{Binary: c.Restic, Repository: req.Repository, PasswordFile: pwPath, CacheDir: c.CacheDir(),
		NoCache: c.NoCache}
	if c.NoCache {
		target.CacheDir = ""
	}
	if state.KindOf(req.Repository) == state.KindS3 {
		place.S3AccessKeyID, place.S3Region = req.S3AccessKeyID, region
		target.S3AccessKeyID, target.S3SecretAccessKey, target.S3Region = req.S3AccessKeyID, req.S3SecretAccessKey, region
		target.PackSizeMB = state.RemotePackSizeMB
		if err := state.WriteFileAtomic(staged, []byte(req.S3SecretAccessKey), 0o600); err != nil {
			return nil, err
		}
	}
	source := c.Repo(main)
	// The seal unit may seal and remove a plain password file while this runs: both repositories read one pinned copy.
	unpin, err := c.PinSecrets(&source)
	if err != nil {
		return nil, err
	}
	defer unpin()
	target.PasswordFile = source.PasswordFile
	// Only whether one restic copy can hold both places is checked here: what pairing started goes at once.
	_, unpair, err := target.Paired(source, c.StateDir)
	unpair()
	if errors.Is(err, restic.ErrCopyCredentials) {
		return nil, stepErr(StepPair, err)
	}
	if err != nil {
		// Anything else that keeps one copy from reaching both places (the main place's own certificate authority
		// unreadable, no room for the relay) would fail every copy: refused now rather than kept.
		return nil, stepErr(StepMain, err)
	}
	cfg, err := target.Config(ctx)
	switch {
	case err == nil:
		mainID := main.RepositoryID
		if mainID == "" {
			mc, err := source.Config(ctx)
			if err != nil {
				return nil, stepErr(StepMain, err)
			}
			mainID = mc.ID
		}
		// Another address for the same storage, bucket and folder passes the address check: the ids tell.
		if cfg.ID == mainID {
			return nil, stepErr(StepSame, errors.New("the second place is the main place's repository"))
		}
		place.RepositoryID = cfg.ID
	case errors.Is(err, restic.ErrWrongPassword):
		return nil, stepErr(StepRepository, err)
	case errors.Is(err, restic.ErrNoRepository):
		id, err := initCopy(ctx, c, target, source)
		if err != nil {
			return nil, classify(err, StepWrite)
		}
		place.RepositoryID = id
	default:
		return nil, classify(err, StepReach)
	}
	// Checked: put everything in place.
	if state.KindOf(req.Repository) == state.KindS3 {
		if err := os.Rename(staged, c.SecretWritePath(state.SecretOffsiteS3Key)); err != nil {
			return nil, err
		}
	} else {
		_ = c.WriteSecret(state.SecretOffsiteS3Key, "")
	}
	if err := state.WriteJSON(path(c), place, 0o600); err != nil {
		return nil, err
	}
	_ = os.Remove(statusPath(c)) // a new place starts afresh: nothing is copied there yet
	_ = Enqueue(c)
	return place, nil
}

// initCopy makes the copy's repository with the main repository's chunker parameters, so what restic copies stays
// deduplicated; when the main place can't be read now, a plain repository (restic copies into it all the same).
func initCopy(ctx context.Context, c *state.Config, target, source restic.Repo) (string, error) {
	if paired, done, err := target.Paired(source, c.StateDir); err == nil {
		defer done()
		if id, err := paired.InitFrom(ctx); err == nil {
			return id, nil
		}
	}
	return target.Init(ctx)
}

// Remove forgets the second place: its secret is cleared and nothing is copied there any more. The copies already
// there stay (the bucket is the person's).
func Remove(c *state.Config) error {
	if err := c.WriteSecret(state.SecretOffsiteS3Key, ""); err != nil {
		return err
	}
	for _, p := range []string{path(c), statusPath(c), requestPath(c)} {
		if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

// classify turns a restic failure against the second place into the step the person reads.
func classify(err error, fallback string) *Error {
	var oe *Error
	if errors.As(err, &oe) {
		return oe
	}
	low := strings.ToLower(err.Error())
	switch {
	case errors.Is(err, restic.ErrCopyCredentials):
		return stepErr(StepPair, err)
	case errors.Is(err, restic.ErrWrongPassword):
		return stepErr(StepRepository, err)
	case strings.Contains(low, "nosuchbucket") || strings.Contains(low, "bucket does not exist"):
		return stepErr(StepBucket, err)
	case strings.Contains(low, "invalidaccesskeyid") || strings.Contains(low, "signaturedoesnotmatch") ||
		strings.Contains(low, "access key id you provided"):
		return stepErr(StepKeys, err)
	case strings.Contains(low, "accessdenied") || strings.Contains(low, "access denied") || errors.Is(err, restic.ErrForbidden):
		return stepErr(StepWrite, err)
	case strings.Contains(low, "no such host") || strings.Contains(low, "connection refused") ||
		strings.Contains(low, "i/o timeout") || strings.Contains(low, "network is unreachable") ||
		strings.Contains(low, "no route to host"):
		return stepErr(StepReach, err)
	}
	return stepErr(fallback, err)
}

func readJSON(p string, v any) (bool, error) {
	b, err := state.ReadStateFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if err := json.Unmarshal(b, v); err != nil {
		return false, fmt.Errorf("%s: %w", filepath.Base(p), err)
	}
	return true, nil
}

// KitSection is the second place's section of the recovery kit's backup material: nil when there is none (or its key
// can't be read, so the kit never names a place it can't open).
func KitSection(c *state.Config) *kit.Offsite {
	p, err := Load(c)
	if err != nil || p == nil {
		return nil
	}
	o := &kit.Offsite{Provider: p.Provider, Repository: p.Repository, RepositoryID: p.RepositoryID}
	if state.KindOf(p.Repository) == state.KindS3 {
		secret, err := c.ReadSecret(state.SecretOffsiteS3Key)
		if err != nil || secret == "" {
			return nil
		}
		o.S3AccessKeyID, o.S3SecretAccessKey, o.S3Region = p.S3AccessKeyID, secret, p.S3Region
	}
	o.Head = LoadStatus(c, p).Head
	return o
}
