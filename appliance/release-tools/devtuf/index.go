package devtuf

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"

	"github.com/CybexBV/whombat/appliance/helper/pkg/canonjson"
	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/release-tools/nixexport"
	"github.com/klauspost/compress/zstd"
	"github.com/theupdateframework/go-tuf/v2/metadata"
)

// Closure indexes and blobs in a repository (UP-X14): index targets are ordinary TUF targets (kind closure-index);
// blobs live at targets/nar/<fileSha256hex>.<narSha256hex>.nar.zst, one per NAR hash, written only after the
// repository verified them by decompressing.

// HostIndexTarget, RuntimeIndexTarget and ProviderIndexTarget are the conventional index target paths.
func HostIndexTarget(version string) string {
	return fmt.Sprintf("host/%s/whombat-host.index.json", version)
}
func RuntimeIndexTarget(version string) string {
	return fmt.Sprintf("runtime/%s/whombat-runtime.index.json", version)
}
func ProviderIndexTarget(name, version string) string {
	return fmt.Sprintf("provider/%s/%s/provider.index.json", name, version)
}

// Blob is a blob file of the repository.
type Blob struct {
	FileHex string
	Size    int64
}

func (r *Repo) blobsDir() string { return filepath.Join(r.targetsDir(), trust.BlobDir) }

// Blobs maps the NAR hash (hex) of every blob in the repository to its file (the lexically first, should there be
// two).
func (r *Repo) Blobs() (map[string]Blob, error) { return ListBlobs(r.Dir) }

// ListBlobs reads <dir>/targets/nar without loading the repository (tufrepo nar-list).
func ListBlobs(dir string) (map[string]Blob, error) {
	entries, err := os.ReadDir(filepath.Join(dir, "targets", trust.BlobDir))
	if errors.Is(err, os.ErrNotExist) {
		return map[string]Blob{}, nil
	}
	if err != nil {
		return nil, err
	}
	out := map[string]Blob{}
	for _, e := range entries {
		fileHex, narHex, ok := trust.ParseBlobFileName(e.Name())
		if !ok || !e.Type().IsRegular() {
			continue
		}
		if _, dup := out[narHex]; dup {
			continue // ReadDir is sorted: keep the first
		}
		info, err := e.Info()
		if err != nil {
			return nil, err
		}
		out[narHex] = Blob{FileHex: fileHex, Size: info.Size()}
	}
	return out, nil
}

// checkBlobFile verifies a compressed NAR file by decompressing it (bounded, trust.VerifyNar) and returns its sha256
// and size.
func checkBlobFile(path string, p trust.IndexPath) (string, int64, error) {
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return "", 0, err
	}
	if !st.Mode().IsRegular() {
		return "", 0, fmt.Errorf("%s is not a regular file", path)
	}
	h := sha256.New()
	cr := &countWriter{}
	if err := trust.VerifyNar(trust.IOReader(io.TeeReader(f, io.MultiWriter(h, cr))), p.NarHash, p.NarSize); err != nil {
		return "", 0, fmt.Errorf("the blob of %s: %w", p.StorePath, err)
	}
	// The decoder may stop before the end of the file (trailing data): hash the rest too, so the hash names the file.
	if _, err := io.Copy(io.MultiWriter(h, cr), f); err != nil {
		return "", 0, err
	}
	if cr.n != st.Size() {
		return "", 0, fmt.Errorf("the blob of %s changed while it was read", p.StorePath)
	}
	return hex.EncodeToString(h.Sum(nil)), cr.n, nil
}

// addBlob copies a verified blob into targets/nar/ under its content name (tmp + rename).
func (r *Repo) addBlob(src, fileHex string, p trust.IndexPath) error {
	if err := os.MkdirAll(r.blobsDir(), 0o755); err != nil {
		return err
	}
	final := filepath.Join(r.blobsDir(), trust.BlobFileName(fileHex, p.NarHash))
	if _, err := os.Stat(final); err == nil {
		return nil
	}
	in, err := os.OpenFile(src, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp, err := os.CreateTemp(r.blobsDir(), ".incoming-*")
	if err != nil {
		return err
	}
	h := sha256.New()
	_, err = io.Copy(io.MultiWriter(tmp, h), in)
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err == nil && hex.EncodeToString(h.Sum(nil)) != fileHex {
		err = fmt.Errorf("the blob of %s changed while it was copied", p.StorePath)
	}
	if err == nil {
		err = os.Chmod(tmp.Name(), 0o644)
	}
	if err == nil {
		err = os.Rename(tmp.Name(), final)
	}
	if err != nil {
		os.Remove(tmp.Name())
	}
	return err
}

// putBlobBytes stores a blob given as bytes (fixtures), verifying it like a published one.
func (r *Repo) putBlobBytes(compressed []byte, p trust.IndexPath) (string, int64, error) {
	if b, ok := mustBlobs(r)[strings.TrimPrefix(p.NarHash, "sha256:")]; ok {
		return b.FileHex, b.Size, nil
	}
	if err := trust.VerifyNar(bytes.NewReader(compressed), p.NarHash, p.NarSize); err != nil {
		return "", 0, err
	}
	sum := sha256.Sum256(compressed)
	fileHex := hex.EncodeToString(sum[:])
	if err := os.MkdirAll(r.blobsDir(), 0o755); err != nil {
		return "", 0, err
	}
	final := filepath.Join(r.blobsDir(), trust.BlobFileName(fileHex, p.NarHash))
	tmp := final + ".tmp"
	if err := os.WriteFile(tmp, compressed, 0o644); err != nil {
		return "", 0, err
	}
	return fileHex, int64(len(compressed)), os.Rename(tmp, final)
}

// putBlobUnchecked stores a fixture blob without verifying it (CorruptNar).
func (r *Repo) putBlobUnchecked(compressed []byte, p trust.IndexPath) (string, int64, error) {
	sum := sha256.Sum256(compressed)
	fileHex := hex.EncodeToString(sum[:])
	if err := os.MkdirAll(r.blobsDir(), 0o755); err != nil {
		return "", 0, err
	}
	return fileHex, int64(len(compressed)), os.WriteFile(filepath.Join(r.blobsDir(), trust.BlobFileName(fileHex, p.NarHash)), compressed, 0o644)
}

func mustBlobs(r *Repo) map[string]Blob {
	b, err := r.Blobs()
	if err != nil {
		return map[string]Blob{}
	}
	return b
}

// putIndex writes an index (its paths carrying the blob fields) as the target with its metadata. Different bytes
// under a published index target are refused.
func (r *Repo) putIndex(target string, ci *trust.ClosureIndex, meta trust.IndexMeta) (added bool, err error) {
	if !trust.ValidTargetPath(target) {
		return false, fmt.Errorf("bad index target path %q", target)
	}
	ci.V = r.indexVersion()
	content, err := canonjson.Marshal(ci)
	if err != nil {
		return false, err
	}
	if len(content) > trust.MaxIndexBytes {
		return false, fmt.Errorf("%s: the index is %d bytes (max %d)", target, len(content), trust.MaxIndexBytes)
	}
	ci.V = r.indexVersion()
	meta.Paths = len(ci.Paths)
	meta.DownloadSize = 0
	for _, p := range ci.Paths {
		meta.DownloadSize += p.FileSize
	}
	if err := meta.Validate(); err != nil {
		return false, fmt.Errorf("%s: %w", target, err)
	}
	sum := sha256.Sum256(content)
	old, exists := r.destTargets()[r.destPath(target)]
	if exists && hex.EncodeToString(old.Hashes["sha256"]) != hex.EncodeToString(sum[:]) {
		return false, fmt.Errorf("%s is published with different bytes; use a new version", target)
	}
	if _, err := r.putTarget(target, content, meta); err != nil {
		return false, err
	}
	return !exists, nil
}

// findIndex returns the published index target of a component.
func (r *Repo) findIndex(c component) (string, bool) {
	view := r.destView()
	paths := make([]string, 0)
	for p := range view {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	for _, p := range paths {
		tf := view[p]
		if m, ok := indexMetaOf(tf); ok && c.matchesIndex(m) {
			return p, true
		}
	}
	return "", false
}

func indexMetaOf(tf *metadata.TargetFiles) (trust.IndexMeta, bool) {
	if tf == nil || tf.Custom == nil {
		return trust.IndexMeta{}, false
	}
	var c struct {
		Whombat trust.IndexMeta `json:"whombat"`
	}
	if json.Unmarshal(*tf.Custom, &c) != nil || c.Whombat.Kind != trust.KindClosureIndex {
		return trust.IndexMeta{}, false
	}
	return c.Whombat, true
}

func (c component) matchesIndex(m trust.IndexMeta) bool {
	return m.Kind == trust.KindClosureIndex && m.Of == c.kind && m.StorePath == c.storePath && m.NarHash == c.narHash &&
		m.Version == c.version && m.Provider == c.provider
}

// fakeEncoder compresses fixture blobs.
func fakeCompress(b []byte) []byte {
	enc, _ := zstd.NewWriter(nil, zstd.WithEncoderLevel(zstd.SpeedFastest), zstd.WithEncoderConcurrency(1))
	defer enc.Close()
	return enc.EncodeAll(b, nil)
}

// FakeNarPath is one store path of a fixture closure: its "NAR" is FakeNar(Content) (the fake activator stores
// Content as the path's content), its NAR hash the sha256 of that.
type FakeNarPath struct {
	StorePath  string
	Content    []byte
	References []string
	// CorruptNar, if set, is compressed as the blob instead of Content (a blob that does not decompress to the NAR
	// its index names; tests of the box's checks).
	CorruptNar []byte
	// NarHash, if set, is the path's NAR hash in the index instead of FakeNar(Content)'s: a placeholder for a path the
	// box has already (AddComponentIndex). No blob is written for it.
	NarHash string
}

// BlobPath returns the repository file of a NAR hash's blob.
func (r *Repo) BlobPath(narHash string) (string, bool) {
	b, ok := mustBlobs(r)[strings.TrimPrefix(narHash, "sha256:")]
	if !ok {
		return "", false
	}
	return filepath.Join(r.blobsDir(), trust.BlobFileName(b.FileHex, narHash)), true
}

// AddComponentIndex adds the closure index of one component from one file (not yet published; `tufrepo add-index`):
// the closure is the component's path and, for a host generation, its manager's (whose content is its store path). The
// path's blob is FakeNar(content) when meta.NarHash is that NAR's hash: a fixture document the fake activator imports
// (the dev stack's releases). Any other NAR hash makes the path a placeholder for one the box has already (VM tests
// name the real store path and NAR hash): no blob is written, so the box downloads nothing for it, a box without the
// path fails to, and no real release can reuse a wrong blob under that NAR hash.
func (r *Repo) AddComponentIndex(target string, meta trust.IndexMeta, content []byte) error {
	meta.Kind = trust.KindClosureIndex
	var paths []FakeNarPath
	root := FakeNarPath{StorePath: meta.StorePath, Content: content, References: []string{}}
	if meta.Of == trust.KindHostGeneration {
		if meta.ManagerStorePath == "" {
			return errors.New("a host generation's index needs the manager's store path")
		}
		paths = append(paths, FakeNarPath{StorePath: meta.ManagerStorePath, Content: []byte(meta.ManagerStorePath), References: []string{}})
		root.References = []string{meta.ManagerStorePath}
	}
	if fakeNarHash(content) != meta.NarHash {
		root.NarHash = meta.NarHash
	}
	return r.AddFakeIndex(target, meta, append(paths, root))
}

// AddFakeIndex publishes a fixture closure index (not yet signed) for a component: the blobs of its paths (zstd of
// Content) and the index target. paths may be in any order; root must be among them.
func (r *Repo) AddFakeIndex(target string, meta trust.IndexMeta, paths []FakeNarPath) error {
	refs := map[string][]string{}
	byPath := map[string]FakeNarPath{}
	for _, p := range paths {
		refs[p.StorePath] = p.References
		byPath[p.StorePath] = p
	}
	order, err := nixexport.TopoOrder(refs)
	if err != nil {
		return err
	}
	ci := &trust.ClosureIndex{V: 1, Of: meta.Of, StorePath: meta.StorePath, NarHash: meta.NarHash, Compression: trust.CompressionZstd}
	for _, sp := range order {
		p := byPath[sp]
		nar := FakeNar(p.Content)
		sum := sha256.Sum256(nar)
		ip := trust.IndexPath{StorePath: sp, NarHash: "sha256:" + hex.EncodeToString(sum[:]), NarSize: int64(len(nar)),
			References: append([]string{}, p.References...), Deriver: ""}
		sort.Strings(ip.References)
		var fileHex string
		var size int64
		if p.NarHash != "" {
			ip.NarHash = p.NarHash
			b := fakeCompress(nar)
			sum := sha256.Sum256(b)
			fileHex, size = hex.EncodeToString(sum[:]), int64(len(b))
		} else if p.CorruptNar != nil {
			fileHex, size, err = r.putBlobUnchecked(fakeCompress(p.CorruptNar), ip)
		} else {
			fileHex, size, err = r.putBlobBytes(fakeCompress(nar), ip)
		}
		if err != nil {
			return err
		}
		ip.FileHash, ip.FileSize = "sha256:"+fileHex, size
		ci.Paths = append(ci.Paths, ip)
	}
	size, err := trust.CheckClosure(ci.Paths, meta.StorePath, meta.NarHash, true)
	if err != nil {
		return err
	}
	meta.Kind, meta.ClosureSize = trust.KindClosureIndex, size
	_, err = r.putIndex(target, ci, meta)
	return err
}

// FakeStore is the store a fixture release's closure indexes deliver: every path with the content its blob carries
// (FakeNar(content)) and its references, as the fake activator holds them after importing them. Tests seed a factory
// store with it.
func (r *Repo) FakeStore(indexes []trust.Artifact) (map[string]FakeNarPath, error) {
	out := map[string]FakeNarPath{}
	for _, ia := range indexes {
		p, err := r.TargetFilePath(ia.Target)
		if err != nil {
			return nil, err
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return nil, err
		}
		ci, err := trust.ParseClosureIndex(b, ia)
		if err != nil {
			return nil, err
		}
		for _, ip := range ci.Paths {
			bp, ok := r.BlobPath(ip.NarHash)
			if !ok {
				return nil, fmt.Errorf("no blob for %s", ip.StorePath)
			}
			nar, err := readFakeNar(bp, ip.NarSize)
			if err != nil {
				return nil, fmt.Errorf("%s: %w", ip.StorePath, err)
			}
			out[ip.StorePath] = FakeNarPath{StorePath: ip.StorePath, Content: nar[len(FakeNarPrefix):], References: ip.References}
		}
	}
	return out, nil
}

func readFakeNar(blob string, narSize int64) ([]byte, error) {
	f, err := os.Open(blob)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	nr, err := trust.NewNarReader(f, narSize)
	if err != nil {
		return nil, err
	}
	defer nr.Close()
	nar, err := io.ReadAll(nr)
	if err != nil {
		return nil, err
	}
	if !bytes.HasPrefix(nar, []byte(FakeNarPrefix)) {
		return nil, errors.New("not a fixture NAR")
	}
	return nar, nil
}
