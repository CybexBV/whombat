// Command whombat-console draws the appliance's local console (CC-08, NX-32): the claim code while the
// appliance waits for its owner, the claim state otherwise. It reads the state file the runtime writes
// (WHOMBAT_CONSOLE_FILE) once a second and redraws the whole screen when anything changes. It has no
// credential: the runtime is the authority, this only shows its file. It writes nothing. Key presses on tty1 are
// read and dropped, so nothing typed shows up on the screen; one key does something: N on the claim screen asks the
// runtime for new letters (Whombat whombat-link.md), through the desk socket when one is given.
//
//	whombat-console [--file /run/whombat/console/console.json] [--footer-file F] [--start-file F]   (tty1, systemd)
//	    [--desk-socket /run/whombat/console/desk.sock --desk-peer-uid N]              (N for new letters)
//	whombat-console --once [--file F] [--width N]                                    (one frame to stdout)
//	whombat-console --once --json [--file F]                                         (the Console API's state)
//	whombat-console --serve 127.0.0.1:8411 --ui DIR --token-file F [--file F] …      (graphical console, CG-03)
//	    [--desk-socket /run/whombat/console/desk.sock --desk-peer-uid N]              (the desk display, NX-160)
//
// --serve is the graphical console's server (CG-03, CG-06, NX-78): the static UI from --ui at /, and the Console
// API under /api/ behind a token made at every start and written to --token-file (0640; its directory's group is
// the kiosk's). It reads the same file with the same validation as the text console; it never touches a
// terminal. On the appliance it runs in a network namespace of its own that only the kiosk joins.
//
// --desk-socket is the runtime's desk socket (Whombat DK-12). With --serve or --once --json the API's `desk` is its
// state, checked and cleaned, and /api/desk/… pass the page's requests to it; the API's `network` and /api/network…
// are the box's network and Wi-Fi through the same socket (HD-07, CG-100). The text console dials it for one thing:
// new claim letters when someone presses N. The socket must be served by --desk-peer-uid (the runtime's user).
//
// A missing, unreadable or invalid state file shows the starting screen ("Starting Whombat…"), or why the first start
// can't finish when the provisioning unit wrote that (--start-file, CG-409).
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/CybexBV/whombat/contracts/go/local"
	"golang.org/x/sys/unix"

	"github.com/CybexBV/whombat/appliance/console/internal/consoleapi"
	"github.com/CybexBV/whombat/appliance/console/internal/desk"
	"github.com/CybexBV/whombat/appliance/console/internal/screen"
	"github.com/CybexBV/whombat/appliance/console/internal/source"
	"github.com/CybexBV/whombat/appliance/console/internal/web"
)

// DefaultFile is where the appliance's runtime writes the console state (NX-32: its own directory, not
// the contract's local.ConsoleFileDefault /run/whombat/console.json, so the file can have its own group).
const DefaultFile = "/run/whombat/console/console.json"

const (
	clearScreen = "\x1b[H\x1b[2J\x1b[3J"
	hideCursor  = "\x1b[?25l"
	showCursor  = "\x1b[?25h"
	// Redraw now and then even without a change: repairs anything else that wrote to the VT.
	refresh = time.Minute
)

func main() {
	def := os.Getenv(local.ConsoleFileEnv)
	if def == "" {
		def = DefaultFile
	}
	file := flag.String("file", def, "console state file (env WHOMBAT_CONSOLE_FILE)")
	once := flag.Bool("once", false, "print one frame to stdout and exit")
	footerFile := flag.String("footer-file", "", "footer text (default: the built-in repair line)")
	width := flag.Int("width", 0, "columns (default: the terminal's, else 80)")
	height := flag.Int("height", 0, "lines (default: the terminal's; --once: compact)")
	interval := flag.Duration("interval", time.Second, "poll interval")
	asJSON := flag.Bool("json", false, "with --once: print the Console API's state (GET /api/state) instead of a frame")
	serve := flag.String("serve", "", "serve the graphical console on this loopback address (e.g. 127.0.0.1:8411)")
	uiDir := flag.String("ui", "", "with --serve: the UI's static files")
	tokenFile := flag.String("token-file", "", "with --serve: where the per-start API token goes (0640)")
	deskSocket := flag.String("desk-socket", "", "the runtime's desk socket (the page's desk; on tty1: N for new letters)")
	deskPeer := flag.Int("desk-peer-uid", -1, "with --desk-socket: the uid that must serve it (the runtime's)")
	startFile := flag.String("start-file", "", "why the first start can't finish (the provisioning unit's file; CG-409)")
	flag.Parse()
	// The runtime's state, and on the starting screen why the first start can't finish.
	load := func() screen.Screen {
		s := source.Load(*file)
		if s.State == screen.Starting {
			s.Start = source.LoadStart(*startFile)
		}
		return s
	}

	footer, err := source.LoadFooter(*footerFile)
	if err != nil {
		fmt.Fprintln(os.Stderr, "whombat-console:", err)
		os.Exit(1)
	}
	api := consoleapi.New(load, footer, nil)
	var deskClient *desk.Client
	if *deskSocket != "" {
		if *deskPeer < 0 {
			fmt.Fprintln(os.Stderr, "whombat-console: --desk-socket needs --desk-peer-uid")
			os.Exit(2)
		}
		logf := func(format string, args ...any) { fmt.Fprintf(os.Stderr, "whombat-console: "+format+"\n", args...) }
		deskClient = desk.New(*deskSocket, *deskPeer, nil, logf)
	}
	if deskClient != nil && (*serve != "" || (*once && *asJSON)) {
		api.WithDesk(deskClient)
	}
	// The text console offers new letters only when it can ask the runtime for them.
	textLoad := func() screen.Screen {
		s := load()
		s.NewLetters = s.NewLetters && deskClient != nil
		return s
	}
	if *once && *asJSON {
		b, _ := json.MarshalIndent(api.State(context.Background()), "", "  ")
		fmt.Println(string(b))
		return
	}
	if *serve != "" {
		if err := serveGUI(*serve, *uiDir, *tokenFile, api); err != nil {
			fmt.Fprintln(os.Stderr, "whombat-console:", err)
			os.Exit(1)
		}
		return
	}
	if *once {
		w, _ := termSize()
		if *width > 0 {
			w = *width
		}
		fmt.Print(screen.Render(textLoad(), time.Now(), w, *height, footer))
		return
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
	tick := time.NewTicker(*interval)
	defer tick.Stop()
	restore := rawInput(int(os.Stdin.Fd()))
	defer restore()
	input := readInput(os.Stdin)
	var last string
	var drawn time.Time
	var wait screen.WaitWatch
	for {
		w, h := termSize()
		if *width > 0 {
			w = *width
		}
		if *height > 0 {
			h = *height
		}
		shown, now := textLoad(), time.Now()
		shown.WaitedLong = wait.Long(shown, now)
		frame := screen.Render(shown, now, w, h, footer)
		if frame != last || time.Since(drawn) >= refresh {
			if _, err := io.WriteString(os.Stdout, clearScreen+hideCursor+frame); err != nil {
				fmt.Fprintln(os.Stderr, "whombat-console:", err)
				os.Exit(1)
			}
			last, drawn = frame, time.Now()
		}
		select {
		case <-tick.C:
		case keys, ok := <-input:
			if !ok {
				input = nil // no terminal on stdin (or it went away): the screen still updates
			}
			// N on a screen that offers it: new letters. Every other key is dropped, as before.
			if shown.NewLetters && screen.AsksNewLetters(keys) {
				askNewLetters(deskClient)
			}
		case <-sig:
			_, _ = io.WriteString(os.Stdout, showCursor)
			return
		}
	}
}

// askNewLetters passes the N key on to the runtime. Nothing is drawn here: the runtime writes the new letters to the
// state file and the next poll shows them; a refusal or a runtime that doesn't answer leaves the screen as it was.
func askNewLetters(c *desk.Client) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := c.ClaimLetters(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "whombat-console: new letters:", err)
	}
}

// serveGUI runs the graphical console's server until SIGTERM: listen first, then the token file, then READY=1
// (the kiosk starts after it and reads the token once), and the token file goes away on the way out.
func serveGUI(addr, uiDir, tokenFile string, api *consoleapi.Server) error {
	if uiDir == "" || tokenFile == "" {
		return fmt.Errorf("--serve needs --ui and --token-file")
	}
	if st, err := os.Stat(uiDir); err != nil || !st.IsDir() {
		return fmt.Errorf("--ui %s: not a directory", uiDir)
	}
	ln, port, err := web.Listen(addr)
	if err != nil {
		return err
	}
	token, err := web.NewToken()
	if err != nil {
		return err
	}
	if err := web.WriteTokenFile(tokenFile, token); err != nil {
		return fmt.Errorf("token file: %w", err)
	}
	defer os.Remove(tokenFile)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
	defer stop()
	h := web.Handler(web.Options{Port: port, Token: token, UI: os.DirFS(uiDir), API: api.Handler(), MaxBody: 1024,
		Limits: consoleapi.BodyLimits})
	_ = web.Notify("READY=1\nSTATUS=serving the graphical console on " + ln.Addr().String())
	return web.Serve(ctx, ln, h)
}

// rawInput turns off line editing, echo and signal keys on a terminal stdin (key presses must never show up
// on the VT by themselves, and Ctrl-C must not stop the console). Not a terminal: nothing to do.
func rawInput(fd int) func() {
	t, err := unix.IoctlGetTermios(fd, unix.TCGETS)
	if err != nil {
		return func() {}
	}
	old := *t
	t.Lflag &^= unix.ICANON | unix.ECHO | unix.ECHONL | unix.ISIG | unix.IEXTEN
	t.Iflag &^= unix.IXON | unix.ICRNL | unix.INLCR | unix.IGNCR
	t.Cc[unix.VMIN], t.Cc[unix.VTIME] = 1, 0
	if err := unix.IoctlSetTermios(fd, unix.TCSETS, t); err != nil {
		return func() {}
	}
	return func() { _ = unix.IoctlSetTermios(fd, unix.TCSETS, &old) }
}

// readInput drains stdin (key presses are dropped); the channel closes at end of input (e.g. /dev/null).
func readInput(r io.Reader) <-chan []byte {
	ch := make(chan []byte, 16)
	go func() {
		defer close(ch)
		buf := make([]byte, 64)
		for {
			n, err := r.Read(buf)
			if n > 0 {
				ch <- append([]byte(nil), buf[:n]...)
			}
			if err != nil {
				return
			}
		}
	}()
	return ch
}

// termSize is stdout's size (the VT on the appliance), 80×0 when it isn't a terminal.
func termSize() (int, int) {
	ws, err := unix.IoctlGetWinsize(int(os.Stdout.Fd()), unix.TIOCGWINSZ)
	if err != nil || ws.Col == 0 {
		return 80, 0
	}
	return int(ws.Col), int(ws.Row)
}
