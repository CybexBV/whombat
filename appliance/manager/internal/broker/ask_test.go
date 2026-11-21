package broker_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/broker"
	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
	"github.com/CybexBV/whombat/appliance/manager/internal/update"
	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/release"
)

// startAsk serves the broker over a test world without control (the ask and approve routes need none), counting the
// engine wakes it asks for.
func startAsk(t *testing.T, runtimeUID uint32) (string, *testworld.World, *atomic.Int64) {
	t.Helper()
	w := testworld.New(t)
	wakes := &atomic.Int64{}
	s := &broker.Server{RuntimeUID: runtimeUID, Engine: w.Engine, WakeEngine: func() { wakes.Add(1) }}
	sock := filepath.Join(filepath.Dir(w.P.HelperSock), "api.sock")
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go s.Listen(ctx, sock)
	for i := 0; i < 100; i++ {
		if _, err := os.Stat(sock); err == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	return sock, w, wakes
}

// Ask before updating (Whombat ask-before-updating.md): the switch and the approval are the runtime's only, strict
// contract requests; approving what doesn't wait for the owner is 409 not_waiting.
func TestAskAndApproveRoutes(t *testing.T) {
	t.Parallel()
	me := uint32(os.Getuid())
	sock, w, wakes := startAsk(t, me)
	c := client(sock)

	for _, body := range []string{`{"v":1,"askFirst":true,"by":"control"}`, `{"v":2,"askFirst":true}`, `{"v":1,"askFirst":"yes"}`, `{"v":1}`} {
		if resp, _ := post(t, c, local.ManagerPathUpdateAsk, body); resp.StatusCode != 400 {
			t.Fatalf("%s: %d", body, resp.StatusCode)
		}
	}
	resp, m := post(t, c, local.ManagerPathUpdateAsk, `{"v":1,"askFirst":true}`)
	b, _ := json.Marshal(m)
	if a, err := local.ParseUpdateAskResponse(b); resp.StatusCode != 200 || err != nil || !a.AskFirst {
		t.Fatalf("%d %s %v", resp.StatusCode, b, err)
	}
	if st := w.State(); !st.AskFirst || wakes.Load() != 1 {
		t.Fatalf("ask %v, %d wakes", st.AskFirst, wakes.Load())
	}

	if resp, m := post(t, c, local.ManagerPathUpdateApprove, `{"v":1,"release":"rt-2"}`); resp.StatusCode != 409 || errCode(m) != "not_waiting" {
		t.Fatalf("nothing waits: %d %v", resp.StatusCode, m)
	}
	if resp, _ := post(t, c, local.ManagerPathUpdateApprove, `{"v":1,"release":"rt-2","all":true}`); resp.StatusCode != 400 {
		t.Fatalf("unknown member: %d", resp.StatusCode)
	}
	if d, why, err := w.Offer(testworld.RuntimeGood); err != nil || d != update.DecisionStarted {
		t.Fatal(d, why, err)
	}
	w.Run(200, func(st *update.State) bool {
		return st.Candidate.Deferral != nil && st.Candidate.Deferral.Waiting == "owner"
	})
	if resp, m := post(t, c, local.ManagerPathUpdateApprove, `{"v":1,"release":"`+testworld.RuntimeNext+`"}`); resp.StatusCode != 409 || errCode(m) != "not_waiting" {
		t.Fatalf("another release: %d %v", resp.StatusCode, m)
	}
	resp, m = post(t, c, local.ManagerPathUpdateApprove, `{"v":1,"release":"`+testworld.RuntimeGood+`"}`)
	b, _ = json.Marshal(m)
	if a, err := local.ParseUpdateApproveResponse(b); resp.StatusCode != 200 || err != nil || a.Release != testworld.RuntimeGood {
		t.Fatalf("%d %s %v", resp.StatusCode, b, err)
	}
	if st := w.State(); st.Approved != testworld.RuntimeGood || wakes.Load() != 2 {
		t.Fatalf("approved %q, %d wakes", st.Approved, wakes.Load())
	}
	w.Run(400, testworld.PhaseIs(update.Healthy))
	if resp, _ := post(t, c, local.ManagerPathUpdateAsk, `{"v":1,"askFirst":false}`); resp.StatusCode != 200 || w.State().AskFirst {
		t.Fatalf("off: %d", resp.StatusCode)
	}
}

func TestAskAndApproveForTheRuntimeOnly(t *testing.T) {
	t.Parallel()
	sock, w, wakes := startAsk(t, uint32(os.Getuid())+1)
	c := client(sock)
	if resp, _ := post(t, c, local.ManagerPathUpdateAsk, `{"v":1,"askFirst":false}`); resp.StatusCode != 403 {
		t.Fatalf("ask: %d", resp.StatusCode)
	}
	if resp, _ := post(t, c, local.ManagerPathUpdateApprove, `{"v":1,"release":"rt-2"}`); resp.StatusCode != 403 {
		t.Fatalf("approve: %d", resp.StatusCode)
	}
	if st := w.State(); st.AskFirst || wakes.Load() != 0 {
		t.Fatalf("changed by another caller: ask %v, %d wakes", st.AskFirst, wakes.Load())
	}
}

// A body past the routes' limit is refused before it is read.
func TestAskBodyLimit(t *testing.T) {
	t.Parallel()
	sock, w, _ := startAsk(t, uint32(os.Getuid()))
	if resp, _ := post(t, client(sock), local.ManagerPathUpdateAsk, strings.Repeat(" ", 4096)+`{"v":1,"askFirst":true}`); resp.StatusCode != 400 {
		t.Fatalf("%d", resp.StatusCode)
	}
	if w.State().AskFirst {
		t.Fatal("a body past the limit was taken")
	}
}

// The owner's facts say whether the box asks first (always: this manager can) and that an update waits for the owner;
// the local status explains it.
func TestFactsCarryTheOwnersWait(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	if f, body := factsOf(t, w.State()); f.AskFirst == nil || *f.AskFirst || !strings.Contains(body, `"askFirst":false`) {
		t.Fatalf("factory facts %s", body)
	}
	if err := w.Engine.SetAskFirst(true); err != nil {
		t.Fatal(err)
	}
	if d, why, err := w.Offer(testworld.RuntimeGood); err != nil || d != update.DecisionStarted {
		t.Fatal(d, why, err)
	}
	w.Run(200, func(st *update.State) bool {
		return st.Candidate.Deferral != nil && st.Candidate.Deferral.Waiting == "owner"
	})
	st := w.State()
	f, body := factsOf(t, st)
	if f.AskFirst == nil || !*f.AskFirst || f.Waiting == nil || f.Waiting.Reason != release.UpdateWaitReasonOwner ||
		f.DeferredReason == nil || *f.DeferredReason != "owner" || f.Candidate == nil || *f.Candidate != testworld.RuntimeGood {
		t.Fatalf("facts %s", body)
	}
	s := broker.StatusOf(st)
	b, _ := json.Marshal(s)
	if _, err := local.ParseUpdateStatusResponse(b); err != nil || s.Hold || s.Explanation == nil || !strings.Contains(*s.Explanation, "owner") {
		t.Fatalf("status %s %v", b, err)
	}
}
