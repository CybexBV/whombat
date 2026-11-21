package snap

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	"golang.org/x/sys/unix"

	"github.com/CybexBV/whombat/appliance/backup/pkg/coverage"
)

// Snapshotter is what the checkpoint uses: take every source into filesDir/<name>, release afterwards.
type Snapshotter interface {
	Method() string
	Take(ctx context.Context, id string) ([]Taken, error)
	Release(ctx context.Context, id string) error
}

// Taken is one staged source.
type Taken struct {
	Name    string `json:"name"`
	Source  string `json:"source"`
	Path    string `json:"path"`
	Missing bool   `json:"missing,omitempty"`
}

// Local runs a driver in-process (development, tests, and inside whombat-backup-snapd).
type Local struct {
	Driver   Driver
	Sources  []coverage.Source
	FilesDir string // <staging>/current/files
	mu       sync.Mutex
}

// Method of the driver.
func (l *Local) Method() string { return l.Driver.Method() }

var idRe = regexp.MustCompile(`^[A-Za-z0-9._-]{1,80}$`)

// Take snapshots every source, in order; on failure releases what it took.
func (l *Local) Take(ctx context.Context, id string) ([]Taken, error) {
	if !idRe.MatchString(id) {
		return nil, fmt.Errorf("snapshot id %q", id)
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := os.MkdirAll(l.FilesDir, 0o755); err != nil {
		return nil, err
	}
	var taken []Taken
	for _, s := range l.Sources {
		dst := filepath.Join(l.FilesDir, s.Name)
		_ = l.Driver.Release(ctx, dst) // leftovers of a crashed run
		_, statErr := os.Lstat(s.Path)
		missing := errors.Is(statErr, os.ErrNotExist)
		var err error
		if missing {
			err = os.MkdirAll(dst, 0o700)
		} else {
			err = l.Driver.Create(ctx, s.Path, dst)
		}
		if err != nil {
			for _, t := range taken {
				_ = l.Driver.Release(context.Background(), t.Path)
			}
			return nil, fmt.Errorf("snapshot %s: %w", s.Name, err)
		}
		taken = append(taken, Taken{Name: s.Name, Source: s.Path, Path: dst, Missing: missing})
	}
	return taken, nil
}

// Release removes every staged source.
func (l *Local) Release(ctx context.Context, id string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	var errs []error
	for _, s := range l.Sources {
		dst := filepath.Join(l.FilesDir, s.Name)
		if err := l.Driver.Release(ctx, dst); err != nil {
			errs = append(errs, err)
		}
		_ = os.RemoveAll(dst) // empty placeholders for missing sources
	}
	return errors.Join(errs...)
}

// Server exposes a Local over a unix socket to exactly one peer uid (whombat-backup-snapd). Operations are
// typed: take/release by checkpoint id; sources and destinations come from the server's own config.
type Server struct {
	Local      *Local
	AllowedUID int
	srv        *http.Server
}

type ctxKey struct{}

// Serve listens on socket (mode 0660; the unit's SocketGroup gives the backup user access).
func (s *Server) Serve(l net.Listener) error {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/take", s.take)
	mux.HandleFunc("POST /v1/release", s.release)
	mux.HandleFunc("GET /v1/info", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"driver": s.Local.Driver.Name(), "method": s.Local.Method()})
	})
	s.srv = &http.Server{
		Handler:     s.guard(mux),
		ReadTimeout: 10 * time.Second,
		ConnContext: func(ctx context.Context, c net.Conn) context.Context { return context.WithValue(ctx, ctxKey{}, c) },
	}
	return s.srv.Serve(l)
}

// Close stops the server.
func (s *Server) Close() error {
	if s.srv == nil {
		return nil
	}
	return s.srv.Close()
}

func peerUID(c net.Conn) (int, error) {
	uc, ok := c.(*net.UnixConn)
	if !ok {
		return -1, errors.New("not a unix connection")
	}
	raw, err := uc.SyscallConn()
	if err != nil {
		return -1, err
	}
	var cred *unix.Ucred
	var cerr error
	if err := raw.Control(func(fd uintptr) { cred, cerr = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED) }); err != nil {
		return -1, err
	}
	if cerr != nil {
		return -1, cerr
	}
	return int(cred.Uid), nil
}

func (s *Server) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, _ := r.Context().Value(ctxKey{}).(net.Conn)
		uid, err := peerUID(c)
		if err != nil || uid != s.AllowedUID {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

type opReq struct {
	ID string `json:"id"`
}

func (s *Server) take(w http.ResponseWriter, r *http.Request) {
	var req opReq
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&req); err != nil || !idRe.MatchString(req.ID) {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	taken, err := s.Local.Take(r.Context(), req.ID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"method": s.Local.Method(), "taken": taken})
}

func (s *Server) release(w http.ResponseWriter, r *http.Request) {
	var req opReq
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&req); err != nil || !idRe.MatchString(req.ID) {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if err := s.Local.Release(r.Context(), req.ID); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	_, _ = w.Write([]byte(`{"released":true}`))
}

// Remote is the backup service's client of whombat-backup-snapd.
type Remote struct {
	Socket string
	method string
}

func (r *Remote) client() *http.Client {
	return &http.Client{Timeout: 6 * time.Hour, Transport: &http.Transport{DisableKeepAlives: true,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", r.Socket)
		}}}
}

func (r *Remote) post(ctx context.Context, path, id string, out any) error {
	b, _ := json.Marshal(opReq{ID: id})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://snapd"+path, bytes.NewReader(b))
	if err != nil {
		return err
	}
	resp, err := r.client().Do(req)
	if err != nil {
		return fmt.Errorf("snapshot helper: %w", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("snapshot helper %s: HTTP %d: %s", path, resp.StatusCode, bytes.TrimSpace(data))
	}
	if out != nil {
		return json.Unmarshal(data, out)
	}
	return nil
}

// Method asks the helper which method it uses (cached).
func (r *Remote) Method() string {
	if r.method != "" {
		return r.method
	}
	req, _ := http.NewRequest(http.MethodGet, "http://snapd/v1/info", nil)
	resp, err := r.client().Do(req)
	if err != nil {
		return "unknown"
	}
	defer resp.Body.Close()
	var info struct{ Method string }
	_ = json.NewDecoder(resp.Body).Decode(&info)
	r.method = info.Method
	return r.method
}

// Take asks the helper to snapshot every source.
func (r *Remote) Take(ctx context.Context, id string) ([]Taken, error) {
	var out struct {
		Method string  `json:"method"`
		Taken  []Taken `json:"taken"`
	}
	if err := r.post(ctx, "/v1/take", id, &out); err != nil {
		return nil, err
	}
	r.method = out.Method
	return out.Taken, nil
}

// Release asks the helper to remove the snapshots.
func (r *Remote) Release(ctx context.Context, id string) error {
	return r.post(ctx, "/v1/release", id, nil)
}
