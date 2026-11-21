package installer

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/CybexBV/whombat/appliance/console/internal/screen"
	"github.com/CybexBV/whombat/appliance/console/internal/web"
)

// System is the machine the installer runs on; the real one is in system.go, tests use fakes.
type System interface {
	UEFI() bool
	CPUs() int
	MemoryBytes() (uint64, error)
	BlockDevices(ctx context.Context) ([]byte, error) // lsblk LsblkArgs
	Address() string                                  // an address the machine got (DHCP), "" without one
	WiredAddress() string                             // an address on a cable's interface (not Wi-Fi), "" without one
	Reach(ctx context.Context, host string) error     // a TLS handshake with host:443, or the host:port given
	// Install runs whombat-install for the job and hands every output line to line; it returns when it exits.
	Install(ctx context.Context, job Job, line func(string)) error
	Reboot() error
}

// Job is one install: the disk, the joined Wi-Fi network's iwd profile to copy into the system ("" none, HD-08) and how
// the owner will reach the box (nil: no choice written, LNK-12).
type Job struct {
	Disk        string
	WifiProfile string
	Reach       *ReachChoice
}

// Check is one pre-flight check (CG-13).
type Check struct {
	ID     string `json:"id"`
	Status string `json:"status"` // running | ok | warn | fail
	Value  string `json:"value"`
}

// CheckIDs in the order the page lists them.
var CheckIDs = []string{"uefi", "cpu", "memory", "disk", "network", "reach-api", "reach-updates", "reach-relay", "reach-login"}

// checkIDs are the checks of a run: the reach checks only for what the owner's choice needs (reachTargets): control
// and the relay for Whombat Link (never on a community box, NX-445), the login server for Tailscale.
func checkIDs(targets map[string]string) []string {
	var ids []string
	for _, id := range CheckIDs {
		if _, ok := targets[id]; ok || !strings.HasPrefix(id, "reach-") {
			ids = append(ids, id)
		}
	}
	return ids
}

// Thresholds of CG-13.
const (
	cpuWarn, cpuFail = 4, 2
	memWarnGiB       = 8
	memFailGiB       = 4
	reachTimeout     = 8 * time.Second
	logLines         = 200
	logLineRunes     = 300
)

// Preflight is the checks' state.
type Preflight struct {
	Status string  `json:"status"` // running | done
	Checks []Check `json:"checks"`
	Disks  []Disk  `json:"disks"`
}

// Install is the install's state.
type Install struct {
	Status  string   `json:"status"` // idle | running | done | failed
	Disk    *string  `json:"disk"`
	Step    *string  `json:"step"`
	Percent int      `json:"percent"`
	Log     []string `json:"log"`
	Error   string   `json:"error"`
}

// State is GET /api/state.
type State struct {
	Mode        string    `json:"mode"`
	Platform    string    `json:"platform"`
	Storage     string    `json:"storage"`
	Environment string    `json:"environment"`
	Edition     string    `json:"edition"` // a community image has no Whombat Link: the page doesn't ask (NX-445)
	Release     *string   `json:"release"`
	AppURL      string    `json:"appUrl"`
	Preflight   Preflight `json:"preflight"`
	Install     Install   `json:"install"`
	// Wired: whether a cable's interface had an address at the last network check (null before the first): without
	// one, the page offers the Wi-Fi step (HD-08, CG-120).
	Wired *bool `json:"wired"`
}

// Server is the installer's state machine: pre-flight (re-runnable), then one install at a time, then a restart.
type Server struct {
	image       Image
	mediumLabel string
	sys         System
	ctx         context.Context

	// How long the network checks wait for an address (DHCP may still be at it when the installer starts).
	addrWait time.Duration

	mu        sync.Mutex
	preflight Preflight
	runs      int // pre-flight runs started (a result of an older run is dropped)
	install   Install
	rebooting bool
	wired     *bool

	// Wi-Fi (wifi.go): the card (nil: none), one scan or join at a time, the last scan, the network joined here.
	wifi     Wifi
	wifiMu   sync.Mutex
	networks []WifiNetwork
	joined   string
	tmpDir   string // where the profile waits for whombat-install ("": the system's)

	// The reach choice the checks test (the page sends it with POST /api/preflight).
	choice *ReachChoice
}

// New makes a server; ctx bounds everything it starts (checks, the install).
func New(ctx context.Context, image Image, mediumLabel string, sys System) *Server {
	s := &Server{image: image, mediumLabel: mediumLabel, sys: sys, ctx: ctx, addrWait: 20 * time.Second}
	s.preflight = Preflight{Status: "done", Checks: []Check{}, Disks: []Disk{}}
	s.install = Install{Status: "idle", Log: []string{}}
	s.choice = s.defaultChoice()
	return s
}

// State is a copy of the current state.
func (s *Server) State() State {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := State{Mode: "installer", Platform: s.image.Platform, Storage: s.image.Storage, Environment: s.image.Environment,
		Release: s.image.Release, AppURL: s.image.AppURL, Edition: s.image.Edition}
	st.Preflight = Preflight{Status: s.preflight.Status, Checks: append([]Check{}, s.preflight.Checks...),
		Disks: append([]Disk{}, s.preflight.Disks...)}
	st.Install = s.install
	st.Install.Log = append([]string{}, s.install.Log...)
	st.Wired = s.wired
	return st
}

// StartPreflight runs every check again (concurrently), for the last reach choice; false while an install runs or is
// done.
func (s *Server) StartPreflight() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.startPreflight()
}

// StartPreflightFor runs the checks for a new reach choice (nil: the default choice). ErrReach for one that can't be,
// ErrEnvironment for a request naming an environment; ErrBusy while an install runs or is done (the choice is then
// kept as it was).
func (s *Server) StartPreflightFor(c *ReachChoice, env string) error {
	if err := s.validChoice(c, env); err != nil {
		return err
	}
	if c == nil {
		c = s.defaultChoice()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.install.Status == "running" || s.install.Status == "done" {
		return ErrBusy
	}
	s.choice = c
	s.startPreflight()
	return nil
}

// startPreflight starts a run with s.mu held.
func (s *Server) startPreflight() bool {
	if s.install.Status == "running" || s.install.Status == "done" {
		return false
	}
	s.runs++
	run := s.runs
	targets := s.reachTargets(s.choice)
	s.preflight = Preflight{Status: "running", Disks: s.preflight.Disks}
	for _, id := range checkIDs(targets) {
		s.preflight.Checks = append(s.preflight.Checks, Check{ID: id, Status: "running"})
	}
	go s.runChecks(run, targets)
	return true
}

func (s *Server) runChecks(run int, targets map[string]string) {
	var wg sync.WaitGroup
	set := func(c Check, disks []Disk) {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.runs != run {
			return
		}
		for i := range s.preflight.Checks {
			if s.preflight.Checks[i].ID == c.ID {
				s.preflight.Checks[i] = c
			}
		}
		if disks != nil {
			s.preflight.Disks = disks
		}
	}
	for _, id := range checkIDs(targets) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c, disks := s.check(id, targets[id])
			set(c, disks)
		}()
	}
	wg.Wait()
	s.mu.Lock()
	if s.runs == run {
		s.preflight.Status = "done"
	}
	s.mu.Unlock()
}

// check runs one check (a reach check tries host); the disk check also returns the disk list.
func (s *Server) check(id, host string) (Check, []Disk) {
	c := Check{ID: id}
	switch id {
	case "uefi":
		c.Status, c.Value = "ok", "UEFI"
		if !s.sys.UEFI() {
			c.Status, c.Value = "fail", "BIOS"
		}
	case "cpu":
		n := s.sys.CPUs()
		c.Value = plural(n, "core")
		c.Status = grade(n < cpuFail, n < cpuWarn)
	case "memory":
		b, err := s.sys.MemoryBytes()
		if err != nil {
			c.Status = "fail"
			break
		}
		gib := MemoryGiB(b)
		c.Value = fmt.Sprintf("%d GiB", gib)
		c.Status = grade(gib < memFailGiB, gib < memWarnGiB)
	case "disk":
		disks, err := s.disks()
		if err != nil {
			c.Status = "fail"
			return c, []Disk{}
		}
		var names []string
		for _, d := range disks {
			if d.Eligible {
				names = append(names, d.Name)
			}
		}
		c.Status, c.Value = "fail", ""
		if len(names) > 0 {
			c.Status, c.Value = "ok", strings.Join(names, ", ")
		}
		return c, disks
	case "network":
		// Any address passes, a Wi-Fi network's too (HD-08); whether a cable has one decides the Wi-Fi step.
		c.Value = s.address()
		c.Status = grade(false, c.Value == "")
		wired := s.sys.WiredAddress() != ""
		s.mu.Lock()
		s.wired = &wired
		s.mu.Unlock()
	case "reach-api", "reach-updates", "reach-relay", "reach-login":
		c.Value, c.Status = host, "warn"
		if host != "" && s.address() != "" {
			ctx, cancel := context.WithTimeout(s.ctx, reachTimeout)
			if s.sys.Reach(ctx, host) == nil {
				c.Status = "ok"
			}
			cancel()
		}
	}
	return c, nil
}

// address waits up to addrWait for the machine to have an address.
func (s *Server) address() string {
	end := time.Now().Add(s.addrWait)
	for {
		if a := s.sys.Address(); a != "" || !time.Now().Before(end) {
			return a
		}
		select {
		case <-s.ctx.Done():
			return ""
		case <-time.After(500 * time.Millisecond):
		}
	}
}

func (s *Server) disks() ([]Disk, error) {
	ctx, cancel := context.WithTimeout(s.ctx, 10*time.Second)
	defer cancel()
	b, err := s.sys.BlockDevices(ctx)
	if err != nil {
		return nil, err
	}
	return ParseDisks(b, s.mediumLabel)
}

func grade(fail, warn bool) string {
	switch {
	case fail:
		return "fail"
	case warn:
		return "warn"
	}
	return "ok"
}

func plural(n int, word string) string {
	if n == 1 {
		return "1 " + word
	}
	return fmt.Sprintf("%d %ss", n, word)
}

// MemoryGiB is the memory the machine has, in whole GiB, as the pre-flight compares it: MemTotal is what the kernel
// has left after its own reservations (an 8 GiB VM reports about 7.7 GiB), so it is rounded to the nearest GiB, not
// down (NX-80).
func MemoryGiB(memTotal uint64) int {
	return int(math.Round(float64(memTotal) / float64(1<<30)))
}

// Refusals of POST /api/install.
var (
	ErrBusy        = errors.New("busy")         // 409: an install runs or is done, or the checks are running
	ErrNotEligible = errors.New("not-eligible") // 400
	ErrConfirm     = errors.New("confirm")      // 400: the typed name isn't the disk's
	ErrCheckFailed = errors.New("check-failed") // 400: a pre-flight check failed
)

// InstallRequest is POST /api/install: the disk, its name typed to confirm and how the owner will reach the box (nil:
// the default, defaultChoice). Environment is read only to refuse it (ErrEnvironment, ONE-02).
type InstallRequest struct {
	Disk        string       `json:"disk"`
	Confirm     string       `json:"confirm"`
	Reach       *ReachChoice `json:"reach"`
	Environment string       `json:"environment"`
}

// StartInstall erases the request's disk and installs the system on it, once every check passed and confirm is the
// disk's name. The disk is looked up again right before (a disk mounted since the checks is refused).
func (s *Server) StartInstall(req InstallRequest) error {
	path, confirm := req.Disk, req.Confirm
	if err := s.validChoice(req.Reach, req.Environment); err != nil {
		return err
	}
	// A request without a choice (older scripted installs: the harness's, the VM tests') writes none: the box starts
	// with Link off and Tailscale as it is, and its owner chooses later in the apps (LNK-15). Its checks still ran for
	// the default choice (defaultChoice).
	if !s.wifiMu.TryLock() {
		return ErrBusy
	}
	defer s.wifiMu.Unlock()
	s.mu.Lock()
	if s.install.Status == "running" || s.install.Status == "done" || s.preflight.Status != "done" {
		s.mu.Unlock()
		return ErrBusy
	}
	if len(s.preflight.Checks) == 0 {
		s.mu.Unlock()
		return ErrCheckFailed
	}
	for _, c := range s.preflight.Checks {
		if c.Status == "fail" || c.Status == "running" {
			s.mu.Unlock()
			return ErrCheckFailed
		}
	}
	var chosen *Disk
	for i := range s.preflight.Disks {
		if s.preflight.Disks[i].Path == path {
			chosen = &s.preflight.Disks[i]
		}
	}
	if chosen == nil || !chosen.Eligible {
		s.mu.Unlock()
		return ErrNotEligible
	}
	if confirm != chosen.Name {
		s.mu.Unlock()
		return ErrConfirm
	}
	// Claim the install before looking at the disk again, so a second request can't slip in meanwhile.
	disk := path
	step := Steps[0]
	prev := s.install
	s.install = Install{Status: "running", Disk: &disk, Step: &step, Log: []string{}}
	s.mu.Unlock()

	fresh, err := s.disks()
	ok := false
	for _, d := range fresh {
		if d.Path == path && d.Eligible {
			ok = true
		}
	}
	if err != nil || !ok {
		s.mu.Lock()
		s.install = prev // a refused retry keeps showing the failure it retried
		if err == nil {
			s.preflight.Disks = fresh
		}
		s.mu.Unlock()
		return ErrNotEligible
	}
	go s.runInstall(Job{Disk: path, Reach: req.Reach})
	return nil
}

func (s *Server) runInstall(job Job) {
	// The network joined here goes into the system (HD-08). Without its profile the box still starts and its screen
	// offers Wi-Fi (HD-07), so a profile that can't be read is a line in the log, not a failed install.
	profile, err := s.wifiProfile()
	switch {
	case err != nil:
		s.line("== the Wi-Fi network couldn’t be copied; choose it again on the screen after the restart")
	case profile != "":
		job.WifiProfile = profile
		defer os.RemoveAll(filepath.Dir(profile))
	}
	err = s.sys.Install(s.ctx, job, s.line)
	s.mu.Lock()
	defer s.mu.Unlock()
	if err == nil {
		step := Steps[len(Steps)-1]
		s.install.Status, s.install.Step, s.install.Percent = "done", &step, 100
		return
	}
	s.install.Status = "failed"
	s.install.Error = err.Error()
	// The installer's own last words say more than an exit status.
	for i := len(s.install.Log) - 1; i >= 0; i-- {
		if l := strings.TrimSpace(s.install.Log[i]); l != "" && !strings.HasPrefix(l, "== ") {
			s.install.Error = l
			break
		}
	}
}

// line takes one line of whombat-install's output: progress moves the bar, everything else goes to the log.
func (s *Server) line(l string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if step, pct, before, ok := ParseProgress(l); ok {
		st := step
		s.install.Step = &st
		s.install.Percent = max(s.install.Percent, Overall(step, pct))
		if strings.TrimSpace(before) == "" {
			return
		}
		l = before
	}
	l = screen.Clean(l)
	if utf8.RuneCountInString(l) > logLineRunes {
		l = string([]rune(l)[:logLineRunes]) + "…"
	}
	s.install.Log = append(s.install.Log, l)
	if n := len(s.install.Log); n > logLines {
		s.install.Log = append([]string{}, s.install.Log[n-logLines:]...)
	}
}

// Restart reboots into the installed system; only once the install is done.
func (s *Server) Restart() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.install.Status != "done" {
		return false
	}
	if !s.rebooting {
		s.rebooting = true
		go func() {
			time.Sleep(500 * time.Millisecond) // let the answer reach the page
			_ = s.sys.Reboot()
		}()
	}
	return true
}

// Handler serves the Installer API (behind web.Handler's token check).
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/state", func(w http.ResponseWriter, r *http.Request) {
		if web.Method(w, r, http.MethodGet) {
			web.JSON(w, http.StatusOK, s.State())
		}
	})
	mux.HandleFunc("/api/preflight", func(w http.ResponseWriter, r *http.Request) {
		if !web.Method(w, r, http.MethodPost) {
			return
		}
		// Without a body: the checks again for the last choice ("Check again", "Try again"). With one: for the
		// choice of the page's reach step.
		if r.ContentLength == 0 {
			if !s.StartPreflight() {
				web.Error(w, http.StatusConflict, "busy")
				return
			}
			web.JSON(w, http.StatusAccepted, map[string]bool{"ok": true})
			return
		}
		var body struct {
			Reach       *ReachChoice `json:"reach"`
			Environment string       `json:"environment"` // refused (ONE-02)
		}
		if !web.DecodeJSON(w, r, &body) {
			return
		}
		switch err := s.StartPreflightFor(body.Reach, body.Environment); {
		case err == nil:
			web.JSON(w, http.StatusAccepted, map[string]bool{"ok": true})
		case errors.Is(err, ErrBusy):
			web.Error(w, http.StatusConflict, err.Error())
		default:
			web.Error(w, http.StatusBadRequest, err.Error())
		}
	})
	mux.HandleFunc("/api/install", func(w http.ResponseWriter, r *http.Request) {
		if !web.Method(w, r, http.MethodPost) {
			return
		}
		var body InstallRequest
		if !web.DecodeJSON(w, r, &body) {
			return
		}
		switch err := s.StartInstall(body); {
		case err == nil:
			web.JSON(w, http.StatusAccepted, map[string]bool{"ok": true})
		case errors.Is(err, ErrBusy):
			web.Error(w, http.StatusConflict, err.Error())
		default:
			web.Error(w, http.StatusBadRequest, err.Error())
		}
	})
	mux.HandleFunc("/api/restart", func(w http.ResponseWriter, r *http.Request) {
		if !web.Method(w, r, http.MethodPost) {
			return
		}
		if !s.Restart() {
			web.Error(w, http.StatusConflict, "not done")
			return
		}
		web.JSON(w, http.StatusAccepted, map[string]bool{"ok": true})
	})
	s.wifiRoutes(mux)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { web.Error(w, http.StatusNotFound, "not found") })
	return mux
}
