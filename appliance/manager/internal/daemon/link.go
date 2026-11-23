package daemon

// Whombat Link in the daemon (Whombat LNK-01…LNK-07, LNK-31; MG-170…MG-175). One image for every box: what a box does
// with control follows its Link state, not an edition.
//
//   - The environment (LNK-01a, internal/environment): control's address, the own address's zone. Without a resolved
//     environment (an image before it, the tests) the configuration's control.url stands for it.
//   - The Link state (manager/internal/link): kept in <dir of journalDir>/link, a journal of its own (the update
//     engine saves its whole state at every step, so a second writer there would lose changes). A box registered at
//     control before Link (Cybex's two boxes) starts `on`, as it worked before; every other box starts `off`.
//   - The reach file (internal/reach): the installer's and the recovery menu's choice, acted on once per seq at start.
//   - With Link off nothing goes to control: no assignment polls, status reports, update reports, claim lookups,
//     tickets or own-address work (LNK-03). The licence is inert (LNK-04): it is no longer renewed.
//   - Remote help's report: support.heartbeat instead of status.report once control speaks Link (LNK-31).

import (
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/CybexBV/whombat/appliance/internal/environment"
	"github.com/CybexBV/whombat/appliance/internal/reach"
	"github.com/CybexBV/whombat/appliance/manager/internal/broker"
	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi"
	"github.com/CybexBV/whombat/appliance/manager/internal/link"
	"github.com/CybexBV/whombat/contracts/go/device"
	"github.com/CybexBV/whombat/contracts/go/release"
)

// The environment variables that point the daemon elsewhere (tests and the harness; the image sets neither). The
// manager's configuration has no field for them: it refuses unknown fields, and an older known-good manager reads the
// same file.
const (
	// EnvEnvironmentDir: the resolved environment's folder (default environment.RunDir).
	EnvEnvironmentDir = "WHOMBAT_ENVIRONMENT_DIR"
	// EnvReachFile: the owner's reach choice (default reach.File).
	EnvReachFile = "WHOMBAT_REACH_FILE"
	// EnvRegistrationFile: the signed registration provisioning kept (default <dir of deviceFile>/registration.json).
	EnvRegistrationFile = "WHOMBAT_REGISTRATION_FILE"
)

func getenvOr(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}

// identityFile is device.json as provisioning writes it: the members a registration is made of.
type identityFile struct {
	DeviceID            string `json:"deviceId"`
	Env                 string `json:"env"`
	ApplianceRoute      string `json:"applianceRoute"`
	Model               string `json:"model"`
	Serial              string `json:"serial"`
	ContentPeerID       string `json:"contentPeerId"`
	ContentPublicKey    string `json:"contentPublicKey"`
	ManagementPublicKey string `json:"managementPublicKey"`
	ProvisionedAt       int64  `json:"provisionedAt"`
}

// localRoute is the appliance route of a box that made its identity itself (provisioning's LocalRoute).
const localRoute = "local"

func readIdentity(path string) (*identityFile, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var f identityFile
	if err := json.Unmarshal(b, &f); err != nil {
		return nil, fmt.Errorf("device file: %w", err)
	}
	return &f, nil
}

// setupEnvironment resolves where control is and whether this box can have Link. A broken environment leaves the box
// without Link (logged), never without its manager.
func (d *Daemon) setupEnvironment() {
	d.ReachFile = getenvOr(EnvReachFile, reach.File)
	d.RegistrationFile = getenvOr(EnvRegistrationFile, filepath.Join(filepath.Dir(d.Cfg.DeviceFile), "registration.json"))
	dir := getenvOr(EnvEnvironmentDir, environment.RunDir)
	env, err := environment.Load(dir)
	switch {
	case err == nil:
		d.Env = env
		d.controlURL = env.ControlURL
		d.Log.Info("environment", "name", env.Name, "chosen", env.Chosen, "link", env.LinkAvailable())
	case errors.Is(err, os.ErrNotExist):
		// An image before the environment file (or a test): the configuration says where control is.
		if !d.Cfg.Community() {
			d.controlURL = d.Cfg.Control.URL
		}
	default:
		d.Log.Error("environment unusable: no Whombat Link on this start", "err", err)
	}
	if id, err := readIdentity(d.Cfg.DeviceFile); err == nil {
		d.identity = id
		// A box control registered (factory or self-registration, before LNK-01) is one control already knows.
		d.registeredAtControl = id.ApplianceRoute != "" && id.ApplianceRoute != localRoute
	}
}

// setupLink opens the Link state. Without control in the environment the keeper has none and answers off.
func (d *Daemon) setupLink(key ed25519.PrivateKey) error {
	dir := filepath.Join(filepath.Dir(filepath.Clean(d.Cfg.JournalDir)), "link")
	carried := d.registeredAtControl && d.controlURL != "" && !d.Cfg.Community()
	k, err := link.Open(dir, carried, time.Now())
	if err != nil {
		return err
	}
	k.Log = d.Log
	if d.Control != nil {
		k.Control = d.Control // never a nil *Client in the interface
	}
	k.Registration = func(contentProof string) (*device.DeviceRegistration, error) {
		return d.registration(key, contentProof)
	}
	k.OnChange = d.linkChanged
	d.Link = k
	d.Broker.Link = k
	return nil
}

// registration is the box's signed registration for link.begin: device.json's members, the management key's proof,
// and the content key's (the runtime's contentProof, else the one provisioning kept in registration.json).
func (d *Daemon) registration(key ed25519.PrivateKey, contentProof string) (*device.DeviceRegistration, error) {
	id := d.identity
	if id == nil {
		var err error
		if id, err = readIdentity(d.Cfg.DeviceFile); err != nil {
			return nil, err
		}
	}
	reg := &device.DeviceRegistration{Env: release.Environment(id.Env), HardwareSerial: id.Serial, Model: id.Model,
		ManagementPublicKey: id.ManagementPublicKey, ContentPeerID: id.ContentPeerID, ContentPublicKey: id.ContentPublicKey,
		ProvisionedAt: id.ProvisionedAt}
	if contentProof == "" {
		path := d.RegistrationFile
		b, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("no content proof (the runtime gives one when the owner turns Link on): %w", err)
		}
		var kept device.DeviceRegistration
		if err := json.Unmarshal(b, &kept); err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
		contentProof = kept.ContentProof
	}
	msg, err := device.RegistrationSigningBytes(reg)
	if err != nil {
		return nil, err
	}
	if hex.EncodeToString(key.Public().(ed25519.PublicKey)) != reg.ManagementPublicKey {
		return nil, errors.New("the management key is not the one device.json names")
	}
	reg.Proof = hex.EncodeToString(ed25519.Sign(key, msg))
	reg.ContentProof = contentProof
	if !device.VerifyRegistration(reg) {
		return nil, errors.New("the content proof doesn't verify against device.json")
	}
	return reg, nil
}

// linkActive: Link features may run (starting, on, grace). linkKnown: control knows the box (any state but off).
func (d *Daemon) linkActive() bool { return d.Link != nil && d.Link.Active() }

// linkNewPath: control speaks Link (it told the box its state at least once), so remote help's report is the
// heartbeat, not status.report (LNK-31). A carried box on a control from before Link keeps status.report.
func (d *Daemon) linkNewPath() bool {
	if d.Link == nil {
		return false
	}
	r := d.Link.Snapshot()
	return r.CheckedAt != nil
}

// linkSignal is closed and replaced at every Link change: whileLinkActive waits on it.
type linkSignal struct {
	mu sync.Mutex
	ch chan struct{}
}

func (s *linkSignal) wait() <-chan struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ch == nil {
		s.ch = make(chan struct{})
	}
	return s.ch
}

func (s *linkSignal) fire() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ch != nil {
		close(s.ch)
	}
	s.ch = make(chan struct{})
}

// linkChanged follows a change of the Link state: the loops that run only with Link start or stop, remote help's
// report and the runtime hear of it soon, and a label control gave is registered.
func (d *Daemon) linkChanged(before, after link.Record) {
	d.Log.Info("link: state", "from", before.State, "to", after.State, "leaving", after.Leaving)
	d.linkSig.fire()
	select {
	case d.statusNow <- struct{}{}:
	default:
	}
	if !after.Active() && d.Broker != nil {
		d.Broker.DropTickets()
	}
	if after.Active() && addressChanged(before, after) {
		go d.followAddress(context.Background())
	}
}

// addressChanged: control's view of the box's address changed, or Link just became active.
func addressChanged(before, after link.Record) bool {
	lb, la := before.AddressLeaving, after.AddressLeaving
	sameLeaving := (lb == nil) == (la == nil) && (lb == nil || *lb == *la)
	return !before.Active() || before.Label != after.Label || before.Host != after.Host || before.Zone != after.Zone || !sameLeaving
}

// whileLinkActive runs f while Link is starting, on or in grace: cancelled when Link stops, started again when it comes
// back.
func (d *Daemon) whileLinkActive(ctx context.Context, f func(context.Context)) {
	for ctx.Err() == nil {
		changed := d.linkSig.wait()
		if !d.linkActive() {
			select {
			case <-ctx.Done():
			case <-changed:
			}
			continue
		}
		run, cancel := context.WithCancel(ctx)
		done := make(chan struct{})
		go func() { defer close(done); f(run) }()
		for running := true; running; {
			select {
			case <-ctx.Done():
				running = false
			case <-done:
				running = false
			case <-changed:
				changed = d.linkSig.wait()
				running = d.linkActive()
			}
		}
		cancel()
		<-done
		if ctx.Err() == nil && d.linkActive() {
			// f ended by itself while Link is still on (the claim lease once claimed): again only after Link changes.
			select {
			case <-ctx.Done():
			case <-changed:
			}
		}
	}
}

// registerLinkLabel registers the label control gave with Link (LNK-13: control gives it, the manager registers it and
// orders the certificate). A box that has its label already keeps it: a new name comes by a rename (followAddress).
func (d *Daemon) registerLinkLabel(ctx context.Context) {
	if d.OwnAddress == nil || d.Control == nil || !d.linkActive() {
		return
	}
	label := d.Link.Snapshot().Label
	if have, _ := d.OwnAddress.Label(); have != "" || label == "" {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	var resp device.AddressRegisterResponse
	if err := d.Control.Do(ctx, device.DeviceOpNameAddressRegister, device.AddressRegisterRequest{Label: label}, &resp); err != nil {
		d.warnOnce("own address: the label from Whombat Link wasn't registered (tried again with the next state)", err)
		return
	}
	if err := resp.Validate(); err != nil {
		d.warnOnce("own address: control's answer to address.register is not the contract's", err)
		return
	}
	if err := d.OwnAddress.Accept(&resp); err != nil {
		d.warnOnce("own address: control's answer refused", err)
		return
	}
	d.clearErr("own address: the label from Whombat Link wasn't registered (tried again with the next state)")
	d.Broker.DropTickets() // the next ticket carries the label (lbl)
	d.Log.Info("own address: label from Whombat Link registered", "label", label)
}

// applyReach acts on the owner's reach choice once per seq (the installer's at the first start, the recovery menu's
// after it): Link on or off, Tailscale on.
func (d *Daemon) applyReach(ctx context.Context) {
	path := d.ReachFile
	c, err := reach.Read(path)
	if err != nil {
		d.Log.Error("reach: the owner's choice is unreadable; nothing changes", "file", path, "err", err)
		d.resumeTailscale(ctx, nil)
		return
	}
	if c == nil || d.Link == nil || c.Seq <= d.Link.Snapshot().ReachSeq {
		d.resumeTailscale(ctx, c)
		return
	}
	d.Log.Info("reach: acting on the owner's choice", "seq", c.Seq, "by", c.By, "link", c.Link, "tailscale", c.Tailscale)
	if c.Tailscale {
		d.tailscaleOn(ctx, c.LoginServer)
	} else {
		d.resumeTailscale(ctx, nil)
	}
	switch {
	case c.Link && d.Link.Available():
		err = d.Link.WantOn(c.Seq)
	case !c.Link && d.Link.Snapshot().Known():
		if _, err = d.Link.Off(ctx); err == nil {
			err = d.Link.ReachSeen(c.Seq)
		}
	default:
		err = d.Link.ReachSeen(c.Seq)
	}
	if err != nil {
		d.Log.Error("reach: the owner's choice wasn't recorded", "err", err)
	}
}

// tailscaleOn turns Tailscale on for the reach choice; tailscaled may still be starting, so it is tried a few times.
func (d *Daemon) tailscaleOn(ctx context.Context, loginServer string) {
	if d.Broker.Tailscale == nil {
		d.Log.Warn("reach: Tailscale chosen, but this Whombat has no Tailscale")
		return
	}
	go func() {
		for i := range 10 {
			c, cancel := context.WithTimeout(ctx, time.Minute)
			_, err := d.Broker.Tailscale.On(c, loginServer)
			cancel()
			if err == nil {
				d.Log.Info("reach: Tailscale on", "loginServer", loginServer != "")
				return
			}
			d.Log.Info("reach: Tailscale not on yet", "try", i+1, "err", err)
			select {
			case <-ctx.Done():
				return
			case <-time.After(30 * time.Second):
			}
		}
	}()
}

// resumeTailscale turns Tailscale on again at start while it waits for its first sign-in: tailscaled forgets that it
// should run, and the owner's login server, when a box that never signed in restarts (tailscale.Manager.Resume). c is
// the reach choice the manager acted on before, which stands for a box from before the manager kept this itself.
// tailscaled may still be starting, so it is tried a few times.
func (d *Daemon) resumeTailscale(ctx context.Context, c *reach.Choice) {
	if d.Tailscale == nil {
		return
	}
	var fromReach *string
	if c != nil && c.Tailscale {
		server := c.LoginServer
		fromReach = &server
	}
	go func() {
		for i := range 10 {
			try, cancel := context.WithTimeout(ctx, time.Minute)
			on, err := d.Tailscale.Resume(try, fromReach)
			cancel()
			if err == nil {
				if on {
					d.Log.Info("tailscale: on again, waiting for its first sign-in")
				}
				return
			}
			d.Log.Info("tailscale: not on again yet", "try", i+1, "err", err)
			select {
			case <-ctx.Done():
				return
			case <-time.After(30 * time.Second):
			}
		}
	}()
}

// linkLoop acts on the reach choice, follows what control said of the address while the box was away (a label to
// register, a move), and keeps the Link state fresh.
func (d *Daemon) linkLoop(ctx context.Context) {
	d.applyReach(ctx)
	if d.linkActive() {
		go d.followAddress(ctx)
	}
	d.Link.Run(ctx)
}

// pollGated is pollOnce while Link is on: without it the box asks control nothing (LNK-03). Updates are the exception
// (LNK-05: Link never touches them): a box without a channel that control registered before Link still takes its
// releases as control's assignments, so it keeps asking for them whatever its Link state. A box with a channel takes
// its channel's newest instead (pollOnce answers at once); a box control never registered has nothing to ask.
func (d *Daemon) pollGated(ctx context.Context, poll time.Duration) (time.Duration, *broker.CheckResult, error) {
	if !d.linkActive() && !d.assignedUpdates() {
		return jitter(poll), &broker.CheckResult{Result: controlapi.ResultNone, NextCheckS: int64(poll / time.Second)}, nil
	}
	return d.pollOnce(ctx, poll)
}

// heartbeat sends remote help's state as support.heartbeat (LNK-31) and answers when to send the next.
func (d *Daemon) heartbeat(ctx context.Context, every time.Duration) time.Duration {
	sup, key := d.supportReport(ctx)
	if sup == nil {
		return every // no support service: nothing to tell
	}
	var out device.SupportHeartbeatResponse
	err := d.Control.Do(ctx, device.DeviceOpNameSupportHeartbeat, device.SupportHeartbeatRequest{Support: *sup}, &out)
	if err != nil {
		if errors.Is(err, controlapi.ErrUnavailable) {
			if ctx.Err() == nil {
				d.unreachable(depControl, "support.heartbeat failed", err, false)
			}
		} else {
			d.warnOnce("support.heartbeat failed", err)
		}
		return min(every, time.Minute)
	}
	d.reachable(depControl)
	d.clearErr("support.heartbeat failed")
	if key != "" {
		d.supportTold.Store(&key)
	}
	if out.NextS > 0 {
		return jitter(time.Duration(out.NextS) * time.Second)
	}
	return jitter(every)
}
