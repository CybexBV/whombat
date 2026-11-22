package devtuf

import (
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
)

// UnlistResult says what Unlist took out of a channel role.
type UnlistResult struct {
	Channel string `json:"channel"`
	// Kept are the channel's releases that stay listed, Unlisted those taken out (both oldest first).
	Kept     []string `json:"kept"`
	Unlisted []string `json:"unlisted"`
	// Targets are the role's targets taken out: each unlisted tuple and every index no kept release resolves to.
	Targets []string `json:"targets"`
	// Version is the role version signed with the change (0: nothing changed, or not signed yet).
	Version int64 `json:"version,omitempty"`
}

// ErrUnlistNewest: an unlist would take out the newest release a channel lists. The newest is what every box of the
// channel moves to, and a box that already runs it rolls back only to a release some channel lists; withdrawing it is
// a different act (publish a fix instead).
var ErrUnlistNewest = errors.New("the channel's newest release must stay listed")

// Unlist takes every release a channel lists out of its role, except keep (ids the channel doesn't list are ignored):
// the release tuple and the indexes that only unlisted releases resolve to; an index a kept release resolves to stays.
// It changes the loaded role only; sign it with PublishChannelWith (nothing to sign when Targets is empty). The
// channel's newest release must be kept, so a channel is never left empty.
func (r *Repo) Unlist(channel string, keep []string) (*UnlistResult, error) {
	md, ok := r.channels[channel]
	if !ok {
		return nil, fmt.Errorf("devtuf: no %s role", channel)
	}
	listed, err := r.ChannelReleases(channel)
	if err != nil {
		return nil, err
	}
	res := &UnlistResult{Channel: channel, Kept: []string{}, Unlisted: []string{}, Targets: []string{}}
	if len(listed) == 0 {
		return res, nil
	}
	ids := make([]string, 0, len(listed))
	for _, s := range listed {
		ids = append(ids, s.ID)
	}
	sort.SliceStable(ids, func(i, j int) bool { return CompareChannelIDs(ids[i], ids[j]) < 0 })
	newest := ids[len(ids)-1]
	if !containsString(keep, newest) {
		return nil, fmt.Errorf("%w: %s lists %s as its newest, and the releases to keep don't name it", ErrUnlistNewest, channel, newest)
	}
	needed := map[string]bool{}
	for _, id := range ids {
		if !containsString(keep, id) {
			res.Unlisted = append(res.Unlisted, id)
			continue
		}
		res.Kept = append(res.Kept, id)
		targets, err := r.releaseTargets(channel, id)
		if err != nil {
			return nil, err
		}
		for _, t := range targets {
			needed[t] = true
		}
	}
	if len(res.Unlisted) == 0 {
		return res, nil
	}
	gone := map[string]bool{}
	for _, id := range res.Unlisted {
		targets, err := r.releaseTargets(channel, id)
		if err != nil {
			return nil, err
		}
		for _, t := range targets {
			if !needed[t] {
				gone[t] = true
			}
		}
	}
	for t := range gone {
		delete(md.Signed.Targets, t)
		res.Targets = append(res.Targets, t)
	}
	sort.Strings(res.Targets)
	return res, nil
}

// ListedFiles lists every file the repository's metadata names on GitHub, each once: what each release every channel
// lists needs (its tuple and indexes in its own release, the blobs in their buckets) and the clients role's targets.
func (r *Repo) ListedFiles() ([]ReleaseFile, error) {
	var out []ReleaseFile
	seen := map[string]bool{}
	add := func(files []ReleaseFile) {
		for _, f := range files {
			if k := f.Tag + "/" + f.Name; !seen[k] {
				seen[k] = true
				out = append(out, f)
			}
		}
	}
	for _, channel := range []string{trust.ChannelDevelopment, trust.ChannelProduction} {
		if !r.HasChannel(channel) {
			continue
		}
		releases, err := r.ChannelReleases(channel)
		if err != nil {
			return nil, err
		}
		for _, rel := range releases {
			files, err := r.ReleaseFiles(channel, rel.ID)
			if err != nil {
				return nil, fmt.Errorf("devtuf: %s in %s: %w", rel.ID, channel, err)
			}
			add(files)
		}
	}
	add(r.ClientFiles())
	return out, nil
}

// IsReleaseTag reports whether a GitHub release of the repository is one release's own (its tuple and indexes): a
// whombat release id. The blob buckets (nar-xx), `clients` and anything else are not.
func IsReleaseTag(tag string) bool {
	if strings.HasPrefix(tag, "nar-") {
		return false
	}
	return ParseReleaseID(tag).Family != ""
}
