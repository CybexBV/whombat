package daemon

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/config"
	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi"
)

// Where a box's releases come from (LNK-05, LNK-20, MG-136). A commercial box without a channel whose environment
// didn't resolve has no control this start: it is offered no newest release (its helper would refuse it as not
// assigned at every refresh) and a check answers none at once instead of waiting for a control loop that isn't there.
func TestWhereUpdatesComeFrom(t *testing.T) {
	commercial := &Daemon{Cfg: &config.Config{Edition: config.EditionCommercial}}
	if commercial.newestUpdates() || commercial.assignedUpdates() {
		t.Fatal("a commercial box without control or channel takes updates from somewhere")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	res, err := commercial.CheckNow(ctx)
	if err != nil || res.Result != controlapi.ResultNone {
		t.Fatalf("check without control: %+v %v", res, err)
	}
	if !(&Daemon{Cfg: &config.Config{Edition: config.EditionCommunity}}).newestUpdates() {
		t.Fatal("a community box doesn't take its newest")
	}
	registered := &Daemon{Cfg: &config.Config{Edition: config.EditionCommercial}, Control: &controlapi.Client{}, registeredAtControl: true}
	if !registered.assignedUpdates() {
		t.Fatal("a box control registered doesn't take its assignments")
	}
	registered.registeredAtControl = false
	if registered.assignedUpdates() {
		t.Fatal("a box control never registered asks it for assignments")
	}
}

// A required claim window is only for a box claimed on its own pages, where New letters on its screen opens one. On a
// box control registered nothing can open one, so the setting stays off there whatever the configuration says.
func TestClaimWindowRequiredOnlyWhereItCanBeOpened(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	own := &Daemon{Cfg: &config.Config{ClaimWindowRequired: true}, Log: log}
	if !own.claimWindowRequired() {
		t.Fatal("a box claimed on its own pages loses the setting")
	}
	registered := &Daemon{Cfg: &config.Config{ClaimWindowRequired: true}, Log: log, registeredAtControl: true}
	if registered.claimWindowRequired() || registered.claimWindowRequired() {
		t.Fatal("a box control registered requires a claim window nothing can open")
	}
	if (&Daemon{Cfg: &config.Config{}, Log: log}).claimWindowRequired() {
		t.Fatal("off is off")
	}
}
