package model

import (
	"time"

	"rackoon/internal/proto"
	"rackoon/internal/rules"
)

// A Mac (Whombat docs/decisions/macos-servers.md): its facts in the server
// detail, its os family and the hints about its screen and helper.

// OS families (FleetServer.OSFamily, DetailServer.OSFamily).
const (
	OSFamilyLinux = "linux"
	OSFamilyMacOS = "macos"
)

// OSFamily is the server's system: "macos" for a Mac's agent, "linux"
// for every other report, "" before the first one.
func OSFamily(r *proto.Report) string {
	switch {
	case r == nil:
		return ""
	case r.MacOS != nil || r.Agent.OS == "darwin":
		return OSFamilyMacOS
	}
	return OSFamilyLinux
}

// MacOSDetail is GET /servers/{id}'s "macos" block.
type MacOSDetail struct {
	Version     string          `json:"version"`
	Build       *string         `json:"build"`
	Model       *string         `json:"model"`
	ModelName   *string         `json:"model_name"`
	Chip        *string         `json:"chip"`
	SIP         *bool           `json:"sip"`
	FileVault   *bool           `json:"filevault"`
	AutoLogin   *string         `json:"auto_login"`
	ConsoleUser *string         `json:"console_user"`
	Screen      MacScreenDetail `json:"screen"`
	Helper      MacHelperDetail `json:"helper"`
}

// MacScreenDetail is the Mac's screen through Screen Sharing.
type MacScreenDetail struct {
	Sharing  bool    `json:"sharing"`
	Account  *string `json:"account"`
	SignIn   *string `json:"sign_in"` // ok | failed; null: not tried
	SignInAt *Time   `json:"sign_in_at"`
	Locked   *bool   `json:"locked"`
	W        *int    `json:"w"`
	H        *int    `json:"h"`
}

// MacHelperDetail is Whombat Helper on the Mac.
type MacHelperDetail struct {
	Installed bool    `json:"installed"`
	Version   *string `json:"version"`
	Running   bool    `json:"running"`
	AX        *bool   `json:"ax"`
	User      *string `json:"user"`
	// Latest is the helper build the hub has (null: none); Update how this
	// Mac's helper follows it (the hub fills both in GET /servers/{id}).
	Latest *string          `json:"latest"`
	Update *MacHelperUpdate `json:"update"`
}

// MacHelperUpdate is how a Mac's Whombat Helper follows the hub's build
// (GET /agents' "helper", the detail's macos.helper.update): the agents'
// update object with the Mac's own helper version.
type MacHelperUpdate struct {
	Available bool   `json:"available"`
	Version   string `json:"version,omitempty"`   // the hub's helper build
	Installed string `json:"installed,omitempty"` // the Mac's helper version
	Reason    string `json:"reason,omitempty"`    // English
	// ReasonCode: no_build, not_connected, up_to_date, unsupported,
	// no_key, other_key, turned_off, host_shell_off, newer_running.
	ReasonCode    string `json:"reason_code,omitempty"`
	Auto          bool   `json:"auto"`
	State         string `json:"state,omitempty"`       // updating | failed | waiting | halted
	WaitingFor    string `json:"waiting_for,omitempty"` // agent | packages | console | task
	Message       string `json:"message,omitempty"`
	FailedVersion string `json:"failed_version,omitempty"`
	UpdatedAt     string `json:"updated_at,omitempty"` // the last successful update (RFC 3339)
}

// BuildMacOS builds the "macos" block (nil when the report has none).
func BuildMacOS(r *proto.Report) *MacOSDetail {
	if r == nil || r.MacOS == nil {
		return nil
	}
	m := r.MacOS
	d := &MacOSDetail{Version: m.Version, Build: strp(m.Build), Model: strp(m.Model), ModelName: strp(m.ModelName),
		Chip: strp(m.Chip), SIP: m.SIP, FileVault: m.FileVault, AutoLogin: strp(m.AutoLogin), ConsoleUser: strp(m.ConsoleUser)}
	s := m.Screen
	d.Screen = MacScreenDetail{Sharing: s.Sharing, Account: strp(s.Account), SignIn: strp(s.SignIn), Locked: s.Locked}
	if !s.SignInAt.IsZero() {
		d.Screen.SignInAt = T(s.SignInAt)
	}
	if s.Width > 0 && s.Height > 0 {
		w, h := s.Width, s.Height
		d.Screen.W, d.Screen.H = &w, &h
	}
	h := m.Helper
	d.Helper = MacHelperDetail{Installed: h.Installed, Version: strp(h.Version), Running: h.Running, AX: h.Accessibility, User: strp(h.User)}
	return d
}

// Hint kinds of a Mac. Whombat starts all of them off (MAC-10): they show
// on the Mac's page and are watched only when the person turns them on.
const (
	HintMacHelperOff      = "macos.helper_off"
	HintMacHelperNoAccess = "macos.helper_no_access"
	HintMacScreenSignIn   = "macos.screen_sign_in"
	HintMacSharingOff     = "macos.screen_sharing_off"
	HintMacAgentFolder    = "macos.agent_folder"
)

// HelperOffAfter is how long the helper may be missing from the screen's
// session before macos.helper_off says so (it starts with the session).
const HelperOffAfter = 5 * time.Minute

// LinkScreen is the Mac page's screen section.
const LinkScreen = "#screen"

// HelperOffSince follows how long the installed helper has not answered
// in the session of the person at the screen: the time it was first seen
// missing (kept from prev), zero while it runs, isn't installed or nobody
// is at the screen.
func HelperOffSince(prev time.Time, r *proto.Report, now time.Time) time.Time {
	if r == nil || r.MacOS == nil {
		return time.Time{}
	}
	h := r.MacOS.Helper
	if !h.Installed || h.Running || r.MacOS.ConsoleUser == "" {
		return time.Time{}
	}
	if prev.IsZero() {
		return now
	}
	return prev
}

// macHints are a Mac's screen and helper hints.
func macHints(s *ServerState, now time.Time) []rules.Hint {
	r := s.Report
	if r == nil || r.MacOS == nil {
		return nil
	}
	m := r.MacOS
	var out []rules.Hint
	if !m.Screen.Sharing {
		out = append(out, rules.Hint{Kind: HintMacSharingOff, Severity: rules.HintInfo, Entity: "screen", Link: LinkScreen,
			Title: "Screen Sharing is off", Detail: "Turn it on in System Settings → General → Sharing so Whombat can see the screen"})
	}
	if m.Screen.SignIn == "failed" {
		out = append(out, rules.Hint{Kind: HintMacScreenSignIn, Severity: rules.HintWarning, Entity: "screen", Link: LinkScreen,
			Title: "Whombat can’t sign in to the Mac’s screen", Detail: "The Mac’s password was refused; set it again"})
	}
	if m.AgentFolder != "" {
		out = append(out, rules.Hint{Kind: HintMacAgentFolder, Severity: rules.HintInfo, Entity: "agent", Link: rules.LinkAgent,
			Title:  "Whombat’s agent is in a folder others can change",
			Detail: "Run the Mac’s install command again to move it out of " + m.AgentFolder})
	}
	h := m.Helper
	switch {
	case h.Running && h.Accessibility != nil && !*h.Accessibility:
		out = append(out, rules.Hint{Kind: HintMacHelperNoAccess, Severity: rules.HintInfo, Entity: "helper", Link: LinkScreen,
			Title: "Whombat Helper needs Accessibility", Detail: "Switch it on in Privacy & Security → Accessibility"})
	case !s.MacHelperOffSince.IsZero() && now.Sub(s.MacHelperOffSince) >= HelperOffAfter:
		d := "It starts when someone logs in to the Mac"
		if m.ConsoleUser != "" {
			d = "It isn’t running for " + m.ConsoleUser
		}
		out = append(out, rules.Hint{Kind: HintMacHelperOff, Severity: rules.HintInfo, Entity: "helper", Link: LinkScreen,
			Title: "Whombat Helper isn’t running", Detail: d})
	}
	return out
}
