package broker

// The backup kit's locked copies (Whombat backup-passkey.md, the envelope push): the runtime hands the manager the
// recovery material locked with each of the person's passkeys, and the manager stores them at control, signed like its
// status reports, so a new Whombat can bring this one back with a passkey touch.
//
//	POST /v1/backup/kit-envelopes {envelopes: [{credentialId, salt, envelope, generation}], adoptedFrom?, applianceName?}  runtime
//	     → 200 {stored, skipped} | 503 control_unreachable (the runtime tries again later)
//
// The body and the answer are the contracts' (local.RuntimeKitEnvelopesRequest/Response), exactly those of control's
// device op kit.envelopes.put, so the push goes on unchanged.

import (
	"errors"
	"net/http"

	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi"
	"github.com/CybexBV/whombat/contracts/go/device"
	"github.com/CybexBV/whombat/contracts/go/local"
)

// PathBackupKitEnvelopes is the runtime's route (the runtime is its only caller).
const PathBackupKitEnvelopes = local.ManagerPathKitEnvelopes

// kitEnvelopesBodyMax: the push has to fit a signed device request.
const kitEnvelopesBodyMax = device.DeviceRequestMaxBytes

func (s *Server) backupKitEnvelopes(w http.ResponseWriter, r *http.Request) {
	if s.noControl(w) {
		return
	}
	b, ok := readBody(w, r)
	if !ok {
		return
	}
	req, err := local.ParseRuntimeKitEnvelopesRequest(b)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	var out local.RuntimeKitEnvelopesResponse
	if err := s.Control.Do(r.Context(), device.DeviceOpNameKitEnvelopesPut, req, &out); err != nil {
		if errors.Is(err, controlapi.ErrUnavailable) {
			w.Header().Set("Retry-After", "300")
			writeErr(w, http.StatusServiceUnavailable, "control_unreachable", "control can't be reached now: "+err.Error())
			return
		}
		writeErr(w, http.StatusBadGateway, "control_refused", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, out)
}
