// Package server is the update helper's socket front end: kernel peer-credential check (only the
// manager uid), one bounded request line per connection, strict typed decoding, serialized execution.
package server

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"os"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/internal/ops"
	"github.com/CybexBV/whombat/appliance/helper/pkg/peercred"
	"github.com/CybexBV/whombat/appliance/helper/pkg/proto"
)

// Server serves helper requests.
type Server struct {
	H           *ops.Helper
	ManagerUID  uint32
	IdleTimeout time.Duration // 0 = never exit on idle
	ReadTimeout time.Duration
	Log         *slog.Logger
	active      atomic.Int64
	last        atomic.Int64
}

// Serve accepts connections until ctx ends or the idle timeout passes with no activity
// (socket activation restarts the helper on the next connection).
func (s *Server) Serve(ctx context.Context, ln *net.UnixListener) error {
	if s.ReadTimeout == 0 {
		s.ReadTimeout = 10 * time.Second
	}
	if s.Log == nil {
		s.Log = slog.Default()
	}
	s.last.Store(time.Now().UnixNano())
	stop := context.AfterFunc(ctx, func() { _ = ln.SetDeadline(time.Now()) })
	defer stop()
	for {
		if ctx.Err() != nil {
			return nil
		}
		_ = ln.SetDeadline(time.Now().Add(time.Second))
		c, err := ln.AcceptUnix()
		if err != nil {
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() {
				idle := time.Since(time.Unix(0, s.last.Load()))
				if s.IdleTimeout > 0 && s.active.Load() == 0 && idle > s.IdleTimeout {
					return nil
				}
				continue
			}
			return err
		}
		s.active.Add(1)
		go func() {
			defer func() {
				s.last.Store(time.Now().UnixNano())
				s.active.Add(-1)
			}()
			s.handle(ctx, c)
		}()
	}
}

func (s *Server) reply(c net.Conn, resp proto.Response) {
	resp.V = proto.Version
	b, _ := json.Marshal(resp)
	_ = c.SetWriteDeadline(time.Now().Add(10 * time.Second))
	_, _ = c.Write(append(b, '\n'))
}

func (s *Server) handle(ctx context.Context, c *net.UnixConn) {
	defer c.Close()
	cred, err := peercred.Of(c)
	if err != nil || cred.UID != s.ManagerUID {
		s.Log.Warn("rejected helper client", "uid", cred.UID, "pid", cred.PID, "err", err)
		s.reply(c, proto.Response{Error: &proto.Error{Code: proto.CodeForbidden, Message: "peer is not the manager"}})
		return
	}
	_ = c.SetReadDeadline(time.Now().Add(s.ReadTimeout))
	line, err := proto.ReadRequestLine(bufio.NewReaderSize(c, proto.MaxRequestBytes+2))
	if err != nil {
		s.reply(c, proto.Response{Error: &proto.Error{Code: proto.CodeBadRequest, Message: "unreadable request"}})
		return
	}
	req, err := proto.DecodeRequest(line)
	if err != nil {
		s.Log.Warn("rejected helper request", "err", err)
		s.reply(c, proto.Response{Error: &proto.Error{Code: proto.CodeBadRequest, Message: err.Error()}})
		return
	}
	_ = c.SetReadDeadline(time.Time{})
	// Never the request itself: a Wi-Fi join carries a passphrase.
	s.Log.Info("helper op", "op", req.Op, "releaseId", req.ReleaseID, "candidateId", req.CandidateID, "changeId", req.ChangeID, "pid", cred.PID)
	res, perr, post := s.H.Handle(ctx, req)
	if perr != nil {
		s.Log.Warn("helper op failed", "op", req.Op, "code", perr.Code, "msg", perr.Message)
		s.reply(c, proto.Response{Error: perr})
		return
	}
	s.reply(c, proto.Response{OK: true, Result: res})
	// What the store operations removed, in the helper's own journal too (UP-X18, UP-X19): the manager may have
	// stopped waiting.
	if res != nil && len(res.Deleted) > 0 {
		s.Log.Info("generations deleted", "op", req.Op, "deleted", res.Deleted)
	}
	if res != nil && res.Collected != nil {
		s.Log.Info("store collected", "paths", res.Collected.Paths, "freedBytes", res.Collected.FreedBytes,
			"rootFreeBytes", res.Collected.FreeBytes)
	}
	if post != nil {
		post()
	}
}

// ListenerFromSystemd returns the socket passed by systemd socket activation (LISTEN_FDS=1).
func ListenerFromSystemd() (*net.UnixListener, error) {
	if os.Getenv("LISTEN_PID") != strconv.Itoa(os.Getpid()) || os.Getenv("LISTEN_FDS") != "1" {
		return nil, errors.New("not socket-activated (expected LISTEN_FDS=1 for this pid)")
	}
	f := os.NewFile(3, "whombat-update-helper.socket")
	ln, err := net.FileListener(f)
	f.Close()
	if err != nil {
		return nil, err
	}
	ul, ok := ln.(*net.UnixListener)
	if !ok {
		ln.Close()
		return nil, errors.New("activation socket is not a unix stream socket")
	}
	os.Unsetenv("LISTEN_PID")
	os.Unsetenv("LISTEN_FDS")
	os.Unsetenv("LISTEN_FDNAMES")
	return ul, nil
}
