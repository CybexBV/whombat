package sshd

import (
	"context"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/CybexBV/whombat/appliance/support/internal/fix"
	"github.com/CybexBV/whombat/appliance/support/internal/look"
	"github.com/CybexBV/whombat/appliance/support/internal/wire"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

func refusal(reason string) protocol.RemoteHelpRefusal { return protocol.RemoteHelpRefusal(reason) }

// fixHelp follows Look's help at Look and fix.
const fixHelp = `
With Look and fix (as root; what these print is kept for the owners, what you type isn't):
  restart UNIT              restart one unit
  any other command         runs with sh -c
  ssh without a command     a command line (bash -l)
  ssh -L / -W               to 127.0.0.1 or ::1, and to sockets under /run
`

const lookOnly = "That needs Look and fix; remote help is at Look on this Whombat.\n"

// Requests' payloads (RFC 4254).
type ptyRequest struct {
	Term                      string
	Cols, Rows, Width, Height uint32
	Modes                     string
}

type windowChange struct {
	Cols, Rows, Width, Height uint32
}

type execRequest struct{ Command string }

type subsystemRequest struct{ Name string }

type exitStatus struct{ Status uint32 }

func window(cols, rows uint32) fix.Window {
	return fix.Window{Cols: uint16(min(cols, 1000)), Rows: uint16(min(rows, 1000))}
}

// session serves one session channel: one exec or shell, a terminal when the level and the certificate allow it.
func (c *conn) session(ctx context.Context, nc ssh.NewChannel) {
	ch, reqs, err := nc.Accept()
	if err != nil {
		return
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var term *fix.Term
	winch := make(chan fix.Window, 1)
	started := false
	var running sync.WaitGroup
	reply := func(r *ssh.Request, ok bool) {
		if r.WantReply {
			_ = r.Reply(ok, nil)
		}
	}
	for r := range reqs {
		switch r.Type {
		case "pty-req":
			var p ptyRequest
			ok := !started && term == nil && c.pty && c.s.cfg.Gate.Level() == wire.LevelFix &&
				ssh.Unmarshal(r.Payload, &p) == nil
			if ok {
				term = &fix.Term{Name: p.Term, Window: window(p.Cols, p.Rows)}
			}
			reply(r, ok)
		case "window-change":
			var p windowChange
			if term != nil && ssh.Unmarshal(r.Payload, &p) == nil {
				select { // keep only the newest size
				case <-winch:
				default:
				}
				winch <- window(p.Cols, p.Rows)
			}
			reply(r, term != nil)
		case "exec", "shell":
			var p execRequest
			if started || (r.Type == "exec" && ssh.Unmarshal(r.Payload, &p) != nil) {
				reply(r, false)
				continue
			}
			started = true
			reply(r, true)
			running.Add(1)
			go func(kind, line string) {
				defer running.Done()
				code := c.run(ctx, ch, kind, line, term, winch)
				_, _ = ch.SendRequest("exit-status", false, ssh.Marshal(exitStatus{uint32(code)}))
				_ = ch.CloseWrite()
				_ = ch.Close()
			}(r.Type, p.Command)
		case "subsystem":
			var p subsystemRequest
			_ = ssh.Unmarshal(r.Payload, &p)
			c.refuse(wire.ReasonLimit, look.Truncate("subsystem "+p.Name, 60), "")
			reply(r, false)
		case "x11-req":
			c.refuse(wire.ReasonLimit, "x11 forwarding", "")
			reply(r, false)
		case "auth-agent-req@openssh.com":
			c.refuse(wire.ReasonLimit, "agent forwarding", "")
			reply(r, false)
		default: // env (nothing from the client reaches a command), signal, keepalive, …
			reply(r, false)
		}
	}
	cancel()
	running.Wait()
	close(winch)
	_ = ch.Close()
}

// run is one exec or shell; it answers the exit status.
func (c *conn) run(ctx context.Context, ch ssh.Channel, kind, line string, term *fix.Term, winch <-chan fix.Window) int {
	level := c.s.cfg.Gate.Level()
	stderr := ch.Stderr()
	if level == "" {
		io.WriteString(stderr, "Remote help is off.\n")
		return 1
	}
	fio := fix.IO{In: ch, Out: ch, Err: stderr, Transcript: c.visit.Transcript()}
	if kind == "shell" {
		if level != wire.LevelFix {
			c.refuse(wire.ReasonLevel, "command line", "")
			io.WriteString(stderr, lookOnly+"\n"+look.Help())
			return 1
		}
		start := c.s.cfg.Now()
		code, err := c.s.fix.Shell(ctx, fio, term, winch)
		secs := int64(c.s.cfg.Now().Sub(start) / time.Second)
		c.visit.Step(wire.Step{Kind: wire.StepShell, Seconds: wire.Ptr(secs)})
		if err != nil && ctx.Err() == nil {
			fmt.Fprintf(stderr, "%v\n", err)
		}
		return code
	}

	first := ""
	if f := strings.Fields(line); len(f) > 0 {
		first = f[0]
	}
	switch {
	case look.IsCommand(first):
		cmd, err := look.Parse(line)
		if err != nil {
			return c.refused(stderr, err, line)
		}
		c.visit.Step(cmd.Step())
		code := c.s.look.Run(ctx, cmd, ch, stderr)
		if cmd.Name == "help" && level == wire.LevelFix {
			io.WriteString(ch, fixHelp)
		}
		return code
	case first == "restart":
		if level != wire.LevelFix {
			c.refuse(wire.ReasonLevel, line, "")
			io.WriteString(stderr, lookOnly)
			return 1
		}
		words, err := look.Split(line)
		if err != nil || len(words) != 2 || !look.ValidUnit(words[1]) {
			c.refuse(wire.ReasonBadArguments, line, "")
			io.WriteString(stderr, "restart takes one unit name.\n")
			return 2
		}
		c.visit.Step(wire.Step{Kind: wire.StepRestart, Units: []string{words[1]}})
		code, err := c.s.fix.Restart(ctx, words[1], fio)
		if err != nil && ctx.Err() == nil {
			fmt.Fprintf(stderr, "%v\n", err)
		}
		return code
	case level == wire.LevelFix && first != "":
		c.visit.Step(wire.Step{Kind: wire.StepExec, Line: wire.Ptr(line)})
		code, err := c.s.fix.Exec(ctx, line, fio, term, winch)
		if err != nil && ctx.Err() == nil {
			fmt.Fprintf(stderr, "%v\n", err)
		}
		return code
	case first != "":
		// Any other command runs at Look and fix (sh -c); at Look it is refused as needing it.
		c.refuse(wire.ReasonLevel, line, "")
		fmt.Fprintf(stderr, "%sLook commands: %s.\n", lookOnly, strings.Join(wire.LookCommands, ", "))
		return 1
	default:
		_, err := look.Parse(line)
		return c.refused(stderr, err, line)
	}
}

// refused records a Look refusal and tells the support person why.
func (c *conn) refused(stderr io.Writer, err error, line string) int {
	reason := wire.ReasonUnknownCommand
	if r, ok := err.(*look.Refusal); ok {
		reason = r.Reason
	}
	c.refuse(reason, line, "")
	if err != nil {
		fmt.Fprintf(stderr, "%v\n", err)
	}
	if reason == wire.ReasonBadArguments {
		return 2
	}
	return 1
}
