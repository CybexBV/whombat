package proto

import "time"

// macOS agents (Whombat docs/decisions/macos-servers.md; the wire shapes are in
// Whombat docs/implementation/macos/assignment.md §1). Everything is additive:
// Linux agents never send these, older hubs ignore them.

// MacOS is Report.MacOS: the Mac's own facts, sent only by macOS agents.
type MacOS struct {
	Version     string    `cbor:"version"`                // "27.2.1" (sw_vers)
	Build       string    `cbor:"build,omitempty"`        // "26B131"
	Model       string    `cbor:"model,omitempty"`        // hw.model, "Mac14,14"
	ModelName   string    `cbor:"model_name,omitempty"`   // "Mac Studio"
	Chip        string    `cbor:"chip,omitempty"`         // "Apple M2 Ultra"
	SIP         *bool     `cbor:"sip,omitempty"`          // System Integrity Protection on
	FileVault   *bool     `cbor:"filevault,omitempty"`    // FileVault on
	AutoLogin   string    `cbor:"auto_login,omitempty"`   // the auto-login user; "" none
	ConsoleUser string    `cbor:"console_user,omitempty"` // at the screen now; "" = the login window
	Screen      MacScreen `cbor:"screen"`
	Helper      MacHelper `cbor:"helper"`
	// AgentFolder is the folder of the agent's own executable when someone
	// other than root can change it or a folder above it (Homebrew's
	// /usr/local/bin on an Intel Mac): a program there could swap the root
	// daemon's executable. "" when only root can.
	AgentFolder string `cbor:"agent_folder,omitempty"`
}

// MacScreen is the Mac's screen as the agent reaches it through Screen Sharing.
type MacScreen struct {
	Sharing  bool      `cbor:"sharing"`              // Screen Sharing answers on 127.0.0.1:5900
	Account  string    `cbor:"account,omitempty"`    // the user the agent signs in as; "" = not set
	SignIn   string    `cbor:"sign_in,omitempty"`    // "ok" | "failed" | "" (not tried): the last check
	SignInAt time.Time `cbor:"sign_in_at,omitempty"` // when that check ran
	Locked   *bool     `cbor:"locked,omitempty"`     // from the helper; nil = unknown
	Width    int       `cbor:"w,omitempty"`          // framebuffer size at the last sign-in
	Height   int       `cbor:"h,omitempty"`
}

// MacHelper is Whombat Helper, the app in the person's session that finds
// buttons by name (accessibility).
type MacHelper struct {
	Installed     bool   `cbor:"installed"`
	Version       string `cbor:"version,omitempty"`
	Running       bool   `cbor:"running"`        // answered on its socket within the last minute
	Accessibility *bool  `cbor:"ax,omitempty"`   // AXIsProcessTrusted() of the running helper
	User          string `cbor:"user,omitempty"` // whose session it runs in
}

// StreamScreen is the hub-opened screen RPC: ScreenRequest -> ScreenResponse,
// one per stream. The runtime needs Policy.HostShell (op "status" also
// Policy.Diagnose).
const StreamScreen = "screen"

// Screen ops.
const (
	ScreenStatus       = "status"
	ScreenLook         = "look"
	ScreenClick        = "click"
	ScreenDrag         = "drag"
	ScreenScroll       = "scroll"
	ScreenType         = "type"
	ScreenKeys         = "keys"
	ScreenUnlock       = "unlock"
	ScreenPassword     = "password" // the stored password into macOS's own password prompt in front
	ScreenAccountSet   = "account.set"
	ScreenAccountCheck = "account.check"
	ScreenAccountClear = "account.clear"
	ScreenUIApps       = "ui.apps"
	ScreenUIList       = "ui.list"
	ScreenUIPress      = "ui.press"
	ScreenUISet        = "ui.set"
	ScreenUIMenu       = "ui.menu"
	ScreenUIFocus      = "ui.focus"
	ScreenUIOpen       = "ui.open"
)

// ScreenStepLimit is how long the agent gives one screen step: 25 s, and
// 60 s for password and unlock, whose password goes one character at a time,
// each checked first. The agent's stream and the hub wait a little longer.
func ScreenStepLimit(op string) time.Duration {
	if op == ScreenPassword || op == ScreenUnlock {
		return 60 * time.Second
	}
	return 25 * time.Second
}

// Screen codes, besides the runtime's.
const (
	ScreenCodeNoScreen     = "no_screen"      // Screen Sharing off or not answering
	ScreenCodeNoAccount    = "no_account"     // no screen account stored
	ScreenCodeSignInFailed = "sign_in_failed" // the account was refused
	ScreenCodeNoHelper     = "no_helper"      // helper not installed or not running in the console session
	ScreenCodeNoAccess     = "no_access"      // helper running without Accessibility
	ScreenCodeNotFound     = "not_found"      // nothing matched the name / menu path
	ScreenCodeLocked       = "locked"         // ui.* while the screen is locked
	ScreenCodeNoPrompt     = "no_prompt"      // password: no macOS password prompt is in front
	ScreenCodeNotAdmin     = "not_admin"      // password without Accessibility: the screen account isn't an administrator
)

// ScreenRequest is one screen step. Coordinates are framebuffer pixels.
type ScreenRequest struct {
	Op      string         `cbor:"op"`
	X       int            `cbor:"x,omitempty"`
	Y       int            `cbor:"y,omitempty"`
	ToX     int            `cbor:"to_x,omitempty"` // drag end
	ToY     int            `cbor:"to_y,omitempty"`
	Button  string         `cbor:"button,omitempty"` // left (default) | right | middle
	Clicks  int            `cbor:"clicks,omitempty"` // 1 (default) | 2 | 3
	DX      int            `cbor:"dx,omitempty"`     // scroll steps
	DY      int            `cbor:"dy,omitempty"`
	Text    string         `cbor:"text,omitempty"`   // type; ui.set value
	Keys    string         `cbor:"keys,omitempty"`   // "cmd+q", "return", "tab tab space"
	MaxW    int            `cbor:"max_w,omitempty"`  // look: scale down to this width (0 = full)
	Format  string         `cbor:"format,omitempty"` // png (default) | jpeg
	App     string         `cbor:"app,omitempty"`    // ui.*: app name or bundle id; "" = frontmost
	Window  string         `cbor:"window,omitempty"` // ui.list: window title (contains)
	Name    string         `cbor:"name,omitempty"`   // ui.press / ui.set
	Role    string         `cbor:"role,omitempty"`   // button | checkbox | switch | text_field | menu_item | link | tab | row | popup | radio | any
	Index   int            `cbor:"index,omitempty"`  // the n-th match, 0 = first
	Path    []string       `cbor:"path,omitempty"`   // ui.menu
	Limit   int            `cbor:"limit,omitempty"`  // ui.list: max elements (default 300, max 1000)
	Target  string         `cbor:"target,omitempty"` // ui.open: "accessibility" | an app name | an https URL
	Account *ScreenAccount `cbor:"account,omitempty"`
}

// ScreenAccount is the Mac account the agent signs in to Screen Sharing with
// (account.set only). Never logged, never answered.
type ScreenAccount struct {
	User     string `cbor:"user"`
	Password string `cbor:"password"`
}

// ScreenResponse answers a ScreenRequest.
type ScreenResponse struct {
	OK        bool        `cbor:"ok"`
	Code      string      `cbor:"code,omitempty"`
	Message   string      `cbor:"message,omitempty"`
	Image     []byte      `cbor:"image,omitempty"` // look
	Format    string      `cbor:"format,omitempty"`
	W         int         `cbor:"w,omitempty"` // the image's size
	H         int         `cbor:"h,omitempty"`
	ScreenW   int         `cbor:"screen_w,omitempty"` // framebuffer size (the click space)
	ScreenH   int         `cbor:"screen_h,omitempty"`
	Elements  []UIElement `cbor:"elements,omitempty"` // ui.list
	Apps      []UIApp     `cbor:"apps,omitempty"`     // ui.apps
	Element   *UIElement  `cbor:"element,omitempty"`  // ui.press / ui.set / ui.menu: what was acted on
	Status    *MacScreen  `cbor:"status,omitempty"`   // status, account.*, unlock
	Helper    *MacHelper  `cbor:"helper,omitempty"`   // status
	Truncated bool        `cbor:"truncated,omitempty"`
}

// UIElement is one accessibility element. X, Y, W, H are framebuffer pixels.
type UIElement struct {
	ID          string   `cbor:"id"` // the helper's path ("w0.3.1"), valid for one list only
	Role        string   `cbor:"role,omitempty"`
	Subrole     string   `cbor:"subrole,omitempty"`
	Title       string   `cbor:"title,omitempty"`
	Description string   `cbor:"desc,omitempty"`
	Value       string   `cbor:"value,omitempty"`
	Identifier  string   `cbor:"ident,omitempty"`
	Enabled     bool     `cbor:"enabled,omitempty"`
	Focused     bool     `cbor:"focused,omitempty"`
	X           int      `cbor:"x,omitempty"`
	Y           int      `cbor:"y,omitempty"`
	W           int      `cbor:"w,omitempty"`
	H           int      `cbor:"h,omitempty"`
	Actions     []string `cbor:"actions,omitempty"`
	App         string   `cbor:"app,omitempty"`
	Window      string   `cbor:"window,omitempty"`
}

// UIApp is one running app with windows.
type UIApp struct {
	Name     string   `cbor:"name"`
	BundleID string   `cbor:"bundle_id,omitempty"`
	PID      int      `cbor:"pid,omitempty"`
	Active   bool     `cbor:"active,omitempty"`
	Windows  []string `cbor:"windows,omitempty"`
}
