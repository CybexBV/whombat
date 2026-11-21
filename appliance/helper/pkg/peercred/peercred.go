// Package peercred authenticates local unix-socket clients by kernel peer credentials (SO_PEERCRED).
// Credentials are read once when a connection is accepted; they cannot be forged by the client.
package peercred

import (
	"context"
	"errors"
	"fmt"
	"net"

	"golang.org/x/sys/unix"
)

// Cred is the kernel-reported identity of the process that connected.
type Cred struct {
	PID int32
	UID uint32
	GID uint32
}

// Of returns the peer credentials of a unix connection.
func Of(c net.Conn) (Cred, error) {
	uc, ok := c.(*net.UnixConn)
	if !ok {
		return Cred{}, errors.New("peercred: not a unix connection")
	}
	raw, err := uc.SyscallConn()
	if err != nil {
		return Cred{}, err
	}
	var cred *unix.Ucred
	var serr error
	if err := raw.Control(func(fd uintptr) {
		cred, serr = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
	}); err != nil {
		return Cred{}, err
	}
	if serr != nil {
		return Cred{}, fmt.Errorf("peercred: SO_PEERCRED: %w", serr)
	}
	return Cred{PID: cred.Pid, UID: cred.Uid, GID: cred.Gid}, nil
}

type ctxKey struct{}

// ConnContext is an http.Server.ConnContext that stores the peer credentials in the request context.
func ConnContext(ctx context.Context, c net.Conn) context.Context {
	cred, err := Of(c)
	if err != nil {
		return context.WithValue(ctx, ctxKey{}, (*Cred)(nil))
	}
	return context.WithValue(ctx, ctxKey{}, &cred)
}

// FromContext returns the credentials stored by ConnContext.
func FromContext(ctx context.Context) (Cred, bool) {
	c, _ := ctx.Value(ctxKey{}).(*Cred)
	if c == nil {
		return Cred{}, false
	}
	return *c, true
}
