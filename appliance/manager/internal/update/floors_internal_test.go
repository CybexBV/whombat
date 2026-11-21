package update

import (
	"testing"

	"github.com/CybexBV/whombat/appliance/helper/pkg/proto"
)

// MG-51: exit-0 floors are used only when they can be the live schema's: 0 < readers ≤ writers ≤ the database's schema.
func TestLiveFloorsOnlyWhenConsistent(t *testing.T) {
	t.Parallel()
	at := func(exit, db, version, readers, writers int) *proto.Schema {
		return &proto.Schema{Exit: exit, DatabaseVersion: db, Target: &proto.SchemaTarget{Version: version, Readers: readers, Writers: writers}}
	}
	if f := liveFloors(at(proto.SchemaExitOK, 49, 49, 47, 48)); f == nil || f.Readers != 47 || f.Writers != 48 {
		t.Fatalf("consistent floors: %+v", f)
	}
	if f := liveFloors(at(proto.SchemaExitOK, 49, 49, 49, 49)); f == nil {
		t.Fatal("floors at the schema itself")
	}
	for name, s := range map[string]*proto.Schema{
		"no target":            {Exit: proto.SchemaExitOK, DatabaseVersion: 49},
		"migration required":   at(proto.SchemaExitMigrationRequired, 48, 49, 48, 48),
		"another schema":       at(proto.SchemaExitOK, 49, 50, 48, 48),
		"zero readers":         at(proto.SchemaExitOK, 49, 49, 0, 48),
		"negative readers":     at(proto.SchemaExitOK, 49, 49, -1, 48),
		"readers above writer": at(proto.SchemaExitOK, 49, 49, 48, 47),
		"writers above schema": at(proto.SchemaExitOK, 49, 49, 47, 50),
	} {
		if f := liveFloors(s); f != nil {
			t.Errorf("%s: floors %+v used", name, f)
		}
	}
}
