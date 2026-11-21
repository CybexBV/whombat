//go:build !linux && !darwin

package screen

import (
	"errors"
	"net"
)

// peerUID can't tell the peer here: no helper is trusted.
func peerUID(*net.UnixConn) (int, error) { return -1, errors.New("peer credentials unsupported") }

// peerPID can't tell the peer here.
func peerPID(*net.UnixConn) (int, error) { return -1, errors.New("peer credentials unsupported") }
