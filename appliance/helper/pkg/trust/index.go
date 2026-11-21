package trust

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// Closure indexes (UP-X14, docs/implementation/delta-updates/spec.md): a component (host generation, runtime bundle,
// provider bundle) is delivered as a TUF target of kind closure-index listing every store path of its closure in import
// order with its NAR hash, size, references and the sha256/size of its zstd-compressed NAR blob. The blobs are not TUF
// targets: they live at targets/nar/<fileSha256hex>.<narSha256hex>.nar.zst and are verified through the signed index.

const (
	// KindClosureIndex classifies index targets. Managers and helpers before 0.3.0 filter artifact targets by kind
	// and skip it.
	KindClosureIndex Kind = "closure-index"
	// KindNarBlob is the Meta.Kind of a blob download unit (never a TUF target).
	KindNarBlob Kind = "nar-blob"
	// ArtifactFormatClosureIndex is the Meta.Format of an index Artifact, ArtifactFormatNarZstd of a blob.
	ArtifactFormatClosureIndex = "closure-index"
	ArtifactFormatNarZstd      = "nar-zstd"
	// CompressionZstd is the only blob compression.
	CompressionZstd = "zstd"
	// MaxIndexPaths bounds the paths of one index; MaxIndexBytes the size of an index target.
	MaxIndexPaths = 65536
	MaxIndexBytes = 64 << 20
	// BlobDir is the targets subdirectory of the blobs.
	BlobDir = "nar"
	// IndexV1 lists blobs at targets/nar/<file>.<nar>.nar.zst; IndexV2 (LNK-24) at nar-<first two hex of the file
	// hash>/<file>.<nar>.nar.zst under the targets base, the GitHub bucket releases. Same content otherwise: the
	// version only says where the blobs are, so a manager before it refuses an index whose blobs it can't find.
	IndexV1 = 1
	IndexV2 = 2
)

// hex64 reports whether s is 64 lowercase hex digits (a sha256).
func hex64(s string) bool {
	if len(s) != 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		if c := s[i]; (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// ValidNarHash reports whether h is sha256:<64 lowercase hex>.
func ValidNarHash(h string) bool { return digestRe.MatchString(h) }

// IndexMeta is the custom metadata of a closure-index target.
type IndexMeta struct {
	Kind        Kind   `json:"kind"` // closure-index
	Of          Kind   `json:"of"`   // host-generation | runtime-bundle | provider-bundle
	Version     string `json:"version"`
	StorePath   string `json:"storePath"`
	NarHash     string `json:"narHash"`
	ClosureSize int64  `json:"closureSize"`
	// Host generations: the whombat-manager store path (tuple.manager), required there.
	ManagerStorePath string `json:"managerStorePath,omitempty"`
	// Provider bundles: the provider name.
	Provider string `json:"provider,omitempty"`
	// Paths and DownloadSize (Σ fileSize) are informational.
	Paths        int   `json:"paths"`
	DownloadSize int64 `json:"downloadSize"`
}

// Validate checks the metadata.
func (m IndexMeta) Validate() error {
	if m.Kind != KindClosureIndex {
		return fmt.Errorf("kind %q is not a closure index", m.Kind)
	}
	if !versionRe.MatchString(m.Version) {
		return fmt.Errorf("bad version %q", m.Version)
	}
	if !storePathRe.MatchString(m.StorePath) {
		return fmt.Errorf("bad store path %q", m.StorePath)
	}
	if !digestRe.MatchString(m.NarHash) {
		return fmt.Errorf("bad narHash %q", m.NarHash)
	}
	if m.ClosureSize <= 0 || m.Paths < 1 || m.Paths > MaxIndexPaths || m.DownloadSize < 0 {
		return errors.New("bad closureSize, paths or downloadSize")
	}
	switch m.Of {
	case KindHostGeneration:
		if !storePathRe.MatchString(m.ManagerStorePath) || m.Provider != "" {
			return errors.New("host generation index needs managerStorePath and no provider")
		}
	case KindRuntimeBundle:
		if m.ManagerStorePath != "" || m.Provider != "" {
			return errors.New("runtime bundle index with managerStorePath or provider")
		}
	case KindProviderBundle:
		if !providerRe.MatchString(m.Provider) || m.ManagerStorePath != "" {
			return errors.New("provider bundle index without a valid provider name")
		}
	default:
		return fmt.Errorf("index of %q", m.Of)
	}
	return nil
}

// ArtifactMeta returns the component metadata an index Artifact carries in Meta (ClosureSize 0: the unpacked sizes are
// counted by the blobs).
func (m IndexMeta) ArtifactMeta() ArtifactMeta {
	return ArtifactMeta{Kind: m.Of, Version: m.Version, Format: ArtifactFormatClosureIndex, StorePath: m.StorePath,
		NarHash: m.NarHash, ManagerStorePath: m.ManagerStorePath, Provider: m.Provider}
}

// IndexPath is one store path of a closure index. FileSize/FileHash (the blob) are absent in a release directory's
// listing (<component>.paths.json) and required in a published index.
type IndexPath struct {
	StorePath  string   `json:"storePath"`
	NarHash    string   `json:"narHash"`
	NarSize    int64    `json:"narSize"`
	References []string `json:"references"`
	Deriver    string   `json:"deriver"`
	FileSize   int64    `json:"fileSize,omitempty"`
	FileHash   string   `json:"fileHash,omitempty"`
}

// ClosureIndex is the content of a closure-index target (canonical JSON) and, without blob fields, a listing.
type ClosureIndex struct {
	V           int         `json:"v"` // IndexV1 or IndexV2
	Of          Kind        `json:"of"`
	StorePath   string      `json:"storePath"`
	NarHash     string      `json:"narHash"`
	Compression string      `json:"compression"`
	Paths       []IndexPath `json:"paths"`
}

// BlobTarget returns the download target of a blob ("nar/<narhex>.nar.zst"; its file is
// nar/<fileSha256hex>.<narhex>.nar.zst, tufclient.RemotePath).
func BlobTarget(narHash string) string {
	return BlobDir + "/" + strings.TrimPrefix(narHash, "sha256:") + ".nar.zst"
}

// BlobFileName returns the name of a blob file in targets/nar/.
func BlobFileName(fileHashHex, narHash string) string {
	return fileHashHex + "." + strings.TrimPrefix(narHash, "sha256:") + ".nar.zst"
}

// ParseBlobFileName splits a targets/nar/ file name into the file's and the NAR's sha256 (hex).
func ParseBlobFileName(name string) (fileHex, narHex string, ok bool) {
	rest, ok := strings.CutSuffix(name, ".nar.zst")
	if !ok || len(rest) != 129 || rest[64] != '.' {
		return "", "", false
	}
	fileHex, narHex = rest[:64], rest[65:]
	return fileHex, narHex, hex64(fileHex) && hex64(narHex)
}

// Blob returns the download unit of path i (Meta.ClosureSize is its NAR size, so space planning counts the unpacked
// size).
func (ci *ClosureIndex) Blob(i int) Artifact {
	p := ci.Paths[i]
	fileHex := strings.TrimPrefix(p.FileHash, "sha256:")
	a := Artifact{Target: BlobTarget(p.NarHash), Length: p.FileSize, Hashes: map[string]string{"sha256": fileHex},
		Meta: ArtifactMeta{Kind: KindNarBlob, Format: ArtifactFormatNarZstd, StorePath: p.StorePath, NarHash: p.NarHash, ClosureSize: p.NarSize}}
	if ci.V == IndexV2 && hex64(fileHex) {
		a.Remote = BlobRemote(fileHex, p.NarHash)
	}
	return a
}

// BlobRemote is a version-2 index's blob under the targets base: nar-<xx>/<file>.<nar>.nar.zst (LNK-24).
func BlobRemote(fileHashHex, narHash string) string {
	return BlobBucket(fileHashHex) + "/" + BlobFileName(fileHashHex, narHash)
}

// StorePaths lists the index's store paths in import order.
func (ci *ClosureIndex) StorePaths() []string {
	out := make([]string, len(ci.Paths))
	for i, p := range ci.Paths {
		out[i] = p.StorePath
	}
	return out
}

// CheckClosure verifies a listing's structure: well-formed store paths, hashes and sizes, no duplicates, import order
// (every reference is the path itself or earlier), the closure of root complete and equal to the listing, root's NAR
// hash. It returns the closure size (Σ narSize). Blob fields are checked when withBlobs is set (and must be absent
// otherwise).
func CheckClosure(paths []IndexPath, root, rootNarHash string, withBlobs bool) (int64, error) {
	if len(paths) == 0 || len(paths) > MaxIndexPaths {
		return 0, fmt.Errorf("%d paths (1…%d)", len(paths), MaxIndexPaths)
	}
	pos := make(map[string]int, len(paths))
	var size int64
	for i, p := range paths {
		if !storePathRe.MatchString(p.StorePath) {
			return 0, fmt.Errorf("bad store path %q", p.StorePath)
		}
		if _, dup := pos[p.StorePath]; dup {
			return 0, fmt.Errorf("%s appears twice", p.StorePath)
		}
		if !digestRe.MatchString(p.NarHash) || p.NarSize <= 0 || p.NarSize > 1<<50 {
			return 0, fmt.Errorf("%s: bad narHash or narSize", p.StorePath)
		}
		if p.Deriver != "" && !storePathRe.MatchString(p.Deriver) {
			return 0, fmt.Errorf("%s: bad deriver %q", p.StorePath, p.Deriver)
		}
		if withBlobs {
			if p.FileSize <= 0 || p.FileSize > 1<<50 || !digestRe.MatchString(p.FileHash) {
				return 0, fmt.Errorf("%s: bad fileSize or fileHash", p.StorePath)
			}
		} else if p.FileSize != 0 || p.FileHash != "" {
			return 0, fmt.Errorf("%s: a listing carries no blob fields", p.StorePath)
		}
		if p.References == nil {
			return 0, fmt.Errorf("%s: references missing", p.StorePath)
		}
		seenRef := make(map[string]bool, len(p.References))
		for _, r := range p.References {
			if seenRef[r] {
				return 0, fmt.Errorf("%s references %s twice", p.StorePath, r)
			}
			seenRef[r] = true
			if r == p.StorePath {
				continue
			}
			if _, ok := pos[r]; !ok {
				return 0, fmt.Errorf("%s references %s, which is not before it (import order, complete closure)", p.StorePath, r)
			}
		}
		pos[p.StorePath] = i
		size += p.NarSize
	}
	ri, ok := pos[root]
	if !ok {
		return 0, fmt.Errorf("the root %s is not listed", root)
	}
	if paths[ri].NarHash != rootNarHash {
		return 0, fmt.Errorf("the root's narHash is %s, not %s", paths[ri].NarHash, rootNarHash)
	}
	// The listing is exactly the closure of root.
	seen := make([]bool, len(paths))
	stack := []int{ri}
	reached := 0
	for len(stack) > 0 {
		i := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if seen[i] {
			continue
		}
		seen[i] = true
		reached++
		for _, r := range paths[i].References {
			if j := pos[r]; !seen[j] {
				stack = append(stack, j)
			}
		}
	}
	if reached != len(paths) {
		for i, s := range seen {
			if !s {
				return 0, fmt.Errorf("%s is not in the closure of %s", paths[i].StorePath, root)
			}
		}
	}
	return size, nil
}

// Contains reports whether the index lists storePath.
func (ci *ClosureIndex) Contains(storePath string) bool {
	for _, p := range ci.Paths {
		if p.StorePath == storePath {
			return true
		}
	}
	return false
}

// DecodeClosureIndex strictly decodes an index or a listing (no verification against TUF).
func DecodeClosureIndex(b []byte) (*ClosureIndex, error) {
	var ci ClosureIndex
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&ci); err != nil {
		return nil, err
	}
	if dec.More() {
		return nil, errors.New("trailing data")
	}
	if ci.V != IndexV1 && ci.V != IndexV2 {
		return nil, fmt.Errorf("unsupported index version %d", ci.V)
	}
	return &ci, nil
}

// ParseClosureIndex verifies an index's bytes against its TUF target (length, hashes) and its metadata: strict JSON,
// version 1, zstd, the component (of, root store path and NAR hash) of the target, the structure (CheckClosure with
// blob fields), the closure size of the metadata and, for a host generation, the manager in the closure.
func ParseClosureIndex(b []byte, ia Artifact) (*ClosureIndex, error) {
	if ia.Index == nil {
		return nil, fmt.Errorf("%w: %s is not a closure index", ErrInvalidMetadata, ia.Target)
	}
	if ia.Length > MaxIndexBytes {
		return nil, fmt.Errorf("%w: %s is larger than %d bytes", ErrInvalidMetadata, ia.Target, MaxIndexBytes)
	}
	v := newVerifier(ia)
	if _, err := v.Write(b); err != nil {
		return nil, err
	}
	if err := v.check(); err != nil {
		return nil, err
	}
	m := ia.Index
	ci, err := DecodeClosureIndex(b)
	if err != nil {
		return nil, fmt.Errorf("%w: %s: %v", ErrInvalidMetadata, ia.Target, err)
	}
	bad := func(format string, a ...any) error {
		return fmt.Errorf("%w: %s: %s", ErrInvalidMetadata, ia.Target, fmt.Sprintf(format, a...))
	}
	if ci.Compression != CompressionZstd {
		return nil, bad("compression %q", ci.Compression)
	}
	if ci.Of != m.Of || ci.StorePath != m.StorePath || ci.NarHash != m.NarHash {
		return nil, bad("the index is of %s %s, the target of %s %s", ci.Of, ci.StorePath, m.Of, m.StorePath)
	}
	size, err := CheckClosure(ci.Paths, ci.StorePath, ci.NarHash, true)
	if err != nil {
		return nil, bad("%v", err)
	}
	if size != m.ClosureSize {
		return nil, bad("closure size %d, the metadata says %d", size, m.ClosureSize)
	}
	if m.Of == KindHostGeneration && !ci.Contains(m.ManagerStorePath) {
		return nil, bad("the host closure does not contain the manager %s", m.ManagerStorePath)
	}
	return ci, nil
}
