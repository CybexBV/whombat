package coverage

import (
	"os"
	"strings"
	"testing"
)

func TestCheckRoots(t *testing.T) {
	l := Layout{Persist: "/persist"}
	out := CheckRoots(l, []string{"/persist/whombat/workspaces/agents", "/home/owner/src", "/persist/whombat/homex"})
	if len(out) != 2 {
		t.Fatalf("outside %v", out)
	}
}

// The hosts service's backup is a source and “Servers” a class only where the service runs (BK-31).
func TestHostsSourceOnlyWithTheService(t *testing.T) {
	names := func(l Layout) (src, cls []string) {
		for _, s := range l.Sources() {
			src = append(src, s.Name)
		}
		for _, c := range Classes(l) {
			cls = append(cls, c.ID)
		}
		return src, cls
	}
	src, cls := names(Layout{Persist: "/persist"})
	if strings.Join(src, ",") != "home,workspaces,credentials,hermes,agent,secrets" || strings.Contains(strings.Join(cls, ","), "servers") {
		t.Fatalf("without the hosts service: sources %v, classes %v", src, cls)
	}
	l := Layout{Persist: "/persist", Hosts: true}
	src, cls = names(l)
	if strings.Join(src, ",") != "home,workspaces,credentials,hermes,agent,secrets,hosts" {
		t.Fatalf("sources %v", src)
	}
	if got := l.Sources()[6].Path; got != "/persist/hosts-backup" {
		t.Fatalf("hosts source at %s", got)
	}
	i := strings.Index(strings.Join(cls, ","), "provider-sessions,servers,recovery-references")
	if i < 0 {
		t.Fatalf("classes %v", cls)
	}
	for _, c := range Classes(l) {
		if c.ID == "servers" && (c.Title != "Servers" || !c.Covered) {
			t.Fatalf("servers class %+v", c)
		}
	}
	if out := CheckRoots(l, []string{"/persist/hosts-backup"}); len(out) != 0 {
		t.Fatalf("the hosts source counts as covered: %v", out)
	}
}

// The Hermes home is a source of every box (BK-36, NX-466): memory and conversations, and the skills, are in it.
func TestHermesSource(t *testing.T) {
	l := Layout{Persist: "/persist"}
	if got := l.Sources()[3]; got.Name != "hermes" || got.Path != "/persist/whombat/hermes" {
		t.Fatalf("hermes source %+v", got)
	}
	for _, c := range Classes(l) {
		if (c.ID == "memory" || c.ID == "packs") && (!c.Covered || !strings.Contains(c.Source, "/persist/whombat/hermes")) {
			t.Fatalf("%s isn't the Hermes home's: %+v", c.ID, c)
		}
		if c.ID == "memory" && strings.Contains(c.Source, "<account>") {
			t.Fatalf("a home per person: %+v", c)
		}
	}
	if out := CheckRoots(l, []string{"/persist/whombat/hermes/profiles/_feedback"}); len(out) != 0 {
		t.Fatalf("the Hermes home counts as covered: %v", out)
	}
}

// The agent's home is a source (NX-465, NX-466), its .cache left out; the containers' storage never is one.
func TestAgentHomeSource(t *testing.T) {
	l := Layout{Persist: "/persist"}
	if got := l.Sources()[4]; got.Name != "agent" || got.Path != "/persist/whombat/agent/home" {
		t.Fatalf("agent source %+v", got)
	}
	if strings.Join(AlwaysExcluded["agent"], ",") != ".cache" {
		t.Fatalf("agent excludes %v", AlwaysExcluded["agent"])
	}
	if out := CheckRoots(l, []string{"/persist/whombat/agent/home/src", "/persist/containers"}); len(out) != 1 || out[0] != "/persist/containers" {
		t.Fatalf("covered: %v", out)
	}
	for _, c := range Classes(l) {
		if c.ID == "workspaces" && !strings.Contains(c.Source, l.AgentHome()) {
			t.Fatalf("workspaces class without the agent's home: %+v", c)
		}
		if c.ID == "caches" && (c.Covered || !strings.Contains(c.Source, l.Containers())) {
			t.Fatalf("caches class without the containers: %+v", c)
		}
	}
}

// docs/runbooks/backup.md carries the rendered table (a box with the hosts service, the full inventory).
func TestRunbookTable(t *testing.T) {
	b, err := os.ReadFile("../../../docs/runbooks/backup.md")
	if err != nil {
		t.Fatal(err)
	}
	_, rest, ok := strings.Cut(string(b), "<!-- coverage:begin -->\n")
	doc, _, ok2 := strings.Cut(rest, "<!-- coverage:end -->")
	if !ok || !ok2 {
		t.Fatal("no coverage markers in the runbook")
	}
	if want := Markdown(Layout{Persist: "/persist", Hosts: true}); doc != want {
		t.Fatalf("docs/runbooks/backup.md differs from the code: go run ./backup/cmd/whombat-backup coverage, between the markers\n%s", want)
	}
}
