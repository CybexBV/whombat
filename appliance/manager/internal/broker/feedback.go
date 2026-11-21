package broker

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi"
	"github.com/CybexBV/whombat/contracts/go/device"
	"github.com/CybexBV/whombat/contracts/go/local"
)

// The feedback drop (Whombat FD-06, FD-21, FD-38; MG-39): the runtime publishes its site cards, pulls sealed reports
// and acknowledges them through three socket paths, and publishes its reporters' report statuses through a fourth
// (contracts 0.25, CT-164; MG-58); the manager signs the matching device op with the management key
// and returns control's answer as control sent it. It checks requests and answers against the contract schemas and
// never opens a card or an envelope (it holds no content key). Bodies are never logged.

// feedbackAnswerMaxBytes is what the manager reads of control's answer to a card sync or an ack (FD-33: 1 MiB).
const feedbackAnswerMaxBytes = 1 << 20

// feedbackReportersMaxJSON is the compact JSON of the largest feedback.reporters.publish body the contract allows:
// FeedbackReportersPublishMax updates and as many removals, every member at its longest (MG-58). The runtime's
// request may be twice that (room for another encoding of the same values); the signed request control gets is the
// compact re-encoding, well below DeviceRequestMaxBytes. Control's answer is `{"ok":true}` or an error body: 4 KiB.
var feedbackReportersMaxJSON = maxReportersPublishJSON()

var (
	feedbackReportersRequestMax = int64(2 * feedbackReportersMaxJSON)
	feedbackReportersAnswerMax  = int64(4 << 10)
)

func maxReportersPublishJSON() int {
	const epochMax = 4102444800 // the schema's maximum for receivedAt/updatedAt
	longest := func(values []device.FeedbackReporterStatus) device.FeedbackReporterStatus {
		var l device.FeedbackReporterStatus
		for _, v := range values {
			if len(v) > len(l) {
				l = v
			}
		}
		return l
	}
	site := "fbs_" + strings.Repeat("A", 24)
	ref := "FB-AAAA-AAAA"
	body := device.FeedbackReportersPublishRequest{}
	for range device.FeedbackReportersPublishMax {
		body.Updates = append(body.Updates, device.FeedbackReporterUpdate{Site: site, ReporterID: "fbr_" + strings.Repeat("A", 22),
			Reference: ref, Type: device.FeedbackReportTypeFeature, Status: longest(device.FeedbackReporterStatusValues),
			ReceivedAt: epochMax, UpdatedAt: epochMax})
		body.Removals = append(body.Removals, device.FeedbackReporterRemoval{Site: site, Reference: ref})
	}
	b, err := json.Marshal(body)
	if err != nil {
		panic(err)
	}
	return len(b)
}

type feedbackRoute struct {
	op         device.DeviceOpName
	requestMax int64         // the runtime's request body (FD-32: 4 MiB for a card sync, else 64 KiB; MG-58)
	answerMax  int64         // control's answer (FD-33: 64 MiB for a pull, else 1 MiB; MG-58)
	timeout    time.Duration // the whole exchange with control; below the runtime's own timeout for the path
	parseReq   func([]byte) (any, error)
	checkResp  func([]byte) error
}

// The runtime waits 30 s for a card sync, 120 s for a pull and 10 s for an ack or a reporters publish (its ManagerSocketClient): the
// manager gives up a little earlier, so the runtime hears 503 and retries rather than timing out on the socket.
var feedbackRoutes = map[string]feedbackRoute{
	local.ManagerPathFeedbackCards: {
		op: device.DeviceOpNameFeedbackCardsSync, requestMax: device.FeedbackCardsSyncMaxBytes,
		answerMax: feedbackAnswerMaxBytes, timeout: 25 * time.Second,
		parseReq: func(b []byte) (any, error) { return local.ParseRuntimeFeedbackCardsRequest(b) },
		checkResp: func(b []byte) error {
			_, err := local.ParseRuntimeFeedbackCardsResponse(b)
			return err
		},
	},
	local.ManagerPathFeedbackPull: {
		op: device.DeviceOpNameFeedbackDropsPull, requestMax: device.DeviceRequestMaxBytes,
		answerMax: device.FeedbackPullResponseMaxBytes, timeout: 110 * time.Second,
		parseReq: func(b []byte) (any, error) { return local.ParseRuntimeFeedbackPullRequest(b) },
		checkResp: func(b []byte) error {
			_, err := local.ParseRuntimeFeedbackPullResponse(b)
			return err
		},
	},
	// feedback.reporters.publish (CT-164, MG-58): the runtime's socket client waits 10 s, as for an ack.
	local.ManagerPathFeedbackReporters: {
		op: device.DeviceOpNameFeedbackReportersPublish, requestMax: feedbackReportersRequestMax,
		answerMax: feedbackReportersAnswerMax, timeout: 8 * time.Second,
		parseReq: func(b []byte) (any, error) { return local.ParseRuntimeFeedbackReportersRequest(b) },
		checkResp: func(b []byte) error {
			_, err := local.ParseRuntimeFeedbackReportersResponse(b)
			return err
		},
	},
	local.ManagerPathFeedbackAck: {
		op: device.DeviceOpNameFeedbackDropsAck, requestMax: device.DeviceRequestMaxBytes,
		answerMax: feedbackAnswerMaxBytes, timeout: 8 * time.Second,
		parseReq: func(b []byte) (any, error) { return local.ParseRuntimeFeedbackAckRequest(b) },
		checkResp: func(b []byte) error {
			_, err := local.ParseRuntimeFeedbackAckResponse(b)
			return err
		},
	},
}

func (s *Server) feedback(route feedbackRoute) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.noControl(w) {
			return
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
			s.feedbackErr(w, route.op, err)
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

// feedbackErr maps control's refusals for the feedback ops (FD-21, FD-38): a control with the drop switched off (404
// feedback_drop_off) is 501 unsupported; 409 (an unclaimed device, device_unclaimed) passes through with control's
// reason; unreachable is 503 as for every op; a request above the op's limit is 413 too_large; anything else is 502
// control_refused. The broker never answers 404 on these paths: the runtime reads 404 as an older manager
// (unsupported).
func (s *Server) feedbackErr(w http.ResponseWriter, op device.DeviceOpName, err error) {
	var he *controlapi.HTTPError
	code, detail := controlapi.ErrorCodes(err)
	switch {
	case errors.Is(err, controlapi.ErrTooLarge):
		writeErr(w, http.StatusRequestEntityTooLarge, "too_large", err.Error())
	case errors.Is(err, controlapi.ErrUnavailable):
		s.controlErr(w, err)
	case errors.As(err, &he) && feedbackUnsupported(he.Status, detail):
		writeErr(w, http.StatusNotImplemented, "unsupported", "control does not support "+string(op))
	case errors.As(err, &he) && he.Status == http.StatusConflict:
		reason := detail
		if reason == "" {
			reason = code
		}
		if reason == "" {
			reason = "conflict"
		}
		writeErr(w, http.StatusConflict, reason, err.Error())
	default:
		writeErr(w, http.StatusBadGateway, "control_refused", err.Error())
	}
}

// feedbackUnsupported: control has the drop switched off (404 feedback_drop_off).
func feedbackUnsupported(status int, detail string) bool {
	return status == http.StatusNotFound && detail == "feedback_drop_off"
}
