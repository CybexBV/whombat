// Package clientchannel builds client bundles from the vendors' official artifacts and publishes the signed client
// channel (CT-74, SUB-09) as the TUF target clients/channel.json of the delegated `clients` role.
//
// Artifacts are the official downloads, unmodified: Codex's release package (a tar.gz) is the TUF artifact itself,
// byte for byte; Claude Code's release is the bare executable, which is wrapped in a reproducible tar.gz with the
// executable as its only member (`claude`, mode 0755) — the executable's bytes are unchanged, so its sha256 is the
// release manifest's checksum (SUB-15).
package clientchannel

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/canonjson"
	"github.com/CybexBV/whombat/appliance/manager/pkg/clientbundle"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
	"github.com/CybexBV/whombat/contracts/go/release"
)

// Input describes one tested client version for one platform.
type Input struct {
	Provider release.ClientProvider
	Version  string
	Arch     release.ClientArch
	// PublishedAt is the upstream publication time, TestedAt when the Whombat provider tests passed.
	PublishedAt, TestedAt time.Time
	// FixturesDigest: sha256 of the provider fixtures regenerated from this executable ("sha256:<hex>").
	FixturesDigest string
	Adapter        release.IntRange
	// SourceURL is the official download (https); SourceFile its downloaded bytes.
	SourceURL  string
	SourceFile string
	// SourceFormat is "binary" (Claude Code) or "tar.gz" (Codex's package); SourcePath the executable inside a
	// tar.gz (e.g. bin/codex).
	SourceFormat string
	SourcePath   string
	// ExpectSourceSHA256, when set, must equal the source's sha256 (the vendor's published digest: Claude Code's
	// manifest.json checksum, the GitHub release asset digest).
	ExpectSourceSHA256 string
}

// PlainChannelPath is where, relative to the repository directory the updates host serves, the publisher also puts the
// signed channel for self-hosted servers (outside TUF).
const PlainChannelPath = "clients/channel.json"

// Built is a bundle and its artifact file.
type Built struct {
	Bundle       release.ClientBundle
	ArtifactFile string
}

func sha256File(p string) (string, int64, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	return hex.EncodeToString(h.Sum(nil)), n, err
}

// Build checks the source against the vendor digest, makes the artifact in workDir and describes the bundle. The
// artifact is unpacked with the manager's own code (clientbundle) and the executable hashed from there, so what is
// signed is what installs.
func Build(ctx context.Context, in Input, workDir string) (*Built, error) {
	srcSHA, srcSize, err := sha256File(in.SourceFile)
	if err != nil {
		return nil, err
	}
	if in.ExpectSourceSHA256 != "" && !strings.EqualFold(strings.TrimPrefix(in.ExpectSourceSHA256, "sha256:"), srcSHA) {
		return nil, fmt.Errorf("%s: sha256 %s, the vendor publishes %s", in.SourceURL, srcSHA, in.ExpectSourceSHA256)
	}
	if err := os.MkdirAll(workDir, 0o755); err != nil {
		return nil, err
	}
	b := release.ClientBundle{Provider: in.Provider, Version: in.Version, Os: release.ClientOsLinux, Arch: in.Arch,
		PublishedAt: in.PublishedAt.Unix(), TestedAt: in.TestedAt.Unix(), FixturesDigest: in.FixturesDigest, Adapter: in.Adapter,
		Source: release.ClientBundleSource{URL: in.SourceURL, SHA256: srcSHA, Size: srcSize, Format: in.SourceFormat}}
	b.Artifact.Target = release.ClientBundleTarget(in.Provider, in.Version, release.ClientOsLinux, in.Arch)
	art := filepath.Join(workDir, fmt.Sprintf("%s-%s-linux-%s.tar.gz", in.Provider, in.Version, in.Arch))
	switch in.SourceFormat {
	case "binary":
		name := string(in.Provider)
		b.Artifact.Path = name
		f, err := os.Create(art)
		if err != nil {
			return nil, err
		}
		err = clientbundle.WriteTarGz(f, []clientbundle.Entry{{Name: name, Exec: true, Path: in.SourceFile}})
		if cerr := f.Close(); err == nil {
			err = cerr
		}
		if err != nil {
			return nil, err
		}
		b.Executable = release.ClientBundleExecutable{SHA256: srcSHA, Size: srcSize}
	case "tar.gz":
		if in.SourcePath == "" {
			return nil, errors.New("a tar.gz source needs the executable's path inside it")
		}
		p := in.SourcePath
		b.Source.Path = &p
		b.Artifact.Path = p
		if err := copyFile(in.SourceFile, art); err != nil {
			return nil, err
		}
	default:
		return nil, fmt.Errorf("unknown source format %q", in.SourceFormat)
	}
	aSHA, aSize, err := sha256File(art)
	if err != nil {
		return nil, err
	}
	b.Artifact.SHA256, b.Artifact.Size = aSHA, aSize
	// Install it the way the manager does and hash the executable from there.
	check := filepath.Join(workDir, ".check-"+string(in.Provider)+"-"+in.Version)
	_ = clientbundle.ForceRemove(check)
	if err := clientbundle.Unpack(ctx, art, check, clientbundle.Limits{}, nil); err != nil {
		return nil, fmt.Errorf("the artifact would not install: %w", err)
	}
	defer clientbundle.ForceRemove(check)
	exe := filepath.Join(check, filepath.FromSlash(b.Artifact.Path))
	eSHA, eSize, err := sha256File(exe)
	if err != nil {
		return nil, fmt.Errorf("executable %s: %w", b.Artifact.Path, err)
	}
	if in.SourceFormat == "binary" && eSHA != srcSHA {
		return nil, errors.New("the wrapped executable differs from the source (never happens: bytes are copied)")
	}
	b.Executable = release.ClientBundleExecutable{SHA256: eSHA, Size: eSize}
	if err := clientbundle.CheckExecutable(check, b.Artifact.Path, eSize, eSHA); err != nil {
		return nil, err
	}
	if err := b.Validate(); err != nil {
		return nil, fmt.Errorf("bundle: %w", err)
	}
	return &Built{Bundle: b, ArtifactFile: art}, nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// Publisher publishes channels into a development TUF repository (the dev instance's). Production publishes the
// same documents through the release publishing service (docs/runbooks/updates.md, “AI client channel”).
type Publisher struct {
	Repo *devtuf.Repo
	// Key holds the clients role and signs the channel (nil: the repository's own development clients key).
	Key ed25519.PrivateKey
	Now func() time.Time
	// Lifetime of a channel (default 7 days, at most 14; the job re-signs daily).
	Lifetime time.Duration
	// Keep: bundles kept per provider and architecture (default 4, newest first), for rollback and older runtimes.
	Keep int
}

func (p *Publisher) key() ed25519.PrivateKey {
	if p.Key != nil {
		return p.Key
	}
	return p.Repo.ClientsKey()
}

func (p *Publisher) now() time.Time {
	if p.Now != nil {
		return p.Now()
	}
	return time.Now()
}

// Current returns the published channel (nil when there is none yet).
func (p *Publisher) Current() (*release.SignedClientChannel, error) {
	raw, err := p.Repo.ClientTargetContent(release.ClientChannelTarget)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return release.ParseSignedClientChannel(raw)
}

func bundleID(b release.ClientBundle) string {
	return string(b.Provider) + "/" + b.Version + "/" + string(b.Os) + "-" + string(b.Arch)
}

// CompareVersions orders dotted versions numerically where both parts are numbers (2.1.290 > 2.1.99).
func CompareVersions(a, b string) int {
	as, bs := strings.FieldsFunc(a, sep), strings.FieldsFunc(b, sep)
	for i := 0; i < len(as) && i < len(bs); i++ {
		x, xe := strconv.ParseInt(as[i], 10, 64)
		y, ye := strconv.ParseInt(bs[i], 10, 64)
		switch {
		case xe == nil && ye == nil && x != y:
			if x < y {
				return -1
			}
			return 1
		case (xe != nil || ye != nil) && as[i] != bs[i]:
			return strings.Compare(as[i], bs[i])
		}
	}
	return len(as) - len(bs)
}

func sep(r rune) bool { return r == '.' || r == '-' || r == '+' }

// Publish signs and publishes a new channel: the current bundles, minus `withdraw` (ids provider/version or
// provider/version/os-arch) and minus bundles replaced by `add`, plus `add`; newest first per provider; at most
// Keep per provider and architecture. Artifacts of new bundles become clients targets, those of dropped bundles are
// removed. With nothing added or withdrawn it re-signs the same bundles (a refresh before expiry).
func (p *Publisher) Publish(add []Built, withdraw []string) (*release.SignedClientChannel, error) {
	key := p.key()
	if key == nil {
		return nil, errors.New("no clients key")
	}
	cur, err := p.Current()
	if err != nil {
		return nil, fmt.Errorf("current channel: %w", err)
	}
	var seq int64 = 1
	var bundles []release.ClientBundle
	if cur != nil {
		seq = cur.Payload.Sequence + 1
		bundles = cur.Payload.Bundles
	}
	drop := map[string]bool{}
	for _, w := range withdraw {
		drop[w] = true
	}
	for _, a := range add {
		drop[bundleID(a.Bundle)] = true
	}
	withdrawn := func(b release.ClientBundle) bool {
		return drop[bundleID(b)] || drop[string(b.Provider)+"/"+b.Version]
	}
	var next []release.ClientBundle
	put := map[string][]byte{}
	for _, b := range bundles {
		if withdrawn(b) {
			put[b.Artifact.Target] = nil
			continue
		}
		next = append(next, b)
	}
	for _, a := range add {
		data, err := os.ReadFile(a.ArtifactFile)
		if err != nil {
			return nil, err
		}
		sum := sha256.Sum256(data)
		if hex.EncodeToString(sum[:]) != a.Bundle.Artifact.SHA256 || int64(len(data)) != a.Bundle.Artifact.Size {
			return nil, fmt.Errorf("%s changed since it was built", a.ArtifactFile)
		}
		put[a.Bundle.Artifact.Target] = data
		next = append(next, a.Bundle)
	}
	sort.SliceStable(next, func(i, j int) bool {
		if next[i].Provider != next[j].Provider {
			return next[i].Provider < next[j].Provider
		}
		return CompareVersions(next[i].Version, next[j].Version) > 0
	})
	keep := p.Keep
	if keep <= 0 {
		keep = 4
	}
	count := map[string]int{}
	var kept []release.ClientBundle
	for _, b := range next {
		k := string(b.Provider) + "/" + string(b.Arch)
		if count[k] >= keep {
			put[b.Artifact.Target] = nil
			continue
		}
		count[k]++
		kept = append(kept, b)
	}
	if len(kept) > release.ClientChannelMaxBundles {
		return nil, fmt.Errorf("%d bundles, at most %d", len(kept), release.ClientChannelMaxBundles)
	}
	life := p.Lifetime
	if life <= 0 {
		life = 7 * 24 * time.Hour
	}
	if life > release.ClientChannelMaxLifetimeS*time.Second {
		life = release.ClientChannelMaxLifetimeS * time.Second
	}
	now := p.now().UTC()
	if kept == nil {
		kept = []release.ClientBundle{}
	}
	payload := release.ClientChannelPayload{Purpose: release.ClientChannelPurpose, Env: release.Environment(p.Repo.ClientsEnv()),
		Sequence: seq, IssuedAt: now.Unix(), ExpiresAt: now.Add(life).Unix(), Bundles: kept}
	if err := payload.Validate(); err != nil {
		return nil, fmt.Errorf("channel payload: %w", err)
	}
	signed, err := devtuf.SignClientChannel(payload, devtuf.ClientChannelKeyID(p.Repo.ClientsEnv(), key.Public().(ed25519.PublicKey)), key)
	if err != nil {
		return nil, err
	}
	raw, err := canonjson.Marshal(signed)
	if err != nil {
		return nil, err
	}
	// Self-check with the contract verifier before anything is published.
	if _, err := release.VerifyClientChannel(raw, release.ClientChannelContext{
		Keys: map[string]ed25519.PublicKey{signed.KeyID: key.Public().(ed25519.PublicKey)}, Env: payload.Env, Now: now.Unix(),
		LastSequence: seq - 1}); err != nil {
		return nil, fmt.Errorf("the new channel does not verify: %w", err)
	}
	put[release.ClientChannelTarget] = raw
	if err := p.Repo.PublishClients(key, put); err != nil {
		return nil, err
	}
	// The same signed document at a plain path for self-hosted servers, which have no TUF (SUB-26:
	// https://updates.whombat.com/clients/channel.json; they verify it with their own pinned keys).
	plain := filepath.Join(p.Repo.Dir, PlainChannelPath)
	if err := os.MkdirAll(filepath.Dir(plain), 0o755); err != nil {
		return nil, err
	}
	if err := os.WriteFile(plain+".tmp", raw, 0o644); err != nil {
		return nil, err
	}
	if err := os.Rename(plain+".tmp", plain); err != nil {
		return nil, err
	}
	return signed, nil
}

// Mirror makes the client channel of `to` the one `from` publishes, byte for byte: the same signed channel document
// (the same sequence) and its bundles' artifacts, the role signed with to's clients key (key nil: the repository's
// own). The GitHub repository (Whombat LNK-24, LNK-50) gets DEV's channel this way while DEV's repository still feeds
// the boxes before the bridge: a box keeps the highest sequence it accepted and refuses a lower one, so the two never
// count apart. It refuses to move `to` back (a higher sequence, or other bytes under the same one) and a channel
// to's key doesn't sign. False: `to` has it already.
func Mirror(from, to *devtuf.Repo, key ed25519.PrivateKey, now time.Time) (*release.SignedClientChannel, bool, error) {
	if key == nil {
		key = to.ClientsKey()
	}
	if key == nil {
		return nil, false, errors.New("no clients key for the repository mirrored into")
	}
	raw, err := from.ClientTargetContent(release.ClientChannelTarget)
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, errors.New("the source repository has no client channel")
	}
	if err != nil {
		return nil, false, err
	}
	src, err := release.ParseSignedClientChannel(raw)
	if err != nil {
		return nil, false, err
	}
	var last int64
	cur, err := to.ClientTargetContent(release.ClientChannelTarget)
	switch {
	case err == nil:
		dst, err := release.ParseSignedClientChannel(cur)
		if err != nil {
			return nil, false, err
		}
		if string(cur) == string(raw) {
			return src, false, nil
		}
		if dst.Payload.Sequence >= src.Payload.Sequence {
			return nil, false, fmt.Errorf("the mirror has channel %d, the source %d: it would move back", dst.Payload.Sequence, src.Payload.Sequence)
		}
		last = dst.Payload.Sequence
	case !errors.Is(err, os.ErrNotExist):
		return nil, false, err
	}
	pub := key.Public().(ed25519.PublicKey)
	if _, err := release.VerifyClientChannel(raw, release.ClientChannelContext{Keys: map[string]ed25519.PublicKey{
		devtuf.ClientChannelKeyID(to.ClientsEnv(), pub): pub}, Env: release.Environment(to.ClientsEnv()), Now: now.Unix(), LastSequence: last}); err != nil {
		return nil, false, fmt.Errorf("the source's channel doesn't verify for the mirror: %w", err)
	}
	put := map[string][]byte{release.ClientChannelTarget: raw}
	for _, b := range src.Payload.Bundles {
		data, err := from.ClientTargetContent(b.Artifact.Target)
		if err != nil {
			return nil, false, fmt.Errorf("%s: %w", b.Artifact.Target, err)
		}
		sum := sha256.Sum256(data)
		if hex.EncodeToString(sum[:]) != b.Artifact.SHA256 || int64(len(data)) != b.Artifact.Size {
			return nil, false, fmt.Errorf("%s isn't the artifact the channel names", b.Artifact.Target)
		}
		put[b.Artifact.Target] = data
	}
	for p := range to.ClientTargets() {
		if _, ok := put[p]; !ok {
			put[p] = nil
		}
	}
	if err := to.PublishClients(key, put); err != nil {
		return nil, false, err
	}
	return src, true, nil
}
