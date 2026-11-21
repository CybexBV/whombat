package proto

import (
	"strings"
	"testing"
)

func TestDecodeRequest(t *testing.T) {
	good := []string{
		`{"v":1,"op":"stage-runtime","releaseId":"r-2026.09.25-1"}`,
		`{"v":1,"op":"rollback-runtime"}`,
		`{"v":1,"op":"rollback-runtime","releaseId":"rt-2"}`,
		`{"v":1,"op":"apply-network","candidateId":"n-abc"}`,
		`{"v":1,"op":"bless-boot"}`,
		`{"v":1,"op":"prune-host-generations"}`,
		`{"v":1,"op":"prune-runtime-generations"}`,
		`{"v":1,"op":"collect-garbage"}`,
		`{"v":1,"op":"hardware-log"}`,
		`{"v":1,"op":"check-schema","releaseId":"rt-2026.09.25-1"}`,
		`{"v":1,"op":"migrate-runtime","releaseId":"rt-2026.09.25-1","checkpointId":"ckpt-2026-09-25T12:00:00Z.1"}`,
	}
	for _, s := range good {
		if _, err := DecodeRequest([]byte(s)); err != nil {
			t.Errorf("%s: %v", s, err)
		}
	}
	bad := []string{
		`{"v":1,"op":"exec","command":"sh -c id"}`,
		`{"v":1,"op":"shell"}`,
		`{"v":1,"op":"stage-runtime","releaseId":"../../etc/passwd"}`,
		`{"v":1,"op":"stage-runtime","releaseId":"/nix/store/abc-evil"}`,
		`{"v":1,"op":"stage-runtime","releaseId":"rt-1","path":"/tmp/x"}`,
		`{"v":1,"op":"stage-runtime","releaseId":"rt-1","url":"http://evil"}`,
		`{"v":1,"op":"stage-runtime","releaseId":"rt-1","candidateId":"n-1"}`,
		`{"v":1,"op":"activate-runtime","releaseId":"(import <nixpkgs> {}).hello"}`,
		`{"v":2,"op":"bless-boot"}`,
		`{"v":1,"op":"bless-boot"} {"v":1,"op":"bless-boot"}`,
		`not json`,
		`{"v":1,"op":"apply-network","candidateId":"n-1; reboot"}`,
		`{"v":1,"op":"check-schema","releaseId":"rt-1","checkpointId":"c1"}`,
		`{"v":1,"op":"prune-host-generations","releaseId":"rt-1"}`,
		// The store operations take nothing: what stays is the helper's records and the profiles, never the request's.
		`{"v":1,"op":"prune-runtime-generations","releaseId":"rt-1"}`,
		`{"v":1,"op":"prune-runtime-generations","candidateId":"n-1"}`,
		`{"v":1,"op":"collect-garbage","releaseId":"rt-1"}`,
		`{"v":1,"op":"collect-garbage","storePaths":["/nix/store/0123456789abcdfghijklmnpqrsvwxyz-whombat-runtime-1.0.0"]}`,
		`{"v":1,"op":"collect-garbage","checkpointId":"c1"}`,
		`{"v":1,"op":"collect-garbage","maxFreed":1}`,
		`{"v":1,"op":"collect-garbage","delete":"old"}`,
		// hardware-log takes nothing: what it reads is fixed (MG-114).
		`{"v":1,"op":"hardware-log","releaseId":"rt-1"}`,
		`{"v":1,"op":"hardware-log","storePaths":["/nix/store/0123456789abcdfghijklmnpqrsvwxyz-whombat-runtime-1.0.0"]}`,
		`{"v":1,"op":"hardware-log","path":"/var/log"}`,
		`{"v":1,"op":"migrate-runtime","releaseId":"rt-1","checkpointId":"../../backup"}`,
		`{"v":1,"op":"migrate-runtime","releaseId":"rt-1","checkpointId":"/persist/backup/x"}`,
		`{"v":1,"op":"migrate-runtime","releaseId":"rt-1","checkpointId":"--home=/tmp"}`,
	}
	for _, s := range bad {
		if _, err := DecodeRequest([]byte(s)); err == nil {
			t.Errorf("accepted %s", s)
		}
	}
}

func TestMissingPathsRequest(t *testing.T) {
	p := "/nix/store/0123456789abcdfghijklmnpqrsvwxyz-whombat-runtime-1.0.0"
	if _, err := DecodeRequest([]byte(`{"v":1,"op":"missing-paths","storePaths":["` + p + `"]}`)); err != nil {
		t.Fatal(err)
	}
	// A large request is fine for missing-paths only (up to MaxStorePaths paths).
	paths := make([]string, 2000)
	for i := range paths {
		paths[i] = `"` + p + `"`
	}
	big := `{"v":1,"op":"missing-paths","storePaths":[` + strings.Join(paths, ",") + `]}`
	if r, err := DecodeRequest([]byte(big)); err != nil || len(r.StorePaths) != 2000 {
		t.Fatalf("large request: %v", err)
	}
	for _, s := range []string{
		`{"v":1,"op":"missing-paths"}`,
		`{"v":1,"op":"missing-paths","storePaths":[]}`,
		`{"v":1,"op":"missing-paths","storePaths":["/etc/passwd"]}`,
		`{"v":1,"op":"missing-paths","storePaths":["` + p + `/bin/sh"]}`,
		`{"v":1,"op":"missing-paths","storePaths":["` + p + `"],"releaseId":"rt-1"}`,
		`{"v":1,"op":"stage-runtime","releaseId":"rt-1","storePaths":["` + p + `"]}`,
		`{"v":1,"op":"stage-runtime","releaseId":"rt-1","storePaths":[]}`,
		`{"v":1,"op":"bless-boot","checkpointId":"` + strings.Repeat("a", 2000) + `"}`,
	} {
		if _, err := DecodeRequest([]byte(s)); err == nil {
			t.Errorf("accepted %.120s", s)
		}
	}
	tooMany := make([]string, MaxStorePaths+1)
	for i := range tooMany {
		tooMany[i] = p
	}
	if err := (Request{V: 1, Op: OpMissingPaths, StorePaths: tooMany}).Validate(); err == nil {
		t.Error("too many paths accepted")
	}
}
