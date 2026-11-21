package assist

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"

	"golang.org/x/crypto/openpgp" //nolint:staticcheck // verifies Anthropic's GPG-signed release manifests
)

// Release sources (tests point them at a local server).
var (
	claudeReleases = "https://downloads.claude.ai/claude-code-releases"
	codexReleases  = "https://api.github.com/repos/openai/codex/releases"
	// claudeKeyFingerprint pins Anthropic's Claude Code release signing key
	// (https://code.claude.com/docs/en/setup#binary-integrity-and-code-signing).
	claudeKeyFingerprint = "31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE"
	httpClient           = &http.Client{Timeout: 0} // downloads are bounded by their context
)

//go:embed claude-code.asc
var claudeKeyArmored string

var versionRe = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$`)

// binaryName is the executable of a provider.
func binaryName(provider string) string {
	if provider == Codex {
		return "codex"
	}
	return "claude"
}

func (r *Runner) providerDir(provider string) string {
	return filepath.Join(r.opts.StateDir, "bin", provider)
}

// binary is the current executable of a provider ("" when not installed).
func (r *Runner) binary(provider string) string {
	p := filepath.Join(r.providerDir(provider), "current", binaryName(provider))
	if fi, err := os.Stat(p); err != nil || fi.IsDir() {
		return ""
	}
	return p
}

// installedVersion is the version "current" points at.
func (r *Runner) installedVersion(provider string) string {
	t, err := os.Readlink(filepath.Join(r.providerDir(provider), "current"))
	if err != nil || r.binary(provider) == "" {
		return ""
	}
	return filepath.Base(t)
}

func musl() bool {
	m, _ := filepath.Glob("/lib/ld-musl-*.so.1")
	return len(m) > 0
}

// claudePlatform is the manifest's platform key for this machine.
func claudePlatform() (string, error) {
	var p string
	switch runtime.GOARCH {
	case "amd64":
		p = "linux-x64"
	case "arm64":
		p = "linux-arm64"
	default:
		return "", Errf(CodeInvalid, "Claude Code has no build for %s", runtime.GOARCH)
	}
	if musl() {
		p += "-musl"
	}
	return p, nil
}

// codexTarget is the Rust target of Codex's static build for this machine.
func codexTarget() (string, error) {
	switch runtime.GOARCH {
	case "amd64":
		return "x86_64-unknown-linux-musl", nil
	case "arm64":
		return "aarch64-unknown-linux-musl", nil
	}
	return "", Errf(CodeInvalid, "Codex has no build for %s", runtime.GOARCH)
}

func get(ctx context.Context, url string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "rackoon-assist")
	if strings.Contains(url, "api.github.com") {
		req.Header.Set("Accept", "application/vnd.github+json")
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, Errf(CodeDownload, "%s: %v", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, Errf(CodeDownload, "%s: HTTP %d", url, resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, Errf(CodeDownload, "%s: %v", url, err)
	}
	if int64(len(b)) > limit {
		return nil, Errf(CodeDownload, "%s: larger than expected", url)
	}
	return b, nil
}

// Latest returns the newest version of a provider.
func (r *Runner) Latest(ctx context.Context, provider, channel string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	switch provider {
	case Claude:
		if channel != "latest" {
			channel = "stable"
		}
		b, err := get(ctx, claudeReleases+"/"+channel, 64)
		if err != nil {
			return "", err
		}
		v := strings.TrimSpace(string(b))
		if !versionRe.MatchString(v) {
			return "", Errf(CodeDownload, "unexpected Claude Code version %q", v)
		}
		return v, nil
	case Codex:
		rel, err := codexRelease(ctx, "")
		if err != nil {
			return "", err
		}
		return rel.version, nil
	}
	return "", Errf(CodeInvalid, "unknown provider %q", provider)
}

type codexAsset struct {
	version, url, digest string
	size                 int64
}

// codexRelease finds the static Codex build of a release ("": the latest).
func codexRelease(ctx context.Context, version string) (codexAsset, error) {
	var a codexAsset
	target, err := codexTarget()
	if err != nil {
		return a, err
	}
	url := codexReleases + "/latest"
	if version != "" {
		url = codexReleases + "/tags/rust-v" + version
	}
	b, err := get(ctx, url, 4<<20)
	if err != nil {
		return a, err
	}
	var rel struct {
		Tag    string `json:"tag_name"`
		Assets []struct {
			Name   string `json:"name"`
			URL    string `json:"browser_download_url"`
			Size   int64  `json:"size"`
			Digest string `json:"digest"`
		} `json:"assets"`
	}
	if err := json.Unmarshal(b, &rel); err != nil {
		return a, Errf(CodeDownload, "Codex release: %v", err)
	}
	a.version = strings.TrimPrefix(rel.Tag, "rust-v")
	if !versionRe.MatchString(a.version) {
		return a, Errf(CodeDownload, "unexpected Codex release tag %q", rel.Tag)
	}
	// The package, not the bare binary: Codex runs tool calls through
	// codex-code-mode-host, which only the package carries.
	want := "codex-package-" + target + ".tar.gz"
	for _, as := range rel.Assets {
		if as.Name == want {
			a.url, a.size, a.digest = as.URL, as.Size, strings.TrimPrefix(as.Digest, "sha256:")
		}
	}
	if a.url == "" {
		return a, Errf(CodeDownload, "Codex %s has no %s", a.version, want)
	}
	if len(a.digest) != 64 {
		return a, Errf(CodeVerify, "Codex %s: the release publishes no SHA-256 for %s", a.version, want)
	}
	return a, nil
}

// Install downloads, verifies and switches to a version (the newest of
// the channel when none is given). Running sessions keep their binary.
func (r *Runner) Install(ctx context.Context, p InstallParams) (string, error) {
	if !r.begin(p.Provider) {
		return "", Errf(CodeBusy, "%s is already being installed", ProviderName(p.Provider))
	}
	defer r.end(p.Provider)
	ctx, cancel := context.WithTimeout(ctx, 30*time.Minute)
	defer cancel()
	var version string
	var err error
	switch p.Provider {
	case Claude:
		version, err = r.installClaude(ctx, p)
	case Codex:
		version, err = r.installCodex(ctx, p)
	default:
		return "", Errf(CodeInvalid, "unknown provider %q", p.Provider)
	}
	if err != nil {
		return "", err
	}
	r.prune(p.Provider)
	r.forget(p.Provider) // sign-in state may differ for the new version
	return version, nil
}

func (r *Runner) installClaude(ctx context.Context, p InstallParams) (string, error) {
	platform, err := claudePlatform()
	if err != nil {
		return "", err
	}
	version := p.Version
	if version == "" {
		if version, err = r.Latest(ctx, Claude, p.Channel); err != nil {
			return "", err
		}
	}
	if !versionRe.MatchString(version) {
		return "", Errf(CodeInvalid, "invalid version %q", version)
	}
	if r.installedVersion(Claude) == version {
		return version, nil
	}
	base := claudeReleases + "/" + version
	manifest, err := get(ctx, base+"/manifest.json", 1<<20)
	if err != nil {
		return "", err
	}
	sig, err := get(ctx, base+"/manifest.json.sig", 64<<10)
	if err != nil {
		return "", err
	}
	if err := verifyClaudeManifest(manifest, sig); err != nil {
		return "", err
	}
	var m struct {
		Version   string `json:"version"`
		Platforms map[string]struct {
			Binary   string `json:"binary"`
			Checksum string `json:"checksum"`
			Size     int64  `json:"size"`
		} `json:"platforms"`
	}
	if err := json.Unmarshal(manifest, &m); err != nil {
		return "", Errf(CodeVerify, "Claude Code manifest: %v", err)
	}
	pl, ok := m.Platforms[platform]
	if m.Version != version || !ok || len(pl.Checksum) != 64 || pl.Binary == "" || strings.ContainsAny(pl.Binary, "/\\") {
		return "", Errf(CodeVerify, "Claude Code %s: the manifest has no %s build", version, platform)
	}
	tmp, err := r.download(ctx, Claude, base+"/"+platform+"/"+pl.Binary, pl.Size, pl.Checksum)
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp)
	return version, r.place(ctx, Claude, version, map[string]string{"claude": tmp})
}

// verifyClaudeManifest checks the detached signature against the pinned
// release key.
func verifyClaudeManifest(manifest, sig []byte) error {
	ring, err := openpgp.ReadArmoredKeyRing(strings.NewReader(claudeKeyArmored))
	if err != nil || len(ring) == 0 {
		return Errf(CodeVerify, "the Claude Code release key is unreadable: %v", err)
	}
	if fp := strings.ToUpper(hex.EncodeToString(ring[0].PrimaryKey.Fingerprint[:])); fp != claudeKeyFingerprint {
		return Errf(CodeVerify, "unexpected Claude Code release key %s", fp)
	}
	check := openpgp.CheckArmoredDetachedSignature
	if !bytes.HasPrefix(bytes.TrimSpace(sig), []byte("-----BEGIN")) {
		check = openpgp.CheckDetachedSignature
	}
	if _, err := check(ring, bytes.NewReader(manifest), bytes.NewReader(sig)); err != nil {
		return Errf(CodeVerify, "the Claude Code manifest signature does not verify: %v", err)
	}
	return nil
}

func (r *Runner) installCodex(ctx context.Context, p InstallParams) (string, error) {
	a, err := codexRelease(ctx, p.Version)
	if err != nil {
		return "", err
	}
	if r.installedVersion(Codex) == a.version {
		return a.version, nil
	}
	tgz, err := r.download(ctx, Codex, a.url, a.size, a.digest)
	if err != nil {
		return "", err
	}
	defer os.Remove(tgz)
	files, err := extractCodex(tgz)
	for _, f := range files {
		defer os.Remove(f)
	}
	if err != nil {
		return "", err
	}
	return a.version, r.place(ctx, Codex, a.version, files)
}

// codexPackageFiles are the files Rackoon takes from Codex's package.
var codexPackageFiles = map[string]string{"bin/codex": "codex", "bin/codex-code-mode-host": "codex-code-mode-host"}

// extractCodex writes the package's executables next to the archive and
// returns them by name.
func extractCodex(tgz string) (map[string]string, error) {
	out := map[string]string{}
	f, err := os.Open(tgz)
	if err != nil {
		return out, err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return out, Errf(CodeVerify, "Codex archive: %v", err)
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return out, Errf(CodeVerify, "Codex archive: %v", err)
		}
		name, ok := codexPackageFiles[strings.TrimPrefix(h.Name, "./")]
		if !ok || h.Typeflag != tar.TypeReg {
			continue
		}
		dst := tgz + "." + name
		w, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o700)
		if err != nil {
			return out, err
		}
		_, err = io.Copy(w, io.LimitReader(tr, 1<<30))
		if cerr := w.Close(); err == nil {
			err = cerr
		}
		out[name] = dst
		if err != nil {
			return out, err
		}
	}
	for _, name := range codexPackageFiles {
		if out[name] == "" {
			return out, Errf(CodeVerify, "the Codex package holds no %s", name)
		}
	}
	return out, nil
}

// download fetches url into a temporary file in the provider's directory,
// checking its size and SHA-256, and reports progress.
func (r *Runner) download(ctx context.Context, provider, url string, size int64, sum string) (string, error) {
	dir := r.providerDir(provider)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	f, err := os.CreateTemp(dir, ".download-*")
	if err != nil {
		return "", err
	}
	tmp := f.Name()
	fail := func(err error) (string, error) {
		f.Close()
		os.Remove(tmp)
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return fail(err)
	}
	req.Header.Set("User-Agent", "rackoon-assist")
	resp, err := httpClient.Do(req)
	if err != nil {
		return fail(Errf(CodeDownload, "%s: %v", url, err))
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fail(Errf(CodeDownload, "%s: HTTP %d", url, resp.StatusCode))
	}
	total := size
	if total <= 0 {
		total = resp.ContentLength
	}
	h := sha256.New()
	pw := &progressWriter{r: r, provider: provider, total: total}
	limit := int64(2 << 30)
	if size > 0 {
		limit = size
	}
	n, err := io.Copy(io.MultiWriter(f, h, pw), io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return fail(Errf(CodeDownload, "%s: %v", url, err))
	}
	if size > 0 && n != size {
		return fail(Errf(CodeVerify, "%s: %d bytes instead of %d", url, n, size))
	}
	if got := hex.EncodeToString(h.Sum(nil)); !strings.EqualFold(got, sum) {
		return fail(Errf(CodeVerify, "%s: SHA-256 %s does not match %s", url, got, sum))
	}
	pw.flush()
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return "", err
	}
	return tmp, nil
}

type progressWriter struct {
	r        *Runner
	provider string
	total    int64
	done     int64
	last     time.Time
}

func (p *progressWriter) Write(b []byte) (int, error) {
	p.done += int64(len(b))
	if time.Since(p.last) >= time.Second {
		p.flush()
	}
	return len(b), nil
}

func (p *progressWriter) flush() {
	p.last = time.Now()
	p.r.notify(NProgress, Progress{Provider: p.provider, Done: p.done, Total: p.total})
}

// place installs verified executables (name -> file) as version and
// makes it current after the CLI ran (--version).
func (r *Runner) place(ctx context.Context, provider, version string, files map[string]string) error {
	dir := filepath.Join(r.providerDir(provider), version)
	if err := os.RemoveAll(dir); err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	for name, src := range files {
		if err := copyFile(src, filepath.Join(dir, name), 0o700); err != nil {
			return err
		}
	}
	bin := filepath.Join(dir, binaryName(provider))
	vctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(vctx, bin, "--version")
	cmd.Env = r.cliEnv(provider, nil)
	cmd.Dir = r.opts.StateDir
	out, err := cmd.CombinedOutput()
	if err != nil || !strings.Contains(string(out), version) {
		os.RemoveAll(dir)
		return Errf(CodeVerify, "%s %s does not run here: %s", ProviderName(provider), version, firstLine(string(out), err))
	}
	link := filepath.Join(r.providerDir(provider), "current")
	tmp := link + ".new"
	os.Remove(tmp)
	if err := os.Symlink(version, tmp); err != nil {
		return err
	}
	return os.Rename(tmp, link)
}

func copyFile(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

func firstLine(s string, err error) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	if s == "" && err != nil {
		s = err.Error()
	}
	if len(s) > 300 {
		s = s[:300]
	}
	return s
}

// prune keeps the current version, the one before it and those running
// sessions use.
func (r *Runner) prune(provider string) {
	dir := r.providerDir(provider)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	cur := r.installedVersion(provider)
	var versions []os.DirEntry
	for _, e := range entries {
		if e.IsDir() && versionRe.MatchString(e.Name()) {
			versions = append(versions, e)
		}
	}
	sort.Slice(versions, func(i, j int) bool {
		a, _ := versions[i].Info()
		b, _ := versions[j].Info()
		return a.ModTime().After(b.ModTime())
	})
	inUse := r.versionsInUse(provider)
	kept := 0
	for _, e := range versions {
		v := e.Name()
		if v == cur || inUse[v] || kept < 2 {
			kept++
			continue
		}
		os.RemoveAll(filepath.Join(dir, v))
	}
}

// Uninstall removes every version of a provider (sign-ins stay).
func (r *Runner) Uninstall(provider string) error {
	if !r.begin(provider) {
		return Errf(CodeBusy, "%s is being installed", ProviderName(provider))
	}
	defer r.end(provider)
	if len(r.versionsInUse(provider)) > 0 {
		return Errf(CodeBusy, "an investigation still uses %s", ProviderName(provider))
	}
	r.forget(provider)
	return os.RemoveAll(r.providerDir(provider))
}

func (r *Runner) requireBinary(provider string) (string, error) {
	if b := r.binary(provider); b != "" {
		return b, nil
	}
	return "", Errf(CodeNotInstalled, "%s is not installed", ProviderName(provider))
}

func (r *Runner) begin(provider string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.busy[provider] {
		return false
	}
	r.busy[provider] = true
	return true
}

func (r *Runner) end(provider string) {
	r.mu.Lock()
	delete(r.busy, provider)
	r.mu.Unlock()
}
