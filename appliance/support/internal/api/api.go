// Package api is the support socket (contracts 0.120.0 `local` SUPPORT_PATHS, CT-938…CT-942; Whombat RH-01…RH-09;
// NX-414): HTTP/1.1 JSON on /run/whombat-support/api.sock, for the runtime server (owners' remote help), the manager
// (the state for status.report) and root.
//
//	GET  /v1/state                       → SupportState
//	POST /v1/grant                       SupportGrantRequest { v:1, level, duration, grantedBy } → SupportState
//	POST /v1/stop                        SupportStopRequest { v:1, reason, by? } → SupportState
//	GET  /v1/visits?before=&limit=       → SupportVisitsAnswer { v:1, visits }   (newest first, limit 1…20, default 20)
//	GET  /v1/visits/{id}/transcript      → text/plain; charset=utf-8, the raw command-line output
//	GET  /v1/events?after=&waitS=        → SupportEventsAnswer { v:1, events, next }  (long poll, waitS 0…25)
//
// Callers by peer uid (SO_PEERCRED): the runtime and root everything; the manager GET /v1/state only, and without the
// help code; anyone else 403 forbidden. Requests are strict (no other member, no other query parameter, v = 1) and at
// most 1 KiB, checked with the contract's generated validators. Errors are LocalError { error: { code, message } }: 400 bad_request (also a wrong path 404 and method
// 405), 413 too_large, 403 forbidden and forever_not_allowed, 404 not_found, 503 unavailable (no support CA pinned, or
// the grant couldn't be saved). The state is answered from memory: the manager asks about every 30 s.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/peercred"
	"github.com/CybexBV/whombat/appliance/support/internal/grant"
	"github.com/CybexBV/whombat/appliance/support/internal/records"
	"github.com/CybexBV/whombat/appliance/support/internal/wire"
	"github.com/CybexBV/whombat/contracts/go/local"
)

// Grant is the owner's grant (grant.Store).
type Grant interface {
	Start(level string, durationS *int64, by wire.Person) (wire.Grant, error)
	Stop(reason string, by *wire.Person) error
	Grant() *wire.Grant
	Environment() string
	ForeverAllowed() bool
	HelpCodeRequired() bool
}

// Records is the record of visits (records.Store).
type Records interface {
	Connected() []wire.Connected
	List(before string, limit int) ([]wire.Visit, error)
	Transcript(id string) (io.ReadCloser, error)
}

// Events is the event log (events.Log).
type Events interface {
	After(ctx context.Context, after int64, wait time.Duration) wire.Events
}

// Server serves the support socket.
type Server struct {
	Grant   Grant
	Records Records
	Events  Events
	// Available: the image pins a support CA (and the SSH server could start); without it grants are refused.
	Available bool
	// HostKey is the SSH host key's public line, `ssh-ed25519 <base64>` (nil before there is one).
	HostKey *string
	// RuntimeUID may use everything, ManagerUID GET /v1/state only (without the help code); root (0) everything.
	RuntimeUID uint32
	ManagerUID uint32
	// Peer gives the caller's uid; peercred's (SO_PEERCRED) unless a test sets it.
	Peer func(*http.Request) (uint32, bool)
}

type role int

const (
	nobody role = iota
	manager
	full
)

type ctxRole struct{}

var visitID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// Handler routes the paths behind the peer check.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc(wire.PathState, method(http.MethodGet, s.state))
	mux.HandleFunc(wire.PathGrant, only(method(http.MethodPost, s.grant)))
	mux.HandleFunc(wire.PathStop, only(method(http.MethodPost, s.stop)))
	mux.HandleFunc(wire.PathVisits, only(method(http.MethodGet, s.visits)))
	mux.HandleFunc(wire.PathTranscript, only(method(http.MethodGet, s.transcript)))
	mux.HandleFunc(wire.PathEvents, only(method(http.MethodGet, s.events)))
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		failStatus(w, http.StatusNotFound, wire.ErrBadRequest, "no such path")
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rl := s.role(r)
		if rl == nobody {
			fail(w, wire.ErrForbidden, "this socket is the runtime's, the manager's and root's")
			return
		}
		mux.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxRole{}, rl)))
	})
}

func (s *Server) role(r *http.Request) role {
	peer := s.Peer
	if peer == nil {
		peer = func(r *http.Request) (uint32, bool) {
			c, ok := peercred.FromContext(r.Context())
			return c.UID, ok
		}
	}
	uid, ok := peer(r)
	switch {
	case !ok:
		return nobody
	case uid == 0 || uid == s.RuntimeUID:
		return full
	case uid == s.ManagerUID:
		return manager
	}
	return nobody
}

// only lets the runtime and root through: the manager reads the state, nothing else.
func only(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if rl, _ := r.Context().Value(ctxRole{}).(role); rl != full {
			fail(w, wire.ErrForbidden, "the manager may read the state only")
			return
		}
		h(w, r)
	}
}

func method(m string, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != m {
			w.Header().Set("Allow", m)
			failStatus(w, http.StatusMethodNotAllowed, wire.ErrBadRequest, m+" only")
			return
		}
		h(w, r)
	}
}

func (s *Server) state(w http.ResponseWriter, r *http.Request) {
	if !noQuery(w, r) {
		return
	}
	st := s.build()
	if rl, _ := r.Context().Value(ctxRole{}).(role); rl != full && st.Grant != nil {
		st.Grant.HelpCode = nil
	}
	reply(w, st)
}

// build is the state, from memory only.
func (s *Server) build() wire.State {
	st := wire.State{V: 1, Available: s.Available, ForeverAllowed: s.Grant.ForeverAllowed(),
		HelpCodeRequired: s.Grant.HelpCodeRequired(), Environment: local.SupportEnvironment(s.Grant.Environment()),
		HostKey: s.HostKey,
		Grant:   s.Grant.Grant(), Connected: []wire.Connected{}}
	// Nobody is connected without a grant: a visit the grant's end is still closing isn't shown.
	if st.Grant != nil {
		st.Connected = s.Records.Connected()
		if len(st.Connected) > wire.ConnectedMax {
			st.Connected = st.Connected[len(st.Connected)-wire.ConnectedMax:]
		}
	}
	return st
}

func (s *Server) grant(w http.ResponseWriter, r *http.Request) {
	body, ok := read(w, r)
	if !ok {
		return
	}
	req, err := local.ParseSupportGrantRequest(body)
	if err != nil {
		fail(w, wire.ErrBadRequest, "not a SupportGrantRequest")
		return
	}
	seconds, ok := wire.DurationSeconds(string(req.Duration))
	if !ok {
		fail(w, wire.ErrBadRequest, "not a SupportGrantRequest")
		return
	}
	if !s.Available {
		fail(w, wire.ErrUnavailable, "this image pins no support CA")
		return
	}
	_, err = s.Grant.Start(string(req.Level), seconds, req.GrantedBy)
	switch {
	case errors.Is(err, grant.ErrForeverNotAllowed):
		fail(w, wire.ErrForeverNotAllowed, "forever is only for test Whombats")
	case errors.Is(err, grant.ErrNotSaved):
		fail(w, wire.ErrUnavailable, "the grant couldn't be saved")
	case err != nil:
		fail(w, wire.ErrBadRequest, "not a SupportGrantRequest")
	default:
		reply(w, s.build())
	}
}

func (s *Server) stop(w http.ResponseWriter, r *http.Request) {
	body, ok := read(w, r)
	if !ok {
		return
	}
	req, err := local.ParseSupportStopRequest(body)
	if err != nil {
		fail(w, wire.ErrBadRequest, "not a SupportStopRequest")
		return
	}
	err = s.Grant.Stop(string(req.Reason), req.By)
	switch {
	case errors.Is(err, grant.ErrNotSaved):
		// Off now; but the file still holds the grant.
		fail(w, wire.ErrUnavailable, "stopped, but the stop couldn't be saved")
	case err != nil:
		fail(w, wire.ErrBadRequest, "not a SupportStopRequest")
	default:
		reply(w, s.build())
	}
}

func (s *Server) visits(w http.ResponseWriter, r *http.Request) {
	q, ok := query(w, r, "before", "limit")
	if !ok {
		return
	}
	before, limit := q["before"], wire.VisitsMax
	if before != "" && !visitID.MatchString(before) {
		fail(w, wire.ErrBadRequest, "before is a visit id")
		return
	}
	if v, set := q["limit"]; set {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > wire.VisitsMax || strconv.Itoa(n) != v {
			fail(w, wire.ErrBadRequest, "limit is 1…20")
			return
		}
		limit = n
	}
	list, err := s.Records.List(before, limit)
	switch {
	case errors.Is(err, records.ErrNotFound):
		list = nil // a visit id the record can't have: nothing is older
	case err != nil:
		fail(w, wire.ErrUnavailable, "the record can't be read")
		return
	}
	if list == nil {
		list = []wire.Visit{}
	}
	reply(w, wire.Visits{V: 1, Visits: list})
}

func (s *Server) transcript(w http.ResponseWriter, r *http.Request) {
	if !noQuery(w, r) {
		return
	}
	id := r.PathValue("id")
	if !visitID.MatchString(id) {
		fail(w, wire.ErrBadRequest, "not a visit id")
		return
	}
	t, err := s.Records.Transcript(id)
	switch {
	case errors.Is(err, records.ErrNotFound):
		fail(w, wire.ErrNotFound, "no such transcript")
		return
	case err != nil:
		fail(w, wire.ErrUnavailable, "the record can't be read")
		return
	}
	defer t.Close()
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = io.Copy(w, io.LimitReader(t, wire.TranscriptBytesPerVisit))
}

func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	q, ok := query(w, r, "after", "waitS")
	if !ok {
		return
	}
	after, wait, bad := int64(0), int64(0), false
	if v, set := q["after"]; set {
		n, err := strconv.ParseInt(v, 10, 64)
		bad = bad || err != nil || n < 0 || strconv.FormatInt(n, 10) != v
		after = n
	}
	if v, set := q["waitS"]; set {
		n, err := strconv.ParseInt(v, 10, 64)
		bad = bad || err != nil || n < 0 || n > wire.EventsWaitMaxS || strconv.FormatInt(n, 10) != v
		wait = n
	}
	if bad {
		fail(w, wire.ErrBadRequest, "after is a seq, waitS 0…25")
		return
	}
	e := s.Events.After(r.Context(), after, time.Duration(wait)*time.Second)
	e.V = 1
	// At most EventsMax, the oldest: next is then the last one sent, so asking from next misses nothing.
	if len(e.Events) > wire.EventsMax {
		e.Events = e.Events[:wire.EventsMax]
		e.Next = e.Events[len(e.Events)-1].Seq
	}
	reply(w, e)
}

// noQuery refuses a query string where a path takes none.
func noQuery(w http.ResponseWriter, r *http.Request) bool {
	if r.URL.RawQuery != "" {
		fail(w, wire.ErrBadRequest, "this path takes no query")
		return false
	}
	return true
}

// query reads the query's parameters: each of names at most once, nothing else.
func query(w http.ResponseWriter, r *http.Request, names ...string) (map[string]string, bool) {
	vals, err := url.ParseQuery(r.URL.RawQuery)
	out := map[string]string{}
	if err == nil {
		for k, v := range vals {
			known := false
			for _, n := range names {
				known = known || k == n
			}
			if !known || len(v) != 1 {
				err = errors.New("unknown or repeated")
				break
			}
			out[k] = v[0]
		}
	}
	if err != nil {
		fail(w, wire.ErrBadRequest, "not this path's query")
		return nil, false
	}
	return out, true
}

// read reads a request body of at most RequestMaxBytes, where the path takes no query; false when it answered.
func read(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	if !noQuery(w, r) {
		return nil, false
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, wire.RequestMaxBytes))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			fail(w, wire.ErrTooLarge, "the body is larger than 1 KiB")
		} else {
			fail(w, wire.ErrBadRequest, "can't read the body")
		}
		return nil, false
	}
	return body, true
}

func reply(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, code, message string) {
	failStatus(w, wire.ErrorStatus[code], code, message)
}

func failStatus(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": code, "message": message}})
}
