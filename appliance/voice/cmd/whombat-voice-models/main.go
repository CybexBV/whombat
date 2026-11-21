// Command whombat-voice-models is the speech models' fetcher (Whombat DT-05; NX-473): it downloads the models the
// runtime asks for, from the sources the release's manifest names, into the directory the voice service reads, and
// answers how far each one is, on a Unix socket. The voice service has no network; this one has, and hears nothing.
//
//	whombat-voice-models --manifest FILE --dir DIR [--socket /run/whombat-voice-models/models.sock] [--allow-uid 0,951]
//
// Under socket activation (whombat-voice-models.socket) the socket is systemd's; otherwise it is made at --socket, 0660.
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
	"github.com/CybexBV/whombat/appliance/voice/internal/fetch"
	"github.com/CybexBV/whombat/appliance/voice/internal/models"
	"github.com/CybexBV/whombat/contracts/go/local"
)

func main() {
	socket := flag.String("socket", local.VoiceModelsSocketDefault, "the socket (ignored under socket activation)")
	manifest := flag.String("manifest", "", "the release's speech models (models.Manifest)")
	dir := flag.String("dir", "", "where the models go (the voice service reads them there)")
	allow := flag.String("allow-uid", "", "comma-separated uids that may connect (SO_PEERCRED); empty: the socket's mode decides")
	flag.Parse()

	uids, err := parseUIDs(*allow)
	m, merr := models.Load(*manifest)
	if err == nil {
		err = merr
	}
	if err != nil || *dir == "" {
		fmt.Fprintln(os.Stderr, "whombat-voice-models: --manifest and --dir are required; --allow-uid is a list of uids:", err)
		os.Exit(2)
	}
	logf := func(f string, a ...any) { fmt.Fprintf(os.Stderr, f+"\n", a...) }
	f := &fetch.Fetcher{Manifest: m, Dir: *dir, Client: client(), Log: logf}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	if err := f.Start(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "whombat-voice-models:", err)
		os.Exit(1)
	}

	l, err := listener(*socket)
	if err != nil {
		fmt.Fprintln(os.Stderr, "whombat-voice-models:", err)
		os.Exit(1)
	}
	srv := &http.Server{
		Handler:           (&fetch.Server{Fetcher: f, AllowUIDs: uids}).Handler(),
		ConnContext:       peercred.ConnContext,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       time.Minute,
	}
	go func() {
		<-ctx.Done()
		notify("STOPPING=1")
		c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(c)
	}()
	var ready []string
	for _, s := range f.State().Models {
		ready = append(ready, s.ID+" "+s.State)
	}
	status := strings.Join(ready, ", ")
	fmt.Fprintln(os.Stderr, "whombat-voice-models:", status)
	notify("READY=1\nSTATUS=" + status)
	if err := srv.Serve(l); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fmt.Fprintln(os.Stderr, "whombat-voice-models:", err)
		os.Exit(1)
	}
}

// client follows redirects to the sources' download hosts over https only; a slow source may take as long as it
// takes, a silent one ends the download (fetch.IdleTimeout).
func client() *http.Client {
	return &http.Client{
		Transport: &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			DialContext:           (&net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
			TLSHandshakeTimeout:   30 * time.Second,
			ResponseHeaderTimeout: time.Minute,
			ForceAttemptHTTP2:     true,
			MaxIdleConns:          4,
			IdleConnTimeout:       90 * time.Second,
		},
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return errors.New("too many redirects")
			}
			if req.URL.Scheme != "https" {
				return fmt.Errorf("a redirect to %s", req.URL.Scheme)
			}
			return nil
		},
	}
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
		return net.FileListener(os.NewFile(3, "models.sock"))
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
