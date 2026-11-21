// Package api is the presence socket (contracts 0.103.0 `local`, CT-597; Whombat DK-28…DK-33; NX-283): HTTP/1.1
// JSON on /run/whombat-presence/presence.sock, used by the runtime server only.
//
//	GET  /v1/presence/health  → PresenceHealth { v:1, camera, detector }
//	POST /v1/presence/watch   PresenceWatchRequest { v:1 } → PresenceWatch { v:1, state, face, seenAt?, frameAt? }
//	POST /v1/presence/stop    PresenceStopRequest { v:1 } → PresenceAck { v:1 }
//
// A watch turns the camera on and keeps it on 6 s more (package watch); a stop turns it off. Requests are strict and at
// most 1 KiB; errors are LocalError with the contract's PRESENCE_ERRORS: 400 bad_request (not the request's JSON, a
// wrong path or method) · 413 too_large · 503 unavailable (the detector doesn't work, so there is nothing to watch
// with). A peer that isn't the runtime or root gets 403 forbidden.
//
// Nothing of a picture leaves the service: the answers say only whether, and when, a face was seen.
package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"slices"

	"github.com/CybexBV/whombat/appliance/helper/pkg/peercred"
	"github.com/CybexBV/whombat/contracts/go/local"
)

// Watcher is the camera's lifetime (watch.Watcher).
type Watcher interface {
	Watch() local.PresenceWatch
	Stop()
}

// Server serves the presence socket.
type Server struct {
	Watcher Watcher
	// Camera says whether there is a camera it can stream from (camera.Prober); Detector whether the model loaded and
	// ran at start (presence-watch --self-test).
	Camera   func() bool
	Detector func() bool
	// AllowUIDs: the peers that may connect (SO_PEERCRED); empty lets in whoever the socket's mode lets in.
	AllowUIDs []uint32
}

// Handler routes the three paths behind the peer check.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc(local.PresencePathHealth, method(http.MethodGet, s.health))
	mux.HandleFunc(local.PresencePathWatch, method(http.MethodPost, s.watch))
	mux.HandleFunc(local.PresencePathStop, method(http.MethodPost, s.stop))
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		fail(w, http.StatusNotFound, local.PresenceErrorBadRequest, "no such path")
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if len(s.AllowUIDs) > 0 {
			c, ok := peercred.FromContext(r.Context())
			if !ok || !slices.Contains(s.AllowUIDs, c.UID) {
				fail(w, http.StatusForbidden, "forbidden", "this socket is the runtime's")
				return
			}
		}
		mux.ServeHTTP(w, r)
	})
}

func method(m string, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != m {
			w.Header().Set("Allow", m)
			fail(w, http.StatusMethodNotAllowed, local.PresenceErrorBadRequest, m+" only")
			return
		}
		h(w, r)
	}
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	reply(w, local.PresenceHealth{V: 1, Camera: s.Camera(), Detector: s.Detector()})
}

func (s *Server) watch(w http.ResponseWriter, r *http.Request) {
	body, ok := read(w, r)
	if !ok {
		return
	}
	if _, err := local.ParsePresenceWatchRequest(body); err != nil {
		fail(w, http.StatusBadRequest, local.PresenceErrorBadRequest, "not a PresenceWatchRequest")
		return
	}
	if !s.Detector() {
		fail(w, http.StatusServiceUnavailable, local.PresenceErrorUnavailable, "the face detector doesn't work on this box")
		return
	}
	reply(w, s.Watcher.Watch())
}

func (s *Server) stop(w http.ResponseWriter, r *http.Request) {
	body, ok := read(w, r)
	if !ok {
		return
	}
	if _, err := local.ParsePresenceStopRequest(body); err != nil {
		fail(w, http.StatusBadRequest, local.PresenceErrorBadRequest, "not a PresenceStopRequest")
		return
	}
	s.Watcher.Stop()
	reply(w, local.PresenceAck{V: 1})
}

// read reads a body of at most PresenceRequestMaxBytes; false when it answered.
func read(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, local.PresenceRequestMaxBytes))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			fail(w, http.StatusRequestEntityTooLarge, local.PresenceErrorTooLarge, "the body is larger than 1 KiB")
		} else {
			fail(w, http.StatusBadRequest, local.PresenceErrorBadRequest, "can't read the body")
		}
		return nil, false
	}
	return body, true
}

func reply(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(local.LocalError{Error: local.LocalErrorError{Code: code, Message: message}})
}
