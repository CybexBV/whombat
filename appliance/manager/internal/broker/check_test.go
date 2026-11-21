package broker_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/broker"
	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi"
)

// MG-67: POST /v1/update/check is for the admin users only, answers what control said to the poll, and is 404 on a
// manager that doesn't poll on demand (as one before MG-67 answers).
func TestCheckEndpoint(t *testing.T) {
	t.Parallel()
	me := uint32(os.Getuid())
	answer := func(res *broker.CheckResult, err error) func(context.Context) (*broker.CheckResult, error) {
		return func(context.Context) (*broker.CheckResult, error) { return res, err }
	}
	assigned := &broker.CheckResult{Result: "assigned", Decision: "started", NextCheckS: 60}
	for _, tc := range []struct {
		name  string
		admin []uint32
		check func(context.Context) (*broker.CheckResult, error)
		want  string // the answer's result, or the error's code
	}{
		{"answered", []uint32{0, me}, answer(assigned, nil), "assigned"},
		{"not an admin user", []uint32{0}, answer(assigned, nil), "403 forbidden"},
		{"control away", []uint32{me}, answer(nil, fmt.Errorf("poll: %w", controlapi.ErrUnavailable)), "503 unavailable"},
		{"control refused", []uint32{me}, answer(nil, errors.New("signature")), "502 control_refused"},
		{"no checks here", []uint32{me}, nil, "404 unavailable"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := &broker.Server{RuntimeUID: me, AdminUIDs: tc.admin, CheckNow: tc.check}
			dir, err := os.MkdirTemp("", "ck") // a short path: a socket's is at most 107 bytes
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { os.RemoveAll(dir) })
			sock := filepath.Join(dir, "api.sock")
			serve(t, s, sock)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			res, err := broker.Check(ctx, sock)
			if err != nil {
				if !strings.Contains(err.Error(), tc.want) {
					t.Fatalf("want %q: %v", tc.want, err)
				}
				return
			}
			if res.Result != tc.want || *res != *assigned {
				t.Fatalf("want %q: %+v", tc.want, res)
			}
		})
	}
}
