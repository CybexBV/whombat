// Package manifest defines the checkpoint manifest (BK-08): what one checkpoint contains, where it came
// from, and how it is authenticated. The manifest travels inside the restic snapshot
// (manifest/checkpoint.json + manifest/checkpoint.sig); the snapshot is tagged with the manifest's
// sha256 so a snapshot and its manifest can't be recombined.
package manifest

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/CybexBV/whombat/appliance/backup/pkg/gitinv"
)

// Kind is the manifest format.
const Kind = "whombat.checkpoint/1"

// Paths inside a checkpoint snapshot (relative to its root).
const (
	ManifestPath = "manifest/checkpoint.json"
	SigPath      = "manifest/checkpoint.sig"
	DumpPath     = "db/whombat.pgdump"
	FilesDir     = "files"
	// HostsBackupTarPath and HostsBackupPath are the hosts service's own backup in a checkpoint that has the `hosts`
	// source (BK-31): the uncompressed archive it writes now, or the gzipped one of a hosts service from before.
	// Hosts.Backup.Path says which.
	HostsBackupTarPath = "files/hosts/hub.tar"
	HostsBackupPath    = "files/hosts/hub.tar.gz"
	// HermesDir holds the agent's Hermes home in a checkpoint that has the `hermes` source (BK-36, NX-466): the
	// person's at its root, Hermes's named profiles (the outsiders' `_feedback`) under profiles/.
	HermesDir = "files/hermes"
)

// Tags on the restic snapshot.
const (
	TagProduct  = "whombat-checkpoint"
	TagIDPrefix = "ck:"
	TagMFPrefix = "mf:"
)

// Ref points at a previous checkpoint (a hash chain; withheld or reordered snapshots show as gaps).
type Ref struct {
	ID             string `json:"id"`
	Seq            int64  `json:"seq"`
	ManifestSHA256 string `json:"manifestSha256"`
}

// Quiesce records how consistency between database and files was obtained.
type Quiesce struct {
	Method    string `json:"method"` // "snapshot" | "quiesced-copy"
	Scope     string `json:"scope"`  // "writes" | "all"
	RequestID string `json:"requestId"`
	WaitMs    int64  `json:"waitMs"` // drain requested → safe
	HeldMs    int64  `json:"heldMs"` // safe → resumed (writes paused this long)
	Note      string `json:"note,omitempty"`
}

// Runtime is the runtime tuple reported by the runtime's local health at checkpoint time.
type Runtime struct {
	ReleaseID     string `json:"releaseId,omitempty"`
	Version       string `json:"version,omitempty"`
	SchemaVersion int    `json:"schemaVersion,omitempty"`
	Status        string `json:"status,omitempty"`
}

// File is one staged file with its hash.
type File struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

// Table is a row count read in the checkpoint's database snapshot.
type Table struct {
	Schema string `json:"schema"`
	Name   string `json:"name"`
	Rows   int64  `json:"rows"`
}

// Database describes the logical dump.
type Database struct {
	Name              string  `json:"name"`
	ServerVersion     string  `json:"serverVersion"`
	SnapshotID        string  `json:"snapshotId"`
	SnapshotTime      string  `json:"snapshotTime"` // database clock at export
	SchemaVersion     int     `json:"schemaVersion"`
	SchemaTag         string  `json:"schemaTag,omitempty"`
	DrizzleMigrations int     `json:"drizzleMigrations"`
	Dump              File    `json:"dump"`
	Tables            []Table `json:"tables"`
	ReferencedBlobs   int     `json:"referencedBlobs"`
	// ReferencedDigest is sha256 over the sorted referenced blob hashes (one per line).
	ReferencedDigest string `json:"referencedDigest"`
}

// Source is one snapshotted tree.
type Source struct {
	Name         string   `json:"name"`
	OriginalPath string   `json:"originalPath"`
	SnapshotPath string   `json:"snapshotPath"` // files/<name>
	Files        int64    `json:"files"`
	Dirs         int64    `json:"dirs"`
	Bytes        int64    `json:"bytes"`
	Excluded     []string `json:"excluded,omitempty"` // slash paths relative to the snapshot root
	Missing      bool     `json:"missing,omitempty"`  // the source didn't exist on the appliance
}

// CoverageItem mirrors coverage.Class for the record.
type CoverageItem struct {
	ID      string `json:"id"`
	Covered bool   `json:"covered"`
	Relogin bool   `json:"relogin,omitempty"`
}

// References are public identifiers of recovery material (never private keys).
type References struct {
	ManagementKeyFingerprint     string `json:"managementKeyFingerprint,omitempty"`
	ContentPeerID                string `json:"contentPeerId,omitempty"`
	RecoveryAuthorityFingerprint string `json:"recoveryAuthorityFingerprint,omitempty"`
	ManifestKey                  string `json:"manifestKey"`
	ResticRepositoryID           string `json:"resticRepositoryId,omitempty"`
}

// Manifest is one checkpoint.
type Manifest struct {
	Kind        string         `json:"kind"`
	ID          string         `json:"id"`
	Seq         int64          `json:"seq"`
	Previous    *Ref           `json:"previous,omitempty"`
	ApplianceID string         `json:"applianceId"`
	CreatedAt   time.Time      `json:"createdAt"` // the checkpoint instant (inside the quiesce)
	Reason      string         `json:"reason"`    // "scheduled" | "manual" | "pre-migration" | "test"
	Quiesce     Quiesce        `json:"quiesce"`
	Runtime     Runtime        `json:"runtime"`
	Database    Database       `json:"database"`
	Sources     []Source       `json:"sources"`
	Repos       []gitinv.Repo  `json:"repos"`
	Coverage    []CoverageItem `json:"coverage"`
	References  References     `json:"references"`
	// Migration is set for a pre-migration checkpoint (MD-06): the release and migrations it guards.
	Migration *Migration `json:"migration,omitempty"`
	// Hosts is set when the checkpoint carries the hosts service's backup (the `hosts` source; BF-18, BK-31).
	Hosts *Hosts `json:"hosts,omitempty"`
	// Hermes is set when the checkpoint carries the agent's Hermes home (the `hermes` source; BK-36, NX-466).
	Hermes *Hermes `json:"hermes,omitempty"`
	// Incomplete is set when the checkpoint knowingly lacks something and was uploaded anyway.
	Incomplete *Incomplete `json:"incomplete,omitempty"`
	Tool       string      `json:"tool"`
}

// MaxMissingKeys is how many missing attachments a manifest names (the count is always whole).
const MaxMissingKeys = 200

// Incomplete is what a checkpoint knowingly lacks: one missing attachment or a failed export of the servers doesn't
// stop every backup, the rest is uploaded and this records the gap, signed like the rest. Restores and checks take
// what it names as recorded, not as a fault of the backup.
type Incomplete struct {
	// MissingAttachments counts the attachments the database referenced that weren't on the box at the checkpoint
	// instant; MissingAttachmentKeys names the first MaxMissingKeys of them (blob keys, sorted).
	MissingAttachments    int      `json:"missingAttachments,omitempty"`
	MissingAttachmentKeys []string `json:"missingAttachmentKeys,omitempty"`
	// Servers says why the hosts service's backup isn't in it ("" = it is, or the box has no hosts service).
	Servers string `json:"servers,omitempty"`
}

// Hermes describes the agent's Hermes home in the checkpoint (one person, one home: Whombat one-person.md OP-08;
// NX-466): its SQLite stores — each database with its write-ahead log, as the atomic snapshot had them, the person's
// directly in the home and each named profile's (the outsiders' `_feedback`) in profiles/<name>/ — bound to the
// signed manifest by their hashes as the dump is (BK-08, BK-36), and how many skills its skills/ holds.
type Hermes struct {
	Stores []File `json:"stores"` // HermesDir/<x>.db and HermesDir/profiles/<name>/<x>.db, each with its -wal
	Skills int    `json:"skills"`
}

// Hosts describes the hosts service's backup in the checkpoint: the archive's hash binds it to the signed
// manifest, as the dump's hash does the database (BK-08, BK-34).
type Hosts struct {
	Backup File `json:"backup"` // HostsBackupTarPath or HostsBackupPath
}

// Migration names what a pre-migration checkpoint protects.
type Migration struct {
	ReleaseID  string   `json:"releaseId,omitempty"`
	Migrations []string `json:"migrations,omitempty"`
}

// Signature is manifest/checkpoint.sig.
type Signature struct {
	Alg string `json:"alg"` // "ed25519"
	Key string `json:"key"` // base64 public key
	Sig string `json:"sig"` // base64 signature over signedMessage(manifest bytes)
}

const domain = "whombat-checkpoint-manifest/1\n"

func signedMessage(b []byte) []byte {
	h := sha256.Sum256(b)
	return append([]byte(domain), h[:]...)
}

// Encode renders the manifest deterministically (indented JSON; the bytes are what is signed and hashed).
func Encode(m *Manifest) ([]byte, error) {
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(b, '\n'), nil
}

// SHA256 is the hex sha256 of manifest bytes (the snapshot's mf: tag).
func SHA256(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// Sign signs manifest bytes.
func Sign(b []byte, key ed25519.PrivateKey) ([]byte, error) {
	s := Signature{Alg: "ed25519",
		Key: base64.StdEncoding.EncodeToString(key.Public().(ed25519.PublicKey)),
		Sig: base64.StdEncoding.EncodeToString(ed25519.Sign(key, signedMessage(b)))}
	out, err := json.MarshalIndent(s, "", "  ")
	return append(out, '\n'), err
}

// Errors from Verify.
var (
	ErrUntrustedKey = errors.New("manifest signed by a key that is not the trusted manifest key")
	ErrBadSignature = errors.New("manifest signature does not verify")
)

// Verify checks sig over manifest bytes against the trusted public key (from the recovery kit or the
// appliance's own key) and parses the manifest.
func Verify(b, sig []byte, trusted ed25519.PublicKey) (*Manifest, error) {
	var s Signature
	if err := json.Unmarshal(sig, &s); err != nil {
		return nil, fmt.Errorf("manifest signature: %w", err)
	}
	if s.Alg != "ed25519" {
		return nil, fmt.Errorf("manifest signature: unsupported alg %q", s.Alg)
	}
	pub, err := base64.StdEncoding.DecodeString(s.Key)
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return nil, ErrBadSignature
	}
	if !ed25519.PublicKey(pub).Equal(trusted) {
		return nil, ErrUntrustedKey
	}
	raw, err := base64.StdEncoding.DecodeString(s.Sig)
	if err != nil || !ed25519.Verify(trusted, signedMessage(b), raw) {
		return nil, ErrBadSignature
	}
	var m Manifest
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, fmt.Errorf("manifest: %w", err)
	}
	if m.Kind != Kind {
		return nil, fmt.Errorf("manifest: unsupported kind %q", m.Kind)
	}
	if err := m.ValidatePaths(); err != nil {
		return nil, fmt.Errorf("manifest: %w", err)
	}
	return &m, nil
}

// SourceNames are the only snapshot sources a checkpoint can contain (coverage.Layout.Sources); `hosts` only
// on a box with the hosts service (BK-31). `hermes` is in every checkpoint since BK-36, `agent` (the agent's home,
// OP-16) since NX-466: tools from before refuse them.
var SourceNames = []string{"home", "workspaces", "credentials", "hermes", "agent", "secrets", "hosts"}

// HermesStorePath reports whether p is where a Hermes store may be: a file directly in the home (HermesDir) or directly
// in one of its named profiles (HermesDir/profiles/<name>), never deeper or elsewhere.
func HermesStorePath(p string) bool {
	d := path.Dir(p)
	if d == HermesDir {
		return true
	}
	return path.Dir(d) == HermesDir+"/profiles" && !strings.HasPrefix(path.Base(d), ".")
}

// ErrBadPath: a manifest names a source or repository path outside its fixed layout. The manifest key
// lives on the appliance, so a compromised appliance signs "authentic" manifests: every path the restore
// and export tools derive from a manifest is checked here, before anything is written (MA-21f, M-4).
var ErrBadPath = errors.New("path outside the checkpoint layout")

// ValidatePaths checks that sources are the known ones at files/<name>, each at most once, and that every
// repository path is a clean relative slash path below files/ (no "..", no absolute path, no backslash).
func (m *Manifest) ValidatePaths() error {
	seen := map[string]bool{}
	for _, s := range m.Sources {
		known := false
		for _, n := range SourceNames {
			known = known || s.Name == n
		}
		if !known || seen[s.Name] {
			return fmt.Errorf("%w: source %q", ErrBadPath, s.Name)
		}
		seen[s.Name] = true
		if s.SnapshotPath != FilesDir+"/"+s.Name {
			return fmt.Errorf("%w: source %s at %q", ErrBadPath, s.Name, s.SnapshotPath)
		}
	}
	for _, r := range m.Repos {
		if !ValidRelPath(r.Path) || !strings.HasPrefix(r.Path, FilesDir+"/") {
			return fmt.Errorf("%w: repository %q", ErrBadPath, r.Path)
		}
	}
	if m.Hosts != nil && ((m.Hosts.Backup.Path != HostsBackupTarPath && m.Hosts.Backup.Path != HostsBackupPath) || !seen["hosts"]) {
		return fmt.Errorf("%w: the hosts service's backup at %q", ErrBadPath, m.Hosts.Backup.Path)
	}
	if m.Hermes != nil {
		if !seen["hermes"] {
			return fmt.Errorf("%w: a Hermes home without the hermes source", ErrBadPath)
		}
		stores := map[string]bool{}
		for _, f := range m.Hermes.Stores {
			if !ValidRelPath(f.Path) || !HermesStorePath(f.Path) || stores[f.Path] {
				return fmt.Errorf("%w: Hermes store %q", ErrBadPath, f.Path)
			}
			stores[f.Path] = true
		}
	}
	return nil
}

// ValidRelPath reports whether p is a clean, relative slash path without "..", "." or empty segments.
func ValidRelPath(p string) bool {
	if p == "" || strings.ContainsAny(p, "\\\x00") || path.IsAbs(p) || path.Clean(p) != p {
		return false
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return false
		}
	}
	return true
}

// EncodeKey renders a public key as "ed25519:<base64>" (kit and manifest references).
func EncodeKey(pub ed25519.PublicKey) string {
	return "ed25519:" + base64.StdEncoding.EncodeToString(pub)
}

// ParseKey parses "ed25519:<base64>".
func ParseKey(s string) (ed25519.PublicKey, error) {
	const p = "ed25519:"
	if len(s) <= len(p) || s[:len(p)] != p {
		return nil, fmt.Errorf("manifest key: want ed25519:<base64>")
	}
	b, err := base64.StdEncoding.DecodeString(s[len(p):])
	if err != nil || len(b) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("manifest key: bad key")
	}
	return ed25519.PublicKey(b), nil
}

// LoadOrCreateKey loads the manifest signing key (an ed25519 seed, 0600) or creates it.
func LoadOrCreateKey(path string) (ed25519.PrivateKey, error) {
	b, err := os.ReadFile(path)
	if err == nil {
		if len(b) != ed25519.SeedSize {
			return nil, fmt.Errorf("manifest key %s: bad size", path)
		}
		return ed25519.NewKeyFromSeed(b), nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	seed := make([]byte, ed25519.SeedSize)
	if _, err := rand.Read(seed); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, seed, 0o600); err != nil {
		return nil, err
	}
	if err := os.Rename(tmp, path); err != nil {
		return nil, err
	}
	return ed25519.NewKeyFromSeed(seed), nil
}
