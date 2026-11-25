package broker_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/broker"
	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi"
	"github.com/CybexBV/whombat/contracts/go/local"
)

// checkSocket serves s on a socket of its own and returns its path.
func checkSocket(t *testing.T, s *broker.Server) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "ck") // a short path: a socket's is at most 107 bytes
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	sock := filepath.Join(dir, "api.sock")
	serve(t, s, sock)
	return sock
}

// MG-67, MG-194: POST /v1/update/check is for the runtime (the owner's “Check for updates”) and the admin users,
// answers what the check found, and is 404 on a manager that doesn't check on demand (as one before MG-67 answers).
func TestCheckEndpoint(t *testing.T) {
	t.Parallel()
	me := uint32(os.Getuid())
	other := me + 1
	answer := func(res *broker.CheckResult, err error) func(context.Context) (*broker.CheckResult, error) {
		return func(context.Context) (*broker.CheckResult, error) { return res, err }
	}
	assigned := &broker.CheckResult{Result: "assigned", Decision: "started", NextCheckS: 60}
	for _, tc := range []struct {
		name    string
		runtime uint32
		admin   []uint32
		check   func(context.Context) (*broker.CheckResult, error)
		want    string // the answer's result, or the error's code
	}{
		{"an admin user", other, []uint32{0, me}, answer(assigned, nil), "assigned"},
		{"the runtime", me, []uint32{0}, answer(assigned, nil), "assigned"},
		{"neither", other, []uint32{0}, answer(assigned, nil), "403 forbidden"},
		{"control away", me, nil, answer(nil, fmt.Errorf("poll: %w", controlapi.ErrUnavailable)), "503 unavailable"},
		{"control refused", me, nil, answer(nil, errors.New("signature")), "502 control_refused"},
		{"no checks here", me, nil, nil, "404 unavailable"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			sock := checkSocket(t, &broker.Server{RuntimeUID: tc.runtime, AdminUIDs: tc.admin, CheckNow: tc.check})
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			res, err := broker.Check(ctx, sock)
			if err != nil {
				if !strings.Contains(err.Error(), tc.want) {
					t.Fatalf("want %q: %v", tc.want, err)
				}
				return
			}
			want := *assigned
			want.V = local.LocalAPIVersion
			if res.Result != tc.want || *res != want {
				t.Fatalf("want %q: %+v", tc.want, res)
			}
		})
	}
}

// MG-194: the runtime sends `UpdateCheckRequest` and gets `UpdateCheckResponse`; anything else in the body is refused.
func TestCheckEndpointContract(t *testing.T) {
	t.Parallel()
	me := uint32(os.Getuid())
	sock := checkSocket(t, &broker.Server{RuntimeUID: me, CheckNow: func(context.Context) (*broker.CheckResult, error) {
		return &broker.CheckResult{Result: "none", NextCheckS: 3600}, nil
	}})
	post := func(body string) (int, []byte) {
		t.Helper()
		resp, err := client(sock).Post("http://manager"+local.ManagerPathUpdateCheck, "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var raw json.RawMessage
		_ = json.NewDecoder(resp.Body).Decode(&raw)
		return resp.StatusCode, raw
	}
	if code, _ := post(`{"v":1,"now":true}`); code != http.StatusBadRequest {
		t.Fatalf("an unknown member: %d", code)
	}
	code, raw := post(`{"v":1}`)
	if code != http.StatusOK {
		t.Fatalf("status %d", code)
	}
	res, err := local.ParseUpdateCheckResponse(raw)
	if err != nil || res.Result != "none" || res.Decision != nil || res.NextCheckS != 3600 {
		t.Fatalf("%+v %v", res, err)
	}
}

// MG-194: pressing Check for updates again and again checks once; the presses after it get its answer.
func TestCheckEndpointReusesTheLastAnswer(t *testing.T) {
	t.Parallel()
	me := uint32(os.Getuid())
	var runs atomic.Int32
	sock := checkSocket(t, &broker.Server{RuntimeUID: me, CheckNow: func(context.Context) (*broker.CheckResult, error) {
		runs.Add(1)
		time.Sleep(50 * time.Millisecond) // long enough for the presses to overlap
		return &broker.CheckResult{Result: "unchanged", NextCheckS: 3600}, nil
	}})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	done := make(chan error, 3)
	for range 3 {
		go func() {
			res, err := broker.Check(ctx, sock)
			if err == nil && res.Result != "unchanged" {
				err = fmt.Errorf("answer %+v", res)
			}
			done <- err
		}()
	}
	for range 3 {
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}
	if n := runs.Load(); n != 1 {
		t.Fatalf("checked %d times", n)
	}
}
