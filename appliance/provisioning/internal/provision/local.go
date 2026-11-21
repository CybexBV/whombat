package provision

import (
	"context"
	"crypto/rand"
	"errors"
	"io"

	"github.com/CybexBV/whombat/contracts/go/device"
)

// LocalRegistrar makes a community box's identity at first boot without control (Whombat HE-58, HE-59; NX-445): a
// community box has no control to register with, so nothing assigns it an id. It checks the registration's two
// signatures as control would (a box that can't sign its own registration has broken keys) and answers a device id of
// its own: `wb-` and three groups of four letters and digits (Crockford's base32, lower case, no i, l, o or u), the
// shape control's ids have, from 60 random bits; the appliance route is `local` (no relay routes to it). The id
// names the box in its own records and on its own page; its PeerId (the content identity) is what clients pin.
type LocalRegistrar struct {
	// Rand defaults to crypto/rand.
	Rand io.Reader
}

// LocalRoute is the appliance route of a box without a relay.
const LocalRoute = "local"

const crockford = "0123456789abcdefghjkmnpqrstvwxyz"

// Register implements Registrar.
func (l LocalRegistrar) Register(_ context.Context, reg *device.DeviceRegistration) (*device.DeviceRegistrationResponse, error) {
	if reg == nil {
		return nil, errors.New("no registration")
	}
	if !device.VerifyRegistration(reg) {
		return nil, errors.New("the registration's signatures don't verify")
	}
	r := l.Rand
	if r == nil {
		r = rand.Reader
	}
	var b [12]byte
	if _, err := io.ReadFull(r, b[:]); err != nil {
		return nil, err
	}
	id := []byte("wb-")
	for i, x := range b {
		if i > 0 && i%4 == 0 {
			id = append(id, '-')
		}
		id = append(id, crockford[x%32])
	}
	return &device.DeviceRegistrationResponse{Device: string(id), ApplianceRoute: LocalRoute, Env: reg.Env}, nil
}
