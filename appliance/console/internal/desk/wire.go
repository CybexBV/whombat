package desk

// The desk socket's shapes: contracts 0.123.0 `local` (DESK_PATHS, CT-517…, CT-538…, CT-590…, CT-601…, CT-646…,
// CT-660…, CT-700…, CT-860…, CT-890…, CT-970…, CT-1065; the paired agent's `face`, OA-08), validated by the generated parsers against the contract's JSON Schemas (display texts as
// ConsoleDisplayText, the bounds, the enums). Members the console doesn't clean (the lock's `stays`, the camera's
// `presence`) pass as sent.

import (
	"errors"
	"regexp"

	"github.com/CybexBV/whombat/contracts/go/local"
)

type (
	State         = local.DeskState
	Paired        = local.DeskPaired
	Lock          = local.DeskLock
	Glance        = local.DeskGlance
	Ask           = local.DeskAsk
	Server        = local.DeskServer
	Power         = local.DeskPower
	Talk          = local.DeskTalk
	UnlockAnswer  = local.DeskUnlockAnswer
	PhoneAnswer   = local.DeskPhoneUnlockAnswer
	TouchAnswer   = local.DeskTouchAnswer
	Ack           = local.DeskAck
	TalkStarted   = local.DeskTalkStarted
	TalkRequest   = local.DeskTalkRequest
	UnlockRequest = local.DeskUnlockRequest
	DecideRequest = local.DeskDecideRequest
	Request       = local.DeskRequest
	TalkRef       = local.DeskTalkRef
	Box           = local.DeskBox
	// 0.108 (CT-663, CT-664).
	DecideAnswer   = local.DeskDecideAnswer
	Session        = local.DeskTalkSession
	SessionMessage = local.DeskSessionMessage
	// 0.110 (CT-700): found on your network.
	Found     = local.DeskFound
	FoundItem = local.DeskFoundItem
	// 0.115 (CT-863, CT-864): every server, and a server's own screen.
	ServersAnswer = local.DeskServersAnswer
	ServerRequest = local.DeskServerRequest
	ServerPage    = local.DeskServerPage
	// 0.116 (CT-890…CT-895, TF-14…TF-17): an ask's wider choices, the assistant working in the conversation, a task's row.
	AskChoice      = local.DeskAskChoice
	SessionWorking = local.DeskSessionWorking
	SessionTask    = local.DeskSessionTask
	// 0.118 (CT-970, DK-93): what needs a look, in Needs you; 0.122 (CT-1065, QN-20) with its line, kind, Ignore's
	// words and question.
	Look       = local.DeskLook
	LookNotice = local.DeskLookNotice
	// 3.5 (Whombat look-research.md): what the assistant found out about a look.
	LookResearch = local.DeskLookResearch
)

// Bounds of the contract's display texts (code points); the console cuts to them again after cleaning.
const (
	maxName     = 40
	maxStatus   = 200
	maxTitle    = 120
	maxWhere    = 40
	maxDetail   = 400
	maxFact     = 80
	maxLabel    = 40
	maxDoneText = 120
	maxNote     = 40
	maxValue    = 24
	maxTileText = 48
	maxUp       = 40 // This Whombat (DK-22): the uptime note,
	maxFigure   = 8  // a figure's value and unit,
	maxBoxText  = 16 // a total, a part, a rate
	maxQuestion = local.DeskQuestionMax
	maxAnswer   = local.DeskAnswerMax
	// Found on your network (DF-01, DF-08): a service's name, its short line and its address.
	maxFoundName    = 60
	maxFoundTagline = 40
	maxFoundAddress = 120
	// A server's own screen (0.115, DK-83): its OS, a guest's name, an alert's title.
	maxOS         = 60
	maxGuestName  = 60
	maxAlertTitle = 120
	// 0.116 (TF-14, TF-15, TF-17): a wider choice's label, who asks, what the assistant is doing, a task's title.
	maxChoice    = 120
	maxFrom      = 40
	maxDoing     = 120
	maxTaskTitle = 120
	// 0.118 (DK-93): a look's key (the thing's id) and its reason; its name is maxName.
	maxLookKey = 120
	// The calm glance (3.2, CG-350): its sentence and a moment's detail.
	maxCalmHeadline = 80
	maxCalmDetail   = 80
	maxLookReason   = 120
	// 0.122 (QN-20): when you'll hear again after Ignore, and the line's own question.
	maxLookWords    = 60
	maxLookQuestion = 300
	// 3.5 (look-research.md, CG-370): the assistant's title and summary for a look, and the label of the step it offers.
	maxResearchTitle   = 80
	maxResearchSummary = 240
	maxFixLabel        = 32
)

// A talk id (DeskTalkRef's pattern).
var idRe = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)

// ValidID reports whether s is a talk id the socket accepts.
func ValidID(s string) bool { return idRe.MatchString(s) }

// ParseState validates the runtime's DeskState: the schema, then its consistency (DeskStateValid: the lock's times in
// their states, an ask's words only while unlocked, nothing shown for nobody paired, This Whombat as `box` only without
// servers and tiles and as `self` only beside them, neither in *Only the time*, the extra servers and tiles only beside
// four, the camera only while unlocked, `stays` only while unlocked, a presence only while paired, found on your
// network not in *Only the time* and consistent (DeskFoundValid), …).
func ParseState(data []byte) (*State, error) {
	st, err := local.ParseDeskState(data)
	if err != nil {
		return nil, err
	}
	if !local.DeskStateValid(*st) {
		return nil, errors.New("desk state: inconsistent")
	}
	return st, nil
}

// ParseServerPage validates DeskServerPage (POST /v1/desk/server, 0.115): the schema, then its consistency
// (DeskServerPageValid: the card's id, the series of one length, no more alert titles than counted, no more guests than
// running and off) and that it is the page of the server asked for (CT-866): no page otherwise.
func ParseServerPage(data []byte, id string) (*ServerPage, error) {
	p, err := local.ParseDeskServerPage(data)
	if err != nil {
		return nil, err
	}
	if !local.DeskServerPageValid(*p) || p.Server.ID == nil || *p.Server.ID != id {
		return nil, errors.New("desk server page: inconsistent or another server's")
	}
	return p, nil
}

// ParseSession validates DeskTalkSession (POST /v1/desk/talk/session, 0.108): the schema, then `until` exactly while
// open and nothing in a closed one, `working` only while open, a task's end and result only once it ended and never a
// task beside an ask (DeskTalkSessionValid, 0.116).
func ParseSession(data []byte) (*Session, error) {
	s, err := local.ParseDeskTalkSession(data)
	if err != nil {
		return nil, err
	}
	if !local.DeskTalkSessionValid(*s) {
		return nil, errors.New("desk session: inconsistent")
	}
	return s, nil
}

// ParseTalk validates DeskTalk (POST /v1/desk/talk/get).
func ParseTalk(data []byte) (*Talk, error) {
	t, err := local.ParseDeskTalk(data)
	if err != nil {
		return nil, err
	}
	if !local.DeskTalkValid(*t) {
		return nil, errors.New("desk talk: inconsistent")
	}
	return t, nil
}
