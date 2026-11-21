// Package broker is the manager's local API on /run/whombat-manager/api.sock (MG-11). The runtime
// gets admission tickets and relays claim/revocation/push facts to control through it, so the
// management key never leaves the manager. Every request is authorized by kernel peer credentials:
// runtime endpoints accept only the runtime uid; maintenance-lock endpoints accept only configured
// lock holders (the backup agent).
//
// Runtime-facing shapes are the @whombat/control-contracts `local` IPC contract (contracts 0.4.0,
// CT-23, docs/local-ipc.md): requests strict, errors LocalError {error: {code, message}}, control
// unreachable -> 503 {code: unavailable}.
package broker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"slices"
	"sync"
	"syscall"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/netconfig"
	"github.com/CybexBV/whombat/appliance/helper/pkg/peercred"
	"github.com/CybexBV/whombat/appliance/manager/internal/clients"
	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi"
	"github.com/CybexBV/whombat/appliance/manager/internal/hostmetrics"
	"github.com/CybexBV/whombat/appliance/manager/internal/netguard"
	"github.com/CybexBV/whombat/appliance/manager/internal/runtimeapi"
	"github.com/CybexBV/whombat/appliance/manager/internal/update"
	"github.com/CybexBV/whombat/appliance/manager/internal/updatechannel"
	"github.com/CybexBV/whombat/contracts/go/device"
	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/release"
)

// Control is the subset of the control client the broker needs.
type Control interface {
	AdmissionTicket(ctx context.Context, class string) (*device.TicketIssueResponse, error)
	Do(ctx context.Context, op device.DeviceOpName, body, out any) error
	// Forward signs op and returns control's answer as sent, up to maxAnswer bytes, within timeout (MG-39).
	Forward(ctx context.Context, op device.DeviceOpName, body any, maxAnswer int64, timeout time.Duration) ([]byte, error)
}

// Clients is the AI clients manager as the broker needs it (manager/internal/clients).
type Clients interface {
	Status() local.LocalClientsStatus
	Install(ctx context.Context, p release.ClientProvider) (local.LocalClient, error)
	Remove(ctx context.Context, p release.ClientProvider) (local.LocalClient, error)
}

// Licence renews the licence now (the daemon, MG-34).
type Licence interface {
	RenewNow(ctx context.Context) (local.LicenceRenewNowResult, error)
}

// HostMetrics is the manager's measurements of the box (manager/internal/hostmetrics, MG-63).
type HostMetrics interface {
	Metrics(req *local.HostMetricsRequest) (*local.HostMetricsResponse, error)
}

// ErrLicenceBusy: a forced renewal ran less than a minute ago (429 busy, LC-08).
var ErrLicenceBusy = errors.New("a licence renewal was asked for less than a minute ago")

// Server is the broker.
type Server struct {
	RuntimeUID uint32
	LockUIDs   []uint32
	// Control is nil on a box without control (a community box, MG-136): the routes that need it answer 404 unavailable.
	Control Control
	Engine  *update.Engine
	// Channel is the update channel (channel.go); nil: the routes answer update.channel_unavailable.
	Channel *updatechannel.Service
	Net     *netguard.Guard
	Now     func() time.Time
	Log     *slog.Logger
	// TicketMargin: a cached ticket is reused until this long before it expires.
	TicketMargin time.Duration
	// TicketRefresh: a cached ticket the runtime asks for again is replaced by a fresh one from control, at most once
	// this often per class (0: a minute; MG-167).
	TicketRefresh time.Duration
	// OnClaimed is called when the runtime reports its claim (before control is told): the claim-code
	// lease stops (MG-28).
	OnClaimed func()
	// Clients installs the AI clients (CT-73, MG-33); nil: this appliance manages none.
	Clients Clients
	// OnClaimReported is called once control accepted the runtime's claim report (claim.claimed): the licence is
	// renewed right after the claim (LC-06).
	OnClaimReported func()
	// Licence renews the licence on the runtime's request (LC-08); nil: no licence configuration.
	Licence Licence
	// Host answers POST /v1/host/metrics (CT-334, MG-66); nil: 404 unavailable, as from a manager before it.
	Host HostMetrics
	// Hardware answers POST /v1/host/hardware (CT-560, MG-113); nil: 404 unavailable.
	Hardware Hardware
	// CheckNow polls control now and returns its answer (POST /v1/update/check, MG-67); nil: 404 unavailable.
	CheckNow func(ctx context.Context) (*CheckResult, error)
	// WakeEngine has the update engine step now (the owner's switch or approval, ask.go); nil: it steps at its own pace.
	WakeEngine func()
	// AdminUIDs may ask for that poll: root and the manager's own user (`whombat-manager check`).
	AdminUIDs []uint32
	// SocketCheck is how often Serve checks that its socket file is still there (SR-02); 0: 5 s.
	SocketCheck time.Duration
	// SupportUIDs is the support service (root, remote help, MG-118): its ticket, and the reads its Look commands make
	// (the update status, the network state, the box's measurements and its hardware) beside the runtime's.
	SupportUIDs []uint32
	// Support fetches the support route's tickets (support.ticket); nil: 404 unavailable, as a manager before it.
	Support SupportControl
	// Tailscale drives the box's tailscaled for the runtime (CT-1255, MG-130; tailscale.go); nil: 404 unavailable.
	Tailscale Tailscale
	// Helper starts a restore and restarts after one (restore.go); nil: 404 unavailable.
	Helper Helper
	// RestoreState reads where a restore is from the backup service (restore.go): a failed restore gives its
	// maintenance lock back. Nil: only the release after the person's answers (or the lock's limit) does.
	RestoreState func(ctx context.Context) (RestoreState, error)
	// RestorePoll is how often a held restore lock is checked (0: 30 s).
	RestorePoll time.Duration
	// OwnAddress is the box's own address (ownaddress.go, MG-166); nil: none on this image or environment (state
	// answers enabled false, the other routes 404 own_address.off).
	OwnAddress OwnAddress
	// Link is the box's Whombat Link state (link.go, MG-171): the gate of every route that goes to control, and the
	// Link routes. Nil: no gate (a manager built without it, the tests of other routes); the Link routes answer off.
	Link Link

	mu      sync.Mutex
	tickets map[string]*local.RuntimeTicketResponse
	// ticketAt is when each class's cached ticket came from control (MG-167).
	ticketAt map[string]time.Time
	// supportMu guards supportCached, the support route's ticket, kept apart from the runtime's (MG-118).
	supportMu     sync.Mutex
	supportCached *device.SupportTicketResponse
}

func (s *Server) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *Server) log() *slog.Logger {
	if s.Log != nil {
		return s.Log
	}
	return slog.Default()
}

// Handler returns the HTTP handler (use with ConnContext = peercred.ConnContext).
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	rt := []uint32{s.RuntimeUID}
	lock := s.LockUIDs
	both := append(append([]uint32{}, rt...), lock...)
	// What the support service's Look commands read besides the runtime (MG-118).
	look := append(append([]uint32{}, rt...), s.SupportUIDs...)
	mux.HandleFunc("POST "+local.ManagerPathTicket, s.only(rt, s.ticket))
	mux.HandleFunc("POST "+local.ManagerPathClaimed, s.only(rt, s.claimed))
	mux.HandleFunc("POST "+local.ManagerPathRevocations, s.only(rt, s.revocations))
	mux.HandleFunc("POST "+local.ManagerPathPush, s.only(rt, s.push))
	for path, route := range feedbackRoutes {
		mux.HandleFunc("POST "+path, s.onlyN(rt, route.requestMax, s.feedback(route)))
	}
	mux.HandleFunc("GET /v1/update/status", s.only(append(append([]uint32{}, both...), s.SupportUIDs...), s.status))
	// Ask before updating: the owner's switch and approval, the runtime's only (ask.go).
	mux.HandleFunc("POST "+local.ManagerPathUpdateAsk, s.onlyN(rt, askBodyMax, s.updateAsk))
	mux.HandleFunc("POST "+local.ManagerPathUpdateApprove, s.onlyN(rt, askBodyMax, s.updateApprove))
	mux.HandleFunc("POST "+local.ManagerPathUpdateChannel, s.onlyN(rt, channelBodyMax, s.updateChannel))       // channel.go
	mux.HandleFunc("POST "+local.ManagerPathUpdateChannelSet, s.onlyN(rt, channelBodyMax, s.updateChannelSet)) // channel.go
	mux.HandleFunc("POST "+PathCheck, s.only(s.AdminUIDs, s.check))
	mux.HandleFunc("POST /v1/maintenance/lock", s.only(lock, s.lock))
	mux.HandleFunc("POST /v1/maintenance/unlock", s.only(lock, s.unlock))
	mux.HandleFunc("POST /v1/network/candidates", s.only(rt, s.netSubmit))
	mux.HandleFunc("GET /v1/network/status", s.only(rt, s.netStatus))
	// The network state and Wi-Fi (MG-102, network.go).
	mux.HandleFunc("POST "+local.ManagerPathNetworkState, s.onlyN(look, networkBodyMax, s.networkState))
	mux.HandleFunc("POST "+local.ManagerPathWifiScan, s.onlyN(rt, networkBodyMax, s.wifiScan))
	mux.HandleFunc("POST "+local.ManagerPathWifiJoin, s.onlyN(rt, networkBodyMax, s.wifiJoin))
	mux.HandleFunc("POST "+local.ManagerPathWifiForget, s.onlyN(rt, networkBodyMax, s.wifiForget))
	mux.HandleFunc("POST "+local.ManagerPathNetworkCable, s.onlyN(rt, networkBodyMax, s.cableSet))
	mux.HandleFunc("GET "+local.ManagerPathClients, s.only(rt, s.clientsStatus))
	mux.HandleFunc("POST "+local.ManagerPathClientsInstall, s.only(rt, s.clientsInstall))
	mux.HandleFunc("POST "+local.ManagerPathClientsRemove, s.only(rt, s.clientsRemove))
	mux.HandleFunc("POST "+local.ManagerPathLicenceRenew, s.only(rt, s.licenceRenew))
	mux.HandleFunc("POST "+local.ManagerPathHostMetrics, s.only(look, s.hostMetrics))
	mux.HandleFunc("POST "+local.ManagerPathHostHardware, s.onlyN(look, 1024, s.hostHardware))
	// Remote help (MG-118): the support route's ticket, for the support service only.
	mux.HandleFunc("POST "+local.ManagerPathSupportTicket, s.onlyN(s.SupportUIDs, 1024, s.supportTicket))
	// Tailscale (CT-1255, MG-130): the state for the runtime and Look, changes and the certificate for the runtime.
	mux.HandleFunc("POST "+local.ManagerPathTailscaleState, s.onlyN(look, tailscaleBodyMax, s.tailscaleStateRoute))
	mux.HandleFunc("POST "+local.ManagerPathTailscaleOn, s.onlyN(rt, tailscaleBodyMax, s.tailscaleOn))
	mux.HandleFunc("POST "+local.ManagerPathTailscaleOff, s.onlyN(rt, tailscaleBodyMax, s.tailscaleOff))
	mux.HandleFunc("POST "+local.ManagerPathTailscaleSignIn, s.onlyN(rt, tailscaleBodyMax, s.tailscaleSignIn))
	mux.HandleFunc("POST "+local.ManagerPathTailscaleCert, s.onlyN(rt, tailscaleBodyMax, s.tailscaleCert))
	mux.HandleFunc("POST "+local.ManagerPathTailscalePeers, s.onlyN(look, tailscaleBodyMax, s.tailscalePeers))
	mux.HandleFunc("POST "+PathBackupRestore, s.onlyN(rt, 1024, s.backupRestore))
	mux.HandleFunc("POST "+PathBackupRestored, s.onlyN(rt, 1024, s.backupRestored))
	mux.HandleFunc("POST "+PathBackupKitEnvelopes, s.onlyN(rt, kitEnvelopesBodyMax, s.backupKitEnvelopes))
	// Shared links (share.go): the runtime's sealed copies, signed and forwarded to control.
	for path, route := range shareRoutes {
		mux.HandleFunc("POST "+path, s.onlyN(rt, route.requestMax, s.share(route)))
	}
	// The own address (ownaddress.go, MG-166): the runtime's only.
	mux.HandleFunc("POST "+local.ManagerPathLinkState, s.onlyN(rt, linkBodyMax, s.linkState))
	mux.HandleFunc("POST "+local.ManagerPathLinkOn, s.onlyN(rt, linkBodyMax, s.linkOn))
	mux.HandleFunc("POST "+local.ManagerPathLinkOff, s.onlyN(rt, linkBodyMax, s.linkOff))
	mux.HandleFunc("POST "+local.ManagerPathPushRegister, s.onlyN(rt, linkBodyMax, s.pushRegister))
	mux.HandleFunc("POST "+local.ManagerPathPushUnregister, s.onlyN(rt, linkBodyMax, s.pushUnregister))
	mux.HandleFunc("POST "+local.ManagerPathOwnAddressState, s.onlyN(rt, ownAddressBodyMax, s.ownAddressState))
	mux.HandleFunc("POST "+local.ManagerPathOwnAddressRegister, s.onlyN(rt, ownAddressBodyMax, s.ownAddressRegister))
	mux.HandleFunc("POST "+local.ManagerPathOwnAddressCert, s.onlyN(rt, ownAddressBodyMax, s.ownAddressCert))
	mux.HandleFunc("POST "+local.ManagerPathOwnAddressCt, s.onlyN(rt, ownAddressBodyMax, s.ownAddressCT))
	for path, route := range ownAddressForwards {
		mux.HandleFunc("POST "+path, s.onlyN(rt, route.requestMax, s.share(route)))
	}
	return mux
}

func (s *Server) only(uids []uint32, h http.HandlerFunc) http.HandlerFunc {
	return s.onlyN(uids, 64*1024, h)
}

// onlyN is only with a request body limit of max bytes.
func (s *Server) onlyN(uids []uint32, max int64, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cred, ok := peercred.FromContext(r.Context())
		if !ok || !slices.Contains(uids, cred.UID) {
			s.log().Warn("broker: refused peer", "uid", cred.UID, "pid", cred.PID, "path", r.URL.Path)
			writeErr(w, http.StatusForbidden, "forbidden", "this caller may not use this endpoint")
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, max)
		h(w, r)
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, kind, msg string) {
	writeJSON(w, code, local.LocalError{Error: local.LocalErrorError{Code: kind, Message: runtimeapi.ASCII(msg, 300)}})
}

func decode(r *http.Request, v any) error {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	return nil
}

// noControl answers 404 unavailable on a box without control, or without Link starting, on or in grace (link.go):
// tickets, shares, feedback drops and kit envelope copies are Link features (LNK-05, LNK-07).
func (s *Server) noControl(w http.ResponseWriter) bool { return s.gate(w, needActive) }

// noControlKnown is noControl for what is never gated once control knows the box (LNK-06): claim and revocation
// reports, push.send (control lets only security pushes through once Link ended).
func (s *Server) noControlKnown(w http.ResponseWriter) bool { return s.gate(w, needKnown) }

func (s *Server) controlErr(w http.ResponseWriter, err error) {
	if errors.Is(err, controlapi.ErrUnavailable) {
		w.Header().Set("Retry-After", "30")
		writeErr(w, http.StatusServiceUnavailable, "unavailable", err.Error())
		return
	}
	writeErr(w, http.StatusBadGateway, "control_refused", err.Error())
}

func readBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	b, err := io.ReadAll(r.Body)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return nil, false
	}
	return b, true
}

func (s *Server) ticket(w http.ResponseWriter, r *http.Request) {
	if s.noControl(w) {
		return
	}
	b, ok := readBody(w, r)
	if !ok {
		return
	}
	req, err := local.ParseRuntimeTicketRequest(b)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	// The Link state of control's answer goes to the keeper once s.mu is released (deferred before the lock, so it runs
	// after the unlock): a change it makes can drop the cached tickets, which takes s.mu.
	var seen *device.DeviceLinkStatus
	defer func() {
		if seen != nil && s.Link != nil {
			s.Link.Observe(seen)
		}
	}()
	margin := s.TicketMargin
	if margin == 0 {
		margin = 60 * time.Second
	}
	refresh := s.TicketRefresh
	if refresh == 0 {
		refresh = time.Minute
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.tickets == nil {
		s.tickets = map[string]*local.RuntimeTicketResponse{}
		s.ticketAt = map[string]time.Time{}
	}
	cached := s.tickets[req.Class]
	if cached != nil {
		exp, err := time.Parse(time.RFC3339, cached.ExpiresAt)
		if err != nil || !s.now().Add(margin).Before(exp) {
			cached = nil
		}
	}
	// The runtime keeps the ticket it was handed and asks again only when its own copy is nearly used up (then the
	// cached one is too, and goes above), after a restart, or when a relay refused it (4401). So a cached ticket asked
	// for again may be one the relay no longer takes: one that still carries lbl after control's switch went off and
	// the relay went back (MG-167). It is replaced by a fresh one, at most once per TicketRefresh, so a relay that
	// keeps refusing never makes the manager hammer control; meanwhile the cached ticket is handed out as before.
	if cached != nil && s.now().Sub(s.ticketAt[req.Class]) < refresh {
		writeJSON(w, http.StatusOK, cached)
		return
	}
	t, err := s.Control.AdmissionTicket(r.Context(), req.Class)
	if err != nil {
		if cached != nil {
			// Control out of reach (or refusing) is no reason to take away a ticket that may still work.
			s.ticketAt[req.Class] = s.now()
			writeJSON(w, http.StatusOK, cached)
			return
		}
		s.controlErr(w, err)
		return
	}
	// Every ticket answer carries the Link state (LNK-02): the cheapest way the box hears of a change.
	seen = t.Link
	resp := &local.RuntimeTicketResponse{Ticket: t.Ticket, RelayURL: t.Relay.URL, Worker: t.Relay.Worker,
		ExpiresAt: time.Unix(t.ExpiresAt, 0).UTC().Format(time.RFC3339)}
	if err := resp.Validate(); err != nil {
		writeErr(w, http.StatusBadGateway, "control_refused", "control returned an invalid ticket: "+err.Error())
		return
	}
	s.tickets[req.Class] = resp
	s.ticketAt[req.Class] = s.now()
	writeJSON(w, http.StatusOK, resp)
}

func parseTime(v string) (int64, error) {
	t, err := time.Parse(time.RFC3339Nano, v)
	if err != nil {
		return 0, err
	}
	return t.Unix(), nil
}

func (s *Server) claimed(w http.ResponseWriter, r *http.Request) {
	if s.noControlKnown(w) {
		return
	}
	b, ok := readBody(w, r)
	if !ok {
		return
	}
	req, err := local.ParseRuntimeClaimedRequest(b)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	at, err := parseTime(req.ClaimedAt)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if s.OnClaimed != nil {
		s.OnClaimed()
	}
	// CT-27: the claim id the client presented travels to control, which completes exactly that claim.
	if err := s.Control.Do(r.Context(), device.DeviceOpNameClaimClaimed, device.ClaimClaimedRequest{ClaimID: req.ClaimID, ClaimedAt: at}, nil); err != nil {
		s.controlErr(w, err)
		return
	}
	if s.OnClaimReported != nil {
		s.OnClaimReported()
	}
	writeJSON(w, http.StatusOK, local.LocalOk{Ok: true})
}

func (s *Server) revocations(w http.ResponseWriter, r *http.Request) {
	if s.noControlKnown(w) {
		return
	}
	b, ok := readBody(w, r)
	if !ok {
		return
	}
	req, err := local.ParseRuntimeRevocationRequest(b)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	at, err := parseTime(req.RevokedAt)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	body := device.RevocationsReportRequest{Revocations: []device.RevocationReport{{Ref: local.RevocationRef(req.PeerID),
		Kind: "endpoint", State: "applied", RequestedAt: at, AppliedAt: &at}}}
	if err := s.Control.Do(r.Context(), device.DeviceOpNameRevocationsReport, body, nil); err != nil {
		s.controlErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, local.LocalOk{Ok: true})
}

func (s *Server) push(w http.ResponseWriter, r *http.Request) {
	if s.noControlKnown(w) {
		return
	}
	b, ok := readBody(w, r)
	if !ok {
		return
	}
	req, err := local.ParseRuntimePushRequest(b)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	var out local.RuntimePushResponse
	if err := s.Control.Do(r.Context(), device.DeviceOpNamePushSend, req, &out); err != nil {
		s.controlErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// UpdateFactsOf is the local-contract UpdateFacts for the runtime UI (codes only; no free text).
// ClientFloor is the current tuple's client security floor (CT-53), absent when that tuple has none: the
// journal's current tuple is TUF-verified and persisted, so the floor survives restarts, follows a
// rollback to known-good, and never ratchets. AskFirst is always there: this manager can hold updates for the owner,
// so the app offers the switch (Whombat ask-before-updating.md).
func UpdateFactsOf(st *update.State, lastChecked time.Time) *local.UpdateFacts {
	askFirst := st.AskFirst
	f := &local.UpdateFacts{State: st.Phase, Failure: st.Record.Failure, AskFirst: &askFirst}
	if st.Current != nil {
		f.Current = st.Current.ReleaseID
		if r := st.Current.Release; r != nil && r.ClientFloor != nil {
			floor := *r.ClientFloor
			f.ClientFloor = &floor
		}
	}
	if c := st.Candidate; c != nil {
		id := c.Tuple.ReleaseID
		f.Candidate = &id
		if d := c.Deferral; d != nil && d.Waiting != "" {
			why := d.Waiting
			f.DeferredReason = &why
		}
	}
	if st.Hold && f.DeferredReason == nil {
		h := "hold"
		f.DeferredReason = &h
	}
	if !lastChecked.IsZero() {
		s := lastChecked.UTC().Format(time.RFC3339)
		f.LastCheckedAt = &s
	}
	// What the owner is told (MG-47, UP-E4): why an update failed (the structured detail; the app renders it), what a
	// staged update waits for, and the last update that completed.
	f.FailureDetail = update.FailureDetail(st)
	if w := update.WaitingOf(st); w != nil {
		f.Waiting = &local.UpdateWaiting{Reason: w.Reason, Since: w.Since.UTC().Format(time.RFC3339), Blockers: []local.UpdateWaitingBlockersItem{}}
		for _, b := range w.Blockers {
			f.Waiting.Blockers = append(f.Waiting.Blockers, local.UpdateWaitingBlockersItem{Kind: b.Kind, Count: b.Count})
		}
	}
	if lu := st.LastUpdate; lu != nil {
		f.LastUpdate = &local.LastUpdate{Release: lu.Release, At: lu.At.UTC().Format(time.RFC3339)}
		if lu.From != "" {
			from := lu.From
			f.LastUpdate.From = &from
		}
	}
	return f
}

// StatusOf summarizes the journal for local callers (local.UpdateStatusResponse, CT-37).
func StatusOf(st *update.State) local.UpdateStatusResponse {
	out := local.UpdateStatusResponse{State: st.Phase, Hold: st.Hold, Failure: st.Record.Failure}
	if st.Current != nil {
		out.Current = st.Current.ReleaseID
	}
	if st.KnownGood != nil {
		out.KnownGood = st.KnownGood.ReleaseID
	}
	explanation := ""
	if c := st.Candidate; c != nil {
		id := c.Tuple.ReleaseID
		out.Candidate = &id
		if c.Deferral != nil {
			explanation = c.Deferral.Explanation
		}
		if c.Failure != nil {
			explanation = c.Failure.Message
			out.ReadOnly = c.Failure.KnownGoodAccess == "read-only"
		}
	} else if st.LastFailure != nil && st.Phase != update.Healthy {
		explanation = st.LastFailure.Message
	}
	if explanation != "" {
		e := runtimeapi.ASCII(explanation, 500)
		out.Explanation = &e
	}
	return out
}

func (s *Server) status(w http.ResponseWriter, r *http.Request) {
	st, err := s.Engine.Load()
	if err != nil {
		writeErr(w, http.StatusServiceUnavailable, "journal", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, StatusOf(st))
}

func (s *Server) lock(w http.ResponseWriter, r *http.Request) {
	b, ok := readBody(w, r)
	if !ok {
		return
	}
	req, err := local.ParseMaintenanceLockRequest(b)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	l, err := s.Engine.AcquireLock(req.Holder, req.Reason, time.Duration(req.TTLS)*time.Second)
	if err != nil {
		if errors.Is(err, update.ErrLockBusy) {
			writeErr(w, http.StatusConflict, "busy", err.Error())
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, local.MaintenanceLock{Holder: l.Holder, Reason: l.Reason,
		Since: l.Since.UTC().Format(time.RFC3339), Expires: l.Expires.UTC().Format(time.RFC3339)})
}

func (s *Server) unlock(w http.ResponseWriter, r *http.Request) {
	b, ok := readBody(w, r)
	if !ok {
		return
	}
	req, err := local.ParseMaintenanceUnlockRequest(b)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if err := s.Engine.ReleaseLock(req.Holder); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, local.LocalOk{Ok: true})
}

func (s *Server) netSubmit(w http.ResponseWriter, r *http.Request) {
	if s.Net == nil {
		writeErr(w, http.StatusNotImplemented, "unavailable", "network changes are not enabled")
		return
	}
	b, ok := readBody(w, r)
	if !ok {
		return
	}
	// The contract schema first (strict, MTU 576-9216), then the helper's own validation rules.
	if _, err := local.ParseNetworkCandidate(b); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	c, err := netconfig.Parse(b)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if err := s.Net.Submit(c); err != nil {
		writeErr(w, http.StatusConflict, "busy", err.Error())
		return
	}
	writeJSON(w, http.StatusAccepted, local.NetworkSubmitResponse{CandidateID: c.ID, Phase: local.NetworkPhaseApplying})
}

func (s *Server) netStatus(w http.ResponseWriter, r *http.Request) {
	if s.Net == nil {
		writeErr(w, http.StatusNotImplemented, "unavailable", "network changes are not enabled")
		return
	}
	st, err := s.Net.Load()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	out := local.NetworkStatus{UpdatedAt: st.UpdatedAt.UTC().Format(time.RFC3339)}
	if st.CandidateID != "" {
		id := st.CandidateID
		out.CandidateID = &id
	}
	if st.Phase != "" {
		ph := local.NetworkPhase(st.Phase)
		out.Phase = &ph
	}
	if !st.Deadline.IsZero() {
		d := st.Deadline.UTC().Format(time.RFC3339)
		out.Deadline = &d
	}
	if st.Result != "" {
		r := runtimeapi.ASCII(st.Result, 300)
		out.Result = &r
	}
	writeJSON(w, http.StatusOK, out)
}

// ErrSocketInUse: another process serves the socket path (a second manager); it is not taken over (SR-01).
var ErrSocketInUse = errors.New("the socket is served by another process")

// ErrSocketLost: the socket file was removed or replaced while the broker served it; the runtime can no longer
// reach this manager through it (SR-02).
var ErrSocketLost = errors.New("the socket file was removed or replaced")

// Listen binds the socket (Bind) and serves it until ctx ends (Serve).
func (s *Server) Listen(ctx context.Context, path string) error {
	ln, err := s.Bind(path)
	if err != nil {
		return err
	}
	return s.Serve(ctx, ln)
}

// Listener is a bound local API socket (Bind).
type Listener struct {
	ln   *net.UnixListener
	path string
	file os.FileInfo // the socket file as bound (Serve notices another file at the path)
}

// Close closes the listener and removes its socket file.
func (l *Listener) Close() error { return l.ln.Close() }

// Bind creates the socket (0660; the Nix module makes its directory group-accessible to the runtime and backup
// users) and returns its listener, which accepts connections from here on (SR-01). A stale socket file left by a
// manager that died is replaced; a socket another process still serves is not (ErrSocketInUse), and nothing but a
// socket is ever removed.
func (s *Server) Bind(path string) (*Listener, error) {
	if fi, err := os.Lstat(path); err == nil {
		if fi.Mode().Type() != os.ModeSocket {
			return nil, fmt.Errorf("%s exists and is not a socket", path)
		}
		if beforeDial != nil {
			beforeDial()
		}
		c, err := net.DialTimeout("unix", path, time.Second)
		switch {
		case err == nil:
			c.Close()
			return nil, fmt.Errorf("%s: %w", path, ErrSocketInUse)
		case errors.Is(err, syscall.ECONNREFUSED), errors.Is(err, syscall.ENOENT):
			// Nobody listens (the file of a manager that died), or the file went meanwhile.
		case errors.Is(err, syscall.EAGAIN):
			// A unix socket whose backlog is full refuses at once: someone listens.
			return nil, fmt.Errorf("%s: %w (its backlog is full)", path, ErrSocketInUse)
		default:
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() {
				return nil, fmt.Errorf("%s: %w (it does not accept in time)", path, ErrSocketInUse)
			}
			return nil, fmt.Errorf("%s: %w", path, err)
		}
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0o660); err != nil {
		ln.Close() // removes the socket file
		return nil, err
	}
	fi, err := os.Stat(path)
	if err != nil {
		ln.Close()
		return nil, err
	}
	return &Listener{ln: ln, path: path, file: fi}, nil
}

// beforeDial runs between Bind's look at the path and its dial (tests: the file goes meanwhile).
var beforeDial func()

// shutdownGrace is how long requests in flight may finish when the broker stops.
const shutdownGrace = 3 * time.Second

func (s *Server) socketCheck() time.Duration {
	if s.SocketCheck > 0 {
		return s.SocketCheck
	}
	return 5 * time.Second
}

// Serve serves the local API on l (from Bind) until ctx ends (nil) or serving fails: the listener fails, or the
// socket file is removed or replaced (ErrSocketLost, checked every SocketCheck; /run is a tmpfs, whose inode numbers
// are not reused soon). Either way l is closed and its socket file removed (unless another process's file replaced
// it) before Serve returns; requests in flight get shutdownGrace to finish on a normal stop.
func (s *Server) Serve(ctx context.Context, l *Listener) error {
	ln, path := l.ln, l.path
	srv := &http.Server{Handler: s.Handler(), ConnContext: peercred.ConnContext, ReadHeaderTimeout: 10 * time.Second}
	served := make(chan error, 1)
	go func() { served <- srv.Serve(ln) }()
	wctx, stopWatch := context.WithCancel(ctx)
	defer stopWatch()
	go s.watchRestores(wctx)
	tick := time.NewTicker(s.socketCheck())
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			if fi, err := os.Stat(path); err != nil || !os.SameFile(fi, l.file) {
				ln.SetUnlinkOnClose(false) // another process's socket (or none) at the path now: leave it
			}
			sctx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
			if err := srv.Shutdown(sctx); err != nil {
				_ = srv.Close()
			}
			cancel()
			<-served
			return nil
		case err := <-served:
			_ = srv.Close() // http.Server.Serve closed ln; this closes the connections
			if err == nil || errors.Is(err, http.ErrServerClosed) {
				err = errors.New("stopped serving")
			}
			return err
		case <-tick.C:
			if fi, err := os.Stat(path); err == nil && os.SameFile(fi, l.file) {
				continue
			}
			ln.SetUnlinkOnClose(false) // gone, or another process's socket now: leave the path alone
			_ = srv.Close()
			<-served
			return fmt.Errorf("%s: %w", path, ErrSocketLost)
		}
	}
}

func (s *Server) noClients(w http.ResponseWriter) bool {
	if s.Clients == nil {
		writeErr(w, http.StatusNotFound, "unavailable", "this appliance does not install AI clients")
		return true
	}
	return false
}

func (s *Server) clientsStatus(w http.ResponseWriter, r *http.Request) {
	if s.noClients(w) {
		return
	}
	writeJSON(w, http.StatusOK, s.Clients.Status())
}

// clientsErr maps the clients manager's errors to the contract (CT-73): 409 busy while removing, 404 unavailable
// when no bundle fits.
func (s *Server) clientsErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, clients.ErrBusy):
		writeErr(w, http.StatusConflict, "busy", err.Error())
	case errors.Is(err, clients.ErrUnavailable):
		writeErr(w, http.StatusNotFound, "unavailable", err.Error())
	default:
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
	}
}

func (s *Server) clientsInstall(w http.ResponseWriter, r *http.Request) {
	if s.noClients(w) {
		return
	}
	b, ok := readBody(w, r)
	if !ok {
		return
	}
	req, err := local.ParseClientInstallRequest(b)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	c, err := s.Clients.Install(r.Context(), req.Provider)
	if err != nil {
		s.clientsErr(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, c)
}

func (s *Server) clientsRemove(w http.ResponseWriter, r *http.Request) {
	if s.noClients(w) {
		return
	}
	b, ok := readBody(w, r)
	if !ok {
		return
	}
	req, err := local.ParseClientRemoveRequest(b)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	c, err := s.Clients.Remove(r.Context(), req.Provider)
	if err != nil {
		s.clientsErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, c)
}

// licenceRenew is POST /v1/licence/renew (LC-08, CT-77): one renewal now, answered after the attempt; 429 busy
// within a minute of the last one; 404 unavailable on an appliance without a licence configuration.
func (s *Server) licenceRenew(w http.ResponseWriter, r *http.Request) {
	if s.Licence == nil {
		writeErr(w, http.StatusNotFound, "unavailable", "this appliance has no licence configuration")
		return
	}
	b, ok := readBody(w, r)
	if !ok {
		return
	}
	if _, err := local.ParseLicenceRenewNowRequest(b); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	res, err := s.Licence.RenewNow(r.Context())
	switch {
	case errors.Is(err, ErrLicenceBusy):
		w.Header().Set("Retry-After", "60")
		writeErr(w, http.StatusTooManyRequests, "busy", err.Error())
		return
	case err != nil:
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// hostMetrics is POST /v1/host/metrics (CT-334, MG-66): the box's processor, memory, disks and network for an owner's
// Settings → This Whombat, answered from the sampler's memory. 503 unavailable in the second before the first sample.
func (s *Server) hostMetrics(w http.ResponseWriter, r *http.Request) {
	if s.Host == nil {
		writeErr(w, http.StatusNotFound, "unavailable", "this manager does not measure the box")
		return
	}
	b, ok := readBody(w, r)
	if !ok {
		return
	}
	req, err := local.ParseHostMetricsRequest(b)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	res, err := s.Host.Metrics(req)
	switch {
	case errors.Is(err, hostmetrics.ErrNotYet):
		w.Header().Set("Retry-After", "1")
		writeErr(w, http.StatusServiceUnavailable, "unavailable", err.Error())
		return
	case errors.Is(err, hostmetrics.ErrBadRequest):
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	case err != nil:
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, res)
}
