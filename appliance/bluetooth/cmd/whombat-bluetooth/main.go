// Command whombat-bluetooth is the box's Bluetooth service (Whombat BT-01…BT-10; NX-350…): the only program that
// talks to BlueZ (the D-Bus policy lets in nothing else but root and the sound server, BT-09). The runtime asks it,
// on a local socket, for the adapter and the paired devices, to look for devices, to pair one (the box finds the
// device, never the other way round: there is a pairing agent only while a pairing an owner started runs, BT-03), and
// to connect, disconnect and remove paired ones.
//
//	whombat-bluetooth [--socket /run/whombat-bluetooth/bluetooth.sock] [--allow-uid 0,951] [--bus ADDRESS]
//	                  [--sys /sys]
//
// Under socket activation (whombat-bluetooth.socket) the socket is systemd's; otherwise it is made at --socket, 0660.
// Logs name devices, never their addresses (BT-10).
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

	"github.com/CybexBV/whombat/appliance/bluetooth/internal/api"
	"github.com/CybexBV/whombat/appliance/bluetooth/internal/bluez"
	"github.com/CybexBV/whombat/appliance/bluetooth/internal/service"
	"github.com/CybexBV/whombat/appliance/helper/pkg/peercred"
	"github.com/CybexBV/whombat/contracts/go/local"
)

func main() {
	socket := flag.String("socket", local.BluetoothSocketDefault, "the socket (ignored under socket activation)")
	allow := flag.String("allow-uid", "", "comma-separated uids that may connect (SO_PEERCRED); empty: the socket's mode decides")
	bus := flag.String("bus", bluez.DefaultBus, "the system bus")
	sys := flag.String("sys", "/sys", "the kernel's sysfs")
	flag.Parse()

	uids, err := parseUIDs(*allow)
	if err != nil {
		fmt.Fprintln(os.Stderr, "whombat-bluetooth: --allow-uid is a list of uids:", err)
		os.Exit(2)
	}
	logf := func(f string, a ...any) { fmt.Fprintf(os.Stderr, f+"\n", a...) }
	bz := &bluez.DBus{Bus: *bus}
	cfg := service.Defaults()
	cfg.Sys = *sys
	svc := service.New(cfg, bz, service.RealClock, logf)
	s := &api.Server{Bluetooth: svc, AllowUIDs: uids}

	l, err := listener(*socket)
	if err != nil {
		fmt.Fprintln(os.Stderr, "whombat-bluetooth:", err)
		os.Exit(1)
	}
	srv := &http.Server{
		Handler:           s.Handler(),
		ConnContext:       peercred.ConnContext,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       5 * time.Second,
		// A connect waits up to 15 s.
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  time.Minute,
	}
	sig, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	go func() {
		<-sig.Done()
		notify("STOPPING=1")
		c, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = srv.Shutdown(c)
	}()
	status := "ready"
	if st, err := svc.State(); err == nil && st.Adapter != nil {
		status = fmt.Sprintf("ready, %d paired device(s)", len(st.Devices))
	} else if err == nil && st.Missing != nil {
		status = "ready, no adapter (" + string(*st.Missing) + ")"
	}
	logf("whombat-bluetooth: %s", status)
	notify("READY=1\nSTATUS=" + status)
	if err := srv.Serve(l); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fmt.Fprintln(os.Stderr, "whombat-bluetooth:", err)
		os.Exit(1)
	}
	// Looking and a running pairing end with the service; dropping the connection tells BlueZ.
	svc.Close()
	_ = bz.Close()
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
		return net.FileListener(os.NewFile(3, "bluetooth.sock"))
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
