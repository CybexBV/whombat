// Package kit defines the customer's recovery kit (BK-06) and the backup section the appliance
// contributes to it. The kit is assembled in the owner's client (MA-04 step 4): the client generates the
// recovery key and fetches the backup material from the appliance over the end-to-end session (an
// owner-only operation). Everything needed to open, verify and export backups without the appliance and
// without Whombat cloud is in the backup section.
package kit

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/CybexBV/whombat/appliance/backup/pkg/manifest"
	"github.com/CybexBV/whombat/appliance/backup/pkg/restic"
	"github.com/CybexBV/whombat/appliance/backup/pkg/sshkey"
)

// Kinds.
const (
	KitKind      = "whombat.recovery-kit/1"
	MaterialKind = "whombat.backup-recovery-material/1"
)

// Material is the backup section: what the appliance hands the owner's client.
type Material struct {
	Kind        string    `json:"kind"`
	ApplianceID string    `json:"applianceId"`
	Generation  int       `json:"generation"` // bumped when password, destination or manifest key change
	CreatedAt   time.Time `json:"createdAt"`
	// Repository is the restic repository URL without credentials ("rest:https://host/appliance/",
	// "s3:https://host/bucket/path", "sftp:host:/path", "disk:").
	Repository string `json:"repository"`
	// RESTUser/RESTPassword: the appliance's append-only destination credential. It can read and add,
	// never delete; with it the kit alone reaches the backups. Empty when the destination has none.
	RESTUser     string `json:"restUser,omitempty"`
	RESTPassword string `json:"restPassword,omitempty"`
	// S3 destinations (BK-18): the access key the box uses. Unlike the REST credential it can usually
	// delete objects too (unless the bucket's policy, versioning or object lock prevents it).
	S3AccessKeyID     string `json:"s3AccessKeyId,omitempty"`
	S3SecretAccessKey string `json:"s3SecretAccessKey,omitempty"`
	S3Region          string `json:"s3Region,omitempty"`
	// SFTP destinations (BK-19): the user, the box's private key (OpenSSH PEM) and the pinned host key.
	SFTPUser       string `json:"sftpUser,omitempty"`
	SFTPPrivateKey string `json:"sftpPrivateKey,omitempty"`
	SFTPHostKey    string `json:"sftpHostKey,omitempty"`
	// RepositoryPassword opens (decrypts) the restic repository.
	RepositoryPassword string `json:"repositoryPassword"`
	RepositoryID       string `json:"repositoryId"`
	// ManifestKey authenticates checkpoint manifests as made by this appliance ("ed25519:<base64>").
	ManifestKey string `json:"manifestKey"`
	// Head is the newest checkpoint the appliance had made when the material was fetched: a restore
	// reports a destination whose newest authentic checkpoint is older (withheld checkpoints, I-2).
	Head *Head `json:"head,omitempty"`
	// Adopted are the earlier Whombats this one was brought back from (BK-79), newest first: a box that adopts this
	// material trusts their backups too, each only up to its cut-off. Absent in older materials and on a box that was
	// never brought back.
	Adopted []Adopted `json:"adopted,omitempty"`
}

// Adopted is an earlier Whombat's manifest key and its cut-off. Once one of its backups was brought back onto another
// Whombat it is retired, so what its key signs later (a stolen or unwiped box) never counts.
type Adopted struct {
	// ApplianceID names the earlier Whombat when the box knew it.
	ApplianceID string `json:"applianceId,omitempty"`
	ManifestKey string `json:"manifestKey"` // "ed25519:<base64>"
	Until       Until  `json:"until"`
}

// Until is the cut-off: the backup that was brought back and the earlier Whombat's backups known then.
type Until struct {
	CheckpointID   string `json:"checkpointId"`
	Seq            int64  `json:"seq"`
	ManifestSHA256 string `json:"manifestSha256"`
	// Known are the manifest sha256s of its backups up to the one brought back, newest first.
	Known []string `json:"known"`
}

// The material's limits for what it carries of earlier Whombats: it travels sealed with passkeys, beside the backups and
// on paper, so it stays small (a box keeps the newest).
const (
	MaxAdopted = 4
	MaxKnown   = 128
)

// maxSeq is the highest sequence number the material's readers take: the largest integer a JSON number keeps exactly
// in the apps (2^53 − 1), the contract's bound.
const maxSeq = 1<<53 - 1

var (
	sha256Hex    = regexp.MustCompile(`^[0-9a-f]{64}$`)
	checkpointID = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,64}$`)
	applianceID  = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,64}$`)
)

// Head identifies a checkpoint in the manifest hash chain.
type Head struct {
	Seq            int64     `json:"seq"`
	ManifestSHA256 string    `json:"manifestSha256"`
	At             time.Time `json:"at"`
}

// RecoveryKey is generated in the client; the backup tools don't use it.
type RecoveryKey struct {
	Alg     string `json:"alg"`
	Private string `json:"private"`
}

// Kit is the whole recovery kit.
type Kit struct {
	Kind          string       `json:"kind"`
	ApplianceID   string       `json:"applianceId"`
	ContentPeerID string       `json:"contentPeerId,omitempty"`
	CreatedAt     time.Time    `json:"createdAt"`
	RecoveryKey   *RecoveryKey `json:"recoveryKey,omitempty"`
	Backup        *Material    `json:"backup,omitempty"`
	// Checksum: first 16 hex of sha256 over the kit JSON with Checksum empty; catches transcription errors.
	Checksum string `json:"checksum"`
}

// Validate checks a material section.
func (m *Material) Validate() error {
	var miss []string
	if m.Kind != MaterialKind {
		return fmt.Errorf("backup material: kind %q", m.Kind)
	}
	for n, v := range map[string]string{"applianceId": m.ApplianceID, "repository": m.Repository,
		"repositoryPassword": m.RepositoryPassword, "manifestKey": m.ManifestKey} {
		if v == "" {
			miss = append(miss, n)
		}
	}
	if len(miss) > 0 {
		return fmt.Errorf("backup material: missing %s", strings.Join(miss, ", "))
	}
	if strings.Contains(m.Repository, "@") {
		return errors.New("backup material: credentials belong in their own fields, not in the repository URL")
	}
	if err := m.validateAdopted(); err != nil {
		return err
	}
	// Completeness per kind (BK-18, BK-19): the kit alone must reach the repository from another machine.
	switch {
	case strings.HasPrefix(m.Repository, "s3:"):
		if m.S3AccessKeyID == "" || m.S3SecretAccessKey == "" {
			return errors.New("backup material: an S3 destination needs s3AccessKeyId and s3SecretAccessKey")
		}
	case strings.HasPrefix(m.Repository, "sftp:"):
		if m.SFTPUser == "" || m.SFTPPrivateKey == "" || m.SFTPHostKey == "" {
			return errors.New("backup material: an SFTP destination needs sftpUser, sftpPrivateKey and sftpHostKey")
		}
	}
	return nil
}

// validateAdopted checks the earlier Whombats' keys and cut-offs: well formed, none the material's own key, none twice.
func (m *Material) validateAdopted() error {
	if len(m.Adopted) > MaxAdopted {
		return fmt.Errorf("backup material: more than %d earlier Whombats", MaxAdopted)
	}
	seen := map[string]bool{m.ManifestKey: true}
	for i, a := range m.Adopted {
		bad := func(what string) error { return fmt.Errorf("backup material: adopted[%d]: %s", i, what) }
		if _, err := manifest.ParseKey(a.ManifestKey); err != nil {
			return bad(err.Error())
		}
		if seen[a.ManifestKey] {
			return bad("the same key twice, or the material's own")
		}
		seen[a.ManifestKey] = true
		if a.ApplianceID != "" && !applianceID.MatchString(a.ApplianceID) {
			return bad("applianceId")
		}
		u := a.Until
		if !checkpointID.MatchString(u.CheckpointID) || u.Seq < 0 || u.Seq > maxSeq || !sha256Hex.MatchString(u.ManifestSHA256) {
			return bad("until: checkpointId, seq or manifestSha256")
		}
		if len(u.Known) > MaxKnown {
			return bad(fmt.Sprintf("until: more than %d known backups", MaxKnown))
		}
		for _, k := range u.Known {
			if !sha256Hex.MatchString(k) {
				return bad("until: a known backup that isn't a sha256")
			}
		}
	}
	return nil
}

func checksum(k Kit) string {
	k.Checksum = ""
	b, _ := json.Marshal(k)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])[:16]
}

// Seal fills the checksum.
func (k *Kit) Seal() { k.Checksum = checksum(*k) }

// Load reads a kit file: a whole kit (checksum verified) or a bare backup material section.
func Load(path string) (*Material, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return Parse(b)
}

// Parse parses kit bytes (see Load).
func Parse(b []byte) (*Material, error) {
	var probe struct {
		Kind string `json:"kind"`
	}
	if err := json.Unmarshal(b, &probe); err != nil {
		return nil, fmt.Errorf("recovery kit: %w", err)
	}
	switch probe.Kind {
	case KitKind:
		var k Kit
		if err := json.Unmarshal(b, &k); err != nil {
			return nil, fmt.Errorf("recovery kit: %w", err)
		}
		if k.Checksum != checksum(k) {
			return nil, errors.New("recovery kit: checksum mismatch (the kit was changed or mistyped)")
		}
		if k.Backup == nil {
			return nil, errors.New("recovery kit: no backup section (the kit predates backups; create a new kit)")
		}
		return k.Backup, k.Backup.Validate()
	case MaterialKind:
		var m Material
		if err := json.Unmarshal(b, &m); err != nil {
			return nil, fmt.Errorf("backup material: %w", err)
		}
		return &m, m.Validate()
	}
	return nil, fmt.Errorf("recovery kit: unknown kind %q", probe.Kind)
}

// Repo opens the material's repository from another machine (the recovery tool, BK-14): the password,
// the SFTP key and the pinned host key are written as 0600 files into dir (a private directory the caller
// removes), credentials go only to restic's environment. A disk: repository has no address: the caller
// passes where the disk's copy is mounted (repoDir).
func (m *Material) Repo(dir, resticBin, sshBin, repoDir string) (restic.Repo, error) {
	pw := filepath.Join(dir, "pw")
	if err := os.WriteFile(pw, []byte(m.RepositoryPassword), 0o600); err != nil {
		return restic.Repo{}, err
	}
	r := restic.Repo{Binary: resticBin, Repository: m.Repository, PasswordFile: pw, NoCache: true}
	if repoDir != "" { // a local copy (or the backup disk, mounted): no credentials needed
		r.Repository = repoDir
		if _, err := os.Stat(filepath.Join(repoDir, "whombat", "repository", "config")); err == nil {
			r.Repository = filepath.Join(repoDir, "whombat", "repository") // the backup disk's root
		}
		return r, nil
	}
	switch {
	case strings.HasPrefix(m.Repository, "rest:"):
		r.RESTUser, r.RESTPassword = m.RESTUser, m.RESTPassword
	case strings.HasPrefix(m.Repository, "s3:"):
		r.S3AccessKeyID, r.S3SecretAccessKey, r.S3Region = m.S3AccessKeyID, m.S3SecretAccessKey, m.S3Region
	case strings.HasPrefix(m.Repository, "sftp:"):
		loc, err := restic.ParseSFTP(m.Repository)
		if err != nil {
			return r, err
		}
		pk, err := sshkey.ParsePublicKey(m.SFTPHostKey)
		if err != nil {
			return r, fmt.Errorf("the kit's SFTP host key: %w", err)
		}
		if _, err := sshkey.ParsePrivate([]byte(m.SFTPPrivateKey)); err != nil {
			return r, fmt.Errorf("the kit's SFTP key: %w", err)
		}
		key, known := filepath.Join(dir, "sftp-key"), filepath.Join(dir, "known_hosts")
		if err := os.WriteFile(key, []byte(strings.TrimSpace(m.SFTPPrivateKey)+"\n"), 0o600); err != nil {
			return r, err
		}
		if err := os.WriteFile(known, []byte(sshkey.KnownHostsLine(loc.Host, loc.Port, pk)), 0o600); err != nil {
			return r, err
		}
		r.SFTP = &restic.SFTP{SSH: sshBin, Host: loc.Host, Port: loc.Port, User: m.SFTPUser, KeyFile: key,
			KnownHostsFile: known, HostKeyAlgorithms: pk.HostKeyAlgorithms()}
		if err := r.SFTP.Validate(); err != nil {
			return r, err
		}
	case m.Repository == "disk:":
		return r, errors.New("this kit's backups are on the backup disk (WHOMBAT-BACKUP): attach and mount it, and pass its mount point with -repo-dir")
	}
	return r, nil
}
