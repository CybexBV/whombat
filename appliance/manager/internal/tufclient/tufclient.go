// Package tufclient is the manager side of TUF: refresh from the remote repository with the
// manager's own cache and trusted time floor, publish the verified metadata files to a local mirror
// the update helper re-verifies from, and download artifacts into content-addressed staging.
package tufclient

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/atomicfile"
	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/theupdateframework/go-tuf/v2/metadata/fetcher"
)

// Client refreshes TUF metadata.
type Client struct {
	PinnedRootPath string
	CacheDir       string // manager's trusted cache
	MirrorDir      string // published for the helper
	MetadataURL    string
	Fetcher        fetcher.Fetcher
	Now            func() time.Time
	// Floor returns the trusted time floor (max signed time seen); reference time = max(now, floor).
	Floor func() time.Time
	// Production refuses development TUF roots (L-4).
	Production bool
	// ResolveClients also resolves the client channel of the delegated clients role (CT-74, MG-33).
	ResolveClients bool
	// Channel returns the box's update channel (LNK-21, the helper's: proto.OpChannel); nil or "": the top-level
	// targets, as before channels. With a channel the view is that channel's role, and both channel roles are
	// verified and mirrored, so the helper finds its own after a channel change without waiting for a refresh.
	Channel func() string

	mu      sync.Mutex
	latest  *trust.Repo
	lastErr error
	lastOK  time.Time
}

// NewHTTPFetcher returns a go-tuf fetcher with bounded timeouts.
func NewHTTPFetcher(userAgent string) fetcher.Fetcher {
	f := fetcher.NewDefaultFetcher()
	f.SetHTTPUserAgent(userAgent)
	f.SetHTTPClient(&http.Client{Timeout: 60 * time.Second})
	f.SetRetry(2*time.Second, 2)
	return f
}

type teeFetcher struct {
	inner fetcher.Fetcher
	base  string
	mu    sync.Mutex
	got   map[string][]byte
}

// metaName matches the metadata files the mirror carries: the top-level roles and the delegated channel roles
// (LNK-23); the clients role is the manager's alone.
var metaName = regexp.MustCompile(`^([0-9]+\.)?(root|timestamp|snapshot|targets|production|development)\.json$`)

func (t *teeFetcher) DownloadFile(url string, maxLength int64, timeout time.Duration) ([]byte, error) {
	b, err := t.inner.DownloadFile(url, maxLength, timeout)
	if err == nil {
		name := strings.TrimPrefix(url, strings.TrimSuffix(t.base, "/")+"/")
		if metaName.MatchString(name) {
			t.mu.Lock()
			t.got[name] = b
			t.mu.Unlock()
		}
	}
	return b, err
}

// ReferenceTime returns max(now, floor).
func (c *Client) ReferenceTime() time.Time {
	now := time.Now()
	if c.Now != nil {
		now = c.Now()
	}
	if c.Floor != nil {
		if f := c.Floor(); f.After(now) {
			return f
		}
	}
	return now
}

// Refresh runs a TUF refresh. On success the verified files are published to the mirror; on
// failure the previous verified view stays available through Latest (the installation keeps
// running; only new activations need fresh metadata).
func (c *Client) Refresh(ctx context.Context) (*trust.Repo, error) {
	var channel string
	if c.Channel != nil {
		channel = c.Channel()
	}
	return c.refresh(channel)
}

// RefreshIn is Refresh with the view of channel instead of the box's ("" the top-level targets): the first start looks
// for the release the box was installed with in the other channel when its own doesn't list it. Latest is then that
// view.
func (c *Client) RefreshIn(ctx context.Context, channel string) (*trust.Repo, error) {
	return c.refresh(channel)
}

func (c *Client) refresh(channel string) (*trust.Repo, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	pinned, err := os.ReadFile(c.PinnedRootPath)
	if err != nil {
		return nil, fmt.Errorf("pinned root: %w", err)
	}
	tee := &teeFetcher{inner: c.Fetcher, base: c.MetadataURL, got: map[string][]byte{}}
	var also []string
	if channel != "" {
		also = trust.Channels
	}
	repo, err := trust.Refresh(trust.Config{PinnedRoot: pinned, MetadataDir: c.CacheDir, MetadataURL: c.MetadataURL,
		Fetcher: tee, Now: c.ReferenceTime(), Production: c.Production, ResolveClients: c.ResolveClients,
		Channel: channel, LoadChannels: also})
	if err != nil {
		c.lastErr = err
		return nil, err
	}
	if err := c.publish(repo, tee.got); err != nil {
		c.lastErr = err
		return nil, fmt.Errorf("publish mirror: %w", err)
	}
	c.latest, c.lastErr, c.lastOK = repo, nil, time.Now()
	return repo, nil
}

// publish writes the complete, consistent metadata set of this successful refresh into the mirror the
// helper verifies from: every root version fetched during rotation, the trusted root, and the trusted
// snapshot and targets under their version names — taken from the verified cache, not only from what
// this refresh downloaded. go-tuf reuses a cached snapshot/targets it already trusts, so after a refused
// refresh (e.g. forged targets) a later successful one may download only timestamp.json and targets; the
// old mirror then lacked N.snapshot.json and the helper failed with metadata_stale forever. Every
// successful refresh (the engine refreshes on metadata_stale) therefore rebuilds the whole set.
// timestamp.json is written last so a reader never sees a timestamp without its snapshot.
func (c *Client) publish(repo *trust.Repo, fetched map[string][]byte) error {
	if err := os.MkdirAll(c.MirrorDir, 0o755); err != nil {
		return err
	}
	files := map[string][]byte{}
	for n, b := range fetched {
		if m := metaName.FindStringSubmatch(n); m != nil && m[2] == "root" && m[1] != "" {
			files[n] = b // intermediate roots of a rotation chain
		}
	}
	cached := func(role string, version int64) error {
		b, err := os.ReadFile(filepath.Join(c.CacheDir, role+".json"))
		if err != nil {
			return fmt.Errorf("trusted %s: %w", role, err)
		}
		var probe struct {
			Signed struct {
				Version int64 `json:"version"`
			} `json:"signed"`
		}
		if err := json.Unmarshal(b, &probe); err != nil || probe.Signed.Version != version {
			return fmt.Errorf("trusted %s is not version %d", role, version)
		}
		name := fmt.Sprintf("%d.%s.json", version, role)
		if role == "timestamp" {
			name = "timestamp.json"
		}
		files[name] = b
		return nil
	}
	roles := []struct {
		role string
		v    int64
	}{{"root", repo.RootVersion}, {"snapshot", repo.SnapshotVersion}, {"targets", repo.TargetsVersion}}
	// The verified channel roles (LNK-23): the helper resolves its channel through the same delegation.
	for _, ch := range trust.Channels {
		if v, ok := repo.RoleVersions[ch]; ok {
			roles = append(roles, struct {
				role string
				v    int64
			}{ch, v})
		}
	}
	roles = append(roles, struct {
		role string
		v    int64
	}{"timestamp", repo.TimestampVersion})
	for _, r := range roles {
		if err := cached(r.role, r.v); err != nil {
			return err
		}
	}
	names := make([]string, 0, len(files))
	for n := range files {
		if n != "timestamp.json" {
			names = append(names, n)
		}
	}
	sort.Strings(names)
	names = append(names, "timestamp.json")
	for _, n := range names {
		if err := atomicfile.WriteFile(filepath.Join(c.MirrorDir, n), files[n], 0o644); err != nil {
			return err
		}
	}
	c.gcMirror()
	return nil
}

// gcMirror keeps every root version (the helper may need the whole rotation chain) and the newest
// few snapshot/targets versions.
func (c *Client) gcMirror() {
	entries, err := os.ReadDir(c.MirrorDir)
	if err != nil {
		return
	}
	versions := map[string][]int{}
	for _, e := range entries {
		m := metaName.FindStringSubmatch(e.Name())
		if m == nil || m[1] == "" || m[2] == "root" {
			continue
		}
		v, _ := strconv.Atoi(strings.TrimSuffix(m[1], "."))
		versions[m[2]] = append(versions[m[2]], v)
	}
	for role, vs := range versions {
		sort.Ints(vs)
		for i := 0; i+4 < len(vs); i++ {
			_ = os.Remove(filepath.Join(c.MirrorDir, fmt.Sprintf("%d.%s.json", vs[i], role)))
		}
	}
}

// Latest returns the last successfully verified view (nil if none since start).
func (c *Client) Latest() *trust.Repo {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.latest
}

// Status reports the last refresh outcome.
func (c *Client) Status() (lastOK time.Time, lastErr error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.lastOK, c.lastErr
}

// IsExpired reports whether err is a freshness failure.
func IsExpired(err error) bool { return errors.Is(err, trust.ErrExpired) }
