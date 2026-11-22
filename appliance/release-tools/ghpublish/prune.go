package ghpublish

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
)

// Old releases leave in two steps. Unlist takes them out of a channel role and pushes the role, so boxes stop seeing
// them; Prune then deletes from GitHub what no listed release needs any more: each unlisted release's own GitHub
// release with its tag, and the blobs no listed release's index names. Prune runs only once the Pages site serves the
// roles the clone has, so no box is ever shown metadata that names a deleted file, and it holds the publish lock, so a
// release whose blobs are on their way up (not listed yet) never loses them.

// Unlist takes every release a channel lists out of its role except keep (devtuf.Unlist), signs the role with key (nil:
// the repository's own, as a promotion signs) and pushes it. Nothing is uploaded or deleted. Run again after a stop, it
// pushes what it signed.
func (p *Publisher) Unlist(ctx context.Context, channel string, keep []string, key ed25519.PrivateKey) (*Result, *devtuf.UnlistResult, error) {
	if !trust.ValidChannel(channel) {
		return nil, nil, fmt.Errorf("ghpublish: unknown channel %q", channel)
	}
	var ur *devtuf.UnlistResult
	res, err := p.publish(ctx, channel, "", "unlist", "unlist "+channel, func(r *devtuf.Repo) error {
		u, err := r.Unlist(channel, keep)
		if err != nil {
			return err
		}
		ur = u
		if len(u.Targets) == 0 {
			return nil
		}
		if err := r.PublishChannelWith(channel, key); err != nil {
			return err
		}
		u.Version = r.RoleVersions()[channel]
		return nil
	})
	return res, ur, err
}

// PruneOptions configure Prune.
type PruneOptions struct {
	// MetadataURL is the Pages site boxes read (https://releases.whombat.com/): Prune deletes nothing until it serves
	// channel roles at least as new as the clone's.
	MetadataURL string
	// DryRun plans and checks, and deletes nothing.
	DryRun bool
}

// PrunePlan is what Prune deletes (or, in a dry run, would delete).
type PrunePlan struct {
	// Listed is what each channel lists, oldest first: every file these need stays.
	Listed map[string][]string `json:"listed"`
	// KeptFiles is the number of files the listed releases and the clients role name on GitHub.
	KeptFiles int `json:"keptFiles"`
	// Releases are the GitHub releases (and their tags) of releases no channel lists, with their assets.
	Releases      []PruneRelease `json:"releases"`
	ReleaseAssets int            `json:"releaseAssets"`
	ReleaseBytes  int64          `json:"releaseBytes"`
	// Blobs are the bucket assets no listed release needs.
	Blobs     []string `json:"blobs"`
	BlobBytes int64    `json:"blobBytes"`
	// LeftAlone are GitHub releases that are neither a release's own nor a blob bucket (clients, anything else).
	LeftAlone []string `json:"leftAlone"`
	// Published is the role versions the Pages site serves (dry run of a planned unlist: not read).
	Published map[string]int64 `json:"published,omitempty"`
	Deleted   bool             `json:"deleted"`

	releaseIDs map[string]int64
	blobIDs    map[string]int64
	kept       []devtuf.ReleaseFile
}

// PruneRelease is a GitHub release Prune deletes.
type PruneRelease struct {
	Tag    string `json:"tag"`
	Assets int    `json:"assets"`
	Bytes  int64  `json:"bytes"`
}

// PlanPrune plans a prune against r as loaded (possibly with unlists applied in memory and not signed: a dry run of
// gh-unlist), reading what GitHub has. It deletes nothing and takes no lock.
func (p *Publisher) PlanPrune(ctx context.Context, r *devtuf.Repo) (*PrunePlan, error) {
	plan := &PrunePlan{Listed: map[string][]string{}, Releases: []PruneRelease{}, Blobs: []string{}, LeftAlone: []string{},
		releaseIDs: map[string]int64{}, blobIDs: map[string]int64{}}
	listed := map[string]bool{}
	for _, channel := range trust.Channels {
		if !r.HasChannel(channel) {
			continue
		}
		rels, err := r.ChannelReleases(channel)
		if err != nil {
			return nil, err
		}
		// A channel listing nothing would make every release and blob look unneeded: never prune from that.
		if len(rels) == 0 {
			return nil, fmt.Errorf("ghpublish: the %s role lists no release; refusing to prune", channel)
		}
		ids := []string{}
		for _, s := range rels {
			ids = append(ids, s.ID)
			listed[s.ID] = true
		}
		sort.SliceStable(ids, func(i, j int) bool { return devtuf.CompareChannelIDs(ids[i], ids[j]) < 0 })
		plan.Listed[channel] = ids
	}
	if len(plan.Listed) == 0 {
		return nil, errors.New("ghpublish: the repository has no channel roles; refusing to prune")
	}
	files, err := r.ListedFiles()
	if err != nil {
		return nil, err
	}
	plan.kept, plan.KeptFiles = files, len(files)
	keep := map[string]bool{}
	for _, f := range files {
		keep[f.Tag+"/"+f.Name] = true
	}
	rels, err := p.listReleases(ctx)
	if err != nil {
		return nil, err
	}
	for _, rel := range rels {
		switch {
		case strings.HasPrefix(rel.TagName, "nar-"):
			assets, err := p.assets(ctx, rel.ID)
			if err != nil {
				return nil, err
			}
			for _, a := range assets {
				if k := rel.TagName + "/" + a.Name; !keep[k] {
					plan.Blobs = append(plan.Blobs, k)
					plan.BlobBytes += a.Size
					plan.blobIDs[k] = a.ID
				}
			}
		case devtuf.IsReleaseTag(rel.TagName) && !listed[rel.TagName]:
			assets, err := p.assets(ctx, rel.ID)
			if err != nil {
				return nil, err
			}
			pr := PruneRelease{Tag: rel.TagName, Assets: len(assets)}
			for _, a := range assets {
				pr.Bytes += a.Size
			}
			plan.Releases = append(plan.Releases, pr)
			plan.ReleaseAssets += pr.Assets
			plan.ReleaseBytes += pr.Bytes
			plan.releaseIDs[rel.TagName] = rel.ID
		case devtuf.IsReleaseTag(rel.TagName):
			// Listed: everything in it stays.
		default:
			plan.LeftAlone = append(plan.LeftAlone, rel.TagName)
		}
	}
	sort.Slice(plan.Releases, func(i, j int) bool {
		return devtuf.CompareChannelIDs(plan.Releases[i].Tag, plan.Releases[j].Tag) < 0
	})
	sort.Strings(plan.Blobs)
	sort.Strings(plan.LeftAlone)
	return plan, nil
}

// Prune deletes from GitHub what no listed release needs (PlanPrune), after these checks, each of which stops it
// before anything is deleted: no other publish is running (it holds the publish lock), none is unfinished, the clone
// has every commit of the remote and nothing unpushed, the Pages site serves channel roles at least as new as the
// clone's, and GitHub has every file the listed releases need, whole. Deleted are the unlisted releases' own GitHub
// releases and tags, and the bucket blobs no listed release names; the buckets themselves stay.
func (p *Publisher) Prune(ctx context.Context, o PruneOptions) (*PrunePlan, error) {
	if o.MetadataURL == "" {
		return nil, errors.New("ghpublish: prune needs the Pages site's address (where boxes read the metadata)")
	}
	unlock, err := p.lock(10 * time.Minute)
	if err != nil {
		return nil, err
	}
	defer unlock()
	if _, err := p.git(ctx, "fetch", "-q", p.cfg.Remote, p.cfg.Branch); err != nil {
		return nil, err
	}
	if pend, err := p.readPending(); err != nil {
		return nil, err
	} else if pend != nil {
		return nil, fmt.Errorf("ghpublish: the publish of %s didn't finish; finish it before pruning (its files may not be listed yet)", pend.what())
	}
	if err := p.pull(ctx); err != nil {
		return nil, err
	}
	if dirty, err := p.unpushed(ctx); err != nil {
		return nil, err
	} else if len(dirty) > 0 {
		return nil, fmt.Errorf("ghpublish: the metadata folder has signed changes nobody pushed (%s); refusing to prune", strings.Join(dirty, ", "))
	}
	if ahead, err := p.ahead(ctx); err != nil {
		return nil, err
	} else if ahead {
		return nil, errors.New("ghpublish: the clone has commits the remote lacks; push them (run the publish again) before pruning")
	}
	r, err := func() (*devtuf.Repo, error) {
		unlockRepo, err := devtuf.Lock(p.cfg.Dir, time.Minute)
		if err != nil {
			return nil, err
		}
		defer unlockRepo()
		return devtuf.Load(p.cfg.Dir, devtuf.Options{})
	}()
	if err != nil {
		return nil, err
	}
	if !r.GitHub() {
		return nil, errors.New("ghpublish: the repository is not of the GitHub layout")
	}
	published, err := p.publishedVersions(ctx, o.MetadataURL)
	if err != nil {
		return nil, err
	}
	local := r.RoleVersions()
	for _, channel := range trust.Channels {
		if !r.HasChannel(channel) {
			continue
		}
		if published[channel] < local[channel] {
			return nil, fmt.Errorf("ghpublish: %s serves the %s role version %d, the clone has %d: wait until the site serves it (the workflow signs and deploys after each push)", o.MetadataURL, channel, published[channel], local[channel])
		}
	}
	plan, err := p.PlanPrune(ctx, r)
	if err != nil {
		return nil, err
	}
	plan.Published = published
	if err := p.Verify(ctx, plan.kept); err != nil {
		return plan, fmt.Errorf("%w; refusing to prune", err)
	}
	if o.DryRun {
		return plan, nil
	}
	p.cfg.Log("deleting %d blob(s) (%d bytes) and %d release(s) (%d assets, %d bytes)", len(plan.Blobs), plan.BlobBytes,
		len(plan.Releases), plan.ReleaseAssets, plan.ReleaseBytes)
	for _, k := range plan.Blobs {
		if err := p.deleteAsset(ctx, plan.blobIDs[k]); err != nil {
			return plan, fmt.Errorf("deleting %s: %w", k, err)
		}
	}
	for _, rel := range plan.Releases {
		if err := p.deleteRelease(ctx, plan.releaseIDs[rel.Tag], rel.Tag); err != nil {
			return plan, fmt.Errorf("deleting %s: %w", rel.Tag, err)
		}
	}
	plan.Deleted = true
	return plan, nil
}

// listReleases lists every release of the repository.
func (p *Publisher) listReleases(ctx context.Context) ([]ghRelease, error) {
	var all []ghRelease
	for page := 1; ; page++ {
		var batch []ghRelease
		if _, err := p.api(ctx, http.MethodGet, p.repoURL(fmt.Sprintf("releases?per_page=100&page=%d", page)), nil, "", 0, &batch); err != nil {
			return nil, err
		}
		all = append(all, batch...)
		if len(batch) < 100 {
			return all, nil
		}
	}
}

// deleteRelease deletes a release and then its tag: GitHub keeps a release's tag when the release goes.
func (p *Publisher) deleteRelease(ctx context.Context, id int64, tag string) error {
	if _, err := p.api(ctx, http.MethodDelete, p.repoURL(fmt.Sprintf("releases/%d", id)), nil, "", 0, nil); err != nil {
		return err
	}
	code, err := p.api(ctx, http.MethodDelete, p.repoURL("git/refs/tags/"+url.PathEscape(tag)), nil, "", 0, nil)
	if code == http.StatusUnprocessableEntity {
		return nil // no such tag (deleted before)
	}
	return err
}

// publishedVersions reads the role versions the Pages site serves: the timestamp names the snapshot, the snapshot the
// roles. Signatures aren't checked here: this only decides when deleting is safe, and a box checks them itself.
func (p *Publisher) publishedVersions(ctx context.Context, base string) (map[string]int64, error) {
	base = strings.TrimSuffix(base, "/") + "/"
	var ts struct {
		Signed struct {
			Meta map[string]struct {
				Version int64 `json:"version"`
			} `json:"meta"`
		} `json:"signed"`
	}
	if err := p.getJSON(ctx, base+"timestamp.json", &ts); err != nil {
		return nil, err
	}
	sv := ts.Signed.Meta["snapshot.json"].Version
	if sv <= 0 {
		return nil, fmt.Errorf("ghpublish: %stimestamp.json names no snapshot", base)
	}
	var snap struct {
		Signed struct {
			Meta map[string]struct {
				Version int64 `json:"version"`
			} `json:"meta"`
		} `json:"signed"`
	}
	if err := p.getJSON(ctx, fmt.Sprintf("%s%d.snapshot.json", base, sv), &snap); err != nil {
		return nil, err
	}
	out := map[string]int64{}
	for name, m := range snap.Signed.Meta {
		out[strings.TrimSuffix(name, ".json")] = m.Version
	}
	return out, nil
}

func (p *Publisher) getJSON(ctx context.Context, u string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	// The site's cache must not hide a role the workflow just deployed.
	req.Header.Set("Cache-Control", "no-cache")
	resp, err := p.cfg.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("ghpublish: %s: HTTP %d", u, resp.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 16<<20)).Decode(out)
}

// LocalRepo brings the clone up to date with the remote and loads its repository for a plan (gh-unlist's dry run):
// nothing is signed or changed on disk but the pull.
func (p *Publisher) LocalRepo(ctx context.Context) (*devtuf.Repo, error) {
	if _, err := os.Stat(filepath.Join(p.cfg.Dir, ".git")); err != nil {
		return nil, fmt.Errorf("ghpublish: %s is not a clone of the releases repository", p.cfg.Dir)
	}
	unlock, err := p.lock(10 * time.Minute)
	if err != nil {
		return nil, err
	}
	defer unlock()
	if pend, err := p.readPending(); err != nil {
		return nil, err
	} else if pend == nil {
		if err := p.pull(ctx); err != nil {
			return nil, err
		}
	}
	unlockRepo, err := devtuf.Lock(p.cfg.Dir, time.Minute)
	if err != nil {
		return nil, err
	}
	defer unlockRepo()
	return devtuf.Load(p.cfg.Dir, devtuf.Options{})
}
