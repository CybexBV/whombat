package store

import (
	"errors"
	"path/filepath"
	"testing"
	"time"
)

// TestWatchOffs: a database of the previous schema gets the watch settings
// (migration 13); rules switch off and on per server and entity, and go
// with their server (HS-194).
func TestWatchOffs(t *testing.T) {
	orig := migrations
	t.Cleanup(func() { migrations = orig })
	path := filepath.Join(t.TempDir(), "hub.db")
	migrations = orig[:12]
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"granite", "basalt"} {
		if _, err := s.w.ExecContext(ctx, `INSERT INTO servers(id, hostname, grp, location, rc_console, rc_power, cert_serial,
			cert_not_after, machine_id, created_at, agent_version, address) VALUES (?, ?, 'Lab', '', 0, 0, ?, 0, ?, 0, '', '')`,
			id, id, "c-"+id, "m-"+id); err != nil {
			t.Fatal(err)
		}
	}
	s.Close()
	migrations = orig
	if s, err = Open(path); err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	at := time.Date(2026, 10, 22, 9, 30, 0, 0, time.UTC)
	put := func(server, rule, entity string) bool {
		t.Helper()
		changed, err := s.PutWatchOff(ctx, WatchOff{Server: server, Rule: rule, Entity: entity, By: "John (pe_1)", At: at})
		if err != nil {
			t.Fatal(err)
		}
		return changed
	}
	if !put("granite", "disk.space_high", "fs:/srv") || !put("granite", "net.link_down", "") || !put("basalt", "net.link_down", "") {
		t.Fatal("not changed")
	}
	// Again: unchanged, the first who and when stay.
	if changed, err := s.PutWatchOff(ctx, WatchOff{Server: "granite", Rule: "net.link_down", By: "Vera (pe_2)", At: at.Add(time.Hour)}); err != nil || changed {
		t.Fatalf("again: %v %v", changed, err)
	}
	if _, err := s.PutWatchOff(ctx, WatchOff{Server: "nope", Rule: "net.link_down", By: "x", At: at}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown server: %v", err)
	}
	l, err := s.ListWatchOffs(ctx, "granite")
	if err != nil || len(l) != 2 || l[0].Rule != "disk.space_high" || l[0].Entity != "fs:/srv" || l[1].Entity != "" ||
		l[1].By != "John (pe_1)" || !l[1].At.Equal(at) {
		t.Fatalf("granite %+v %v", l, err)
	}
	if n, _ := s.CountWatchOffs(ctx, "granite"); n != 2 {
		t.Fatalf("count %d", n)
	}
	if all, _ := s.ListWatchOffs(ctx, ""); len(all) != 3 || all[0].Server != "basalt" {
		t.Fatalf("all %+v", all)
	}
	if changed, err := s.DeleteWatchOff(ctx, "granite", "disk.space_high", "fs:/srv"); err != nil || !changed {
		t.Fatalf("delete %v %v", changed, err)
	}
	if changed, _ := s.DeleteWatchOff(ctx, "granite", "disk.space_high", "fs:/srv"); changed {
		t.Fatal("deleted twice")
	}
	// A deleted server's settings go with it.
	if err := s.DeleteServer(ctx, "granite"); err != nil {
		t.Fatal(err)
	}
	if all, _ := s.ListWatchOffs(ctx, ""); len(all) != 1 || all[0].Server != "basalt" {
		t.Fatalf("after delete %+v", all)
	}
}
