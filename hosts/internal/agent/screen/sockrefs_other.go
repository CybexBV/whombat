//go:build !darwin

package screen

import (
	"errors"
	"net"
)

// connRefs can't tell who holds a connection here: only a Mac has the
// helper, so none is trusted.
func connRefs(*net.UnixConn, int) ([]sockRef, error) {
	return nil, errors.New("can't tell who holds a connection on this system")
}
