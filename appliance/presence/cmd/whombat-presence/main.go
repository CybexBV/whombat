// Command whombat-presence is the box's camera service for the desk display's “Stay unlocked while you're here”
// (Whombat DK-28…DK-33; NX-280…): while the runtime keeps asking, it reads the camera and says whether, and when, it
// last saw a face. It detects; it doesn't recognize. No picture is kept or sent, and it has no network.
//
//	whombat-presence --watch BIN --model FILE.onnx [--socket /run/whombat-presence/presence.sock] [--allow-uid 0,951]
//	                 [--sys /sys/class/video4linux] [--threshold 0] [--frames DIR]
//
// The camera is held by a child program (presence-watch): it runs only while the runtime watches (and 6 s after), so
// when it exits the camera, and its light, go off. Under socket activation (whombat-presence.socket) the socket is
// systemd's; otherwise it is made at --socket, 0660. --frames plays a folder of pictures as the only camera (the
// Nix check; never on a box).
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/peercred"
	"github.com/CybexBV/whombat/appliance/presence/internal/api"
	"github.com/CybexBV/whombat/appliance/presence/internal/camera"
	"github.com/CybexBV/whombat/appliance/presence/internal/watch"
	"github.com/CybexBV/whombat/contracts/go/local"
)

func main() {
	socket := flag.String("socket", local.PresenceSocketDefault, "the socket (ignored under socket activation)")
	bin := flag.String("watch", "presence-watch", "the camera program")
	model := flag.String("model", "", "the YuNet face detection model (.onnx)")
	allow := flag.String("allow-uid", "", "comma-separated uids that may connect (SO_PEERCRED); empty: the socket's mode decides")
	sys := flag.String("sys", "/sys/class/video4linux", "the kernel's video devices")
	threshold := flag.Float64("threshold", 0, "the face threshold (0: presence-watch's own)")
	frames := flag.String("frames", "", "a folder of pictures played as the only camera (checks only)")
	flag.Parse()

	uids, err := parseUIDs(*allow)
	if err != nil || *model == "" || *threshold < 0 || *threshold > 1 {
		fmt.Fprintln(os.Stderr, "whombat-presence: --model is required; --allow-uid is a list of uids; --threshold is 0–1:", err)
		os.Exit(2)
	}
	logf := func(f string, a ...any) { fmt.Fprintf(os.Stderr, f+"\n", a...) }
	prog := watch.Program{Bin: *bin, Model: *model, Threshold: *threshold}

	// The detector is checked once (a black frame through the model); without it there is nothing to watch with.
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	selfTest := prog.SelfTest(ctx)
	cancel()
	detector := selfTest == nil
	if !detector {
		logf("whombat-presence: the face detector doesn't work: %v", selfTest)
	}
	prober := &camera.Prober{Sys: *sys, Run: prog.Probe, Frames: *frames, Log: logf}
	w := watch.New(watch.Defaults(), watch.RealClock, prog.Spawn, prober.Cameras, logf)
	s := &api.Server{
		Watcher:   w,
		Camera:    func() bool { return len(prober.Cameras()) > 0 },
		Detector:  func() bool { return detector },
		AllowUIDs: uids,
	}

	l, err := listener(*socket)
	if err != nil {
		fmt.Fprintln(os.Stderr, "whombat-presence:", err)
		os.Exit(1)
	}
	srv := &http.Server{
		Handler:           s.Handler(),
		ConnContext:       peercred.ConnContext,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       5 * time.Second,
		// A health may run the camera probe (5 s at most).
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  time.Minute,
	}
	sig, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	go func() {
		<-sig.Done()
		notify("STOPPING=1")
		w.Close(2 * time.Second) // the camera goes off before the service does
		c, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = srv.Shutdown(c)
	}()
	word := "ready"
	if !detector {
		word = "not working"
	}
	status := fmt.Sprintf("face detector %s, %d camera(s)", word, len(prober.Cameras()))
	logf("whombat-presence: %s", status)
	notify("READY=1\nSTATUS=" + status)
	if err := srv.Serve(l); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fmt.Fprintln(os.Stderr, "whombat-presence:", err)
		os.Exit(1)
	}
	w.Close(2 * time.Second)
}

func parseUIDs(s string) ([]uint32, error) {
	var out []uint32
	for _, f := range strings.Split(s, ",") {
		if f = strings.TrimSpace(f); f == "" {
			continue
		}
		n, err := strconv.ParseUint(f, 10, 32)
		if err != nil {
			return nil, err
		}
		out = append(out, uint32(n))
	}
	return out, nil
}

// listener is systemd's socket (LISTEN_FDS) or a new one at path, 0660.
func listener(path string) (net.Listener, error) {
	if os.Getenv("LISTEN_FDS") == "1" && os.Getenv("LISTEN_PID") == strconv.Itoa(os.Getpid()) {
		return net.FileListener(os.NewFile(3, "presence.sock"))
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
