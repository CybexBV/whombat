package tufclient_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/manager/internal/tufclient"
	"github.com/CybexBV/whombat/appliance/release-tools/fakegithub"
)

func artifactOf(target, remote string, b []byte) trust.Artifact {
	sum := sha256.Sum256(b)
	return trust.Artifact{Target: target, Remote: remote, Length: int64(len(b)), Hashes: map[string]string{"sha256": hex.EncodeToString(sum[:])}}
}

// Downloads from GitHub release assets (LNK-24): the redirect is followed, an interrupted download resumes with
// Range at the storage host, and a client bundle's deep target path maps onto the clients release.
func TestDownloadFromGitHubReleases(t *testing.T) {
	gh := fakegithub.New("CybexBV", "whombat-releases", "tok", t.TempDir())
	defer gh.Close()
	ctx := context.Background()
	blob := []byte(strings.Repeat("blob bytes ", 40000))
	sum := sha256.Sum256(blob)
	fileHex := hex.EncodeToString(sum[:])
	narHash := "sha256:" + strings.Repeat("ab", 32)
	name := trust.BlobFileName(fileHex, narHash)
	gh.PutAsset(trust.BlobBucket(fileHex), name, blob)
	gh.FailNext[name] = 100000

	staging := t.TempDir()
	d := &tufclient.Downloader{StagingDir: staging, Space: tufclient.StatfsSpace{},
		Source: tufclient.HTTPSource{BaseURL: gh.DownloadBase(), Layout: tufclient.LayoutGitHub}}
	a := artifactOf(trust.BlobTarget(narHash), trust.BlobRemote(fileHex, narHash), blob)
	if err := d.Download(ctx, a); err == nil {
		t.Fatal("the interrupted download succeeded")
	}
	if st, err := os.Stat(filepath.Join(staging, a.SHA256()+".part")); err != nil || st.Size() == 0 {
		t.Fatalf("no partial file kept: %v", err)
	}
	if err := d.Download(ctx, a); err != nil {
		t.Fatal(err)
	}
	if gh.RangeRequests != 1 || gh.Downloads[name] != 2 {
		t.Fatalf("range requests %d, downloads %d", gh.RangeRequests, gh.Downloads[name])
	}
	if !d.Present(a) {
		t.Fatal("not staged")
	}

	// A client bundle: clients/<provider>/<version>/<sha>.<file> is the asset clients/<sha>.<file>.
	bundle := []byte("tarball")
	ba := artifactOf("clients/codex/0.158.0/linux-x86_64.tar.gz", "", bundle)
	gh.PutAsset("clients", ba.SHA256()+".linux-x86_64.tar.gz", bundle)
	if err := d.Download(ctx, ba); err != nil {
		t.Fatal(err)
	}
	// A missing asset is an error, not an empty file.
	if err := d.Download(ctx, artifactOf("x/y.json", "whombat-20261119.1/nope.json", []byte("x"))); err == nil {
		t.Fatal("a missing asset downloaded")
	}
}

// GitHubPath maps a deep target path onto a one-directory release asset.
func TestGitHubPath(t *testing.T) {
	for in, want := range map[string]string{
		"whombat-20261119.1/abc.whombat-runtime.index.json": "whombat-20261119.1/abc.whombat-runtime.index.json",
		"nar-ab/f.n.nar.zst":                            "nar-ab/f.n.nar.zst",
		"clients/codex/0.158.0/abc.linux-x86_64.tar.gz": "clients/abc.linux-x86_64.tar.gz",
		"clients/abc.channel.json":                      "clients/abc.channel.json",
	} {
		if got := tufclient.GitHubPath(in); got != want {
			t.Errorf("%s: %s, want %s", in, got, want)
		}
	}
}
