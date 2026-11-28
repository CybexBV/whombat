// Package state holds the backup service's configuration, destination, status (the client-facing shape,
// BK-11), checkpoint chain and run lock, all under /persist/backup.
package state

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/unix"

	"github.com/CybexBV/whombat/appliance/backup/pkg/coverage"
	"github.com/CybexBV/whombat/appliance/backup/pkg/restic"
	"github.com/CybexBV/whombat/appliance/backup/pkg/sshkey"
)

// Config is the service configuration (NixOS writes it; tests build it).
type Config struct {
	ApplianceID string `json:"applianceId"`
	// ApplianceIDFile: provisioning's device.json ({"deviceId": ...}); used when ApplianceID is empty.
	ApplianceIDFile  string `json:"applianceIdFile"`
	Persist          string `json:"persist"`          // "/persist"
	StateDir         string `json:"stateDir"`         // "/persist/backup"
	RuntimeSocket    string `json:"runtimeSocket"`    // "/run/whombat/admin.sock"; "" = no runtime (refuses checkpoints unless AllowNoRuntime)
	AllowNoRuntime   bool   `json:"allowNoRuntime"`   // only for a stopped runtime (recovery, tests)
	SnapSocket       string `json:"snapSocket"`       // whombat-backup-snapd socket; "" = in-process Driver
	Driver           string `json:"driver"`           // in-process driver: "copy" (default), "btrfs", "zfs"
	APISocket        string `json:"apiSocket"`        // "/run/whombat-backup/api.sock"
	PGDSN            string `json:"pgDsn"`            // "host=/run/postgresql dbname=whombat user=whombat_backup"
	PGBin            string `json:"pgBin"`            // directory with pg_dump/pg_restore/initdb/pg_ctl ("" = PATH)
	Restic           string `json:"restic"`           // restic binary ("" = PATH)
	Git              string `json:"git"`              // git binary ("" = PATH)
	QuiesceTimeoutMs int64  `json:"quiesceTimeoutMs"` // default 120000
	LeaseMs          int64  `json:"leaseMs"`          // default 30000
	ReserveBytes     int64  `json:"reserveBytes"`     // kept free on the staging filesystem (default 1 GiB)
	IdentityPublic   string `json:"identityPublic"`   // directory with provisioning's public identity files (default <persist>/identity)
	StaleAfterMs     int64  `json:"staleAfterMs"`     // last success older than this = "stale" (default 36h)
	// Peers of the local API and the snapshot helper (-1 = nobody).
	RuntimeUID int `json:"runtimeUid"`
	ManagerUID int `json:"managerUid"`
	BackupUID  int `json:"backupUid"` // the only peer whombat-backup-snapd serves
	// SnapDatasets maps source paths to ZFS datasets (driver "zfs").
	SnapDatasets map[string]string `json:"snapDatasets,omitempty"`
	// PasswordFile overrides where the repository password is read (default: SecretPath).
	PasswordFile string `json:"passwordFile"`
	// SSH is the ssh binary for SFTP destinations ("" = PATH); ssh-keyscan is looked up next to it.
	SSH string `json:"ssh"`
	// DiskMount is where the NixOS module mounts the disk labelled WHOMBAT-BACKUP (disk: destinations,
	// BK-20; default <stateDir>/disk); DiskRequireMount: the directory must be a mount point to count as
	// attached (the appliance; tests use a plain directory).
	DiskMount        string `json:"diskMount"`
	DiskRequireMount bool   `json:"diskRequireMount"`
	// DiskInitTimeoutMs bounds the wait for the root helper to prepare an empty disk (default 120 s).
	DiskInitTimeoutMs int64 `json:"diskInitTimeoutMs"`
	// Tools of the root disk helper (whombat-backup disk-init): blkid, mkfs.ext4, udevadm ("" = PATH).
	Blkid    string `json:"blkid"`
	MkfsExt4 string `json:"mkfsExt4"`
	Udevadm  string `json:"udevadm"`
	// SystemdCreds is the systemd-creds binary a root CLI run unseals the secrets with ("" = PATH).
	SystemdCreds string `json:"systemdCreds"`
	// SealedDir is the root-only directory of the sealed secrets and the pinned backup disk (BK-26;
	// default <persist>/backup-root). The backup user can't write, rename or replace anything in it.
	SealedDir string `json:"sealedDir"`
	// SystemdMount mounts the backup disk (the root helper; "" = PATH).
	SystemdMount string `json:"systemdMount"`
	// DiskHelper: a root helper answers disk requests (the appliance); without it (tests) an attached disk
	// is simply used.
	DiskHelper bool `json:"diskHelper"`
	// RunDir is where a root run materializes its secrets (default /run); RuntimeDir is that run's private
	// directory, its only source of secrets (root mode, BK-26).
	RunDir     string `json:"runDir"`
	RuntimeDir string `json:"-"`
	// NoCache runs restic without its cache (set for root invocations, so no root-owned cache files are
	// left for the backup user).
	NoCache bool `json:"-"`
	// RetryLock is how long restic waits for another restic's lock (restic.Repo.RetryLock): the timers' runs wait
	// longer than the calls a person waits on.
	RetryLock time.Duration `json:"-"`
	// Hosts is the hosts service (the servers' hub), nil on a box without it (BF-18, BK-31): its backup is
	// then a source of every checkpoint and a restore hands it back to it.
	Hosts *HostsConfig `json:"hosts,omitempty"`
	// Peek is how a backup is opened for reading (internal/peek); nil = peeks aren't offered.
	Peek *PeekConfig `json:"peek,omitempty"`
	// ReadConcurrency is how many files a backup reads at once (restic --read-concurrency; 0 = restic's 2). The
	// appliance's /persist is solid state, where more parallel reads of many small files help.
	ReadConcurrency int `json:"readConcurrency,omitempty"`
}

// PeekConfig is how a backup opened for reading reaches the runtime (internal/peek).
type PeekConfig struct {
	// RuntimeRole is the runtime's PostgreSQL role: it may connect to the peek's database and SELECT from it.
	RuntimeRole string `json:"runtimeRole"`
	// GID is the group the peek's root is readable by, one the runtime's user is in (-1: leave the group, tests).
	GID int `json:"gid"`
	// Dir holds the open peek (default <stateDir>/peek).
	Dir string `json:"dir,omitempty"`
	// DBPrefix names the peek's database (default whombat_peek_; tests on a shared server give their own).
	DBPrefix string `json:"dbPrefix,omitempty"`
	// TTLMs is how long a peek stays open (default 2 hours).
	TTLMs int64 `json:"ttlMs,omitempty"`
}

// RemotePackSizeMB is the pack size for destinations across a network (REST, S3): half the objects of restic's
// 16 MiB, so half the requests and files on a NAS or bucket, without making a failed upload or a prune's repacking
// much coarser. Measured on loopback (400 MB and 2000 small files): 27 → 14 pack files, the same time.
const RemotePackSizeMB = 32

// HostsConfig is how the backup reaches the hosts service's own backup (BK-32).
type HostsConfig struct {
	// BackupSocket: a connection makes the service, as its user, write its backup to
	// <persist>/hosts-backup/hub.tar (hub.tar.gz before) and answer "ok" (or "failed: …").
	BackupSocket string `json:"backupSocket"`
	// TimeoutMs bounds that backup (default 30 minutes).
	TimeoutMs int64 `json:"timeoutMs,omitempty"`
	// UID and GID of the service's user: the owner of what a restore stages for it (BK-34).
	UID int `json:"uid"`
	GID int `json:"gid"`
}

// LoadConfig reads a config file and fills defaults.
func LoadConfig(path string) (*Config, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	c := Config{RuntimeUID: -1, ManagerUID: -1, BackupUID: -1} // absent = nobody (never uid 0 by default)
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, fmt.Errorf("config %s: %w", path, err)
	}
	if c.ApplianceID == "" && c.ApplianceIDFile != "" {
		b, err := os.ReadFile(c.ApplianceIDFile)
		if err != nil {
			return nil, fmt.Errorf("appliance id: %w", err)
		}
		var dev struct {
			DeviceID string `json:"deviceId"`
		}
		if err := json.Unmarshal(b, &dev); err != nil || dev.DeviceID == "" {
			return nil, fmt.Errorf("appliance id: %s has no deviceId", c.ApplianceIDFile)
		}
		c.ApplianceID = dev.DeviceID
	}
	c.Defaults()
	return &c, nil
}

// Defaults fills unset fields.
func (c *Config) Defaults() {
	if c.Persist == "" {
		c.Persist = "/persist"
	}
	if c.StateDir == "" {
		c.StateDir = filepath.Join(c.Persist, "backup")
	}
	if c.Driver == "" {
		c.Driver = "copy"
	}
	if c.QuiesceTimeoutMs == 0 {
		c.QuiesceTimeoutMs = 120_000
	}
	if c.LeaseMs < 1_000 {
		c.LeaseMs = 30_000 // the contract's minimum is 1000 ms
	}
	if c.ReserveBytes == 0 {
		c.ReserveBytes = 1 << 30
	}
	if c.StaleAfterMs == 0 {
		c.StaleAfterMs = 36 * 3600 * 1000
	}
	if c.DiskMount == "" {
		c.DiskMount = filepath.Join(c.StateDir, "disk")
	}
	if c.DiskInitTimeoutMs == 0 {
		c.DiskInitTimeoutMs = 120_000
	}
	if c.SealedDir == "" {
		c.SealedDir = filepath.Join(c.Persist, "backup-root")
	}
	if c.Hosts != nil && c.Hosts.TimeoutMs == 0 {
		c.Hosts.TimeoutMs = 30 * 60 * 1000
	}
	if p := c.Peek; p != nil {
		if p.Dir == "" {
			p.Dir = filepath.Join(c.StateDir, "peek")
		}
		if p.DBPrefix == "" {
			p.DBPrefix = "whombat_peek_"
		}
		if p.TTLMs == 0 {
			p.TTLMs = 2 * 3600 * 1000
		}
	}
}

// Layout returns the persistent layout.
func (c *Config) Layout() coverage.Layout {
	return coverage.Layout{Persist: c.Persist, Hosts: c.Hosts != nil}
}

// Paths under the state directory.
func (c *Config) StagingDir() string { return filepath.Join(c.StateDir, "staging", "current") }
func (c *Config) SecretsDir() string { return filepath.Join(c.StateDir, "secrets") }
func (c *Config) ManifestKeyPath() string {
	return filepath.Join(c.StateDir, "keys", "manifest.ed25519")
}
func (c *Config) StatusPath() string      { return filepath.Join(c.StateDir, "status.json") }
func (c *Config) DestinationPath() string { return filepath.Join(c.StateDir, "destination.json") }
func (c *Config) ChainPath() string       { return filepath.Join(c.StateDir, "checkpoints.jsonl") }
func (c *Config) CacheDir() string        { return filepath.Join(c.StateDir, "cache") }
func (c *Config) DrillDir() string        { return filepath.Join(c.StateDir, "drill") }

// Secrets of the destination (BK-15, BK-18): each is written as a plain 0600 file under <stateDir>/secrets
// (on the encrypted /persist) by the service, then sealed by the root unit whombat-backup-seal with
// systemd-creds (TPM2 + host key) into <name>.cred and the plain file shredded; the backup units get the
// sealed ones as credentials ($CREDENTIALS_DIRECTORY/<credential>). File name → credential name.
var secretCreds = map[string]string{
	SecretRepositoryPassword: "restic-password",
	SecretRESTPassword:       "rest-password",
	SecretS3Key:              "s3-secret",
	SecretSSHKey:             "ssh-key",
	SecretOffsiteS3Key:       "offsite-s3-secret",
}

// Secret file names.
const (
	SecretRepositoryPassword = "repository-password"
	SecretRESTPassword       = "rest-password"
	SecretS3Key              = "s3-secret-access-key"
	SecretSSHKey             = "ssh-key" // the box's Ed25519 key for SFTP destinations (OpenSSH format)
	// SecretOffsiteS3Key is the secret of the bucket that keeps the second copy (internal/offsite).
	SecretOffsiteS3Key = "offsite-s3-secret-access-key"
)

// SecretNames lists the secrets in sealing order.
func SecretNames() []string {
	return []string{SecretRepositoryPassword, SecretRESTPassword, SecretS3Key, SecretSSHKey, SecretOffsiteS3Key}
}

// SecretWritePath is where the service writes a new value (the seal unit picks it up).
func (c *Config) SecretWritePath(name string) string { return filepath.Join(c.SecretsDir(), name) }

// SecretPath is where a secret is read ("" = not set):
//   - root mode: only the run's private directory (MaterializeForRoot), never a file of the backup user;
//   - otherwise the plain file when one exists (a value written since the last seal is always the newest;
//     an empty one means the secret was cleared), else the unit's credential unless it is the empty
//     placeholder the seal unit leaves for a secret that was never set.
func (c *Config) SecretPath(name string) string {
	cred, ok := secretCreds[name]
	if !ok {
		return ""
	}
	nonEmpty := func(p string) string {
		if fi, err := os.Stat(p); err == nil && fi.Mode().IsRegular() && fi.Size() > 0 {
			return p
		}
		return ""
	}
	if root.on {
		if c.RuntimeDir == "" {
			return ""
		}
		return nonEmpty(filepath.Join(c.RuntimeDir, cred))
	}
	plain := c.SecretWritePath(name)
	if fi, err := os.Lstat(plain); err == nil {
		if !fi.Mode().IsRegular() || fi.Size() == 0 {
			return "" // cleared (or not a file: never followed)
		}
		return plain
	}
	if d := os.Getenv("CREDENTIALS_DIRECTORY"); d != "" {
		return nonEmpty(filepath.Join(d, cred))
	}
	return ""
}

// ReadSecret returns a secret's value ("" when not set).
func (c *Config) ReadSecret(name string) (string, error) {
	p := c.SecretPath(name)
	if p == "" {
		return "", nil
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(b)), nil
}

// WriteSecret stores a new value (0600) for the seal unit. An empty value clears the secret: an empty
// file, which wins over the sealed value and is sealed as the empty placeholder in turn (BK-26).
func (c *Config) WriteSecret(name, value string) error {
	return WriteFileAtomic(c.SecretWritePath(name), []byte(value), 0o600)
}

// RESTPasswordPath is where the REST password is read ("" = none).
func (c *Config) RESTPasswordPath() string { return c.SecretPath(SecretRESTPassword) }

// RepositoryPasswordPath is where the restic password is read (PasswordFile when set; "" = none yet).
func (c *Config) RepositoryPasswordPath() string {
	if c.PasswordFile != "" {
		return c.PasswordFile
	}
	return c.SecretPath(SecretRepositoryPassword)
}

// AdoptedManifestKeyPath holds the old appliance's manifest key after `destination adopt` (replacement):
// the key a quarantine restore trusts.
func (c *Config) AdoptedManifestKeyPath() string {
	return filepath.Join(c.StateDir, "keys", "adopted-manifest.pub")
}

// KnownHostsPath is the pinned SFTP host key (not a secret; in root mode the run's private copy).
func (c *Config) KnownHostsPath() string {
	if root.on && c.RuntimeDir != "" {
		return filepath.Join(c.RuntimeDir, "known_hosts")
	}
	return filepath.Join(c.StateDir, "known_hosts")
}

// DiskPinPath holds the UUID of the pinned backup disk (root-only, BK-27).
func (c *Config) DiskPinPath() string { return filepath.Join(c.SealedDir, "disk-uuid") }

// CACertPath is where a destination's private CA certificate is kept (not a secret).
func (c *Config) CACertPath() string { return filepath.Join(c.StateDir, "ca.pem") }

// DiskRepository is the restic repository on the backup disk (fixed, so a replacement finds it).
func (c *Config) DiskRepository() string { return filepath.Join(c.DiskMount, "whombat", "repository") }

// DiskLabel is the filesystem label of a backup disk.
const DiskLabel = "WHOMBAT-BACKUP"

// DiskPresent says whether the backup disk is attached (mounted, when DiskRequireMount).
func (c *Config) DiskPresent() bool {
	fi, err := os.Stat(c.DiskMount)
	if err != nil || !fi.IsDir() {
		return false
	}
	if !c.DiskRequireMount {
		return true
	}
	return isMountPoint(c.DiskMount)
}

func isMountPoint(p string) bool {
	var st, pst unix.Stat_t
	if unix.Stat(p, &st) != nil || unix.Stat(filepath.Dir(p), &pst) != nil {
		return false
	}
	return st.Dev != pst.Dev
}

// Destination kinds (the contract's BackupDestinationKind, CT-142).
const (
	KindREST  = "rest"  // rest:https://host/path/ — a restic REST server (append-only qualifies, BK-09)
	KindS3    = "s3"    // s3:https://host/bucket/path — an S3-compatible bucket (BK-18)
	KindSFTP  = "sftp"  // sftp:host:/path — SFTP/NAS with the box's own key (BK-19)
	KindDisk  = "disk"  // disk: — the disk labelled WHOMBAT-BACKUP (BK-20)
	KindLocal = "local" // a local path (tests, recovery copies)
)

// KindOf is the kind a repository string names.
func KindOf(repo string) string {
	switch {
	case strings.HasPrefix(repo, "rest:"):
		return KindREST
	case strings.HasPrefix(repo, "s3:"):
		return KindS3
	case strings.HasPrefix(repo, "sftp:"):
		return KindSFTP
	case repo == "disk:":
		return KindDisk
	}
	return KindLocal
}

// Destination is the configured off-device destination. Never a secret in it (the file is 0600 anyway).
type Destination struct {
	Kind         string    `json:"kind"`       // KindREST … KindLocal ("restic-rest"/"restic-local" before BK-18)
	Repository   string    `json:"repository"` // restic repository string without credentials ("disk:" for the disk)
	RESTUser     string    `json:"restUser,omitempty"`
	CACert       string    `json:"caCert,omitempty"` // path of the PEM file
	RepositoryID string    `json:"repositoryId"`
	Generation   int       `json:"generation"`
	ConfiguredAt time.Time `json:"configuredAt"`
	// S3: the access key id (the secret is SecretS3Key) and the region ("" = the service's default).
	S3AccessKeyID string `json:"s3AccessKeyId,omitempty"`
	S3Region      string `json:"s3Region,omitempty"`
	// SFTP: the user, and the pinned host key ("ssh-ed25519 AAAA…") with its fingerprint.
	SFTPUser               string `json:"sftpUser,omitempty"`
	SFTPHostKey            string `json:"sftpHostKey,omitempty"`
	SFTPHostKeyFingerprint string `json:"sftpHostKeyFingerprint,omitempty"`
	// AppendOnly is the result of the deletion probe: "verified" (the destination refused a delete with
	// this appliance's credential), "not-enforced" (it accepted one, or the kind can't refuse one) or
	// "unknown".
	AppendOnly        string    `json:"appendOnly"`
	AppendOnlyChecked time.Time `json:"appendOnlyChecked"`
}

// Display is the repository for people: no scheme noise, never a credential.
func (d *Destination) Display() string {
	switch d.Kind {
	case KindREST:
		return strings.TrimPrefix(d.Repository, "rest:")
	case KindS3:
		return strings.TrimPrefix(d.Repository, "s3:")
	case KindSFTP:
		if loc, err := restic.ParseSFTP(d.Repository); err == nil {
			host := loc.Host
			if strings.Contains(host, ":") {
				host = "[" + host + "]"
			}
			if loc.Port != 0 && loc.Port != 22 {
				host += ":" + strconv.Itoa(loc.Port)
			}
			return d.SFTPUser + "@" + host + ":" + loc.Path
		}
		return strings.TrimPrefix(d.Repository, "sftp:")
	case KindDisk:
		return "Local disk " + DiskLabel
	}
	return d.Repository
}

// LoadDestination returns nil when none is configured.
func LoadDestination(c *Config) (*Destination, error) {
	b, err := ReadStateFile(c.DestinationPath())
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var d Destination
	if err := json.Unmarshal(b, &d); err != nil {
		return nil, err
	}
	switch d.Kind { // before BK-18
	case "restic-rest":
		d.Kind = KindREST
	case "restic-local":
		d.Kind = KindLocal
	}
	return &d, nil
}

// SaveDestination writes the destination atomically.
func SaveDestination(c *Config, d *Destination) error {
	return WriteJSON(c.DestinationPath(), d, 0o600)
}

// Repo returns the restic repository for a destination, with its credentials resolved (BK-18…BK-20).
func (c *Config) Repo(d *Destination) restic.Repo {
	r := restic.Repo{Binary: c.Restic, Repository: d.Repository, PasswordFile: c.RepositoryPasswordPath(),
		RESTUser: d.RESTUser, CacheDir: c.CacheDir(), CACert: d.CACert, RetryLock: c.RetryLock}
	if c.NoCache {
		r.CacheDir, r.NoCache = "", true
	}
	if root.on && d.CACert != "" { // never a path the backup user chose: the run's private copy
		r.CACert = ""
		if c.RuntimeDir != "" {
			if _, err := os.Stat(filepath.Join(c.RuntimeDir, "ca.pem")); err == nil {
				r.CACert = filepath.Join(c.RuntimeDir, "ca.pem")
			}
		}
	}
	switch d.Kind {
	case KindREST, KindS3:
		r.PackSizeMB = RemotePackSizeMB
	}
	switch d.Kind {
	case KindREST:
		if d.RESTUser != "" {
			r.RESTPassword, _ = c.ReadSecret(SecretRESTPassword)
		}
	case KindS3:
		r.S3AccessKeyID, r.S3Region = d.S3AccessKeyID, d.S3Region
		r.S3SecretAccessKey, _ = c.ReadSecret(SecretS3Key)
	case KindSFTP:
		r.SFTP = c.SFTP(d)
	case KindDisk:
		r.Repository = c.DiskRepository()
	}
	return r
}

// SFTP is the hardened ssh invocation for an SFTP destination (nil when the repository doesn't parse). It
// (re)writes the pinned host key file when it is missing or differs from the destination's pin.
func (c *Config) SFTP(d *Destination) *restic.SFTP {
	loc, err := restic.ParseSFTP(d.Repository)
	if err != nil {
		return nil
	}
	s := &restic.SFTP{SSH: c.SSH, Host: loc.Host, Port: loc.Port, User: d.SFTPUser,
		KeyFile: c.SecretPath(SecretSSHKey), KnownHostsFile: c.KnownHostsPath()}
	if pk, err := sshkey.ParsePublicKey(d.SFTPHostKey); err == nil {
		s.HostKeyAlgorithms = pk.HostKeyAlgorithms()
		want := sshkey.KnownHostsLine(loc.Host, loc.Port, pk)
		if b, err := ReadStateFile(s.KnownHostsFile); err != nil || string(b) != want {
			_ = WriteFileAtomic(s.KnownHostsFile, []byte(want), 0o600)
		}
	}
	return s
}

// WriteJSON writes v atomically (temp file, fsync, rename, fsync dir).
func WriteJSON(path string, v any, mode os.FileMode) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return WriteFileAtomic(path, append(b, '\n'), mode)
}

// WriteFileAtomic writes bytes atomically (a new temp file, fsync, rename, fsync of the directory). In
// root mode: below the state directory without following any symlink and owned by the backup user, or into
// the run's private directory; nothing else.
func WriteFileAtomic(path string, b []byte, mode os.FileMode) error {
	if root.on {
		if c := filepath.Clean(path); runtimeDirOf(c) {
			return os.WriteFile(c, b, mode)
		}
		return rootWrite(path, b, mode)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	if _, err := f.Write(b); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Chmod(tmp, mode); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	if d, err := os.Open(filepath.Dir(path)); err == nil {
		_ = d.Sync()
		d.Close()
	}
	return nil
}

// Lock is an exclusive run lock (flock).
type Lock struct{ f *os.File }

// ErrBusy means another checkpoint, restore or drill is running.
var ErrBusy = errors.New("another backup operation is running")

// TryLock takes the run lock without waiting.
func TryLock(c *Config) (*Lock, error) {
	var f *os.File
	var err error
	if root.on {
		f, err = rootOpen(filepath.Join(c.StateDir, "run.lock"), os.O_RDWR)
	} else {
		if err := os.MkdirAll(c.StateDir, 0o700); err != nil {
			return nil, err
		}
		f, err = os.OpenFile(filepath.Join(c.StateDir, "run.lock"), os.O_RDWR|os.O_CREATE, 0o600)
	}
	if err != nil {
		return nil, err
	}
	if err := unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		f.Close()
		return nil, ErrBusy
	}
	return &Lock{f: f}, nil
}

// Unlock releases the lock.
func (l *Lock) Unlock() {
	_ = unix.Flock(int(l.f.Fd()), unix.LOCK_UN)
	_ = l.f.Close()
}

// ChainEntry is one completed checkpoint.
type ChainEntry struct {
	ID             string    `json:"id"`
	Seq            int64     `json:"seq"`
	ManifestSHA256 string    `json:"manifestSha256"`
	SnapshotID     string    `json:"snapshotId"`
	Repository     string    `json:"repository"`
	At             time.Time `json:"at"`
	Reason         string    `json:"reason"`
}

// Chain returns every chain entry, oldest first (none when there is no chain yet).
func Chain(c *Config) ([]ChainEntry, error) {
	b, err := ReadStateFile(c.ChainPath())
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []ChainEntry
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		var e ChainEntry
		if line := bytes.TrimSpace(sc.Bytes()); len(line) > 0 && json.Unmarshal(line, &e) == nil {
			out = append(out, e)
		}
	}
	return out, sc.Err()
}

// LastChain returns the newest chain entry (nil when none).
func LastChain(c *Config) (*ChainEntry, error) {
	b, err := ReadStateFile(c.ChainPath())
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var last *ChainEntry
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		var e ChainEntry
		if json.Unmarshal(line, &e) == nil {
			last = &e
		}
	}
	return last, sc.Err()
}

// SeqPath holds the newest checkpoint sequence number handed out (<stateDir>/seq).
func (c *Config) SeqPath() string { return filepath.Join(c.StateDir, "seq") }

// NextSeq hands out the next checkpoint sequence number: one more than both the newest recorded checkpoint and the
// newest number handed out before, which it records (fsync'd) before returning. A checkpoint gets its number before
// its upload, so one whose upload or read-back failed after a snapshot was written can't leave its number to the
// next: two snapshots in the repository never share one.
func NextSeq(c *Config, last *ChainEntry) (int64, error) {
	n := int64(0)
	if last != nil {
		n = last.Seq
	}
	if b, err := ReadStateFile(c.SeqPath()); err == nil {
		if v, err := strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64); err == nil && v > n {
			n = v
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return 0, err
	}
	n++
	return n, WriteFileAtomic(c.SeqPath(), []byte(strconv.FormatInt(n, 10)+"\n"), 0o600)
}

// AppendChain appends an entry (fsync'd).
func AppendChain(c *Config, e ChainEntry) error {
	var f *os.File
	var err error
	if root.on {
		f, err = rootOpen(c.ChainPath(), os.O_WRONLY|os.O_APPEND)
	} else {
		f, err = os.OpenFile(c.ChainPath(), os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	}
	if err != nil {
		return err
	}
	b, _ := json.Marshal(e)
	if _, err := f.Write(append(b, '\n')); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// SealedPath is where the seal unit keeps a secret sealed with systemd-creds (root-only, BK-26).
func (c *Config) SealedPath(name string) string { return filepath.Join(c.SealedDir, name+".cred") }

// runtimeDirOf: path is in the current root run's private directory.
var runtimeDirs []string

func runtimeDirOf(path string) bool {
	for _, d := range runtimeDirs {
		if strings.HasPrefix(path, d+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

// AppendLine appends one line to a state file (created 0600 by the backup user; root appends only to an existing
// one, BK-26).
func AppendLine(path string, line []byte) error {
	var f *os.File
	var err error
	if root.on {
		f, err = rootOpen(path, os.O_WRONLY|os.O_APPEND)
	} else {
		f, err = os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	}
	if err != nil {
		return err
	}
	if _, err := f.Write(append(line, '\n')); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// PinSecrets gives one run of r its own copies of the secret files it reads that are the backup user's plain
// values (written since the last seal): the seal unit seals and removes those while a run may still need them, and a
// checkpoint that lost its repository password between its upload and its read-back failed (BK-26). The copies are
// 0600 in a private directory of the state directory, removed by the returned function. Sealed credentials and a root
// run's private copies are left as they are.
func (c *Config) PinSecrets(r *restic.Repo) (func(), error) {
	plain := map[string]bool{}
	for name := range secretCreds {
		if p := c.SecretWritePath(name); p != "" {
			plain[p] = true
		}
	}
	files := []*string{&r.PasswordFile}
	if r.SFTP != nil {
		files = append(files, &r.SFTP.KeyFile)
	}
	var dir string
	cleanup := func() {
		if dir != "" {
			_ = os.RemoveAll(dir)
		}
	}
	for _, f := range files {
		if *f == "" || !plain[*f] {
			continue
		}
		b, err := os.ReadFile(*f)
		if err != nil {
			cleanup()
			return func() {}, err
		}
		if dir == "" {
			if dir, err = os.MkdirTemp(c.StateDir, ".pinned-"); err != nil {
				return func() {}, err
			}
		}
		pinned := filepath.Join(dir, filepath.Base(*f))
		if err := os.WriteFile(pinned, b, 0o600); err != nil {
			cleanup()
			return func() {}, err
		}
		*f = pinned
	}
	return cleanup, nil
}
