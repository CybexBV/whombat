package clients

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/atomicfile"
	"github.com/CybexBV/whombat/appliance/manager/pkg/clientbundle"
	"github.com/CybexBV/whombat/contracts/go/release"
)

// Upstream fetches a client's executable from its publisher's own download site.
type Upstream interface {
	Get(ctx context.Context, url string) (io.ReadCloser, error)
}

// upstreamSites are the download sites a client is installed from directly, by provider: Claude Code is Anthropic's
// program, which Whombat installs from Anthropic rather than handing out a copy. Codex is open source and would keep
// coming from its TUF target.
var upstreamSites = map[Provider]struct{ host, prefix string }{
	release.ClientProviderClaude: {host: "downloads.claude.ai", prefix: "/claude-code-releases/"},
}

// upstreamSource says whether a bundle is installed from its publisher's site, and from which address: a bare
// executable (`binary`) on that provider's site, whose source and executable agree in the signed channel. A bundle on
// another site installs from its TUF target as before.
func upstreamSource(p Provider, b release.ClientBundle) (string, bool, error) {
	site, ok := upstreamSites[p]
	if !ok || b.Source.Format != "binary" {
		return "", false, nil
	}
	u, err := url.Parse(b.Source.URL)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Host != site.host || u.RawQuery != "" || u.Fragment != "" ||
		!strings.HasPrefix(u.Path, site.prefix) || strings.Contains(u.Path, "..") {
		return "", false, nil
	}
	if b.Source.SHA256 != b.Executable.SHA256 || b.Source.Size != b.Executable.Size || b.Executable.Size <= 0 {
		return "", false, digestErr("the channel's source (%d bytes %s) and executable (%d bytes %s) differ",
			b.Source.Size, b.Source.SHA256, b.Executable.Size, b.Executable.SHA256)
	}
	return u.String(), true, nil
}

// executableName is where the executable goes inside the version directory: the bundle's own path, else the
// provider's name.
func executableName(p Provider, b release.ClientBundle) string {
	if b.Artifact.Path != "" {
		return b.Artifact.Path
	}
	return string(p)
}

// installUpstream downloads the executable from the publisher's site, checks its size and sha256 against the signed
// channel, and puts it read-only into the version directory, the same layout an unpacked artifact has.
func (m *Manager) installUpstream(ctx context.Context, p Provider, b release.ClientBundle, src, provDir, final string, v *Version) (*Version, error) {
	name, err := clientbundle.CleanName(executableName(p, b))
	if err != nil || name == "" || strings.Contains(name, "/") {
		return nil, fmt.Errorf("bad executable path %q", executableName(p, b))
	}
	incoming := filepath.Join(provDir, ".incoming-"+b.Version)
	if err := clientbundle.ForceRemove(incoming); err != nil {
		return nil, err
	}
	if err := os.Mkdir(incoming, 0o755); err != nil {
		return nil, err
	}
	// Straight into the version's own folder: staging can be on another file system than the clients' root.
	// Download: 0-95 %, check and place: 95-100 %.
	if err := m.fetchUpstream(ctx, p, src, b.Executable.Size, b.Executable.SHA256, filepath.Join(incoming, name)); err != nil {
		_ = clientbundle.ForceRemove(incoming)
		return nil, err
	}
	if err := os.Chmod(filepath.Join(incoming, name), 0o755); err != nil {
		_ = clientbundle.ForceRemove(incoming)
		return nil, err
	}
	if err := clientbundle.CheckExecutable(incoming, name, b.Executable.Size, b.Executable.SHA256); err != nil {
		_ = clientbundle.ForceRemove(incoming)
		return nil, digestErr("%v", err)
	}
	if err := clientbundle.ReadOnly(incoming); err != nil {
		_ = clientbundle.ForceRemove(incoming)
		return nil, err
	}
	if err := os.Rename(incoming, final); err != nil {
		_ = clientbundle.ForceRemove(incoming)
		return nil, err
	}
	_ = atomicfile.SyncDir(provDir)
	m.setProgress(p, 100)
	v.InstalledAt = m.now()
	m.Log.Debug("clients: installed from the publisher", "provider", p, "version", b.Version, "from", src)
	return v, nil
}

// fetchUpstream streams the executable into staging while hashing, never past its signed size, and checks it.
func (m *Manager) fetchUpstream(ctx context.Context, p Provider, src string, size int64, sha string, dst string) error {
	_ = os.Remove(dst)
	if m.Upstream == nil {
		return errors.New("download: no way to reach the publisher's site")
	}
	rc, err := m.Upstream.Get(ctx, src)
	if err != nil {
		return fmt.Errorf("download from %s: %w", hostOf(src), err)
	}
	defer rc.Close()
	f, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return err
	}
	h := sha256.New()
	pw := &progressWriter{total: size, report: func(done int64) { m.setProgress(p, 95*done/max(size, 1)) }}
	n, cerr := io.Copy(io.MultiWriter(f, h, pw), io.LimitReader(rc, size+1))
	serr := f.Sync()
	f.Close()
	if cerr != nil {
		if errors.Is(cerr, syscall.ENOSPC) {
			return fmt.Errorf("not enough space to download %s", hostOf(src))
		}
		return fmt.Errorf("download from %s: %w", hostOf(src), cerr)
	}
	if serr != nil {
		return serr
	}
	if got := hex.EncodeToString(h.Sum(nil)); n != size || got != sha {
		return digestErr("%s gave %d bytes sha256 %s, the channel says %d bytes %s", hostOf(src), n, got, size, sha)
	}
	return nil
}

func hostOf(raw string) string {
	if u, err := url.Parse(raw); err == nil && u.Host != "" {
		return u.Host
	}
	return "the publisher's site"
}

// HTTPUpstream gets files over HTTPS; redirects must stay on HTTPS.
type HTTPUpstream struct{ Client *http.Client }

// NewHTTPUpstream is the manager's client for publishers' sites: bounded waits to connect and for an answer, none
// for the body (a client is a few hundred MB; the install's context ends it).
func NewHTTPUpstream() HTTPUpstream {
	tr := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout:   30 * time.Second,
		ResponseHeaderTimeout: time.Minute,
		IdleConnTimeout:       time.Minute,
		ForceAttemptHTTP2:     true,
	}
	return HTTPUpstream{Client: &http.Client{Transport: tr, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if req.URL.Scheme != "https" {
			return errors.New("a redirect away from HTTPS")
		}
		if len(via) >= 5 {
			return errors.New("too many redirects")
		}
		return nil
	}}}
}

// Get answers the body of a 200 response.
func (u HTTPUpstream) Get(ctx context.Context, src string) (io.ReadCloser, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, src, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "whombat-manager")
	resp, err := u.Client.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return resp.Body, nil
}
