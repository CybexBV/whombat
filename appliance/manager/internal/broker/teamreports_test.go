package broker_test

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/CybexBV/whombat/appliance/manager/internal/broker"
	"github.com/CybexBV/whombat/contracts/go/device"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

const (
	teamReport  = "tr_AAAAAAAAAAAAAAAAAAAA"
	teamRequest = "req_AAAAAAAAAAAAAAAA"
	// base64url of {"kind":"bug","text":"It stops","expected":"","context":{}}: the manager never reads it.
	teamPayload = "eyJraW5kIjoiYnVnIiwidGV4dCI6Ikl0IHN0b3BzIiwiZXhwZWN0ZWQiOiIiLCJjb250ZXh0Ijp7fX0"
)

// One good body per path.
var teamBodies = map[string]string{
	broker.PathTeamReportsList:   `{}`,
	broker.PathTeamReportsGet:    `{"reportId":"` + teamReport + `"}`,
	broker.PathTeamReportsCreate: `{"requestId":"` + teamRequest + `","payload":"` + teamPayload + `"}`,
	broker.PathTeamReportsReply:  `{"requestId":"` + teamRequest + `","reportId":"` + teamReport + `","payload":"` + teamPayload + `"}`,
	broker.PathTeamReportsAct:    `{"requestId":"` + teamRequest + `","reportId":"` + teamReport + `","action":"works"}`,
}

// Each op goes to control as the runtime sent it, signed like every device request, and control's answer comes back
// as control sent it; a body that isn't the contract's is refused before it leaves the box.
func TestTeamReportsForwarded(t *testing.T) {
	t.Parallel()
	me := uint32(os.Getuid())
	fc, sock, _ := start(t, me, nil)
	c := client(sock)
	for path, body := range teamBodies {
		resp, m := post(t, c, path, body)
		if resp.StatusCode != 200 {
			t.Fatalf("%s: %d %v", path, resp.StatusCode, m)
		}
		if path == broker.PathTeamReportsList && (m["available"] != true || m["reports"] != "eyJyZXBvcnRzIjpbXX0") {
			t.Fatalf("list: %v", m)
		}
	}
	if len(fc.TeamCalls) != len(teamBodies) || len(fc.AuthErrors) != 0 {
		t.Fatalf("control took %v (auth errors %v)", fc.TeamCalls, fc.AuthErrors)
	}
	for _, call := range fc.TeamCalls {
		if strings.HasPrefix(call, string(device.DeviceOpNameTeamReportsCreate)+" ") && !strings.Contains(call, teamPayload) {
			t.Fatalf("the payload didn't reach control as it was: %s", call)
		}
	}
	resp, m := post(t, c, broker.PathTeamReportsAct, `{"requestId":"`+teamRequest+`","reportId":"`+teamReport+`","action":"withdraw"}`)
	if resp.StatusCode != 200 || m["report"] != nil {
		t.Fatalf("withdraw: %d %v", resp.StatusCode, m)
	}

	calls := len(fc.TeamCalls)
	for path, bad := range map[string][]string{
		broker.PathTeamReportsList: {`{"all":true}`},
		broker.PathTeamReportsGet:  {`{"reportId":"tr_short"}`, `{}`},
		broker.PathTeamReportsCreate: {
			`{"requestId":"` + teamRequest + `","payload":"not base64url!"}`,
			`{"requestId":"short","payload":"` + teamPayload + `"}`,
			`{"payload":"` + teamPayload + `"}`,
		},
		broker.PathTeamReportsReply: {`{"requestId":"` + teamRequest + `","reportId":"` + teamReport + `"}`},
		broker.PathTeamReportsAct:   {`{"requestId":"` + teamRequest + `","reportId":"` + teamReport + `","action":"delete"}`},
	} {
		for _, body := range bad {
			if resp, m := post(t, c, path, body); resp.StatusCode != 400 {
				t.Fatalf("%s %s: %d %v", path, body, resp.StatusCode, m)
			}
		}
	}
	if len(fc.TeamCalls) != calls {
		t.Fatal("a refused body reached control")
	}
}

// A whole report with the longest conversation the contract allows comes back; an answer that isn't the contract's
// shape is control's fault (502), never passed on.
func TestTeamReportsAnswers(t *testing.T) {
	t.Parallel()
	me := uint32(os.Getuid())
	fc, sock, _ := start(t, me, nil)
	c := client(sock)
	big := strings.Repeat("A", (device.TeamPayloadAnswerMaxBytes*4+2)/3)
	fc.TeamAnswer = json.RawMessage(`{"report":"` + big + `"}`)
	resp, m := post(t, c, broker.PathTeamReportsGet, teamBodies[broker.PathTeamReportsGet])
	if resp.StatusCode != 200 || len(m["report"].(string)) != len(big) {
		t.Fatalf("largest answer: %d", resp.StatusCode)
	}
	fc.TeamAnswer = json.RawMessage(`{"report":"not base64url!"}`)
	if resp, m := post(t, c, broker.PathTeamReportsGet, teamBodies[broker.PathTeamReportsGet]); resp.StatusCode != 502 || errCode(m) != "control_refused" {
		t.Fatalf("a bad answer: %d %v", resp.StatusCode, m)
	}
}

// A body above 64 KiB is 413 too_large before anything leaves the box.
func TestTeamReportsTooLarge(t *testing.T) {
	t.Parallel()
	me := uint32(os.Getuid())
	fc, sock, _ := start(t, me, nil)
	huge := strings.Repeat("A", device.DeviceRequestMaxBytes)
	body := `{"requestId":"` + teamRequest + `","payload":"` + huge + `"}`
	if resp, m := post(t, client(sock), broker.PathTeamReportsCreate, body); resp.StatusCode != 413 || errCode(m) != "too_large" {
		t.Fatalf("huge create: %d %v", resp.StatusCode, m)
	}
	if len(fc.TeamCalls) != 0 {
		t.Fatal("a too large body reached control")
	}
}

// Control's refusals are 502 control_refused with control's code first in the message, so the runtime tells them
// apart; control out of reach is 503 control_unreachable with Retry-After.
func TestTeamReportsControlErrors(t *testing.T) {
	t.Parallel()
	me := uint32(os.Getuid())
	fc, sock, _ := start(t, me, nil)
	c := client(sock)
	for _, code := range []string{"report_unknown", "team_reports_unavailable", "report_closed", "rate_limited"} {
		fc.TeamRefuse = code
		for path, body := range teamBodies {
			resp, m := post(t, c, path, body)
			e, _ := m["error"].(map[string]any)
			msg, _ := e["message"].(string)
			if resp.StatusCode != 502 || e["code"] != "control_refused" || !strings.HasPrefix(msg, "refused "+code+":") {
				t.Fatalf("%s refused %s: %d %v", path, code, resp.StatusCode, m)
			}
		}
	}
	fc.TeamRefuse = ""
	fc.Down = true
	for path, body := range teamBodies {
		resp, m := post(t, c, path, body)
		if resp.StatusCode != 503 || errCode(m) != "control_unreachable" || resp.Header.Get("Retry-After") != "300" {
			t.Fatalf("%s with control down: %d %v", path, resp.StatusCode, m)
		}
	}
}

// Only the runtime asks; a box without control, or with Link off, answers 404 (the runtime reads it as no reports
// here). Once control knows the box every route goes through, also after Link ended: the person still reads their
// reports and withdraws one, and control alone says what else each Link state allows.
func TestTeamReportsGate(t *testing.T) {
	t.Parallel()
	me := uint32(os.Getuid())
	_, sock, _ := start(t, me+1, nil)
	other := client(sock)
	none := serveSupport(t, &broker.Server{RuntimeUID: me})
	for path, body := range teamBodies {
		if resp, _ := post(t, other, path, body); resp.StatusCode != 403 {
			t.Fatalf("%s from another caller: %d", path, resp.StatusCode)
		}
		if resp, _ := post(t, none, path, body); resp.StatusCode != 404 {
			t.Fatalf("%s without control: %d", path, resp.StatusCode)
		}
	}
	fl := &fakeLink{}
	fc, linkSock := startLink(t, fl)
	c := client(linkSock)
	states := []protocol.LinkState{protocol.LinkStateOff, protocol.LinkStateEnded, protocol.LinkStateStarting,
		protocol.LinkStateOn, protocol.LinkStateGrace}
	for _, st := range states {
		fl.set(st)
		known := st != protocol.LinkStateOff
		for path, body := range teamBodies {
			resp, m := post(t, c, path, body)
			if known != (resp.StatusCode == 200) || (!known && resp.StatusCode != 404) {
				t.Fatalf("%s %s: %d %v", st, path, resp.StatusCode, m)
			}
		}
	}
	if want := (len(states) - 1) * len(teamBodies); len(fc.TeamCalls) != want {
		t.Fatalf("control took %d calls, want %d: %v", len(fc.TeamCalls), want, fc.TeamCalls)
	}
}

// A withdrawal after Link ended reaches control: the person's words are theirs to take back whatever Link says.
func TestTeamReportsWithdrawAfterLinkEnded(t *testing.T) {
	t.Parallel()
	fl := &fakeLink{}
	fc, linkSock := startLink(t, fl)
	fl.set(protocol.LinkStateEnded)
	body := `{"requestId":"` + teamRequest + `","reportId":"` + teamReport + `","action":"withdraw"}`
	resp, m := post(t, client(linkSock), broker.PathTeamReportsAct, body)
	if resp.StatusCode != 200 || m["report"] != nil {
		t.Fatalf("withdraw after Link ended: %d %v", resp.StatusCode, m)
	}
	if len(fc.TeamCalls) != 1 || !strings.HasPrefix(fc.TeamCalls[0], string(device.DeviceOpNameTeamReportsAct)+" ") {
		t.Fatalf("control took %v", fc.TeamCalls)
	}
}
