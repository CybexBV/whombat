package screen

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"rackoon/internal/proto"
)

// The helper (Whombat Helper, a LaunchAgent in the person's desktop session)
// listens on <ui root>/<uid>/helper.sock and answers one JSON line per
// connection (Whombat docs/implementation/macos/assignment.md §2).
const (
	DefaultUIRoot    = "/var/run/whombat-agent/ui"
	DefaultHelperApp = "/Library/Application Support/Whombat/Whombat Helper.app"
	helperSocketName = "helper.sock"
	helperMaxAnswer  = 16 << 20
	helperTimeout    = 12 * time.Second // the helper bounds itself to 10 s
	// helperMapTimeout: geocode and map ask Apple's map service, and the
	// helper gives them 20 s.
	helperMapTimeout = 22 * time.Second
)

// errNoHelper: the helper isn't there or isn't the console user's.
var errNoHelper = errors.New("Whombat Helper isn't running in the session at the Mac's screen")

// errHelperBusy: the helper turned the connection away because it already
// answers as many requests as it takes; nothing was sent.
var errHelperBusy = errors.New("Whombat Helper is busy")

// What a helper version can do with a password. Only a helper that checks
// the lock screen's field before each key it sends (1.0.4) gets the password
// for its own unlock, and only one that says what has the focus with the
// field's own identity (1.0.5's token) or at least checks each key may be
// relied on for the password step's per-key checks with Accessibility.
var (
	helperGuardedKeys = [3]int{1, 0, 4} // unlock sends each key only while the field has the keyboard
	helperFieldToken  = [3]int{1, 0, 5} // `focused` names the element (token)
)

// helperOlderMsg answers a step the helper doesn't know yet (an op of a
// newer helper): it takes the new version with the agent's next update.
const helperOlderMsg = "Whombat Helper on this Mac is older than this step; it updates itself."

// helperAtLeast says whether a helper's version (X.Y.Z) is at least want;
// anything else ("dev", empty) isn't.
func helperAtLeast(version string, want [3]int) bool {
	parts := strings.Split(strings.TrimSpace(version), ".")
	if len(parts) != 3 {
		return false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return false
		}
		if n != want[i] {
			return n > want[i]
		}
	}
	return true
}

type helperDisplay struct {
	ID    int64   `json:"id"`
	X     float64 `json:"x"`
	Y     float64 `json:"y"`
	W     float64 `json:"w"`
	H     float64 `json:"h"`
	Scale float64 `json:"scale"`
	Main  bool    `json:"main"`
}

type helperElement struct {
	ID          string   `json:"id"`
	Role        string   `json:"role"`
	Subrole     string   `json:"subrole"`
	Title       string   `json:"title"`
	Description string   `json:"desc"`
	Value       string   `json:"value"`
	Identifier  string   `json:"ident"`
	Enabled     bool     `json:"enabled"`
	Focused     bool     `json:"focused"`
	X           float64  `json:"x"`
	Y           float64  `json:"y"`
	W           float64  `json:"w"`
	H           float64  `json:"h"`
	Actions     []string `json:"actions"`
	App         string   `json:"app"`
	Window      string   `json:"window"`
	// Token (focused, 1.0.5 on) names the element itself for as long as it
	// exists: the same field gives the same token, another field another.
	Token string `json:"token"`
}

type helperApp struct {
	Name     string   `json:"name"`
	BundleID string   `json:"bundle_id"`
	PID      int      `json:"pid"`
	Active   bool     `json:"active"`
	Windows  []string `json:"windows"`
}

// helperWindow is one window of the helper's `windows` (1.0.2 on): what the
// window server says is on the screen, front to back, in global display
// points. It needs no permission, so it works before the helper has
// Accessibility; it carries no titles (those need Screen Recording).
type helperWindow struct {
	Number   int     `json:"number"`
	Layer    int     `json:"layer"`
	Alpha    float64 `json:"alpha"`
	X        float64 `json:"x"`
	Y        float64 `json:"y"`
	W        float64 `json:"w"`
	H        float64 `json:"h"`
	PID      int     `json:"pid"`
	Owner    string  `json:"owner"`
	BundleID string  `json:"bundle_id"`
	Path     string  `json:"path"`
}

// helperAnswer is any of the helper's answers.
type helperAnswer struct {
	OK      bool   `json:"ok"`
	Code    string `json:"code"`
	Message string `json:"message"`

	// status
	Version     string          `json:"version"`
	AX          bool            `json:"ax"`
	Locked      bool            `json:"locked"`
	User        string          `json:"user"`
	FrontApp    string          `json:"front_app"`
	FrontWindow string          `json:"front_window"`
	Displays    []helperDisplay `json:"displays"`

	Apps      []helperApp     `json:"apps"`
	Elements  []helperElement `json:"elements"`
	Truncated bool            `json:"truncated"`
	Element   *helperElement  `json:"element"`
	Windows   []helperWindow  `json:"windows"`

	// focused (1.0.3 on): the process whose element has the keyboard focus.
	PID      int    `json:"pid"`
	BundleID string `json:"bundle_id"`

	// status (1.1.0 on): seconds since the last input at the Mac itself;
	// nil when unknown.
	IdleS *float64 `json:"idle_s"`
	// geocode (1.1.0 on): one per query, nil where nothing was found.
	Places []*helperPlace `json:"places"`
	// map (1.1.0 on): the picture (base64 in the JSON), its size in
	// pixels, one point per pin (nil: outside it) and the region drawn.
	Image  []byte         `json:"image"`
	Format string         `json:"format"`
	W      int            `json:"w"`
	H      int            `json:"h"`
	Points []*helperPoint `json:"points"`
	Lat    *float64       `json:"lat"`
	Lon    *float64       `json:"lon"`
	SpanM  float64        `json:"span_m"`
}

type helperPlace struct {
	Lat       float64 `json:"lat"`
	Lon       float64 `json:"lon"`
	AccuracyM float64 `json:"accuracy_m"`
}

type helperPoint struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// helperClient talks to the helper of one user.
type helperClient struct {
	root string
	// check vets the process that answers on the socket before anything is
	// sent (Screen.checkHelperPeer), on every connection; without one
	// nothing is.
	check func(ctx context.Context, c *net.UnixConn, uid int) error
}

func (h helperClient) socket(uid int) string {
	return filepath.Join(h.root, strconv.Itoa(uid), helperSocketName)
}

// call sends one request to uid's helper and reads its answer. The socket
// must be a socket (not a link) and the process behind it the installed
// helper (check): the folder is the user's, so any of their programs could
// listen there, and a request may carry the password.
func (h helperClient) call(ctx context.Context, uid int, req map[string]any) (*helperAnswer, error) {
	return h.callWithin(ctx, uid, req, helperTimeout)
}

// callWithin is call with the helper given wait to answer.
func (h helperClient) callWithin(ctx context.Context, uid int, req map[string]any, wait time.Duration) (*helperAnswer, error) {
	path := h.socket(uid)
	fi, err := os.Lstat(path)
	if err != nil || fi.Mode()&fs.ModeSocket == 0 {
		return nil, errNoHelper
	}
	ctx, cancel := context.WithTimeout(ctx, wait)
	defer cancel()
	var d net.Dialer
	conn, err := d.DialContext(ctx, "unix", path)
	if err != nil {
		return nil, errNoHelper
	}
	defer conn.Close()
	uc, ok := conn.(*net.UnixConn)
	if !ok {
		return nil, errNoHelper
	}
	if h.check == nil {
		return nil, fmt.Errorf("%w (nothing to check it with)", errNoHelper)
	}
	if err := h.check(ctx, uc, uid); err != nil {
		if errors.Is(err, errHelperBusy) {
			return nil, err
		}
		return nil, fmt.Errorf("%w (%w)", errNoHelper, err)
	}
	if dl, ok := ctx.Deadline(); ok {
		conn.SetDeadline(dl)
	}
	req["v"] = 1
	line, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	if _, err := conn.Write(append(line, '\n')); err != nil {
		return nil, fmt.Errorf("helper: %w", err)
	}
	buf, err := bufio.NewReader(io.LimitReader(conn, helperMaxAnswer+1)).ReadBytes('\n')
	switch {
	case len(buf) > helperMaxAnswer:
		return nil, errors.New("helper: answer too long")
	case err != nil && !(errors.Is(err, io.EOF) && len(bytes.TrimSpace(buf)) > 0):
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("helper: %w", err)
	}
	var a helperAnswer
	if err := json.Unmarshal(buf, &a); err != nil {
		return nil, fmt.Errorf("helper: unreadable answer: %w", err)
	}
	if busyAnswer(&a) {
		return nil, errHelperBusy
	}
	return &a, nil
}

// ensureUIDirs makes <root> (root, 0755) and <root>/<uid> (the user's,
// 0700) for the helper's socket. Anything else in the user's place (a link,
// a file) is removed first.
func ensureUIDirs(root string, uid int) error {
	if err := os.MkdirAll(root, 0o755); err != nil {
		return err
	}
	asRoot := os.Geteuid() == 0
	if asRoot {
		if err := os.Chown(root, 0, 0); err != nil {
			return err
		}
	}
	if err := os.Chmod(root, 0o755); err != nil {
		return err
	}
	dir := filepath.Join(root, strconv.Itoa(uid))
	fi, err := os.Lstat(dir)
	if err == nil && !fi.IsDir() {
		if err := os.Remove(dir); err != nil {
			return err
		}
		err = fs.ErrNotExist
	}
	if errors.Is(err, fs.ErrNotExist) {
		if err := os.Mkdir(dir, 0o700); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	if asRoot {
		fi, err := os.Lstat(dir)
		if err != nil {
			return err
		}
		if st, ok := fi.Sys().(*syscall.Stat_t); !ok || int(st.Uid) != uid {
			if err := os.Lchown(dir, uid, -1); err != nil {
				return err
			}
		}
	}
	return os.Chmod(dir, 0o700)
}

// consoleUID is the user at the Mac's screen: the owner of /dev/console;
// ok is false at the login window (root owns it then).
func consoleUID() (int, bool) {
	fi, err := os.Stat("/dev/console")
	if err != nil {
		return 0, false
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok || st.Uid == 0 {
		return 0, false
	}
	return int(st.Uid), true
}

// UI roles the agent accepts, and the accessibility roles they stand for.
var uiRoles = map[string]string{
	"button":     "AXButton",
	"checkbox":   "AXCheckBox",
	"switch":     "AXCheckBox,AXSwitch",
	"text_field": "AXTextField,AXTextArea,AXSecureTextField,AXSearchField",
	"menu_item":  "AXMenuItem",
	"link":       "AXLink",
	"tab":        "AXRadioButton",
	"row":        "AXRow,AXCell",
	"popup":      "AXPopUpButton,AXMenuButton",
	"radio":      "AXRadioButton",
	"any":        "",
	"":           "",
}

// uiRoleMax and uiRoleParts bound a step's role: at most 64 characters,
// at most 8 words or AX roles separated by commas.
const (
	uiRoleMax   = 64
	uiRoleParts = 8
)

// axRole maps a role (a word, an AX role such as "AXSlider", or several of
// either separated by commas) to the helper's AX roles, comma-separated;
// "" is any role, and so is a list naming "any".
func axRole(role string) (string, bool) {
	if len(role) > uiRoleMax {
		return "", false
	}
	if strings.TrimSpace(role) == "" {
		return "", true
	}
	parts := strings.Split(role, ",")
	if len(parts) > uiRoleParts {
		return "", false
	}
	var out []string
	seen := map[string]bool{}
	for _, part := range parts {
		p := strings.TrimSpace(part)
		var mapped string
		if r, ok := uiRoles[strings.ToLower(p)]; ok && p != "" {
			if r == "" {
				return "", true // any
			}
			mapped = r
		} else if strings.HasPrefix(p, "AX") && len(p) > 2 && !strings.ContainsAny(p, " \t") {
			mapped = p
		} else {
			return "", false
		}
		for _, r := range strings.Split(mapped, ",") {
			if !seen[r] {
				seen[r] = true
				out = append(out, r)
			}
		}
	}
	return strings.Join(out, ","), true
}

// pointMap converts the helper's global display points to framebuffer
// pixels: relative to the main display's origin, both axes scaled by one
// factor, the framebuffer's width over the main display's width in points
// (Screen Sharing shows the main display; its pixels are square). Elements on
// other displays come out beyond the framebuffer or at negative pixels, where
// a step refuses them as outside the screen.
type pointMap struct {
	ox, oy, scale float64
}

func newPointMap(displays []helperDisplay, fbW int) pointMap {
	m := pointMap{scale: 1}
	for _, d := range displays {
		if !d.Main || d.W <= 0 || d.H <= 0 {
			continue
		}
		m.ox, m.oy = d.X, d.Y
		switch {
		case fbW > 0:
			m.scale = float64(fbW) / d.W
		case d.Scale > 0:
			m.scale = d.Scale
		}
		break
	}
	return m
}

func (m pointMap) px(pt, origin float64) int {
	return int(math.Round((pt - origin) * m.scale))
}

func (m pointMap) element(e helperElement) proto.UIElement {
	x, y := m.px(e.X, m.ox), m.px(e.Y, m.oy)
	return proto.UIElement{
		ID: clip(e.ID, 128), Role: clip(e.Role, 64), Subrole: clip(e.Subrole, 64), Title: clip(e.Title, 200),
		Description: clip(e.Description, 200), Value: clip(e.Value, 200), Identifier: clip(e.Identifier, 200),
		Enabled: e.Enabled, Focused: e.Focused,
		X: x, Y: y, W: m.px(e.X+e.W, m.ox) - x, H: m.px(e.Y+e.H, m.oy) - y,
		Actions: clipList(actionNames(e.Actions), 16, 64), App: clip(e.App, 200), Window: clip(e.Window, 200),
	}
}

// actionNames are an element's actions as a person names them: an app's
// own action is listed by Accessibility as "Name:Play\nTarget:0x0\n
// Selector:(null)" and named by the words after "Name:" up to the line's
// end; an AX action keeps its name ("AXPress").
func actionNames(raw []string) []string {
	out := make([]string, 0, len(raw))
	for _, a := range raw {
		if rest, ok := strings.CutPrefix(a, "Name:"); ok {
			if i := strings.IndexAny(rest, "\r\n"); i >= 0 {
				rest = rest[:i]
			}
			a = strings.TrimSpace(rest)
		}
		if a != "" {
			out = append(out, a)
		}
	}
	return out
}

func clip(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n])
	}
	return s
}

func clipList(l []string, n, each int) []string {
	if len(l) > n {
		l = l[:n]
	}
	out := make([]string, 0, len(l))
	for _, s := range l {
		out = append(out, clip(s, each))
	}
	if len(out) == 0 {
		return nil
	}
	return out
}
