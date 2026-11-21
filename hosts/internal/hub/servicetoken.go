package hub

import (
	"crypto/subtle"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"syscall"
	"unicode"
	"unicode/utf8"

	"rackoon/internal/hub/store"
)

// The service token (docs/WHOMBAT.md "Authentication"): the Whombat server
// authenticates with one bearer token from --service-token-file and names
// the person it acts for in X-Whombat-Actor. It is an admin principal
// without a user row; X-Whombat-Role lowers the role for one request.

// ServiceTokenPrefix starts every generated service token.
const ServiceTokenPrefix = "wbh_"

// Request headers of the service principal.
const (
	HeaderActor    = "X-Whombat-Actor"     // "<id>|<display name>"
	HeaderRole     = "X-Whombat-Role"      // viewer | operator | admin (default admin)
	HeaderClientIP = "X-Whombat-Client-IP" // the person's address, for the audit log
)

// serviceToken holds the hash of the token in the file and notices when
// the file changes (rotation: write a new token into the file; the hub
// reads it within a few seconds and ends consoles opened with the old one).
type serviceToken struct {
	path string
	log  *slog.Logger

	mu     sync.RWMutex
	hash   []byte // nil: no valid token (the file went missing or is unusable)
	stamp  fileStamp
	broken bool // the last read failed (logged once)
}

type fileStamp struct {
	size  int64
	mod   int64 // unix ns
	inode uint64
}

func stampOf(fi os.FileInfo) fileStamp {
	st := fileStamp{size: fi.Size(), mod: fi.ModTime().UnixNano()}
	if sys, ok := fi.Sys().(*syscall.Stat_t); ok {
		st.inode = sys.Ino
	}
	return st
}

// loadServiceToken reads the token file, creating it with a new random
// token (mode 0640) when it does not exist.
func loadServiceToken(path string, log *slog.Logger) (*serviceToken, error) {
	s := &serviceToken{path: path, log: log}
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		if err := createServiceToken(path); err != nil {
			return nil, fmt.Errorf("--service-token-file: %w", err)
		}
		log.Info("service token created", "file", path)
	}
	hash, stamp, err := readServiceToken(path)
	if err != nil {
		return nil, fmt.Errorf("--service-token-file: %w", err)
	}
	s.hash, s.stamp = hash, stamp
	return s, nil
}

func createServiceToken(path string) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o640)
	if err != nil {
		return err
	}
	_, werr := f.WriteString(ServiceTokenPrefix + randToken(32) + "\n")
	cerr := f.Close()
	if werr == nil {
		werr = cerr
	}
	if werr == nil {
		werr = os.Chmod(path, 0o640) // the umask may have taken the group bit
	}
	if werr != nil {
		os.Remove(path)
	}
	return werr
}

func readServiceToken(path string) ([]byte, fileStamp, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fileStamp{}, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return nil, fileStamp{}, err
	}
	if !fi.Mode().IsRegular() || fi.Size() > 4096 {
		return nil, fileStamp{}, errors.New(path + " is not a token file")
	}
	b := make([]byte, fi.Size())
	if _, err := f.ReadAt(b, 0); err != nil && fi.Size() > 0 {
		return nil, fileStamp{}, err
	}
	tok := strings.TrimSpace(string(b))
	if len(tok) < 32 || strings.IndexFunc(tok, unicode.IsSpace) >= 0 || !isPrintableASCII(tok) {
		return nil, fileStamp{}, errors.New(path + " must hold one token of at least 32 characters")
	}
	return sha(tok), stampOf(fi), nil
}

func isPrintableASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < 0x21 || s[i] > 0x7e {
			return false
		}
	}
	return true
}

// refresh re-reads the file when it changed (called every few seconds).
func (s *serviceToken) refresh() {
	fi, err := os.Stat(s.path)
	s.mu.RLock()
	same := err == nil && stampOf(fi) == s.stamp && s.hash != nil
	s.mu.RUnlock()
	if same {
		return
	}
	hash, stamp, err := readServiceToken(s.path)
	s.mu.Lock()
	defer s.mu.Unlock()
	if err != nil {
		if !s.broken {
			s.log.Warn("service token unusable: the Whombat server is refused until the file holds a token again", "file", s.path, "err", err)
		}
		s.hash, s.stamp, s.broken = nil, fileStamp{}, true
		return
	}
	if s.broken || subtle.ConstantTimeCompare(hash, s.hash) != 1 {
		s.log.Info("service token changed", "file", s.path)
	}
	s.hash, s.stamp, s.broken = hash, stamp, false
}

// match returns the token's hash when secret is the current token.
func (s *serviceToken) match(secret string) []byte {
	h := sha(secret)
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.hash == nil || subtle.ConstantTimeCompare(h, s.hash) != 1 {
		return nil
	}
	return s.hash
}

// current reports whether hash is still the current token's.
func (s *serviceToken) current(hash []byte) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.hash != nil && subtle.ConstantTimeCompare(hash, s.hash) == 1
}

// serviceActor is the person (or Whombat itself) a service request acts
// for.
type serviceActor struct {
	id   string // Whombat's id of the person or agent
	name string // display name ("" when not given)
}

// auditName is how the actor appears as the hub's user name: in the audit
// log, acknowledgements and created_by fields: "<display name> (<id>)".
func (a *serviceActor) auditName() string {
	if a.name == "" {
		return a.id
	}
	return a.name + " (" + a.id + ")"
}

// actorUserID maps an actor id to a stable negative user id (real users are
// positive), which keys the per-person console and event-stream limits.
func actorUserID(id string) int64 {
	var h uint64 = 14695981039346656037 // FNV-1a
	for i := 0; i < len(id); i++ {
		h ^= uint64(id[i])
		h *= 1099511628211
	}
	return -int64(h>>1) - 1
}

// DefaultActor is the actor of service requests without X-Whombat-Actor.
const DefaultActor = "whombat|Whombat"

// parseActor reads X-Whombat-Actor: "<id>|<display name>" (the name is
// optional). The id is 1 to 128 of letters, digits and . _ : @ -; the name
// keeps printable characters, at most 128 bytes.
func parseActor(v string) (*serviceActor, error) {
	if strings.TrimSpace(v) == "" {
		v = DefaultActor
	}
	id, name, _ := strings.Cut(v, "|")
	id = strings.TrimSpace(id)
	if id == "" || len(id) > 128 || strings.IndexFunc(id, func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("._:@-", r))
	}) >= 0 {
		return nil, apiErr(http.StatusBadRequest, "bad_actor", HeaderActor+" must be \"<id>|<display name>\"; the id is letters, digits and . _ : @ -.")
	}
	name = strings.Join(strings.Fields(strings.ReplaceAll(cleanText(name, 256), "|", " ")), " ")
	for len(name) > 128 || !utf8.ValidString(name) {
		name = strings.TrimSpace(name[:len(name)-1])
	}
	return &serviceActor{id: id, name: name}, nil
}

// authenticateService resolves the service token: nil without one (or
// when another bearer token is sent), an error for bad X-Whombat-* headers.
func (h *Hub) authenticateService(r *http.Request) (*principal, *apiError) {
	if h.svc == nil {
		return nil, nil
	}
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return nil, nil
	}
	secret := strings.TrimSpace(strings.TrimPrefix(auth, "Bearer "))
	if len(secret) > 512 {
		return nil, nil
	}
	hash := h.svc.match(secret)
	if hash == nil {
		return nil, nil
	}
	actor, err := parseActor(r.Header.Get(HeaderActor))
	if err != nil {
		var ae *apiError
		errors.As(err, &ae)
		return nil, ae
	}
	role := store.RoleAdmin
	switch v := strings.TrimSpace(r.Header.Get(HeaderRole)); v {
	case "":
	case store.RoleViewer, store.RoleOperator, store.RoleAdmin:
		role = v
	default:
		return nil, apiErr(http.StatusBadRequest, "bad_role", HeaderRole+" must be viewer, operator or admin.")
	}
	u := store.User{ID: actorUserID(actor.id), Username: actor.auditName(), Role: role}
	return &principal{user: u, tokenHsh: hash, service: actor}, nil
}

// applyClientIP makes X-Whombat-Client-IP the request's client address for
// a service request (audit log, per-address limits), and drops forwarding
// headers: the Whombat server is the only proxy.
func applyClientIP(r *http.Request) {
	r.Header.Del("X-Forwarded-For")
	r.Header.Del("X-Forwarded-Proto")
	switch ip := net.ParseIP(strings.TrimSpace(r.Header.Get(HeaderClientIP))); {
	case ip != nil:
		r.RemoteAddr = net.JoinHostPort(ip.String(), "0")
	case overUnixSocket(r):
		r.RemoteAddr = "" // "@": no address to record
	}
}
