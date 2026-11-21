package trust

import (
	"encoding/hex"
	"errors"
	"fmt"
	"strings"

	"github.com/CybexBV/whombat/contracts/go/release"
	"github.com/theupdateframework/go-tuf/v2/metadata"
	"github.com/theupdateframework/go-tuf/v2/metadata/updater"
)

// ClientsRole is the delegated targets role that signs the client channel and the client bundle artifacts
// (CT-74). Its key is online (the channel publisher's); the delegation limits it to ClientsRolePaths, so it can
// never approve a release tuple, a runtime or a host artifact, or the assignment keys (MG-33).
const ClientsRole = "clients"

// ClientsRolePaths are the delegation's path patterns. go-tuf matches them per path segment, so
// `clients/channel.json` and `clients/<provider>/<version>/<os>-<arch>.tar.gz` need one pattern each.
var ClientsRolePaths = []string{"clients/*", "clients/*/*/*"}

// ErrClientsUnavailable: the client channel is not (yet) published or its role could not be verified. The
// installed release is unaffected; the manager only cannot install or update AI clients.
var ErrClientsUnavailable = errors.New("client channel unavailable")

// resolveClients looks up the client channel through the delegation (pre-order walk: the top-level targets
// first, then the `clients` role) and records every clients/ target the walk made trusted. Called after a
// successful top-level refresh; a failure here never fails the refresh.
func (r *Repo) resolveClients(up *updater.Updater) {
	r.clientTargets = map[string]*metadata.TargetFiles{}
	if _, err := up.GetTargetInfo(release.ClientChannelTarget); err != nil {
		r.clientsErr = fmt.Errorf("%w: %v", ErrClientsUnavailable, classify(err))
		return
	}
	set := up.GetTrustedMetadataSet()
	top := set.Targets[metadata.TARGETS]
	// Delegated first, then the top-level targets override (TUF pre-order: the top-level role wins).
	if top.Signed.Delegations != nil {
		for _, role := range top.Signed.Delegations.Roles {
			if role.Name != ClientsRole {
				continue
			}
			md := set.Targets[ClientsRole]
			if md == nil {
				continue
			}
			for p, tf := range md.Signed.Targets {
				if ok, err := role.IsDelegatedPath(p); err == nil && ok && strings.HasPrefix(p, "clients/") {
					r.clientTargets[p] = tf
				}
			}
		}
	}
	for p, tf := range top.Signed.Targets {
		if strings.HasPrefix(p, "clients/") {
			r.clientTargets[p] = tf
		}
	}
	if _, ok := r.clientTargets[release.ClientChannelTarget]; !ok {
		r.clientsErr = fmt.Errorf("%w: %s not found", ErrClientsUnavailable, release.ClientChannelTarget)
	}
}

// ClientsError reports why the client targets are unavailable (nil when the channel resolved). A Repo from a
// refresh without Config.ResolveClients always reports ErrClientsUnavailable.
func (r *Repo) ClientsError() error {
	if r.clientTargets == nil && r.clientsErr == nil {
		return fmt.Errorf("%w: not resolved", ErrClientsUnavailable)
	}
	return r.clientsErr
}

// ClientTarget returns a verified clients/ target (the channel or a bundle artifact) with its TUF length and
// hashes. The client channel is plain signed JSON without Whombat custom metadata; bundle artifacts carry none.
func (r *Repo) ClientTarget(path string) (Artifact, error) {
	if err := r.ClientsError(); err != nil {
		return Artifact{}, err
	}
	tf, ok := r.clientTargets[path]
	if !ok {
		return Artifact{}, fmt.Errorf("%w: %s", ErrNotApproved, path)
	}
	hashes := map[string]string{}
	for alg, h := range tf.Hashes {
		if alg != "sha256" && alg != "sha512" {
			return Artifact{}, fmt.Errorf("%w: %s: unsupported hash %s", ErrInvalidMetadata, path, alg)
		}
		hashes[alg] = hex.EncodeToString(h)
	}
	if len(hashes["sha256"]) != 64 || tf.Length <= 0 {
		return Artifact{}, fmt.Errorf("%w: %s needs a sha256 hash and a length", ErrInvalidMetadata, path)
	}
	return Artifact{Target: path, Length: tf.Length, Hashes: hashes}, nil
}
