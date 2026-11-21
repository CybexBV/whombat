package update_test

import (
	"fmt"
	"io"
	"net/url"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
	"github.com/CybexBV/whombat/appliance/manager/internal/update"
)

// A request the backup API dropped as it restarted (the seal after a new destination), as the client reports it.
func dropped(cause error) error {
	return fmt.Errorf("backup service: %w", &url.Error{Op: "Post", URL: "http://backup/v1/checkpoints", Err: cause})
}

func checkpointWaiting(st *update.State) bool {
	return st.Phase == update.WaitingForSafeBoundary && st.Candidate.Deferral != nil &&
		st.Candidate.Deferral.Waiting == "checkpoint" && !st.Candidate.Deferral.Draining
}

// A checkpoint request that lost its connection is asked again a few seconds later, in the same window: the update
// takes its checkpoint and migrates instead of waiting for the next window.
func TestCheckpointRetriedAfterLostConnection(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	w.Engine.Policy.CheckpointRetry = time.Millisecond
	w.Checkpoints.FailNext = []error{dropped(io.EOF), dropped(syscall.ECONNRESET)}
	mustOffer(t, w, testworld.ContractFloors, update.DecisionStarted)
	waited := false
	w.Run(400, func(st *update.State) bool {
		waited = waited || checkpointWaiting(st)
		return st.Phase == update.Healthy
	})
	if waited {
		t.Fatal("the update waited for the next window for its checkpoint")
	}
	if len(w.Checkpoints.Refs) != 1 || w.Checkpoints.Calls != 3 || w.Helper.DBSchema() != 11 {
		t.Fatalf("checkpoints %v after %d requests, schema %d", w.Checkpoints.Refs, w.Checkpoints.Calls, w.Helper.DBSchema())
	}
}

// The retries are bounded: a backup service that keeps dropping the request leaves the update waiting for the next
// window, with the reason, after 1 + CheckpointRetries requests.
func TestCheckpointRetriesAreBounded(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	w.Engine.Policy.CheckpointRetry = time.Millisecond
	w.Checkpoints.Fail = dropped(syscall.ECONNREFUSED)
	mustOffer(t, w, testworld.ContractFloors, update.DecisionStarted)
	w.Run(80, checkpointWaiting)
	if n := w.Checkpoints.Calls; n != 1+w.Engine.Policy.CheckpointRetries {
		t.Fatalf("%d requests", n)
	}
	if ex := w.State().Candidate.Deferral.Explanation; !strings.Contains(ex, "next window") {
		t.Fatalf("explanation %q", ex)
	}
	noCheckpointTaken(t, w)
}

// A refusal the backup service answered (no destination) is not asked again: the update waits for the next window.
func TestCheckpointRefusalNotRetried(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	w.Engine.Policy.CheckpointRetry = time.Millisecond
	w.Checkpoints.Fail = errUnprotected
	mustOffer(t, w, testworld.ContractFloors, update.DecisionStarted)
	w.Run(80, checkpointWaiting)
	if w.Checkpoints.Calls != 1 {
		t.Fatalf("%d requests", w.Checkpoints.Calls)
	}
}
