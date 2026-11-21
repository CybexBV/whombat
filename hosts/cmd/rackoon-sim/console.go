package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	"image/png"
	"strings"
	"sync"
	"time"

	"github.com/hashicorp/yamux"

	"rackoon/internal/hub/fakefleet"
	"rackoon/internal/proto"
	"rackoon/internal/wire"
)

// console answers a console stream with a fake terminal for shell / tty /
// serial, and "unsupported" for graphical protocols.
func (a *simAgent) console(ctx context.Context, st *yamux.Stream, req proto.ConsoleRequest) {
	if a.streamConsole(ctx, st, req) {
		return
	}
	g, ok := a.host.FindGuest(req.Platform, req.GuestID)
	if req.Platform == proto.PlatformHost {
		g, ok = fakefleet.GuestSpec{ID: a.host.ID, Kind: "host", Image: a.host.Pretty, State: proto.StateRunning}, true
	}
	switch {
	case !a.host.Policy.Console:
		_ = wire.WriteMsg(st, proto.ConsoleResponse{Code: "remote_control_disabled", Message: "Console is disabled in agent.toml."})
		return
	case !ok:
		_ = wire.WriteMsg(st, proto.ConsoleResponse{Code: "guest_not_found", Message: "No such guest on this host."})
		return
	case g.State == proto.StateStopped:
		_ = wire.WriteMsg(st, proto.ConsoleResponse{Code: "guest_not_running", Message: "The guest is powered off."})
		return
	case req.Protocol == proto.ProtoVNC || req.Protocol == proto.ProtoSPICE:
		_ = wire.WriteMsg(st, proto.ConsoleResponse{Code: "unsupported",
			Message: "The simulator has no graphical console. Use the serial console."})
		return
	}
	cols, rows := 132, 36
	if req.Protocol == proto.ProtoSerial {
		cols, rows = 80, 24
	}
	if err := wire.WriteMsg(st, proto.ConsoleResponse{OK: true, Resolution: fmt.Sprintf("%dx%d", cols, rows)}); err != nil {
		return
	}
	name := g.Name
	if name == "" {
		name = g.ID
	}
	fw := wire.NewFrameWriter(st)
	var wmu sync.Mutex
	write := func(f wire.Frame) error {
		wmu.Lock()
		defer wmu.Unlock()
		_ = st.SetWriteDeadline(time.Now().Add(30 * time.Second))
		return fw.Write(f)
	}
	ctl := func(cc wire.ConsoleControl) error {
		b, _ := json.Marshal(cc)
		return write(wire.Frame{Kind: wire.FrameControl, Payload: b})
	}
	out := func(s string) error { return write(wire.Frame{Kind: wire.FrameData, Payload: []byte(s)}) }
	prompt := fmt.Sprintf("\x1b[32mroot@%s\x1b[0m:~# ", name)
	_ = ctl(wire.ConsoleControl{Type: "status", State: "connected", Protocol: req.Protocol, Resolution: fmt.Sprintf("%dx%d", cols, rows)})
	banner := fmt.Sprintf("Rackoon simulator · %s console of %s (%s)\r\n", req.Protocol, name, g.Image)
	if req.Protocol == proto.ProtoSerial || req.Protocol == proto.ProtoTTY {
		banner += fmt.Sprintf("\r\n%s login: root (automatic)\r\n", name)
	}
	_ = out(banner + "Type 'help' for the few commands this fake shell knows.\r\n" + prompt)

	fr := wire.NewFrameReader(st)
	var line []byte
	started := time.Now()
	for {
		f, err := fr.Read()
		if err != nil {
			return
		}
		if ctx.Err() != nil {
			return
		}
		if f.Kind == wire.FrameControl {
			var cc wire.ConsoleControl
			if json.Unmarshal(f.Payload, &cc) != nil {
				continue
			}
			switch cc.Type {
			case "ping":
				_ = ctl(wire.ConsoleControl{Type: "pong", ID: cc.ID})
			case "resize":
				if cc.Cols > 0 && cc.Rows > 0 {
					cols, rows = cc.Cols, cc.Rows
				}
			case "open":
				_ = ctl(wire.ConsoleControl{Type: "error", Code: "unsupported", Message: "no sub-channels"})
			}
			continue
		}
		if f.Kind != wire.FrameData || f.Channel != 0 {
			continue
		}
		for _, b := range f.Payload {
			switch {
			case b == '\r' || b == '\n':
				cmd := strings.TrimSpace(string(line))
				line = line[:0]
				res, quit := a.shell(cmd, name, g.Image, cols, rows, started)
				_ = out("\r\n" + res)
				if quit {
					_ = out("logout\r\n")
					return
				}
				_ = out(prompt)
			case b == 0x7f || b == 0x08:
				if len(line) > 0 {
					line = line[:len(line)-1]
					_ = out("\b \b")
				}
			case b == 0x03:
				line = line[:0]
				_ = out("^C\r\n" + prompt)
			case b == 0x04:
				if len(line) == 0 {
					_ = out("logout\r\n")
					return
				}
			case b == 0x0c:
				_ = out("\x1b[H\x1b[2J" + prompt + string(line))
			case b >= 0x20 && b < 0x7f || b >= 0x80:
				if len(line) < 4096 {
					line = append(line, b)
					_ = out(string([]byte{b}))
				}
			}
		}
	}
}

func (a *simAgent) shell(cmd, name, image string, cols, rows int, started time.Time) (string, bool) {
	fields := strings.Fields(cmd)
	if len(fields) == 0 {
		return "", false
	}
	switch fields[0] {
	case "exit", "logout":
		return "", true
	case "help":
		return "commands: help hostname whoami uname uptime date ls df free stty echo clear exit\r\n", false
	case "hostname":
		return name + "\r\n", false
	case "whoami":
		return "root\r\n", false
	case "uname":
		return fmt.Sprintf("Linux %s 6.12.48-sim #1 SMP PREEMPT_DYNAMIC x86_64 GNU/Linux\r\n", name), false
	case "uptime":
		return fmt.Sprintf(" %s up %s,  1 user,  load average: 0.08, 0.05, 0.01\r\n",
			time.Now().Format("15:04:05"), time.Since(started).Truncate(time.Second)), false
	case "date":
		return time.Now().UTC().Format("Mon Jan  2 15:04:05 MST 2006") + "\r\n", false
	case "ls":
		return "\x1b[34mbin\x1b[0m  \x1b[34metc\x1b[0m  notes.txt  \x1b[34mscripts\x1b[0m\r\n", false
	case "df":
		return "Filesystem      Size  Used Avail Use% Mounted on\r\n/dev/sda1        32G   11G   20G  36% /\r\n", false
	case "free":
		return "               total        used        free      shared  buff/cache   available\r\nMem:           8.0Gi       2.1Gi       3.9Gi        12Mi       2.0Gi       5.9Gi\r\n", false
	case "stty":
		return fmt.Sprintf("%d %d\r\n", rows, cols), false
	case "echo":
		return strings.Join(fields[1:], " ") + "\r\n", false
	case "clear":
		return "\x1b[H\x1b[2J", false
	case "cat":
		if len(fields) > 1 && fields[1] == "/etc/os-release" {
			return fmt.Sprintf("PRETTY_NAME=%q\r\n", image), false
		}
	}
	return fmt.Sprintf("-sh: %s: command not found\r\n", fields[0]), false
}

// thumbnail renders a fake screen.
func (a *simAgent) thumbnail(req proto.ThumbnailRequest) proto.ThumbnailResponse {
	g, ok := a.host.FindGuest(req.Platform, req.GuestID)
	switch {
	case !a.host.Policy.Console:
		return proto.ThumbnailResponse{Code: "remote_control_disabled", Message: "Console is disabled in agent.toml."}
	case !ok:
		return proto.ThumbnailResponse{Code: "guest_not_found"}
	case g.State == proto.StateStopped:
		return proto.ThumbnailResponse{Code: "guest_not_running", Message: "The guest is powered off."}
	case g.Kind != "vm":
		return proto.ThumbnailResponse{Code: "unsupported", Message: "Containers have no screen."}
	}
	w, h := 1280, 800
	if req.MaxWidth > 0 && req.MaxWidth < w {
		h = h * req.MaxWidth / w
		w = req.MaxWidth
	}
	img := renderScreen(g.Name+"|"+g.ID, w, h, time.Now())
	var buf bytes.Buffer
	var err error
	if req.Format == "png" {
		err = png.Encode(&buf, img)
	} else {
		err = jpeg.Encode(&buf, img, &jpeg.Options{Quality: 70})
	}
	if err != nil {
		return proto.ThumbnailResponse{Code: "error", Message: err.Error()}
	}
	return proto.ThumbnailResponse{Image: buf.Bytes(), Width: w, Height: h}
}

// renderScreen draws a desktop-like picture: a colored background, a
// window with "text" lines and a moving progress bar (so refreshes show).
func renderScreen(key string, w, h int, t time.Time) *image.RGBA {
	hs := fnv.New32a()
	hs.Write([]byte(key))
	seed := hs.Sum32()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	bg := color.RGBA{uint8(20 + seed%40), uint8(30 + (seed>>8)%50), uint8(60 + (seed>>16)%80), 255}
	draw.Draw(img, img.Bounds(), &image.Uniform{bg}, image.Point{}, draw.Src)
	// Task bar.
	draw.Draw(img, image.Rect(0, h-h/20, w, h), &image.Uniform{color.RGBA{16, 18, 22, 255}}, image.Point{}, draw.Src)
	// Window.
	x0, y0, x1, y1 := w/8, h/8, w*7/8, h*3/4
	draw.Draw(img, image.Rect(x0, y0, x1, y1), &image.Uniform{color.RGBA{236, 238, 242, 255}}, image.Point{}, draw.Src)
	draw.Draw(img, image.Rect(x0, y0, x1, y0+h/24), &image.Uniform{color.RGBA{60, 64, 72, 255}}, image.Point{}, draw.Src)
	lineH := max(h/40, 2)
	for i := 0; ; i++ {
		y := y0 + h/24 + lineH + i*lineH*2
		if y+lineH > y1-lineH*3 {
			break
		}
		lw := (x1 - x0 - 2*lineH) * int(30+(seed>>(i%24))%60) / 100
		draw.Draw(img, image.Rect(x0+lineH, y, x0+lineH+lw, y+lineH), &image.Uniform{color.RGBA{150, 156, 168, 255}}, image.Point{}, draw.Src)
	}
	// Progress bar that moves every few seconds.
	pw := (x1 - x0 - 2*lineH) * int(t.Unix()/5%20+1) / 20
	draw.Draw(img, image.Rect(x0+lineH, y1-lineH*2, x0+lineH+pw, y1-lineH), &image.Uniform{color.RGBA{57, 135, 229, 255}}, image.Point{}, draw.Src)
	return img
}
