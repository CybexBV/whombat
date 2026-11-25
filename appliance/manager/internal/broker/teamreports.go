package broker

// Reports to the Whombat Team (Whombat team-reports.md): the person tells the team behind Whombat about a problem or an
// idea, and follows the answers. Control keeps the reports; the runtime passes the person's words on and reads the
// team's answers back. The words travel as base64url JSON inside the device ops' bodies, so the manager forwards them
// without reading them: it checks the runtime's body against the contract, signs the device op with the management key
// and answers control's body as control sent it.
//
//	POST /v1/runtime/team-reports/list   {}                                runtime → 200 {available, reason, reports}
//	POST /v1/runtime/team-reports/get    {reportId}                        runtime → 200 {report}
//	POST /v1/runtime/team-reports/create {requestId, payload}              runtime → 200 {report}
//	POST /v1/runtime/team-reports/reply  {requestId, reportId, payload}    runtime → 200 {report}
//	POST /v1/runtime/team-reports/act    {requestId, reportId, action}     runtime → 200 {report | null}
//
// The same way and the same answers as the shared links (share.go), but gated like what control answers once it knows
// the box: 404 only while Link is off, or on a box without control. A person whose Link ended can still read their
// reports and withdraw one; control alone decides what each Link state may do (sending needs Link on or in grace) and
// says so with its code. 503 control_unreachable with Retry-After while control is out of reach; 502 control_refused
// with control's codes first in the message (team_reports_unavailable, not_invited, link_off, report_unknown,
// report_closed, rate_limited …); 413 too_large above a path's limit.

import (
	"time"

	"github.com/CybexBV/whombat/contracts/go/device"
	"github.com/CybexBV/whombat/contracts/go/local"
)

// The runtime's paths (the runtime is their only caller).
const (
	PathTeamReportsList   = local.ManagerPathTeamReportsList
	PathTeamReportsGet    = local.ManagerPathTeamReportsGet
	PathTeamReportsCreate = local.ManagerPathTeamReportsCreate
	PathTeamReportsReply  = local.ManagerPathTeamReportsReply
	PathTeamReportsAct    = local.ManagerPathTeamReportsAct
)

// The runtime waits 30 s for a team report path; the manager gives up a little earlier so the runtime hears 503 rather
// than timing out on the socket. Nothing here is large on the way up: what a person writes fits in a few KiB.
const teamReportsTimeout = 25 * time.Second

// Control's answer: a whole report (or the list) of up to TeamPayloadAnswerMaxBytes as base64url, which is a third
// larger than the payload itself, and the few fields around it.
const teamReportsAnswerMax = (device.TeamPayloadAnswerMaxBytes*4+2)/3 + 4<<10

// Every request body is the op's own: at most 64 KiB, the size of a device request. Each route needs only that control
// knows the box (needKnown).
var teamReportRoutes = map[string]shareRoute{
	PathTeamReportsList: {
		op: device.DeviceOpNameTeamReportsList, requestMax: device.DeviceRequestMaxBytes, answerMax: teamReportsAnswerMax, timeout: teamReportsTimeout, need: needKnown,
		parseReq: func(b []byte) (any, error) { return local.ParseRuntimeTeamReportsListRequest(b) },
		checkResp: func(b []byte) error {
			_, err := local.ParseRuntimeTeamReportsListResponse(b)
			return err
		},
	},
	PathTeamReportsGet: {
		op: device.DeviceOpNameTeamReportsGet, requestMax: device.DeviceRequestMaxBytes, answerMax: teamReportsAnswerMax, timeout: teamReportsTimeout, need: needKnown,
		parseReq: func(b []byte) (any, error) { return local.ParseRuntimeTeamReportsGetRequest(b) },
		checkResp: func(b []byte) error {
			_, err := local.ParseRuntimeTeamReportsGetResponse(b)
			return err
		},
	},
	PathTeamReportsCreate: {
		op: device.DeviceOpNameTeamReportsCreate, requestMax: device.DeviceRequestMaxBytes, answerMax: teamReportsAnswerMax, timeout: teamReportsTimeout, need: needKnown,
		parseReq: func(b []byte) (any, error) { return local.ParseRuntimeTeamReportsCreateRequest(b) },
		checkResp: func(b []byte) error {
			_, err := local.ParseRuntimeTeamReportsCreateResponse(b)
			return err
		},
	},
	PathTeamReportsReply: {
		op: device.DeviceOpNameTeamReportsReply, requestMax: device.DeviceRequestMaxBytes, answerMax: teamReportsAnswerMax, timeout: teamReportsTimeout, need: needKnown,
		parseReq: func(b []byte) (any, error) { return local.ParseRuntimeTeamReportsReplyRequest(b) },
		checkResp: func(b []byte) error {
			_, err := local.ParseRuntimeTeamReportsReplyResponse(b)
			return err
		},
	},
	PathTeamReportsAct: {
		op: device.DeviceOpNameTeamReportsAct, requestMax: device.DeviceRequestMaxBytes, answerMax: teamReportsAnswerMax, timeout: teamReportsTimeout, need: needKnown,
		parseReq: func(b []byte) (any, error) { return local.ParseRuntimeTeamReportsActRequest(b) },
		checkResp: func(b []byte) error {
			_, err := local.ParseRuntimeTeamReportsActResponse(b)
			return err
		},
	},
}
