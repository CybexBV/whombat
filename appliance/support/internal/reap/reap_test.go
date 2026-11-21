package reap

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"testing"
)

// cgroups is a fake unified hierarchy: the service's cgroup and one below it, each a cgroup.procs file.
type cgroups struct {
	t        *testing.T
	root     string
	procs    map[string][]int // relative cgroup → pids
	killed   []int
	onKill   func(pid int)
	selfFile string
}

func newCgroups(t *testing.T) *cgroups {
	c := &cgroups{t: t, root: t.TempDir(), procs: map[string][]int{}}
	c.selfFile = filepath.Join(t.TempDir(), "cgroup")
	if err := os.WriteFile(c.selfFile, []byte("0::/system.slice/whombat-support.service\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return c
}

func (c *cgroups) set(rel string, pids ...int) {
	c.procs[rel] = pids
	dir := filepath.Join(c.root, "system.slice/whombat-support.service", rel)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		c.t.Fatal(err)
	}
	var b strings.Builder
	for _, p := range pids {
		fmt.Fprintln(&b, p)
	}
	if err := os.WriteFile(filepath.Join(dir, "cgroup.procs"), []byte(b.String()), 0o644); err != nil {
		c.t.Fatal(err)
	}
}

func (c *cgroups) kill(pid int) error {
	c.killed = append(c.killed, pid)
	for rel, pids := range c.procs {
		if i := slices.Index(pids, pid); i >= 0 {
			c.set(rel, slices.Delete(slices.Clone(pids), i, i+1)...)
			if c.onKill != nil {
				c.onKill(pid)
			}
			return nil
		}
	}
	return syscall.ESRCH
}

func (c *cgroups) options() Options {
	return Options{ProcSelfCgroup: c.selfFile, CgroupRoot: c.root, Self: 100, Kill: c.kill, Wait: func() {}, Logf: c.t.Logf}
}

func TestLeftovers(t *testing.T) {
	c := newCgroups(t)
	c.set("", 100, 200, 300)
	c.set("sub", 400)
	// 300 forks 301 as it dies: the next sweep ends it too.
	c.onKill = func(pid int) {
		if pid == 300 {
			c.set("", append(c.procs[""], 301)...)
		}
	}
	n, err := Leftovers(c.options())
	slices.Sort(c.killed)
	if err != nil || n != 4 || !slices.Equal(c.killed, []int{200, 300, 301, 400}) {
		t.Fatalf("%d %v, killed %v", n, err, c.killed)
	}
	if !slices.Equal(c.procs[""], []int{100}) {
		t.Fatalf("left %v", c.procs[""])
	}
	// Nothing left: nothing killed.
	c.killed = nil
	if n, err := Leftovers(c.options()); n != 0 || err != nil || len(c.killed) != 0 {
		t.Fatalf("%d %v %v", n, err, c.killed)
	}
}

func TestGoneAlreadyIsFine(t *testing.T) {
	c := newCgroups(t)
	c.set("", 100, 200)
	o := c.options()
	gone := 0
	o.Kill = func(pid int) error {
		gone++
		c.set("", 100)
		return syscall.ESRCH
	}
	if n, err := Leftovers(o); n != 0 || err != nil || gone != 1 {
		t.Fatalf("%d %v %d", n, err, gone)
	}
}

// A killed process that takes a moment to leave is counted once.
func TestSlowToLeave(t *testing.T) {
	c := newCgroups(t)
	c.set("", 100, 200)
	o := c.options()
	kills := 0
	o.Kill = func(int) error { kills++; return nil }
	o.Wait = func() {
		if kills == 3 {
			c.set("", 100)
		}
	}
	if n, err := Leftovers(o); n != 1 || err != nil || kills != 3 {
		t.Fatalf("%d %v, %d kills", n, err, kills)
	}
}

func TestOneThatKeepsComing(t *testing.T) {
	c := newCgroups(t)
	c.set("", 100, 200)
	o := c.options()
	o.Kill = func(int) error { return nil } // never goes
	if _, err := Leftovers(o); err == nil {
		t.Fatal("no error")
	}
}

func TestOwnCgroup(t *testing.T) {
	dir := t.TempDir()
	for content, ok := range map[string]bool{
		"0::/system.slice/whombat-support.service\n":             true,
		"12:pids:/x\n0::/system.slice/whombat-support.service\n": true,
		"0::/\n": false,
		"1:name=systemd:/system.slice/whombat-support.service\n": false,
		"0::/system.slice/../../etc\n":                           false,
	} {
		p := filepath.Join(dir, "cgroup")
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		got, err := own(p, "/sys/fs/cgroup")
		if (err == nil) != ok || (ok && got != "/sys/fs/cgroup/system.slice/whombat-support.service") {
			t.Errorf("%q: %q %v", content, got, err)
		}
	}
}
