package devtuf

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/canonjson"
	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/contracts/go/release"
	"github.com/theupdateframework/go-tuf/v2/metadata"
)

// ClientsExpiry is how long a clients role version stays valid. The channel publisher re-signs it with every
// channel (the channel itself lives at most 14 days, CT-74), so the role never outlives two missed publishes.
const ClientsExpiry = 21 * 24 * time.Hour

// HasClientsRole reports whether the top-level targets delegate the clients role.
func (r *Repo) HasClientsRole() bool { return r.clients != nil }

// AddClientsRole delegates `clients/*` and `clients/*/*/*` to a new `clients` role held by pub (the online channel
// key, MG-33), publishes an empty role version 1 signed with priv (nil: a fresh development key is generated and
// kept with the repository's keys) and republishes targets, snapshot and timestamp. The top-level targets keys
// sign the delegation once; afterwards the role advances without them.
func (r *Repo) AddClientsRole(priv ed25519.PrivateKey) error {
	if r.clients != nil {
		return errors.New("devtuf: the clients role exists already")
	}
	if priv == nil {
		priv = newKey()
	}
	key, err := metadata.KeyFromPublicKey(priv.Public())
	if err != nil {
		return err
	}
	id, err := key.ID()
	if err != nil {
		return err
	}
	r.delegate(key, id, metadata.DelegatedRole{Name: trust.ClientsRole, KeyIDs: []string{id}, Threshold: 1, Terminating: true,
		Paths: append([]string{}, trust.ClientsRolePaths...)})
	r.keys[trust.ClientsRole] = []ed25519.PrivateKey{priv}
	now := r.opts.Now().UTC()
	r.clients = metadata.Targets(now.Add(ClientsExpiry))
	r.clients.Signed.Version = 0
	if err := r.signClients(); err != nil {
		return err
	}
	if err := r.saveKeys(); err != nil {
		return err
	}
	return r.Publish()
}

// ClientsKey returns the clients role's private key when the repository holds it (development).
func (r *Repo) ClientsKey() ed25519.PrivateKey {
	if ks := r.keys[trust.ClientsRole]; len(ks) > 0 {
		return ks[0]
	}
	return nil
}

// ClientChannelKeyID is the channel key id of a clients key: "clients-<env>-<12 hex of sha256(pub)>".
func ClientChannelKeyID(env string, pub ed25519.PublicKey) string {
	sum := sha256.Sum256(pub)
	return "clients-" + env + "-" + hex.EncodeToString(sum[:6])
}

// ClientsEnv is the env the repository's AI client channel is signed for (the channel's payload and its key id): the
// repository's env, unless the GitHub repository was set to production's (SetClientsEnv, ONE-05). A box accepts only a
// channel of its identity's env (CT-74).
func (r *Repo) ClientsEnv() string {
	if r.clientsEnv != "" {
		return r.clientsEnv
	}
	return r.Env
}

// SetClientsEnv makes the GitHub repository sign its AI client channel for env (ONE-05: one environment, production;
// the repository itself stays the continued development one). From the next channel signed on: the key stays the
// clients role's, its key id and the payload name the new env, so boxes of the old env refuse it from then on and
// boxes of the new one pin `ClientChannelKeys`. Saved with the repository's state.
func (r *Repo) SetClientsEnv(env string) error {
	if !r.GitHub() {
		return errors.New("devtuf: only the GitHub repository's client channel changes env")
	}
	switch env {
	case "prod", "local", "dev":
	default:
		return fmt.Errorf("devtuf: clients env %q (prod, dev or local)", env)
	}
	if env == r.Env {
		env = ""
	}
	r.clientsEnv = env
	return r.saveKeys()
}

// ClientChannelKeys is the pinned channel key document (AssignmentKeys shape, CT-74) for the repository's clients
// key: what a device configures as `clients.channelKeys`.
func (r *Repo) ClientChannelKeys() (release.AssignmentKeys, error) {
	k := r.ClientsKey()
	if k == nil {
		return release.AssignmentKeys{}, errors.New("devtuf: no clients key in this repository")
	}
	return ChannelKeysFor(r.ClientsEnv(), k.Public().(ed25519.PublicKey)), nil
}

// ChannelKeysFor is the channel key document with one active key.
func ChannelKeysFor(env string, pub ed25519.PublicKey) release.AssignmentKeys {
	return release.AssignmentKeys{V: 1, Env: release.Environment(env), Keys: []release.AssignmentKeysKeysItem{{
		Kid: ClientChannelKeyID(env, pub), PublicKey: hex.EncodeToString(pub), State: "active"}}}
}

// ClientTargets lists the clients role's current targets (path → sha256 hex).
func (r *Repo) ClientTargets() map[string]string {
	out := map[string]string{}
	if r.clients != nil {
		for p, tf := range r.clients.Signed.Targets {
			out[p] = hex.EncodeToString(tf.Hashes["sha256"])
		}
	}
	return out
}

// ClientTargetContent reads a published clients target back (e.g. the current channel).
func (r *Repo) ClientTargetContent(targetPath string) ([]byte, error) {
	if r.clients == nil {
		return nil, errors.New("devtuf: no clients role")
	}
	tf, ok := r.clients.Signed.Targets[targetPath]
	if !ok {
		return nil, os.ErrNotExist
	}
	return os.ReadFile(filepath.Join(r.targetsDir(), filepath.FromSlash(consistentName(targetPath, hex.EncodeToString(tf.Hashes["sha256"])))))
}

// PublishClients replaces clients targets (path → content; nil content removes the target), signs a new clients
// role version with key (nil: the repository's own clients key) and publishes snapshot and timestamp. Only paths
// inside the delegation are accepted. The target files are written before any metadata names them.
func (r *Repo) PublishClients(key ed25519.PrivateKey, put map[string][]byte) error {
	return r.publishClients(key, put, true)
}

// PublishClientsUnchecked is PublishClients without the delegation check. Tests only: it lets a test sign a target
// outside `clients/` with the clients key to prove that devices ignore it.
func (r *Repo) PublishClientsUnchecked(key ed25519.PrivateKey, put map[string][]byte) error {
	return r.publishClients(key, put, false)
}

func (r *Repo) publishClients(key ed25519.PrivateKey, put map[string][]byte, check bool) error {
	if r.clients == nil {
		return errors.New("devtuf: no clients role (tufrepo add-clients-role)")
	}
	if key == nil {
		key = r.ClientsKey()
	}
	if key == nil {
		return errors.New("devtuf: no clients key")
	}
	role, _ := r.delegatedRole(trust.ClientsRole)
	pk, _ := metadata.KeyFromPublicKey(key.Public())
	id, _ := pk.ID()
	if len(role.KeyIDs) != 1 || role.KeyIDs[0] != id {
		return errors.New("devtuf: this key does not hold the clients role")
	}
	paths := make([]string, 0, len(put))
	for p := range put {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	for _, p := range paths {
		if ok, err := role.IsDelegatedPath(p); check && (err != nil || !ok) {
			return fmt.Errorf("devtuf: %s is outside the clients delegation", p)
		}
		if put[p] == nil {
			delete(r.clients.Signed.Targets, p)
			continue
		}
		tf, err := metadata.TargetFile().FromBytes(p, put[p], "sha256")
		if err != nil {
			return err
		}
		dst := filepath.Join(r.targetsDir(), filepath.FromSlash(consistentName(p, hex.EncodeToString(tf.Hashes["sha256"]))))
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(dst+".tmp", put[p], 0o644); err != nil {
			return err
		}
		if err := os.Rename(dst+".tmp", dst); err != nil {
			return err
		}
		r.clients.Signed.Targets[p] = tf
	}
	r.clients.Signed.Expires = r.opts.Now().UTC().Add(ClientsExpiry)
	r.keysOverride = key
	defer func() { r.keysOverride = nil }()
	if err := r.signClients(); err != nil {
		return err
	}
	return r.PublishSnapshot()
}

func (r *Repo) signClients() error {
	r.clients.Signed.Version++
	r.clients.ClearSignatures()
	k := r.keysOverride
	if k == nil {
		k = r.ClientsKey()
	}
	if _, err := r.clients.Sign(signer(k)); err != nil {
		return err
	}
	return writeJSON(filepath.Join(r.metaDir(), fmt.Sprintf("%d.%s.json", r.clients.Signed.Version, trust.ClientsRole)), r.clients)
}

// SignClientChannel signs a channel payload in the contract format {payload, keyId, sig=hex(Ed25519(JCS(payload)))}.
func SignClientChannel(p release.ClientChannelPayload, kid string, key ed25519.PrivateKey) (*release.SignedClientChannel, error) {
	body, err := canonjson.Marshal(p)
	if err != nil {
		return nil, err
	}
	return &release.SignedClientChannel{Payload: p, KeyID: kid, Sig: hex.EncodeToString(ed25519.Sign(key, body))}, nil
}

// TargetFilePathClients returns the on-disk path of a published clients target (for corruption fixtures).
func (r *Repo) TargetFilePathClients(targetPath string) (string, error) {
	if r.clients == nil {
		return "", errors.New("devtuf: no clients role")
	}
	tf, ok := r.clients.Signed.Targets[targetPath]
	if !ok {
		return "", fmt.Errorf("no clients target %s", targetPath)
	}
	return filepath.Join(r.targetsDir(), filepath.FromSlash(consistentName(targetPath, hex.EncodeToString(tf.Hashes["sha256"])))), nil
}
