// Package fakecontrol is a test double of control's device API. It verifies envelopes with
// the contract verifier (device.VerifyDeviceRequest) exactly as control must.
package fakecontrol

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"maps"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi"
	"github.com/CybexBV/whombat/appliance/manager/internal/licence/licencetest"
	"github.com/CybexBV/whombat/contracts/go/device"
	"github.com/CybexBV/whombat/contracts/go/protocol"
	"github.com/CybexBV/whombat/contracts/go/release"
)

// Control is a fake control server.
type Control struct {
	mu         sync.Mutex
	Server     *httptest.Server
	Audience   string
	Devices    map[string]ed25519.PublicKey
	nonces     map[string]bool
	Assignment json.RawMessage
	Down       bool
	Progress   []device.UpdateProgressRequest
	Statuses   []device.StatusReportRequest
	Tickets    int
	Refused    int // requests answered 503 while Down
	Other      []string
	NextCheckS int64
	// AssignmentCalls counts answered update.assignment polls.
	AssignmentCalls int
	// NextReportS is status.report's answer (default 300 s, control's interval); daemon tests shorten it.
	NextReportS int64
	// StatusAway: test: this many status.reports are answered 503 first, as a control that is away for a moment;
	// StatusRefused counts them.
	StatusAway, StatusRefused int

	BadResult  string // test: force an inconsistent result
	AuthErrors []string
	Now        func() time.Time
	TicketTTL  time.Duration
	// claim.lookup (CC-03): the leased number, its lifetime and renewal hint; Claimed answers 409
	// already_claimed, Retired answers 403 device_revoked for every op (CL-30, CL-33).
	Lookup        string
	LookupTTL     time.Duration
	RenewAfterS   int64
	LookupCalls   int
	LookupClaimed bool
	Retired       bool
	// LookupsByFamily counts answered claim.lookup calls by the client's address family, "ipv4" or "ipv6"
	// (control keeps a network tag per family, CL-36; MG-32).
	LookupsByFamily map[string]int
	// LookupRefuseFamily ("ipv4" or "ipv6") answers claim.lookup over that family with 503 and doesn't count it: the
	// family isn't up yet on the box's network (MG-42).
	LookupRefuseFamily string

	// licence.renew (CL-41): tokens signed by LicenceSigner (a TEST key) for the org's LicenceState, living
	// LicenceTTL, with LicenceRenewAfterS. LicenceRefuse answers a refusal instead (device_unclaimed,
	// devices_allowed_reached, rate_limited); LicenceEdit changes the claims before signing (another device, an old
	// iat); LicenceForge signs with another key; LicenceTyp overrides the header's typ; LicenceNow is control's clock
	// for the token and the answer's now (default: the fake's clock).
	LicenceSigner      licencetest.Signer
	LicenceState       string
	LicenceTTL         time.Duration
	LicenceRenewAfterS int64
	LicenceRefuse      string
	LicenceEdit        func(*protocol.LicenceClaims)
	LicenceForge       *licencetest.Signer
	LicenceTyp         string
	LicenceNow         func() time.Time
	LicenceCalls       int
	LicenceIssued      []string
	env                string

	// The feedback drop (FD-20, FD-38): FeedbackMode "" answers the ops, "off" as a control with FEEDBACK_DROP=off
	// (404 feedback_drop_off), "unclaimed" 409 device_unclaimed. FeedbackSyncs records card-sync bodies as received, FeedbackDrops is what a pull returns
	// (then emptied), FeedbackAcked the acknowledged ids.
	FeedbackMode  string
	FeedbackSyncs []json.RawMessage
	FeedbackDrops []device.FeedbackDrop
	FeedbackAcked []string
	FeedbackPulls []device.FeedbackDropsPullRequest
	// feedback.reporters.publish (CT-164, MG-58): FeedbackPublishes records each request as decoded,
	// FeedbackReporters holds what control would serve, keyed "site/reference": an update replaces an entry unless the
	// entry's updatedAt is newer (equal overwrites), a removal deletes it. Unlike control, every site counts as the
	// device's own.
	FeedbackPublishes []device.FeedbackReportersPublishRequest
	FeedbackReporters map[string]device.FeedbackReporterUpdate
	FeedbackAnswer    json.RawMessage // test: answer every feedback op with this body instead
	Delay             time.Duration   // test: wait this long before answering a feedback op (outside the lock)

	// SupportTickets counts the support tickets issued.
	SupportTickets int

	// kit.envelopes.put: KitEnvelopes records each body as received; the answer is {stored: <envelopes in it>}.
	KitEnvelopes []json.RawMessage

	// share.put, share.delete, share.views: Shares holds each kept copy's put body by id, ShareViews how often each
	// was opened; SharePuts counts the puts control took. ShareRefuse answers every share op with that refusal code
	// instead (share_taken, share_limit, bad_expiry: 409, 400 or 403 like control, with the code in details.code).
	Shares      map[string]device.SharePutRequest
	ShareViews  map[string]int64
	SharePuts   int
	ShareRefuse string

	// The own address (4.3): address.register keeps one label per device (Addresses), under Zone (default
	// dev.whombat.app); a label in Taken is answered 409 label_taken; AddressHost, when set, is answered as the host
	// whatever the label (a control that disagrees with the box). AddressCalls counts the registrations control saw.
	Addresses    map[string]device.AddressRegisterResponse
	Zone         string
	Taken        map[string]bool
	AddressHost  string
	AddressCalls int
	// account.link.lookup, account.link and kit.credentials.declare: Forwarded records "<op> <body>" for each; LinkRefuse
	// answers the two link ops with that refusal code instead (link_code_invalid … : 409, code in details.code).
	Forwarded  []string
	LinkRefuse string

	// Whombat Link (4.4): Link is the state control answers to link.status and with every ticket (nil: a control from
	// before Link, which answers the link ops 404 and sends no state with tickets). link.begin of a device control
	// doesn't know adds it with its registration's management key (Registered), and answers BeginAnswer (default:
	// starting with a fresh code); LinkRefuse answers link.begin with that refusal code instead (device_exists,
	// rate_limited: 409 or 429). link.leave answers off. LinkCalls counts each link op by name.
	Link        *device.DeviceLinkStatus
	BeginAnswer *device.DeviceLinkStatus
	LinkRefuse2 string
	LinkCalls   map[string]int
	Registered  []device.DeviceRegistration
	// BeginNames: the name each link.begin carried ("" without one).
	BeginNames []string
	// support.heartbeat and push.register/unregister: what control took.
	Heartbeats  []device.SupportReport
	HeartbeatS  int64
	PushTokens  []protocol.NativePushToken
	PushDropped []string

	v6 *http.Server // the IPv6 loopback listener of ServeDualStack
}

// LinkCount is how often control answered the link op (link.begin, link.status, link.leave).
func (c *Control) LinkCount(op device.DeviceOpName) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.LinkCalls[string(op)]
}

// SetLink sets the Link state control answers.
func (c *Control) SetLink(st *device.DeviceLinkStatus) { c.mu.Lock(); c.Link = st; c.mu.Unlock() }

// adoptRegistration adds a device link.begin introduces (a box control never saw, LNK-03): control trusts the
// registration's management key once both its proofs verify, as control does.
func (c *Control) adoptRegistration(raw []byte) {
	var env device.DeviceRequestEnvelope
	if json.Unmarshal(raw, &env) != nil || env.Op != device.DeviceOpNameLinkBegin {
		return
	}
	if _, known := c.Devices[env.Device]; known {
		return
	}
	var req device.LinkBeginRequest
	if json.Unmarshal(env.Body, &req) != nil || !device.VerifyRegistration(&req.Registration) {
		return
	}
	k, err := hex.DecodeString(req.Registration.ManagementPublicKey)
	if err != nil || len(k) != ed25519.PublicKeySize {
		return
	}
	c.Devices[env.Device] = ed25519.PublicKey(k)
	c.Registered = append(c.Registered, req.Registration)
}

func (c *Control) link(w http.ResponseWriter, env *device.DeviceRequestEnvelope) {
	if c.LinkCalls == nil {
		c.LinkCalls = map[string]int{}
	}
	c.LinkCalls[string(env.Op)]++
	if c.Link == nil && c.BeginAnswer == nil && env.Op != device.DeviceOpNameLinkBegin {
		http.NotFound(w, nil)
		return
	}
	now := c.now().Unix()
	switch env.Op {
	case device.DeviceOpNameLinkBegin:
		switch c.LinkRefuse2 {
		case "":
		case "rate_limited":
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = fmt.Fprintf(w, `{"error":{"code":"rate_limited","message":"refused"}}`)
			return
		default:
			w.WriteHeader(http.StatusConflict)
			_, _ = fmt.Fprintf(w, `{"error":{"code":%q,"message":"refused"}}`, c.LinkRefuse2)
			return
		}
		var begin device.LinkBeginRequest
		if json.Unmarshal(env.Body, &begin) == nil {
			name := ""
			if begin.Name != nil {
				name = *begin.Name
			}
			c.BeginNames = append(c.BeginNames, name)
		}
		st := c.BeginAnswer
		if st == nil {
			if c.Link != nil && (c.Link.State == protocol.LinkStateOn || c.Link.State == protocol.LinkStateGrace) {
				st = c.Link
			} else {
				st = &device.DeviceLinkStatus{State: protocol.LinkStateStarting, Since: now,
					Pending: &device.LinkPending{Code: "ABCD-EFGH", URL: "https://app.whombat.com/link", ExpiresAt: now + protocol.LinkCodeTTLS}}
			}
		}
		c.Link = st
		_ = json.NewEncoder(w).Encode(device.LinkBeginResponse{Link: *st})
	case device.DeviceOpNameLinkStatus:
		_ = json.NewEncoder(w).Encode(device.LinkStatusResponse{Link: *c.Link})
	case device.DeviceOpNameLinkLeave:
		c.Link = &device.DeviceLinkStatus{State: protocol.LinkStateOff, Since: now, Label: c.Link.Label}
		_ = json.NewEncoder(w).Encode(device.LinkLeaveResponse{Link: *c.Link})
	}
}

// LicenceKeySet is the key set a device of this fake's environment pins (the fake's signing key).
func (c *Control) LicenceKeySet() protocol.LicenceKeySet {
	return licencetest.KeySet(c.env, c.LicenceSigner)
}

// LicenceCount returns how many licence.renew calls control answered (refusals included).
func (c *Control) LicenceCount() int { c.mu.Lock(); defer c.mu.Unlock(); return c.LicenceCalls }

// LastLicence returns the last token issued ("" if none).
func (c *Control) LastLicence() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.LicenceIssued) == 0 {
		return ""
	}
	return c.LicenceIssued[len(c.LicenceIssued)-1]
}

// Set runs f under the fake's lock (tests change the claim.lookup fields while the daemon runs).
func (c *Control) Set(f func(*Control)) { c.mu.Lock(); defer c.mu.Unlock(); f(c) }

// LookupCount returns how many claim.lookup calls control answered.
func (c *Control) LookupCount() int { c.mu.Lock(); defer c.mu.Unlock(); return c.LookupCalls }

// New starts a fake control for an environment.
func New(env string) *Control {
	c := &Control{Audience: "whombat-api:" + env, Devices: map[string]ed25519.PublicKey{}, nonces: map[string]bool{}, TicketTTL: 5 * time.Minute,
		Lookup: "4821", LookupTTL: 24 * time.Hour, RenewAfterS: 300, env: env,
		LicenceSigner: licencetest.NewSigner("fakecontrol", "lic-test-1"), LicenceState: "active",
		LicenceTTL: time.Duration(protocol.LicenceLifetimeS) * time.Second, LicenceRenewAfterS: protocol.LicenceRenewS}
	c.Server = httptest.NewServer(http.HandlerFunc(c.serve))
	return c
}

// Close stops the server.
func (c *Control) Close() {
	if c.v6 != nil {
		_ = c.v6.Close()
	}
	c.Server.Close()
}

// ServeDualStack serves the fake on [::1] too, on the same port as its 127.0.0.1 listener, and returns a URL whose
// host (localhost) resolves to both, like a dual-stack control. An error means this host has no IPv6 loopback (or
// the port is taken there): tests skip.
func (c *Control) ServeDualStack() (string, error) {
	_, port, err := net.SplitHostPort(c.Server.Listener.Addr().String())
	if err != nil {
		return "", err
	}
	l, err := net.Listen("tcp6", net.JoinHostPort("::1", port))
	if err != nil {
		return "", err
	}
	c.v6 = &http.Server{Handler: http.HandlerFunc(c.serve)}
	go func() { _ = c.v6.Serve(l) }()
	return "http://localhost:" + port, nil
}

// LookupFamilies returns how many claim.lookup calls came over IPv4 and over IPv6.
func (c *Control) LookupFamilies() (v4, v6 int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.LookupsByFamily["ipv4"], c.LookupsByFamily["ipv6"]
}

// clientFamily is "ipv4" or "ipv6" for a request's remote address (IPv4-mapped IPv6 counts as IPv4).
func clientFamily(r *http.Request) string {
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	if ip := net.ParseIP(host); ip != nil && ip.To4() == nil {
		return "ipv6"
	}
	return "ipv4"
}

// SetDown toggles an outage (HTTP 503).
func (c *Control) SetDown(d bool) { c.mu.Lock(); c.Down = d; c.mu.Unlock() }

// AssignmentCount is how many update.assignment polls control answered.
func (c *Control) AssignmentCount() int { c.mu.Lock(); defer c.mu.Unlock(); return c.AssignmentCalls }

// SetAssignment sets the served assignment (nil = none).
func (c *Control) SetAssignment(raw []byte) { c.mu.Lock(); c.Assignment = raw; c.mu.Unlock() }

// RefusedCount returns how many requests were answered 503 during outages.
func (c *Control) RefusedCount() int { c.mu.Lock(); defer c.mu.Unlock(); return c.Refused }

// StatusReports returns the status.report bodies received.
func (c *Control) StatusReports() []device.StatusReportRequest {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]device.StatusReportRequest(nil), c.Statuses...)
}

// LastProgress returns the most recent update.progress report.
func (c *Control) LastProgress() (device.UpdateProgressRequest, int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.Progress) == 0 {
		return device.UpdateProgressRequest{}, 0
	}
	return c.Progress[len(c.Progress)-1], len(c.Progress)
}

func (c *Control) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

func (c *Control) serve(w http.ResponseWriter, r *http.Request) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.Down {
		c.Refused++
		http.Error(w, "maintenance", http.StatusServiceUnavailable)
		return
	}
	op, ok := strings.CutPrefix(r.URL.Path, controlapi.PathPrefix)
	if r.Method != http.MethodPost || !ok {
		http.NotFound(w, r)
		return
	}
	// Room for the largest signed request of any op (share.put's 11 MiB copy).
	raw, _ := io.ReadAll(io.LimitReader(r.Body, device.SharePutMaxBytes+1<<20))
	c.adoptRegistration(raw)
	env, err := device.VerifyDeviceRequest(raw, device.DeviceRequestContext{
		Audience: c.Audience, Now: c.now().Unix(),
		PublicKeyOf: func(id string) (ed25519.PublicKey, bool) { k, ok := c.Devices[id]; return k, ok },
		ClaimNonce: func(dev, n string) bool {
			k := dev + "/" + n
			if c.nonces[k] {
				return false
			}
			c.nonces[k] = true
			return true
		},
	})
	if err != nil {
		c.AuthErrors = append(c.AuthErrors, err.Error())
		http.Error(w, err.Error(), http.StatusUnauthorized)
		return
	}
	if string(env.Op) != op {
		http.Error(w, "op mismatch", http.StatusBadRequest)
		return
	}
	if c.Retired {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":{"code":"device_revoked","message":"This appliance was retired.","details":{"code":"device_retired"}}}`))
		return
	}
	switch env.Op {
	case device.DeviceOpNameClaimLookup:
		if c.LookupRefuseFamily != "" && clientFamily(r) == c.LookupRefuseFamily {
			http.Error(w, "unreachable over this family", http.StatusServiceUnavailable)
			return
		}
		c.LookupCalls++
		if c.LookupsByFamily == nil {
			c.LookupsByFamily = map[string]int{}
		}
		c.LookupsByFamily[clientFamily(r)]++
		if c.LookupClaimed {
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"error":{"code":"claim_conflict","message":"This appliance is already claimed.","details":{"code":"already_claimed"}}}`))
			return
		}
		_ = json.NewEncoder(w).Encode(device.ClaimLookupResponse{Lookup: c.Lookup, ExpiresAt: c.now().Add(c.LookupTTL).Unix(), RenewAfterS: c.RenewAfterS})
	case device.DeviceOpNameLicenceRenew:
		c.LicenceCalls++
		switch c.LicenceRefuse {
		case "":
		case "device_unclaimed":
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"error":{"code":"conflict","message":"This appliance is not claimed.","details":{"code":"device_unclaimed"}}}`))
			return
		case "devices_allowed_reached":
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"error":{"code":"entitlement_withheld","message":"Over the device limit.","details":{"code":"devices_allowed_reached"}}}`))
			return
		case "rate_limited":
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"error":{"code":"rate_limited","message":"Too many requests."}}`))
			return
		default:
			http.Error(w, c.LicenceRefuse, http.StatusBadRequest)
			return
		}
		now := c.now()
		if c.LicenceNow != nil {
			now = c.LicenceNow()
		}
		claims := licencetest.Claims(c.env, env.Device, "org-1", c.LicenceState, now.Unix(), int64(c.LicenceTTL/time.Second))
		if c.LicenceEdit != nil {
			c.LicenceEdit(&claims)
		}
		signer, typ := c.LicenceSigner, protocol.LicenceTyp
		if c.LicenceForge != nil {
			signer = *c.LicenceForge
		}
		if c.LicenceTyp != "" {
			typ = c.LicenceTyp
		}
		tok := signer.SignTyp(claims, typ)
		c.LicenceIssued = append(c.LicenceIssued, tok)
		_ = json.NewEncoder(w).Encode(device.LicenceRenewResponse{Token: tok, ExpiresAt: claims.Exp, RenewAfterS: c.LicenceRenewAfterS, Now: now.Unix()})
	case device.DeviceOpNameTicketIssue:
		c.Tickets++
		exp := c.now().Add(c.TicketTTL)
		claims, _ := json.Marshal(map[string]any{"rol": "appliance", "sub": env.Device, "exp": exp.Unix(), "jti": fmt.Sprint(c.Tickets)})
		jws := "eyJhbGciOiJFZERTQSJ9." + base64.RawURLEncoding.EncodeToString(claims) + ".c2lnbmF0dXJl"
		_ = json.NewEncoder(w).Encode(device.TicketIssueResponse{Ticket: jws, ExpiresAt: exp.Unix(), Channel: "app",
			Relay: device.RelayAssignment{Worker: "w1", URL: "wss://relay.dev.whombat.com", ReassignAfter: exp.Unix()}, Link: c.Link})
	case device.DeviceOpNameLinkBegin, device.DeviceOpNameLinkStatus, device.DeviceOpNameLinkLeave:
		c.link(w, env)
	case device.DeviceOpNameSupportHeartbeat:
		req, err := device.ParseSupportHeartbeatRequest(env.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		c.Heartbeats = append(c.Heartbeats, req.Support)
		next := c.HeartbeatS
		if next == 0 {
			next = 300
		}
		_ = json.NewEncoder(w).Encode(device.SupportHeartbeatResponse{Ok: true, NextS: next})
	case device.DeviceOpNamePushRegister:
		req, err := device.ParsePushRegisterRequest(env.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		c.PushTokens = append(c.PushTokens, req.Token)
		_ = json.NewEncoder(w).Encode(device.PushRegisterResponse{Handle: fmt.Sprintf("ph_handle_of_the_box_%04d", len(c.PushTokens))})
	case device.DeviceOpNamePushUnregister:
		req, err := device.ParsePushUnregisterRequest(env.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		c.PushDropped = append(c.PushDropped, req.Handle)
		_, _ = w.Write([]byte(`{"ok":true}`))
	case device.DeviceOpNameSupportTicket:
		c.SupportTickets++
		exp := c.now().Add(c.TicketTTL)
		claims, _ := json.Marshal(map[string]any{"rol": "appliance", "apl": "rt_support", "sub": env.Device, "exp": exp.Unix(),
			"jti": fmt.Sprint("s", c.SupportTickets)})
		jws := "eyJhbGciOiJFZERTQSJ9." + base64.RawURLEncoding.EncodeToString(claims) + ".c2lnbmF0dXJl"
		_ = json.NewEncoder(w).Encode(device.SupportTicketResponse{Ticket: jws, ExpiresAt: exp.Unix(), Channel: "app",
			Relay: device.RelayAssignment{Worker: "w1", URL: "wss://relay.dev.whombat.com/v1/connect", ReassignAfter: exp.Unix()}})
	case device.DeviceOpNameUpdateAssignment:
		c.AssignmentCalls++
		a, result := c.Assignment, "assigned"
		var req device.UpdateAssignmentRequest
		_ = json.Unmarshal(env.Body, &req)
		if a == nil {
			a, result = json.RawMessage("null"), "none"
		} else if sa, err := release.ParseSignedAssignment(a); err == nil && sa.Payload.Sequence <= req.LastSequence {
			a, result = json.RawMessage("null"), "unchanged"
		}
		if c.BadResult != "" {
			result = c.BadResult
		}
		next := c.NextCheckS
		if next == 0 {
			next = 300
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"result": result, "assignment": a, "nextCheckS": next})
	case device.DeviceOpNameUpdateProgress:
		var p device.UpdateProgressRequest
		_ = json.Unmarshal(env.Body, &p)
		c.Progress = append(c.Progress, p)
		_, _ = w.Write([]byte(`{"ok":true}`))
	case device.DeviceOpNameClaimClaimed, device.DeviceOpNameRevocationsReport:
		c.Other = append(c.Other, string(env.Op)+" "+string(env.Body))
		_, _ = w.Write([]byte(`{"ok":true}`))
	case device.DeviceOpNamePushSend:
		c.Other = append(c.Other, string(env.Op)+" "+string(env.Body))
		_, _ = w.Write([]byte(`{"accepted":1,"invalidHandles":[],"rateLimited":false}`))
	case device.DeviceOpNameFeedbackCardsSync, device.DeviceOpNameFeedbackDropsPull, device.DeviceOpNameFeedbackDropsAck,
		device.DeviceOpNameFeedbackReportersPublish:
		c.feedback(w, env)
	case device.DeviceOpNameStatusReport:
		if c.StatusAway > 0 {
			c.StatusAway--
			c.StatusRefused++
			http.Error(w, "maintenance", http.StatusServiceUnavailable)
			return
		}
		s, err := device.ParseStatusReportRequest(env.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		c.Statuses = append(c.Statuses, *s)
		next := c.NextReportS
		if next == 0 {
			next = 300
		}
		_, _ = fmt.Fprintf(w, `{"ok":true,"nextReportS":%d}`, next)
	case device.DeviceOpNameKitEnvelopesPut:
		p, err := device.ParseKitEnvelopesPutRequest(env.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		c.KitEnvelopes = append(c.KitEnvelopes, append(json.RawMessage(nil), env.Body...))
		_ = json.NewEncoder(w).Encode(device.KitEnvelopesPutResponse{Stored: int64(len(p.Envelopes))})
	case device.DeviceOpNameSharePut, device.DeviceOpNameShareDelete, device.DeviceOpNameShareViews:
		c.share(w, env)
	case device.DeviceOpNameAddressRegister:
		c.addressRegister(w, env)
	case device.DeviceOpNameAccountLinkLookup, device.DeviceOpNameAccountLink, device.DeviceOpNameKitCredentialsDeclare:
		c.Forwarded = append(c.Forwarded, string(env.Op)+" "+string(env.Body))
		if c.LinkRefuse != "" && env.Op != device.DeviceOpNameKitCredentialsDeclare {
			w.WriteHeader(http.StatusConflict)
			_, _ = fmt.Fprintf(w, `{"error":{"code":"conflict","message":"refused","details":{"code":%q}}}`, c.LinkRefuse)
			return
		}
		switch env.Op {
		case device.DeviceOpNameAccountLinkLookup:
			_, _ = w.Write([]byte(`{"email":"owner@example.com","expiresAt":1790000600}`))
		case device.DeviceOpNameAccountLink:
			_, _ = w.Write([]byte(`{"email":"owner@example.com","linkedAt":1790000000}`))
		default:
			req, err := device.ParseKitCredentialsDeclareRequest(env.Body)
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			_ = json.NewEncoder(w).Encode(device.KitCredentialsDeclareResponse{Declared: int64(len(req.CredentialIds))})
		}
	default:
		http.NotFound(w, r)
	}
}

func (c *Control) feedback(w http.ResponseWriter, env *device.DeviceRequestEnvelope) {
	if d := c.Delay; d > 0 {
		c.mu.Unlock()
		time.Sleep(d)
		c.mu.Lock()
	}
	switch c.FeedbackMode {
	case "off":
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":{"code":"not_found","message":"The feedback drop is switched off on this service.","details":{"code":"feedback_drop_off"}}}`))
		return
	case "unclaimed":
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"error":{"code":"conflict","message":"This appliance is not claimed yet.","details":{"code":"device_unclaimed"}}}`))
		return
	}
	if c.FeedbackAnswer != nil {
		_, _ = w.Write(c.FeedbackAnswer)
		return
	}
	switch env.Op {
	case device.DeviceOpNameFeedbackCardsSync:
		req, err := device.ParseFeedbackCardsSyncRequest(env.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		c.FeedbackSyncs = append(c.FeedbackSyncs, append(json.RawMessage(nil), env.Body...))
		out := device.FeedbackCardsSyncResponse{Accepted: []string{}, Refused: []device.FeedbackCardRefusal{}}
		for _, card := range req.Cards {
			var head struct {
				Site string `json:"site"`
			}
			_ = json.Unmarshal(card.Card, &head)
			out.Accepted = append(out.Accepted, head.Site)
		}
		_ = json.NewEncoder(w).Encode(out)
	case device.DeviceOpNameFeedbackDropsPull:
		req, err := device.ParseFeedbackDropsPullRequest(env.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		c.FeedbackPulls = append(c.FeedbackPulls, *req)
		drops := c.FeedbackDrops
		if drops == nil {
			drops = []device.FeedbackDrop{}
		}
		c.FeedbackDrops = nil
		_ = json.NewEncoder(w).Encode(device.FeedbackDropsPullResponse{Drops: drops, Pending: 0,
			Expired: []device.FeedbackExpiredCount{}, NextPullS: device.FeedbackPullS})
	case device.DeviceOpNameFeedbackDropsAck:
		req, err := device.ParseFeedbackDropsAckRequest(env.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		c.FeedbackAcked = append(c.FeedbackAcked, req.DropIds...)
		_, _ = w.Write([]byte(`{"ok":true}`))
	case device.DeviceOpNameFeedbackReportersPublish:
		req, err := device.ParseFeedbackReportersPublishRequest(env.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		c.FeedbackPublishes = append(c.FeedbackPublishes, *req)
		if c.FeedbackReporters == nil {
			c.FeedbackReporters = map[string]device.FeedbackReporterUpdate{}
		}
		for _, u := range req.Updates {
			k := u.Site + "/" + u.Reference
			if held, ok := c.FeedbackReporters[k]; !ok || held.UpdatedAt <= u.UpdatedAt {
				c.FeedbackReporters[k] = u
			}
		}
		for _, r := range req.Removals {
			delete(c.FeedbackReporters, r.Site+"/"+r.Reference)
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}
}

// ReporterEntries returns a copy of the reporter entries control holds (feedback.reporters.publish), keyed
// "site/reference".
func (c *Control) ReporterEntries() map[string]device.FeedbackReporterUpdate {
	c.mu.Lock()
	defer c.mu.Unlock()
	return maps.Clone(c.FeedbackReporters)
}

func (c *Control) share(w http.ResponseWriter, env *device.DeviceRequestEnvelope) {
	if code := c.ShareRefuse; code != "" {
		status := map[string]int{"share_taken": http.StatusConflict, "share_limit": http.StatusForbidden}[code]
		if status == 0 {
			status = http.StatusBadRequest
		}
		w.WriteHeader(status)
		_, _ = fmt.Fprintf(w, `{"error":{"code":"refused","message":"Refused.","details":{"code":%q}}}`, code)
		return
	}
	if c.Shares == nil {
		c.Shares = map[string]device.SharePutRequest{}
		c.ShareViews = map[string]int64{}
	}
	switch env.Op {
	case device.DeviceOpNameSharePut:
		p, err := device.ParseSharePutRequest(env.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		c.Shares[p.ShareID] = *p
		c.SharePuts++
		_ = json.NewEncoder(w).Encode(device.SharePutResponse{URL: "https://app.dev.whombat.com/s/" + p.ShareID})
	case device.DeviceOpNameShareDelete:
		p, err := device.ParseShareDeleteRequest(env.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		for _, id := range p.ShareIds {
			delete(c.Shares, id)
			delete(c.ShareViews, id)
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	case device.DeviceOpNameShareViews:
		p, err := device.ParseShareViewsRequest(env.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		out := device.ShareViewsResponse{Shares: []device.ShareViews{}}
		for _, id := range p.ShareIds {
			if _, ok := c.Shares[id]; ok {
				out.Shares = append(out.Shares, device.ShareViews{ShareID: id, Views: c.ShareViews[id]})
			}
		}
		_ = json.NewEncoder(w).Encode(out)
	}
}

// addressRegister is control's address.register (control CL-165): one label per device, never reused.
func (c *Control) addressRegister(w http.ResponseWriter, env *device.DeviceRequestEnvelope) {
	req, err := device.ParseAddressRegisterRequest(env.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	c.AddressCalls++
	if c.Addresses == nil {
		c.Addresses = map[string]device.AddressRegisterResponse{}
	}
	if have, ok := c.Addresses[env.Device]; ok {
		_ = json.NewEncoder(w).Encode(have)
		return
	}
	if c.Taken[req.Label] {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"error":{"code":"conflict","message":"taken","details":{"code":"label_taken"}}}`))
		return
	}
	zone := c.Zone
	if zone == "" {
		zone = "dev.whombat.app"
	}
	resp := device.AddressRegisterResponse{Label: req.Label, Host: req.Label + "." + zone, RegisteredAt: c.now().Unix()}
	if c.AddressHost != "" {
		resp.Host = c.AddressHost
	} else {
		c.Addresses[env.Device] = resp
	}
	_ = json.NewEncoder(w).Encode(resp)
}
