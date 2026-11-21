package devtuf

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/contracts/go/release"
	"github.com/theupdateframework/go-tuf/v2/metadata"
)

// Production pilot mode (PI-05, MG-40). All TUF roles are signed by keys kept online on the update host
// (“online-pilot” custody), threshold 1 each. It is a recorded shortcut, not the target design
// (the maintainers' release-signing runbook); PI-12 lists what must change before anyone but the owner of the
// host installs a production image.
const (
	// CustodyOnlinePilot is the only production custody this package supports.
	CustodyOnlinePilot = "online-pilot"
	// PilotRootExpiry: the pilot root must be re-signed (ResignRoot) or rotated within four months.
	PilotRootExpiry = 120 * 24 * time.Hour
	// ProdWarning is embedded in every production key file.
	ProdWarning = "PRODUCTION KEY (online-pilot custody, PI-05) - keep it on the update host; never copy, back up in clear or commit it"
)

func (r *Repo) prod() bool { return r.opts.Custody == CustodyOnlinePilot }

// IsProduction reports whether the repository uses production (online-pilot) keys.
func (r *Repo) IsProduction() bool { return r.prod() }

func pathWithin(child, parent string) bool {
	rel, err := filepath.Rel(parent, child)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// resolved is the absolute path with every existing prefix's symlinks resolved.
func resolved(p string) string {
	p, _ = filepath.Abs(p)
	rest := ""
	for cur := p; ; cur = filepath.Dir(cur) {
		if r, err := filepath.EvalSymlinks(cur); err == nil {
			return filepath.Join(r, rest)
		}
		if cur == filepath.Dir(cur) {
			return p
		}
		rest = filepath.Join(filepath.Base(cur), rest)
	}
}

// checkMode refuses every mix of development and production options (MA-14).
func checkMode(dir string, o Options) error {
	switch o.Edition {
	case "":
	case EditionCommunity:
		if o.Custody != "" || o.Env == "prod" || o.Env == "production" {
			return errors.New("devtuf: a community repository has development (test) keys only: no community custody exists yet (HE-62)")
		}
	default:
		return fmt.Errorf("devtuf: unknown edition %q", o.Edition)
	}
	switch o.Custody {
	case "":
		if o.Env == "prod" || o.Env == "production" {
			return errors.New("devtuf: refusing production keys without --custody " + CustodyOnlinePilot + " --keys-dir DIR (PI-05)")
		}
		return nil
	case CustodyOnlinePilot:
	default:
		return fmt.Errorf("devtuf: unknown custody %q (only %q exists)", o.Custody, CustodyOnlinePilot)
	}
	if o.Env != "prod" {
		return fmt.Errorf("devtuf: custody %s is for --env prod only; development repositories use development keys (MA-14)", o.Custody)
	}
	if o.KeysDir == "" || !filepath.IsAbs(o.KeysDir) {
		return errors.New("devtuf: production keys need an absolute --keys-dir")
	}
	kd, rd := resolved(o.KeysDir), resolved(dir)
	if pathWithin(kd, rd) || pathWithin(rd, kd) {
		return fmt.Errorf("devtuf: the keys dir %s must be outside the repository %s (the repository is served)", o.KeysDir, dir)
	}
	return nil
}

// CheckMode is the mode rule for commands that read a repository without its keys (`check-newer --dir`): the options
// never mix (checkMode), and they must be the repository's own, development or production (MA-14), as Load demands.
func CheckMode(dir string, o Options) error {
	o.defaults()
	if err := checkMode(dir, o); err != nil {
		return err
	}
	var st struct {
		Env         string `json:"env"`
		Development bool   `json:"development"`
		Custody     string `json:"custody"`
	}
	b, err := os.ReadFile(filepath.Join(dir, "state.json"))
	if err != nil {
		return err
	}
	if err := json.Unmarshal(b, &st); err != nil {
		return fmt.Errorf("devtuf: %s/state.json: %w", dir, err)
	}
	isProd := !st.Development && st.Env == "prod" && st.Custody == CustodyOnlinePilot
	switch {
	case o.Custody != "" && !isProd:
		return fmt.Errorf("devtuf: %s is not a production (%s) repository; development and production never mix", dir, CustodyOnlinePilot)
	case o.Custody == "" && (st.Custody != "" || st.Env == "prod"):
		return errors.New("devtuf: this is a production repository; use --env prod --custody " + CustodyOnlinePilot + " --keys-dir DIR")
	case o.Custody == "" && !st.Development:
		return errors.New("devtuf: not a development repository")
	}
	return nil
}

// checkKeysDir: a real directory (no symlink), owned by the caller, no access for group or others.
func checkKeysDir(kd string, create bool) error {
	st, err := os.Lstat(kd)
	if errors.Is(err, os.ErrNotExist) && create {
		if err := os.MkdirAll(kd, 0o700); err != nil {
			return err
		}
		if err := os.Chmod(kd, 0o700); err != nil {
			return err
		}
		st, err = os.Lstat(kd)
	}
	if err != nil {
		return fmt.Errorf("devtuf: keys dir: %w", err)
	}
	if !st.IsDir() {
		return fmt.Errorf("devtuf: keys dir %s is not a directory", kd)
	}
	if st.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("devtuf: keys dir %s is mode %#o; it must be 0700", kd, st.Mode().Perm())
	}
	if sys, ok := st.Sys().(*syscall.Stat_t); ok && int(sys.Uid) != os.Geteuid() {
		return fmt.Errorf("devtuf: keys dir %s belongs to uid %d, not to this user", kd, sys.Uid)
	}
	return nil
}

func (r *Repo) checkNewProd() error {
	kd := r.keysDir()
	if err := checkKeysDir(kd, true); err != nil {
		return err
	}
	entries, err := os.ReadDir(kd)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".json") {
			return fmt.Errorf("devtuf: %s already holds keys; refusing to create a second production key set", kd)
		}
	}
	if _, err := os.Stat(filepath.Join(r.Dir, "metadata", "root.json")); err == nil {
		return fmt.Errorf("devtuf: %s already holds a repository", r.Dir)
	}
	if _, err := os.Stat(filepath.Join(r.Dir, "state.json")); err == nil {
		return fmt.Errorf("devtuf: %s already holds a repository", r.Dir)
	}
	return nil
}

func prodKeyFileName(role, id string) string { return fmt.Sprintf("%s-%s.json", role, id[:16]) }

func writeFileSync(path string, b []byte, mode os.FileMode) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	if _, err := f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// saveProdKeys writes every key that is not on disk yet (0600, never overwritten, never deleted: a key that is
// no longer in the root stays on disk until an operator removes it).
func (r *Repo) saveProdKeys() error {
	kd := r.keysDir()
	roles := make([]string, 0, len(r.keys))
	for role := range r.keys {
		roles = append(roles, role)
	}
	sort.Strings(roles)
	for _, role := range roles {
		for _, k := range r.keys[role] {
			key, _ := metadata.KeyFromPublicKey(k.Public())
			id, _ := key.ID()
			p := filepath.Join(kd, prodKeyFileName(role, id))
			b, _ := json.MarshalIndent(keyFile{Development: false, Environment: "prod", Custody: CustodyOnlinePilot,
				Warning: ProdWarning, Role: role, KeyID: id, Seed: base64.StdEncoding.EncodeToString(k.Seed())}, "", " ")
			if old, err := os.ReadFile(p); err == nil {
				if !bytes.Equal(old, b) {
					return fmt.Errorf("devtuf: %s exists with a different key", p)
				}
				continue
			}
			if err := writeFileSync(p, b, 0o600); err != nil {
				return err
			}
		}
	}
	if d, err := os.Open(kd); err == nil {
		_ = d.Sync()
		d.Close()
	}
	st := map[string]any{"env": r.Env, "development": false, "custody": CustodyOnlinePilot}
	return writeJSON(filepath.Join(r.Dir, "state.json"), st)
}

func parseProdKeyFile(b []byte, name string) (keyFile, ed25519.PrivateKey, error) {
	var kf keyFile
	if err := json.Unmarshal(b, &kf); err != nil || kf.Development || kf.Environment != "prod" || kf.Custody != CustodyOnlinePilot {
		return kf, nil, fmt.Errorf("devtuf: %s is not a production (%s) key; development and production keys never mix", name, CustodyOnlinePilot)
	}
	seed, err := base64.StdEncoding.DecodeString(kf.Seed)
	if err != nil || len(seed) != ed25519.SeedSize {
		return kf, nil, fmt.Errorf("devtuf: bad key %s", name)
	}
	k := ed25519.NewKeyFromSeed(seed)
	key, _ := metadata.KeyFromPublicKey(k.Public())
	if id, _ := key.ID(); id != kf.KeyID {
		return kf, nil, fmt.Errorf("devtuf: %s: key id does not match the key", name)
	}
	return kf, k, nil
}

func loadProd(dir string, opts Options) (*Repo, error) {
	opts.defaults()
	if err := checkMode(dir, opts); err != nil {
		return nil, err
	}
	r := &Repo{Dir: dir, Env: opts.Env, opts: opts, keys: map[string][]ed25519.PrivateKey{}}
	var st struct {
		Env         string `json:"env"`
		Development bool   `json:"development"`
		Custody     string `json:"custody"`
	}
	b, err := os.ReadFile(filepath.Join(dir, "state.json"))
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, &st); err != nil || st.Development || st.Env != "prod" || st.Custody != CustodyOnlinePilot {
		return nil, fmt.Errorf("devtuf: %s is not a production (%s) repository; development and production never mix", dir, CustodyOnlinePilot)
	}
	kd := r.keysDir()
	if err := checkKeysDir(kd, false); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(kd)
	if err != nil {
		return nil, err
	}
	byID := map[string]ed25519.PrivateKey{}
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		p := filepath.Join(kd, e.Name())
		info, err := os.Lstat(p)
		if err != nil {
			return nil, err
		}
		if !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
			return nil, fmt.Errorf("devtuf: key file %s must be a regular file with mode 0600", p)
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return nil, err
		}
		kf, k, err := parseProdKeyFile(b, p)
		if err != nil {
			return nil, err
		}
		if kf.Role == "assignment" {
			return nil, fmt.Errorf("devtuf: %s: production assignment keys belong to control, not to the update host", p)
		}
		byID[kf.KeyID] = k
	}
	if err := r.loadMetadata(); err != nil {
		return nil, err
	}
	if err := trust.CheckProductionRoot(r.root); err != nil {
		return nil, err
	}
	for _, role := range topRoles {
		for _, id := range r.root.Signed.Roles[role].KeyIDs {
			if k, ok := byID[id]; ok {
				r.keys[role] = append(r.keys[role], k)
			}
		}
		if len(r.keys[role]) == 0 {
			return nil, fmt.Errorf("devtuf: no private key for the %s role in %s", role, kd)
		}
	}
	if r.clients != nil && r.targets.Signed.Delegations != nil {
		for _, dr := range r.targets.Signed.Delegations.Roles {
			if dr.Name != trust.ClientsRole {
				continue
			}
			for _, id := range dr.KeyIDs {
				if k, ok := byID[id]; ok {
					r.keys[trust.ClientsRole] = append(r.keys[trust.ClientsRole], k)
				}
			}
		}
	}
	return r, nil
}

// RoleState is one role's current version and expiry.
type RoleState struct {
	Version int64     `json:"version"`
	Expires time.Time `json:"expires"`
}

// Status describes the published repository.
type Status struct {
	Env         string               `json:"env"`
	Custody     string               `json:"custody,omitempty"`
	Development bool                 `json:"development"`
	Roles       map[string]RoleState `json:"roles"`
	// Releases are the approved releases with their host, runtime and manager versions, ordered by id family, day
	// and counter (MG-44).
	Releases []ReleaseSummary `json:"releases"`
	Warnings []string         `json:"warnings"`
	// AssignmentKeys is the published control/assignment-keys.json document (nil: none yet).
	AssignmentKeys *release.AssignmentKeys `json:"assignmentKeys"`
	// PausedChannels names update channels currently carrying the pause marker.
	PausedChannels []string `json:"pausedChannels,omitempty"`
}

// Warning thresholds for Status and Refresh.
const (
	RootWarnWithin      = 30 * 24 * time.Hour
	TargetsRenewWithin  = 14 * 24 * time.Hour
	ClientsRenewWithin  = 7 * 24 * time.Hour
	statusExpiredFormat = "%s expired at %s"
)

// Status reports versions, expiries, approved releases and warnings (root expiring within 30 days, anything
// expired).
func (r *Repo) Status() Status {
	now := r.opts.Now().UTC()
	s := Status{Env: r.Env, Custody: r.opts.Custody, Development: !r.prod(), Roles: map[string]RoleState{
		metadata.ROOT:      {r.root.Signed.Version, r.root.Signed.Expires},
		metadata.TARGETS:   {r.targets.Signed.Version, r.targets.Signed.Expires},
		metadata.SNAPSHOT:  {r.snapshot.Signed.Version, r.snapshot.Signed.Expires},
		metadata.TIMESTAMP: {r.timestamp.Signed.Version, r.timestamp.Signed.Expires},
	}, Releases: []ReleaseSummary{}, Warnings: []string{}}
	if r.clients != nil {
		s.Roles[trust.ClientsRole] = RoleState{r.clients.Signed.Version, r.clients.Signed.Expires}
	}
	for _, c := range trust.Channels {
		if r.ChannelPaused(c) {
			s.PausedChannels = append(s.PausedChannels, c)
		}
	}
	if rs, err := r.PublishedReleases(); err != nil {
		s.Warnings = append(s.Warnings, "release targets: "+err.Error())
	} else {
		s.Releases = rs
	}
	if _, ok := r.targets.Signed.Targets[trust.AssignmentKeysTarget]; ok {
		doc := r.AssignmentKeysDoc()
		s.AssignmentKeys = &doc
	}
	names := make([]string, 0, len(s.Roles))
	for n := range s.Roles {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		if !s.Roles[n].Expires.After(now) {
			s.Warnings = append(s.Warnings, fmt.Sprintf(statusExpiredFormat, n, s.Roles[n].Expires.Format(time.RFC3339)))
		}
	}
	if exp := r.root.Signed.Expires; exp.After(now) && exp.Before(now.Add(RootWarnWithin)) {
		s.Warnings = append(s.Warnings, fmt.Sprintf("root expires at %s: re-sign it (tufrepo resign-root) or rotate it (PI-12)",
			exp.Format(time.RFC3339)))
	}
	return s
}

// Refresh is the periodic job (every 6 h on the update host): it always re-signs snapshot and timestamp, and
// re-signs the clients role when it expires within clientsWithin and targets when they expire within
// targetsWithin (both keys are online in the pilot). It returns the roles it signed. The root is never re-signed
// here; Status warns before it expires.
func (r *Repo) Refresh(targetsWithin, clientsWithin time.Duration) ([]string, error) {
	now := r.opts.Now().UTC()
	signed := []string{}
	if r.clients != nil && r.clients.Signed.Expires.Before(now.Add(clientsWithin)) {
		if r.ClientsKey() == nil {
			return nil, errors.New("devtuf: the clients role expires soon and its key is not here")
		}
		r.clients.Signed.Expires = now.Add(ClientsExpiry)
		if err := r.signClients(); err != nil {
			return nil, err
		}
		signed = append(signed, trust.ClientsRole)
	}
	if r.targets.Signed.Expires.Before(now.Add(targetsWithin)) {
		r.targets.Signed.Expires = now.Add(r.opts.TargetsExp)
		if err := r.Publish(); err != nil {
			return nil, err
		}
		return append(signed, metadata.TARGETS, metadata.SNAPSHOT, metadata.TIMESTAMP), nil
	}
	if err := r.PublishSnapshot(); err != nil {
		return nil, err
	}
	return append(signed, metadata.SNAPSHOT, metadata.TIMESTAMP), nil
}

// ResignRoot publishes a new root version with the same keys and a fresh expiry (RootExpiry from now; 120 days
// in the pilot), signed by the current root keys. Devices walk to it on their next refresh.
func (r *Repo) ResignRoot() error {
	r.root.Signed.Version++
	r.root.Signed.Expires = r.opts.Now().UTC().Add(r.opts.RootExpiry)
	return r.signWriteRoot(nil)
}

// VerifiedRoot reads <dir>/metadata/root.json and checks that it is self-signed to its threshold; for a
// production root also that it trusts no development key. This is what an image pins.
func VerifiedRoot(dir string, production bool) ([]byte, error) {
	b, err := os.ReadFile(filepath.Join(dir, "metadata", "root.json"))
	if err != nil {
		return nil, err
	}
	root, err := metadata.Root().FromBytes(b)
	if err != nil {
		return nil, err
	}
	if err := root.VerifyDelegate(metadata.ROOT, root); err != nil {
		return nil, fmt.Errorf("devtuf: root.json is not signed by its own keys: %w", err)
	}
	if production {
		if err := trust.CheckProductionRoot(root); err != nil {
			return nil, err
		}
	}
	return b, nil
}
