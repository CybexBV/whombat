package screen

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"image"
	"io"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"

	"rackoon/internal/proto"
	"rackoon/internal/wire"
)

// CLIUsage is `whombat-agent screen`'s help.
const CLIUsage = `whombat-agent screen OP [flags]     a Mac's screen, here and now (as root)
  status | look --out FILE [--max-width N] [--format png|jpeg] [--crop X,Y,W,H]
  click --x X --y Y [--button left|right|middle] [--clicks N] | drag --x X --y Y --to-x X --to-y Y
  scroll [--x X --y Y] [--dx N] [--dy N] | type --text TEXT | keys --keys "cmd+q tab" | unlock
  password                            the stored password into macOS's own password prompt in front
  account set --user USER --password-file FILE|- | account check | account clear
  ui apps | ui list [--app A] [--window W] [--limit N] | ui press --name N [--role R] [--index I]
  ui set [--name N] --value V | ui menu --app A --path "File>Save…" | ui focus --app A | ui open --target T
  ui action --name N --action A [--app A] [--role R] [--index I] | ui quit --app A
  map geocode --query Q [--query Q …]  places for addresses (Apple's geocoder)
  map snapshot --out FILE (--pin LAT,LON … | --lat L --lon L --span-m M) [--w W --h H] [--scale 1|2] [--dark] [--format jpeg|png]
  console-test --out FILE [--encodings raw|browser]   the host vnc console, as the browser sees it
  common: [--config-dir DIR] [--addr 127.0.0.1:5900] [--ui-root DIR] [--helper-app APP]`

// CLI runs one screen step locally (cmd/whombat-agent's `screen`) and
// prints its answer as JSON; a look's picture goes to --out.
func CLI(args []string, configDir string, stdout io.Writer, log *slog.Logger) error {
	if len(args) == 0 || isHelpWord(args[0]) {
		// Asking for help is not a mistake: the usage goes to stdout.
		fmt.Fprintln(stdout, CLIUsage)
		return nil
	}
	op := args[0]
	args = args[1:]
	group := op == "account" || op == "ui" || op == "map"
	if group && len(args) > 0 && !isHelpWord(args[0]) {
		op = op + "." + args[0]
		args = args[1:]
	}
	if op == "account" || op == "ui" || op == "map" {
		fmt.Fprintln(stdout, CLIUsage)
		return nil
	}
	fs := flag.NewFlagSet("screen "+op, flag.ContinueOnError)
	fs.SetOutput(stdout)
	fs.Usage = func() {
		fmt.Fprintln(stdout, CLIUsage)
		fmt.Fprintln(stdout, "\nflags:")
		fs.PrintDefaults()
	}
	dir := fs.String("config-dir", configDir, "the agent's config folder (screen.toml)")
	addr := fs.String("addr", DefaultAddr, "Screen Sharing")
	uiRoot := fs.String("ui-root", DefaultUIRoot, "the helpers' folders")
	helperApp := fs.String("helper-app", DefaultHelperApp, "the Whombat Helper app whose process alone is trusted on the socket")
	out := fs.String("out", "", "look, map snapshot, console-test: write the picture here")
	maxW := fs.Int("max-width", 0, "look: scale down to this width")
	format := fs.String("format", "", "look, map snapshot: png or jpeg")
	crop := fs.String("crop", "", "look: X,Y,W,H of the screen to take (pixels)")
	var req proto.ScreenRequest
	fs.IntVar(&req.X, "x", 0, "x (framebuffer pixels)")
	fs.IntVar(&req.Y, "y", 0, "y")
	fs.IntVar(&req.ToX, "to-x", 0, "drag: end x")
	fs.IntVar(&req.ToY, "to-y", 0, "drag: end y")
	fs.StringVar(&req.Button, "button", "", "left, right or middle")
	fs.IntVar(&req.Clicks, "clicks", 0, "1, 2 or 3")
	fs.IntVar(&req.DX, "dx", 0, "scroll steps right")
	fs.IntVar(&req.DY, "dy", 0, "scroll steps down")
	fs.StringVar(&req.Text, "text", "", "type: the text")
	fs.StringVar(&req.Text, "value", "", "ui set: the value")
	fs.StringVar(&req.Keys, "keys", "", "keys: \"cmd+q\", \"tab tab return\"")
	fs.StringVar(&req.App, "app", "", "ui: app name or bundle id")
	fs.StringVar(&req.Window, "window", "", "ui list: window title")
	fs.StringVar(&req.Name, "name", "", "ui press/set: the element's name")
	fs.StringVar(&req.Role, "role", "", "ui press/set: button, checkbox, text_field, …")
	fs.IntVar(&req.Index, "index", 0, "ui press/set: the n-th match")
	fs.IntVar(&req.Limit, "limit", 0, "ui list: at most this many")
	fs.StringVar(&req.Target, "target", "", "ui open: accessibility, an app or an https address")
	fs.StringVar(&req.Action, "action", "", "ui action: the action's name (\"Open Details\")")
	fs.Var((*stringList)(&req.Queries), "query", "map geocode: an address (again for more, up to 8)")
	var pins pinList
	fs.Var(&pins, "pin", "map snapshot: LAT,LON of a pin (again for more, up to 20)")
	if op == "map.snapshot" {
		// Only here: elsewhere -h asks for help.
		fs.IntVar(&req.W, "w", 0, "map snapshot: width in points (64 to 1600; 600)")
		fs.IntVar(&req.H, "h", 0, "map snapshot: height in points (64 to 1600; 400)")
	}
	fs.IntVar(&req.Scale, "scale", 0, "map snapshot: pixels per point, 1 or 2 (2)")
	fs.BoolVar(&req.Dark, "dark", false, "map snapshot: the dark map")
	lat := fs.String("lat", "", "map snapshot: the middle's latitude (with --lon and --span-m)")
	lon := fs.String("lon", "", "map snapshot: the middle's longitude")
	fs.Float64Var(&req.SpanM, "span-m", 0, "map snapshot: metres across the shorter side")
	path := fs.String("path", "", "ui menu: items separated by >")
	user := fs.String("user", "", "account set: the Mac's user")
	pwFile := fs.String("password-file", "", "account set: a file with the password, or - for stdin")
	encodings := fs.String("encodings", "raw", "console-test: raw, or browser (what noVNC asks for)")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	s := New(Options{ConfigDir: *dir, Addr: *addr, UIRoot: *uiRoot, HelperApp: *helperApp, Log: log})
	if uid, ok := s.consoleUID(); ok && os.Geteuid() == 0 {
		if err := ensureUIDirs(s.uiRoot, uid); err != nil {
			fmt.Fprintln(os.Stderr, "the helper's folder:", err)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	switch op {
	case "console-test":
		return consoleTest(ctx, s, *out, *encodings, stdout)
	case "account.set":
		pw, err := readPassword(*pwFile)
		if err != nil {
			return err
		}
		req.Account = &proto.ScreenAccount{User: *user, Password: pw}
	case "look":
		req.MaxW, req.Format = *maxW, *format
		if *crop != "" {
			c, err := parseInts(*crop, 4)
			if err != nil {
				return fmt.Errorf("--crop is X,Y,W,H: %w", err)
			}
			req.Crop = &proto.ScreenCrop{X: c[0], Y: c[1], W: c[2], H: c[3]}
		}
	case "map.snapshot":
		req.Format, req.Pins = *format, pins
		for _, f := range []struct {
			v   string
			dst **float64
		}{{*lat, &req.Lat}, {*lon, &req.Lon}} {
			if f.v == "" {
				continue
			}
			n, err := strconv.ParseFloat(f.v, 64)
			if err != nil {
				return fmt.Errorf("--lat and --lon are degrees: %w", err)
			}
			*f.dst = &n
		}
	case "ui.menu":
		for _, p := range strings.Split(*path, ">") {
			if p = strings.TrimSpace(p); p != "" {
				req.Path = append(req.Path, p)
			}
		}
	}
	req.Op = op
	resp := s.Screen(ctx, req)
	if len(resp.Image) > 0 {
		if *out == "" {
			return fmt.Errorf("%s: give --out FILE", op)
		}
		if err := os.WriteFile(*out, resp.Image, 0o600); err != nil {
			return err
		}
		fmt.Fprintf(os.Stderr, "wrote %s (%d bytes)\n", *out, len(resp.Image))
		resp.Image = nil
	}
	enc := json.NewEncoder(stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(resp); err != nil {
		return err
	}
	if !resp.OK {
		return fmt.Errorf("%s: %s", resp.Code, resp.Message)
	}
	return nil
}

// stringList is a flag given again for each value.
type stringList []string

func (l *stringList) String() string { return strings.Join(*l, "; ") }

func (l *stringList) Set(v string) error {
	*l = append(*l, v)
	return nil
}

// pinList is --pin LAT,LON, again for each pin.
type pinList []proto.MapPin

func (l *pinList) String() string { return fmt.Sprint(len(*l), " pins") }

func (l *pinList) Set(v string) error {
	parts := strings.Split(v, ",")
	if len(parts) != 2 {
		return errors.New("a pin is LAT,LON")
	}
	var ll [2]float64
	for i, p := range parts {
		n, err := strconv.ParseFloat(strings.TrimSpace(p), 64)
		if err != nil {
			return errors.New("a pin is LAT,LON in degrees")
		}
		ll[i] = n
	}
	*l = append(*l, proto.MapPin{Lat: ll[0], Lon: ll[1]})
	return nil
}

// parseInts reads n whole numbers separated by commas.
func parseInts(v string, n int) ([]int, error) {
	parts := strings.Split(v, ",")
	if len(parts) != n {
		return nil, fmt.Errorf("give %d numbers separated by commas", n)
	}
	out := make([]int, n)
	for i, p := range parts {
		x, err := strconv.Atoi(strings.TrimSpace(p))
		if err != nil {
			return nil, err
		}
		out[i] = x
	}
	return out, nil
}

func isHelpWord(s string) bool {
	switch s {
	case "-h", "-help", "--help", "help":
		return true
	}
	return false
}

func readPassword(file string) (string, error) {
	var r io.Reader
	switch file {
	case "":
		return "", errors.New("account set: give --password-file FILE (or - for stdin)")
	case "-":
		r = os.Stdin
	default:
		f, err := os.Open(file)
		if err != nil {
			return "", err
		}
		defer f.Close()
		r = f
	}
	line, err := bufio.NewReader(io.LimitReader(r, 4096)).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return "", err
	}
	return strings.TrimRight(line, "\r\n"), nil
}

// consoleTest opens the host's vnc console and plays the browser: security
// None, a pixel format, encodings, one full update. With raw encodings it
// writes the picture; with the browser's it reports what the Mac chose.
func consoleTest(ctx context.Context, s *Screen, out, encodings string, stdout io.Writer) error {
	sess, resp := s.Console(ctx)
	if !resp.OK {
		return fmt.Errorf("%s: %s", resp.Code, resp.Message)
	}
	in := make(chan wire.Frame, 16)
	outCh := make(chan wire.Frame, 1024)
	sctx, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- sess.Run(sctx, in, func(f wire.Frame) error {
			select {
			case outCh <- f:
				return nil
			case <-sctx.Done():
				return sctx.Err()
			}
		})
	}()
	defer func() { close(in); <-done }()
	var pending []byte
	read := func(n int) ([]byte, error) {
		for len(pending) < n {
			select {
			case f := <-outCh:
				if f.Kind == wire.FrameData {
					pending = append(pending, f.Payload...)
				} else {
					fmt.Fprintf(os.Stderr, "control: %s\n", f.Payload)
				}
			case err := <-done:
				done <- err
				return nil, fmt.Errorf("session ended: %v", err)
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		b := append([]byte(nil), pending[:n]...)
		pending = pending[n:]
		return b, nil
	}
	send := func(b []byte) { in <- wire.Frame{Kind: wire.FrameData, Payload: b} }
	ver, err := read(12)
	if err != nil {
		return err
	}
	send([]byte("RFB 003.008\n"))
	sec, err := read(2)
	if err != nil {
		return err
	}
	send([]byte{1})
	if _, err := read(4); err != nil {
		return err
	}
	send([]byte{1})
	si, err := read(24)
	if err != nil {
		return err
	}
	name, err := read(int(binary.BigEndian.Uint32(si[20:])))
	if err != nil {
		return err
	}
	w, h := int(binary.BigEndian.Uint16(si[0:])), int(binary.BigEndian.Uint16(si[2:]))
	fmt.Fprintf(stdout, "browser saw %q, security types %v, screen %dx%d %q, resolution %s\n", ver[:11], sec, w, h, name, resp.Resolution)
	send([]byte{0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0})
	encs := []int32{encRaw}
	if encodings == "browser" {
		encs = []int32{7, 16, 5, 1, encRaw, encDesktopSize, -239} // tight, zrle, hextile, copyrect, raw, desktop size, cursor
	}
	m := make([]byte, 4+4*len(encs))
	m[0] = 2
	binary.BigEndian.PutUint16(m[2:], uint16(len(encs)))
	for i, e := range encs {
		putInt32(m[4+4*i:], e)
	}
	send(m)
	req := []byte{3, 0, 0, 0, 0, 0, 0, 0, 0, 0}
	binary.BigEndian.PutUint16(req[6:], uint16(w))
	binary.BigEndian.PutUint16(req[8:], uint16(h))
	send(req)
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for {
		t, err := read(1)
		if err != nil {
			return err
		}
		switch t[0] {
		case 0:
		case 2:
			continue
		case 3:
			hdr, err := read(7)
			if err != nil {
				return err
			}
			if _, err := read(int(binary.BigEndian.Uint32(hdr[3:]))); err != nil {
				return err
			}
			continue
		default:
			return fmt.Errorf("server message %d", t[0])
		}
		hdr, err := read(3)
		if err != nil {
			return err
		}
		n := int(binary.BigEndian.Uint16(hdr[1:]))
		gotPixels := false
		for i := 0; i < n; i++ {
			rh, err := read(12)
			if err != nil {
				return err
			}
			rx, ry := int(binary.BigEndian.Uint16(rh[0:])), int(binary.BigEndian.Uint16(rh[2:]))
			rw, rhh := int(binary.BigEndian.Uint16(rh[4:])), int(binary.BigEndian.Uint16(rh[6:]))
			enc := int32(binary.BigEndian.Uint32(rh[8:]))
			fmt.Fprintf(stdout, "rectangle %d: %dx%d at %d,%d, encoding %d\n", i, rw, rhh, rx, ry, enc)
			if enc != encRaw {
				fmt.Fprintln(stdout, "the Mac answers the browser's encodings with that one; stopping here")
				return nil
			}
			px, err := read(rw * rhh * 4)
			if err != nil {
				return err
			}
			for y := 0; y < rhh; y++ {
				for x := 0; x < rw; x++ {
					o, d := (y*rw+x)*4, img.PixOffset(rx+x, ry+y)
					img.Pix[d], img.Pix[d+1], img.Pix[d+2], img.Pix[d+3] = px[o+2], px[o+1], px[o], 255
				}
			}
			gotPixels = true
		}
		if gotPixels {
			break
		}
	}
	if out == "" {
		return nil
	}
	data, err := encodeImage(img, "png")
	if err != nil {
		return err
	}
	fmt.Fprintf(stdout, "wrote %s\n", out)
	return os.WriteFile(out, data, 0o600)
}
