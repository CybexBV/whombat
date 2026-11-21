package activator

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"
)

// UP-X19: the fake collects what no profile generation, profile or booted system reaches. A layout seeded without
// generation links (the dev stack's harness writes profiles/whombat-runtime only) keeps its seeded runtime: the first
// switch records it as generation 1, as nix-env did on a real box.
func TestFakeCollectsWhatNoRootReaches(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	f, err := NewFake(root, hp)
	if err != nil {
		t.Fatal(err)
	}
	seeded := "/nix/store/0123456789abcdfghijklmnpqrsvwxyb-whombat-runtime-0.9.0"
	orphan := "/nix/store/0123456789abcdfghijklmnpqrsvwxyc-whombat-runtime-0.8.0"
	for _, p := range []string{hp, sp, seeded, orphan} {
		if err := os.WriteFile(filepath.Join(root, "store", filepath.Base(p)), []byte(p), 0o444); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(seeded, filepath.Join(root, "profiles", "whombat-runtime")); err != nil {
		t.Fatal(err)
	}
	if err := f.SetRuntime(ctx, RuntimeSet{Runtime: sp}); err != nil {
		t.Fatal(err)
	}
	gens, err := f.RuntimeGenerations(ctx)
	if err != nil || len(gens) != 2 || gens[0] != (Generation{Number: 1, StorePath: seeded}) ||
		gens[1] != (Generation{Number: 2, StorePath: sp, Current: true}) {
		t.Fatalf("%+v %v", gens, err)
	}
	r, err := f.CollectGarbage(ctx)
	if err != nil || r.Paths != 1 || r.FreedBytes != int64(len(orphan)) {
		t.Fatalf("%+v %v", r, err)
	}
	for p, want := range map[string]bool{hp: true, sp: true, seeded: true, orphan: false} {
		if ok, _ := f.HasStorePath(ctx, p); ok != want {
			t.Fatalf("%s in store: %v", p, ok)
		}
	}
	// The current generation is never deleted; the seeded one is once nothing needs it.
	if err := f.DeleteRuntimeGenerations(ctx, []int{2}); err == nil {
		t.Fatal("deleted the current generation")
	}
	if err := f.DeleteRuntimeGenerations(ctx, []int{1}); err != nil {
		t.Fatal(err)
	}
	if r, err := f.CollectGarbage(ctx); err != nil || r.Paths != 1 {
		t.Fatalf("%+v %v", r, err)
	}
	if ok, _ := f.HasStorePath(ctx, seeded); ok {
		t.Fatal("the seeded runtime outlived its generation")
	}
}

// UP-X14, UP-X19: a path ImportNar recorded as a reference stays while its referrer is reachable and goes with the
// last one.
func TestFakeCollectFollowsReferences(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	f, err := NewFake(root, hp)
	if err != nil {
		t.Fatal(err)
	}
	other := "/nix/store/0123456789abcdfghijklmnpqrsvwxyb-whombat-runtime-2.0.0"
	for _, p := range []string{hp, other} {
		if err := os.WriteFile(filepath.Join(root, "store", filepath.Base(p)), []byte(p), 0o444); err != nil {
			t.Fatal(err)
		}
	}
	lib := "/nix/store/0123456789abcdfghijklmnpqrsvwxyd-whombat-fake-lib-1"
	for _, p := range []NarPath{{StorePath: lib, References: []string{}}, {StorePath: sp, References: []string{lib, sp}}} {
		nar := []byte(fakeNarPrefix + p.StorePath)
		p.NarSize = int64(len(nar))
		if err := f.ImportNar(ctx, p, bytes.NewReader(nar)); err != nil {
			t.Fatal(err)
		}
	}
	for _, rt := range []string{sp, other} {
		if err := f.SetRuntime(ctx, RuntimeSet{Runtime: rt}); err != nil {
			t.Fatal(err)
		}
	}
	if r, err := f.CollectGarbage(ctx); err != nil || r.Paths != 0 {
		t.Fatalf("with generation 1 kept: %+v %v", r, err)
	}
	if err := f.DeleteRuntimeGenerations(ctx, []int{1}); err != nil {
		t.Fatal(err)
	}
	if r, err := f.CollectGarbage(ctx); err != nil || r.Paths != 2 {
		t.Fatalf("after generation 1: %+v %v", r, err)
	}
	if ok, _ := f.HasStorePath(ctx, lib); ok {
		t.Fatal("the library outlived its last referrer")
	}
}
