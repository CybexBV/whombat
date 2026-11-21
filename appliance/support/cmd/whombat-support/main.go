// Command whombat-support is the appliance's support service (Whombat RH-01…RH-13; NX-411…NX-424): it keeps the owner's
// grant of remote help, answers the runtime and the manager on its socket, and only while a grant lets support in, dials
// the relay as the device's support worker and serves SSH to Whombat support over it, recording every visit for the
// owners. It runs as root because “Look and fix” is root (NX-412); nothing listens on any network.
//
//	whombat-support --environment local|dev|prod --runtime-uid 951 --manager-uid 950 [--ca-keys /etc/whombat/support-ca.pub]
//	                [--state-dir /var/lib/whombat-support] [--device-file /persist/identity/device.json]
//	                [--manager-socket /run/whombat-manager/api.sock] [--look-user whombat-support-look]
//	                [--socket /run/whombat-support/api.sock]
//
// Under socket activation (whombat-support.socket) the socket is systemd's; otherwise it is made at --socket, 0660. In
// the state directory: grant.json (the grant), events.json (what happened, for the runtime's follower), visits/ (the
// record) and the SSH server's host key.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/peercred"
	"github.com/CybexBV/whombat/appliance/support/internal/api"
	"github.com/CybexBV/whombat/appliance/support/internal/cakeys"
	"github.com/CybexBV/whombat/appliance/support/internal/events"
	"github.com/CybexBV/whombat/appliance/support/internal/grant"
	"github.com/CybexBV/whombat/appliance/support/internal/reap"
	"github.com/CybexBV/whombat/appliance/support/internal/records"
	"github.com/CybexBV/whombat/appliance/support/internal/wire"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// pruneEvery: the record also prunes itself at start and after every visit; this catches a box nobody visits.
const pruneEvery = 24 * time.Hour

// firstPause is the relay worker's first pause after it stopped early (then doubling to a minute).
var firstPause = 2 * time.Second

func main() {
	env := flag.String("environment", "", "the image's whombat.environment: local, dev or prod")
	caFile := flag.String("ca-keys", "/etc/whombat/support-ca.pub", "the pinned support CA keys (absent: remote help isn't available)")
	stateDir := flag.String("state-dir", "/var/lib/whombat-support", "the grant, the events, the record and the host key (0700)")
	deviceFile := flag.String("device-file", "/persist/identity/device.json", "the device's identity (its id is the certificates' principal)")
	managerSocket := flag.String("manager-socket", "/run/whombat-manager/api.sock", "the manager's socket (support tickets, Look's reads)")
	lookUser := flag.String("look-user", "whombat-support-look", "the account Look commands run as")
	runtimeUID := flag.Int("runtime-uid", -1, "the runtime server's uid (everything on the socket)")
	managerUID := flag.Int("manager-uid", -1, "the manager's uid (the state only)")
	socket := flag.String("socket", wire.SocketDefault, "the socket (ignored under socket activation)")
	flag.Parse()

	if (*env != wire.EnvLocal && *env != wire.EnvDev && *env != wire.EnvProd) || *runtimeUID <= 0 || *managerUID <= 0 ||
		*runtimeUID == *managerUID {
		fmt.Fprintln(os.Stderr, "whombat-support: --environment is local, dev or prod; --runtime-uid and --manager-uid are two uids above 0")
		os.Exit(2)
	}
	logf := func(f string, a ...any) { fmt.Fprintf(os.Stderr, f+"\n", a...) }
	if err := os.MkdirAll(*stateDir, 0o700); err != nil {
		fail(err)
	}

	// The events first: the record reports visits a crash left open while it opens.
	ev := events.Open(filepath.Join(*stateDir, "events.json"), time.Now, logf)
	rec, err := records.Open(records.Options{Dir: filepath.Join(*stateDir, "visits"), OnStart: visitStart(ev),
		OnEnd: visitEnd(ev), Logf: logf})
	if err != nil {
		fail(err)
	}
	g, err := grant.Open(grant.Options{Path: filepath.Join(*stateDir, "grant.json"), Environment: *env, Events: ev, Logf: logf})
	if err != nil {
		fail(err)
	}

	ca, err := cakeys.Read(*caFile)
	if err != nil {
		logf("whombat-support: the support CA keys aren't usable, remote help isn't available: %v", err)
		ca = nil
	}
	svc, err := newSSH(sshConfig{StateDir: *stateDir, CAFile: *caFile, CAKeys: ca, DeviceID: deviceID(*deviceFile),
		Gate: g, Records: rec, ManagerSocket: *managerSocket, LookUser: *lookUser, Logf: logf})
	if err != nil {
		logf("whombat-support: the SSH server can't start, remote help isn't available: %v", err)
	}
	available := len(ca) > 0 && err == nil
	if !available && g.Level() != "" {
		// A grant nobody can use isn't shown as on (an image that no longer pins a CA).
		g.Expire()
	}
	var hostKey *string
	if svc != nil {
		if k := svc.HostKey(); k != "" {
			hostKey = &k
		}
	}

	s := &api.Server{Grant: g, Records: rec, Events: ev, Available: available, HostKey: hostKey,
		RuntimeUID: uint32(*runtimeUID), ManagerUID: uint32(*managerUID)}
	l, err := listener(*socket)
	if err != nil {
		fail(err)
	}
	srv := &http.Server{
		Handler:           s.Handler(),
		ConnContext:       peercred.ConnContext,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       5 * time.Second,
		// The events' long poll waits up to 25 s; a transcript is at most 50 MiB over a local socket.
		WriteTimeout: 2 * time.Minute,
		IdleTimeout:  time.Minute,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	var wg sync.WaitGroup
	if available {
		wg.Go(func() { supervise(ctx, g, svc.Run, func() { ended(rec, logf) }, logf) })
	}
	wg.Go(func() { prune(ctx, rec, logf) })
	go func() {
		<-ctx.Done()
		notify("STOPPING=1")
		c, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = srv.Shutdown(c)
	}()

	status := fmt.Sprintf("%s image, remote help %s", *env, map[bool]string{true: "available", false: "not available"}[available])
	if lv := g.Level(); lv != "" {
		status += ", on (" + lv + ")"
	}
	logf("whombat-support: %s", status)
	notify("READY=1\nSTATUS=" + status)
	if err := srv.Serve(l); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fail(err)
	}
	wg.Wait()
	rec.Close()
	g.Close()
}

// gate is what supervise watches (grant.Store).
type gate interface {
	Level() string
	Changed() <-chan struct{}
}

// supervise runs the relay worker while the grant lets support in, and only then (RH-06): it starts when a grant does,
// is cancelled the moment the grant ends, and after it has stopped, end closes up. A worker that returns while the grant
// still runs is started again after a pause that grows to a minute.
func supervise(ctx context.Context, g gate, run func(context.Context) error, end func(), logf func(string, ...any)) {
	var cancel context.CancelFunc
	var done chan struct{}
	halt := func() {
		cancel()
		<-done
		cancel = nil
	}
	for {
		ch := g.Changed()
		on := g.Level() != ""
		switch {
		case on && cancel == nil:
			var wctx context.Context
			wctx, cancel = context.WithCancel(ctx)
			done = make(chan struct{})
			go func() {
				defer close(done)
				worker(wctx, run, logf)
			}()
		case !on && cancel != nil:
			halt()
			end()
		}
		select {
		case <-ch:
		case <-ctx.Done():
			if cancel != nil {
				halt()
			}
			return
		}
	}
}

// worker runs the relay worker until ctx ends, again after a pause when it returns early.
func worker(ctx context.Context, run func(context.Context) error, logf func(string, ...any)) {
	pause := firstPause
	for {
		err := run(ctx)
		if ctx.Err() != nil {
			return
		}
		logf("whombat-support: the relay worker stopped, again in %s: %v", pause, err)
		t := time.NewTimer(pause)
		select {
		case <-t.C:
		case <-ctx.Done():
			t.Stop()
			return
		}
		pause = min(pause*2, time.Minute)
	}
}

// ended closes up after a grant: the visits end now, and what they left running in the service's cgroup goes (NX-418).
func ended(rec *records.Store, logf func(string, ...any)) {
	rec.EndOpen()
	n, err := reap.Leftovers(reap.Options{Logf: logf})
	if err != nil {
		logf("whombat-support: ending what the visits left running: %v", err)
	}
	if n > 0 {
		logf("whombat-support: ended %d process(es) the visits left running", n)
	}
}

func prune(ctx context.Context, rec *records.Store, logf func(string, ...any)) {
	t := time.NewTicker(pruneEvery)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			if err := rec.Prune(); err != nil {
				logf("whombat-support: records: prune: %v", err)
			}
		case <-ctx.Done():
			return
		}
	}
}

// visitStart and visitEnd tell the runtime about visits (RH-08: owners hear of each, it signs remote_help.visit).
func visitStart(ev *events.Log) func(records.Meta) {
	return func(m records.Meta) {
		ev.Add(wire.Event{Kind: wire.EventVisitStart, VisitID: wire.Ptr(m.ID), Who: wire.Ptr(m.Who),
			Level: wire.Ptr(protocol.RemoteHelpLevel(m.Level))})
	}
}

func visitEnd(ev *events.Log) func(records.Meta) {
	return func(m records.Meta) {
		// Every step support took, also those past the record's cap.
		ev.Add(wire.Event{Kind: wire.EventVisitEnd, VisitID: wire.Ptr(m.ID), Who: wire.Ptr(m.Who),
			Level: wire.Ptr(protocol.RemoteHelpLevel(m.Level)), StartedAt: wire.Ptr(m.StartedAt.UTC().Format(time.RFC3339)),
			Steps: wire.Ptr(int64(m.Steps + m.StepsDropped))})
	}
}

var deviceIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// deviceID reads the device's id (the certificates' principal) when it is needed: a self-installed box gets it when it
// registers, after this service started.
func deviceID(path string) func() (string, error) {
	return func() (string, error) {
		b, err := os.ReadFile(path)
		if err != nil {
			return "", err
		}
		var d struct {
			DeviceID string `json:"deviceId"`
		}
		if err := json.Unmarshal(b, &d); err != nil || !deviceIDRe.MatchString(d.DeviceID) {
			return "", fmt.Errorf("%s has no device id", path)
		}
		return d.DeviceID, nil
	}
}

// listener is systemd's socket (LISTEN_FDS) or a new one at path, 0660.
func listener(path string) (net.Listener, error) {
	if os.Getenv("LISTEN_FDS") == "1" && os.Getenv("LISTEN_PID") == strconv.Itoa(os.Getpid()) {
		// FileListener dups fd 3; close the original, which Look and fix's children would otherwise inherit (the
		// runtime's socket, open in a support visitor's process).
		f := os.NewFile(3, "api.sock")
		l, err := net.FileListener(f)
		f.Close()
		return l, err
	}
	_ = os.Remove(path)
	l, err := net.Listen("unix", path)
	if err == nil {
		err = os.Chmod(path, 0o660)
	}
	return l, err
}

// notify sends a state to systemd ($NOTIFY_SOCKET); a no-op outside systemd.
func notify(state string) {
	path := os.Getenv("NOTIFY_SOCKET")
	if path == "" {
		return
	}
	if path[0] == '@' {
		path = "\x00" + path[1:]
	}
	conn, err := net.DialUnix("unixgram", nil, &net.UnixAddr{Name: path, Net: "unixgram"})
	if err != nil {
		return
	}
	defer conn.Close()
	_, _ = conn.Write([]byte(state))
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "whombat-support:", err)
	os.Exit(1)
}
