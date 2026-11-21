package daemon

import (
	"context"
	"errors"
	"testing"
)

// SR-02: a failure followed by a stop (SIGTERM before Run looked) is still a failure; a stop followed by a failure is
// a stop.
func TestFailureOf(t *testing.T) {
	boom := errors.New("local API: the socket file was removed or replaced")

	ctx, stop := context.WithCancel(context.Background())
	run, fail := context.WithCancelCause(ctx)
	fail(boom)
	stop()
	if err := failureOf(ctx, run); err != boom {
		t.Fatalf("failure, then a stop: %v", err)
	}

	ctx, stop = context.WithCancel(context.Background())
	run, fail = context.WithCancelCause(ctx)
	stop()
	fail(boom)
	if err := failureOf(ctx, run); err != nil {
		t.Fatalf("a stop, then a failure: %v", err)
	}

	ctx, stop = context.WithCancel(context.Background())
	defer stop()
	run, fail = context.WithCancelCause(ctx)
	fail(boom)
	if err := failureOf(ctx, run); err != boom {
		t.Fatalf("a failure: %v", err)
	}
}
