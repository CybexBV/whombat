package jobs

import (
	"context"
	"errors"
	"testing"
	"time"
)

// waitAdmitted waits until n jobs are running or queued (the goroutines below admit themselves concurrently).
func waitAdmitted(t *testing.T, l *Limiter, n int) {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for l.Admitted() != n {
		select {
		case <-deadline:
			t.Fatalf("admitted %d, want %d", l.Admitted(), n)
		case <-time.After(time.Millisecond):
		}
	}
}

func TestOneRunsTwoWaitTheRestAreBusy(t *testing.T) {
	l := New(2)
	ctx := context.Background()
	release, err := l.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	order := make(chan int, 2)
	releases := make(chan func(), 2)
	for i := 1; i <= 2; i++ {
		go func() {
			r, err := l.Acquire(ctx)
			if err != nil {
				t.Error(err)
				return
			}
			order <- i
			releases <- r
		}()
		waitAdmitted(t, l, 1+i)
	}
	if _, err := l.Acquire(ctx); !errors.Is(err, ErrBusy) {
		t.Fatalf("fourth job: %v", err)
	}
	select {
	case i := <-order:
		t.Fatalf("job %d ran beside the first", i)
	default:
	}
	release()
	release() // a second release is a no-op
	<-order
	(<-releases)()
	<-order
	(<-releases)()
	if l.Admitted() != 0 {
		t.Fatal(l.Admitted())
	}
}

func TestGivingUpLeavesTheQueue(t *testing.T) {
	l := New(1)
	release, _ := l.Acquire(context.Background())
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := l.Acquire(ctx)
		done <- err
	}()
	waitAdmitted(t, l, 2)
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if l.Admitted() != 1 {
		t.Fatal(l.Admitted())
	}
	// The place is free again.
	ok := make(chan struct{})
	go func() {
		r, err := l.Acquire(context.Background())
		if err == nil {
			r()
		}
		close(ok)
	}()
	waitAdmitted(t, l, 2)
	release()
	<-ok
}
