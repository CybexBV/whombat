package main

// The SSH server and the relay worker (support/internal/sshd, relay and managerclient), made from sshConfig.

import (
	"context"
	"io"

	"github.com/CybexBV/whombat/appliance/support/internal/managerclient"
	"github.com/CybexBV/whombat/appliance/support/internal/records"
	"github.com/CybexBV/whombat/appliance/support/internal/relay"
	"github.com/CybexBV/whombat/appliance/support/internal/sshd"
	"github.com/CybexBV/whombat/appliance/support/internal/wire"
)

func newSSH(c sshConfig) (sshService, error) {
	srv, err := sshd.New(sshd.Config{
		StateDir: c.StateDir,
		CAKeys:   c.CAKeys,
		DeviceID: c.DeviceID,
		Gate:     c.Gate,
		Recorder: recorder{c.Records},
		LookUser: c.LookUser,
		Manager:  c.ManagerSocket,
		Logf:     c.Logf,
	})
	if err != nil {
		return nil, err
	}
	return realSSH{srv: srv, tickets: managerclient.New(c.ManagerSocket), logf: c.Logf}, nil
}

type realSSH struct {
	srv     *sshd.Server
	tickets *managerclient.Client
	logf    func(string, ...any)
}

func (r realSSH) HostKey() string { return r.srv.HostKey() }

func (r realSSH) Run(ctx context.Context) error {
	return relay.RunWith(ctx, r.tickets, r.srv.ServeConn, relay.Options{Logf: r.logf})
}

// recorder is the record as sshd's Recorder: a visit per certificate serial.
type recorder struct{ s *records.Store }

func (r recorder) Visit(serial uint64, keyID, who, level string) sshd.Visit {
	return visit{r.s.Visit(serial, keyID, who, level)}
}

type visit struct{ v *records.Visit }

func (v visit) ID() string            { return v.v.ID() }
func (v visit) Connected()            { v.v.Connected() }
func (v visit) Left()                 { v.v.Left() }
func (v visit) Step(s wire.Step)      { v.v.Step(s) }
func (v visit) Transcript() io.Writer { return v.v.Transcript() }
