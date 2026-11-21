package update_test

import (
	"testing"

	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
	"github.com/CybexBV/whombat/contracts/go/release"
)

// MG-131 (Whombat HE-52): a runtime on a new session protocol major activates. The installed runtime speaks major 1,
// the candidate major 2 only, with a contract migration as Whombat's step 4 had: the checkpoint is taken, the migration
// runs and the box is healthy on it. Before MG-131 the activation check refused it as protocol_no_overlap.
func TestNewProtocolMajorActivates(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	major2 := devtuf.StandardRelease("rt-12-protocol-2", "26.05.1", "2.0.0")
	major2.SchemaWrites, major2.SchemaReads, major2.ContractMigration = 11, release.IntRange{Min: 10, Max: 11}, true
	major2.Protocol = release.IntRange{Min: 2000, Max: 2000}
	publish(t, w, major2)
	if p := w.State().Current.Release.Runtime.Protocol; release.ProtocolOverlap(p, major2.Protocol) {
		t.Fatalf("the installed runtime's protocol %+v overlaps major 2: the test proves nothing", p)
	}
	install(t, w, major2.ID)
	st := w.State()
	if st.LastFailure != nil || st.Current.Release.Runtime.Protocol != major2.Protocol {
		t.Fatalf("failure %+v protocol %+v", st.LastFailure, st.Current.Release.Runtime.Protocol)
	}
	if w.Helper.DBSchema() != 11 || len(w.Checkpoints.Refs) != 1 {
		t.Fatalf("schema %d checkpoints %v", w.Helper.DBSchema(), w.Checkpoints.Refs)
	}
}
