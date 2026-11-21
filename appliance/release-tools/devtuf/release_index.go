package devtuf

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"syscall"

	"github.com/CybexBV/whombat/appliance/helper/pkg/canonjson"
	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/release-tools/nixexport"
	"github.com/CybexBV/whombat/contracts/go/release"
)

// Closure indexes in release directories (UP-X14): ExportRelease writes a listing per component and links the blobs
// from the NAR cache; PublishRelease checks the listings, verifies the blobs it doesn't have and signs the indexes.

// releaseBlobDir is the blobs' directory in a release directory.
const releaseBlobDir = "nar"

// indexComponent is one component exported as an index.
type indexComponent struct {
	file, target string
	meta         trust.IndexMeta
	narHash      *string
	paths        []PathInfo
	listing      *trust.ClosureIndex
}

func exportIndexes(ctx context.Context, out string, t *release.ReleaseTuple, m *ReleaseManifest, o ExportOptions,
	fill func(field *string, got, what string) error) error {
	logf := o.Log
	if logf == nil {
		logf = func(string, ...any) {}
	}
	var comps []*indexComponent
	if !o.ReuseHost {
		comps = append(comps, &indexComponent{file: "host.paths.json", target: HostIndexTarget(t.Host.Version), narHash: &t.Host.NarHash,
			meta: trust.IndexMeta{Of: trust.KindHostGeneration, Version: t.Host.Version, StorePath: t.Host.StorePath, ManagerStorePath: t.Manager.StorePath}})
	}
	comps = append(comps, &indexComponent{file: "runtime.paths.json", target: RuntimeIndexTarget(t.Runtime.Version), narHash: &t.Runtime.NarHash,
		meta: trust.IndexMeta{Of: trust.KindRuntimeBundle, Version: t.Runtime.Version, StorePath: t.Runtime.StorePath}})
	for i := range t.Providers {
		p := &t.Providers[i]
		comps = append(comps, &indexComponent{file: "provider-" + p.Provider + ".paths.json", target: ProviderIndexTarget(p.Provider, p.Version),
			narHash: &p.NarHash, meta: trust.IndexMeta{Of: trust.KindProviderBundle, Version: p.Version, StorePath: p.StorePath, Provider: p.Provider}})
	}
	var all []PathInfo
	for _, c := range comps {
		infos, err := o.Paths.Closure(ctx, c.meta.StorePath)
		if err != nil {
			return err
		}
		byPath := map[string]PathInfo{}
		refs := map[string][]string{}
		for _, p := range infos {
			if !trust.ValidNarHash(p.NarHash) {
				return fmt.Errorf("%s: bad narHash %q", p.StorePath, p.NarHash)
			}
			byPath[p.StorePath] = p
			refs[p.StorePath] = p.References
		}
		root, ok := byPath[c.meta.StorePath]
		if !ok {
			return fmt.Errorf("the closure of %s does not contain it", c.meta.StorePath)
		}
		if err := fill(c.narHash, root.NarHash, c.meta.StorePath+" narHash"); err != nil {
			return err
		}
		c.meta.NarHash = root.NarHash
		if c.meta.Of == trust.KindHostGeneration {
			mgr, ok := byPath[t.Manager.StorePath]
			if !ok {
				return fmt.Errorf("the host closure does not contain the manager %s", t.Manager.StorePath)
			}
			if err := fill(&t.Manager.NarHash, mgr.NarHash, "manager narHash"); err != nil {
				return err
			}
		}
		order, err := nixexport.TopoOrder(refs)
		if err != nil {
			return fmt.Errorf("the closure of %s: %w", c.meta.StorePath, err)
		}
		c.listing = &trust.ClosureIndex{V: 1, Of: c.meta.Of, StorePath: c.meta.StorePath, NarHash: c.meta.NarHash, Compression: trust.CompressionZstd}
		for _, sp := range order {
			p := byPath[sp]
			r := append([]string{}, p.References...)
			sort.Strings(r)
			c.listing.Paths = append(c.listing.Paths, trust.IndexPath{StorePath: sp, NarHash: p.NarHash, NarSize: p.NarSize, References: r, Deriver: p.Deriver})
			c.paths = append(c.paths, p)
		}
		size, err := trust.CheckClosure(c.listing.Paths, c.meta.StorePath, c.meta.NarHash, false)
		if err != nil {
			return fmt.Errorf("the closure of %s: %w", c.meta.StorePath, err)
		}
		c.meta.Kind, c.meta.ClosureSize, c.meta.Paths = trust.KindClosureIndex, size, len(c.listing.Paths)
		all = append(all, c.paths...)
	}
	logf("closure indexes: %d components, %d paths; filling the NAR cache %s", len(comps), len(all), o.NarCache)
	st, err := FillNarCache(ctx, o.NarCache, all, o.Paths, o.Workers)
	if err != nil {
		return err
	}
	logf("NAR cache: %d blobs, %d cached, %d compressed now (%d NAR bytes -> %d bytes)", st.Paths, st.Cached, st.Compressed, st.NarBytes, st.FileBytes)
	blobDir := filepath.Join(out, releaseBlobDir)
	if err := os.MkdirAll(blobDir, 0o755); err != nil {
		return err
	}
	linked := map[string]int64{}
	for _, c := range comps {
		var download int64
		for _, p := range c.paths {
			size, ok := linked[p.NarHash]
			if !ok {
				src := NarCacheFile(o.NarCache, p.NarHash)
				dst := filepath.Join(blobDir, filepath.Base(src))
				if err := linkOrCopy(src, dst); err != nil {
					return err
				}
				fi, err := os.Stat(dst)
				if err != nil {
					return err
				}
				size = fi.Size()
				linked[p.NarHash] = size
			}
			download += size
		}
		c.meta.DownloadSize = download
		b, err := json.Marshal(c.listing)
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(out, c.file), append(b, '\n'), 0o644); err != nil {
			return err
		}
		if err := c.meta.Validate(); err != nil {
			return fmt.Errorf("%s: %w", c.target, err)
		}
		m.Indexes = append(m.Indexes, ReleaseIndex{Target: c.target, File: c.file, Meta: c.meta})
		logf("%s: %d paths, closure %d bytes, %d bytes compressed", c.target, c.meta.Paths, c.meta.ClosureSize, c.meta.DownloadSize)
	}
	return nil
}

// preparedIndex is an index ready to be signed: its content with every path's blob.
type preparedIndex struct {
	ix ReleaseIndex
	ci *trust.ClosureIndex
}

// readListing reads a release directory's listing (bounded, no symlink, regular file).
func readListing(dir, file string) ([]byte, error) {
	f, err := os.OpenFile(filepath.Join(dir, file), os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() {
		return nil, fmt.Errorf("%s is not a regular file", file)
	}
	b, err := io.ReadAll(io.LimitReader(f, trust.MaxIndexBytes+1))
	if err != nil {
		return nil, err
	}
	if len(b) > trust.MaxIndexBytes {
		return nil, fmt.Errorf("%s is larger than %d bytes", file, trust.MaxIndexBytes)
	}
	return b, nil
}

// prepareIndexes checks every listing of the release directory (strict JSON, structure, root, closure size, the
// manager in the host closure), reuses the repository's blob of each NAR hash and verifies and writes the others from
// the release directory's nar/ (by decompressing them, in parallel), and returns the index contents. Different bytes
// under a published index target are refused here, before anything is signed.
func (r *Repo) prepareIndexes(dir string, m *ReleaseManifest, res *PublishResult) ([]preparedIndex, error) {
	if len(m.Indexes) == 0 {
		return nil, nil
	}
	blobs, err := r.Blobs()
	if err != nil {
		return nil, err
	}
	var out []preparedIndex
	need := map[string]trust.IndexPath{} // narhex -> a path with it (not in the repository)
	reused := map[string]bool{}
	for _, ix := range m.Indexes {
		b, err := readListing(dir, ix.File)
		if err != nil {
			return nil, err
		}
		ci, err := trust.DecodeClosureIndex(b)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", ix.File, err)
		}
		if ci.Compression != trust.CompressionZstd {
			return nil, fmt.Errorf("%s: compression %q", ix.File, ci.Compression)
		}
		if ci.Of != ix.Meta.Of || ci.StorePath != ix.Meta.StorePath || ci.NarHash != ix.Meta.NarHash {
			return nil, fmt.Errorf("%s: the listing is of %s %s, the metadata of %s %s", ix.File, ci.Of, ci.StorePath, ix.Meta.Of, ix.Meta.StorePath)
		}
		size, err := trust.CheckClosure(ci.Paths, ci.StorePath, ci.NarHash, false)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", ix.File, err)
		}
		if size != ix.Meta.ClosureSize {
			return nil, fmt.Errorf("%s: closure size is %d, the metadata says %d", ix.File, size, ix.Meta.ClosureSize)
		}
		if ix.Meta.Of == trust.KindHostGeneration && !ci.Contains(m.Tuple.Manager.StorePath) {
			return nil, fmt.Errorf("%s: the host closure does not contain the manager %s", ix.File, m.Tuple.Manager.StorePath)
		}
		for _, p := range ci.Paths {
			narHex := strings.TrimPrefix(p.NarHash, "sha256:")
			if _, ok := blobs[narHex]; ok {
				reused[narHex] = true
			} else if _, ok := need[narHex]; !ok {
				need[narHex] = p
			}
		}
		out = append(out, preparedIndex{ix: ix, ci: ci})
	}
	// Verify and write the new blobs.
	var jobs []trust.IndexPath
	for _, p := range need {
		jobs = append(jobs, p)
	}
	sort.Slice(jobs, func(i, j int) bool { return jobs[i].StorePath < jobs[j].StorePath })
	for _, p := range jobs {
		src := filepath.Join(dir, releaseBlobDir, strings.TrimPrefix(p.NarHash, "sha256:")+".nar.zst")
		if _, err := os.Lstat(src); err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return nil, fmt.Errorf("the blob of %s (%s) is neither in the release directory nor in the repository", p.StorePath, p.NarHash)
			}
			return nil, err
		}
	}
	var mu sync.Mutex
	var firstErr error
	work := make(chan trust.IndexPath)
	var wg sync.WaitGroup
	for w := 0; w < min(runtime.NumCPU(), 8, max(len(jobs), 1)); w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for p := range work {
				src := filepath.Join(dir, releaseBlobDir, strings.TrimPrefix(p.NarHash, "sha256:")+".nar.zst")
				fileHex, size, err := checkBlobFile(src, p)
				if err == nil {
					err = r.addBlob(src, fileHex, p)
				}
				mu.Lock()
				if err != nil {
					firstErr = cmp(firstErr, err)
				} else {
					blobs[strings.TrimPrefix(p.NarHash, "sha256:")] = Blob{FileHex: fileHex, Size: size}
					res.BlobsAdded++
					res.BytesAdded += size
				}
				mu.Unlock()
			}
		}()
	}
	for _, p := range jobs {
		mu.Lock()
		failed := firstErr != nil
		mu.Unlock()
		if failed {
			break
		}
		work <- p
	}
	close(work)
	wg.Wait()
	if firstErr != nil {
		return nil, firstErr
	}
	res.BlobsReused = len(reused)
	// Each path's blob; different bytes under a published index target are refused.
	for _, p := range out {
		for i := range p.ci.Paths {
			ip := &p.ci.Paths[i]
			b := blobs[strings.TrimPrefix(ip.NarHash, "sha256:")]
			ip.FileSize, ip.FileHash = b.Size, "sha256:"+b.FileHex
		}
		if _, err := trust.CheckClosure(p.ci.Paths, p.ci.StorePath, p.ci.NarHash, true); err != nil {
			return nil, fmt.Errorf("%s: %w", p.ix.Target, err)
		}
		p.ci.V = r.indexVersion()
		content, err := canonjson.Marshal(p.ci)
		if err != nil {
			return nil, err
		}
		sum := sha256.Sum256(content)
		if old, ok := r.destTargets()[r.destPath(p.ix.Target)]; ok && !bytes.Equal(old.Hashes["sha256"], sum[:]) {
			return nil, fmt.Errorf("%s is published with different bytes; use a new version", p.ix.Target)
		}
	}
	return out, nil
}
