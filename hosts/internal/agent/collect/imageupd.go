package collect

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

// Image update checks: for each running container whose image reference
// has a tag on a registry, the agent asks the registry for the tag's
// current manifest digest (an anonymous HEAD request: no pull, and HEAD
// does not count against Docker Hub's pull limit) and compares it with
// the digests the local image was pulled under (RepoDigests).
const (
	imageCheckEvery   = 12 * time.Hour   // per image
	imageCheckTimeout = 10 * time.Second // per image, token included
	imageMaxPerRun    = 50
	imageRunTimeout   = imageMaxPerRun*imageCheckTimeout + time.Minute
)

// manifestAccept lists the manifest types a tag may point to; asking for
// all of them makes the registry answer with the digest docker stored.
var manifestAccept = strings.Join([]string{
	"application/vnd.oci.image.index.v1+json",
	"application/vnd.docker.distribution.manifest.list.v2+json",
	"application/vnd.docker.distribution.manifest.v2+json",
	"application/vnd.oci.image.manifest.v1+json",
}, ", ")

// imageUpdater runs the checks (sub "image_updates", sequentially, at most
// imageMaxPerRun per run) and keeps the results for the Docker collector.
type imageUpdater struct {
	toggle toggleFn
	c      *collector
	client *http.Client
	// localDigests returns the RepoDigests of a local image (tests replace it).
	localDigests func(ctx context.Context, imageID string) ([]string, error)

	mu      sync.Mutex
	checked map[string]imageCheck // by imageCand.key()
}

type imageCheck struct {
	at     time.Time
	update *bool
}

func newImageUpdater(toggle toggleFn, c *collector) *imageUpdater {
	u := &imageUpdater{toggle: toggle, c: c, checked: map[string]imageCheck{}}
	u.client = &http.Client{
		Timeout: imageCheckTimeout,
		Transport: &http.Transport{
			Proxy:               http.ProxyFromEnvironment,
			DialContext:         (&net.Dialer{Timeout: 5 * time.Second}).DialContext,
			TLSClientConfig:     &tls.Config{MinVersion: tls.VersionTLS12},
			TLSHandshakeTimeout: 5 * time.Second,
			MaxIdleConns:        4,
			IdleConnTimeout:     30 * time.Second,
		},
	}
	u.localDigests = u.dockerRepoDigests
	return u
}

// results returns the latest result per image (nil = unknown).
func (u *imageUpdater) results() map[string]*bool {
	if u == nil {
		return nil
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	out := make(map[string]*bool, len(u.checked))
	for k, v := range u.checked {
		out[k] = copyPtr(v.update)
	}
	return out
}

func (u *imageUpdater) run(ctx context.Context) error {
	d := u.c.docker
	enabled, detected := d.enabled()
	on := enabled && detected && u.toggle.enabled(true)
	u.c.imagesSub.setAbsent(!on)
	if !on {
		u.mu.Lock()
		u.checked = map[string]imageCheck{}
		u.mu.Unlock()
		return nil
	}
	cands := d.runningImages()
	now := time.Now()
	present := map[string]bool{}
	var due []imageCand
	u.mu.Lock()
	for _, cand := range cands {
		k := cand.key()
		if present[k] {
			continue
		}
		present[k] = true
		if c, ok := u.checked[k]; !ok || now.Sub(c.at) >= imageCheckEvery {
			due = append(due, cand)
		}
	}
	for k := range u.checked {
		if !present[k] {
			delete(u.checked, k)
		}
	}
	sort.SliceStable(due, func(i, j int) bool { return u.checked[due[i].key()].at.Before(u.checked[due[j].key()].at) })
	u.mu.Unlock()
	if len(due) > imageMaxPerRun {
		due = due[:imageMaxPerRun]
	}

	var errs []string
	asked := 0
	for _, cand := range due {
		if ctx.Err() != nil {
			break
		}
		cctx, cancel := context.WithTimeout(ctx, imageCheckTimeout)
		update, remote, err := u.check(cctx, cand)
		cancel()
		if remote {
			asked++
		}
		if err != nil {
			errs = append(errs, cand.Ref+": "+err.Error())
		}
		u.mu.Lock()
		u.checked[cand.key()] = imageCheck{at: time.Now(), update: update}
		u.mu.Unlock()
	}
	if len(errs) == 0 {
		return nil
	}
	msg := fmt.Sprintf("%d of %d registry checks failed: %s", len(errs), asked, strings.Join(errs[:min(len(errs), 3)], "; "))
	if len(errs) >= asked {
		return errors.New(msg) // no registry answered: offline, DNS, proxy
	}
	return partial(msg)
}

// check compares one image with its registry. remote reports whether a
// registry was asked (images without a tag or a pull digest are skipped
// without one). A private image (the registry wants credentials) or a
// registry error leaves the result unknown.
func (u *imageUpdater) check(ctx context.Context, cand imageCand) (update *bool, remote bool, err error) {
	ref, ok := parseImageRef(cand.Ref)
	if !ok {
		return nil, false, nil
	}
	digests, err := u.localDigests(ctx, cand.ImageID)
	if err != nil {
		return nil, false, err
	}
	var local []string
	for _, rd := range digests {
		name, dg, ok := strings.Cut(rd, "@")
		if !ok {
			continue
		}
		if r, ok := parseImageRef(name); ok && r.Registry == ref.Registry && r.Repo == ref.Repo {
			local = append(local, dg)
		}
	}
	if len(local) == 0 {
		return nil, false, nil // built locally or loaded from a file: nothing to compare
	}
	dg, err := u.remoteDigest(ctx, ref)
	if errors.Is(err, errRegistryAuth) {
		return nil, true, nil // private repository
	}
	if err != nil {
		return nil, true, err
	}
	for _, l := range local {
		if l == dg {
			return ptr(false), true, nil
		}
	}
	return ptr(true), true, nil
}

// dockerRepoDigests reads RepoDigests from /images/<id>/json.
func (u *imageUpdater) dockerRepoDigests(ctx context.Context, imageID string) ([]string, error) {
	var img struct {
		RepoDigests []string `json:"RepoDigests"`
	}
	if err := u.c.docker.get(ctx, "/images/"+url.PathEscape(imageID)+"/json", &img); err != nil {
		return nil, err
	}
	return img.RepoDigests, nil
}

// imageRef is a normalized image reference.
type imageRef struct {
	Registry string // API host: "registry-1.docker.io", "ghcr.io", "registry.lan:5000"
	Repo     string // "library/nginx", "org/app"
	Tag      string
}

// parseImageRef normalizes "nginx", "nginx:1.27", "ghcr.io/org/app:v1",
// "docker.io/library/redis:7", "localhost:5000/app". Digest-pinned
// references and image ids are not checkable (ok false).
func parseImageRef(s string) (imageRef, bool) {
	s = strings.TrimSpace(s)
	if s == "" || strings.Contains(s, "@") || strings.HasPrefix(s, "sha256:") || isHex64(s) {
		return imageRef{}, false
	}
	var r imageRef
	first, rest, hasSlash := strings.Cut(s, "/")
	if hasSlash && (strings.ContainsAny(first, ".:") || first == "localhost") {
		r.Registry = first
	} else {
		r.Registry = "docker.io"
		rest = s
	}
	// The tag follows the last ':' after the last '/'.
	if i := strings.LastIndex(rest, ":"); i > strings.LastIndex(rest, "/") {
		r.Repo, r.Tag = rest[:i], rest[i+1:]
	} else {
		r.Repo, r.Tag = rest, "latest"
	}
	switch r.Registry {
	case "docker.io", "index.docker.io", "registry-1.docker.io", "registry.hub.docker.com":
		r.Registry = "registry-1.docker.io"
		if !strings.Contains(r.Repo, "/") {
			r.Repo = "library/" + r.Repo
		}
	}
	if r.Repo == "" || r.Tag == "" {
		return imageRef{}, false
	}
	return r, true
}

func isHex64(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		if !strings.ContainsRune("0123456789abcdef", c) {
			return false
		}
	}
	return true
}

// errRegistryAuth: the registry wants credentials (or refuses anonymous
// access to this repository).
var errRegistryAuth = errors.New("registry requires authentication")

// registryBase is the URL scheme and host for a registry (tests point it
// at an httptest server).
var registryBase = func(registry string) string { return "https://" + registry }

// remoteDigest HEADs the tag's manifest and returns Docker-Content-Digest.
// A 401 with a Bearer challenge is answered with an anonymous token from
// the challenge's realm (Docker Hub, ghcr.io, quay.io, lscr.io, GitLab and
// any registry implementing the token flow).
func (u *imageUpdater) remoteDigest(ctx context.Context, ref imageRef) (string, error) {
	manifest := registryBase(ref.Registry) + "/v2/" + ref.Repo + "/manifests/" + url.PathEscape(ref.Tag)
	resp, err := u.head(ctx, manifest, "")
	if err != nil {
		return "", err
	}
	if resp.StatusCode == http.StatusUnauthorized {
		ch := resp.Header.Get("WWW-Authenticate")
		scheme, params := parseChallenge(ch)
		if !strings.EqualFold(scheme, "bearer") || params["realm"] == "" {
			return "", errRegistryAuth
		}
		tok, err := u.token(ctx, params, ref.Repo)
		if err != nil {
			return "", err
		}
		if resp, err = u.head(ctx, manifest, tok); err != nil {
			return "", err
		}
	}
	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusUnauthorized, http.StatusForbidden:
		return "", errRegistryAuth
	case http.StatusNotFound:
		return "", fmt.Errorf("tag not found on %s", ref.Registry)
	case http.StatusTooManyRequests:
		return "", fmt.Errorf("%s: rate limited", ref.Registry)
	default:
		return "", fmt.Errorf("%s: %s", ref.Registry, resp.Status)
	}
	dg := resp.Header.Get("Docker-Content-Digest")
	if !strings.HasPrefix(dg, "sha256:") {
		return "", fmt.Errorf("%s did not return a manifest digest", ref.Registry)
	}
	return dg, nil
}

func (u *imageUpdater) head(ctx context.Context, rawURL, token string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", manifestAccept)
	req.Header.Set("User-Agent", "whombat-agent")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := u.client.Do(req)
	if err != nil {
		return nil, err
	}
	io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	resp.Body.Close()
	return resp, nil
}

// token fetches an anonymous pull token from the challenge's realm.
func (u *imageUpdater) token(ctx context.Context, ch map[string]string, repo string) (string, error) {
	realm, err := url.Parse(ch["realm"])
	if err != nil || (realm.Scheme != "https" && realm.Scheme != "http") {
		return "", fmt.Errorf("bad token realm %q", ch["realm"])
	}
	q := realm.Query()
	if s := ch["service"]; s != "" {
		q.Set("service", s)
	}
	scope := ch["scope"]
	if scope == "" {
		scope = "repository:" + repo + ":pull"
	}
	q.Set("scope", scope)
	realm.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, realm.String(), nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "whombat-agent")
	resp, err := u.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return "", errRegistryAuth
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("token: %s", resp.Status)
	}
	var t struct {
		Token       string `json:"token"`
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&t); err != nil {
		return "", fmt.Errorf("token: %w", err)
	}
	if t.Token == "" {
		t.Token = t.AccessToken
	}
	if t.Token == "" {
		return "", errRegistryAuth
	}
	return t.Token, nil
}

// parseChallenge parses a WWW-Authenticate header:
// `Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"`.
func parseChallenge(h string) (scheme string, params map[string]string) {
	params = map[string]string{}
	scheme, rest, _ := strings.Cut(strings.TrimSpace(h), " ")
	for rest != "" {
		rest = strings.TrimLeft(rest, " ,")
		k, v, ok := strings.Cut(rest, "=")
		if !ok {
			break
		}
		k = strings.ToLower(strings.TrimSpace(k))
		if strings.HasPrefix(v, `"`) {
			end := strings.Index(v[1:], `"`)
			if end < 0 {
				params[k] = v[1:]
				break
			}
			params[k] = v[1 : end+1]
			rest = v[end+2:]
		} else {
			val, r, _ := strings.Cut(v, ",")
			params[k] = strings.TrimSpace(val)
			rest = r
		}
	}
	return scheme, params
}
