package main

import (
	"context"
	"crypto/ed25519"

	"github.com/CybexBV/whombat/appliance/support/internal/grant"
	"github.com/CybexBV/whombat/appliance/support/internal/records"
)

// sshConfig is what the SSH server and the relay worker are made from (A2's packages sshd, relay and managerclient;
// ssh_rhssh.go). The host key is the server's: made at its first start in StateDir, never in the image.
type sshConfig struct {
	StateDir      string
	CAFile        string
	CAKeys        []ed25519.PublicKey
	DeviceID      func() (string, error)
	Gate          *grant.Store
	Records       *records.Store
	ManagerSocket string
	LookUser      string
	Logf          func(string, ...any)
}

// sshService is the SSH server behind the relay worker.
type sshService interface {
	// HostKey is the server's host key, `ssh-ed25519 <base64>` and nothing else ("" before there is one).
	HostKey() string
	// Run is the relay worker: it dials the relay for the device's support route and serves every connection, until ctx
	// ends (the grant ended, or the service stops).
	Run(ctx context.Context) error
}
