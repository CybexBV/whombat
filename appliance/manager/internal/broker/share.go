package broker

// Shared links (Whombat share-links.md): the runtime keeps a sealed copy of part of a Chat thread at control, which hands
// it to whoever opens the link. The key stays in the link, so neither control nor the manager can read the copy; the
// manager checks the runtime's body against the contract, signs the device op with the management key and answers
// control's body as control sent it.
//
//	POST /v1/runtime/shares/put    {shareId, expiresAt?, envelope}  runtime → 200 {url}
//	POST /v1/runtime/shares/delete {shareIds}                       runtime → 200 {ok: true}
//	POST /v1/runtime/shares/views  {shareIds}                       runtime → 200 {shares: [{shareId, views, lastViewedAt?}]}
//
// Control out of reach: 503 control_unreachable with Retry-After. Control refused: 502 control_refused, control's codes
// (share_taken, share_limit, bad_expiry, device_unclaimed, device_revoked …) first in the message. A body above the
// path's limit, or a signed request above the op's: 413 too_large. A box without control: 404.

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi"
	"github.com/CybexBV/whombat/contracts/go/device"
	"github.com/CybexBV/whombat/contracts/go/local"
)

// The runtime's paths (the runtime is their only caller).
const (
	PathSharePut    = local.ManagerPathSharePut
	PathShareDelete = local.ManagerPathShareDelete
	PathShareViews  = local.ManagerPathShareViews
)

type shareRoute struct {
	op         device.DeviceOpName
	requestMax int64         // the runtime's request body
	answerMax  int64         // control's answer
	timeout    time.Duration // the whole exchange with control
	parseReq   func([]byte) (any, error)
	checkResp  func([]byte) error
	// need is what the route needs of the Link state: a Link feature (needActive, the zero value) or only that
	// control knows the box (needKnown).
	need linkNeed
}

// The runtime waits 60 s for every share path (its ManagerSocketClient); the manager gives up a little earlier so the
// runtime hears 503 and tries again rather than timing out on the socket. A put carries up to 11 MiB to control, which
// takes longer than the control client's default 30 s on a slow uplink, so every share op gets its own 55 s.
const shareTimeout = 55 * time.Second

var shareRoutes = map[string]shareRoute{
	// The put's body is the op's own body: the base64url copy (SharePutMaxBytes leaves 64 KiB above the largest one for
	// the rest of the body and the signed envelope around it); the client refuses a signed request above the op's limit
	// before sending it. Control answers {url}: 4 KiB is plenty.
	PathSharePut: {
		op: device.DeviceOpNameSharePut, requestMax: device.SharePutMaxBytes, answerMax: 4 << 10, timeout: shareTimeout,
		parseReq: func(b []byte) (any, error) { return local.ParseRuntimeSharePutRequest(b) },
		checkResp: func(b []byte) error {
			_, err := local.ParseRuntimeSharePutResponse(b)
			return err
		},
	},
	PathShareDelete: {
		op: device.DeviceOpNameShareDelete, requestMax: device.DeviceRequestMaxBytes, answerMax: 4 << 10, timeout: shareTimeout,
		parseReq: func(b []byte) (any, error) { return local.ParseRuntimeShareDeleteRequest(b) },
		checkResp: func(b []byte) error {
			_, err := local.ParseRuntimeShareDeleteResponse(b)
			return err
		},
	},
	// Up to ShareIdsMax entries of about 100 bytes each.
	PathShareViews: {
		op: device.DeviceOpNameShareViews, requestMax: device.DeviceRequestMaxBytes, answerMax: 256 << 10, timeout: shareTimeout,
		parseReq: func(b []byte) (any, error) { return local.ParseRuntimeShareViewsRequest(b) },
		checkResp: func(b []byte) error {
			_, err := local.ParseRuntimeShareViewsResponse(b)
			return err
		},
	},
}

// sharePuts bounds the puts in flight: each holds its copy several times over while it is checked, signed and sent
// (tens of MiB), and the manager has no memory limit of its own to fall back on. Sharing is a person's tap, so two
// at once is plenty; a third waits its turn.
var sharePuts = make(chan struct{}, 2)

func (s *Server) share(route shareRoute) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.gate(w, route.need) {
			return
		}
		if route.op == device.DeviceOpNameSharePut {
			select {
			case sharePuts <- struct{}{}:
				defer func() { <-sharePuts }()
			case <-r.Context().Done():
				return
			}
		}
		b, err := io.ReadAll(r.Body)
		if err != nil {
			var tooBig *http.MaxBytesError
			if errors.As(err, &tooBig) {
				writeErr(w, http.StatusRequestEntityTooLarge, "too_large", "the request is larger than this path accepts")
				return
			}
			writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
			return
		}
		req, err := route.parseReq(b)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
			return
		}
		answer, err := s.Control.Forward(r.Context(), route.op, req, route.answerMax, route.timeout)
		if err != nil {
			shareErr(w, route.op, err)
			return
		}
		if err := route.checkResp(answer); err != nil {
			writeErr(w, http.StatusBadGateway, "control_refused", "control's answer to "+string(route.op)+" is not the contract's: "+err.Error())
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(answer)
	}
}

// shareErr maps control's refusals for the share ops. The runtime tells them apart by the code, which control puts in
// details.code (share_taken, share_limit, bad_expiry, device_unclaimed) or in its error code (device_revoked): both
// lead the message ("<code> <details.code>: …", or the one there is), where the 300-character cut can't reach them.
func shareErr(w http.ResponseWriter, op device.DeviceOpName, err error) {
	switch {
	case errors.Is(err, controlapi.ErrTooLarge):
		writeErr(w, http.StatusRequestEntityTooLarge, "too_large", err.Error())
	case errors.Is(err, controlapi.ErrUnavailable):
		w.Header().Set("Retry-After", "300")
		writeErr(w, http.StatusServiceUnavailable, "control_unreachable", "control can't be reached now: "+err.Error())
	default:
		writeErr(w, http.StatusBadGateway, "control_refused", fmt.Sprintf("%s: control refused %s: %v", refusalCodes(err), op, err))
	}
}

// refusalCodes is how a refusal's message starts: control's error code and its details.code, once when they are the
// same (control's validation_failed is both), the one there is, or "refused" without either.
func refusalCodes(err error) string {
	code, detail := controlapi.ErrorCodes(err)
	switch {
	case code != "" && detail != "" && detail != code:
		return code + " " + detail
	case code != "":
		return code
	case detail != "":
		return detail
	default:
		return "refused"
	}
}
