package fetch

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strings"

	"github.com/CybexBV/whombat/appliance/helper/pkg/peercred"
	"github.com/CybexBV/whombat/contracts/go/local"
)

// maxBody is a VoiceModelRequest with room to spare.
const maxBody = 4 << 10

// Server is the models socket (contracts 3.1 `local` voice-models.ts): HTTP/1.1 JSON for the runtime server only.
//
//	GET  /v1/voice-models         → VoiceModelsState { v:1, models, free? }
//	POST /v1/voice-models/fetch   VoiceModelRequest { v:1, model } → VoiceModelsState
//	POST /v1/voice-models/remove  VoiceModelRequest { v:1, model } → VoiceModelsState
type Server struct {
	Fetcher *Fetcher
	// AllowUIDs: the peers that may connect (SO_PEERCRED); empty lets in whoever the socket's mode lets in.
	AllowUIDs []uint32
}

// Handler routes the three paths behind the peer check.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc(local.VoiceModelsPathState, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			fail(w, http.StatusMethodNotAllowed, local.VoiceErrorBadRequest, "GET only")
			return
		}
		reply(w, s.Fetcher.StateFor(requestedIncludes(r)))
	})
	mux.HandleFunc(local.VoiceModelsPathFetch, s.change(s.Fetcher.Fetch))
	mux.HandleFunc(local.VoiceModelsPathRemove, s.change(s.Fetcher.Remove))
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		fail(w, http.StatusNotFound, local.VoiceErrorBadRequest, "no such path")
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

func (s *Server) change(do func(id string) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			fail(w, http.StatusMethodNotAllowed, local.VoiceErrorBadRequest, "POST only")
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
		if err != nil {
			fail(w, http.StatusBadRequest, local.VoiceErrorBadRequest, "can't read the body")
			return
		}
		req, err := local.ParseVoiceModelRequest(body)
		if err != nil {
			fail(w, http.StatusBadRequest, local.VoiceErrorBadRequest, "not a VoiceModelRequest")
			return
		}
		if err := do(req.Model); err != nil {
			status := http.StatusInternalServerError
			if errors.Is(err, ErrUnknown) {
				status = http.StatusBadRequest
			}
			fail(w, status, local.VoiceErrorBadRequest, fmt.Sprint(err))
			return
		}
		reply(w, s.Fetcher.StateFor(requestedIncludes(r, req.Model)))
	}
}

func requestedIncludes(r *http.Request, extra ...string) []string {
	var out []string
	for _, v := range r.URL.Query()[local.VoiceModelsIncludeParam] {
		for _, part := range strings.Split(v, ",") {
			if id := strings.TrimSpace(part); id != "" {
				out = append(out, id)
			}
		}
	}
	for _, id := range extra {
		if id != "" {
			out = append(out, id)
		}
	}
	return out
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
