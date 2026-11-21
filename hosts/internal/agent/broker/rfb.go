package broker

import (
	"io"

	"rackoon/internal/agent/rfb"
)

// The VNC protocol lives in package rfb, which the Mac's screen package uses
// too; these are the broker's names for it.

// RFBInfo is what the agent learned from the guest's VNC server.
type RFBInfo = rfb.Info

// ErrRFBAuth is returned when the VNC server rejects the agent's credentials.
var ErrRFBAuth = rfb.ErrAuth

// RFBClientHandshake completes the client side of the RFB handshake with a
// guest's VNC server, password being its VNC password (rfb.ClientHandshake).
func RFBClientHandshake(conn io.ReadWriteCloser, password string) (io.ReadWriteCloser, *RFBInfo, error) {
	return rfb.ClientHandshake(conn, rfb.Options{Password: password})
}

// RFBServeNone performs the server side of the RFB handshake towards the
// browser (rfb.ServeNone).
func RFBServeNone(rw io.ReadWriter, serverInit []byte) error { return rfb.ServeNone(rw, serverInit) }

// newRFBSession relays an authenticated VNC connection to the browser.
func newRFBSession(conn io.ReadWriteCloser, info *RFBInfo) *rfb.Session {
	return rfb.NewSession(conn, info, nil)
}
