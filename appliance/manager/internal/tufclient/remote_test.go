package tufclient

import (
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/contracts/go/release"
)

// TestRemoteRepository verifies a live production repository the way a device does (PI-05/PI-11 end-to-end check,
// control infra/hetzner/standin/e2e.sh). It runs only when WB_TUF_REMOTE is set:
//
//	WB_TUF_REMOTE=http://127.0.0.1:PORT  the repository base (metadata/ and targets/ below it)
//	WB_TUF_ROOT=root.json                the pinned root (what tuf-init printed)
//	WB_TUF_RELEASE=<releaseId>           a release to resolve and download (optional with WB_TUF_CLIENT_KEYS)
//	WB_TUF_ASSIGNMENT_KID=<kid>          optional: a kid control/assignment-keys.json must accept
//	WB_TUF_STAGING=<dir>                 optional: keep the verified artifacts there (<sha256> files)
//	WB_TUF_CLIENT_KEYS=<file>            optional: the pinned client channel key document (manifest/prod/
//	                                     clients-channel-keys.json); the channel must resolve and verify with it, and
//	                                     every bundle's artifact must download and match its TUF hashes (PI-17)
//
// Production checks are on (no development key in any root). The first artifact is downloaded in two steps (a
// partial file, then a Range resume). The helper's view is checked from the manager's mirror.
func TestRemoteRepository(t *testing.T) {
	base := os.Getenv("WB_TUF_REMOTE")
	if base == "" {
		t.Skip("WB_TUF_REMOTE not set")
	}
	ctx := context.Background()
	c := &Client{PinnedRootPath: os.Getenv("WB_TUF_ROOT"), CacheDir: t.TempDir(), MirrorDir: t.TempDir(),
		MetadataURL: base + "/metadata", Fetcher: NewHTTPFetcher("whombat-e2e"), Production: true, ResolveClients: true}
	repo, err := c.Refresh(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("refreshed: root v%d, targets v%d, snapshot v%d, timestamp v%d (expires %s); releases %v",
		repo.RootVersion, repo.TargetsVersion, repo.SnapshotVersion, repo.TimestampVersion,
		repo.TimestampExpires.Format(time.RFC3339), repo.ReleaseIDs())
	clientKeys := os.Getenv("WB_TUF_CLIENT_KEYS")
	if err := repo.ClientsError(); err != nil && (clientKeys != "" || !strings.Contains(err.Error(), "channel.json not found")) {
		t.Fatalf("clients role: %v", err)
	}
	if clientKeys != "" {
		checkRemoteClientChannel(t, ctx, repo, base, clientKeys)
	}
	ks, err := repo.AssignmentKeys("prod", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if kid := os.Getenv("WB_TUF_ASSIGNMENT_KID"); kid != "" {
		if _, ok := ks.Keys[kid]; !ok {
			t.Fatalf("assignment key %s not accepted; have %v", kid, ks.Keys)
		}
	}
	id := os.Getenv("WB_TUF_RELEASE")
	if id == "" && clientKeys != "" {
		return
	}
	rel, err := repo.Release(id)
	if err != nil {
		t.Fatal(err)
	}
	staging := os.Getenv("WB_TUF_STAGING")
	if staging == "" {
		staging = t.TempDir()
	}
	d := &Downloader{StagingDir: staging, Source: HTTPSource{BaseURL: base + "/targets"}, Space: StatfsSpace{}}
	for i, a := range rel.Artifacts() {
		if i == 0 {
			// Half the file first: the download resumes with a Range request.
			resp, err := http.Get(base + "/targets/" + RemotePath(a))
			if err != nil {
				t.Fatal(err)
			}
			b, _ := io.ReadAll(io.LimitReader(resp.Body, a.Length/2))
			resp.Body.Close()
			os.MkdirAll(staging, 0o755)
			if err := os.WriteFile(filepath.Join(staging, a.SHA256()+".part"), b, 0o644); err != nil {
				t.Fatal(err)
			}
		}
		if err := d.Download(ctx, a); err != nil {
			t.Fatalf("%s: %v", a.Target, err)
		}
		if !d.Present(a) {
			t.Fatalf("%s not staged", a.Target)
		}
		t.Logf("verified %s (%d bytes) -> %s", a.Target, a.Length, filepath.Join(staging, a.SHA256()))
	}
	// The update helper verifies again from the manager's mirror, on its own cache.
	pinned, _ := os.ReadFile(c.PinnedRootPath)
	hv, err := trust.Refresh(trust.Config{PinnedRoot: pinned, MetadataDir: t.TempDir(), MetadataURL: "mirror://whombat-tuf",
		Fetcher: trust.DirFetcher{BaseURL: "mirror://whombat-tuf", Dir: c.MirrorDir}, Now: time.Now(), Production: true})
	if err != nil {
		t.Fatalf("helper view: %v", err)
	}
	if _, err := hv.Release(id); err != nil {
		t.Fatalf("helper view: %v", err)
	}
}

// checkRemoteClientChannel does what a manager does with the client channel (MG-33): the channel target verified with
// the pinned channel key document as a prod channel, then each bundle's artifact downloaded against its TUF hashes.
func checkRemoteClientChannel(t *testing.T, ctx context.Context, repo *trust.Repo, base, keysFile string) {
	t.Helper()
	a, err := repo.ClientTarget(release.ClientChannelTarget)
	if err != nil {
		t.Fatal(err)
	}
	staging := t.TempDir()
	d := &Downloader{StagingDir: staging, Source: HTTPSource{BaseURL: base + "/targets"}, Space: StatfsSpace{}}
	if err := d.Download(ctx, a); err != nil {
		t.Fatalf("channel: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(staging, a.SHA256()))
	if err != nil {
		t.Fatal(err)
	}
	keysRaw, err := os.ReadFile(keysFile)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	km, err := release.AssignmentKeyMap(keysRaw, "prod", now.Unix())
	if err != nil {
		t.Fatal(err)
	}
	keys := map[string]ed25519.PublicKey{}
	for kid, h := range km {
		pub, err := hex.DecodeString(h)
		if err != nil || len(pub) != ed25519.PublicKeySize {
			t.Fatalf("channel keys: bad key %q", kid)
		}
		keys[kid] = pub
	}
	ch, err := release.VerifyClientChannel(raw, release.ClientChannelContext{Keys: keys, Env: "prod", Now: now.Unix()})
	if err != nil {
		t.Fatalf("channel does not verify with %s: %v", keysFile, err)
	}
	t.Logf("client channel %d (key %s, expires %s)", ch.Payload.Sequence, ch.KeyID,
		time.Unix(ch.Payload.ExpiresAt, 0).UTC().Format(time.RFC3339))
	for _, b := range ch.Payload.Bundles {
		art, err := repo.ClientTarget(b.Artifact.Target)
		if err != nil {
			t.Fatalf("%s: %v", b.Artifact.Target, err)
		}
		if art.Length != b.Artifact.Size || art.SHA256() != b.Artifact.SHA256 {
			t.Fatalf("%s: TUF says %d bytes %s, the bundle %d bytes %s", b.Artifact.Target, art.Length, art.SHA256(),
				b.Artifact.Size, b.Artifact.SHA256)
		}
		if err := d.Download(ctx, art); err != nil {
			t.Fatalf("%s: %v", b.Artifact.Target, err)
		}
		t.Logf("verified %s %s linux-%s adapter %d-%d (%d bytes)", b.Provider, b.Version, b.Arch, b.Adapter.Min,
			b.Adapter.Max, art.Length)
	}
}
