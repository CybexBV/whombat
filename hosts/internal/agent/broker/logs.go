package broker

import (
	"context"
	"errors"
	"io"
	"sync"

	"rackoon/internal/wire"
)

// logSession relays a read-only text stream (Docker logs, the host
// journal) to the browser's terminal on channel 0. Browser input is
// ignored, except a "close" control. When the source ends, endNote is
// shown and the session stays open until the browser closes it (a stopped
// container's log stays readable).
type logSession struct {
	protocol string
	src      io.Reader
	closeSrc func() // stops the source; called once
	endNote  string

	once sync.Once
}

func (s *logSession) stop() {
	s.once.Do(func() {
		if s.closeSrc != nil {
			s.closeSrc()
		}
	})
}

// errOut marks a failed write to the browser.
type errOut struct{ err error }

func (e errOut) Error() string { return e.err.Error() }

func (s *logSession) Run(ctx context.Context, in <-chan wire.Frame, out func(wire.Frame) error) error {
	stop := context.AfterFunc(ctx, s.stop)
	defer stop()
	defer s.stop()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if err := sendStatus(out, s.protocol, ""); err != nil {
		return err
	}
	srcDone := make(chan error, 1)
	go func() {
		var conv crlf
		buf := make([]byte, 32<<10)
		for {
			n, err := s.src.Read(buf)
			if n > 0 {
				if werr := out(wire.Frame{Kind: wire.FrameData, Payload: conv.convert(buf[:n])}); werr != nil {
					srcDone <- errOut{werr}
					return
				}
			}
			if err != nil {
				srcDone <- err
				return
			}
		}
	}()
	done := srcDone
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-done:
			done = nil
			if ctx.Err() != nil {
				return ctx.Err()
			}
			var eo errOut
			if errors.As(err, &eo) {
				return eo.err
			}
			note := s.endNote
			if !isEOF(err) && !errors.Is(err, context.Canceled) {
				note = "-- log stream failed: " + err.Error() + " --"
			}
			if note == "" {
				return nil
			}
			if err := out(wire.Frame{Kind: wire.FrameData, Payload: []byte("\r\n\x1b[2m" + note + "\x1b[0m\r\n")}); err != nil {
				return err
			}
		case f, ok := <-in:
			if !ok {
				return nil
			}
			if cc, ok := parseControl(f); ok && cc.Type == "close" && cc.Channel == 0 {
				return nil
			}
			// Read-only: data and resize are ignored.
		}
	}
}

// crlf turns bare line feeds into CR LF for the terminal (log lines end in
// "\n"; text that already has "\r\n" is left alone).
type crlf struct{ lastCR bool }

func (c *crlf) convert(p []byte) []byte {
	out := make([]byte, 0, len(p)+len(p)/16)
	for _, b := range p {
		if b == '\n' && !c.lastCR {
			out = append(out, '\r')
		}
		out = append(out, b)
		c.lastCR = b == '\r'
	}
	return out
}
