// Package fakegithub is a local stand-in for the parts of GitHub the update channels use (Whombat LNK-24), for
// tests: release downloads that answer 302 to another host whose storage honours Range (as GitHub's does), the REST
// calls the publisher makes (releases by tag, list, create and delete releases and tags, list, upload and delete assets) and a static Pages
// tree. It keeps everything in memory except the Pages tree, which is a directory.
package fakegithub

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// MaxAssetsPerRelease is GitHub's limit of assets in one release.
const MaxAssetsPerRelease = 1000

// Asset is an uploaded release asset.
type Asset struct {
	ID    int64  `json:"id"`
	Name  string `json:"name"`
	Size  int64  `json:"size"`
	State string `json:"state"`
	// Digest is "sha256:<hex>" of the stored bytes, as GitHub reports it.
	Digest string `json:"digest"`
	data   []byte
}

func newAsset(id int64, name string, data []byte) *Asset {
	sum := sha256.Sum256(data)
	return &Asset{ID: id, Name: name, Size: int64(len(data)), State: "uploaded", Digest: "sha256:" + hex.EncodeToString(sum[:]), data: data}
}

// Release is a GitHub release.
type Release struct {
	ID         int64  `json:"id"`
	TagName    string `json:"tag_name"`
	Name       string `json:"name"`
	Prerelease bool   `json:"prerelease"`
	UploadURL  string `json:"upload_url"`
	assets     []*Asset
}

// GitHub is the fake. GitHubURL is the web host (release downloads, /<owner>/<repo>/releases/download/<tag>/<name>),
// APIURL the REST API, StorageURL the other host the downloads redirect to, PagesURL the Pages site.
type GitHub struct {
	Owner, Repo string
	Token       string

	GitHubURL, APIURL, StorageURL, PagesURL string

	// PagesDir is what the Pages site serves (a test deploys into it).
	PagesDir string

	mu       sync.Mutex
	releases []*Release
	// tags are the git tags: GitHub makes one with a release and keeps it when the release is deleted.
	tags   map[string]bool
	nextID int64
	// Downloads counts download requests per asset name; RangeRequests those with a Range header (at the storage).
	Downloads     map[string]int
	RangeRequests int
	// APICalls counts REST calls by "METHOD path-shape".
	APICalls map[string]int
	// FailNext makes the next storage response for an asset name stop after so many bytes (an interrupted download).
	FailNext map[string]int

	web, api, storage, pages *httptest.Server
}

// New starts the fake's servers. Close them with Close.
func New(owner, repo, token, pagesDir string) *GitHub {
	g := &GitHub{Owner: owner, Repo: repo, Token: token, PagesDir: pagesDir, nextID: 100,
		Downloads: map[string]int{}, APICalls: map[string]int{}, FailNext: map[string]int{}, tags: map[string]bool{}}
	g.storage = httptest.NewServer(http.HandlerFunc(g.serveStorage))
	g.web = httptest.NewServer(http.HandlerFunc(g.serveWeb))
	g.api = httptest.NewServer(http.HandlerFunc(g.serveAPI))
	g.pages = httptest.NewServer(http.FileServer(http.Dir(pagesDir)))
	g.GitHubURL, g.APIURL, g.StorageURL, g.PagesURL = g.web.URL, g.api.URL, g.storage.URL, g.pages.URL
	return g
}

// Close stops the servers.
func (g *GitHub) Close() {
	for _, s := range []*httptest.Server{g.web, g.api, g.storage, g.pages} {
		s.Close()
	}
}

// DownloadBase is the targets base a box uses: <web>/<owner>/<repo>/releases/download/.
func (g *GitHub) DownloadBase() string {
	return g.GitHubURL + "/" + g.Owner + "/" + g.Repo + "/releases/download/"
}

// Release returns a release by tag (nil if none).
func (g *GitHub) Release(tag string) *Release {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.byTag(tag)
}

// AssetNames lists a release's asset names.
func (g *GitHub) AssetNames(tag string) []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	r := g.byTag(tag)
	if r == nil {
		return nil
	}
	var out []string
	for _, a := range r.assets {
		out = append(out, a.Name)
	}
	sort.Strings(out)
	return out
}

// Tags lists the releases' tags.
func (g *GitHub) Tags() []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	var out []string
	for _, r := range g.releases {
		out = append(out, r.TagName)
	}
	sort.Strings(out)
	return out
}

// GitTags lists the git tags (a deleted release's stays until its ref is deleted).
func (g *GitHub) GitTags() []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	var out []string
	for t := range g.tags {
		out = append(out, t)
	}
	sort.Strings(out)
	return out
}

// PutAsset adds an asset directly (a test's starting state).
func (g *GitHub) PutAsset(tag, name string, data []byte) {
	g.mu.Lock()
	defer g.mu.Unlock()
	r := g.byTag(tag)
	if r == nil {
		r = g.create(tag, false)
	}
	g.nextID++
	r.assets = append(r.assets, newAsset(g.nextID, name, data))
}

func (g *GitHub) byTag(tag string) *Release {
	for _, r := range g.releases {
		if r.TagName == tag {
			return r
		}
	}
	return nil
}

func (g *GitHub) create(tag string, pre bool) *Release {
	g.nextID++
	r := &Release{ID: g.nextID, TagName: tag, Name: tag, Prerelease: pre}
	r.UploadURL = fmt.Sprintf("%s/uploads/repos/%s/%s/releases/%d/assets{?name,label}", g.APIURL, g.Owner, g.Repo, r.ID)
	g.releases = append(g.releases, r)
	g.tags[tag] = true
	return r
}

func (g *GitHub) asset(id int64) (*Release, int, *Asset) {
	for _, r := range g.releases {
		for i, a := range r.assets {
			if a.ID == id {
				return r, i, a
			}
		}
	}
	return nil, 0, nil
}

// serveWeb answers release downloads with a redirect to the storage host, as github.com does.
func (g *GitHub) serveWeb(w http.ResponseWriter, req *http.Request) {
	prefix := "/" + g.Owner + "/" + g.Repo + "/releases/download/"
	rest, ok := strings.CutPrefix(req.URL.Path, prefix)
	tag, name, ok2 := strings.Cut(rest, "/")
	if !ok || !ok2 || strings.Contains(name, "/") || req.Method != http.MethodGet {
		http.NotFound(w, req)
		return
	}
	g.mu.Lock()
	r := g.byTag(tag)
	var a *Asset
	if r != nil {
		for _, x := range r.assets {
			if x.Name == name {
				a = x
			}
		}
	}
	g.Downloads[name]++
	g.mu.Unlock()
	if a == nil {
		http.NotFound(w, req)
		return
	}
	http.Redirect(w, req, fmt.Sprintf("%s/objects/%d?sig=fake", g.StorageURL, a.ID), http.StatusFound)
}

// serveStorage serves asset bytes with Range (http.ServeContent).
func (g *GitHub) serveStorage(w http.ResponseWriter, req *http.Request) {
	id, err := strconv.ParseInt(strings.TrimPrefix(req.URL.Path, "/objects/"), 10, 64)
	if err != nil || req.URL.Query().Get("sig") == "" {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	g.mu.Lock()
	_, _, a := g.asset(id)
	if req.Header.Get("Range") != "" {
		g.RangeRequests++
	}
	var cut int
	var cutting bool
	if a != nil {
		cut, cutting = g.FailNext[a.Name]
		delete(g.FailNext, a.Name)
	}
	g.mu.Unlock()
	if a == nil {
		http.NotFound(w, req)
		return
	}
	if cutting {
		// An interrupted transfer: the length promised, fewer bytes sent, then the connection closes.
		w.Header().Set("Content-Length", strconv.Itoa(len(a.data)))
		w.WriteHeader(http.StatusOK)
		w.Write(a.data[:min(cut, len(a.data))])
		if hj, ok := w.(http.Hijacker); ok {
			if c, _, err := hj.Hijack(); err == nil {
				c.Close()
			}
		}
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	http.ServeContent(w, req, a.Name, time.Time{}, bytes.NewReader(a.data))
}

func (g *GitHub) count(method, shape string) {
	g.mu.Lock()
	g.APICalls[method+" "+shape]++
	g.mu.Unlock()
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func (g *GitHub) releaseJSON(r *Release) map[string]any {
	assets := []*Asset{}
	assets = append(assets, r.assets...)
	return map[string]any{"id": r.ID, "tag_name": r.TagName, "name": r.Name, "prerelease": r.Prerelease, "upload_url": r.UploadURL,
		"assets": assets}
}

// serveAPI is the REST subset: GET releases/tags/<tag>, GET releases (paged), POST releases, DELETE releases/<id>,
// DELETE git/refs/tags/<tag>, GET releases/<id>/assets, POST uploads/.../releases/<id>/assets?name=, DELETE
// releases/assets/<id>.
func (g *GitHub) serveAPI(w http.ResponseWriter, req *http.Request) {
	if req.Header.Get("Authorization") != "Bearer "+g.Token {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": "Bad credentials"})
		return
	}
	repoPrefix := "/repos/" + g.Owner + "/" + g.Repo + "/"
	p := req.URL.Path
	upload := strings.HasPrefix(p, "/uploads"+repoPrefix)
	rest, ok := strings.CutPrefix(strings.TrimPrefix(p, "/uploads"), repoPrefix)
	if !ok {
		http.NotFound(w, req)
		return
	}
	parts := strings.Split(rest, "/")
	switch {
	case req.Method == http.MethodGet && len(parts) == 3 && parts[0] == "releases" && parts[1] == "tags":
		g.count("GET", "releases/tags")
		g.mu.Lock()
		r := g.byTag(parts[2])
		var out map[string]any
		if r != nil {
			out = g.releaseJSON(r)
		}
		g.mu.Unlock()
		if r == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"message": "Not Found"})
			return
		}
		writeJSON(w, http.StatusOK, out)
	case req.Method == http.MethodGet && len(parts) == 1 && parts[0] == "releases":
		g.count("GET", "releases")
		perPage, _ := strconv.Atoi(req.URL.Query().Get("per_page"))
		if perPage <= 0 || perPage > 100 {
			perPage = 30
		}
		page, _ := strconv.Atoi(req.URL.Query().Get("page"))
		if page <= 0 {
			page = 1
		}
		g.mu.Lock()
		lo := min((page-1)*perPage, len(g.releases))
		hi := min(lo+perPage, len(g.releases))
		out := []map[string]any{}
		for _, r := range g.releases[lo:hi] {
			out = append(out, g.releaseJSON(r))
		}
		g.mu.Unlock()
		writeJSON(w, http.StatusOK, out)
	case req.Method == http.MethodDelete && len(parts) == 2 && parts[0] == "releases" && parts[1] != "assets":
		g.count("DELETE", "releases")
		id, _ := strconv.ParseInt(parts[1], 10, 64)
		g.mu.Lock()
		found := false
		for i, r := range g.releases {
			if r.ID == id {
				g.releases = append(g.releases[:i], g.releases[i+1:]...)
				found = true
				break
			}
		}
		g.mu.Unlock()
		if !found {
			writeJSON(w, http.StatusNotFound, map[string]string{"message": "Not Found"})
			return
		}
		w.WriteHeader(http.StatusNoContent)
	case req.Method == http.MethodDelete && len(parts) == 4 && parts[0] == "git" && parts[1] == "refs" && parts[2] == "tags":
		g.count("DELETE", "git/refs/tags")
		g.mu.Lock()
		had := g.tags[parts[3]]
		delete(g.tags, parts[3])
		g.mu.Unlock()
		if !had {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"message": "Reference does not exist"})
			return
		}
		w.WriteHeader(http.StatusNoContent)
	case req.Method == http.MethodPost && len(parts) == 1 && parts[0] == "releases" && !upload:
		g.count("POST", "releases")
		var body struct {
			TagName    string `json:"tag_name"`
			Prerelease bool   `json:"prerelease"`
		}
		if json.NewDecoder(req.Body).Decode(&body) != nil || body.TagName == "" {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"message": "Validation Failed"})
			return
		}
		g.mu.Lock()
		if g.byTag(body.TagName) != nil {
			g.mu.Unlock()
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"message": "Validation Failed: already_exists"})
			return
		}
		r := g.create(body.TagName, body.Prerelease)
		out := g.releaseJSON(r)
		g.mu.Unlock()
		writeJSON(w, http.StatusCreated, out)
	case req.Method == http.MethodGet && len(parts) == 3 && parts[0] == "releases" && parts[2] == "assets":
		g.count("GET", "releases/assets")
		id, _ := strconv.ParseInt(parts[1], 10, 64)
		perPage, _ := strconv.Atoi(req.URL.Query().Get("per_page"))
		if perPage <= 0 || perPage > 100 {
			perPage = 30
		}
		page, _ := strconv.Atoi(req.URL.Query().Get("page"))
		if page <= 0 {
			page = 1
		}
		g.mu.Lock()
		var r *Release
		for _, x := range g.releases {
			if x.ID == id {
				r = x
			}
		}
		var out []*Asset
		if r != nil {
			lo := min((page-1)*perPage, len(r.assets))
			hi := min(lo+perPage, len(r.assets))
			out = append([]*Asset{}, r.assets[lo:hi]...)
		}
		g.mu.Unlock()
		if r == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"message": "Not Found"})
			return
		}
		writeJSON(w, http.StatusOK, out)
	case req.Method == http.MethodPost && upload && len(parts) == 3 && parts[0] == "releases" && parts[2] == "assets":
		g.count("POST", "uploads")
		id, _ := strconv.ParseInt(parts[1], 10, 64)
		name := req.URL.Query().Get("name")
		data, err := io.ReadAll(req.Body)
		if err != nil || name == "" || path.Base(name) != name || req.ContentLength != int64(len(data)) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"message": "Bad upload"})
			return
		}
		g.mu.Lock()
		defer g.mu.Unlock()
		var r *Release
		for _, x := range g.releases {
			if x.ID == id {
				r = x
			}
		}
		if r == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"message": "Not Found"})
			return
		}
		for _, a := range r.assets {
			if a.Name == name {
				writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"message": "Validation Failed: already_exists"})
				return
			}
		}
		if len(r.assets) >= MaxAssetsPerRelease {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"message": "Validation Failed: too many assets"})
			return
		}
		g.nextID++
		a := newAsset(g.nextID, name, data)
		r.assets = append(r.assets, a)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(a)
	case req.Method == http.MethodDelete && len(parts) == 3 && parts[0] == "releases" && parts[1] == "assets":
		g.count("DELETE", "releases/assets")
		id, _ := strconv.ParseInt(parts[2], 10, 64)
		g.mu.Lock()
		r, i, a := g.asset(id)
		if a != nil {
			r.assets = append(r.assets[:i], r.assets[i+1:]...)
		}
		g.mu.Unlock()
		if a == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"message": "Not Found"})
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		http.NotFound(w, req)
	}
}
