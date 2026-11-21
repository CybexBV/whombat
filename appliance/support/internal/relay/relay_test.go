package relay_test

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/support/internal/relay"
	"github.com/CybexBV/whombat/appliance/support/internal/relay/relaytest"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// source hands out its tickets in order (the last one repeats) and counts the calls.
type source struct {
	mu      sync.Mutex
	tickets []relay.Ticket
	err     error
	calls   atomic.Int32
}

func (s *source) Ticket(context.Context) (relay.Ticket, error) {
	n := int(s.calls.Add(1))
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return relay.Ticket{}, s.err
	}
	return s.tickets[min(n, len(s.tickets))-1], nil
}

func ticket(r *relaytest.Relay, name string, exp time.Time) relay.Ticket {
	tok := relaytest.Token(name)
	r.Allow(tok, r.Worker)
	return relay.Ticket{Token: tok, ExpiresAt: exp, URL: r.URL, Worker: r.Worker}
}

// fast: waits under a minute pass at once (reconnects, quick refreshes); longer ones never (ticket refreshes).
func fast(delays chan<- time.Duration) func(time.Duration) <-chan time.Time {
	return func(d time.Duration) <-chan time.Time {
		if delays != nil {
			select {
			case delays <- d:
			default:
			}
		}
		if d >= time.Minute {
			return nil
		}
		c := make(chan time.Time, 1)
		c <- time.Now()
		return c
	}
}

func opts() relay.Options {
	return relay.Options{After: fast(nil), Backoff: func(int) time.Duration { return time.Millisecond },
		Jitter: func(time.Duration) time.Duration { return 0 }}
}

type running struct {
	cancel context.CancelFunc
	done   chan error
}

func start(t *testing.T, src relay.TicketSource, serve func(net.Conn), o relay.Options) *running {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	r := &running{cancel: cancel, done: make(chan error, 1)}
	go func() { r.done <- relay.RunWith(ctx, src, serve, o) }()
	t.Cleanup(func() { r.stop(t) })
	return r
}

func (r *running) stop(t *testing.T) error {
	t.Helper()
	r.cancel()
	select {
	case err := <-r.done:
		r.done <- err
		return err
	case <-time.After(10 * time.Second):
		t.Fatal("Run didn't return after its context ended")
		return nil
	}
}

func within(t *testing.T) context.Context {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func echo(c net.Conn) { _, _ = io.Copy(c, c) }

func nextHello(t *testing.T, r *relaytest.Relay) protocol.RelayHello {
	t.Helper()
	select {
	case h := <-r.Hellos:
		return h
	case <-time.After(10 * time.Second):
		t.Fatal("no hello")
		return protocol.RelayHello{}
	}
}

func TestControlHelloThenOneDataConnectionPerSession(t *testing.T) {
	r := relaytest.New("w1")
	defer r.Close()
	tk := ticket(r, "a", time.Now().Add(5*time.Minute))
	src := &source{tickets: []relay.Ticket{tk}}
	start(t, src, echo, opts())
	ctx := within(t)
	if err := r.WaitControl(ctx); err != nil {
		t.Fatal(err)
	}
	h := nextHello(t, r)
	if h.Session != nil || h.Class != protocol.RelayStreamClassInteractive || h.Ticket != tk.Token || h.V != 1 {
		t.Fatalf("control hello %+v", h)
	}
	for i := range 2 {
		c, err := r.Open(ctx, "interactive")
		if err != nil {
			t.Fatal(err)
		}
		d := nextHello(t, r)
		if d.Session == nil || d.Ticket != tk.Token || d.Class != protocol.RelayStreamClassInteractive {
			t.Fatalf("data hello %d %+v", i, d)
		}
		if _, err := c.Write([]byte("ping")); err != nil {
			t.Fatal(err)
		}
		buf := make([]byte, 4)
		if _, err := io.ReadFull(c, buf); err != nil || string(buf) != "ping" {
			t.Fatalf("%q %v", buf, err)
		}
		c.Close()
	}
	if n := src.calls.Load(); n != 1 {
		t.Fatalf("the unexpired ticket was fetched %d times", n)
	}
}

func TestNothingBinaryBeforeReady(t *testing.T) {
	r := relaytest.New("w1")
	defer r.Close()
	src := &source{tickets: []relay.Ticket{ticket(r, "a", time.Now().Add(5*time.Minute))}}
	served := make(chan struct{}, 1)
	start(t, src, func(c net.Conn) {
		served <- struct{}{}
		_, _ = c.Write([]byte("SSH-2.0-x\r\n"))
		echo(c)
	}, opts())
	ctx := within(t)
	if err := r.WaitControl(ctx); err != nil {
		t.Fatal(err)
	}
	nextHello(t, r)
	hold := make(chan struct{})
	r.HoldReady = hold
	opened := make(chan net.Conn, 1)
	go func() {
		c, err := r.Open(ctx, "interactive")
		if err != nil {
			t.Error(err)
		}
		opened <- c
	}()
	nextHello(t, r) // the data hello: welcome follows, ready is held
	select {
	case <-served:
		t.Fatal("the session was served before ready")
	case <-time.After(100 * time.Millisecond):
	}
	close(hold)
	c := <-opened
	if c == nil {
		t.FailNow()
	}
	defer c.Close()
	line := make([]byte, 11)
	if _, err := io.ReadFull(c, line); err != nil || string(line) != "SSH-2.0-x\r\n" {
		t.Fatalf("%q %v", line, err)
	}
	if r.EarlyBinary.Load() {
		t.Fatal("binary before ready")
	}
}

func TestRefusesAtTheLimit(t *testing.T) {
	r := relaytest.New("w1")
	defer r.Close()
	src := &source{tickets: []relay.Ticket{ticket(r, "a", time.Now().Add(5*time.Minute))}}
	o := opts()
	o.MaxSessions = 1
	start(t, src, echo, o)
	ctx := within(t)
	if err := r.WaitControl(ctx); err != nil {
		t.Fatal(err)
	}
	first, err := r.Open(ctx, "interactive")
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	if _, err := r.Open(ctx, "interactive"); err == nil || !strings.Contains(err.Error(), "4429") {
		t.Fatalf("second session: %v", err)
	}
	select {
	case <-r.Refused:
	default:
		t.Fatal("no refuse")
	}
	first.Close()
	// The slot comes back once the first session ends.
	for {
		c, err := r.Open(ctx, "interactive")
		if err == nil {
			c.Close()
			break
		}
		if ctx.Err() != nil {
			t.Fatal("the slot never came back")
		}
	}
}

func TestDrainWaitsTheRelaysDelayThenReconnects(t *testing.T) {
	r := relaytest.New("w1")
	defer r.Close()
	src := &source{tickets: []relay.Ticket{ticket(r, "a", time.Now().Add(5*time.Minute))}}
	delays := make(chan time.Duration, 64)
	o := opts()
	o.After = fast(delays)
	o.Jitter = func(max time.Duration) time.Duration { return max / 100 }
	start(t, src, echo, o)
	ctx := within(t)
	if err := r.WaitControl(ctx); err != nil {
		t.Fatal(err)
	}
	nextHello(t, r)
	if err := r.Drain(1234); err != nil {
		t.Fatal(err)
	}
	for {
		select {
		case d := <-delays:
			if d >= time.Minute {
				continue // the ticket refresh
			}
			if d != 1234*time.Millisecond+10*time.Millisecond {
				t.Fatalf("waited %v", d)
			}
		case <-ctx.Done():
			t.Fatal("no wait after drain")
		}
		break
	}
	if h := nextHello(t, r); h.Session != nil {
		t.Fatalf("reconnect hello %+v", h)
	}
	if err := r.WaitControl(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestRefusedTicketsAreReplaced(t *testing.T) {
	for _, tc := range []struct {
		name  string
		allow func(r *relaytest.Relay, tok string)
	}{
		{"unknown (4401)", func(*relaytest.Relay, string) {}},
		{"another worker (4421)", func(r *relaytest.Relay, tok string) { r.Allow(tok, "w9") }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := relaytest.New("w1")
			defer r.Close()
			bad := relay.Ticket{Token: relaytest.Token("bad"), ExpiresAt: time.Now().Add(5 * time.Minute), URL: r.URL, Worker: "w1"}
			tc.allow(r, bad.Token)
			good := ticket(r, "good", time.Now().Add(5*time.Minute))
			src := &source{tickets: []relay.Ticket{bad, good}}
			start(t, src, echo, opts())
			if err := r.WaitControl(within(t)); err != nil {
				t.Fatal(err)
			}
			if h := nextHello(t, r); h.Ticket != bad.Token {
				t.Fatalf("first hello %+v", h)
			}
			if h := nextHello(t, r); h.Ticket != good.Token {
				t.Fatalf("second hello %+v", h)
			}
			if n := src.calls.Load(); n != 2 {
				t.Fatalf("%d ticket fetches", n)
			}
		})
	}
}

func TestATicketForAnotherWorkerMovesTheControlConnection(t *testing.T) {
	r1 := relaytest.New("w1")
	defer r1.Close()
	r2 := relaytest.New("w2")
	defer r2.Close()
	src := &source{tickets: []relay.Ticket{
		ticket(r1, "one", time.Now().Add(relay.TicketMargin+20*time.Millisecond)),
		ticket(r2, "two", time.Now().Add(5*time.Minute)),
	}}
	o := opts()
	o.MinRefresh = time.Millisecond
	start(t, src, echo, o)
	ctx := within(t)
	if err := r2.WaitControl(ctx); err != nil {
		t.Fatal(err)
	}
	if err := r1.WaitNoControl(ctx); err != nil {
		t.Fatal("the old worker kept its control connection")
	}
	c, err := r2.Open(ctx, "interactive")
	if err != nil {
		t.Fatal(err)
	}
	c.Close()
}

func TestAnExpiredTicketIsNeverUsedForASession(t *testing.T) {
	r := relaytest.New("w1")
	defer r.Close()
	now := time.Now()
	var clock atomic.Int64
	clock.Store(now.UnixNano())
	src := &source{tickets: []relay.Ticket{ticket(r, "a", now.Add(5*time.Minute))}}
	o := opts()
	o.Now = func() time.Time { return time.Unix(0, clock.Load()) }
	o.MinRefresh = time.Hour
	start(t, src, echo, o)
	ctx := within(t)
	if err := r.WaitControl(ctx); err != nil {
		t.Fatal(err)
	}
	clock.Store(now.Add(6 * time.Minute).UnixNano())
	if _, err := r.Open(ctx, "interactive"); err == nil || !strings.Contains(err.Error(), "4429") {
		t.Fatalf("a session with an expired ticket: %v", err)
	}
}

func TestEndsPromptlyClosingEverySession(t *testing.T) {
	r := relaytest.New("w1")
	defer r.Close()
	src := &source{tickets: []relay.Ticket{ticket(r, "a", time.Now().Add(5*time.Minute))}}
	gone := make(chan error, 1)
	served := make(chan struct{})
	run := start(t, src, func(c net.Conn) {
		close(served)
		_, err := io.Copy(io.Discard, c)
		if err == nil {
			err = io.EOF
		}
		gone <- err
	}, opts())
	ctx := within(t)
	if err := r.WaitControl(ctx); err != nil {
		t.Fatal(err)
	}
	c, err := r.Open(ctx, "interactive")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	<-served
	if err := run.stop(t); !errors.Is(err, context.Canceled) {
		t.Fatalf("Run returned %v", err)
	}
	select {
	case <-gone:
	default:
		t.Fatal("Run returned before the session's serve did")
	}
	if _, err := c.Read(make([]byte, 1)); err == nil {
		t.Fatal("the client's session stayed open")
	}
	if err := r.WaitNoControl(ctx); err != nil {
		t.Fatal("the control connection stayed open")
	}
}

func TestAnswersPingsAndSplitsLargeWrites(t *testing.T) {
	r := relaytest.New("w1")
	defer r.Close()
	src := &source{tickets: []relay.Ticket{ticket(r, "a", time.Now().Add(5*time.Minute))}}
	big := bytes.Repeat([]byte("x"), 300*1024)
	start(t, src, func(c net.Conn) {
		defer c.Close()
		one := make([]byte, 1)
		if _, err := c.Read(one); err != nil { // the client says go; reading also answers pings
			return
		}
		_, _ = c.Write(big)
		_, _ = c.Read(one)
	}, opts())
	ctx := within(t)
	if err := r.WaitControl(ctx); err != nil {
		t.Fatal(err)
	}
	c, err := r.Open(ctx, "interactive")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err := r.PingData(ctx); err != nil {
		t.Fatalf("no pong: %v", err)
	}
	if _, err := c.Write([]byte("g")); err != nil {
		t.Fatal(err)
	}
	got := make([]byte, len(big))
	if _, err := io.ReadFull(c, got); err != nil || !bytes.Equal(got, big) {
		t.Fatalf("%v", err)
	}
	sizes := r.MessageSizes()
	total := 0
	for _, n := range sizes {
		if n > relay.MaxMessage {
			t.Fatalf("a %d byte message", n)
		}
		total += n
	}
	if total != len(big) || len(sizes) < 2 {
		t.Fatalf("messages %v", sizes)
	}
}

func TestNoTicketBacksOffAndTriesAgain(t *testing.T) {
	r := relaytest.New("w1")
	defer r.Close()
	src := &source{err: errors.New("manager unavailable")}
	attempts := make(chan int, 64)
	o := opts()
	o.Backoff = func(n int) time.Duration {
		attempts <- n
		if n >= 2 {
			src.mu.Lock()
			src.err = nil
			src.tickets = []relay.Ticket{ticket(r, "a", time.Now().Add(5*time.Minute))}
			src.mu.Unlock()
		}
		return time.Millisecond
	}
	start(t, src, echo, o)
	if err := r.WaitControl(within(t)); err != nil {
		t.Fatal(err)
	}
	for want := range 3 {
		if n := <-attempts; n != want {
			t.Fatalf("attempt %d, want %d", n, want)
		}
	}
}

func TestBackoffDelay(t *testing.T) {
	base, max := 500*time.Millisecond, 30*time.Second
	for attempt, ceiling := range []time.Duration{500 * time.Millisecond, time.Second, 2 * time.Second, 4 * time.Second} {
		if d := relay.BackoffDelay(attempt, base, max, func() float64 { return 0.999999 }); d >= ceiling || d < ceiling*99/100 {
			t.Fatalf("attempt %d: %v", attempt, d)
		}
		if d := relay.BackoffDelay(attempt, base, max, func() float64 { return 0 }); d != 0 {
			t.Fatalf("attempt %d: %v", attempt, d)
		}
	}
	for _, attempt := range []int{7, 40, 1000} {
		if d := relay.BackoffDelay(attempt, base, max, func() float64 { return 0.999999 }); d > max {
			t.Fatalf("attempt %d: %v", attempt, d)
		}
	}
}
