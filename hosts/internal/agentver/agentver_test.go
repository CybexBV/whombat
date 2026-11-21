package agentver

import "testing"

func TestCompare(t *testing.T) {
	cases := []struct {
		a, b string
		c    int
		ok   bool
	}{
		{"0.0.0-20261018094703.5394c53", "0.0.0-20261020120000.d2098f2", -1, true},
		{"0.0.0-20261020120000.d2098f2", "0.0.0-20261018094703.5394c53", 1, true},
		{"0.0.0-20261018094703.5394c53", "0.0.0-20261018094703.5394c53", 0, true},
		{"0.0.0-20261018094703.5394c53", "0.0.0-20261018094703.abcdef0", 0, false},
		// The timestamp decides, whatever the revision says.
		{"0.0.0-20261019000000.ffffff0", "0.0.0-20261020000000.0000000", -1, true},
		{"v0.3.1", "v0.4.0", -1, true},
		{"0.4.0", "v0.4.0", 0, true},
		{"0.4.0-rc.1", "0.4.0", -1, true},
		{"0.4.0-rc.2", "0.4.0-rc.10", -1, true},
		{"0.4.0-rc.1", "0.4.0-beta", 1, true},
		{"v1", "v2", -1, true},
		{"0.14.2-sim", "0.14.2", -1, true},
		// One appliance build and one tag, or no version form at all.
		{"0.0.0-20261018094703.5394c53", "v0.4.0", 0, false},
		{"beaea67", "0.0.0-20261018094703.5394c53", 0, false},
		{"dev", "v0.1.0", 0, false},
		{"", "v0.1.0", 0, false},
	}
	for _, c := range cases {
		got, ok := Compare(c.a, c.b)
		if got != c.c || ok != c.ok {
			t.Errorf("Compare(%q, %q) = %d, %v; want %d, %v", c.a, c.b, got, ok, c.c, c.ok)
		}
	}
	if !Older("v1", "v2") || Older("v2", "v1") || Older("dev", "v1") {
		t.Error("Older")
	}
}
