// Package dest configures the off-device destination (BK-06, BK-09, BK-18…BK-21): the repository password
// (generated on the appliance, or adopted from a recovery kit on a replacement), the destination's own
// credentials (the append-only REST credential, an S3 access key, the box's SSH key and the server's
// pinned host key, or the labelled local disk), the repository itself, and the append-only probe.
//
// A new configuration is verified before anything is replaced: its secrets are staged, restic opens (or,
// with allowInit, creates) the repository with them, and only then are they moved into place and the
// destination file written. A failed attempt leaves the previous destination working.
package dest

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/CybexBV/whombat/appliance/backup/internal/listing"
	"github.com/CybexBV/whombat/appliance/backup/internal/state"
	"github.com/CybexBV/whombat/appliance/backup/pkg/kit"
	"github.com/CybexBV/whombat/appliance/backup/pkg/manifest"
	"github.com/CybexBV/whombat/appliance/backup/pkg/restic"
	"github.com/CybexBV/whombat/appliance/backup/pkg/restore"
	"github.com/CybexBV/whombat/appliance/backup/pkg/sshkey"
)

// Request configures a destination (the contract's BackupConfigureDestinationInput, CT-142, plus what
// only the console may give).
type Request struct {
	// Repository: "rest:https://host:port/appliance/", "s3:https://host/bucket/path", "sftp:host:/path",
	// "disk:", or (AllowLocal) a local path.
	Repository   string
	RESTUser     string
	RESTPassword string
	// CACert is a PEM CA certificate for a private rest: or s3: destination.
	CACert string
	// AdoptPassword is the repository password from a recovery kit (replacement appliance): the existing
	// repository is joined, never re-initialized.
	AdoptPassword string
	// AllowInit permits creating the repository when it doesn't exist (and, for disk:, preparing an empty
	// disk).
	AllowInit bool
	// S3 (BK-18).
	S3AccessKeyID     string
	S3SecretAccessKey string
	S3Region          string
	// SFTP (BK-19): the user; the host key to pin (a known_hosts-style line, or a "SHA256:…" fingerprint
	// the scanned key must match); "" = trust on first use.
	SFTPUser    string
	SFTPHostKey string
	// SFTPPrivateKey is a recovery kit's key (console adopt only); "" = the box's own key.
	SFTPPrivateKey string
	// AdoptManifestKey is the old appliance's manifest key from the kit (replacement): its checkpoints are
	// the ones a quarantine restore trusts. Everything an earlier adopt recorded is replaced (listing.Adopt).
	AdoptManifestKey string
	// AdoptHead is the newest checkpoint the kit knew (a restore checks the destination doesn't withhold newer ones),
	// AdoptEarlier the Whombats the old appliance was brought back from, each trusted up to its cut-off (BK-79).
	AdoptHead    *kit.Head
	AdoptEarlier []kit.Adopted
	// AllowLocal accepts a local path (console and tests; never from the owner's session).
	AllowLocal bool
}

// Result is the configured destination and what the owner is shown.
type Result struct {
	*state.Destination
	// HostKeyFingerprint is the pinned SFTP host key's fingerprint, for the owner to compare with the
	// server's.
	HostKeyFingerprint string
}

// InputError is a request that can never work (the API answers 400).
type InputError struct{ Msg string }

func (e *InputError) Error() string { return e.Msg }

func bad(format string, a ...any) error { return &InputError{Msg: fmt.Sprintf(format, a...)} }

// ErrForeignRepository: a repository exists at the destination and this appliance's password doesn't
// open it.
var ErrForeignRepository = errors.New("a repository exists at this destination and this appliance's password doesn't open it; adopt it with the recovery kit (whombat-backup destination adopt) or choose another path")

// NewPassword generates a repository password (256 bits).
func NewPassword() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

var (
	regionRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)
	keyIDRe  = regexp.MustCompile(`^[\x21-\x7e]{1,200}$`)
)

// validate checks the request for its kind and answers the kind.
func validate(req Request) (string, error) {
	repo := strings.TrimSpace(req.Repository)
	if repo == "" {
		return "", bad("repository required")
	}
	if repo != req.Repository || strings.ContainsAny(repo, "\n\r\t\x00") {
		return "", bad("the repository contains spaces or control characters")
	}
	if strings.Contains(repo, "@") {
		return "", bad("put the destination's credentials in their own fields, not in the repository")
	}
	kind := state.KindOf(repo)
	s3 := req.S3AccessKeyID != "" || req.S3SecretAccessKey != "" || req.S3Region != ""
	sftp := req.SFTPUser != "" || req.SFTPHostKey != "" || req.SFTPPrivateKey != ""
	rest := req.RESTUser != "" || req.RESTPassword != ""
	only := func(what string, set bool) error {
		if set {
			return bad("%s fields don't apply to a %s destination", what, kind)
		}
		return nil
	}
	switch kind {
	case state.KindREST:
		u, err := url.Parse(strings.TrimPrefix(repo, "rest:"))
		if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
			return "", bad("a REST destination is rest:https://host[:port]/path/")
		}
		if u.Scheme == "http" && !plainHTTPAllowed(u.Hostname()) {
			return "", bad("%s", ReasonPlainHTTP)
		}
		if err := errors.Join(only("S3", s3), only("SFTP", sftp)); err != nil {
			return "", err
		}
		if req.RESTUser == "" && req.RESTPassword != "" {
			return "", bad("a REST password needs its user")
		}
	case state.KindS3:
		u, err := url.Parse(strings.TrimPrefix(repo, "s3:"))
		if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || strings.Trim(u.Path, "/") == "" {
			return "", bad("an S3 destination is s3:https://host/bucket[/path]")
		}
		if u.RawQuery != "" || u.Fragment != "" {
			return "", bad("an S3 destination has no query or fragment")
		}
		if u.Scheme == "http" && !plainHTTPAllowed(u.Hostname()) {
			return "", bad("%s", ReasonPlainHTTP)
		}
		if err := errors.Join(only("REST", rest), only("SFTP", sftp)); err != nil {
			return "", err
		}
		if !keyIDRe.MatchString(req.S3AccessKeyID) || req.S3SecretAccessKey == "" {
			return "", bad("an S3 destination needs the access key ID and the secret access key")
		}
		if req.S3Region != "" && !regionRe.MatchString(req.S3Region) {
			return "", bad("the S3 region is a name like eu-central-1")
		}
	case state.KindSFTP:
		if _, err := restic.ParseSFTP(repo); err != nil {
			return "", bad("%v", err)
		}
		if err := errors.Join(only("REST", rest), only("S3", s3)); err != nil {
			return "", err
		}
		if req.CACert != "" {
			return "", bad("a CA certificate doesn't apply to an SFTP destination (the host key is pinned instead)")
		}
		if err := (restic.SFTP{Host: "h", User: req.SFTPUser, KeyFile: "k", KnownHostsFile: "k"}).Validate(); err != nil {
			return "", bad("%v", err)
		}
		if hk := strings.TrimSpace(req.SFTPHostKey); hk != "" && !sshkey.IsFingerprint(hk) {
			if _, err := sshkey.ParsePublicKey(hk); err != nil {
				return "", bad("%v", err)
			}
		}
	case state.KindDisk:
		if err := errors.Join(only("REST", rest), only("S3", s3), only("SFTP", sftp)); err != nil {
			return "", err
		}
		if req.CACert != "" {
			return "", bad("a CA certificate doesn't apply to a local disk")
		}
	default:
		if !req.AllowLocal {
			return "", bad("the destination must be rest:, s3:, sftp: or disk:")
		}
		if !filepath.IsAbs(repo) {
			return "", bad("a local repository is an absolute path")
		}
		if err := errors.Join(only("REST", rest), only("S3", s3), only("SFTP", sftp)); err != nil {
			return "", err
		}
	}
	if req.CACert != "" {
		if _, err := parseCA(req.CACert); err != nil {
			return "", bad("%v", err)
		}
	}
	return kind, nil
}

// plainHTTPAllowed: plain http only to a literal address on the owner's own network — private (RFC 1918,
// IPv6 ULA), loopback or link-local — where nothing between the box and the server is someone else's
// network (BK-29). A name never qualifies: it could resolve anywhere.
func plainHTTPAllowed(host string) bool {
	ip := net.ParseIP(host)
	return ip != nil && (ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast())
}

func parseCA(pemText string) (*x509.CertPool, error) {
	pool := x509.NewCertPool()
	rest := []byte(pemText)
	n := 0
	for {
		var blk *pem.Block
		blk, rest = pem.Decode(rest)
		if blk == nil {
			break
		}
		if blk.Type != "CERTIFICATE" {
			return nil, fmt.Errorf("the CA certificate contains a %s block", blk.Type)
		}
		c, err := x509.ParseCertificate(blk.Bytes)
		if err != nil {
			return nil, fmt.Errorf("the CA certificate doesn't parse: %w", err)
		}
		pool.AddCert(c)
		n++
	}
	if n == 0 {
		return nil, errors.New("the CA certificate is not PEM (-----BEGIN CERTIFICATE-----)")
	}
	return pool, nil
}

// staged holds the secrets of an attempt until it succeeded.
type staged struct {
	dir   string
	files map[string]string // secret name → staged file
}

func (s *staged) put(name, value string) (string, error) {
	p := filepath.Join(s.dir, name)
	if err := state.WriteFileAtomic(p, []byte(value), 0o600); err != nil {
		return "", err
	}
	s.files[name] = p
	return p, nil
}

// commit moves the staged secrets into place (same directory: renames).
func (s *staged) commit(c *state.Config) error {
	for name, p := range s.files {
		if err := os.Rename(p, c.SecretWritePath(name)); err != nil {
			return err
		}
	}
	return nil
}

// Configure sets (or replaces) the destination after verifying it.
func Configure(ctx context.Context, c *state.Config, req Request) (*Result, error) {
	kind, err := validate(req)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(c.SecretsDir(), 0o700); err != nil {
		return nil, err
	}
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	st := &staged{dir: filepath.Join(c.SecretsDir(), ".staged-"+hex.EncodeToString(b)), files: map[string]string{}}
	defer os.RemoveAll(st.dir)

	// The repository password: the kit's (adopt), the one this appliance has, or a new one.
	pwPath := c.RepositoryPasswordPath()
	switch {
	case req.AdoptPassword != "":
		if pwPath, err = st.put(state.SecretRepositoryPassword, req.AdoptPassword); err != nil {
			return nil, err
		}
	case pwPath == "":
		pw, err := NewPassword()
		if err != nil {
			return nil, err
		}
		if pwPath, err = st.put(state.SecretRepositoryPassword, pw); err != nil {
			return nil, err
		}
	}

	old, _ := state.LoadDestination(c)
	d := &state.Destination{Kind: kind, Repository: req.Repository, ConfiguredAt: time.Now().UTC(), Generation: 1}
	if old != nil {
		d.Generation = old.Generation + 1
	}
	repo := restic.Repo{Binary: c.Restic, Repository: req.Repository, PasswordFile: pwPath, CacheDir: c.CacheDir()}
	res := &Result{Destination: d}
	caPath := ""
	if req.CACert != "" {
		caPath = filepath.Join(st.dir, "ca.pem")
		if err := state.WriteFileAtomic(caPath, []byte(req.CACert), 0o600); err != nil {
			return nil, err
		}
		repo.CACert = caPath
	}

	switch kind {
	case state.KindREST:
		d.RESTUser = req.RESTUser
		repo.RESTUser, repo.RESTPassword = req.RESTUser, req.RESTPassword
		if req.RESTUser != "" {
			if _, err := st.put(state.SecretRESTPassword, req.RESTPassword); err != nil {
				return nil, err
			}
		}
	case state.KindS3:
		d.S3AccessKeyID, d.S3Region = req.S3AccessKeyID, req.S3Region
		repo.S3AccessKeyID, repo.S3SecretAccessKey, repo.S3Region = req.S3AccessKeyID, req.S3SecretAccessKey, req.S3Region
		if _, err := st.put(state.SecretS3Key, req.S3SecretAccessKey); err != nil {
			return nil, err
		}
	case state.KindSFTP:
		if err := configureSFTP(ctx, c, req, d, &repo, st); err != nil {
			return nil, err
		}
		res.HostKeyFingerprint = d.SFTPHostKeyFingerprint
	case state.KindDisk:
		if err := ensureDisk(ctx, c, req.AllowInit); err != nil {
			return nil, err
		}
		repo.Repository = c.DiskRepository()
	}

	rcfg, err := repo.Config(ctx)
	switch {
	case err == nil:
		d.RepositoryID = rcfg.ID
	case errors.Is(err, restic.ErrNoRepository) && req.AdoptPassword == "" && req.AllowInit:
		id, err := repo.Init(ctx)
		if err != nil {
			return nil, Explain(d, err)
		}
		d.RepositoryID = id
	case errors.Is(err, restic.ErrNoRepository) && req.AdoptPassword != "":
		return nil, &DestError{Reason: "There is no backup repository at this destination to adopt: check the address against the recovery kit.", Err: err}
	case errors.Is(err, restic.ErrNoRepository) && kind == state.KindS3 && strings.Contains(strings.ToLower(err.Error()), "bucket"):
		return nil, &DestError{Reason: ReasonS3NoBucket, Err: err}
	case errors.Is(err, restic.ErrNoRepository):
		return nil, &DestError{Reason: "There is no backup repository at this destination yet: allow Whombat to create one.", Err: err}
	case errors.Is(err, restic.ErrWrongPassword):
		return nil, ErrForeignRepository
	default:
		return nil, Explain(d, err)
	}
	d.AppendOnly, err = ProbeAppendOnly(ctx, d, repo)
	if err != nil {
		d.AppendOnly = "unknown"
	}
	d.AppendOnlyChecked = time.Now().UTC()

	// Verified: put everything in place.
	if err := st.commit(c); err != nil {
		return nil, err
	}
	if kind != state.KindREST || req.RESTUser == "" {
		_ = c.WriteSecret(state.SecretRESTPassword, "")
	}
	if kind != state.KindS3 {
		_ = c.WriteSecret(state.SecretS3Key, "")
	}
	if caPath != "" {
		if err := state.WriteFileAtomic(c.CACertPath(), []byte(req.CACert), 0o644); err != nil {
			return nil, err
		}
		d.CACert = c.CACertPath()
	}
	if req.AdoptManifestKey != "" {
		pk, err := manifest.ParseKey(req.AdoptManifestKey)
		if err != nil {
			return nil, bad("the kit's manifest key: %v", err)
		}
		var head *restore.ExpectedHead
		if h := req.AdoptHead; h != nil {
			head = &restore.ExpectedHead{Seq: h.Seq, ManifestSHA256: h.ManifestSHA256}
		}
		if err := listing.Adopt(c, pk, head, req.AdoptEarlier); err != nil {
			return nil, err
		}
	}
	if err := state.SaveDestination(c, d); err != nil {
		return nil, err
	}
	if kind == state.KindSFTP {
		c.SFTP(d) // writes the pinned host key file
	}
	_, err = state.UpdateStatus(c, func(s *state.Status) { clearPresenceFailure(s) })
	return res, err
}

// ProbeAppendOnly qualifies the destination's deletion resistance with the appliance's own credential.
// A REST server is asked to delete a key file that doesn't exist: rest-server in --append-only mode refuses
// every delete outside locks/ with 403 before looking at the file; a server that allows deletes answers 200
// (deleting a missing file is idempotent). Nothing is ever deleted: the name is random. S3, SFTP and a
// local disk are "not-enforced": the box's own credential can delete what it wrote there (BK-18…BK-20).
func ProbeAppendOnly(ctx context.Context, d *state.Destination, repo restic.Repo) (string, error) {
	if d.Kind != state.KindREST {
		return "not-enforced", nil
	}
	base := strings.TrimSuffix(strings.TrimPrefix(d.Repository, "rest:"), "/")
	rnd := make([]byte, 32)
	_, _ = rand.Read(rnd)
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, base+"/keys/"+hex.EncodeToString(rnd), nil)
	if err != nil {
		return "unknown", err
	}
	if d.RESTUser != "" {
		req.SetBasicAuth(d.RESTUser, repo.RESTPassword)
	}
	req.Header.Set("Accept", "application/vnd.x.restic.rest.v2")
	hc := &http.Client{Timeout: 20 * time.Second}
	if repo.CACert != "" {
		b, err := os.ReadFile(repo.CACert)
		if err != nil {
			return "unknown", err
		}
		pool, err := parseCA(string(b))
		if err != nil {
			return "unknown", err
		}
		hc.Transport = &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}}
	}
	resp, err := hc.Do(req)
	if err != nil {
		return "unknown", err
	}
	resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusForbidden:
		return "verified", nil
	case resp.StatusCode >= 200 && resp.StatusCode < 300, resp.StatusCode == http.StatusNotFound:
		return "not-enforced", nil
	}
	return "unknown", fmt.Errorf("append-only probe: HTTP %d", resp.StatusCode)
}

// Material returns the backup section of the recovery kit (owner-only; the runtime must enforce that):
// everything another machine needs to reach and open the repository (BK-15, BK-18, BK-19).
func Material(c *state.Config) (*kit.Material, error) {
	d, err := state.LoadDestination(c)
	if err != nil {
		return nil, err
	}
	if d == nil {
		return nil, errors.New("no destination configured: there is nothing to put in the kit yet")
	}
	pwPath := c.RepositoryPasswordPath()
	if pwPath == "" {
		return nil, errors.New("the repository password is missing on this appliance")
	}
	pwb, err := os.ReadFile(pwPath)
	if err != nil {
		return nil, err
	}
	pw := strings.TrimSpace(string(pwb))
	if pw == "" {
		return nil, errors.New("the repository password is missing on this appliance")
	}
	key, err := manifest.LoadOrCreateKey(c.ManifestKeyPath())
	if err != nil {
		return nil, err
	}
	m := &kit.Material{Kind: kit.MaterialKind, ApplianceID: c.ApplianceID, Generation: d.Generation,
		CreatedAt: time.Now().UTC(), Repository: d.Repository, RESTUser: d.RESTUser,
		RepositoryPassword: pw, RepositoryID: d.RepositoryID,
		ManifestKey: manifest.EncodeKey(key.Public().(ed25519.PublicKey))}
	switch d.Kind {
	case state.KindREST:
		if d.RESTUser != "" {
			if m.RESTPassword, err = c.ReadSecret(state.SecretRESTPassword); err != nil {
				return nil, err
			}
		}
	case state.KindS3:
		m.S3AccessKeyID, m.S3Region = d.S3AccessKeyID, d.S3Region
		if m.S3SecretAccessKey, err = c.ReadSecret(state.SecretS3Key); err != nil {
			return nil, err
		}
	case state.KindSFTP:
		m.SFTPUser, m.SFTPHostKey = d.SFTPUser, d.SFTPHostKey
		k, err := c.ReadSecret(state.SecretSSHKey)
		if err != nil {
			return nil, err
		}
		m.SFTPPrivateKey = k + "\n"
	}
	if last, err := state.LastChain(c); err == nil && last != nil && last.Repository == d.Repository {
		m.Head = &kit.Head{Seq: last.Seq, ManifestSHA256: last.ManifestSHA256, At: last.At}
	}
	// The Whombats this one was brought back from: a box that adopts this kit later trusts their backups up to their
	// cut-offs too, so bringing this one back doesn't lose the history it brought back (BK-79).
	if keys, err := listing.LoadKeys(c); err == nil {
		m.Adopted = keys.Carried()
	}
	return m, m.Validate()
}
