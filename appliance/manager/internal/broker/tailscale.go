package broker

// Tailscale for This Whombat (contracts 1.0.0 `MANAGER_PATHS.tailscale*`, CT-1253…CT-1255; Whombat HE-51; MG-130): the
// manager drives the box's tailscaled for the runtime, which never reaches tailscaled itself (NX-441). The state for the
// runtime and the support service's Look; changes and the certificate for the runtime only. The owner check is the
// runtime's (the session op is an owner's). The certificate's key is in the answer and nowhere else.

import (
	"context"
	"errors"
	"net/http"

	"github.com/CybexBV/whombat/appliance/manager/internal/tailscale"
	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// Tailscale is the box's Tailscale as the broker needs it (manager/internal/tailscale.Manager).
type Tailscale interface {
	State(ctx context.Context) protocol.TailscaleStatus
	// On turns it on with a coordination server ("": Tailscale's own; CT-1306, MG-135).
	On(ctx context.Context, loginServer string) (protocol.TailscaleStatus, error)
	Off(ctx context.Context, signOut bool) (protocol.TailscaleStatus, error)
	SignIn(ctx context.Context) (protocol.TailscaleStatus, error)
	Cert(ctx context.Context) (*local.TailscaleCertResponse, error)
	// Peers are the tailnet's other devices (3.11 CT-1635, MG-140).
	Peers(ctx context.Context) ([]local.TailscalePeer, error)
}

const tailscaleBodyMax = 1024

func (s *Server) noTailscale(w http.ResponseWriter) bool {
	if s.Tailscale == nil {
		writeErr(w, http.StatusNotFound, "unavailable", "this manager doesn't run Tailscale")
		return true
	}
	return false
}

// tailscaleErr maps the manager's errors to the contract's (409 tailscale.busy, tailscale.off, tailscale.no_https;
// 503 unavailable).
func (s *Server) tailscaleErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, tailscale.ErrBusy):
		writeErr(w, http.StatusConflict, "tailscale.busy", "a Tailscale change is already running")
	case errors.Is(err, tailscale.ErrOff):
		writeErr(w, http.StatusConflict, "tailscale.off", "Tailscale isn't on")
	case errors.Is(err, tailscale.ErrNoHTTPS):
		writeErr(w, http.StatusConflict, "tailscale.no_https", "the tailnet has HTTPS certificates turned off")
	case errors.Is(err, tailscale.ErrLoginServer):
		writeErr(w, http.StatusBadRequest, "bad_request", "not a login server address")
	default:
		w.Header().Set("Retry-After", "10")
		writeErr(w, http.StatusServiceUnavailable, "unavailable", "Tailscale didn't answer")
	}
}

// tailscaleState answers a status with its contract's checks (the schema and tailscaleStatusValid).
func (s *Server) tailscaleState(w http.ResponseWriter, st protocol.TailscaleStatus) {
	resp := local.TailscaleStateResponse{V: 1, Tailscale: st}
	if err := resp.Validate(); err != nil || !tailscale.Valid(st) {
		s.log().Error("broker: the Tailscale state breaks its contract", "err", err, "state", st.State)
		writeErr(w, http.StatusInternalServerError, "internal", "the Tailscale state is not valid")
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// tailscaleRequest reads a body of the route's request type (strict, `{"v":1}`).
func tailscaleRequest[T any](w http.ResponseWriter, r *http.Request, parse func([]byte) (*T, error)) (*T, bool) {
	b, ok := readBody(w, r)
	if !ok {
		return nil, false
	}
	req, err := parse(b)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return nil, false
	}
	return req, true
}

func (s *Server) tailscaleStateRoute(w http.ResponseWriter, r *http.Request) {
	if s.noTailscale(w) {
		return
	}
	if _, ok := tailscaleRequest(w, r, local.ParseTailscaleStateRequest); !ok {
		return
	}
	s.tailscaleState(w, s.Tailscale.State(r.Context()))
}

func (s *Server) tailscaleOn(w http.ResponseWriter, r *http.Request) {
	if s.noTailscale(w) {
		return
	}
	req, ok := tailscaleRequest(w, r, local.ParseTailscaleOnRequest)
	if !ok {
		return
	}
	server := ""
	if req.LoginServer != nil {
		server = *req.LoginServer
	}
	st, err := s.Tailscale.On(r.Context(), server)
	if err != nil {
		s.tailscaleErr(w, err)
		return
	}
	s.tailscaleState(w, st)
}

func (s *Server) tailscaleOff(w http.ResponseWriter, r *http.Request) {
	if s.noTailscale(w) {
		return
	}
	req, ok := tailscaleRequest(w, r, local.ParseTailscaleOffRequest)
	if !ok {
		return
	}
	st, err := s.Tailscale.Off(r.Context(), req.SignOut != nil && *req.SignOut)
	if err != nil {
		s.tailscaleErr(w, err)
		return
	}
	s.tailscaleState(w, st)
}

func (s *Server) tailscaleSignIn(w http.ResponseWriter, r *http.Request) {
	if s.noTailscale(w) {
		return
	}
	if _, ok := tailscaleRequest(w, r, local.ParseTailscaleSignInRequest); !ok {
		return
	}
	st, err := s.Tailscale.SignIn(r.Context())
	if err != nil {
		s.tailscaleErr(w, err)
		return
	}
	s.tailscaleState(w, st)
}

func (s *Server) tailscaleCert(w http.ResponseWriter, r *http.Request) {
	if s.noTailscale(w) {
		return
	}
	if _, ok := tailscaleRequest(w, r, local.ParseTailscaleCertRequest); !ok {
		return
	}
	c, err := s.Tailscale.Cert(r.Context())
	if err != nil {
		s.tailscaleErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, c)
}

// tailscalePeers answers the tailnet's other devices, for the agent through the runtime (3.11 CT-1635, MG-140).
func (s *Server) tailscalePeers(w http.ResponseWriter, r *http.Request) {
	if s.noTailscale(w) {
		return
	}
	if _, ok := tailscaleRequest(w, r, local.ParseTailscalePeersRequest); !ok {
		return
	}
	peers, err := s.Tailscale.Peers(r.Context())
	if err != nil {
		s.tailscaleErr(w, err)
		return
	}
	resp := local.TailscalePeersResponse{V: 1, Peers: peers}
	if err := resp.Validate(); err != nil {
		s.log().Error("broker: the tailnet's devices break their contract", "err", err)
		writeErr(w, http.StatusInternalServerError, "internal", "the tailnet's devices are not valid")
		return
	}
	writeJSON(w, http.StatusOK, resp)
}
