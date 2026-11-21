package rules

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestServerRulesAreEveryRule: every Rule* constant of this package is a
// server rule a watch setting can switch off, and nothing else is (HS-195).
func TestServerRulesAreEveryRule(t *testing.T) {
	fset := token.NewFileSet()
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	var consts []string
	for _, en := range entries {
		if !strings.HasSuffix(en.Name(), ".go") || strings.HasSuffix(en.Name(), "_test.go") {
			continue
		}
		f, err := parser.ParseFile(fset, en.Name(), nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(f, func(n ast.Node) bool {
			vs, ok := n.(*ast.ValueSpec)
			if !ok {
				return true
			}
			for i, name := range vs.Names {
				if !strings.HasPrefix(name.Name, "Rule") || i >= len(vs.Values) {
					continue
				}
				if lit, ok := vs.Values[i].(*ast.BasicLit); ok && lit.Kind == token.STRING {
					v, _ := strconv.Unquote(lit.Value)
					consts = append(consts, v)
				}
			}
			return true
		})
	}
	got := append([]string(nil), ServerRules...)
	sort.Strings(consts)
	sort.Strings(got)
	if strings.Join(consts, " ") != strings.Join(got, " ") {
		t.Errorf("rule constants:\n%v\nServerRules:\n%v", consts, got)
	}
	if !IsServerRule(RuleUPSOnBattery) || IsServerRule("check.down") || IsServerRule("") {
		t.Error("IsServerRule")
	}
}

// TestEngineWatchOff: a rule switched off for a server or one entity is not
// evaluated there, its open alert resolves at once, and switched on again
// it starts from scratch (HS-196).
func TestEngineWatchOff(t *testing.T) {
	e := NewEngine()
	off := map[string]bool{}
	e.Off = func(server, rule, entity string) bool {
		return off[server+"|"+rule+"|"] || off[server+"|"+rule+"|"+entity]
	}
	t0 := time.Date(2026, 10, 22, 9, 0, 0, 0, time.UTC)
	link := func(names ...string) []Condition {
		var out []Condition
		for _, n := range names {
			out = append(out, Condition{Rule: RuleLinkDown, Entity: "net:" + n, Severity: SevWarning, For: 2 * time.Minute,
				ClearAfter: ClearAfter, Render: func(time.Duration) Text { return Text{Title: n + " link down"} }})
		}
		return out
	}
	e.Evaluate("h", link("eno1", "eno2"), notHeartbeat, t0)
	ch := e.Evaluate("h", link("eno1", "eno2"), notHeartbeat, t0.Add(2*time.Minute))
	if len(ch.Opened) != 2 {
		t.Fatalf("opened %+v", ch)
	}
	// One entity off: resolved by ResolveOff, whatever owns the rule.
	off["h|"+RuleLinkDown+"|net:eno2"] = true
	res := e.ResolveOff("h", t0.Add(3*time.Minute))
	if len(res) != 1 || res[0].Entity != "net:eno2" || res[0].State != AlertResolved || res[0].ResolvedAt == nil {
		t.Fatalf("resolve off %+v", res)
	}
	if len(e.ResolveOff("h", t0.Add(3*time.Minute))) != 0 || len(e.ResolveOff("", t0)) != 0 {
		t.Fatal("resolved twice")
	}
	ch = e.Evaluate("h", link("eno1", "eno2"), notHeartbeat, t0.Add(10*time.Minute))
	if len(ch.Opened)+len(ch.Resolved) != 0 || len(e.Open("h")) != 1 || e.Open("h")[0].Entity != "net:eno1" {
		t.Fatalf("eno2 evaluated while off: %+v", ch)
	}
	// Another server is not affected.
	e.Evaluate("g", link("eno2"), notHeartbeat, t0)
	if ch := e.Evaluate("g", link("eno2"), notHeartbeat, t0.Add(2*time.Minute)); len(ch.Opened) != 1 {
		t.Fatalf("other server %+v", ch)
	}
	// The whole rule off: the evaluation itself resolves the open alert at
	// once (no clear-after wait).
	off["h|"+RuleLinkDown+"|"] = true
	ch = e.Evaluate("h", link("eno1", "eno2"), notHeartbeat, t0.Add(11*time.Minute))
	if len(ch.Resolved) != 1 || ch.Resolved[0].Entity != "net:eno1" || len(e.Open("h")) != 0 {
		t.Fatalf("rule off %+v", ch)
	}
	// Back on: evaluated again, the rule's two minutes from scratch.
	delete(off, "h|"+RuleLinkDown+"|")
	delete(off, "h|"+RuleLinkDown+"|net:eno2")
	if ch := e.Evaluate("h", link("eno1", "eno2"), notHeartbeat, t0.Add(12*time.Minute)); len(ch.Opened) != 0 {
		t.Fatalf("opened without waiting: %+v", ch)
	}
	if ch := e.Evaluate("h", link("eno1", "eno2"), notHeartbeat, t0.Add(14*time.Minute)); len(ch.Opened) != 2 {
		t.Fatalf("back on %+v", ch)
	}
	// Hub-level alerts never ask.
	asked := false
	e.Off = func(server, rule, entity string) bool { asked = true; return true }
	e.Evaluate("", []Condition{{Rule: "check.down", Entity: "check:1", Severity: SevCritical,
		Render: func(time.Duration) Text { return Text{} }}}, func(string) bool { return true }, t0)
	if asked || len(e.Open("")) != 1 {
		t.Fatalf("hub-level asked %v open %d", asked, len(e.Open("")))
	}
}

// TestEngineWatchOffCritical: a critical rule switched off no longer hides
// the warning of the same entity.
func TestEngineWatchOffCritical(t *testing.T) {
	e := NewEngine()
	e.Off = func(server, rule, entity string) bool { return rule == RuleTempCritical }
	t0 := time.Now()
	e.Evaluate("h", HostConditions(sensorReport(87)), notHeartbeat, t0)
	ch := e.Evaluate("h", HostConditions(sensorReport(87)), notHeartbeat, t0.Add(10*time.Minute))
	if len(ch.Opened) != 1 || ch.Opened[0].Rule != RuleTempHigh {
		t.Fatalf("opened %+v", ch)
	}
}
