package clientchannel

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/CybexBV/whombat/contracts/go/release"
)

// The official sources (docs/managed/provider-bundles.md in Whombat). Claude Code only: ChatGPT runs on Hermes's own
// provider with no client, so Codex is no longer followed, fetched or published (IN-432; Whombat HN-04, HN-A04).
const (
	ClaudeNpmPackage = "@anthropic-ai/claude-code"
	ClaudeReleaseURL = "https://downloads.claude.ai/claude-code-releases"
	npmRegistry      = "https://registry.npmjs.org/"
	maxJSON          = 32 << 20
	userAgent        = "whombat-clientchannel"
	downloadTimeout  = 30 * time.Minute
	metadataTimeout  = time.Minute
)

// ErrNotPublished: a provider the channel no longer follows (Codex, IN-432).
var ErrNotPublished = errors.New("codex is no longer tested or published: ChatGPT runs on Hermes's own provider (IN-432)")

// Platform is a contract architecture's names upstream.
func npmPlatform(a release.ClientArch) string {
	if a == release.ClientArchAarch64 {
		return "linux-arm64"
	}
	return "linux-x64"
}

// Pin is one platform's digests, as Whombat's bundles.ts records them.
type Pin struct {
	SHA256       string  `json:"sha256"`       // the release artifact (Claude Code's is the executable)
	NpmIntegrity string  `json:"npmIntegrity"` // the npm platform package's dist.integrity
	BinarySHA256 *string `json:"binarySha256"` // the executable, when known
}

// Fetched is an official artifact downloaded for one version and architecture, with the other platforms' pins.
type Fetched struct {
	Provider    release.ClientProvider `json:"provider"`
	Version     string                 `json:"version"`
	Arch        release.ClientArch     `json:"arch"`
	PublishedAt time.Time              `json:"publishedAt"`
	URL         string                 `json:"url"`
	File        string                 `json:"file"`
	SHA256      string                 `json:"sha256"`
	Format      string                 `json:"format"`
	Path        string                 `json:"path,omitempty"`
	Pins        map[string]Pin         `json:"pins"` // linux-x64, linux-arm64
}

// HTTP is the client for upstream metadata and downloads.
type HTTP struct{ Client *http.Client }

func (h HTTP) get(ctx context.Context, url string, timeout time.Duration) (*http.Response, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		cancel()
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	c := h.Client
	if c == nil {
		c = http.DefaultClient
	}
	resp, err := c.Do(req)
	if err != nil {
		cancel()
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		cancel()
		return nil, fmt.Errorf("GET %s: HTTP %d", url, resp.StatusCode)
	}
	resp.Body = struct {
		io.Reader
		io.Closer
	}{resp.Body, closer(func() error { cancel(); return nil })}
	return resp, nil
}

type closer func() error

func (c closer) Close() error { return c() }

func (h HTTP) json(ctx context.Context, url string, v any) error {
	resp, err := h.get(ctx, url, metadataTimeout)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return json.NewDecoder(io.LimitReader(resp.Body, maxJSON)).Decode(v)
}

// Latest returns upstream's latest release: npm's `latest` dist-tag of @anthropic-ai/claude-code.
func (h HTTP) Latest(ctx context.Context, p release.ClientProvider) (string, error) {
	switch p {
	case release.ClientProviderClaude:
		var doc struct {
			DistTags map[string]string `json:"dist-tags"`
		}
		if err := h.json(ctx, npmRegistry+strings.Replace(ClaudeNpmPackage, "/", "%2F", 1), &doc); err != nil {
			return "", err
		}
		if v := doc.DistTags["latest"]; v != "" {
			return v, nil
		}
		return "", fmt.Errorf("%s has no latest dist-tag", ClaudeNpmPackage)
	case release.ClientProviderCodex:
		return "", ErrNotPublished
	}
	return "", fmt.Errorf("unknown provider %q", p)
}

func (h HTTP) npmIntegrity(ctx context.Context, pkg, version string) (string, error) {
	var doc struct {
		Dist struct {
			Integrity string `json:"integrity"`
		} `json:"dist"`
	}
	if err := h.json(ctx, npmRegistry+strings.Replace(pkg, "/", "%2F", 1)+"/"+version, &doc); err != nil {
		return "", err
	}
	return doc.Dist.Integrity, nil
}

func (h HTTP) download(ctx context.Context, url, dst string) error {
	resp, err := h.get(ctx, url, downloadTimeout)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	f, err := os.Create(dst + ".part")
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, resp.Body); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(dst+".part", dst)
}

// Fetch downloads the official artifact of version for arch into dir and checks it against the vendor's published
// digest (Claude Code: the version's manifest.json checksum).
func (h HTTP) Fetch(ctx context.Context, p release.ClientProvider, version string, arch release.ClientArch, dir string) (*Fetched, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	f := &Fetched{Provider: p, Version: version, Arch: arch, Pins: map[string]Pin{}}
	switch p {
	case release.ClientProviderClaude:
		var man struct {
			Version   string `json:"version"`
			Platforms map[string]struct {
				Checksum string `json:"checksum"`
				Size     int64  `json:"size"`
			} `json:"platforms"`
		}
		if err := h.json(ctx, ClaudeReleaseURL+"/"+version+"/manifest.json", &man); err != nil {
			return nil, err
		}
		if man.Version != version {
			return nil, fmt.Errorf("manifest.json is for %q", man.Version)
		}
		var reg struct {
			Time map[string]time.Time `json:"time"`
		}
		if err := h.json(ctx, npmRegistry+strings.Replace(ClaudeNpmPackage, "/", "%2F", 1), &reg); err != nil {
			return nil, err
		}
		f.PublishedAt = reg.Time[version]
		for _, plat := range []string{"linux-x64", "linux-arm64"} {
			sum := man.Platforms[plat].Checksum
			integ, err := h.npmIntegrity(ctx, ClaudeNpmPackage+"-"+plat, version)
			if err != nil {
				return nil, err
			}
			s := sum
			f.Pins[plat] = Pin{SHA256: sum, NpmIntegrity: integ, BinarySHA256: &s}
		}
		plat := npmPlatform(arch)
		f.URL = ClaudeReleaseURL + "/" + version + "/" + plat + "/claude"
		f.File = filepath.Join(dir, "claude-"+version+"-"+plat)
		f.Format = "binary"
		f.SHA256 = man.Platforms[plat].Checksum
	case release.ClientProviderCodex:
		return nil, ErrNotPublished
	default:
		return nil, fmt.Errorf("unknown provider %q", p)
	}
	if f.SHA256 == "" || f.PublishedAt.IsZero() {
		return nil, fmt.Errorf("%s %s: no published digest or date", p, version)
	}
	if err := h.download(ctx, f.URL, f.File); err != nil {
		return nil, err
	}
	got, _, err := sha256File(f.File)
	if err != nil {
		return nil, err
	}
	if got != f.SHA256 {
		os.Remove(f.File)
		return nil, fmt.Errorf("%s: sha256 %s, the vendor publishes %s", f.URL, got, f.SHA256)
	}
	return f, nil
}
