package diagnose

// Live run of the catalog on this machine (read-only checks only; exec is
// not run):
//
//	RACKOON_DIAGNOSE_LIVE=1 go test -run TestLive -v ./internal/agent/diagnose/
//
// RACKOON_DIAGNOSE_ARGS adds one check with arguments, e.g.
// "logs:grep=error,lines=20" or "smart:device=nvme0n1".

import (
	"context"
	"os"
	"strings"
	"testing"

	"rackoon/internal/proto"
)

func TestLive(t *testing.T) {
	if os.Getenv("RACKOON_DIAGNOSE_LIVE") == "" {
		t.Skip("set RACKOON_DIAGNOSE_LIVE=1")
	}
	d := New(nil, nil)
	reqs := []proto.DiagnoseRequest{}
	for _, c := range d.Catalog() {
		need := false
		for _, a := range c.Args {
			need = need || a.Required
		}
		if !need {
			reqs = append(reqs, proto.DiagnoseRequest{Check: c.Name})
		}
	}
	if spec := os.Getenv("RACKOON_DIAGNOSE_ARGS"); spec != "" {
		name, list, _ := strings.Cut(spec, ":")
		req := proto.DiagnoseRequest{Check: name, Args: map[string]string{}}
		for _, kv := range strings.Split(list, ",") {
			if k, v, ok := strings.Cut(kv, "="); ok {
				req.Args[k] = v
			}
		}
		reqs = append(reqs, req)
	}
	for _, req := range reqs {
		r := d.Run(context.Background(), req)
		out := r.Output
		if len(out) > 1500 {
			out = out[:1500] + "\n…"
		}
		t.Logf("== %s %v: code=%q msg=%q truncated=%v commands=%q\n%s", req.Check, req.Args, r.Code, r.Message, r.Truncated, r.Commands, out)
	}
}
