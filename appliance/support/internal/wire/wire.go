// Package wire is the support service's names for the support socket's shapes (contracts 0.120.0, CT-930…CT-942;
// Whombat RH-01…RH-13): aliases of the generated `local` and `protocol` types, the contract's limits, and its enum values
// as untyped constants, so they compare with plain strings (Gate.Level) and assign to the generated enum types alike
// (wire_test checks each against the generated value).
//
// Socket /run/whombat-support/api.sock, HTTP/1.1 JSON, callers by uid (SO_PEERCRED): the runtime server everything, the
// manager `state` only (without the help code), root everything. Every body carries `v: 1`; a grant's time is a
// duration's name (hour, day, week, forever), never seconds.
package wire

import (
	"crypto/rand"
	"crypto/subtle"

	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// The shapes.
type (
	State        = local.SupportState           // GET /v1/state
	Grant        = local.SupportGrant           // the grant and its wrong codes
	GrantRequest = local.SupportGrantRequest    // POST /v1/grant
	StopRequest  = local.SupportStopRequest     // POST /v1/stop
	Visits       = local.SupportVisitsAnswer    // GET /v1/visits
	Event        = local.SupportEvent           // one of GET /v1/events
	Events       = local.SupportEventsAnswer    // GET /v1/events
	Person       = protocol.RemoteHelpGrantedBy // who granted or stopped it: { accountId, name }
	Connected    = protocol.RemoteHelpConnected
	Visit        = protocol.RemoteHelpVisit // one certificate's visit, its newest StepsShown steps oldest first
	Step         = protocol.RemoteHelpStep  // one thing support did
)

// Paths of the support socket (SUPPORT_PATHS).
const (
	SocketDefault  = local.SupportSocketDefault
	PathState      = local.SupportPathState
	PathGrant      = local.SupportPathGrant
	PathStop       = local.SupportPathStop
	PathVisits     = local.SupportPathVisits
	PathTranscript = local.SupportPathTranscript
	PathEvents     = local.SupportPathEvents
)

// Error codes of the support socket ({ error: { code } }, SUPPORT_ERRORS); ErrorStatus gives their HTTP status.
const (
	ErrForeverNotAllowed = local.SupportErrorForeverNotAllowed
	ErrUnavailable       = local.SupportErrorUnavailable
	ErrBadRequest        = local.SupportErrorBadRequest
	ErrTooLarge          = local.SupportErrorTooLarge
	ErrNotFound          = local.SupportErrorNotFound
	ErrForbidden         = local.SupportErrorForbidden
)

// ErrorStatus is SUPPORT_ERROR_STATUS.
var ErrorStatus = local.SupportErrorStatus

// Bounds of the socket and of remote help (SUPPORT_*, REMOTE_HELP_LIMITS).
const (
	RequestMaxBytes         = local.SupportRequestMaxBytes
	EventsWaitMaxS          = local.SupportEventsWaitMaxS
	EventsMax               = local.SupportEventsMax
	ConnectedMax            = local.RemoteHelpConnectedMax
	VisitsMax               = local.RemoteHelpVisitsMax
	VisitIdleS              = local.RemoteHelpVisitIdleS
	KeepDays                = local.RemoteHelpKeepDays
	KeepBytes               = local.RemoteHelpKeepBytes
	WrongCodes              = local.RemoteHelpWrongCodes
	StepsPerVisit           = local.RemoteHelpStepsPerVisit
	StepsShown              = local.RemoteHelpStepsShown
	CommandLineChars        = local.RemoteHelpCommandLineChars
	NameChars               = local.RemoteHelpNameChars
	TranscriptBytesPerVisit = local.RemoteHelpTranscriptBytesPerVisit
	UnitPattern             = local.RemoteHelpUnitPattern
)

// Levels (protocol.RemoteHelpLevel).
const (
	LevelLook = "look"
	LevelFix  = "fix"
)

// Environments (local.SupportEnvironment, the image's whombat.environment).
const (
	EnvLocal = "local"
	EnvDev   = "dev"
	EnvProd  = "prod"
)

// Durations (protocol.RemoteHelpDuration) and the seconds a grant may last (nil is forever).
const (
	DurationHour    = "hour"
	DurationDay     = "day"
	DurationWeek    = "week"
	DurationForever = "forever"
)

// DurationsS are the seconds of the durations that end.
var DurationsS = []int64{local.RemoteHelpDurationHourS, local.RemoteHelpDurationDayS, local.RemoteHelpDurationWeekS}

// DurationSeconds is a duration's seconds: nil for forever; ok false for a name it doesn't know.
func DurationSeconds(name string) (seconds *int64, ok bool) {
	return local.RemoteHelpDurationSeconds(protocol.RemoteHelpDuration(name))
}

// DurationName is the duration of a grant's seconds (nil: forever); ok false for seconds that aren't one.
func DurationName(seconds *int64) (name string, ok bool) {
	for _, d := range protocol.RemoteHelpDurationValues {
		s, _ := DurationSeconds(string(d))
		if (s == nil && seconds == nil) || (s != nil && seconds != nil && *s == *seconds) {
			return string(d), true
		}
	}
	return "", false
}

// Stop reasons a caller gives (local.SupportStopReason): an owner in the app (with by) or someone at the box's screen.
const (
	StopOwner = "owner"
	StopDesk  = "desk"
)

// Step kinds (protocol.RemoteHelpStepKind) and refusal reasons (protocol.RemoteHelpRefusal).
const (
	StepConnected = "connected"
	StepLeft      = "left"
	StepLook      = "look"
	StepExec      = "exec"
	StepShell     = "shell"
	StepRestart   = "restart"
	StepForward   = "forward"
	StepRefused   = "refused"
	StepWrongCode = "wrong_code"

	ReasonLevel          = "level"
	ReasonCode           = "code"
	ReasonCertificate    = "certificate"
	ReasonLimit          = "limit"
	ReasonUnknownCommand = "unknown_command"
	ReasonBadArguments   = "bad_arguments"
)

// LookCommands are the read-only commands of the Look level (protocol.LookCommand).
var LookCommands = func() []string {
	out := make([]string, len(protocol.LookCommandValues))
	for i, c := range protocol.LookCommandValues {
		out[i] = string(c)
	}
	return out
}()

// Event kinds (local.SupportEventKind).
const (
	EventGrant      = "grant"
	EventStop       = "stop"
	EventExpired    = "expired"
	EventVisitStart = "visit_start"
	EventVisitEnd   = "visit_end"
	EventLockedOut  = "locked_out"
)

// HelpCodeLength and HelpCodeAlphabet (HELP_CODE_LENGTH; Crockford, no I L O U).
const (
	HelpCodeLength   = local.HelpCodeLength
	HelpCodeAlphabet = local.HelpCodeAlphabet
)

// NewHelpCode draws a help code from crypto/rand.
func NewHelpCode() (string, error) { return local.GenerateHelpCode(rand.Reader) }

// NormalizeHelpCode is local.NormalizeHelpCode: the separators dropped, upper case, O read as 0 and I and L as 1; ""
// when it isn't a help code.
func NormalizeHelpCode(s string) string {
	code, ok := local.NormalizeHelpCode(s)
	if !ok {
		return ""
	}
	return code
}

// HelpCodeMatches compares what someone typed with the grant's code, in constant time. Never log either.
func HelpCodeMatches(typed, code string) bool {
	n := NormalizeHelpCode(typed)
	if n == "" || len(code) != HelpCodeLength {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(n), []byte(code)) == 1
}

// Who names a visitor from their certificate's key id (local.RemoteHelpWho): "Claude (op_7Hq2 via john)" → "Claude".
func Who(keyID string) string { return local.RemoteHelpWho(keyID) }

// StepValid, StateValid and EventValid check what one schema can't (local.RemoteHelpStepValid, SupportStateValid,
// SupportEventValid).
func StepValid(s Step) bool   { return local.RemoteHelpStepValid(s) }
func StateValid(s State) bool { return local.SupportStateValid(s) }
func EventValid(e Event) bool { return local.SupportEventValid(e) }

// Ptr is a pointer to v: the generated shapes' optional members are pointers.
func Ptr[T any](v T) *T { return &v }
